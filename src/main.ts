import Anthropic from "@anthropic-ai/sdk";
import {
	App,
	ButtonComponent,
	Editor,
	EventRef,
	FileSystemAdapter,
	FuzzySuggestModal,
	ItemView,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	MarkdownView,
	Menu,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
	editorLivePreviewField,
	loadPdfJs,
	normalizePath,
	requestUrl,
	setIcon,
} from "obsidian";
import type { Correction, DeepgramResponse, DigestData, EvalScore, ExportModel, Frame, FrameSample, GraphEvent, LiveTurn, ParsedInvite, PersonData, SpeakerEmbedding, TurnEmbedding, TurnRef, UsageEvent, VoiceprintLibrary, WhisperXResponse } from "./pipeline";
import { fetchCalendar, GraphError, pollToken, refreshTokens, sendMail, startDeviceCode } from "./graph";
import { strFromU8, unzipSync } from "fflate";
import type { DeckImage, DeckSlide, OcrMode } from "./pptx";
// the WhisperX server ships inside the bundle as text; the settings button
// writes these out so a user never hunts for files that match their plugin
import whisperxServerPy from "../tools/whisperx-server/server.py";
import whisperxRequirementsTxt from "../tools/whisperx-server/requirements.txt";
import whisperxSetupPs1 from "../tools/whisperx-server/setup.ps1";
import whisperxSetupSh from "../tools/whisperx-server/setup.sh";
import { buildDeckNote, notesText, pictureAction, slideOrder, slidePictures, slideText } from "./pptx";
import type { DeviceCode, OutgoingMail } from "./graph";
import { shareEmailHtml } from "./share-html";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { Range } from "@codemirror/state";

/** Dispatched to force the transcript Live Preview layer to recompute after a
 *  speaker's color or emoji changes — neither touches the doc or selection, so
 *  the view plugin would otherwise not know to restyle. */
const refreshTranscriptEffect = StateEffect.define<null>();

/** The document position (line start) of the transcript turn currently playing,
 *  or -1. The player dispatches it as the audio advances; the Live Preview layer
 *  highlights that turn so the transcript follows along like Otter. */
const setPlayingTurn = StateEffect.define<number>();
const playingTurnField = StateField.define<number>({
	create: () => -1,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setPlayingTurn)) return e.value;
		return value;
	},
});

/** The Electron bits a desktop Obsidian exposes to a plugin. Typed only as far
 *  as this uses them: the real shapes live in Electron, which is not a
 *  dependency of this build. */
interface ElectronBits {
	remote?: {
		BrowserWindow?: new (opts: Record<string, unknown>) => {
			loadURL(url: string, opts?: { userAgent?: string }): Promise<void>;
			on(event: "closed", fn: () => void): void;
			destroy(): void;
		};
		session?: { fromPartition(part: string): unknown };
	};
}

interface YoutubeSession {
	cookies: { get(filter: { domain?: string }): Promise<unknown[]> };
	clearStorageData(): Promise<void>;
	setUserAgent?(ua: string): void;
}

/** A television's user agent. YouTube serves a device that says this its TV
 *  interface, whose sign-in is a pairing code approved in a real browser rather
 *  than a password form — the flow Google offers a device it will not accept a
 *  password from, which is exactly what a window inside Obsidian is. */
const TV_USER_AGENT =
	"Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.10.1032722-gold (unlike Gecko) v8/8.8.278.8-jit gles Starboard/16, TV_ATV_2019/2019 (Sony, BRAVIA, Wired)";

/** The session partition the in-app YouTube window uses. Persistent, so signing
 *  in is something done once rather than once per capture, and separate from
 *  Obsidian's own so nothing else in the app inherits it. */
const YOUTUBE_PARTITION = "persist:pa-youtube";

/** The video the YouTube reach check asks about: the oldest public video on
 *  the site, which will still be there and still be public for as long as
 *  YouTube is. Nothing is downloaded; only its title is asked for. */
const YOUTUBE_REACH_PROBE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

/** The version of the CODE actually running, shown by the Show-running-version
 *  command; the Community-plugins list only shows what is on DISK, which
 *  diverges from the running instance until a real reload. Bump with manifest. */
const PC_BUILD = "1.87.1";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Race a promise against a deadline. Used to timebox the awaits on the
 *  recording-teardown path: a wedged blob read, vault write, or flush must
 *  never leave a stop hanging forever (the audio survives as the partial). */
const withTimeout = <T>(p: Promise<T>, ms: number) => {
	void p.catch(() => {}); // a rejection after the race is lost must not go unhandled
	return Promise.race([p, new Promise<"pcap-timeout">((res) => setTimeout(() => res("pcap-timeout"), ms))]);
};
/** Wall-clock time of an epoch-ms instant, e.g. "2:47 PM". */
const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The in-note "working" indicator: a `[!pc-working]` callout, matched by its
 *  own type so it can be found and cleanly removed once the real content lands
 *  (no visible comment markers, which Obsidian only half-hides while editing). */
const PC_PROGRESS_RE = /\n*> \[!pc-working\][^\n]*(?:\n>[^\n]*)*\n*/g;
const stripProgress = (md: string): string => md.replace(PC_PROGRESS_RE, "\n").replace(/\n{3,}/g, "\n\n");
import { Packer } from "docx";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { buildMeetingDoc } from "./docx-export";
import type { ResolvedImage } from "./docx-export";
import {
	ASSISTANT_SYSTEM,
	ChatTurn,
	Chunk,
	EXTRACTIONS,
	ExtractionKey,
	Moment,
	SearchIndex,
	TEMPLATES,
	Utterance,
	allTemplates,
	applySpeakerNames,
	assembleNote,
	buildAskPrompt,
	buildAssistantMessages,
	buildChatNote,
	buildDocExtractionPrompt,
	buildDocNote,
	buildMorningBriefing,
	BriefingData,
	buildDraftContext,
	buildDraftPrompt,
	buildFinancesRollup,
	FinanceDoc,
	cosine,
	parseEmbeddingResponse,
	fuseHits,
	DRAFT_KINDS,
	DraftKind,
	taskDueDate,
	parseActionRow,
	longDate,
	DocFields,
	docNiceName,
	resolveDocFiling,
	DocRule,
	emptyDocFields,
	parseDocExtraction,
	buildCarryOver,
	buildCatchUpPrompt,
	buildExtractionPrompt,
	buildLiveActionsPrompt,
	buildMeetingChat,
	buildMeetingStub,
	buildMultipart,
	buildPersonReport,
	buildSpeakerNamePrompt,
	buildWeeklyDigest,
	chosenKeys,
	chunkNote,
	cleanFolderPath,
	buildEvalReport,
	CLAIM_SETTLE_MS,
	coalesceUtterances,
	countSpeakers,
	dedupeQueuedNotes,
	enrollVoiceprint,
	expectedSpeakerBounds,
	forgetVoiceprint,
	mergeDiarizedParts,
	parseVoiceprintLibrary,
	reviewSpeakerClusters,
	summarizeVoiceprints,
	usableEmbedding,
	downsamplePCM16,
	estimateCost,
	evalSections,
	scoreExtraction,
	llmConfigured,
	llmCostUsd,
	parseMomentsJson,
	parseWhisperX,
	pendingRecordings,
	pendingState,
	pushUsageEvent,
	resolveLlmTarget,
	summarizeUsage,
	transcriptionCostUsd,
	eventToInvite,
	extractDoneTasks,
	extractOpenTasks,
	extractYoutubeMeta,
	extractYoutubeInfo,
	youtubeProps,
	YoutubeInfo,
	pickYoutubeAudio,
	YoutubeFormat,
	isXUrl,
	xStatusId,
	parseMediaInfo,
	isSyncConflictName,
	mediaProps,
	postExtractions,
	sameCaptureSource,
	freeNoteName,
	MediaInfo,
	MediaDump,
	mediaSiteFor,
	MEDIA_SITES,
	routeFor,
	CaptureRoute,
	CookieBrowser,
	COOKIE_BROWSERS,
	renderFolder,
	parseWebMeta,
	webProps,
	WebInfo,
	siteNameFromUrl,
	cleanArticleMarkdown,
	msnArticleRef,
	msnApiUrl,
	parseMsnArticle,
	flattenForShare,
	splitLeadingTitle,
	parseRecipients,
	invalidRecipients,
	NO_MEDIA_RE,
	xOembedUrl,
	parseTweetOembed,
	TweetOembed,
	xSyndicationUrl,
	parseTweetEmbed,
	TweetEmbed,
	TweetRead,
	hasWordsToExtract,
	dayOf,
	today,
	daysAgo,
	clockOf,
	ytDlpInvocations,
	ytDlpInfoArgs,
	ytDlpAudioArgs,
	ytDlpSubsArgs,
	cookieArgs,
	hasYoutubeLogin,
	isYoutubeCookieDomain,
	DEFAULT_MEETING_TEMPLATE,
	LEGACY_MEETING_TEMPLATES,
	MEETING_TOKENS,
	templateBodyOf,
	mergeYoutubeInfo,
	parseYtDlpMeta,
	partOffsetsOf,
	netscapeCookieFile,
	type SessionCookie,
	captionsToText,
	looksAutoCaptioned,
	youtubeBlockReason,
	extractionsFromKeys,
	filterHitsByMeta,
	fmtTime,
	formatScreens,
	frameEmbedLine,
	frameFileName,
	illustrateBody,
	illustrateNote,
	momentsFromNote,
	parseScreensJson,
	pickSceneFrames,
	withMomentFrames,
	withScreensSection,
	formatSpeakersLine,
	formatSummaryForClipboard,
	formatUtterances,
	graphSetupHint,
	humanizeError,
	isAnonymousLabel,
	isSpeakerLetterTerm,
	isCaptureNote,
	isConflictCopy,
	isRetryableError,
	isoWeek,
	meetingAskChips,
	memoAttendees,
	mergeMeetingCapture,
	mergeUtterances,
	parseLineList,
	parseSearchTerms,
	fmtDuration,
	progressLine,
	pickLanAddress,
	parseCaptureForExport,
	parseDeepgram,
	parseMeetingInvite,
	parseMeetingMeta,
	parseChatSummary,
	parseSpeakerNames,
	parseStamp,
	personLink,
	personName,
	parseTimedText,
	parseTranscriptFile,
	partForStamp,
	recentTurnsText,
	redact,
	redactionActive,
	applyCorrections,
	correctionRanges,
	countTerm,
	speakerColor,
	parseTranscriptHeaderLine,
	parseTranscriptSpeakerLine,
	stampSecsOnLine,
	stripTranscriptCallout,
	fmtClock,
	currentTurn,
	interpolatedTime,
	SPEAKER_PALETTE,
	renameSpeakerLabels,
	renderMeetingFilename,
	resolveRecordingFolder,
	replaceExtractedBody,
	retryDelayMs,
	captureSourceText,
	sectionListItems,
	sectionText,
	talkShares,
	taskOwner,
	transcriptSpeakers,
	transcriptToUtterances,
	reassignTranscriptTurn,
	rebuildSpeakersLine,
	pickSpeakerSamples,
	whisperSizeWarning,
	parseTimedTextXml,
	renderFilename,
	seriesKey,
	speakerLetters,
	tokenize,
	ensureUrlScheme,
	mergeForSave,
	absoluteEdited,
	editedAt,
	relativeEdited,
	youtubeVideoId,
} from "./pipeline";
import type { SpendItem, TxnMail, TxnOrder, TxnRule } from "./transactions";
import {
	DEFAULT_TXN_RULES,
	applyTxnRule,
	buildCategorizePrompt,
	buildSpendRollup,
	buildTxnBase,
	buildTxnExtractionPrompt,
	emailToExtractionText,
	parseAmazonOrderCsv,
	parseCategorized,
	parseEmailFile,
	parseTxnExtraction,
	planOrderWrites,
	rememberProcessed,
	resolveTxnRule,
	selectTxnMail,
	settleOrder,
} from "./transactions";
import type { ImportMail, SenderRule } from "./mailimport";
import {
	buildImportReport,
	buildRelevancePrompt,
	buildSenderReport,
	buildThreadNote,
	collapseThreads,
	coverIndexFolders,
	filterThreads,
	parseRelevance,
	safeName,
	senderStats,
	threadNoteName,
} from "./mailimport";
import type { MailDoc, MailMeta } from "./mailwindow";
import {
	chunkMailForIndex,
	isoDate,
	mailHitPath,
	mailIdFromPath,
	linkifyMailCitations,
	mailWindowStats,
	planWindowUpdate,
} from "./mailwindow";

/** A transcription provider, or "default" to follow the Transcription tab's
 *  provider. Per-capture choices use this so one setting still moves everything
 *  that has not been given its own answer. */
type ProviderChoice = "default" | TranscriptionProvider;
type TranscriptionProvider = "whisper" | "assemblyai" | "deepgram" | "whisperx";

/** What a WhisperX transcription carries for the voice layer: fine-grained
 *  (pre-coalesce) utterances the review can move one by one, plus the
 *  per-letter and per-turn voice vectors when the server sent them. */
type VoiceData = { fine: Utterance[]; embeddings?: Record<string, SpeakerEmbedding>; turnEmbeddings?: TurnEmbedding[] };
/** Where the AI model runs: Anthropic's cloud, or a custom server that speaks
 *  the Anthropic Messages API (Ollama 0.14+, LM Studio, llama.cpp). */
type LlmProvider = "anthropic" | "custom";
/** What this device does with a new recording. "full" records and processes
 *  its own (the everything device); "capture" records only and marks the
 *  audio pending; "processor" additionally watches the synced vault and
 *  claims pending items other devices parked. Per-device, never synced. */
type DeviceRole = "full" | "capture" | "processor";

interface PowerAssistantSettings {
	transcriptionProvider: TranscriptionProvider;
	/** Which provider each kind of capture transcribes with. Meetings want
	 *  speaker labels; a solo memo usually does not and can go somewhere cheaper.
	 *  A standalone recording with no meeting note counts as a capture. */
	meetingProvider: ProviderChoice;
	captureProvider: ProviderChoice;
	youtubeProvider: ProviderChoice;
	mediaProvider: ProviderChoice;
	deepgramKey: string;
	deepgramModel: string;
	transcriptionEndpoint: string;
	transcriptionKey: string;
	transcriptionModel: string;
	/** A self-hosted WhisperX server: local diarized transcription (speaker
	 *  labels without a cloud provider). Empty = not set up. Synced, so the
	 *  whole fleet learns the box's address once. */
	whisperxEndpoint: string;
	/** Voice identity (voiceprints): naming a letter on a WhisperX transcript
	 *  enrolls that voice, later recordings' clusters are audited against the
	 *  library and arrive pre-suggested. Biometric, so OFF until the user
	 *  turns it on; the library lives in the vault file below, never here. */
	voiceIdentity: boolean;
	/** Vault path of the voiceprint library JSON. In the vault on purpose:
	 *  enrollment happens where the user names (the laptop), matching where
	 *  the fleet processes (the box), and vault sync is the bridge. */
	voiceprintsFile: string;
	/** Recent notes' per-letter voices, so naming a letter later, even on
	 *  another device after sync, can still enroll it. Rounded and capped
	 *  like the guess cache; a named letter's entry is consumed on enroll. */
	noteVoices: Record<string, Record<string, SpeakerEmbedding>>;
	assemblyaiKey: string;
	anthropicKey: string;
	anthropicModel: string;
	/** Which server the AI calls go to. "anthropic" uses the key and model
	 *  above; "custom" sends the same Messages-API calls to llmEndpoint
	 *  (a local or LAN server), keeping the cloud setup intact to switch back. */
	llmProvider: LlmProvider;
	llmEndpoint: string;
	llmKey: string;
	llmModel: string;
	captureFolder: string;
	/** PowerPoint capture: where decks land (empty falls back to the output
	 *  folder), whether slide pictures are read, and how big a picture must be
	 *  DRAWN on the slide (in inches) to count as content rather than decoration. */
	pptxFolder: string;
	pptxOcr: OcrMode;
	pptxMinInches: number;
	/** Screens: frames lifted out of a video capture where the shared screen
	 *  changed. Off by default because it costs a decode of the whole recording
	 *  and puts image files in the vault, neither of which should start
	 *  happening to an existing vault on an upgrade. `frameEvery` is the sample
	 *  interval in seconds, `frameThreshold` how much of the picture (0 to 100)
	 *  must change to count as a new screen, `frameMax` the cap per capture, and
	 *  `frameCaptions` whether each kept frame is read by the image model. */
	framesFromVideo: boolean;
	frameEvery: number;
	frameThreshold: number;
	frameMax: number;
	frameCaptions: boolean;
	/** Where recordings are written; empty keeps them in the capture folder. */
	audioFolder: string;
	outputFolder: string;
	filenameTemplate: string;
	autoProcess: boolean;
	/** Superseded by deviceRole (kept so an old data.json still loads; the
	 *  role migration reads it once). */
	processHere: boolean;
	/** This device's job in the fleet; lives in per-device storage so one
	 *  synced data.json cannot make every machine the processor. */
	deviceRole: DeviceRole;
	captureSystemAudio: boolean;
	extractions: Record<ExtractionKey, boolean>;
	includeTranscript: boolean;
	/** Wrap the saved transcript in a collapsed, foldable callout. */
	indexFolders: string;
	/** Semantic search: an OpenAI-compatible embeddings endpoint (empty = off).
	 *  Point it at local Ollama for private/free, or a hosted provider. */
	embeddingsEndpoint: string;
	embeddingsKey: string;
	embeddingsModel: string;
	/** Resolve Speaker A/B into real names after diarized transcription. */
	nameSpeakers: boolean;
	/** Where speakers get named after a diarized transcription: right on the
	 *  transcript (click a label, Otter-style) or in a blocking dialog first. */
	speakerNaming: "transcript" | "dialog";
	/** Emit action items as Tasks-format checklist lines (todo dashboards). */
	actionsAsTasks: boolean;
	/** Ask extraction to stamp each item with the [m:ss] it came from, so every
	 *  point clicks back to the moment and a screen can be placed beside the point
	 *  it shows. Off by default: it changes the shape of every capture's notes. */
	stampSummaries: boolean;
	/** Link recurring meetings: prior context to the extractor, open items carried over. */
	seriesAware: boolean;
	/** Rolling live transcript in the sidebar while recording (AssemblyAI). */
	liveTranscript: boolean;
	/** Rotate the recording into parts after this many minutes (provider size limits). */
	maxPartMinutes: number;
	/** The user's own name, for the "Was I mentioned?" quick question and memos. */
	yourName: string;
	/** Per-series default extraction sections, keyed by series key. */
	seriesTemplates: Record<string, ExtractionKey[]>;
	/** Auto-build the weekly digest on the first launch of a new ISO week. */
	autoWeeklyDigest: boolean;
	/** The ISO week ("2026-W28") the auto-digest last wrote, to fire once. */
	lastDigestWeek: string;
	/** Auto-open the morning briefing on the first launch of a new day. */
	autoMorningBriefing: boolean;
	/** The day ("2026-07-15") the briefing last opened, to fire once. */
	lastBriefingDay: string;
	/** How many days ahead a commitment or document counts as "coming due". */
	briefingHorizonDays: number;
	/** Where morning briefings are saved (empty = a Briefings folder under the output folder). */
	briefingsFolder: string;
	/** Learned transcript corrections, applied to every new transcript. */
	corrections: Correction[];
	/** Per-speaker color overrides (name → hex); empty falls back to the auto color. */
	speakerColors: Record<string, string>;
	/** Per-speaker emoji shown in their avatar (name → emoji); remembered across meetings. */
	speakerEmoji: Record<string, string>;
	/** User-defined meeting templates (named section presets). */
	customTemplates: { name: string; sections: ExtractionKey[] }[];
	/** Mask sensitive info when copying/exporting a capture (never the note). */
	redactShare: boolean;
	redactEmails: boolean;
	redactPhones: boolean;
	redactSsns: boolean;
	redactCards: boolean;
	/** Comma-separated custom terms/names to redact. */
	redactTerms: string;
	/** Also redact the note's own attendee names on share/export. */
	redactAttendees: boolean;
	/** What to do with the audio file after a note is successfully written. */
	audioRetention: "keep" | "trash";
	/** Where new meeting notes are created; empty uses the output folder. */
	meetingsFolder: string;
	/** Ask, when a mic-button recording stops, whether it should become a
	 *  meeting note in the Meetings folder or the usual capture note. */
	askQuickFiling: boolean;
	/** Filename pattern for meeting notes; supports {{date}} and {{title}}. */
	meetingFilename: string;
	/** The body a new meeting note starts with; empty means the default. */
	meetingTemplate: string;
	/** A note in the vault whose body is the template. Wins over the box above
	 *  when set, so a template can be written in the editor like anything else. */
	meetingTemplateFile: string;
	/** Where person pages live: attendee links point here and person reports
	 *  are written here. Empty uses People under the output folder. */
	peopleFolder: string;
	/** The assistant sidebar's current conversation, so it survives closing
	 *  the panel and reloading Obsidian. Capped; New chat clears it. */
	chatTurns: ChatTurn[];
	/** Log every AI call to the usage ledger so the usage meter can total it. */
	usageMeterEnabled: boolean;
	/** The ongoing usage ledger the meter reads. Capped to the most recent
	 *  events so it never grows without bound. */
	usageLedger: UsageEvent[];
	/** Sections the user has folded away, as "tab/section". Everything else is
	 *  open: settings are for changing, so they start visible. */
	foldedSections: string[];
	/** How many days of recent email the rolling Ask window indexes; 0 turns it
	 *  off. The window is local-only and never synced. */
	mailWindowDays: number;
	/** Root for mail imported as notes; each folder gets a subfolder. Empty
	 *  turns folder import off. */
	mailImportFolder: string;
	/** Keep only exchanges Outlook classified Focused. */
	mailImportFocusedOnly: boolean;
	/** Drop an exchange whose newest message is shorter than this. 0 = off. */
	mailImportMinChars: number;
	/** How many messages one import reads from a folder. */
	mailImportCap: number;
	/** Sender allow and block rules applied during import. */
	mailImportRules: SenderRule[];
	/** Where processed documents are filed (<folder>/<Type>/<year>/…). Empty
	 *  leaves originals where they are and only writes the note. */
	docsFolder: string;
	/** Watched inbox: an image or PDF dropped here is processed and filed
	 *  automatically. Empty turns the watcher off. */
	docInbox: string;
	/** User-defined filing rules applied when a document is processed. */
	docRules: DocRule[];
	/** Root for transaction notes; orders and line items get year folders
	 *  beneath it. Empty turns mail-driven capture off entirely. */
	txnFolder: string;
	/** Which incoming messages become transactions. First match wins. */
	txnRules: TxnRule[];
	/** Message ids already captured, so a re-poll cannot double-count. Capped. */
	txnSeen: string[];
	/** Where YouTube captures are written; empty uses the output folder. */
	youtubeFolder: string;
	/** Filename pattern for YouTube captures; supports {{title}} and {{date}}. */
	youtubeFilename: string;
	/** Which sections a YouTube capture extracts (content-oriented by default). */
	youtubeExtractions: Record<ExtractionKey, boolean>;
	/** Transcribe a video's actual audio (accurate, costs credits) instead of
	 *  its auto-captions. Best-effort: falls back to captions when unavailable. */
	youtubeTranscribeAudio: boolean;
	/** Where captures from a video or social link are written; supports {{site}}.
	 *  Empty uses the output folder. */
	mediaFolder: string;
	/** Filename pattern for those captures; supports {{title}}, {{date}}, {{site}}. */
	mediaFilename: string;
	/** Which sections they extract (content-oriented by default). */
	mediaExtractions: Record<ExtractionKey, boolean>;
	/** Where web page captures are written; supports {{site}}. */
	webFolder: string;
	/** Filename pattern for web captures; supports {{title}}, {{date}}, {{site}}. */
	webFilename: string;
	/** Which sections a web capture extracts. */
	webExtractions: Record<ExtractionKey, boolean>;
	/** Keep the article's full text in the note. Separate from includeTranscript:
	 *  an article is the thing itself, not a by-product of transcribing it. */
	webIncludeArticle: boolean;
	/** Path to the yt-dlp binary. Empty searches the PATH and then Python's
	 *  module form, which is what a pip install usually leaves working. */
	ytDlpPath: string;
	/** Browser yt-dlp borrows cookies from for login-gated sites. Empty is off,
	 *  and off means nothing reads the browser. */
	cookieBrowser: CookieBrowser;
	/** Path to an exported cookies.txt, used ahead of the browser store. */
	cookieFile: string;
	/** The "Edited 3 minutes ago" line under a note's title. "labeled" carries
	 *  the word Edited, "bare" is the time alone, "off" hides it. Power Editor
	 *  draws this too and wins where both are installed; see editedStampMine(). */
	showEdited: "off" | "labeled" | "bare";
	/** Under the note's title, under it with a rule closing the pair off, at the
	 *  end of the note, or both. */
	editedPosition: "title" | "rule" | "bottom" | "both";
	/** "3 minutes ago", the full date, or the relative time with the date after
	 *  it. Clicking the stamp shows both whatever this is set to. */
	editedFormat: "relative" | "exact" | "both";
	/** Microsoft Graph calendar import. Tokens live locally in data.json. */
	graphClientId: string;
	graphTenant: string;
	graphRefresh: string;
	graphAccess: string;
	graphExpiry: number;
	/** Whether the one-time "this needs setting up" nudge has been shown.
	 *  Nothing here transcribes or extracts without a provider or a model, and
	 *  a fresh install gave no sign of that until the first capture failed. */
	setupNudged: boolean;
	/** Which ribbon icons this plugin claims. Four is a lot of one shared
	 *  strip, so each can be turned off; its command always remains. */
	ribbonRecord: boolean;
	ribbonMeeting: boolean;
	ribbonBriefing: boolean;
	ribbonAssistant: boolean;
}

const DEFAULT_SETTINGS: PowerAssistantSettings = {
	transcriptionProvider: "whisper",
	meetingProvider: "default",
	captureProvider: "default",
	youtubeProvider: "default",
	mediaProvider: "default",
	deepgramKey: "",
	deepgramModel: "nova-2",
	// any OpenAI-compatible /audio/transcriptions endpoint: Groq, OpenAI, or a
	// self-hosted Whisper server on the LAN
	transcriptionEndpoint: "https://api.groq.com/openai/v1",
	transcriptionKey: "",
	transcriptionModel: "whisper-large-v3",
	whisperxEndpoint: "",
	voiceIdentity: false,
	voiceprintsFile: "_resources/voiceprints.json",
	noteVoices: {},
	assemblyaiKey: "",
	anthropicKey: "",
	anthropicModel: "claude-haiku-4-5",
	llmProvider: "anthropic",
	llmEndpoint: "",
	llmKey: "",
	llmModel: "",
	captureFolder: "Capture",
	pptxFolder: "",
	pptxOcr: "large",
	pptxMinInches: 1,
	framesFromVideo: false,
	frameEvery: 5,
	frameThreshold: 12,
	frameMax: 12,
	frameCaptions: false,
	audioFolder: "",
	outputFolder: "Capture/Notes",
	filenameTemplate: "{{basename}}-notes",
	autoProcess: true,
	processHere: true,
	deviceRole: "full",
	captureSystemAudio: true,
	extractions: { summary: true, actions: true, decisions: true, risks: false, questions: true, keywords: true, takeaways: false, facts: false, resources: false, quotes: false },
	includeTranscript: true,
	indexFolders: "Capture",
	embeddingsEndpoint: "",
	embeddingsKey: "",
	embeddingsModel: "nomic-embed-text",
	nameSpeakers: true,
	speakerNaming: "transcript",
	actionsAsTasks: true,
	stampSummaries: false,
	seriesAware: true,
	liveTranscript: true,
	maxPartMinutes: 45,
	yourName: "",
	seriesTemplates: {},
	autoWeeklyDigest: false,
	lastDigestWeek: "",
	autoMorningBriefing: false,
	lastBriefingDay: "",
	briefingHorizonDays: 3,
	briefingsFolder: "",
	corrections: [],
	speakerColors: {},
	speakerEmoji: {},
	customTemplates: [],
	redactShare: false,
	redactEmails: true,
	redactPhones: true,
	redactSsns: true,
	redactCards: true,
	redactTerms: "",
	redactAttendees: false,
	audioRetention: "keep",
	meetingsFolder: "",
	askQuickFiling: true,
	meetingFilename: "{{date}} {{title}}",
	meetingTemplate: DEFAULT_MEETING_TEMPLATE,
	meetingTemplateFile: "",
	peopleFolder: "",
	chatTurns: [],
	usageMeterEnabled: true,
	usageLedger: [],
	docsFolder: "Documents",
	docInbox: "",
	foldedSections: [],
	mailWindowDays: 0,
	mailImportFolder: "",
	mailImportFocusedOnly: true,
	mailImportMinChars: 40,
	mailImportCap: 2000,
	mailImportRules: [],
	docRules: [],
	txnFolder: "Finance",
	txnRules: DEFAULT_TXN_RULES,
	txnSeen: [],
	youtubeFolder: "Sources/YouTube",
	youtubeFilename: "{{date}} {{title}}",
	youtubeExtractions: { summary: true, takeaways: true, facts: true, resources: true, quotes: true, questions: true, keywords: true, actions: false, decisions: false, risks: false },
	youtubeTranscribeAudio: false,
	// One Sources tree per kind of link, so a fresh vault gets a coherent shelf
	// instead of everything landing in the output folder together. {{site}} is
	// right for social (a dozen tidy labels: X, TikTok, Reddit) but not for the
	// web, where the site name comes from each page's own og:site_name and runs
	// to things like "Wikimedia Foundation, Inc." A folder per publication is
	// sprawl, and the site is a property on every note anyway.
	mediaFolder: "Sources/Social/{{site}}",
	mediaFilename: "{{date}} {{title}}",
	mediaExtractions: { summary: true, takeaways: true, facts: true, resources: true, quotes: true, questions: true, keywords: true, actions: false, decisions: false, risks: false },
	webFolder: "Sources/Articles",
	webFilename: "{{date}} {{title}}",
	webExtractions: { summary: true, takeaways: true, facts: true, resources: true, quotes: true, questions: true, keywords: true, actions: false, decisions: false, risks: false },
	webIncludeArticle: true,
	ytDlpPath: "",
	cookieBrowser: "",
	cookieFile: "",
	// off by default: a plugin someone installed to record meetings should not
	// start writing chrome onto every note in the vault unasked
	showEdited: "off",
	editedPosition: "rule",
	editedFormat: "relative",
	graphClientId: "",
	graphTenant: "common",
	graphRefresh: "",
	graphAccess: "",
	graphExpiry: 0,
	setupNudged: false,
	ribbonRecord: true,
	ribbonMeeting: true,
	ribbonBriefing: true,
	ribbonAssistant: true,
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Retry a network op through transient failures (429s, 5xx) with exponential
 *  backoff; non-retryable errors and the final attempt throw straight through. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
	for (let i = 0; ; i++) {
		try {
			return await fn();
		} catch (e) {
			if (i >= attempts - 1 || !isRetryableError(e)) throw e;
			await new Promise((r) => setTimeout(r, retryDelayMs(i)));
		}
	}
}

/** Per-run overrides collected by the Process modal; falls back to settings. */
interface ProcessOverrides {
	extractions: Record<ExtractionKey, boolean>;
	includeTranscript: boolean;
	outputFolder: string;
	filenameTemplate: string;
	/** Scan a video capture for its screens after the note is written. Absent
	 *  means follow the Screens setting, which is how every caller that is not
	 *  the per-file dialog behaves. */
	screens?: boolean;
}

const AUDIO_EXTS = new Set(["webm", "m4a", "mp3", "wav", "ogg", "flac", "mp4"]);
/** Containers that can carry a video track, and that Obsidian will embed. A
 *  webm is in both sets: MediaRecorder writes audio-only webm, so "might have
 *  video" is all an extension can say and the frame grab checks for real. */
const VIDEO_EXTS = new Set(["mp4", "webm", "mkv", "mov", "ogv", "m4v"]);
/** Grabbed frames are capped to this width. A shared screen is legible well
 *  below its native size, and a note full of 1080p stills is a note nobody
 *  wants to sync twice. */
const FRAME_MAX_WIDTH = 1280;
/** Picture formats the image reader accepts. Office also embeds EMF and WMF,
 *  which it cannot take, so those are saved and embedded but never read. */
const VISION_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** Said when no way of calling yt-dlp resolves. pip parks the launcher in a
 *  Scripts directory that is often not on PATH, so "installed" and "runnable"
 *  come apart here more than they do for most tools, and the hint has to cover
 *  the case where the user is sure they already installed it. */
const YTDLP_HINT =
	'yt-dlp was not found. Install it with "pip install yt-dlp". If it is already installed, set the full path to it in Power Assistant settings, under Links.';

/** Thrown when yt-dlp is absent, as opposed to present and refusing the link.
 *  The two have to stay apart: a missing program says nothing about the post,
 *  and a post that is only words never needed the program at all, so this
 *  reroutes the capture the same way "no video here" does instead of ending it. */
class YtDlpMissing extends Error {
	constructor() {
		super(YTDLP_HINT);
	}
}

/** Sent when fetching a page to read as an article. A fair number of publishers
 *  serve a stub or a block page to anything that does not look like a browser,
 *  and Obsidian's own agent string is not one. */
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Below this many characters, what came back is a redirect stub, a consent
 *  wall, or a "please enable JavaScript" page rather than an article. Readability
 *  returns those without complaint, because on such a page that text really is
 *  the only content and so it reads as the article. Far under any real post, far
 *  over a stub. */
const MIN_ARTICLE_CHARS = 200;

/** File kinds the document processor accepts: images (via Text Extractor's
 *  OCR) and PDFs (via Obsidian's bundled pdf.js). */
const DOC_IMG_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif"]);
const isDocExt = (e: string) => e.toLowerCase() === "pdf" || DOC_IMG_EXTS.has(e.toLowerCase());

/** Settings that must never leave this device via data.json: API keys and
 *  Microsoft 365 tokens live in per-vault localStorage, so a data.json
 *  carried to another device by settings sync neither leaks credentials nor
 *  overwrites this device's sign-in. Same pattern as Power Connect. */
const SECRET_KEYS = ["deepgramKey", "transcriptionKey", "assemblyaiKey", "anthropicKey", "llmKey", "embeddingsKey", "graphRefresh", "graphAccess", "graphExpiry"] as const;

/** Everything that is per-device: the credentials above plus this device's
 *  role. These ride the same localStorage stash, so a synced data.json can
 *  neither leak a key nor make the whole fleet claim the same job. */
const DEVICE_KEYS = [...SECRET_KEYS, "deviceRole"] as const;

/** How far back the orphan sweep reaches for PLAIN audio files. A processor
 *  coming online should catch what the fleet recorded this week, not bulk-
 *  transcribe years of deliberately unprocessed memos at cloud rates. Queued
 *  meetings and rotation sidecars are explicit intent and never expire. */
const ORPHAN_HORIZON_MS = 7 * 24 * 60 * 60_000;

export default class PowerAssistantPlugin extends Plugin {
	settings!: PowerAssistantSettings;
	/** The settings as they last stood on disk, read or written by us. Whatever
	 *  differs from this in memory is OUR change, and only those keys may
	 *  overwrite a synced data.json; see saveSettings(). */
	private baseline: PowerAssistantSettings = DEFAULT_SETTINGS;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private stopStreams: (() => void) | null = null;
	private inFlight = new Set<string>();
	/** One sweep at a time; the two-minute beat skips a beat that is running long. */
	private sweeping = false;
	/** "Assistant queue: N" in the status bar; empty text when nothing waits,
	 *  and clickable to force a sweep while something does. */
	private queueStatusEl: HTMLElement | null = null;
	private ribbon!: HTMLElement;
	/** The ribbon icons, so hiding one is immediate rather than a reload. */
	private ribbonEls: Partial<Record<"record" | "meeting" | "briefing" | "assistant", HTMLElement>> = {};
	/** Recording session state: parts, marks, and the crash-safe partial. */
	private recStream: MediaStream | null = null;
	private recStamp = "";
	private recExt = "webm";
	private recMime = "";
	private recStart = 0;
	private partStart = 0;
	/** Accumulated paused time, and the start of an ongoing pause (0 = not paused);
	 *  subtracted from elapsed so moment/turn stamps stay aligned to the audio. */
	private recPausedMs = 0;
	private pauseStart = 0;
	private parts: { path: string; offsetMs: number }[] = [];
	private rotating = false;
	private marks: Moment[] = [];
	private momentsByCapture: Record<string, Moment[]> = {};
	/** Pending debounced write of the usage ledger; see recordUsage. */
	private usageSaveTimer: number | null = null;
	private partialAbs: string | null = null;
	private flushChain: Promise<void> = Promise.resolve();
	private live: LiveSession | null = null;
	/** The floating on-page recording bar (timer, meter, Stop), bound to the note
	 *  the recording started from. */
	recBar: RecordingBar | null = null;
	/** A stop click that lands in the rotation gap: honor it at the next seam. */
	private stopRequested = false;
	/** finishPart is tearing the session down: gates a second, concurrent run
	 *  (a double Stop click, or an onerror racing onstop) so cleanup never
	 *  double-saves. Reset when a fresh recording starts. */
	private finishing = false;
	/** Set in onunload: lets a floating bar orphaned by a plugin reload detect
	 *  its owner is dead and remove itself. */
	unloaded = false;
	/** Debounce + re-entrancy state for the person-page auto-refresh. */
	private peopleRefreshTimer: number | null = null;
	private refreshingPeople = false;
	/** Documents currently being OCR'd/filed, keyed by their original path. */
	private docsInFlight = new Set<string>();
	/** Session generation counter: bumped when a recording starts and when a
	 *  wedged session is force-released. A finishPart that hung mid-await and
	 *  resumes later re-checks this and abandons itself, so it can never clobber
	 *  the force teardown (or a newer session) that superseded it. */
	private sessionGen = 0;
	/** A meeting recording folds into an existing note instead of a new one:
	 *  the note's path plus the extraction sections chosen for the meeting. */
	private meetingTargetPath: string | null = null;
	private meetingTargetExtractions: ProcessOverrides["extractions"] | null = null;
	/** This session is a mic-button quick recording whose destination will be
	 *  ASKED at stop time. Set at start (the create event fires the moment a
	 *  part is written, long before any dialog could), so finishPart can mark
	 *  the parts directProcess and keep the auto-processor's hands off them. */
	private askOnStop = false;
	/** Audio paths handled directly (meeting recordings). The create-event
	 *  auto-processor skips these so they never also spawn a separate note. */
	private directProcess = new Set<string>();
	/** Recordings THIS device just finished and deliberately left to the
	 *  create event (single-part standalone sessions). Audio in the recordings
	 *  folder auto-processes only off this list: a recording that syncs in
	 *  from another device belongs to the processor's sweep, which knows to
	 *  leave queued-meeting audio alone. Without this, the box could eat a
	 *  meeting recording as a standalone note in the window before its queued
	 *  meeting note synced over. */
	private localAuto = new Set<string>();
	/** Claude's speaker-name guesses per note (label → name), feeding the
	 *  transcript label menu when naming happens in the transcript rather than
	 *  a dialog. In-memory only: a reload costs the guesses, never the words. */
	private speakerGuesses: Record<string, Record<string, string>> = {};
	/** The dropped-letter-rules notice fires once per session, not per reload. */
	private warnedLetterRules = false;
	/** Set by the settings tab so connect/disconnect can re-render it. */
	refreshSettingsTab: (() => void) | null = null;
	/** Held so a not-connected notice can open settings on a specific tab. */
	private settingTab: AssistantSettingTab | null = null;
	/** Guards against two overlapping device-code sign-in flows. */
	private graphConnecting = false;
	index = new SearchIndex();
	private indexMeta: Record<string, number> = {};
	private indexChunks: Record<string, Chunk[]> = {};
	private persistTimer: number | null = null;
	/** Per-note embedding vectors for semantic search, keyed by path. */
	private embeds: Record<string, { mtime: number; vec: number[] }> = {};
	private embedTimer: number | null = null;
	private embedding = false;
	/** Cross-plugin API: Power Explorer's search modal drives its Ask mode
	 *  through this, and Power Calendar's event cards open meeting notes.
	 *  Stable shape — add to it, don't change it. */
	api = {
		ask: (question: string): Promise<{ answer: string; hits: number }> => this.askVault(question),
		/** Open the New meeting dialog prefilled. Missing fields stay blank,
		 *  exactly as if a pasted invite had not mentioned them. */
		newMeeting: (invite?: Partial<ParsedInvite>): void => {
			const base: ParsedInvite = { title: "", date: "", when: "", attendees: [], location: "", agenda: "", teamsUrl: "", meetingId: "", passcode: "" };
			new NewMeetingModal(this.app, this, invite ? { ...base, ...invite } : undefined).open();
		},
		/** Power Desk's mail poll hands matched messages here. Returns the number
		 *  of orders captured, so the caller can report without knowing anything
		 *  about how extraction works. */
		captureTransaction: (mail: TxnMail & { html?: string; text?: string; webLink?: string; attachments?: string[] }): Promise<number> => this.captureTransactionMail(mail),
		/** Whether transaction capture is configured, so a sibling can skip the
		 *  work of fetching bodies that would only be dropped. */
		transactionsReady: (): boolean => !!this.settings.txnFolder.trim() && this.llmReady(),
		/** Which of these messages are worth fetching a body for. Matching lives
		 *  here rather than in the caller so the rules, the settings, and the
		 *  already-processed ledger stay in one place; Power Desk only has to
		 *  supply headers and fetch what comes back. */
		transactionSelect: (mail: TxnMail[]): TxnMail[] => selectTxnMail(mail, this.settings.txnRules, this.settings.txnSeen).map((p) => p.mail),
	};

	async onload() {
		await this.loadSettings();
		this.settingTab = new AssistantSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.ribbon = this.addRibbonIcon("mic", "Power Assistant: start recording", () => void this.toggleRecording());
		this.addCommand({ id: "toggle-recording", icon: "mic", name: "Start / stop recording", callback: () => void this.toggleRecording() });
		this.addCommand({
			id: "show-running-version", icon: "info",
			name: "Show running version",
			callback: () => new Notice(`Power Assistant: running build ${PC_BUILD} (disk says ${this.manifest.version}).`, 8000),
		});
		this.ribbonEls.meeting = this.addRibbonIcon("calendar-plus", "Power Assistant: new meeting note", () => new NewMeetingModal(this.app, this).open());
		this.addCommand({ id: "new-meeting-note", icon: "file-plus", name: "New meeting note…", callback: () => new NewMeetingModal(this.app, this).open() });
		this.addCommand({ id: "import-from-calendar", icon: "calendar", name: "Import meeting from calendar (Microsoft 365)…", callback: () => void this.importFromCalendar() });
		this.addCommand({
			id: "process-active-file", icon: "play",
			name: "Process the active audio file…",
			callback: () => {
				const f = this.app.workspace.getActiveFile();
				if (f && AUDIO_EXTS.has(f.extension.toLowerCase())) new ProcessModal(this.app, this, f).open();
				else new Notice("Power Assistant: the active file is not an audio file.");
			},
		});
		this.addCommand({
			id: "run-extraction-evals", icon: "check-check",
			name: "Run extraction evals (compare the AI model against saved notes)",
			callback: () => void this.runEvals(),
		});
		this.addCommand({
			id: "process-pending-now", icon: "play",
			name: "Process pending recordings on this device now",
			callback: () => {
				new Notice("Power Assistant: checking for pending recordings…");
				void this.sweepPending(true);
			},
		});
		this.addCommand({
			id: "capture-youtube", icon: "youtube",
			name: "Capture a YouTube video…",
			callback: () => new YoutubeModal(this.app, this).open(),
		});
		this.addCommand({
			id: "capture-link", icon: "link",
			name: "Capture from a link…",
			callback: () => new LinkModal(this.app, this).open(),
		});
		this.addCommand({
			id: "import-amazon-csv", icon: "shopping-cart",
			name: "Import Amazon order history (Retail.OrderHistory.csv)",
			callback: () => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension.toLowerCase() !== "csv") {
					new Notice("Power Assistant: open the Retail.OrderHistory.csv from your Amazon data export first.", 8000);
					return;
				}
				void this.importAmazonCsv(f);
			},
		});
		this.addCommand({ id: "spend-rollup", icon: "dollar-sign", name: "Spending rollup (personal)", callback: () => void this.spendRollup("personal") });
		this.addCommand({ id: "spend-rollup-business", icon: "briefcase", name: "Spending rollup (business)", callback: () => void this.spendRollup("business") });
		this.addCommand({ id: "categorize-backlog", icon: "tags", name: "Categorize uncategorized purchases", callback: () => void this.categorizeBacklog() });
		this.addCommand({ id: "create-spending-base", icon: "database", name: "Create the Spending base", callback: () => void this.createTransactionsBase() });
		this.addCommand({
			id: "import-mail-folder", icon: "mail",
			name: "Import a mail folder as notes…",
			callback: () => {
				if (!this.mailImportAvailable()) {
					new Notice("Power Assistant: install Power Desk and connect a mailbox to import mail.", 8000);
					return;
				}
				new MailFolderModal(this.app, this).open();
			},
		});
		this.addCommand({
			id: "refresh-mail-window", icon: "refresh-cw",
			name: "Refresh the mail search window now",
			callback: () => {
				if (!this.mailFeed()) {
					new Notice("Power Assistant: install Power Desk and connect a mailbox to search your email.", 8000);
					return;
				}
				if (this.settings.mailWindowDays <= 0) {
					new Notice("Power Assistant: set a mail window in settings (Transactions tab) first.", 8000);
					return;
				}
				new Notice("Power Assistant: refreshing the mail search window…");
				void this.refreshMailWindow().then((n) => new Notice(`Power Assistant: mail window updated (${n} new message${n === 1 ? "" : "s"}).`));
			},
		});
		this.addCommand({
			id: "capture-transactions-from-file", icon: "receipt",
			name: "Capture transactions from this email file (.eml)",
			callback: () => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !/^(eml|html?)$/i.test(f.extension)) {
					new Notice("Power Assistant: open a saved .eml or .html message first.");
					return;
				}
				void (async () => {
					const raw = await this.app.vault.read(f);
					// an .eml carries its own headers; a bare .html is just a body
					const p = /^eml$/i.test(f.extension) ? parseEmailFile(raw) : { from: "", subject: f.basename, date: "", html: raw, text: "" };
					await this.captureTransactionMail({ id: `file:${f.path}`, from: p.from, subject: p.subject || f.basename, date: p.date, html: p.html, text: p.text });
				})();
			},
		});
		this.addCommand({
			id: "capture-pptx", icon: "presentation",
			name: "Capture a PowerPoint…",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				if (active?.extension.toLowerCase() === "pptx") new PptxModal(this.app, this, active).open();
				else new PptxSuggestModal(this.app, (f) => new PptxModal(this.app, this, f).open()).open();
			},
		});
		// Drop a deck onto a note and it captures, rather than landing as a dead
		// attachment link. The file is stored first so the note can point at it.
		this.registerEvent(
			this.app.workspace.on("editor-drop", (evt, _editor, info) => {
				const deck = Array.from(evt.dataTransfer?.files ?? []).find((f) => f.name.toLowerCase().endsWith(".pptx"));
				if (!deck || evt.defaultPrevented) return;
				evt.preventDefault();
				void (async () => {
					try {
						const dest = await this.app.fileManager.getAvailablePathForAttachment(deck.name, info.file?.path ?? "");
						const saved = await this.app.vault.createBinary(dest, await deck.arrayBuffer());
						new PptxModal(this.app, this, saved).open();
					} catch (e) {
						console.error("Power Assistant:", e);
						new Notice("Power Assistant: couldn't read that deck. " + (e instanceof Error ? e.message : String(e)), 8000);
					}
				})();
			})
		);
		this.addCommand({
			id: "capture-x", icon: "at-sign",
			name: "Capture an X post…",
			callback: () => new XModal(this.app, this).open(),
		});
		this.addCommand({
			id: "capture-web", icon: "globe",
			name: "Capture a web page…",
			callback: () => new LinkModal(this.app, this, "web").open(),
		});
		this.addCommand({ id: "mark-moment", icon: "flag", name: "Mark this moment (while recording)", callback: () => this.markMoment() });
		const activeCapture = (): TFile | null => {
			const f = this.app.workspace.getActiveFile();
			if (!f || f.extension !== "md") return null;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { type?: string; tags?: unknown } | undefined;
			return isCaptureNote(fm) ? f : null;
		};
		this.addCommand({
			id: "ask-meeting", icon: "message-square",
			name: "Ask about this meeting…",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) void this.openMeetingAsk(f);
				return !!f;
			},
		});
		this.addCommand({
			id: "record-into-note", icon: "mic",
			name: "Record a meeting into this note",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) void this.startMeetingRecording(f, null);
				return !!f && !this.recStream;
			},
		});
		this.addCommand({
			id: "rename-speakers", icon: "users",
			name: "Rename speakers in this capture…",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) void this.renameSpeakersIn(f);
				return !!f;
			},
		});
		this.addCommand({
			id: "draft-from-meeting", icon: "pencil",
			name: "Draft from this meeting…",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) void this.draftFromNote(f);
				return !!f;
			},
		});
		this.addCommand({ id: "draft-from-recent", icon: "pencil", name: "Draft from recent meetings…", callback: () => void this.draftFromRecent() });
		this.addCommand({
			id: "email-page", icon: "mail",
			name: "Email this page…",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || f.extension !== "md") return false;
				if (!checking) void this.sharePage(f);
				return true;
			},
		});
		this.addCommand({
			id: "import-transcript", icon: "file-text",
			name: "Import a transcript file (Otter, Teams, Zoom)…",
			callback: () => {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = ".vtt,.srt,.txt";
				input.onchange = () => {
					const f = input.files?.[0];
					if (!f) return;
					const date = dayOf(new Date(f.lastModified));
					void f.text().then((t) => this.importTranscript(f.name, t, date));
				};
				input.click();
			},
		});
		this.addCommand({
			id: "add-screens", icon: "image",
			name: "Add screens from a video file…",
			// any capture note qualifies, with or without an embedded recording:
			// the whole point of this one is the video that is NOT in the vault
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const f = view?.file;
				if (!f || f.extension !== "md") return false;
				if (!checking) new ScreensModal(this.app, this, f, this.noteVideoFiles(view)[0] ?? null).open();
				return true;
			},
		});
		this.addCommand({
			id: "grab-frame-at-stamp", icon: "camera",
			name: "Grab a frame at this stamp",
			// offered only for a note that actually embeds a video: on any other
			// note the answer would always be "there is nothing to grab from",
			// which is a command palette entry earning its keep by apologising
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file || !this.noteVideoFiles(view).length) return false;
				if (!checking) void this.grabFrameAtStamp(view);
				return true;
			},
		});
		this.addCommand({
			id: "re-extract", icon: "refresh-cw",
			name: "Re-extract this capture…",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) new ReExtractModal(this.app, this, f, this.reExtractSeed(f)).open();
				return !!f;
			},
		});
		this.addCommand({
			id: "re-extract-folder", icon: "refresh-ccw",
			name: "Re-extract every capture in a folder…",
			callback: () => new FolderPickModal(this.app, (folder) => new BulkReExtractModal(this.app, this, folder).open()).open(),
		});
		this.addCommand({
			id: "stop-re-extract-folder", icon: "square",
			name: "Stop the bulk re-extract",
			checkCallback: (checking) => {
				if (!checking) this.stopBulkReExtract();
				return this.bulkRunning;
			},
		});
		this.addCommand({
			id: "copy-summary", icon: "copy",
			name: "Copy summary to clipboard",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) void this.copySummary(f);
				return !!f;
			},
		});
		this.addCommand({
			id: "copy-summary-redacted", icon: "copy",
			name: "Copy redacted summary to clipboard",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) void this.copySummary(f, true);
				return !!f;
			},
		});
		this.addCommand({
			id: "pause-recording", icon: "pause",
			name: "Pause / resume recording",
			checkCallback: (checking) => {
				const active = !!this.recorder && this.recorder.state !== "inactive";
				if (!checking && active) this.togglePause();
				return active;
			},
		});
		this.addCommand({
			id: "export-docx", icon: "file-down",
			name: "Export as Word document (.docx)",
			checkCallback: (checking) => {
				const f = activeCapture();
				if (!checking && f) void this.exportDocx(f);
				return !!f;
			},
		});
		this.addCommand({
			id: "person-report", icon: "user",
			name: "Person report…",
			callback: () => new PersonPickModal(this.app, this.knownAttendees(), (n) => void this.personReport(n, false)).open(),
		});
		this.addCommand({
			id: "correct-term", icon: "pencil",
			name: "Correct a name or term…",
			editorCheckCallback: (checking, editor, view) => {
				if (!(view instanceof MarkdownView) || !view.file) return false;
				if (!checking) void this.correctTermIn(view.file, editor.getSelection().trim());
				return true;
			},
		});
		this.addCommand({
			id: "convert-transcript-plain", icon: "type",
			name: "Convert transcript to plain, editable text",
			editorCheckCallback: (checking, editor, view) => {
				if (!(view instanceof MarkdownView) || !view.file) return false;
				if (!checking) void this.convertTranscriptIn(view.file);
				return true;
			},
		});
		this.addCommand({
			id: "convert-all-transcripts-plain", icon: "type",
			name: "Convert all transcripts to plain, editable text",
			callback: () => void this.convertAllTranscripts(),
		});
		this.addCommand({
			id: "highlight-selection", icon: "highlighter",
			name: "Highlight the selection",
			editorCheckCallback: (checking, editor, view) => {
				if (!(view instanceof MarkdownView) || !editor.getSelection()) return false;
				if (!checking) {
					const sel = editor.getSelection();
					const t = sel.trim();
					// toggle: unwrap an existing ==highlight==, else wrap the selection
					editor.replaceSelection(/^==[\s\S]+==$/.test(t) ? t.slice(2, -2) : `==${sel}==`);
				}
				return true;
			},
		});
		this.addCommand({
			id: "add-transcript-comment", icon: "message-square",
			name: "Add a comment to this turn",
			editorCheckCallback: (checking, editor, view) => {
				if (!(view instanceof MarkdownView)) return false;
				if (!checking) {
					const cur = editor.getCursor();
					const line = editor.getLine(cur.line);
					new TextPromptModal(this.app, "Add a comment", "A note on this turn, shown as a comment bubble in the transcript.", "", (text) => {
						const t = text.trim();
						if (!t) return;
						// keep the comment inside the callout with a blank quote line so
						// it renders as its own paragraph; outside a callout use a blank line
						const insert = /^>\s?/.test(line) ? `\n>\n> 💬 ${t}` : `\n\n💬 ${t}`;
						editor.replaceRange(insert, { line: cur.line, ch: line.length });
					}).open();
				}
				return true;
			},
		});
		this.addCommand({
			id: "prep-oneonone", icon: "users",
			name: "Prep for a 1:1…",
			callback: () => new PersonPickModal(this.app, this.knownAttendees(), (n) => void this.personReport(n, true)).open(),
		});
		this.addCommand({ id: "weekly-digest", icon: "calendar-days", name: "Weekly meeting digest", callback: () => void this.weeklyDigest() });
		this.addCommand({ id: "morning-briefing", icon: "sunrise", name: "Morning briefing", callback: () => void this.morningBriefing() });
		this.ribbonEls.briefing = this.addRibbonIcon("sunrise", "Power Assistant: morning briefing", () => void this.morningBriefing());
		this.addCommand({ id: "create-meetings-base", icon: "database", name: "Create the Meetings base", callback: () => void this.createMeetingsBase() });
		this.addCommand({ id: "finances-rollup", icon: "dollar-sign", name: "Finances rollup", callback: () => void this.financesRollup() });
		this.addCommand({ id: "create-finances-base", icon: "database", name: "Create the Finances base", callback: () => void this.createFinancesBase() });
		this.registerView(LIVE_VIEW, (leaf) => new LiveView(leaf, this));
		this.registerView(ASSIST_VIEW, (leaf) => new AssistantChatView(leaf, this));
		this.registerView(USAGE_VIEW, (leaf) => new UsageMeterView(leaf, this));
		this.addCommand({ id: "open-assistant-chat", icon: "bot", name: "Open assistant chat", callback: () => void this.openAssistant() });
		this.addCommand({ id: "open-usage-meter", icon: "gauge", name: "Open the AI usage meter", callback: () => void this.openUsageMeter() });
		this.addCommand({
			id: "process-document", icon: "scan",
			name: "Process the active document (OCR)",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !isDocExt(f.extension)) return false;
				if (!checking) void this.processDocument(f);
				return true;
			},
		});
		this.ribbonEls.assistant = this.addRibbonIcon("sparkles", "Power Assistant: open the assistant", () => void this.openAssistant());
		this.ribbonEls.record = this.ribbon;
		this.applyRibbonVisibility();
		// after the UI exists, so the notice's "Open setup" link has a tab to open
		this.app.workspace.onLayoutReady(() => this.nudgeSetupOnce());

		// [m:ss] stamps in capture notes seek the embedded audio on click, and
		// unnamed "Speaker X" labels open the rename dialog (the Otter gesture)
		this.registerMarkdownPostProcessor((el, ctx) => {
			const fm = this.app.metadataCache.getCache(ctx.sourcePath)?.frontmatter as
				| { type?: string; tags?: unknown; parts?: number[] }
				| undefined;
			if (!isCaptureNote(fm)) return;
			decorateStamps(el, partOffsetsOf(fm as Record<string, unknown>));
			enhanceTranscriptCallout(
				el,
				(name) => this.speakerColorFor(name),
				(name) => this.settings.speakerEmoji[name] || "",
				(name, evt, turn) => {
					const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
					if (f instanceof TFile) this.openSpeakerMenu(name, evt, f, el, turn);
				},
				(secs) => this.seekFromEditor(secs)
			);
			decorateSpeakerLabels(el, () => {
				const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
				if (f instanceof TFile) void this.renameSpeakersIn(f);
			});
			this.watchAudioDurations(el, ctx);
		});
		// keep the transcript styled AND editable in Live Preview (Edit mode)
		this.registerEditorExtension(transcriptLivePreview(this));
		// resolve the audio embed's total length in Edit mode too (the reading-view
		// post-processor does not run over the Live Preview editor DOM)
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scanActiveAudio()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scanActiveAudio()));
		this.app.workspace.onLayoutReady(() => this.scanActiveAudio());
		this.register(() => {
			this.player?.destroy();
			this.player = null;
		});
		this.addCommand({
			id: "rebuild-index", icon: "refresh-cw",
			name: "Rebuild the Ask index",
			callback: () => void this.syncIndex(true).then((n) => new Notice(`Power Assistant: indexed ${n} note(s).`)),
		});

		// Right-click any audio file → Process; any capture note → Ask / Rename.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, af) => {
				if (af instanceof TFolder) {
					// only offered where there is something to do: a folder of ordinary
					// notes should not grow a Power Assistant item
					if (!this.capturesIn(af, true).length) return;
					menu.addItem((i) =>
						i
							.setTitle("Re-extract captures here…")
							.setIcon("refresh-cw")
							.onClick(() => new BulkReExtractModal(this.app, this, af).open())
					);
					return;
				}
				if (!(af instanceof TFile)) return;
				if (AUDIO_EXTS.has(af.extension.toLowerCase())) {
					menu.addItem((i) =>
						i
							.setTitle("Process with Power Assistant…")
							.setIcon("mic")
							.onClick(() => new ProcessModal(this.app, this, af).open())
					);
					return;
				}
				if (isDocExt(af.extension)) {
					menu.addItem((i) =>
						i
							.setTitle("Process document (Power Assistant)")
							.setIcon("scan-text")
							.onClick(() => void this.processDocument(af))
					);
					return;
				}
				if (["vtt", "srt", "txt"].includes(af.extension.toLowerCase())) {
					menu.addItem((i) =>
						i
							.setTitle("Import transcript with Power Assistant…")
							.setIcon("import")
							.onClick(() =>
								void this.app.vault
									.read(af)
									.then((t) => this.importTranscript(af.name, t, dayOf(new Date(af.stat.ctime))))
							)
					);
					return;
				}
				if (af.extension !== "md") return;
				// any note can be emailed, so this sits above the capture-only gate
				menu.addItem((i) => i.setTitle("Email this page…").setIcon("mail").onClick(() => void this.sharePage(af)));
				const fm = this.app.metadataCache.getFileCache(af)?.frontmatter as { type?: string; tags?: unknown } | undefined;
				if (!isCaptureNote(fm)) return;
				menu.addItem((i) =>
					i.setTitle("Ask about this meeting…").setIcon("message-circle").onClick(() => void this.openMeetingAsk(af))
				);
				menu.addItem((i) =>
					i.setTitle("Draft from this meeting…").setIcon("pen-line").onClick(() => void this.draftFromNote(af))
				);
				menu.addItem((i) =>
					i.setTitle("Rename speakers…").setIcon("users").onClick(() => void this.renameSpeakersIn(af))
				);
				menu.addItem((i) =>
					i.setTitle("Correct a name or term…").setIcon("replace").onClick(() => void this.correctTermIn(af, ""))
				);
				menu.addItem((i) =>
					i.setTitle("Re-extract…").setIcon("refresh-cw").onClick(() => new ReExtractModal(this.app, this, af, this.reExtractSeed(af)).open())
				);
				menu.addItem((i) =>
					i.setTitle("Copy summary").setIcon("clipboard-copy").onClick(() => void this.copySummary(af))
				);
				menu.addItem((i) =>
					i.setTitle("Export as Word (.docx)").setIcon("file-text").onClick(() => void this.exportDocx(af))
				);
			})
		);

		// right-click selected transcript text to correct a misheard name/word
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, view) => {
				const file = view.file;
				if (!file) return;
				// right-clicking a stamped line offers its frame, selection or not.
				// The cheap test (is there a stamp here?) gates the one that reads
				// the whole document looking for a video embed.
				const md = view instanceof MarkdownView ? view : null;
				const cur = editor.getCursor();
				if (md && stampSecsOnLine(editor.getLine(cur.line), cur.ch) != null && this.noteVideoFiles(md).length) {
					menu.addItem((i) => i.setTitle("Grab a frame at this stamp").setIcon("image").onClick(() => void this.grabFrameAtStamp(md)));
				}
				const sel = editor.getSelection().trim();
				if (!sel) return;
				const label = sel.length > 24 ? sel.slice(0, 24) + "…" : sel;
				menu.addItem((i) => i.setTitle(`Correct "${label}"…`).setIcon("replace").onClick(() => void this.correctTermIn(file, sel)));
			})
		);

		// the last-edited stamp: repainted whenever the page it belongs to could
		// have changed under it, and re-timed on the minute so "3 minutes ago"
		// does not sit there being wrong until the note is reopened
		this.registerEvent(this.app.workspace.on("file-open", () => this.refreshEditedStamps()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshEditedStamps()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshEditedStamps()));
		this.registerEvent(this.app.vault.on("modify", () => this.refreshEditedStamps()));
		this.app.workspace.onLayoutReady(() => this.refreshEditedStamps());
		this.registerInterval(window.setInterval(() => this.refreshEditedStamps(), 60_000));

		// Register watchers after layout-ready: vault fires `create` for every
		// existing file during the startup index, which must not trigger processing.
		this.app.workspace.onLayoutReady(() => {
			void this.recoverPartials();
			// the deferred-processing beat: the processor claims what the fleet
			// parked; every role repaints the queue count. First pass waits out
			// the launch sync burst instead of racing it.
			this.queueStatusEl = this.addStatusBarItem();
			// the count is where the backlog gets noticed, so it is where the
			// override belongs: clicking it runs the same forced sweep as the
			// "process pending recordings now" command
			this.queueStatusEl.addEventListener("click", () => {
				if (this.sweeping) {
					new Notice("Power Assistant: already working through the queue.");
					return;
				}
				new Notice("Power Assistant: checking for pending recordings…");
				void this.sweepPending(true);
			});
			window.setTimeout(() => {
				this.paintQueueStatus();
				void this.sweepPending();
			}, 8000);
			this.registerInterval(window.setInterval(() => void this.sweepPending(), 120_000));
			this.registerInterval(window.setInterval(() => this.paintQueueStatus(), 30_000));
			// the rolling mail window: load once, then top up on a slow beat so
			// recent email stays searchable without a note per message
			window.setTimeout(() => void this.refreshMailWindow(), 12000);
			this.registerInterval(window.setInterval(() => void this.refreshMailWindow(), 15 * 60_000));
			this.registerEvent(
				this.app.vault.on("create", (af) => {
					if (!(af instanceof TFile)) return;
					if (AUDIO_EXTS.has(af.extension.toLowerCase())) {
						// a meeting recording is processed directly into its note; never
						// let the auto-processor also spawn a separate note from it
						if (this.directProcess.has(af.path)) {
							this.directProcess.delete(af.path);
							return;
						}
						if (!this.settings.autoProcess || this.settings.deviceRole === "capture") return;
						// audio directly in the capture folder OR the recordings folder auto-processes
						if (!this.recordingWatchFolders().some((f) => af.path === `${f}/${af.name}`)) return;
						// rotated part files are processed together at final stop
						if (/\.part\d+\.\w+$/.test(af.name)) return;
						// give sync a moment to finish writing large files. Ownership is
						// decided INSIDE the delay: a local session's dispatch (which
						// marks localAuto) races these same 1500ms.
						window.setTimeout(() => {
							// this device's own finished recording: fast path, as always
							if (this.localAuto.delete(af.path)) {
								void this.process(af, undefined, true);
								return;
							}
							const cap = normalizePath(this.settings.captureFolder);
							const rec = normalizePath(this.recordingFolder());
							// a drop into a capture folder that is NOT also the recordings
							// folder is unambiguous user intent: fast path
							if (cap !== rec && af.path === `${cap}/${af.name}`) {
								void this.process(af, undefined, true);
								return;
							}
							// everything else synced in (or shares the recordings folder,
							// where a meeting recording is indistinguishable from a drop):
							// give a queued meeting note time to arrive, then take only
							// what no note has claimed
							window.setTimeout(() => {
								if (this.queuedRecordingPaths().has(af.path) || this.audioLinked(af.path)) return;
								void this.process(af, undefined, true);
							}, 45_000);
						}, 1500);
					} else if (isDocExt(af.extension) && cleanFolderPath(this.settings.docInbox) && af.parent?.path === cleanFolderPath(this.settings.docInbox)) {
						// a scan dropped into the inbox files itself: OCR, extract,
						// organize, note. The delay lets sync finish writing the file.
						window.setTimeout(() => void this.processDocument(af), 1500);
					} else {
						// a blank note born from clicking a missing attendee link
						// becomes that person's hub in the People folder
						if (af.extension === "md") {
							void this.fillPersonPage(af);
							this.schedulePeopleRefresh();
						}
						if (this.indexable(af.path)) void this.indexFile(af);
					}
				})
			);
			this.registerEvent(
				this.app.vault.on("modify", (af) => {
					if (!(af instanceof TFile)) return;
					if (this.indexable(af.path)) void this.indexFile(af);
					// an edited meeting note changes hubs' commitments and lists;
					// person pages themselves are capture-person, so no feedback loop
					if (af.extension === "md" && isCaptureNote(this.app.metadataCache.getFileCache(af)?.frontmatter as { type?: unknown; tags?: unknown } | undefined))
						this.schedulePeopleRefresh();
				})
			);
			this.registerEvent(
				this.app.vault.on("delete", (af) => {
					if (!(af instanceof TFile)) return;
					if (this.indexMeta[af.path] !== undefined) this.dropFromIndex(af.path);
					// the file is gone, so its frontmatter can't be checked: any md
					// delete may have been a meeting; the refresh is debounced + cheap
					if (af.extension === "md") this.schedulePeopleRefresh();
				})
			);
			this.registerEvent(
				this.app.vault.on("rename", (af, oldPath) => {
					if (this.indexMeta[oldPath] !== undefined) this.dropFromIndex(oldPath);
					if (af instanceof TFile && this.indexable(af.path)) void this.indexFile(af);
					if (af instanceof TFile && af.extension === "md") this.schedulePeopleRefresh();
				})
			);
			this.register(() => {
				if (this.peopleRefreshTimer != null) window.clearTimeout(this.peopleRefreshTimer);
			});
			void this.loadIndex()
				.then(() => this.loadEmbeddings())
				.then(() => this.syncIndex(false))
				.then(() => {
					// backfill embeddings for the assistant's notes, quietly, when on
					if (this.semanticEnabled()) window.setTimeout(() => void this.syncEmbeddings(), 4000);
				});
			this.register(() => {
				if (this.embedTimer) window.clearTimeout(this.embedTimer);
			});
			if (this.settings.autoWeeklyDigest) {
				const t = window.setTimeout(() => void this.maybeAutoDigest(), 6000);
				this.register(() => window.clearTimeout(t)); // don't fire on a torn-down plugin
			}
			if (this.settings.autoMorningBriefing) {
				const t = window.setTimeout(() => void this.maybeAutoBriefing(), 8000);
				this.register(() => window.clearTimeout(t));
			}
		});
	}

	onunload() {
		// full teardown: a plugin reload mid-recording must never leave a zombie
		// floating bar wired to this dead instance, or a live mic stream. The
		// crash-safe partial stays on disk and the next launch recovers the audio.
		this.unloaded = true;
		// our stamps outlive us in the DOM otherwise, and with the stylesheet
		// gone they would sit on the page as unstyled stray text
		for (const el of Array.from(document.querySelectorAll(".ptc-edited"))) el.remove();
		this.live?.stop();
		this.live = null;
		const rec = this.recorder;
		this.recorder = null;
		if (rec) {
			rec.ondataavailable = null;
			rec.onstop = null;
			rec.onerror = null;
			try {
				if (rec.state !== "inactive") rec.stop();
			} catch {
				/* already dead */
			}
		}
		this.recBar?.destroy();
		this.recBar = null;
		try {
			this.stopStreams?.();
		} catch {
			/* tracks may already be dead */
		}
		this.stopStreams = null;
		this.recStream = null;
	}

	/* ---------------- recording ---------------- */

	async toggleRecording() {
		// Stop any active session. recStream is the sentinel: non-null from start
		// until the final cleanup finishes, so `recorder || recStream` catches every
		// state — live, paused, mid-rotation, or a recorder that died on its own.
		if (this.recorder || this.recStream) {
			// breadcrumb for the console: exactly what state this stop click saw
			console.warn(
				`Power Assistant ${PC_BUILD}: stop requested`,
				JSON.stringify({ recorder: this.recorder?.state ?? "none", finishing: this.finishing, stopRequested: this.stopRequested, gen: this.sessionGen })
			);
			this.rotating = false;
			this.stopRequested = true;
			// last line of defense: if the stop has not finished in a few seconds
			// (a wedged encoder, a hung await), force-release the session
			this.armStopWatchdog();
			const rec = this.recorder;
			if (rec && rec.state !== "inactive") {
				// healthy path: stop() fires onstop -> finishPart, which releases the
				// mic and saves the audio. Works for a live OR a paused recorder.
				try {
					rec.stop();
				} catch (e) {
					console.warn("Power Assistant: recorder.stop() failed; forcing cleanup.", e);
					void this.finishPart(false);
				}
			} else {
				// the recorder is already gone or inactive (it errored, its track
				// ended, or a stop is mid-flight): no onstop and no rotation seam is
				// coming, so force the teardown directly instead of hanging on
				// "stopping…" forever. finishPart's guard no-ops a redundant run.
				new Notice("Power Assistant: stopping…");
				void this.finishPart(false);
			}
			return;
		}
		try {
			const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
			// On desktop, also grab system (loopback) audio so both sides of a
			// Teams/Zoom/Meet call land in the recording. Chromium exposes it via
			// the legacy chromeMediaSource constraint; when unavailable we fall
			// back to mic-only rather than failing the recording.
			let sys: MediaStream | null = null;
			if (this.settings.captureSystemAudio && Platform.isDesktopApp) {
				try {
					sys = await navigator.mediaDevices.getUserMedia({
						audio: { mandatory: { chromeMediaSource: "desktop" } },
						video: { mandatory: { chromeMediaSource: "desktop" } },
					} as unknown as MediaStreamConstraints);
					sys.getVideoTracks().forEach((t) => t.stop());
				} catch (e) {
					console.warn("Power Assistant: system audio unavailable, recording mic only.", e);
					sys = null;
				}
			}
			let stream: MediaStream;
			let ctx: AudioContext | null = null;
			if (sys) {
				ctx = new AudioContext();
				const dest = ctx.createMediaStreamDestination();
				ctx.createMediaStreamSource(mic).connect(dest);
				ctx.createMediaStreamSource(sys).connect(dest);
				stream = dest.stream;
			} else {
				stream = mic;
			}
			this.stopStreams = () => {
				mic.getTracks().forEach((t) => t.stop());
				sys?.getTracks().forEach((t) => t.stop());
				void ctx?.close();
			};
			this.recStream = stream;
			this.stopRequested = false;
			this.finishing = false;
			this.sessionGen++;
			// a flush left wedged by a previous session must not poison this one
			this.flushChain = Promise.resolve();
			this.recMime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
			this.recExt = this.recMime.includes("mp4") ? "m4a" : this.recMime.includes("ogg") ? "ogg" : "webm";
			// a recording is named for the evening it was made, not for the next
			// morning in Greenwich
			this.recStamp = ((d) => `${dayOf(d)}-${clockOf(d)}`)(new Date());
			this.recStart = Date.now();
			// only a bare mic-button session asks where to file; recordings started
			// from a meeting note already know exactly where they are going
			this.askOnStop = !this.meetingTargetPath && this.settings.askQuickFiling;
			this.recPausedMs = 0;
			this.pauseStart = 0;
			this.parts = [];
			this.marks = [];
			await this.ensureFolder(this.recordingFolder());
			this.startRecorderPart();
			// the floating recording bar (timer, level meter, Stop, Mark) rides on
			// the page the recording started from: it shows over that note's tab and
			// hides when you view another. The sidebar opens only for AssemblyAI's
			// live streaming transcript.
			const barNote = this.meetingTargetPath ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
			this.recBar?.destroy();
			this.recBar = new RecordingBar(this, barNote, stream);
			if (this.settings.liveTranscript && this.settings.transcriptionProvider === "assemblyai" && this.settings.assemblyaiKey && Platform.isDesktopApp) {
				const session = this.recStamp;
				void this.openLiveView().then((view) => {
					// the recording may have ended (or a new one begun) while the
					// sidebar leaf was opening: never attach to a stale session
					if (this.recStamp !== session || !this.recStream || !view) return;
					view.reset();
					view.setStatus("Recording — live transcript on");
					this.live = new LiveSession(this, stream, view);
					this.live.start().catch((e) => {
						console.warn("Power Assistant: live transcript unavailable.", e);
						view.setStatus("Recording — live transcript unavailable.");
					});
				});
			}
			this.ribbon.addClass("ptc-recording");
			new Notice(`Power Assistant: recording (${sys ? "mic + system audio" : "mic only"})…`);
			// which provider handles this depends on whether it lands in a meeting
			// note, which is not known yet, so name whichever is not set up
			const unready = [...new Set([this.providerFor("meeting"), this.providerFor("capture")])].filter((p) => !this.providerReady(p));
			if (unready.length)
				new Notice(
					`Power Assistant: no ${unready.join(" or ")} transcription key is set. The audio will be saved, but add a key in settings to transcribe it.`,
					10000
				);
		} catch (e) {
			new Notice("Power Assistant: microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
		}
	}

	/** One MediaRecorder per part; rotation stops it and starts the next on the
	 *  same live streams, so provider file-size limits never truncate a meeting. */
	private startRecorderPart() {
		const rec = new MediaRecorder(this.recStream!, this.recMime ? { mimeType: this.recMime } : undefined);
		this.recorder = rec;
		this.chunks = [];
		this.partStart = Date.now();
		this.openPartial();
		rec.ondataavailable = (e) => {
			if (!e.data.size) return;
			this.chunks.push(e.data);
			this.appendPartial(e.data);
			const limit = Math.max(5, this.settings.maxPartMinutes) * 60_000;
			if (this.settings.maxPartMinutes > 0 && Date.now() - this.partStart > limit && rec.state === "recording") {
				this.rotating = true;
				rec.stop();
			}
		};
		rec.onstop = () => {
			const rotate = this.rotating;
			this.rotating = false;
			void this.finishPart(rotate);
		};
		// a recorder can die on its own — a codec hiccup, or the system-audio
		// loopback track ending — and that fires onerror, NOT onstop. Without this
		// the session would wedge: a dead recorder, a bar still ticking, and Stop
		// stuck on "stopping…". Route the error into the same teardown (save what we
		// have) so the session always ends and the audio is never silently lost.
		rec.onerror = (e) => {
			// ignore a stale error from a recorder we already rotated past, so it
			// can't tear down the fresh part that replaced it
			if (this.recorder !== rec) return;
			console.error("Power Assistant: recording error; ending the session.", (e as { error?: unknown }).error ?? e);
			this.rotating = false;
			this.armStopWatchdog();
			void this.finishPart(false);
		};
		rec.start(1000);
	}

	private async finishPart(rotate: boolean) {
		// one teardown at a time: a double Stop click, or an onerror firing next to
		// onstop, must never run this twice (double-save, double-process)
		if (this.finishing) return;
		this.finishing = true;
		// if a force teardown supersedes this run while it is awaiting (a wedged
		// blob read or vault write), every later step is abandoned: the force
		// path owns cleanup and audio recovery from that point on
		const gen = this.sessionGen;
		const rec = this.recorder;
		this.recorder = null;
		const offsetMs = this.partStart - this.recStart;
		const type = rec?.mimeType || "audio/webm";
		const blob = new Blob(this.chunks, { type });
		this.chunks = [];
		// save first, THEN drop the crash-safe partial; a failed save keeps the
		// partial on disk so the audio is recovered instead of lost
		let saved = false;
		try {
			if (blob.size) {
				const n = this.parts.length + 1;
				const name =
					rotate || this.parts.length
						? `capture-${this.recStamp}.part${n}.${this.recExt}`
						: `capture-${this.recStamp}.${this.recExt}`;
				const path = normalizePath(`${this.recordingFolder()}/${name}`);
				// a meeting recording is folded into its note directly, so keep the
				// auto-processor from also making a separate note out of this file
				// an ask-at-stop session is claimed the same way as a meeting one:
				// its create event fires NOW and the filing answer only exists later
				if (this.meetingTargetPath || this.askOnStop) this.directProcess.add(path);
				// timeboxed: a blob read or vault write that never settles must not
				// hang the teardown (the partial still holds the audio). On a gen
				// mismatch, leave directProcess alone: the force path that superseded
				// this run may have claimed the same path for its own recovery write.
				const buf = await withTimeout(blob.arrayBuffer(), 10_000);
				if (gen !== this.sessionGen) return;
				if (buf === "pcap-timeout") {
					this.directProcess.delete(path); // nothing was written, nothing to consume
					throw new Error("timed out reading the recorded audio");
				}
				let created: TFile | "pcap-timeout";
				try {
					created = await withTimeout(this.app.vault.createBinary(path, buf), 10_000);
				} catch (e) {
					// no create event will consume it (unless a force path owns it now)
					if (gen === this.sessionGen) this.directProcess.delete(path);
					throw e;
				}
				if (gen !== this.sessionGen) return;
				if (created === "pcap-timeout") {
					// keep the directProcess entry: the write may still land late, and
					// the entry stops its create event from auto-making a stray note
					throw new Error("timed out writing the recording file");
				}
				this.parts.push({ path, offsetMs });
			}
			saved = true;
		} catch (e) {
			console.error("Power Assistant: could not save the recording part.", e);
			new Notice(
				"Power Assistant: could not save the recording; the raw audio is kept and will be recovered. " +
					(e instanceof Error ? e.message : String(e)),
				10000
			);
		}
		if (gen !== this.sessionGen) return;
		await this.closePartial(!saved && blob.size > 0);
		if (gen !== this.sessionGen) return;
		if (rotate && saved && !this.stopRequested) {
			// not a real stop, just a part seam: reopen the guard so the next part
			// (and the stop that ends it) can run finishPart again
			this.finishing = false;
			this.startRecorderPart();
			return;
		}
		// final stop: release everything and hand off processing. This tail runs
		// on EVERY exit (including failed saves), so the mic never stays live and
		// the session sentinel always clears.
		const s = this.teardownSession();
		this.finishing = false;
		this.dispatchCapture(s.parts, s.target, s.targetExt, s.marks, undefined, s.ask);
	}

	/** Release the mic, the bar, the live leg, and all session state; returns
	 *  what the session produced so the caller can dispatch processing. The
	 *  session sentinel (recStream) is cleared here, and the meeting target is
	 *  read and cleared unconditionally so a stop that saved nothing can never
	 *  leak the target into the next, unrelated recording. */
	private teardownSession() {
		// every step is individually shielded: ONE throwing step (a deferred
		// sidebar view, a dead AudioContext, anything) must never block the
		// steps after it — that failure mode held stops hostage once already
		const safe = (what: string, fn: () => void) => {
			try {
				fn();
			} catch (e) {
				console.error(`Power Assistant ${PC_BUILD}: teardown step failed (${what}); continuing.`, e);
			}
		};
		safe("ribbon", () => {
			this.ribbon.removeClass("ptc-recording");
			this.ribbon.removeClass("ptc-paused");
		});
		this.pauseStart = 0;
		safe("live session", () => this.live?.stop("Recording ended."));
		this.live = null;
		safe("live panel", () => this.liveView()?.stopMonitor());
		safe("recording bar", () => this.recBar?.destroy());
		this.recBar = null;
		safe("audio streams", () => this.stopStreams?.());
		this.stopStreams = null;
		this.stopRequested = false;
		const parts = this.parts;
		this.parts = [];
		const marks = this.marks.slice();
		this.marks = [];
		this.recStream = null; // cleared LAST: the sentinel gates new sessions
		const target = this.meetingTargetPath;
		this.meetingTargetPath = null;
		const targetExt = this.meetingTargetExtractions;
		this.meetingTargetExtractions = null;
		const ask = this.askOnStop;
		this.askOnStop = false;
		return { parts, target, targetExt, marks, ask };
	}

	/** Hand a finished session's audio to processing: fold into the meeting note
	 *  when there is a target, otherwise the usual notices and auto-processing. */
	private dispatchCapture(
		parts: { path: string; offsetMs: number }[],
		target: string | null,
		targetExt: ProcessOverrides["extractions"] | null,
		marks: Moment[],
		recordedFrom?: number,
		askFiling?: boolean
	) {
		if (marks.length && parts.length) this.momentsByCapture[parts[0].path] = marks.slice();
		if (!parts.length) {
			if (target) new Notice("Power Assistant: nothing was recorded, so the meeting note was left unchanged.");
			return;
		}
		// a meeting recording folds into the note it was started from, regardless
		// of the auto-process settings (the user explicitly asked to record it);
		// on a record-only device the note itself becomes the queue entry instead
		if (target) {
			const note = this.app.vault.getAbstractFileByPath(target);
			const files = parts
				.map((p) => this.app.vault.getAbstractFileByPath(p.path))
				.filter((f): f is TFile => f instanceof TFile);
			if (!(note instanceof TFile)) {
				new Notice("Power Assistant: the meeting note is gone; saved the recording, so process the audio manually to keep the transcript.");
			} else if (files.length !== parts.length) {
				new Notice("Power Assistant: saved the recording, but some audio parts could not be found to add to the meeting note.");
			} else if (this.settings.deviceRole === "capture") {
				const from = recordedFrom ?? this.recStart;
				const recorded = from ? `${clockTime(from)} - ${clockTime(Date.now())}` : undefined;
				void this.queueMeeting(note, files, parts.map((p) => p.offsetMs), targetExt, recorded, marks);
			} else {
				// force recovery passes its session's own start: this.recStart may
				// already belong to a newer recording by the time recovery dispatches
				const from = recordedFrom ?? this.recStart;
				const recorded = from ? `${clockTime(from)} - ${clockTime(Date.now())}` : undefined;
				void this.setMeetingProgress(note, "Transcribing the recording…");
				window.setTimeout(() => void this.processParts(files, parts.map((p) => p.offsetMs), { note, extractions: targetExt, recorded }), 1500);
			}
			return;
		}
		// the mic button records with no destination: ask where the note should
		// live while the answer can still shape it. The parts were marked
		// directProcess at save, so nothing races the dialog. Closing it (or a
		// crash-recovered session, which never asks) files as a capture.
		if (askFiling) {
			// captured NOW: a new session may own recStart by the time you answer
			const from = recordedFrom ?? this.recStart;
			new QuickFilingModal(this.app, this, (meeting) => {
				if (meeting) void this.fileQuickAsMeeting(parts, meeting.title, from);
				else this.dispatchStandalone(parts, true);
			}).open();
			return;
		}
		this.dispatchStandalone(parts, false);
	}

	/** The no-target tail of dispatch: saved-notices plus auto-processing.
	 *  `direct` is the ask-at-stop world, where the parts were marked
	 *  directProcess (their create events were consumed, so no auto path is
	 *  coming) and processing has to be kicked off right here. */
	private dispatchStandalone(parts: { path: string; offsetMs: number }[], direct: boolean) {
		if (this.settings.deviceRole === "capture") {
			// record-only device: the audio (plus, for a rotated session, a
			// sidecar with its part timing) waits for the processor's sweep
			if (parts.length > 1) void this.writePartsSidecar(parts);
			new Notice(
				`Power Assistant: saved ${parts.length === 1 ? parts[0].path.split("/").pop() : `${parts.length} recording parts`}; queued for the processor device.`
			);
			return;
		}
		if (parts.length === 1) {
			new Notice(`Power Assistant: saved ${parts[0].path.split("/").pop()}.`);
			if (!this.settings.autoProcess) return;
			if (!direct) {
				// the vault create event routes single files through auto-processing;
				// marking ours is what lets it tell OUR recording from synced-in audio
				this.localAuto.add(parts[0].path);
				return;
			}
			const f = this.app.vault.getAbstractFileByPath(parts[0].path);
			if (f instanceof TFile) void this.process(f, undefined, true);
			return;
		}
		new Notice(`Power Assistant: saved ${parts.length} recording parts.`);
		if (this.settings.autoProcess) {
			const files = parts
				.map((p) => this.app.vault.getAbstractFileByPath(p.path))
				.filter((f): f is TFile => f instanceof TFile);
			if (files.length === parts.length) {
				window.setTimeout(() => void this.processParts(files, parts.map((p) => p.offsetMs)), direct ? 0 : 1500);
			}
		}
	}

	/** The "file to Meetings" answer: create a meeting note (title optional) and
	 *  re-dispatch the same parts at it, which routes through the exact flow a
	 *  recording started FROM a meeting note takes — meeting provider, progress
	 *  shown in the note, queueing on a record-only device. */
	private async fileQuickAsMeeting(parts: { path: string; offsetMs: number }[], title: string, from?: number) {
		try {
			const note = await this.createMeetingNote({
				title: title.trim() || "Meeting",
				attendees: [],
				agenda: "",
				extractions: null,
				record: false,
				open: false,
			});
			await this.app.workspace.getLeaf(false).openFile(note);
			this.dispatchCapture(parts, note.path, null, [], from);
		} catch (e) {
			console.error("Power Assistant: could not create the meeting note for a quick recording.", e);
			new Notice(
				"Power Assistant: could not create the meeting note (" + (e instanceof Error ? e.message : String(e)) + "); filing as a capture instead.",
				10000
			);
			this.dispatchStandalone(parts, true);
		}
	}

	/** Park a finished meeting recording in the note itself: the recording
	 *  paths, their part offsets, the chosen sections, marks, and a pending
	 *  status a processor can claim. The note is the queue entry, so the
	 *  audio-to-meeting association survives sync, restarts, and time. */
	private async queueMeeting(
		note: TFile,
		files: TFile[],
		offsets: number[],
		extractions: ProcessOverrides["extractions"] | null,
		recorded: string | undefined,
		marks: Moment[]
	) {
		try {
			await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				fm["pa-status"] = "pending";
				fm["pa-recordings"] = files.map((f) => f.path);
				fm["pa-offsets"] = offsets;
				if (extractions)
					fm["pa-sections"] = Object.entries(extractions)
						.filter(([, on]) => on)
						.map(([k]) => k)
						.join(",");
				if (recorded) fm["pa-recorded"] = recorded;
				if (marks.length) fm["pa-marks"] = JSON.stringify(marks);
			});
			await this.setMeetingProgress(note, "Queued. A processor device picks this up when the recording syncs over.");
		} catch (e) {
			console.error("Power Assistant: could not queue the meeting recording.", e);
			new Notice('Power Assistant: could not queue the recording. Open the saved audio and run "Process the active audio file".', 10000);
		}
	}

	/** A rotated standalone session's part timing, parked next to part 1 so the
	 *  processor can stitch the parts in order. Removed after processing. */
	private async writePartsSidecar(parts: { path: string; offsetMs: number }[]) {
		try {
			await this.app.vault.adapter.write(parts[0].path + ".pa.json", JSON.stringify({ offsets: parts.map((p) => p.offsetMs) }));
		} catch (e) {
			console.warn("Power Assistant: could not write the parts sidecar; the parts will process as separate notes.", e);
		}
	}

	/** The processor's beat: claim and process whatever the fleet parked.
	 *  Queued meeting notes come first (they carry explicit intent), then
	 *  orphan audio that synced over with no note anywhere. Serial on purpose:
	 *  one transcription at a time keeps a small box responsive, and the sweep
	 *  runs again two minutes later for whatever is left. `force` is the
	 *  "process pending here now" command from a non-processor device. */
	private async sweepPending(force = false) {
		if (this.sweeping) return;
		if (!force && this.settings.deviceRole !== "processor") return;
		this.sweeping = true;
		try {
			let worked = 0;
			const queued: { note: TFile; fm: Record<string, unknown>; recordings: string[] }[] = [];
			for (const f of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
				const state = pendingState(fm, Date.now());
				if (state !== "pending" && state !== "stale") continue;
				if (!fm || !Array.isArray(fm["pa-recordings"])) continue; // a claim stub, not a queued meeting
				queued.push({ note: f, fm, recordings: pendingRecordings(fm).paths });
			}
			// a sync conflict copy queueing the same recording must not double-
			// transcribe it; one note per recording set goes through
			const { winners, losers } = dedupeQueuedNotes(queued.map((q) => ({ path: q.note.path, recordings: q.recordings })));
			for (const l of losers) console.warn(`Power Assistant: skipping "${l}" (a conflict copy queues the same recording; resolve the duplicate note).`);
			for (const q of queued) {
				if (!winners.has(q.note.path)) continue;
				worked += (await this.processQueuedMeeting(q.note, q.fm)) ? 1 : 0;
			}
			if (this.settings.autoProcess || force) worked += await this.sweepOrphanAudio();
			// a forced sweep that moved nothing owes an explanation: "none were
			// ready" against a visible count is what makes the button look broken
			if (force && !worked) {
				const { blocked } = this.surveyQueue();
				if (blocked.length) {
					const shown = blocked.slice(0, 6).map((b) => `• ${b.name}: ${b.reason}`);
					if (blocked.length > shown.length) shown.push(`• and ${blocked.length - shown.length} more`);
					new Notice(`Power Assistant: nothing here could be processed automatically. These need you:\n${shown.join("\n")}`, 15000);
				} else {
					new Notice("Power Assistant: no pending recordings were ready to process.");
				}
			}
			this.paintQueueStatus();
		} finally {
			this.sweeping = false;
		}
	}

	/** Fold one queued meeting recording into its own note, exactly as if this
	 *  device had recorded it: claim, restore the parked marks and section
	 *  choices, run the meeting pipeline, then clear the queue marker. */
	private async processQueuedMeeting(note: TFile, fm: Record<string, unknown>): Promise<boolean> {
		const { paths, offsets } = pendingRecordings(fm);
		const files = paths.map((p) => this.app.vault.getAbstractFileByPath(p)).filter((x): x is TFile => x instanceof TFile);
		if (!paths.length || files.length !== paths.length) return false; // audio still syncing over; next sweep
		// a device that cannot transcribe must not claim: claiming and then
		// failing the provider check would mark the item failed and strand it
		// from the device that actually could have done the work
		if (!this.providerReady(this.providerFor("meeting"))) return false;
		if (!(await this.claimMeeting(note))) return false;
		const marks = parseMomentsJson(fm["pa-marks"]);
		if (marks.length) this.momentsByCapture[files[0].path] = marks;
		const sec = fm["pa-sections"];
		const rawSections = typeof sec === "string" && sec.trim() ? (sec.split(",") as ExtractionKey[]) : null;
		const recorded = typeof fm["pa-recorded"] === "string" ? fm["pa-recorded"] : undefined;
		await this.setMeetingProgress(note, `Transcribing the recording (on ${this.deviceName()})…`);
		const ok = await this.processParts(files, offsets, {
			note,
			extractions: rawSections ? extractionsFromKeys(rawSections) : null,
			recorded,
		});
		try {
			await this.app.fileManager.processFrontMatter(note, (f: Record<string, unknown>) => {
				if (ok) for (const k of ["pa-status", "pa-recordings", "pa-offsets", "pa-sections", "pa-recorded", "pa-marks", "pa-claimed", "pa-claimed-at"]) delete f[k];
				else f["pa-status"] = "failed"; // the note carries the error callout; sits out the sweep until retried by hand
			});
		} catch (e) {
			console.warn("Power Assistant: could not update the queue marker.", e);
		}
		return ok;
	}

	/** Claim a queued meeting by stamping the note, then waiting out the settle
	 *  window: if sync lands a rival's stamp over ours, the claim was lost. */
	private async claimMeeting(note: TFile): Promise<boolean> {
		try {
			await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				fm["pa-status"] = "processing";
				fm["pa-claimed"] = this.deviceName();
				fm["pa-claimed-at"] = Date.now();
			});
		} catch {
			return false;
		}
		await sleep(CLAIM_SETTLE_MS);
		const fm = this.app.metadataCache.getFileCache(note)?.frontmatter as Record<string, unknown> | undefined;
		return fm?.["pa-status"] === "processing" && fm?.["pa-claimed"] === this.deviceName();
	}

	/** Whether any note in the vault links or embeds this audio file (the sign
	 *  it has been processed, whatever its note ended up being named). */
	private audioLinked(path: string): boolean {
		const links = this.app.metadataCache.resolvedLinks;
		for (const src in links) if (links[src]?.[path]) return true;
		return false;
	}

	/** Every audio path some queued meeting note claims via pa-recordings.
	 *  Audio on this list is a meeting's, whatever folder it sits in, and the
	 *  standalone paths (create event, orphan sweep, counter) leave it alone. */
	private queuedRecordingPaths(): Set<string> {
		const out = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			const rec = fm?.["pa-recordings"];
			if (!Array.isArray(rec)) continue;
			for (const p of rec) if (typeof p === "string") out.add(p);
		}
		return out;
	}

	/** Audio sitting in the watch folders with no note anywhere: recordings
	 *  from record-only devices, and anything that synced in while every
	 *  processor was off. Rotated sessions stitch via their sidecar. Plain
	 *  files older than the horizon are left alone: a processor coming online
	 *  must not bulk-eat years of deliberately unprocessed memos (explicit
	 *  intent, a queued meeting or a sidecar, has no expiry). */
	private async sweepOrphanAudio(): Promise<number> {
		const folders = this.recordingWatchFolders();
		const inWatch = (af: TFile) => folders.some((f) => af.path === `${f}/${af.name}`);
		const claimed = this.queuedRecordingPaths();
		let worked = 0;
		// rotated sessions first, grouped by their sidecar
		for (const af of this.app.vault.getFiles()) {
			if (!/\.part1\.\w+$/.test(af.name)) continue;
			if (!inWatch(af) || claimed.has(af.path)) continue;
			if (isSyncConflictName(af.name)) continue; // a second copy of a recording the vault already has
			const sidecarPath = af.path + ".pa.json";
			let offsets: number[] | null = null;
			try {
				const raw = await this.app.vault.adapter.read(sidecarPath);
				const parsed = JSON.parse(raw) as { offsets?: unknown };
				if (Array.isArray(parsed.offsets)) offsets = parsed.offsets.map((v) => Number(v) || 0);
			} catch {
				continue; // no sidecar: not a queued rotation (or already cleaned up)
			}
			const base = af.path.replace(/\.part1(\.\w+)$/, "");
			const ext = af.extension;
			const parts: TFile[] = [];
			for (let i = 1; ; i++) {
				const p = this.app.vault.getAbstractFileByPath(`${base}.part${i}.${ext}`);
				if (!(p instanceof TFile)) break;
				parts.push(p);
			}
			if (!offsets || parts.length < 2 || parts.length !== offsets.length) continue; // parts still syncing
			const title = af.basename.replace(/\.part1$/, "");
			const notePath = normalizePath(`${this.settings.outputFolder}/${renderFilename(this.settings.filenameTemplate, title, today())}`);
			if (!(await this.claimByStub(notePath, this.settings.outputFolder))) continue;
			if (await this.processParts(parts, offsets)) {
				worked++;
				await this.app.vault.adapter.remove(sidecarPath).catch(() => {});
			}
		}
		// then single orphans
		for (const af of this.app.vault.getFiles()) {
			if (!AUDIO_EXTS.has(af.extension.toLowerCase())) continue;
			if (!inWatch(af) || /\.part\d+\.\w+$/.test(af.name) || claimed.has(af.path)) continue;
			// A sync client's "keep both" copy is the same recording under a second
			// name. Sweeping it transcribes and extracts the meeting a second time
			// and leaves a duplicate note to reconcile by hand — which is exactly
			// what happened here. The queued-meeting path already dedupes conflict
			// copies (see dedupeQueuedNotes); the orphan sweep never did.
			if (isSyncConflictName(af.name)) {
				console.warn(`Power Assistant: skipping "${af.name}" (a sync conflict copy of a recording the vault already has).`);
				continue;
			}
			if (Date.now() - af.stat.mtime > ORPHAN_HORIZON_MS) continue;
			if (this.inFlight.has(af.path) || this.audioLinked(af.path)) continue;
			const notePath = normalizePath(`${this.settings.outputFolder}/${renderFilename(this.settings.filenameTemplate, af.basename, today())}`);
			const existing = this.app.vault.getAbstractFileByPath(notePath);
			if (existing instanceof TFile && this.stubState(existing) !== "stale") continue; // finished, failed, or someone's live claim
			await this.process(af, undefined, true); // claims its own stub inside
			if (this.audioLinked(af.path) || this.app.vault.getAbstractFileByPath(notePath)) worked++;
		}
		return worked;
	}

	/** The queue at a glance, split the way the sweep actually treats it:
	 *  `pending` is work a forced sweep would take here and now, `working` is
	 *  a live claim that drains on its own, and `blocked` is work no device
	 *  will ever take without a person.
	 *
	 *  The split is the whole point. A count that includes items the sweep
	 *  refuses never drains, and clicking it to be told "nothing was ready"
	 *  reads as a broken button; a count that silently drops them hides real
	 *  unfinished recordings. So the counter applies the sweep's own rules and
	 *  keeps the refusals, with their reasons, to say out loud instead.
	 *
	 *  Cheap enough to repaint on a timer: index lookups, no file reads. */
	private surveyQueue(): { pending: number; working: number; blocked: { name: string; reason: string }[] } {
		let pending = 0;
		let working = 0;
		const blocked: { name: string; reason: string }[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (!Array.isArray(fm?.["pa-recordings"])) continue; // a claim stub, not a queued meeting
			const state = pendingState(fm, Date.now());
			if (state === "pending" || state === "stale") pending++;
			else if (state === "claimed") working++;
			else if (state === "failed") blocked.push({ name: f.basename, reason: "a failed run; open it and retry by hand" });
		}
		// the audio half: nothing when auto-processing is off, nothing past
		// the horizon, and nothing the orphan sweep would decline to claim
		if (this.settings.autoProcess) {
			const folders = this.recordingWatchFolders();
			const claimed = this.queuedRecordingPaths();
			for (const af of this.app.vault.getFiles()) {
				if (!AUDIO_EXTS.has(af.extension.toLowerCase())) continue;
				if (!folders.some((f) => af.path === `${f}/${af.name}`)) continue;
				if (claimed.has(af.path)) continue; // a queued meeting already counts it
				if (Date.now() - af.stat.mtime > ORPHAN_HORIZON_MS) continue;
				if (this.audioLinked(af.path)) continue;
				if (/\.part\d+\.\w+$/.test(af.name)) {
					// a rotation counts once, at part 1, and only while its sidecar
					// is there to stitch it: the plain-orphan pass skips every
					// .partN file outright, so a sidecar-less part is work that
					// no sweep on any device can pick up
					if (!/\.part1\.\w+$/.test(af.name)) continue;
					if (this.app.vault.getAbstractFileByPath(af.path + ".pa.json")) pending++;
					else blocked.push({ name: af.name, reason: "a rotated recording with no sidecar; nothing can stitch its parts" });
					continue;
				}
				const notePath = normalizePath(`${this.settings.outputFolder}/${renderFilename(this.settings.filenameTemplate, af.basename, today())}`);
				const existing = this.app.vault.getAbstractFileByPath(notePath);
				const stub = existing instanceof TFile ? this.stubState(existing) : null;
				// a failed stub is the same item the note half already declined,
				// wearing its audio face: count it once, as blocked, or the queue
				// double-counts every failure and then refuses to work it
				if (stub === "failed") blocked.push({ name: af.name, reason: "a failed run; delete its note to let the sweep retry" });
				else if (stub === "mine" || stub === "claimed-other") working++;
				else if (stub !== "note") pending++; // no note yet, or a claim gone stale
			}
		}
		return { pending, working, blocked };
	}

	paintQueueStatus() {
		if (!this.queueStatusEl) return;
		if (this.jobEl) return; // a running job owns the status bar while it lasts
		const { pending, working, blocked } = this.surveyQueue();
		const n = pending + working;
		if (n) {
			this.queueStatusEl.setText(`Assistant queue: ${n}`);
			this.queueStatusEl.setAttr("aria-label", "Process these on this device now");
		} else if (blocked.length) {
			// nothing to sweep, but recordings are still unfinished: say so
			// rather than clearing the bar and letting them disappear
			this.queueStatusEl.setText(`Assistant queue: ${blocked.length} need you`);
			this.queueStatusEl.setAttr("aria-label", "These cannot be processed automatically; click to see what each one needs");
		} else {
			this.queueStatusEl.setText("");
			this.queueStatusEl.setAttr("aria-label", null);
		}
		// an empty item must not hover like a button over nothing
		this.queueStatusEl.toggleClass("mod-clickable", n > 0 || blocked.length > 0);
	}

	/* ---- progress for long jobs ---- */

	private jobEl: HTMLElement | null = null;

	/** Report a long job's progress in the status bar and in one notice.
	 *
	 *  Long jobs here run for minutes over thousands of items, and a plain
	 *  "working…" leaves no way to tell slow from stuck, or to decide whether
	 *  to wait. The status bar carries it because a notice fades while the work
	 *  does not; the notice is reused rather than re-created so a six-thousand
	 *  item run does not stack six thousand toasts. */
	startJob(label: string, total: number): { tick: (done: number) => void; done: (summary?: string) => void } {
		const started = Date.now();
		if (!this.jobEl) this.jobEl = this.addStatusBarItem();
		const notice = new Notice(`${label}…`, 0);
		let last = 0;
		const paint = (n: number) => {
			const text = progressLine(label, n, total, Date.now() - started);
			this.jobEl?.setText(text);
			notice.setMessage(`Power Assistant: ${text}`);
		};
		paint(0);
		return {
			tick: (n: number) => {
				// repaint at most ten times a second; the work is the point
				const now = Date.now();
				if (n < total && now - last < 100) return;
				last = now;
				paint(n);
			},
			done: (summary?: string) => {
				const took = fmtDuration(Date.now() - started);
				notice.setMessage(`Power Assistant: ${summary ?? `${label} finished`}${took ? ` (${took})` : ""}`);
				window.setTimeout(() => notice.hide(), 6000);
				this.jobEl?.remove();
				this.jobEl = null;
				this.paintQueueStatus();
			},
		};
	}

	/** Arm the stop watchdog: if the session is still alive with a stop pending
	 *  (or a teardown wedged mid-await) a few seconds from now, force-release it
	 *  and recover the audio from the crash-safe partial. Fires only for THIS
	 *  session; a normal finish clears recStream and a new session bumps the
	 *  generation, both of which disarm it. */
	private armStopWatchdog(graceMs = 8_000) {
		const gen = this.sessionGen;
		const id = window.setTimeout(() => {
			if (this.sessionGen !== gen || !this.recStream) return;
			if (!this.stopRequested && !this.finishing) return; // healthy, ongoing session
			if (this.finishing && graceMs < 25_000) {
				// a live finishPart is still working inside its own timeboxes (worst
				// case ~23s: 10s read + 10s write + 3s flush). Forcing now would race
				// its in-flight vault write, so give it one longer grace instead; the
				// 8s trip stays for the real wedge, a recorder whose onstop never fires.
				this.armStopWatchdog(25_000);
				return;
			}
			console.error("Power Assistant: stopping timed out; force-releasing the session and recovering the audio.");
			new Notice("Power Assistant: the recorder did not stop cleanly, so the session was force-released. Recovering the audio now.", 8000);
			this.forceTeardown();
		}, graceMs);
		this.register(() => window.clearTimeout(id));
	}

	/** The bar's second Stop click: skip all patience and force-release now.
	 *  A no-op when the session already ended. */
	/** Whether a recording session is alive (the bar's self-heal probe). */
	sessionActive(): boolean {
		return !!this.recStream;
	}

	forceStopNow() {
		if (!this.recStream) return;
		console.error(`Power Assistant ${PC_BUILD}: force stop requested by the user; releasing the session now.`);
		new Notice("Power Assistant: force-stopping and recovering the audio.", 6000);
		this.forceTeardown();
	}

	/** Break a wedged session by force: detach the recorder, release everything,
	 *  and recover the audio from the crash-safe partial immediately (folding it
	 *  into the meeting note when there was a target). Never waits on anything
	 *  the wedge could be stuck on. */
	private forceTeardown() {
		this.sessionGen++; // orphan any hung finishPart continuation
		// a finisher we interrupt may have an unfinished vault write in flight on
		// the normal capture name; recovery must then use a name of its own
		const interruptedFinisher = this.finishing;
		const rec = this.recorder;
		this.recorder = null;
		if (rec) {
			rec.ondataavailable = null;
			rec.onstop = null;
			rec.onerror = null;
			try {
				if (rec.state !== "inactive") rec.stop();
			} catch {
				/* already dead */
			}
		}
		this.rotating = false;
		this.finishing = false;
		this.chunks = [];
		const partial = this.partialAbs;
		this.partialAbs = null;
		this.flushChain = Promise.resolve(); // a wedged flush must not poison the next session
		// snapshot timing NOW: a new session may start while recovery awaits, and
		// the recovered part's offset and recorded range belong to THIS session
		const offsetMs = this.partStart - this.recStart;
		const recStart = this.recStart;
		const s = this.teardownSession();
		void this.recoverForcedStop(partial, s, { offsetMs, recStart, interruptedFinisher });
	}

	/** After a force stop: turn the crash-safe partial into a real capture file
	 *  (as the next part when earlier parts already saved) and dispatch it like a
	 *  normal finish, so the meeting-note fold still happens. Any failure leaves
	 *  the partial on disk for the next-launch recovery sweep. */
	private async recoverForcedStop(
		partialAbs: string | null,
		s: { parts: { path: string; offsetMs: number }[]; target: string | null; targetExt: ProcessOverrides["extractions"] | null; marks: Moment[]; ask: boolean },
		snap: { offsetMs: number; recStart: number; interruptedFinisher: boolean }
	) {
		const parts = s.parts.slice();
		const fs = this.nodeFs();
		if (partialAbs && fs) {
			try {
				const data = fs.readFileSync(partialAbs);
				if (data.byteLength > 0) {
					const n = parts.length + 1;
					const name = parts.length ? `capture-${this.recStamp}.part${n}.${this.recExt}` : `capture-${this.recStamp}.${this.recExt}`;
					let dest = normalizePath(`${this.recordingFolder()}/${name}`);
					// an interrupted finisher may still have a write in flight on the
					// normal name that the vault index cannot show yet: never share it
					if (snap.interruptedFinisher || this.app.vault.getAbstractFileByPath(dest))
						dest = normalizePath(`${this.recordingFolder()}/capture-recovered-${this.recStamp}.${this.recExt}`);
					// ask-at-stop sessions claim the recovered file too: their filing
				// answer arrives after this create event has already fired
				if (s.target || s.ask) this.directProcess.add(dest);
					let made: TFile | "pcap-timeout";
					try {
						made = await withTimeout(this.app.vault.createBinary(dest, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), 10_000);
					} catch (e) {
						this.directProcess.delete(dest); // the write failed outright; nothing will land
						throw e;
					}
					// on timeout, keep the directProcess entry: a write landing late
					// must not auto-make a stray note
					if (made === "pcap-timeout") throw new Error("timed out writing the recovered audio");
					parts.push({ path: dest, offsetMs: snap.offsetMs });
				}
				try {
					fs.rmSync(partialAbs);
				} catch {
					/* already gone */
				}
			} catch (e) {
				console.error("Power Assistant: could not recover the partial after a force stop; it stays on disk for the next-launch recovery.", e);
				new Notice("Power Assistant: the audio could not be recovered right now; it is kept on disk and will be recovered on the next launch.", 8000);
			}
		}
		this.dispatchCapture(parts, s.target, s.targetExt, s.marks, snap.recStart, s.ask);
	}

	/** A timestamped bookmark while recording: lands in the note's Moments
	 *  section as a clickable stamp. */
	markMoment() {
		if (!this.recStream) {
			new Notice("Power Assistant: no recording is running.");
			return;
		}
		const m: Moment = { ms: this.recElapsedMs(), label: "" }; // pause-adjusted, like live turns
		this.marks.push(m);
		this.liveView()?.addMark(m);
		new Notice(`Power Assistant: marked ${fmtTime(m.ms)}.`);
	}

	/* ---- meeting notes: create a dated page to prep in, then record into it ---- */

	/** Create a new meeting note (date + fields) in the meetings folder and open
	 *  it. When `record` is set, immediately start capturing into that same note
	 *  so the AI summary and transcript land below the agenda you just filled in. */
	/** The meeting template: a note in the vault when one is named, else the
	 *  settings box.
	 *
	 *  A file wins because it is the better place to write one — the editor, with
	 *  live preview, in a vault that syncs it to every device. It falls back
	 *  rather than failing when the note has been moved or renamed: a template is
	 *  a convenience, and losing track of it should cost the layout, not the
	 *  meeting note someone is trying to create. */
	async meetingTemplateBody(): Promise<string> {
		const path = this.settings.meetingTemplateFile.trim();
		if (!path) return this.settings.meetingTemplate;
		const f = this.app.vault.getAbstractFileByPath(path.endsWith(".md") ? path : `${path}.md`);
		if (!(f instanceof TFile)) {
			new Notice(`Power Assistant: the meeting template note "${path}" is not there any more, so the template in settings was used instead.`, 10000);
			return this.settings.meetingTemplate;
		}
		const body = templateBodyOf(await this.app.vault.cachedRead(f));
		return body || this.settings.meetingTemplate;
	}

	async createMeetingNote(opts: {
		title: string;
		attendees: string[];
		agenda: string;
		extractions: ProcessOverrides["extractions"] | null;
		record: boolean;
		/** From an imported invite: the meeting's own date and context. */
		date?: string;
		location?: string;
		when?: string;
		teamsUrl?: string;
		meetingId?: string;
		passcode?: string;
		/** Bulk imports pass false to create quietly without opening each note. */
		open?: boolean;
	}): Promise<TFile> {
		const date = opts.date || today();
		const folder = cleanFolderPath(this.settings.meetingsFolder) || this.settings.outputFolder;
		await this.ensureFolder(folder);
		const stub = buildMeetingStub({
			title: opts.title,
			date,
			attendees: opts.attendees,
			agenda: opts.agenda,
			series: seriesKey(opts.title) || null,
			peopleFolder: this.peopleFolderPath(),
			template: await this.meetingTemplateBody(),
			location: opts.location,
			when: opts.when,
			teamsUrl: opts.teamsUrl,
			meetingId: opts.meetingId,
			passcode: opts.passcode,
		});
		const base = renderMeetingFilename(this.settings.meetingFilename, opts.title, date);
		// collision-safe: two meetings the same day get -2, -3, … rather than clash
		let path = normalizePath(`${folder}/${base}`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			const stem = base.replace(/\.md$/i, "");
			let n = 2;
			while (this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${stem}-${n}.md`))) n++;
			path = normalizePath(`${folder}/${stem}-${n}.md`);
		}
		const file = await this.app.vault.create(path, stub);
		if (opts.record) {
			await this.app.workspace.getLeaf(false).openFile(file);
			await this.startMeetingRecording(file, opts.extractions);
		} else if (opts.open !== false) {
			await this.app.workspace.getLeaf(false).openFile(file);
			new Notice(`Power Assistant: created ${file.basename}.`);
		}
		return file;
	}

	/** Start recording so the result folds into `note` instead of a new note.
	 *  Clears the target again if the recording never actually starts. */
	async startMeetingRecording(note: TFile, extractions: ProcessOverrides["extractions"] | null) {
		if (this.recStream) {
			new Notice("Power Assistant: a recording is already running.");
			return;
		}
		this.meetingTargetPath = note.path;
		this.meetingTargetExtractions = extractions;
		await this.toggleRecording();
		if (!this.recStream) {
			this.meetingTargetPath = null;
			this.meetingTargetExtractions = null;
		}
	}

	/* ---- Microsoft 365 calendar import (Graph) ---- */

	graphConnected(): boolean {
		return !!this.settings.graphRefresh;
	}

	/** Show or hide each ribbon icon to match settings. Called at load and
	 *  whenever a toggle changes, so the strip updates as you flip it. */
	applyRibbonVisibility() {
		const s = this.settings;
		const want = { record: s.ribbonRecord, meeting: s.ribbonMeeting, briefing: s.ribbonBriefing, assistant: s.ribbonAssistant };
		for (const key of Object.keys(want) as (keyof typeof want)[]) {
			this.ribbonEls[key]?.toggleClass("pa-ribbon-hidden", !want[key]);
		}
	}

	/** Say once, on the first load of an install that has nothing configured,
	 *  that setup is needed and where it lives.
	 *
	 *  Nothing here transcribes or extracts without a transcription provider or
	 *  an AI model. Without one the first recording simply fails, which teaches
	 *  the same lesson far more expensively: a meeting has already happened by
	 *  then. Said once and never again, with the settings one click away. */
	private nudgeSetupOnce() {
		const s = this.settings;
		if (s.setupNudged) return;
		const providers: TranscriptionProvider[] = ["whisper", "assemblyai", "deepgram", "whisperx"];
		const hasProvider = providers.some((p) => this.providerReady(p));
		const hasModel = s.llmProvider === "custom" ? !!s.llmEndpoint.trim() : !!s.anthropicKey.trim();
		if (hasProvider || hasModel) return;

		s.setupNudged = true;
		void this.saveSettings();
		const notice = new Notice("", 20000);
		notice.noticeEl.createSpan({
			text: "Power Assistant is installed but not set up yet. Recording and AI notes need a transcription provider, an AI model, or both. ",
		});
		const link = notice.noticeEl.createEl("a", { text: "Open setup", attr: { href: "#" } });
		link.addEventListener("click", (e) => {
			e.preventDefault();
			notice.hide();
			this.openOwnSettings("setup");
		});
	}

	/** Open this plugin's settings on the given tab. Not-connected notices call
	 *  this so the Connect button is on screen before the notice fades. */
	openOwnSettings(tab: string) {
		this.settingTab?.showTab(tab);
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	/** A valid access token, refreshing and persisting when the current one has
	 *  expired. Throws if not connected or the refresh fails. */
	private async graphToken(): Promise<string> {
		const s = this.settings;
		if (s.graphAccess && Date.now() < s.graphExpiry - 60_000) return s.graphAccess;
		if (!s.graphRefresh) throw new Error("Connect Microsoft 365 in settings first.");
		let t;
		try {
			t = await refreshTokens(s.graphClientId.trim(), s.graphTenant.trim(), s.graphRefresh);
		} catch (e) {
			// a rejected refresh token (invalid_grant, ...) is dead: clear it so the
			// UI reads "not connected" instead of failing every import silently. A
			// codeless error is a transient network blip, so keep the token.
			if (e instanceof GraphError && e.code) {
				s.graphAccess = "";
				s.graphRefresh = "";
				s.graphExpiry = 0;
				await this.saveSettings();
				this.refreshSettingsTab?.();
			}
			throw e;
		}
		s.graphAccess = t.access_token;
		if (t.refresh_token) s.graphRefresh = t.refresh_token;
		s.graphExpiry = Date.now() + t.expires_in * 1000;
		await this.saveSettings();
		return s.graphAccess;
	}

	/** Send a page from the user's own mailbox. Separate from the modal so the
	 *  token refresh and its reconnect path stay in one place. */
	async sendPageMail(m: OutgoingMail): Promise<void> {
		await sendMail(await this.graphToken(), m);
	}

	/** Email any note, whole or summarized. Not gated to captures: a page worth
	 *  sending is any page. */
	async sharePage(file: TFile) {
		if (!this.graphConnected()) {
			new Notice("Power Assistant: Microsoft 365 is not connected on this device (sign-ins are per device). Connect in settings to email pages from your own mailbox.", 10000);
			this.openOwnSettings("meetings");
			return;
		}
		const md = await this.app.vault.read(file);
		// a captured page already knows where it came from, and the reader will
		// want the original rather than a note they cannot open
		const source = this.app.metadataCache.getFileCache(file)?.frontmatter?.source;
		new SharePageModal(this.app, this, file, md, typeof source === "string" && /^https?:\/\//i.test(source) ? source : "").open();
	}

	/** Device-code sign-in: show the code, poll until the user authenticates in
	 *  their own browser, then store the tokens. Never handles the password. */
	async connectGraph() {
		const s = this.settings;
		if (!s.graphClientId.trim()) {
			new Notice("Power Assistant: enter your Azure app (client) ID in settings first.");
			return;
		}
		if (this.graphConnecting) {
			new Notice("Power Assistant: a sign-in is already in progress.");
			return;
		}
		this.graphConnecting = true;
		try {
			await this.runDeviceCodeFlow(s);
		} finally {
			this.graphConnecting = false;
		}
	}

	private async runDeviceCodeFlow(s: PowerAssistantSettings) {
		let dc: DeviceCode;
		try {
			dc = await startDeviceCode(s.graphClientId.trim(), s.graphTenant.trim());
		} catch (e) {
			this.graphErrorNotice(e);
			return;
		}
		const modal = new DeviceCodeModal(this.app, dc);
		modal.open();
		const deadline = Date.now() + dc.expires_in * 1000;
		const interval = Math.max(3, dc.interval) * 1000;
		while (Date.now() < deadline && modal.waiting) {
			await sleep(interval);
			if (!modal.waiting) return; // user cancelled
			let res: Awaited<ReturnType<typeof pollToken>>;
			try {
				res = await pollToken(s.graphClientId.trim(), s.graphTenant.trim(), dc.device_code);
			} catch (e) {
				modal.close();
				this.graphErrorNotice(e);
				return;
			}
			if (res === "pending") continue;
			s.graphAccess = res.access_token;
			s.graphRefresh = res.refresh_token;
			s.graphExpiry = Date.now() + res.expires_in * 1000;
			await this.saveSettings();
			modal.close();
			new Notice("Power Assistant: connected to Microsoft 365.");
			this.refreshSettingsTab?.();
			return;
		}
		if (modal.waiting) {
			modal.close();
			new Notice("Power Assistant: sign-in timed out; try again.");
		}
	}

	/** A sign-in failure notice with the actual fix up front when the AADSTS
	 *  code is a known setup problem (single-tenant app on 'common', wrong
	 *  client ID, public client flows off, missing consent). */
	private graphErrorNotice(e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		const hint = graphSetupHint(msg);
		new Notice("Power Assistant: " + (hint ? `${hint}\n\n(${msg})` : msg), hint ? 15000 : 8000);
	}

	disconnectGraph() {
		const s = this.settings;
		s.graphAccess = "";
		s.graphRefresh = "";
		s.graphExpiry = 0;
		void this.saveSettings();
		new Notice("Power Assistant: disconnected Microsoft 365.");
		this.refreshSettingsTab?.();
	}

	/** The next two weeks of calendar meetings as parsed invites; null after a
	 *  notice when not connected or the token/fetch failed. Shared by the bulk
	 *  import picker and the New meeting dialog's From calendar button. */
	async calendarInvites(): Promise<ParsedInvite[] | null> {
		if (!this.graphConnected()) {
			new Notice("Power Assistant: Microsoft 365 is not connected on this device (sign-ins are per device). Connect in settings to import meetings.", 10000);
			this.openOwnSettings("meetings");
			return null;
		}
		let token: string;
		try {
			token = await this.graphToken();
		} catch (e) {
			new Notice("Power Assistant: " + (e instanceof Error ? e.message : String(e)), 8000);
			return null;
		}
		const now = new Date();
		const end = new Date(now.getTime() + 14 * 864e5);
		new Notice("Power Assistant: reading your calendar…");
		try {
			// an exact moment handed to an API, not a day anyone reads: UTC is right here
			const events = (await fetchCalendar(token, now.toISOString(), end.toISOString())) as GraphEvent[];
			return events.map(eventToInvite).filter((inv) => inv.title.trim());
		} catch (e) {
			new Notice("Power Assistant: " + (e instanceof Error ? e.message : String(e)), 8000);
			return null;
		}
	}

	/** Fetch the next two weeks of meetings and open the picker to choose which
	 *  become notes. */
	async importFromCalendar() {
		const invites = await this.calendarInvites();
		if (!invites) return;
		if (!invites.length) {
			new Notice("Power Assistant: no upcoming meetings in the next two weeks.");
			return;
		}
		new CalendarPickerModal(this.app, this, invites).open();
	}

	/* ---- crash-safe partial: every chunk also lands on disk, so an Electron
	 * crash mid-meeting costs nothing. Desktop only; removed on clean stop. ---- */

	private nodeFs(): typeof import("node:fs") | null {
		try {
			return require("node:fs") as typeof import("node:fs");
		} catch {
			return null;
		}
	}

	/* ---- yt-dlp is a separate program, so an X capture is desktop-only and
	 * every one of these returns null on mobile rather than throwing. ---- */

	private nodeCp(): typeof import("node:child_process") | null {
		try {
			return require("node:child_process") as typeof import("node:child_process");
		} catch {
			return null;
		}
	}

	private nodeOs(): typeof import("node:os") | null {
		try {
			return require("node:os") as typeof import("node:os");
		} catch {
			return null;
		}
	}

	private openPartial() {
		const base = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
		const fs = this.nodeFs();
		this.partialAbs = null;
		if (!base || !fs) return;
		const abs = `${base}/${normalizePath(this.recordingFolder())}/.pcap-partial-${this.recStamp}-${this.parts.length + 1}.${this.recExt}`;
		try {
			fs.writeFileSync(abs, Buffer.alloc(0));
			this.partialAbs = abs;
		} catch {
			/* read-only or exotic adapter: recording still works, minus crash safety */
		}
	}

	private appendPartial(data: Blob) {
		const abs = this.partialAbs;
		const fs = this.nodeFs();
		if (!abs || !fs) return;
		this.flushChain = this.flushChain.then(async () => {
			try {
				fs.appendFileSync(abs, Buffer.from(await data.arrayBuffer()));
			} catch {
				/* best effort */
			}
		});
	}

	private async closePartial(keepFile = false) {
		const abs = this.partialAbs;
		this.partialAbs = null;
		// timeboxed: one chunk whose read never settles would otherwise stall the
		// chain and hang every stop after it. On timeout, reset the chain so the
		// wedged promise cannot poison a later session; but only if it is still
		// OUR chain, never a newer session's.
		const chain = this.flushChain;
		if ((await withTimeout(chain, 3_000)) === "pcap-timeout") {
			console.error("Power Assistant: the partial-file flush timed out; continuing the teardown.");
			if (this.flushChain === chain) this.flushChain = Promise.resolve();
		}
		if (keepFile) return; // the save failed: the partial IS the recording now
		const fs = this.nodeFs();
		if (abs && fs) {
			try {
				fs.rmSync(abs);
			} catch {
				/* already gone */
			}
		}
	}

	/** Startup sweep: an interrupted session left .pcap-partial files behind;
	 *  surface them as recovered recordings (auto-processing picks them up).
	 *  Scans the capture folder and the recordings folder, so a partial left in
	 *  either (including before the recordings folder was set) is recovered
	 *  where it lives. */
	private async recoverPartials() {
		for (const folder of this.recordingWatchFolders()) {
			let listing: { files: string[] };
			try {
				listing = await this.app.vault.adapter.list(folder);
			} catch {
				continue;
			}
			for (const p of listing.files) {
				const name = p.split("/").pop() ?? "";
				const m = name.match(/^\.pcap-partial-(.+)\.(\w+)$/);
				if (!m) continue;
				try {
					const data = await this.app.vault.adapter.readBinary(p);
					if (data.byteLength > 4096) {
						const dest = normalizePath(`${folder}/capture-recovered-${m[1]}.${m[2]}`);
						if (!this.app.vault.getAbstractFileByPath(dest)) await this.app.vault.createBinary(dest, data);
						new Notice(`Power Assistant: recovered an interrupted recording (${m[1]}).`, 8000);
					}
					await this.app.vault.adapter.remove(p);
				} catch (e) {
					console.warn("Power Assistant: partial recovery failed for", p, e);
				}
			}
		}
	}

	/* ---- live view plumbing ---- */

	liveView(): LiveView | null {
		// instanceof, NEVER a cast: a live-panel tab restored from the saved
		// workspace layout but not yet shown is a deferred placeholder without
		// LiveView's methods. The old blind cast made teardownSession throw on
		// stopMonitor() for anyone carrying such a tab (left over from versions
		// that opened the panel on every recording), which killed every stop
		// path mid-teardown: the bar stayed, the mic stayed, the session hung.
		const leaf = this.app.workspace.getLeavesOfType(LIVE_VIEW)[0];
		return leaf && leaf.view instanceof LiveView ? leaf.view : null;
	}

	/** Open (or reveal) the assistant chat in the right sidebar. */
	async openAssistant(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(ASSIST_VIEW)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: ASSIST_VIEW, active: true });
			leaf = right;
		}
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof AssistantChatView) leaf.view.focusInput();
	}

	/** Open (or reveal) the AI usage meter in the right sidebar. */
	async openUsageMeter(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(USAGE_VIEW)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: USAGE_VIEW, active: true });
			leaf = right;
		}
		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof UsageMeterView) leaf.view.refresh();
	}

	/** Write a chat-summary note into the Chats folder and open it. */
	async saveChatNote(name: string, md: string): Promise<void> {
		await this.writeGenerated(`${this.settings.outputFolder}/Chats`, name, md);
		new Notice("Power Assistant: chat summary saved.");
	}

	private async openLiveView(): Promise<LiveView | null> {
		let leaf = this.app.workspace.getLeavesOfType(LIVE_VIEW)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return null;
			await right.setViewState({ type: LIVE_VIEW, active: true });
			leaf = right;
		}
		this.app.workspace.revealLeaf(leaf);
		return leaf.view instanceof LiveView ? leaf.view : null;
	}

	/* ---------------- audio pipeline ---------------- */

	async process(file: TFile, overrides?: ProcessOverrides, fromAuto = false) {
		if (this.inFlight.has(file.path)) return;
		const s = this.settings;
		const o: ProcessOverrides = overrides ?? {
			extractions: s.extractions,
			includeTranscript: s.includeTranscript,
			outputFolder: s.outputFolder,
			filenameTemplate: s.filenameTemplate,
		};
		const date = today();
		const notePath = normalizePath(`${o.outputFolder}/${renderFilename(o.filenameTemplate, file.basename, date)}`);
		const existingNote = this.app.vault.getAbstractFileByPath(notePath);
		if (existingNote instanceof TFile) {
			// a finished note, a live rival claim, or a failed run waiting on a
			// person all end this run; our own or a stale stub is resumable
			const st = this.stubState(existingNote);
			if (!(fromAuto && (st === "mine" || st === "stale"))) {
				if (overrides) new Notice("Power Assistant: that note already exists (delete or rename it first).");
				return; // already processed (here or on another device)
			}
		}
		// a dropped or hand-picked file is a capture, not a meeting recording
		const provider = this.providerFor("capture");
		const diarizes = provider === "assemblyai" || provider === "deepgram" || provider === "whisperx";
		if (!this.providerReady(provider)) {
			new Notice(`Power Assistant: set the ${provider} API key in settings first.`);
			return;
		}
		if (provider === "whisper") {
			const warn = whisperSizeWarning(file.stat.size, s.transcriptionEndpoint);
			if (warn) {
				new Notice("Power Assistant: " + warn, 12000);
				return;
			}
		}
		// an auto-processed recording in a remembered series uses that series'
		// section defaults (unless this run already carries explicit overrides)
		if (!overrides) {
			const key = seriesKey(file.basename);
			const saved = key && s.seriesTemplates[key];
			if (saved) o.extractions = extractionsFromKeys(saved);
		}
		// retention only trashes AUTO-captured audio (recorded or dropped in),
		// never a file the user hand-picked to process
		const willTrash = fromAuto && this.settings.audioRetention === "trash";
		// auto runs race the rest of the fleet for synced audio, so they claim
		// the output path first; a hand-picked run is the user standing right
		// there, and their explicit ask does not wait on a settle pause
		if (fromAuto && !(await this.claimByStub(notePath, o.outputFolder))) return;
		this.inFlight.add(file.path);
		try {
			new Notice(`Power Assistant: transcribing ${file.name}${diarizes ? " with speaker labels (can take a minute)" : ""}…`);
			const wantVoices = provider === "whisperx" && s.voiceIdentity;
			const raw = await this.transcribeFile(file, provider, wantVoices ? { wantVoices } : undefined);
			if (!raw.text.trim() && !raw.utts?.length) {
				new Notice("Power Assistant: the transcription came back empty.");
				if (fromAuto) await this.failStub(notePath, "The transcription came back empty; no speech was found in the recording.");
				return;
			}
			let utts = raw.utts;
			let voiceGuesses: Record<string, string> | undefined;
			if (wantVoices && raw.voice) {
				const refined = await this.refineVoices([{ voice: raw.voice, offsetMs: 0 }], notePath);
				if (refined) ({ utts, voiceGuesses } = refined);
			}
			await this.finishNote({
				file,
				utts,
				voiceGuesses,
				plainText: raw.text,
				overrides: o,
				notePath,
				date,
				costProvider: provider,
				audioMinutes: raw.utts?.length ? undefined : file.stat.size / 180000,
				willTrash,
			});
			if (willTrash) await this.applyRetention([file]);
		} catch (e) {
			console.error("Power Assistant:", e);
			const msg = e instanceof Error ? e.message : String(e);
			new Notice("Power Assistant failed: " + msg, 8000);
			if (fromAuto) await this.failStub(notePath, `Transcription or extraction failed: ${msg}`);
		} finally {
			this.inFlight.delete(file.path);
		}
	}

	/** Audio-retention policy: trash the captured audio after a note is written.
	 *  Only ever runs for auto-processed captures (recorded or dropped into the
	 *  capture folder), NEVER for a file the user hand-picked to process, and
	 *  always to the recoverable system trash — retention must not surprise-
	 *  delete a keeper. */
	private async applyRetention(files: TFile[]) {
		if (this.settings.audioRetention !== "trash") return;
		for (const f of files) {
			try {
				await this.app.vault.trash(f, true); // system trash = recoverable
			} catch (e) {
				console.warn("Power Assistant: could not trash", f.path, e);
			}
		}
	}

	/** A rotated recording: transcribe every part, shift each part's segment
	 *  times by where it began, and finish ONE note embedding all the audio. */
	/** Returns whether a note was written, so a queued run knows to clear its
	 *  marker (true) or leave the item for a retry or a person (false). */
	async processParts(files: TFile[], offsets: number[], target?: { note: TFile; extractions: ProcessOverrides["extractions"] | null; recorded?: string }): Promise<boolean> {
		const s = this.settings;
		const first = files[0];
		if (!first || this.inFlight.has(first.path)) return false;
		// folding into a meeting note is the one signal that this is a meeting;
		// a standalone recording is treated as a capture
		const provider = this.providerFor(target ? "meeting" : "capture");
		if (!this.providerReady(provider)) {
			new Notice(`Power Assistant: set the ${provider} API key in settings first.`);
			if (target)
				await this.noteMeetingIssue(
					target.note,
					`No transcription key is set for the ${provider} provider, so the recording was not transcribed. Add a key in Power Assistant settings, then open the saved audio and run "Process the active audio file".`
				);
			return false;
		}
		const o: ProcessOverrides = {
			extractions: s.extractions,
			includeTranscript: s.includeTranscript,
			outputFolder: s.outputFolder,
			filenameTemplate: s.filenameTemplate,
		};
		let date = today();
		let title = first.basename.replace(/\.part1$/, "");
		let notePath: string;
		let targetNote: TFile | undefined;
		let priorAttendees: string[] | undefined;
		if (target) {
			// fold the recording into an existing meeting note: inherit its date,
			// title, and pre-entered attendees, and use its chosen sections; the
			// note's own path is the exclude so series carry-over skips itself
			const meta = parseMeetingMeta(await this.app.vault.read(target.note));
			// a note whose filename already carries its title has no heading to read
			// it back out of, and its own name beats the audio file's
			title = meta.title || target.note.basename;
			if (meta.date) date = meta.date;
			priorAttendees = meta.attendees;
			targetNote = target.note;
			notePath = target.note.path;
			// series carry-over searches the folder the meeting note lives in, not
			// the output folder, so prior meetings in the meetings folder are found
			o.outputFolder = cleanFolderPath(s.meetingsFolder) || s.outputFolder;
			if (target.extractions) o.extractions = target.extractions;
		} else {
			notePath = normalizePath(`${o.outputFolder}/${renderFilename(o.filenameTemplate, title, date)}`);
			const existing = this.app.vault.getAbstractFileByPath(notePath);
			// our own claim stub (the sweep stubs before stitching parts) falls
			// through to be filled in; anything else already owns the path
			if (existing instanceof TFile && !(await this.ownsStub(notePath))) return false;
		}
		this.inFlight.add(first.path);
		try {
			if (!targetNote) new Notice(`Power Assistant: transcribing ${files.length} recording parts…`); // meeting notes show the in-note progress instead
			// the invite's attendee list caps how many voices the diarizer may
			// invent, the classic long-meeting failure; voices are requested
			// only when voice identity is on
			const bounds = provider === "whisperx" ? expectedSpeakerBounds(priorAttendees) : null;
			const wantVoices = provider === "whisperx" && s.voiceIdentity;
			const uttParts: { utterances: Utterance[]; offsetMs: number }[] = [];
			const voiceParts: { voice: VoiceData; offsetMs: number }[] = [];
			const texts: string[] = [];
			for (let i = 0; i < files.length; i++) {
				// meeting notes narrate the server's stages right in the note; a
				// standalone capture keeps its transient notices
				const onStage = targetNote
					? (stage: string) =>
							void this.setMeetingProgress(
								targetNote,
								`Transcribing${files.length > 1 ? ` part ${i + 1} of ${files.length}` : " the recording"} (${stage})…`
							)
					: undefined;
				const raw = await this.transcribeFile(files[i], provider, { onStage, maxSpeakers: bounds?.maxSpeakers, wantVoices });
				if (raw.utts?.length) {
					uttParts.push({ utterances: raw.utts, offsetMs: offsets[i] ?? 0 });
					if (raw.voice) voiceParts.push({ voice: raw.voice, offsetMs: offsets[i] ?? 0 });
				} else if (raw.text.trim()) texts.push(`[${fmtTime(offsets[i] ?? 0)}]\n\n${raw.text.trim()}`);
			}
			let utts = uttParts.length ? mergeUtterances(uttParts) : null;
			let voiceGuesses: Record<string, string> | undefined;
			// the voice path replaces the 1A/2A prefix merge with alignment by
			// voice, audits the clusters, and remembers each letter's voice;
			// it only takes over when every diarized part brought its voices
			if (wantVoices && voiceParts.length && voiceParts.length === uttParts.length) {
				const refined = await this.refineVoices(voiceParts, notePath);
				if (refined) ({ utts, voiceGuesses } = refined);
			}
			if (targetNote && (utts?.length || texts.length)) await this.setMeetingProgress(targetNote, "Writing the summary and action items…");
			if (!utts?.length && !texts.length) {
				new Notice("Power Assistant: every part came back empty.");
				if (targetNote)
					await this.noteMeetingIssue(
						targetNote,
						'The recording came back empty; no speech was transcribed. Confirm the meeting audio (and system audio, for calls) was being captured, then open the saved recording and run "Process the active audio file" to retry.'
					);
				else await this.failStub(notePath, "The recording came back empty; no speech was transcribed in any part.");
				return false;
			}
			await this.finishNote({
				file: first,
				utts,
				voiceGuesses,
				plainText: texts.join("\n\n"),
				overrides: o,
				notePath,
				date,
				title,
				embedAll: files.map((f) => f.path),
				partOffsets: offsets,
				costProvider: provider,
				audioMinutes: utts?.length ? undefined : files.reduce((n, f) => n + f.stat.size, 0) / 180000,
				willTrash: this.settings.audioRetention === "trash",
				targetNote,
				priorAttendees,
				recorded: target?.recorded,
			});
			if (this.settings.audioRetention === "trash") await this.applyRetention(files);
			return true;
		} catch (e) {
			console.error("Power Assistant:", e);
			const msg = e instanceof Error ? e.message : String(e);
			new Notice("Power Assistant failed: " + msg, 8000);
			if (targetNote)
				await this.noteMeetingIssue(
					targetNote,
					`Transcription or extraction failed: ${msg}. The audio is saved in your recordings folder; open it and run "Process the active audio file" to retry.`
				);
			else await this.failStub(notePath, `Transcription or extraction failed: ${msg}`);
			return false;
		} finally {
			this.inFlight.delete(first.path);
		}
	}

	/** The shared back half of every capture: name the speakers, link the
	 *  series, extract (tasks grammar and prior context included), assemble.
	 *  Works with or without an audio file (transcript imports have none). */
	private async finishNote(opts: {
		file?: TFile;
		utts: Utterance[] | null;
		/** Letter -> person from the voiceprint review; rides the same
		 *  suggestion rail as the text guesses and outranks them. */
		voiceGuesses?: Record<string, string>;
		plainText: string;
		overrides: ProcessOverrides;
		notePath: string;
		date: string;
		title?: string;
		embedAll?: string[];
		partOffsets?: number[];
		sourceText?: string;
		embedText?: string | null;
		costProvider?: "assemblyai" | "whisper" | "deepgram" | "whisperx" | null;
		audioMinutes?: number;
		/** The audio will be trashed after this note is written (retention). */
		willTrash?: boolean;
		/** Fold this capture into an existing meeting note instead of creating a
		 *  new one; priorAttendees are the note's pre-entered attendees. */
		targetNote?: TFile;
		priorAttendees?: string[];
		/** Actual recording wall-clock, e.g. "2:47 PM - 3:12 PM". */
		recorded?: string;
	}) {
		const s = this.settings;
		const usage = { tokIn: 0, tokOut: 0 };
		const utts = opts.utts;
		let transcript = utts?.length ? formatUtterances(utts) : opts.plainText;
		// learned corrections fix misheard names/words before naming and extraction
		if (s.corrections.length) transcript = applyCorrections(transcript, s.corrections);
		let attendees: string[] = [];
		let speakersLine: string | null = null;
		// transcript-mode naming skipped the dialog: the finished note opens (or
		// is already open, for a meeting) so the letters can be tagged in place
		let tagInTranscript = false;
		if (utts?.length) {
			const shares = talkShares(utts);
			const named = [...new Set(shares.map((sh) => sh.speaker).filter((l) => !isAnonymousLabel(l)))];
			let names: Record<string, string> = {};
			if (named.length) {
				// an imported/diarized transcript that already carries real names,
				// at ANY speaker count — no dialog; the rename command covers fixes
				attendees = named;
			} else if (countSpeakers(utts) >= 2 && ((s.nameSpeakers && this.llmReady()) || Object.keys(opts.voiceGuesses ?? {}).length)) {
				const letters = shares.map((sh) => sh.speaker); // busiest speakers first
				const voice = opts.voiceGuesses ?? {};
				let guesses: Record<string, string> = {};
				// Claude only reads for the letters the voices did not already
				// answer; a meeting of enrolled voices skips the call entirely
				const unnamed = letters.filter((l) => !voice[l]);
				if (unnamed.length && s.nameSpeakers && this.llmReady()) {
					try {
						guesses = parseSpeakerNames(await this.claude(buildSpeakerNamePrompt(transcript, unnamed), 300, usage, "names"), unnamed);
					} catch (e) {
						console.warn("Power Assistant: speaker-name inference failed; keeping letters.", e);
					}
				}
				guesses = { ...guesses, ...voice }; // a recognized voice outranks a text guess
				if (s.speakerNaming === "dialog") {
					const stats: Record<string, { share: number; first: string }> = {};
					for (const sh of shares) stats[sh.speaker] = { share: sh.share, first: sh.first };
					// clips so you can HEAR each diarized voice before naming it; the
					// parts are still on disk here (retention trims only after the
					// note is written), and the dialog tears the player down
					const partPaths = opts.embedAll ?? (opts.file ? [opts.file.path] : []);
					const partFiles = partPaths.map((p) => this.app.vault.getAbstractFileByPath(p)).filter((f): f is TFile => f instanceof TFile);
					const player = partFiles.length ? new SegmentPlayer(this, partFiles, opts.partOffsets?.length ? opts.partOffsets : [0]) : null;
					names = await confirmSpeakerNames(this.app, letters, {
						guesses,
						stats,
						suggestions: this.knownAttendees(),
						samples: player ? pickSpeakerSamples(utts) : undefined,
						player,
					});
					if (Object.keys(names).length) {
						transcript = applySpeakerNames(transcript, names);
						attendees = [...new Set(Object.values(names))];
					}
				} else {
					// transcript naming (the Otter way): the note ships with its
					// letters and the guesses ride the label menu as one-click
					// suggestions, instead of a dialog asserting them up front
					const byLabel: Record<string, string> = {};
					for (const [l, n] of Object.entries(guesses)) if (n?.trim()) byLabel[`Speaker ${l}`] = n.trim();
					if (Object.keys(byLabel).length) this.rememberGuesses(opts.notePath, byLabel);
					tagInTranscript = true;
				}
			} else {
				// a solo, unlabeled, diarized recording is a voice memo → you
				attendees = memoAttendees(utts, s.yourName);
			}
			speakersLine = formatSpeakersLine(shares, (l) => names[l] ?? (isAnonymousLabel(l) ? `Speaker ${l}` : l));
		}
		// a meeting recording keeps the attendees the user pre-entered, unioned
		// with anyone the recording itself surfaced
		if (opts.priorAttendees?.length) attendees = [...new Set([...opts.priorAttendees, ...attendees])];
		// learned corrections also rename the attendees and the talk-share line, so
		// a remembered name swap carries into every future meeting's frontmatter,
		// not just the transcript text
		if (s.corrections.length) {
			attendees = [...new Set(attendees.map((a) => applyCorrections(a, s.corrections)))];
			if (speakersLine) speakersLine = applyCorrections(speakersLine, s.corrections);
		}
		const title = opts.title ?? opts.file?.basename ?? "Imported meeting";
		let series: string | null = null;
		let priorContext: string | null = null;
		let carryOver: string | null = null;
		if (s.seriesAware) {
			const key = seriesKey(title);
			if (key) {
				series = key;
				const prev = this.findPreviousNote(key, opts.overrides.outputFolder, opts.notePath, opts.date);
				if (prev) {
					const prevMd = await this.app.vault.cachedRead(prev);
					const open = extractOpenTasks(prevMd);
					carryOver = buildCarryOver(open, prev.path);
					const dm = prevMd.match(/## Decisions\n([\s\S]*?)(?=\n## |$)/);
					priorContext =
						[
							dm ? "Decisions last time:\n" + dm[1].trim() : "",
							open.length ? "Still open from last time:\n" + open.join("\n") : "",
						]
							.filter(Boolean)
							.join("\n\n")
							.slice(0, 3000) || null;
				}
			}
		}
		let body: string | null = null;
		let extractionError: string | null = null;
		if (this.llmReady()) {
			if (!opts.targetNote) new Notice("Power Assistant: extracting notes…"); // meeting notes show the in-note progress instead
			try {
				body = await withRetry(() =>
					this.extract(
						transcript,
						opts.overrides.extractions,
						{ actionsAsTasks: s.actionsAsTasks, meetingDate: opts.date, priorContext },
						usage
					)
				);
			} catch (e) {
				// transcription already succeeded — never throw the transcript away
				extractionError = humanizeError(e instanceof Error ? e.message : String(e));
				console.error("Power Assistant: extraction failed; saving the transcript.", e);
				new Notice("Power Assistant: extraction failed; saved the transcript. Run Re-extract to retry. " + extractionError, 12000);
			}
		}
		const moments = opts.file ? (this.momentsByCapture[opts.file.path] ?? []) : [];
		if (opts.file) delete this.momentsByCapture[opts.file.path];
		const last = utts?.[utts.length - 1];
		const audioMinutes = opts.audioMinutes ?? (opts.costProvider && last ? Math.max(0, (last.end ?? last.start ?? 0) / 60000) : 0);
		const cost = estimateCost(this.llmModelName(), usage.tokIn, usage.tokOut, audioMinutes, opts.costProvider ?? null);
		// meter the transcription on its own so the panel can show the two bills
		// apart; the Claude side is already logged inside claude()
		if (opts.costProvider && audioMinutes > 0) {
			const audioModel =
				opts.costProvider === "deepgram"
					? s.deepgramModel.trim() || "nova-2"
					: opts.costProvider === "whisper"
						? s.transcriptionModel.trim() || "whisper"
						: opts.costProvider === "whisperx"
							? "whisperx"
							: "universal";
			this.logAudioUsage("transcribe", opts.costProvider, audioModel, audioMinutes);
		}
		// when the audio will be trashed after processing, neither embed nor
		// wiki-link it (both would dangle); the transcript is the durable record
		const trashing = !!opts.willTrash;
		const embedDefault = trashing ? "" : (opts.embedAll ?? (opts.file ? [opts.file.path] : [])).map((p) => `![[${p}]]`).join("\n");
		const source = opts.sourceText ?? (opts.file ? (trashing ? opts.file.path : `[[${opts.file.path}]]`) : "import");
		const note = assembleNote({
			title,
			date: opts.date,
			source,
			embed: opts.embedText !== undefined ? opts.embedText : embedDefault || null,
			body,
			transcript,
			// assembleNote also forces the transcript in on an extraction error,
			// so paid-for transcription is never lost even if this was off
			includeTranscript: opts.overrides.includeTranscript,
			recorded: opts.recorded,
			model: body ? this.llmModelName() : null,
			attendees,
			peopleFolder: this.peopleFolderPath(),
			series,
			carryOver,
			moments,
			partsMs: opts.partOffsets,
			speakersLine,
			cost,
			extractionError,
			filename: opts.notePath,
		});
		if (opts.targetNote) {
			// fold the recording into the meeting note: its agenda stays on top,
			// the AI summary, action items, transcript, and embed land below
			await this.mergeIntoNote(opts.targetNote, note);
			await this.screensAfterProcess(opts, opts.targetNote);
			if (tagInTranscript) this.tagHandoff();
			return;
		}
		await this.writeNote(opts.notePath, opts.overrides.outputFolder, note);
		const written = this.app.vault.getAbstractFileByPath(opts.notePath);
		if (written instanceof TFile) await this.screensAfterProcess(opts, written);
		if (tagInTranscript) {
			// the Otter handoff: open the transcript itself for tagging
			const f = this.app.vault.getAbstractFileByPath(opts.notePath);
			if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
			this.tagHandoff();
		}
	}

	/** Add the Screens section to a note a capture run just wrote.
	 *
	 *  Deliberately after the note exists rather than woven into its assembly: the
	 *  scan takes about a minute for an hour of video, and a summary you can read
	 *  now beats a note that appears a minute later complete. The section splices
	 *  itself into the right place either way.
	 *
	 *  Skipped when the recording is about to be trashed (its frames would outlive
	 *  the thing they came from with no way back to it). */
	private async screensAfterProcess(opts: { file?: TFile; embedAll?: string[]; willTrash?: boolean; overrides: ProcessOverrides }, note: TFile) {
		if (!(opts.overrides.screens ?? this.settings.framesFromVideo) || opts.willTrash) return;
		const parts = (opts.embedAll ?? (opts.file ? [opts.file.path] : [])).filter((p) => VIDEO_EXTS.has((p.split(".").pop() ?? "").toLowerCase()));
		if (!parts.length) return;
		// a rotated recording is audio in practice (the recorder captures sound,
		// not screen), so this is a guard rather than a case: say what was left
		// out rather than quietly representing the whole meeting by its first part
		if (parts.length > 1) new Notice(`Power Assistant: scanning the first of ${parts.length} recording parts for screens; the rest are not scanned.`, 9000);
		const f = this.app.vault.getAbstractFileByPath(parts[0]);
		if (!(f instanceof TFile)) return;
		const s = this.settings;
		await this.addScreens(note, null, f, {
			everyMs: Math.max(1, s.frameEvery) * 1000,
			threshold: s.frameThreshold,
			max: s.frameMax,
			captions: s.frameCaptions,
		});
	}

	/** One line of orientation after a transcript lands with lettered voices. */
	private tagHandoff() {
		new Notice("Power Assistant: speakers are lettered. Click a turn to hear the voice, then click the letter to name it.", 10000);
	}

	/** Hold Claude's guesses for the label menu, capped so a long session never
	 *  grows this without bound (oldest notes drop first). */
	private rememberGuesses(notePath: string, guesses: Record<string, string>) {
		delete this.speakerGuesses[notePath]; // re-insert to refresh recency
		this.speakerGuesses[notePath] = guesses;
		const keys = Object.keys(this.speakerGuesses);
		for (let i = 0; i < keys.length - 24; i++) delete this.speakerGuesses[keys[i]];
	}

	/** Run the voice layer over a WhisperX transcription's parts: align the
	 *  parts into one speaker space, audit clusters against the voiceprint
	 *  library, remember each letter's voice for later enrollment, and hand
	 *  back the (possibly relabeled) utterances plus per-letter guesses.
	 *  Any failure returns null and the raw diarization stands. */
	private async refineVoices(
		parts: { voice: VoiceData; offsetMs: number }[],
		notePath: string
	): Promise<{ utts: Utterance[]; voiceGuesses: Record<string, string> } | null> {
		try {
			const lib = await this.loadVoiceprints();
			const merged = mergeDiarizedParts(
				parts.map((p) => ({ utts: p.voice.fine, embeddings: p.voice.embeddings, turnEmbeddings: p.voice.turnEmbeddings, offsetMs: p.offsetMs }))
			);
			const review = reviewSpeakerClusters(merged.utts, merged.turnEmbeddings, lib);
			const utts = coalesceUtterances(review.utts);
			// post-review means win over the raw cluster means: a split
			// letter's raw mean still blends the voice that was moved out
			const letterVoices = { ...merged.embeddings, ...review.letterEmbeddings };
			if (Object.keys(letterVoices).length) {
				this.rememberNoteVoices(notePath, letterVoices);
				void this.saveSettings();
			}
			for (const sp of review.splits) {
				new Notice(`Power Assistant: Speaker ${sp.from} was more than one voice; ${sp.turns} turns match ${sp.person} and moved to Speaker ${sp.to}.`, 8000);
			}
			const voiceGuesses: Record<string, string> = {};
			for (const [letter, g] of Object.entries(review.guesses)) voiceGuesses[letter] = g.person;
			return { utts, voiceGuesses };
		} catch (e) {
			console.warn("Power Assistant: the voice review failed; keeping the raw diarization.", e);
			return null;
		}
	}

	/** The voiceprint library, read fresh from its synced vault file each
	 *  time: another device may have enrolled someone since this one last
	 *  looked, and the file is small. */
	async loadVoiceprints(): Promise<VoiceprintLibrary> {
		try {
			const p = normalizePath(this.settings.voiceprintsFile.trim() || "_resources/voiceprints.json");
			if (await this.app.vault.adapter.exists(p)) return parseVoiceprintLibrary(JSON.parse(await this.app.vault.adapter.read(p)));
		} catch (e) {
			console.warn("Power Assistant: could not read the voiceprint library; treating it as empty.", e);
		}
		return [];
	}

	/** Write the library to its vault file (creating the folder on first
	 *  enroll), where vault sync carries it to the rest of the fleet. */
	async saveVoiceprints(lib: VoiceprintLibrary) {
		try {
			const p = normalizePath(this.settings.voiceprintsFile.trim() || "_resources/voiceprints.json");
			const dir = p.split("/").slice(0, -1).join("/");
			if (dir && !(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
			await this.app.vault.adapter.write(p, JSON.stringify(lib));
		} catch (e) {
			console.error("Power Assistant: could not save the voiceprint library.", e);
			new Notice("Power Assistant: could not save the voiceprint library.");
		}
	}

	/** Hold each letter's post-review voice in settings so naming the letter
	 *  later, on any synced device, can still enroll it. Rounded to 4
	 *  decimals and capped like the guess cache; enrollment consumes the
	 *  entry, so this mostly holds the letters nobody has named yet. */
	private rememberNoteVoices(notePath: string, letters: Record<string, SpeakerEmbedding>) {
		const s = this.settings;
		const rounded: Record<string, SpeakerEmbedding> = {};
		for (const [l, e] of Object.entries(letters)) rounded[l] = { vector: e.vector.map((x) => Math.round(x * 1e4) / 1e4), seconds: e.seconds };
		delete s.noteVoices[notePath]; // re-insert to refresh recency
		s.noteVoices[notePath] = rounded;
		const keys = Object.keys(s.noteVoices);
		for (let i = 0; i < keys.length - 24; i++) delete s.noteVoices[keys[i]];
	}

	/** Naming a letter is the enrollment moment: fold that letter's
	 *  remembered voice into the person's print. The min-speech gate keeps a
	 *  clipped "No." from ever defining a voice, and a named-to-named rename
	 *  never enrolls, because only letters carry a remembered voice. */
	private async enrollFromMapping(notePath: string, mapping: Record<string, string>) {
		try {
			const voices = this.settings.noteVoices[notePath];
			if (!voices) return;
			let lib: VoiceprintLibrary | null = null;
			const enrolled: string[] = [];
			for (const [from, to] of Object.entries(mapping)) {
				const m = from.match(/^Speaker (.+)$/);
				const person = to?.trim();
				if (!m || !person || /^Speaker /.test(person)) continue;
				const emb = voices[m[1]];
				if (!emb || !usableEmbedding(emb)) continue;
				lib = enrollVoiceprint(lib ?? (await this.loadVoiceprints()), person, emb.vector, Date.now());
				delete voices[m[1]];
				enrolled.push(person);
			}
			if (!lib) return;
			if (!Object.keys(voices).length) delete this.settings.noteVoices[notePath];
			await this.saveVoiceprints(lib);
			void this.saveSettings();
			new Notice(`Power Assistant: voice remembered for ${[...new Set(enrolled)].join(", ")}.`);
		} catch (e) {
			console.warn("Power Assistant: voice enrollment failed.", e);
		}
	}

	/** Fold an assembled capture into an existing note. When the note is open,
	 *  merge against the live editor buffer and write back through it, so notes
	 *  typed while the meeting ran are preserved rather than overwritten by a
	 *  stale on-disk read; otherwise read and modify the file. Shows the note. */
	private async mergeIntoNote(target: TFile, note: string) {
		const view = this.app.workspace
			.getLeavesOfType("markdown")
			.map((l) => l.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === target.path);
		if (view) {
			const cur = view.editor.getCursor();
			view.editor.setValue(mergeMeetingCapture(stripProgress(view.editor.getValue()), note));
			view.editor.setCursor(cur);
			this.app.workspace.revealLeaf(view.leaf);
			return;
		}
		const existing = stripProgress(await this.app.vault.read(target));
		await this.app.vault.modify(target, mergeMeetingCapture(existing, note));
		await this.app.workspace.getLeaf(false).openFile(target);
	}

	/** Show or clear the in-note "working" indicator (a spinner callout) while a
	 *  recording is transcribed and extracted, so progress is visible in the page
	 *  instead of a stack of toasts. Editor-aware; preserves cursor position. */
	private async setMeetingProgress(target: TFile, text: string | null) {
		const block = text ? `> [!pc-working]+ Power Assistant\n> ${text}` : "";
		const apply = (data: string): string => {
			const base = stripProgress(data).trimEnd();
			return (block ? `${base}\n\n${block}` : base) + "\n";
		};
		try {
			await this.rewriteNote(target, apply);
		} catch (e) {
			console.warn("Power Assistant: could not update the progress indicator.", e);
		}
	}

	/** Rewrite a note through whichever copy of it is authoritative.
	 *
	 *  A file open in an editor holds changes that are not on disk yet, so a
	 *  `vault.process` against it reads the stale version and writes the edited one
	 *  away. Every path that rewrites a note a capture run has just touched has to
	 *  go through here, because folding a recording into a meeting note writes
	 *  through the editor and is immediately followed by more rewriting. */
	private async rewriteNote(target: TFile, apply: (data: string) => string) {
		const view = this.app.workspace
			.getLeavesOfType("markdown")
			.map((l) => l.view)
			.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === target.path);
		if (!view) {
			await this.app.vault.process(target, apply);
			return;
		}
		const cur = view.editor.getCursor();
		view.editor.setValue(apply(view.editor.getValue()));
		view.editor.setCursor(cur);
	}

	/** When a recording cannot be folded into its meeting note (empty audio or a
	 *  transcription/extraction failure), append a visible warning rather than
	 *  leaving the user staring at an unchanged note. Editor-aware like the merge. */
	private async noteMeetingIssue(target: TFile, message: string) {
		const callout = `> [!warning] Recording not added\n> ${message.replace(/\s+/g, " ").trim()}`;
		try {
			const view = this.app.workspace
				.getLeavesOfType("markdown")
				.map((l) => l.view)
				.find((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === target.path);
			if (view) {
				view.editor.setValue(`${stripProgress(view.editor.getValue()).trimEnd()}\n\n${callout}\n`);
				this.app.workspace.revealLeaf(view.leaf);
			} else {
				await this.app.vault.process(target, (data) => `${stripProgress(data).trimEnd()}\n\n${callout}\n`);
			}
		} catch (e) {
			console.error("Power Assistant: could not annotate the meeting note.", e);
		}
	}

	/** Attendees across every capture note, most frequent first — the
	 *  type-ahead behind the naming dialog. */
	knownAttendees(): string[] {
		const count = new Map<string, number>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { type?: string; tags?: unknown; attendees?: unknown } | undefined;
			if (!isCaptureNote(fm) || !Array.isArray(fm.attendees)) continue;
			for (const a of fm.attendees as unknown[]) {
				const n = personName(a);
				if (n) count.set(n, (count.get(n) ?? 0) + 1);
			}
		}
		return [...count.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([n]) => n)
			.slice(0, 30);
	}

	/* ---------------- person hubs + digest + base ---------------- */

	/** Every capture note's parsed essentials, one vault pass. */
	private async eachCapture(
		fn: (f: TFile, fm: Record<string, unknown>, md: string, date: string, attendees: string[]) => void
	): Promise<void> {
		for (const f of this.app.vault.getMarkdownFiles()) {
			// a conflict copy of a meeting is the same meeting twice: counting it
			// inflates every attendee's history, and it only exists on the device
			// that made the copy, so the two devices would derive different pages
			if (isConflictCopy(f.path)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (!isCaptureNote(fm)) continue;
			// ctime is a per-device fact (creation here, download there), so it
			// must be the last resort: a dated filename gives every device the
			// same answer for a note whose frontmatter lost its date
			const date =
				String(fm.date ?? "").slice(0, 10) ||
				f.basename.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ||
				dayOf(new Date(f.stat.ctime));
			const attendees = Array.isArray(fm.attendees)
				? (fm.attendees as unknown[]).map(personName).filter(Boolean)
				: [];
			fn(f, fm, await this.app.vault.cachedRead(f), date, attendees);
		}
	}

	private sectionItems(md: string, heading: string): string[] {
		return sectionListItems(md, heading);
	}

	/** Write (or refresh) a generated note; never clobbers a human note. The
	 *  gate reads the file itself (not the metadata cache), so refreshing a
	 *  note created seconds ago works. */
	private async writeGenerated(folder: string, name: string, md: string, open = true): Promise<void> {
		await this.ensureFolder(folder);
		const path = normalizePath(`${folder}/${name.replace(/[\\/:*?"<>|#^[\]]/g, "-")}.md`);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const head = (await this.app.vault.cachedRead(existing)).slice(0, 400);
			if (!/^generated: true$/m.test(head)) {
				new Notice(`Power Assistant: ${path} exists and isn't a generated note, so nothing was overwritten.`);
				return;
			}
			await this.app.vault.modify(existing, md);
			if (open) await this.app.workspace.getLeaf(false).openFile(existing);
			return;
		}
		const created = await this.app.vault.create(path, md);
		if (open) await this.app.workspace.getLeaf(false).openFile(created);
	}

	/** The person hub: meetings, open commitments, decisions for one attendee;
	 *  with `withAgenda`, Claude drafts a grounded 1:1 agenda on top. */
	async personReport(name: string, withAgenda: boolean) {
		const md = await this.personHubMarkdown(name, withAgenda);
		if (!md) {
			new Notice(`Power Assistant: no captures mention ${name} yet.`);
			return;
		}
		await this.writeGenerated(this.peopleFolderPath(), name, md);
	}

	/** Collect one attendee's history and render their hub markdown; null when
	 *  nothing in the vault mentions them (unless allowEmpty, for refreshing a
	 *  hub whose meetings were all deleted: it then renders the zero state). */
	private async personHubMarkdown(name: string, withAgenda: boolean, allowEmpty = false, keepDate?: string): Promise<string | null> {
		const d: PersonData = { name, meetings: [], openTasks: [], doneCount: 0, decisions: [], questions: [] };
		await this.eachCapture((f, _fm, md, date, attendees) => {
			// a task can mention the person as bare "[[Name]]" or the qualified,
			// aliased "[[People/Name|Name]]"; match either
			const mine = (line: string) => line.includes(`[[${name}]]`) || line.includes(`|${name}]]`);
			for (const t of extractOpenTasks(md)) if (mine(t)) d.openTasks.push({ text: t, fromPath: f.path, date });
			for (const t of extractDoneTasks(md)) if (mine(t.text)) d.doneCount++;
			if (!attendees.includes(name)) return;
			d.meetings.push({ title: f.basename, path: f.path, date });
			for (const x of this.sectionItems(md, "Decisions")) d.decisions.push({ text: x, fromPath: f.path, date });
			for (const x of this.sectionItems(md, "Questions")) d.questions.push({ text: x, fromPath: f.path, date });
		});
		if (!d.meetings.length && !d.openTasks.length && !allowEmpty) return null;
		// Ties must not fall back to the order Obsidian lists files in: that is
		// creation order on the device that recorded the meeting and download
		// order on the one that synced it, so two devices sorted the same
		// same-day items differently and each rewrote the other's page forever.
		const newest = <T extends { date: string }>(tie: (x: T) => string) => (a: T, b: T) =>
			a.date === b.date ? tie(a).localeCompare(tie(b)) : a.date < b.date ? 1 : -1;
		const byOrigin = (x: { date: string; fromPath: string; text: string }) => `${x.fromPath} ${x.text}`;
		d.meetings.sort(newest((m) => m.path));
		d.openTasks.sort(newest(byOrigin));
		d.decisions.sort(newest(byOrigin));
		// never sorted before, and the report shows only the first 8: whichever
		// order the vault happened to yield decided which questions appeared
		d.questions.sort(newest(byOrigin));
		let agenda: string | null = null;
		if (withAgenda && this.llmReady()) {
			try {
				agenda = await this.claude(
					{
						system:
							"You draft a short 1:1 agenda from meeting-history data. Five bullets max, grounded ONLY in the provided items, most urgent first, no preamble.",
						user:
							`Data for the 1:1 with ${name}:\n\nOpen commitments:\n${d.openTasks.map((t) => t.text).join("\n") || "(none)"}` +
							`\n\nRecent decisions involving them:\n${d.decisions.slice(0, 8).map((x) => x.text).join("\n") || "(none)"}` +
							`\n\nOpen questions from their meetings:\n${d.questions.slice(0, 8).map((x) => x.text).join("\n") || "(none)"}`,
					},
					500,
					undefined,
					"agenda"
				);
			} catch (e) {
				console.warn("Power Assistant: agenda generation failed; report continues without it.", e);
			}
		}
		// Stamping today's date rewrote the page's bytes every day on whichever
		// device rebuilt first; the other rebuilt too and both sides had "changed"
		// since the last sync, which is a real conflict however it is resolved.
		// Derive it from the data, and on a refresh keep what the page already had.
		const dates = [...d.meetings, ...d.openTasks, ...d.decisions, ...d.questions].map((x) => x.date).filter(Boolean).sort();
		return buildPersonReport(d, agenda, dates[dates.length - 1] ?? keepDate ?? today());
	}

	/* ---- documents: OCR into filed, typed notes ---- */

	/** Text for a document: pdf.js for PDFs (bundled with Obsidian), the Text
	 *  Extractor plugin's OCR for images. */
	async extractDocText(file: TFile): Promise<string> {
		if (file.extension.toLowerCase() === "pdf") {
			const pdfjs = await loadPdfJs();
			const data = await this.app.vault.readBinary(file);
			const doc = await pdfjs.getDocument({ data }).promise;
			let out = "";
			const pages = Math.min(doc.numPages ?? 0, 20);
			for (let i = 1; i <= pages; i++) {
				const page = await doc.getPage(i);
				const tc = await page.getTextContent();
				out += (tc.items as { str?: string }[]).map((it) => it.str ?? "").join(" ") + "\n";
			}
			return out;
		}
		const te = (this.app as unknown as { plugins?: { plugins?: Record<string, { api?: { extractText?: (f: TFile) => Promise<string> } }> } })
			.plugins?.plugins?.["text-extractor"]?.api;
		if (!te || typeof te.extractText !== "function")
			throw new Error("Install and enable the Text Extractor plugin to OCR images (PDFs work without it).");
		return await te.extractText(file);
	}

	/** OCR → classify and extract fields → file the original into the
	 *  organized tree → write the typed note beside it. A failed extraction
	 *  still files the document under Other with its original name, so nothing
	 *  silently stays behind. */
	async processDocument(file: TFile) {
		const key = file.path;
		if (this.docsInFlight.has(key)) return;
		this.docsInFlight.add(key);
		try {
			if (!this.llmReady()) {
				new Notice("Power Assistant: " + this.llmMissingMsg());
				return;
			}
			new Notice(`Power Assistant: reading ${file.name}…`);
			let text = "";
			try {
				text = await this.extractDocText(file);
			} catch (e) {
				new Notice("Power Assistant: " + (e instanceof Error ? e.message : String(e)), 8000);
				return;
			}
			if (!text.trim()) {
				new Notice("Power Assistant: no text found in the document (blank or unreadable scan).");
				return;
			}
			const { system, user } = buildDocExtractionPrompt(text);
			let fields: DocFields;
			try {
				fields = parseDocExtraction(await this.claude({ system, user }, 500, undefined, "ocr")) ?? emptyDocFields();
			} catch (e) {
				console.warn("Power Assistant: document extraction failed; filing with what we have.", e);
				fields = emptyDocFields();
			}
			// filing rules decide the folder and tags; no rule keeps the default
			const base = cleanFolderPath(this.settings.docsFolder);
			const filing = resolveDocFiling(this.settings.docRules, fields, text, base || "Documents");
			fields.tags = filing.tags;
			// file the original into the organized tree when filing is on, or when
			// a matching rule named an explicit folder
			let docPath = file.path;
			if (base || filing.explicitFolder) {
				const folder = filing.folder;
				await this.ensureFolder(folder);
				const stem = docNiceName(fields, file.basename);
				let target = normalizePath(`${folder}/${stem}.${file.extension}`);
				let n = 2;
				while (this.app.vault.getAbstractFileByPath(target) && target !== file.path)
					target = normalizePath(`${folder}/${stem}-${n++}.${file.extension}`);
				if (target !== file.path) {
					await this.app.fileManager.renameFile(file, target);
					docPath = target;
				}
			}
			// the note lands beside the filed document with the same stem
			const stem = docPath.replace(/\.[^./]+$/, "");
			let notePath = normalizePath(`${stem}.md`);
			let n = 2;
			while (this.app.vault.getAbstractFileByPath(notePath)) notePath = normalizePath(`${stem}-${n++}.md`);
			const md = buildDocNote(fields, { filePath: docPath, ocrText: text, today: today(), review: filing.flag });
			const note = await this.app.vault.create(notePath, md);
			await this.app.workspace.getLeaf(false).openFile(note);
			new Notice(`Power Assistant: filed ${fields.vendor || file.basename} (${fields.docType}).`);
		} finally {
			this.docsInFlight.delete(key);
		}
	}

	/** Debounced trigger: meeting notes changed (created, edited, renamed, or
	 *  deleted), so generated person pages may list meetings that no longer
	 *  exist or miss new ones. One rebuild per burst of changes. */
	schedulePeopleRefresh() {
		if (this.peopleRefreshTimer != null) window.clearTimeout(this.peopleRefreshTimer);
		this.peopleRefreshTimer = window.setTimeout(() => {
			this.peopleRefreshTimer = null;
			// a sync that started while we waited is still landing files: rebuild
			// from a half-updated vault and this device publishes a page the other
			// one is about to contradict
			if (this.syncInFlight()) {
				this.schedulePeopleRefresh();
				return;
			}
			void this.refreshPersonHubs();
		}, 8000);
	}

	/** True while Power Connect is mid-sync. The files it writes raise the same
	 *  create/modify events a person typing raises, so a refresh triggered by
	 *  them rebuilds person pages from whatever fraction of the change has
	 *  arrived. The device that made the change rebuilds and publishes; the
	 *  others take the result. Absent or older Power Connect reads as idle,
	 *  which is the pre-existing behaviour. */
	private syncInFlight(): boolean {
		const pc = (this.app as unknown as { plugins?: { plugins?: Record<string, { running?: unknown }> } }).plugins?.plugins?.["powerconnect"];
		return pc?.running === true;
	}

	/** Regenerate every GENERATED person page in the People folder from the
	 *  vault's current state. Pages whose content would not change are left
	 *  untouched (no modify event, no sync churn); pages without the
	 *  `generated` property are never touched (remove it to own a page). */
	private async refreshPersonHubs() {
		if (this.refreshingPeople) return;
		this.refreshingPeople = true;
		try {
			const folder = normalizePath(this.peopleFolderPath());
			for (const f of this.app.vault.getMarkdownFiles()) {
				if (f.parent?.path !== folder) continue;
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
				if (fm?.generated !== true) continue;
				// a conflict copy of a person page is still marked generated, so
				// without this it would be rebuilt as a person named after the
				// conflict filename: zero meetings, and the copy Power Connect
				// saved to protect the losing edit is destroyed by the rebuild
				if (isConflictCopy(f.basename)) continue;
				const md = await this.personHubMarkdown(f.basename, false, true, typeof fm.date === "string" ? fm.date : undefined);
				if (!md) continue;
				const cur = await this.app.vault.cachedRead(f);
				if (cur.trim() === md.trim()) continue;
				await this.app.vault.modify(f, md);
			}
		} catch (e) {
			console.error("Power Assistant: refreshing person pages failed.", e);
		} finally {
			this.refreshingPeople = false;
		}
	}

	/** Whether any capture note lists this exact name as an attendee. Unlike
	 *  knownAttendees(), this checks everyone, not just the 30 most frequent. */
	private isKnownAttendee(name: string): boolean {
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { type?: string; tags?: unknown; attendees?: unknown } | undefined;
			if (!isCaptureNote(fm) || !Array.isArray(fm.attendees)) continue;
			for (const a of fm.attendees as unknown[]) if (personName(a) === name) return true;
		}
		return false;
	}

	/** Clicking an attendee link with no person page yet makes Obsidian create a
	 *  blank note: in the People folder for the qualified links, or at the
	 *  vault's default new-note location for older bare links. Adopt that blank
	 *  page: move it into the People folder and fill it with the person's hub,
	 *  so a click always lands on a real person page. */
	private async fillPersonPage(file: TFile) {
		const name = file.basename;
		if (isConflictCopy(name)) return;
		if (!this.isKnownAttendee(name)) return;
		// let a template plugin or paste land first; only adopt a STILL-empty note
		await sleep(400);
		let cur = this.app.vault.getAbstractFileByPath(file.path);
		if (!(cur instanceof TFile)) return;
		if ((await this.app.vault.read(cur)).trim()) return;
		const folder = this.peopleFolderPath();
		const target = normalizePath(`${folder}/${name}.md`);
		if (cur.path !== target && !this.app.vault.getAbstractFileByPath(target)) {
			await this.ensureFolder(folder);
			await this.app.fileManager.renameFile(cur, target);
			cur = this.app.vault.getAbstractFileByPath(target);
			if (!(cur instanceof TFile)) return;
		}
		const md = await this.personHubMarkdown(name, false);
		if (!md) return;
		// re-check emptiness right before writing: never clobber typed content
		if ((await this.app.vault.read(cur)).trim()) return;
		await this.app.vault.modify(cur, md);
		new Notice(`Power Assistant: built ${name}'s person page.`);
	}

	/** The Monday note: this week's meetings, decisions, commitments by owner,
	 *  and what's going stale — aging in your own Power Tables colors. Returns
	 *  whether a digest was actually written (the auto-trigger stamps on that). */
	async weeklyDigest(open = true): Promise<boolean> {
		const now = new Date();
		const to = dayOf(now);
		const from = daysAgo(6, now);
		const staleBefore = daysAgo(7, now);
		const d: DigestData = { from, to, meetings: [], decisions: [], newTasks: [], completed: [], stale: [], questions: [] };
		await this.eachCapture((f, fm, md, date) => {
			if (date >= from && date <= to) {
				d.meetings.push({ title: f.basename, path: f.path, date, series: fm.series ? String(fm.series) : null });
				for (const x of this.sectionItems(md, "Decisions")) d.decisions.push({ text: x, fromPath: f.path });
				for (const x of this.sectionItems(md, "Questions")) d.questions.push({ text: x, fromPath: f.path });
				for (const t of extractOpenTasks(md)) d.newTasks.push({ owner: taskOwner(t), text: t, fromPath: f.path, done: false });
				for (const t of extractDoneTasks(md)) d.newTasks.push({ owner: taskOwner(t.text), text: t.text, fromPath: f.path, done: true });
				return;
			}
			for (const t of extractDoneTasks(md)) {
				if (t.doneDate && t.doneDate >= from && t.doneDate <= to) {
					d.completed.push({ owner: taskOwner(t.text), text: t.text, fromPath: f.path });
				}
			}
			if (date < staleBefore) {
				const ageDays = Math.floor((now.getTime() - new Date(date + "T00:00:00").getTime()) / 86400000);
				for (const t of extractOpenTasks(md)) d.stale.push({ owner: taskOwner(t), text: t, fromPath: f.path, date, ageDays });
			}
		});
		d.meetings.sort((a, b) => (a.date < b.date ? 1 : -1));
		let summary: string | null = null;
		if (this.llmReady() && (d.meetings.length || d.completed.length)) {
			try {
				summary = await this.claude(
					{
						system:
							"You write ONE short executive paragraph summarizing a week of meetings from structured data. Grounded only in the data, no preamble, no headings.",
						user: `Meetings: ${d.meetings.map((m) => m.title).join("; ") || "(none)"}\nDecisions:\n${d.decisions.map((x) => x.text).join("\n") || "(none)"}\nNew commitments: ${d.newTasks.length}, completed this week: ${d.completed.length + d.newTasks.filter((t) => t.done).length}, going stale: ${d.stale.length}`,
					},
					300,
					undefined,
					"summary"
				);
			} catch (e) {
				console.warn("Power Assistant: digest summary failed; digest continues without it.", e);
			}
		}
		// the auto-trigger writes silently and only when the week has content;
		// the "wrote" result and this guard use the SAME condition, so a week
		// with completed tasks but no meetings still stamps and never re-fires
		if (!open && !d.meetings.length && !d.completed.length) return false;
		await this.writeGenerated(`${this.settings.outputFolder}/Digests`, `Digest ${to}`, buildWeeklyDigest(d, summary, to), open);
		return true;
	}

	/** Auto-digest: once per new ISO week, on layout-ready, if the week has
	 *  content. Opt-in (settings) and never steals focus. */
	private async maybeAutoDigest() {
		const week = isoWeek(today());
		if (week === this.settings.lastDigestWeek) return;
		const wrote = await this.weeklyDigest(false);
		if (wrote) {
			this.settings.lastDigestWeek = week;
			await this.saveSettings();
			new Notice("Power Assistant: this week's meeting digest is ready.");
		}
	}

	/** The start-of-day note: today's meetings, commitments coming due, bills and
	 *  documents due soon, and open questions. Gathers from the vault (and the
	 *  calendar when connected), writes a generated note, and opens it. */
	async morningBriefing(open = true): Promise<void> {
		const today = dayOf(new Date());
		const horizon = daysAgo(-Math.max(0, this.settings.briefingHorizonDays));
		const me = this.settings.yourName.trim();
		const d: BriefingData = { date: today, meetings: [], commitments: [], dueDocs: [], questions: [] };
		const seenMeeting = new Set<string>();
		await this.eachCapture((f, fm, md, date, attendees) => {
			if (date === today && (fm.time || Array.isArray(fm.attendees))) {
				d.meetings.push({
					time: String(fm.time ?? ""),
					title: f.basename,
					path: f.path,
					join: null,
					attendees: attendees.length ? attendees : undefined,
					agenda: sectionText(md, "Agenda") || undefined,
					location: fm.location ? String(fm.location) : undefined,
				});
				seenMeeting.add(f.basename.toLowerCase());
			}
			// my commitments with a due date that is overdue or within the horizon
			for (const line of extractOpenTasks(md)) {
				const due = taskDueDate(line);
				if (!due || due > horizon) continue;
				const { owner, task } = parseActionRow(line);
				if (me && owner !== me && owner !== "Unassigned") continue;
				d.commitments.push({ task, owner, due, fromPath: f.path, overdue: due < today });
			}
			// open questions from the last week, worth keeping in view
			if (date >= daysAgo(7))
				for (const q of this.sectionItems(md, "Questions")) d.questions.push({ text: q, fromPath: f.path });
		});
		// documents with a due date (bills, invoices) coming due or overdue
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { type?: unknown; due?: unknown; amount?: unknown; currency?: unknown; vendor?: unknown } | undefined;
			if (fm?.type !== "capture-doc") continue;
			const due = String(fm.due ?? "");
			if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || due > horizon) continue;
			const amount = fm.amount != null ? `${fm.currency ? String(fm.currency) + " " : ""}${fm.amount}` : "";
			d.dueDocs.push({ title: fm.vendor ? String(fm.vendor) : f.basename, amount, due, path: f.path, overdue: due < today });
		}
		// enrich with the live calendar when connected: real times, join links,
		// and meetings not yet prepped as notes
		if (this.graphConnected()) {
			const invites = await this.calendarInvites().catch(() => null);
			for (const inv of invites ?? []) {
				if (inv.date !== today) continue;
				const existing = d.meetings.find((m) => m.title.toLowerCase().includes(inv.title.toLowerCase()) || seenMeeting.has(inv.title.toLowerCase()));
				if (existing) {
					if (!existing.time) existing.time = inv.when;
					if (!existing.join) existing.join = inv.teamsUrl || null;
					if (!existing.attendees?.length && inv.attendees.length) existing.attendees = inv.attendees;
					if (!existing.agenda && inv.agenda) existing.agenda = inv.agenda;
					if (!existing.location && inv.location) existing.location = inv.location;
				} else {
					d.meetings.push({
						time: inv.when,
						title: inv.title,
						path: null,
						join: inv.teamsUrl || null,
						attendees: inv.attendees.length ? inv.attendees : undefined,
						agenda: inv.agenda || undefined,
						location: inv.location || undefined,
					});
				}
			}
		}
		d.meetings.sort((a, b) => a.time.localeCompare(b.time));
		d.commitments.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
		d.dueDocs.sort((a, b) => (a.due < b.due ? -1 : 1));
		const folder = this.settings.briefingsFolder.trim() || `${this.settings.outputFolder}/Briefings`;
		await this.writeGenerated(folder, `${today} Briefing`, buildMorningBriefing(d, longDate(today)), open);
	}

	private async maybeAutoBriefing() {
		const today = dayOf(new Date());
		if (today === this.settings.lastBriefingDay) return;
		this.settings.lastBriefingDay = today;
		await this.saveSettings();
		await this.morningBriefing(true);
	}

	/** The redaction config for share/export, from settings (+ the note's own
	 *  attendees when asked). Null when nothing would be masked. `force` turns
	 *  it on for the one-off "Copy redacted summary" command. */
	private redaction(file: TFile, force: boolean): import("./pipeline").RedactionConfig | null {
		const s = this.settings;
		if (!force && !s.redactShare) return null;
		const terms = s.redactTerms.split(",").map((t) => t.trim()).filter(Boolean);
		if (s.redactAttendees) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as { attendees?: unknown } | undefined;
			if (Array.isArray(fm?.attendees)) {
				for (const a of fm.attendees as unknown[]) {
					const n = personName(a);
					if (n) terms.push(n);
				}
			}
		}
		const cfg = { emails: s.redactEmails, phones: s.redactPhones, ssns: s.redactSsns, cards: s.redactCards, terms };
		return redactionActive(cfg) ? cfg : null;
	}

	/** Open the writer over one meeting note's distilled context. */
	async draftFromNote(file: TFile) {
		const md = await this.app.vault.cachedRead(file);
		new DraftModal(this.app, this, buildDraftContext(md), file).open();
	}

	/** Open the writer over the last week's meetings, so "the status email from
	 *  this week" has every meeting's decisions and actions to draw on. */
	async draftFromRecent() {
		const since = daysAgo(7);
		const parts: string[] = [];
		await this.eachCapture((f, _fm, md, date) => {
			if (date >= since) parts.push(buildDraftContext(md));
		});
		if (!parts.length) {
			new Notice("Power Assistant: no meetings in the last week to draft from.");
			return;
		}
		// most recent first, capped so a busy week still fits the prompt
		new DraftModal(this.app, this, parts.reverse().join("\n\n---\n\n").slice(0, 14000), null).open();
	}

	/** Distill a capture note to the clipboard for Teams/email, optionally
	 *  masking sensitive info. */
	async copySummary(file: TFile, forceRedact = false) {
		const md = await this.app.vault.cachedRead(file);
		let text = formatSummaryForClipboard(md);
		const cfg = this.redaction(file, forceRedact);
		if (cfg) text = redact(text, cfg);
		await navigator.clipboard.writeText(text);
		new Notice(cfg ? "Power Assistant: redacted summary copied." : "Power Assistant: summary copied to the clipboard.");
	}

	/** Read every screen a recap wants into PNG bytes the document can carry.
	 *
	 *  Two jobs at once, and one decode pays for both: the picture's own pixel size,
	 *  which the builder needs to scale it into the text column, and a re-encode out
	 *  of webp, which belongs in a vault but not in a .docx. A frame that cannot be
	 *  read is left out of the map rather than failing the export, and the builder
	 *  still prints its stamp and caption so the recap does not quietly lose it. */
	private async resolveScreens(model: ExportModel, note: TFile): Promise<Map<string, ResolvedImage>> {
		const out = new Map<string, ResolvedImage>();
		const links = [...new Set(model.sections.flatMap((s) => s.images.map((i) => i.link)))];
		for (const link of links) {
			const f = this.app.metadataCache.getFirstLinkpathDest(link, note.path);
			if (!(f instanceof TFile)) continue;
			try {
				out.set(link, await pngForDocx(this.app.vault.getResourcePath(f)));
			} catch (e) {
				console.error("Power Assistant: a screen could not be read for the export.", e);
			}
		}
		return out;
	}

	/** Export a capture note as a formatted Word document (the same .docx shape
	 *  the AI-notetaker recap tools produce), into an Exports folder. */
	async exportDocx(file: TFile) {
		try {
			let md = await this.app.vault.cachedRead(file);
			const cfg = this.redaction(file, false);
			if (cfg) md = redact(md, cfg);
			const model = parseCaptureForExport(md, file.basename);
			const blob = await Packer.toBlob(buildMeetingDoc(model, await this.resolveScreens(model, file)));
			const data = await blob.arrayBuffer();
			const folder = `${this.settings.outputFolder}/Exports`;
			await this.ensureFolder(folder);
			const path = normalizePath(`${folder}/${file.basename}.docx`);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
			else await this.app.vault.createBinary(path, data);
			new Notice(`Power Assistant: exported to ${path}`, 6000);
			// best-effort open in the system default app (Word), desktop only —
			// isolated so a throw/rejection can't produce a false "failed" notice
			const openExternal = (this.app as unknown as { openWithDefaultApp?: (p: string) => unknown }).openWithDefaultApp;
			if (typeof openExternal === "function") {
				try {
					void Promise.resolve(openExternal.call(this.app, path)).catch(() => {});
				} catch {
					/* the file is already saved; opening it is a convenience */
				}
			}
		} catch (e) {
			console.error("Power Assistant:", e);
			new Notice("Power Assistant: Word export failed: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/** A ready-made Power Bases view over every capture note. */
	/** A finances overview from processed documents: per-currency totals, bills
	 *  due, and spending by vendor and month. Written as a generated note. */
	async financesRollup(open = true) {
		const docs: FinanceDoc[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (fm?.type !== "capture-doc") continue;
			const amount = typeof fm.amount === "number" ? fm.amount : parseFloat(String(fm.amount ?? "")) || 0;
			docs.push({
				title: fm.vendor ? String(fm.vendor) : f.basename,
				path: f.path,
				vendor: fm.vendor ? String(fm.vendor) : "",
				docType: String(fm["doc-type"] ?? ""),
				amount,
				currency: fm.currency ? String(fm.currency) : "",
				date: String(fm.date ?? "").slice(0, 10),
				due: String(fm.due ?? ""),
			});
		}
		if (!docs.length) {
			new Notice("Power Assistant: no processed documents yet. Right-click a bill or receipt and choose Process document.");
			return;
		}
		const today = dayOf(new Date());
		await this.writeGenerated(`${this.settings.outputFolder}/Finances`, "Finances", buildFinancesRollup(docs, today), open);
	}

	/* ---- mail folder import: a curated folder as a knowledge corpus ---- */

	/** Power Desk's folder listing and per-folder reader, when installed. */
	private mailImporter(): {
		folders: () => Promise<{ accountId: string; accountName: string; id: string; name: string; path: string }[]>;
		read: (accountId: string, folderId: string, opts: { sinceMs?: number; cap?: number }) => Promise<ImportMail[]>;
	} | null {
		const plugs = (
			this.app as unknown as {
				plugins?: {
					plugins?: Record<
						string,
						{
							mailFoldersForImport?: () => Promise<{ accountId: string; accountName: string; id: string; name: string; path: string }[]>;
							mailFromFolder?: (a: string, f: string, o: { sinceMs?: number; cap?: number }) => Promise<ImportMail[]>;
						}
					>;
				};
			}
		).plugins?.plugins;
		const pd = plugs?.["powerdesk"] ?? plugs?.["powercalendar"];
		if (typeof pd?.mailFoldersForImport !== "function" || typeof pd.mailFromFolder !== "function") return null;
		return { folders: pd.mailFoldersForImport.bind(pd), read: pd.mailFromFolder.bind(pd) };
	}

	mailImportAvailable(): boolean {
		return !!this.mailImporter();
	}

	/** Conversation ids already imported, read from the vault so notes deleted
	 *  by hand stop counting and a synced vault is understood on sight. */
	private knownConversations(): Map<string, TFile> {
		const out = new Map<string, TFile>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { type?: unknown; "conversation-id"?: unknown } | undefined;
			if (fm?.type !== "capture-mail") continue;
			const id = String(fm["conversation-id"] ?? "").trim();
			if (id) out.set(id, f);
		}
		return out;
	}

	/** Scan a folder and write the sender report, so a person can decide what to
	 *  block in bulk before importing anything. */
	async mailSenderReport(accountId: string, folderId: string, folderName: string): Promise<void> {
		const imp = this.mailImporter();
		if (!imp) {
			new Notice("Power Assistant: install Power Desk and connect a mailbox first.", 8000);
			return;
		}
		new Notice(`Power Assistant: scanning ${folderName}…`);
		const mail = await imp.read(accountId, folderId, { cap: this.settings.mailImportCap });
		if (!mail.length) {
			new Notice("Power Assistant: that folder looks empty.");
			return;
		}
		const stats = senderStats(collapseThreads(mail));
		const today = dayOf(new Date());
		await this.writeGenerated(`${this.settings.outputFolder}/Mail`, `Senders in ${safeName(folderName)}`, buildSenderReport(stats, folderName, today), true);
	}

	/** Import one mail folder as notes: collapse threads, run the funnel, write
	 *  a note per surviving conversation, and always write the report.
	 *
	 *  An already-imported conversation is updated in place rather than added
	 *  again, so an active thread stays one living note as it grows. */
	async importMailFolder(accountId: string, folderId: string, folderName: string, opts: { useAi?: boolean } = {}): Promise<void> {
		const imp = this.mailImporter();
		if (!imp) {
			new Notice("Power Assistant: install Power Desk and connect a mailbox first.", 8000);
			return;
		}
		const base = this.settings.mailImportFolder.trim();
		if (!base) {
			new Notice("Power Assistant: set a folder for imported mail in settings first.", 8000);
			return;
		}
		new Notice(`Power Assistant: reading ${folderName}…`);
		const mail = await imp.read(accountId, folderId, { cap: this.settings.mailImportCap });
		if (!mail.length) {
			new Notice("Power Assistant: that folder looks empty.");
			return;
		}
		const threads = collapseThreads(mail);
		const { keep, rejected } = filterThreads(threads, {
			focusedOnly: this.settings.mailImportFocusedOnly,
			rules: this.settings.mailImportRules,
			minChars: this.settings.mailImportMinChars,
		});

		let surviving = keep;
		if (opts.useAi && this.llmReady() && keep.length) {
			const judgeJob = this.startJob("Judging exchanges", keep.length);
			const verdicts: boolean[] = [];
			for (let i = 0; i < keep.length; i += 100) {
				const batch = keep.slice(i, i + 100);
				judgeJob.tick(i);
				const { system, user } = buildRelevancePrompt(batch, `These are exchanges from the mail folder "${folderName}".`);
				try {
					verdicts.push(...parseRelevance(await this.claude({ system, user }, 2000, undefined, "mail"), batch.length));
				} catch (e) {
					console.warn("Power Assistant: relevance pass failed for one batch; keeping it.", e);
					verdicts.push(...batch.map(() => true));
				}
			}
			judgeJob.done(`judged ${keep.length} exchanges`);
			surviving = keep.filter((t, i) => {
				if (verdicts[i] === false) rejected.push({ id: t.id, subject: t.latest.subject, from: t.latest.from, reason: "the AI relevance pass judged it not worth keeping" });
				return verdicts[i] !== false;
			});
		}

		const today = dayOf(new Date());
		const known = this.knownConversations();
		const folder = `${base}/${safeName(folderName)}`;
		await this.ensureFolder(folder);
		let written = 0;
		let updated = 0;
		const writeJob = this.startJob(`Importing ${folderName}`, surviving.length);
		for (const [n, t] of surviving.entries()) {
			const body = buildThreadNote(t, { folder: folderName, today });
			const existing = known.get(t.id);
			if (existing) {
				await this.app.vault.modify(existing, body);
				updated++;
			} else {
				const path = normalizePath(`${folder}/${threadNoteName(t)}.md`);
				if (!this.app.vault.getAbstractFileByPath(path)) {
					await this.app.vault.create(path, body);
					written++;
				}
			}
			writeJob.tick(n + 1);
		}
		writeJob.done(`imported ${written} new, updated ${updated}`);
		await this.writeGenerated(
			`${this.settings.outputFolder}/Mail`,
			`Import ${safeName(folderName)} ${today}`,
			buildImportReport(surviving, rejected, { folder: folderName, today, scanned: mail.length, collapsed: threads.length }),
			true
		);
		new Notice(`Power Assistant: imported ${written} new, updated ${updated}, skipped ${rejected.length}.`, 9000);
	}

	/* ---- rolling mail window: recent email, searchable by Ask ---- */

	private mailIndex = new SearchIndex();
	private mailMeta = new Map<string, MailMeta>();
	private mailDates = new Map<string, string>();
	private mailWindowLoaded = false;
	private mailRefreshing = false;

	private mailWindowPath(): string {
		return `${this.manifest.dir}/mail-window.json`;
	}

	/** Load the persisted window and rebuild its index. The corpus lives in the
	 *  plugin's own folder, never synced: it is derived from the mailbox and can
	 *  be rebuilt at any time, so syncing it would only manufacture conflicts. */
	private async loadMailWindow(): Promise<void> {
		if (this.mailWindowLoaded) return;
		this.mailWindowLoaded = true;
		try {
			const raw = await this.app.vault.adapter.read(this.mailWindowPath());
			const docs = JSON.parse(raw) as MailDoc[];
			for (const d of docs) this.addMailDoc(d);
		} catch {
			/* no window yet; it builds on first refresh */
		}
	}

	private addMailDoc(d: MailDoc): void {
		const chunk = chunkMailForIndex(d);
		if (!chunk) return;
		this.mailIndex.addFile(mailHitPath(d.id), [chunk]);
		this.mailMeta.set(d.id, { from: d.from, subject: d.subject, date: d.date, webLink: d.webLink });
		this.mailDates.set(d.id, isoDate(d.date));
		this.mailCorpus.set(d.id, d);
	}

	/** The corpus behind the index, kept so the window can be persisted and
	 *  pruned without re-fetching. */
	private mailCorpus = new Map<string, MailDoc>();

	private removeMailDoc(id: string): void {
		this.mailIndex.removeFile(mailHitPath(id));
		this.mailMeta.delete(id);
		this.mailDates.delete(id);
		this.mailCorpus.delete(id);
	}

	private async persistMailWindow(): Promise<void> {
		try {
			await this.app.vault.adapter.write(this.mailWindowPath(), JSON.stringify([...this.mailCorpus.values()]));
		} catch (e) {
			console.warn("Power Assistant: could not persist the mail window.", e);
		}
	}

	/** Power Desk's recent-mail feed, when it is installed and current. Same
	 *  config-borrowing convention as the transaction handoff. */
	private mailFeed(): ((sinceMs: number) => Promise<MailDoc[]>) | null {
		// Power Desk hangs these on the plugin instance, like sendPageMail, not
		// under an api object; probe both ids and feature-detect, as with the
		// transaction and meeting handoffs
		const plugs = (this.app as unknown as { plugins?: { plugins?: Record<string, { mailForIndex?: (sinceMs: number) => Promise<MailDoc[]> }> } }).plugins?.plugins;
		const pd = plugs?.["powerdesk"] ?? plugs?.["powercalendar"];
		return typeof pd?.mailForIndex === "function" ? pd.mailForIndex.bind(pd) : null;
	}

	/** Whether the rolling mail window is switched on and Power Desk can feed it. */
	mailWindowEnabled(): boolean {
		return this.settings.mailWindowDays > 0 && !!this.mailFeed();
	}

	/** Whether Power Desk can feed the window, for the settings page. */
	mailFeedAvailable(): boolean {
		return !!this.mailFeed();
	}

	/** A one-line state summary for the settings page. */
	mailWindowSummary(): string {
		const oldest = this.mailDates.size ? [...this.mailDates.values()].filter(Boolean).sort()[0] ?? null : null;
		return mailWindowStats(this.mailMeta.size, this.settings.mailWindowDays, oldest);
	}

	/** Pull recent mail from Power Desk, add what is new and in-window, drop what
	 *  has aged out, and persist. Safe to call on a timer: it only pays for the
	 *  delta each time. */
	async refreshMailWindow(): Promise<number> {
		if (this.mailRefreshing || !this.mailWindowEnabled()) return 0;
		const feed = this.mailFeed();
		if (!feed) return 0;
		this.mailRefreshing = true;
		try {
			await this.loadMailWindow();
			const days = this.settings.mailWindowDays;
			const sinceMs = Date.now() - days * 86400000;
			const incoming = await feed(sinceMs);
			const today = dayOf(new Date());
			const { add, drop } = planWindowUpdate(incoming, new Set(this.mailMeta.keys()), this.mailDates, today, days);
			for (const id of drop) this.removeMailDoc(id);
			for (const d of add) this.addMailDoc(d);
			if (add.length || drop.length) await this.persistMailWindow();
			return add.length;
		} catch (e) {
			console.warn("Power Assistant: mail window refresh failed.", e);
			return 0;
		} finally {
			this.mailRefreshing = false;
		}
	}

	/** Mail hits for a query, as note-shaped hits with synthetic email: paths.
	 *  Ask merges these with note hits; the path prefix lets the answer layer
	 *  render a mail citation that links back to Outlook. */
	mailHits(terms: string[], k: number): { path: string; heading: string; text: string }[] {
		if (!this.mailMeta.size) return [];
		return this.mailIndex.search(terms, k).map((h) => ({ path: h.path, heading: h.heading, text: h.text }));
	}

	/* ---- transactions: order mail into line-item notes ---- */

	/** Order ids already in the vault. Read from the metadata cache rather than
	 *  a stored list, so notes deleted by hand stop counting as captured and a
	 *  vault synced from another device is understood on sight. */
	private knownOrderIds(): Set<string> {
		const out = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as { type?: unknown; "order-id"?: unknown } | undefined;
			if (fm?.type !== "capture-txn-order") continue;
			const id = String(fm["order-id"] ?? "").trim();
			if (id) out.add(id);
		}
		return out;
	}

	/** Write one transaction note. Unlike writeGenerated these are user-facing
	 *  records, so an existing note is only replaced when this same order is
	 *  being re-captured; anything else is left alone rather than clobbered. */
	private async writeTxnNote(folder: string, name: string, body: string, update: boolean): Promise<void> {
		await this.ensureFolder(folder);
		const path = normalizePath(`${folder}/${name}.md`);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			if (update) await this.app.vault.modify(existing, body);
			return;
		}
		await this.app.vault.create(path, body);
	}

	/** Turn one message into order and line-item notes.
	 *
	 *  The AI proposes; the vendor's own printed subtotal disposes. Anything
	 *  that fails settleOrder is still written, but flagged review: true with
	 *  the reason stated, because a silently dropped order is worse than a
	 *  visible questionable one. Returns how many orders were captured. */
	async captureTransactionMail(mail: TxnMail & { html?: string; text?: string; webLink?: string; attachments?: string[] }, rule?: TxnRule | null): Promise<number> {
		if (!this.settings.txnFolder.trim()) return 0;
		if (!this.llmReady()) {
			new Notice("Power Assistant: " + this.llmMissingMsg());
			return 0;
		}
		let body = mail.html ? emailToExtractionText(mail.html) : (mail.text ?? "").slice(0, 12000);
		// An invoice often lives in an attached PDF while the message body says
		// only "your invoice is attached", so the attachment's text is appended
		// rather than replacing the body: between them one carries the numbers.
		for (const path of mail.attachments ?? []) {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) continue;
			try {
				const text = (await this.extractDocText(f)).trim();
				if (text) body = `${body}\n\n--- attachment: ${f.name} ---\n${text}`.slice(0, 16000);
			} catch (e) {
				console.warn(`Power Assistant: could not read attachment ${path}.`, e);
			}
		}
		if (!body.trim()) return 0;
		const matched = rule !== undefined ? rule : resolveTxnRule(this.settings.txnRules, mail);

		const { system, user } = buildTxnExtractionPrompt(body, { from: mail.from, subject: mail.subject, date: mail.date });
		let orders;
		try {
			orders = parseTxnExtraction(await this.claude({ system, user }, 2000, undefined, "txn"));
		} catch (e) {
			console.warn("Power Assistant: transaction extraction failed.", e);
			new Notice("Power Assistant: could not read that order mail.");
			return 0;
		}
		if (!orders?.length) {
			new Notice(`Power Assistant: no orders found in "${mail.subject}".`);
			return 0;
		}

		const today = dayOf(new Date());
		const known = this.knownOrderIds();
		const base = this.settings.txnFolder.trim();
		let flagged = 0;
		for (const raw of orders) {
			const { order, recon, repaired } = settleOrder(applyTxnRule(raw, matched));
			if (!recon.ok) flagged++;
			const folder = matched?.folder?.trim() || base;
			for (const w of planOrderWrites(order, folder, { today, sourceUrl: mail.webLink, recon, repaired }, known))
				await this.writeTxnNote(w.folder, w.name, w.body, w.update);
		}
		this.settings.txnSeen = rememberProcessed(this.settings.txnSeen, mail.id);
		await this.saveSettings();
		const n = orders.length;
		new Notice(
			flagged
				? `Power Assistant: captured ${n} order${n === 1 ? "" : "s"}, ${flagged} needing review.`
				: `Power Assistant: captured ${n} order${n === 1 ? "" : "s"}.`,
			flagged ? 8000 : 4000
		);
		return n;
	}

	/** Write the orders and items an already-parsed source produced. Shared by
	 *  mail capture and CSV backfill so both land identically. */
	private async writeOrders(orders: TxnOrder[], opts: { sourceUrl?: string; sourcePath?: string }): Promise<{ written: number; flagged: number }> {
		const today = dayOf(new Date());
		const known = this.knownOrderIds();
		const base = this.settings.txnFolder.trim();
		let flagged = 0;
		for (const raw of orders) {
			const { order, recon, repaired } = settleOrder(raw);
			if (!recon.ok) flagged++;
			for (const w of planOrderWrites(order, base, { today, ...opts, recon, repaired }, known)) await this.writeTxnNote(w.folder, w.name, w.body, w.update);
			if (order.orderId) known.add(order.orderId);
		}
		return { written: orders.length, flagged };
	}

	/** Import an Amazon "Request My Data" retail export. This is the sanctioned
	 *  route to order history: no scraping and no stored credentials, and the
	 *  file is already line-item grained. */
	async importAmazonCsv(file: TFile): Promise<void> {
		if (!this.settings.txnFolder.trim()) {
			new Notice("Power Assistant: set a transactions folder first.");
			return;
		}
		const orders = parseAmazonOrderCsv(await this.app.vault.read(file));
		if (!orders.length) {
			new Notice("Power Assistant: no orders found. Point this at Retail.OrderHistory.csv from your Amazon data export.", 8000);
			return;
		}
		new Notice(`Power Assistant: importing ${orders.length} orders…`);
		const { flagged } = await this.writeOrders(orders, { sourcePath: file.path });
		new Notice(`Power Assistant: imported ${orders.length} orders${flagged ? `, ${flagged} needing review` : ""}. Run "Categorize uncategorized purchases" to sort them.`, 9000);
	}

	/** Every captured line item, as the rollup sees it. */
	private spendItems(): SpendItem[] {
		const out: SpendItem[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (fm?.type !== "capture-txn-item") continue;
			const eff = typeof fm.effective === "number" ? fm.effective : typeof fm.amount === "number" ? fm.amount : 0;
			out.push({
				path: f.path,
				vendor: String(fm.vendor ?? ""),
				date: String(fm.date ?? "").slice(0, 10),
				category: String(fm.category ?? "other"),
				scope: String(fm.scope ?? "personal"),
				currency: String(fm.currency ?? "USD"),
				effective: eff,
				review: fm.review === true,
			});
		}
		return out;
	}

	/** The spending rollup as a generated note. */
	async spendRollup(scope = "personal", open = true): Promise<void> {
		const items = this.spendItems();
		if (!items.length) {
			new Notice("Power Assistant: no line items captured yet. Run \"Scan mail for orders and bills now\" from Power Desk.", 8000);
			return;
		}
		const today = dayOf(new Date());
		await this.writeGenerated(`${this.settings.outputFolder}/Spending`, `Spending (${scope})`, buildSpendRollup(items, today, scope), open);
	}

	/** Sort anything still sitting in "other" into the taxonomy, in one batch
	 *  per hundred items so a large backfill stays a handful of AI calls. */
	async categorizeBacklog(): Promise<void> {
		if (!this.llmReady()) {
			new Notice("Power Assistant: " + this.llmMissingMsg());
			return;
		}
		const pending: { file: TFile; name: string }[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (fm?.type !== "capture-txn-item" || String(fm.category ?? "other") !== "other") continue;
			pending.push({ file: f, name: String(fm.item ?? f.basename) });
		}
		if (!pending.length) {
			new Notice("Power Assistant: everything is already categorized.");
			return;
		}
		const catJob = this.startJob("Categorizing purchases", pending.length);
		let done = 0;
		for (let i = 0; i < pending.length; i += 100) {
			const batch = pending.slice(i, i + 100);
			catJob.tick(i);
			const { system, user } = buildCategorizePrompt(batch.map((b) => b.name));
			let cats: string[];
			try {
				cats = parseCategorized(await this.claude({ system, user }, 2000, undefined, "txn"), batch.length);
			} catch (e) {
				console.warn("Power Assistant: categorizing failed for one batch.", e);
				continue;
			}
			for (let k = 0; k < batch.length; k++) {
				if (cats[k] === "other") continue;
				await this.app.fileManager.processFrontMatter(batch[k].file, (fm: Record<string, unknown>) => {
					fm.category = cats[k];
				});
				done++;
			}
		}
		catJob.done(`categorized ${done} of ${pending.length} purchases`);
	}

	/** A base over the captured transactions: category, month, and vendor views
	 *  plus a review queue, and a chart when Power Bases is installed. */
	async createTransactionsBase(): Promise<void> {
		const path = normalizePath(`${this.settings.outputFolder}/Spending.base`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice("Power Assistant: Spending.base already exists.");
			return;
		}
		await this.ensureFolder(this.settings.outputFolder);
		await this.app.vault.create(path, buildTxnBase(this.powerBasesReady()));
		this.baseCreatedNotice("Spending.base");
	}

	/** Whether Power Bases is installed. Its view types and per-value coloring
	 *  only render there, so a base written into a vault without it has to fall
	 *  back to core's own table or it opens as an unrenderable view. */
	private powerBasesReady(): boolean {
		return !!(this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.powerbases;
	}

	/* ---------- last-edited stamp ----------
	 * Power Editor draws this line too, and two plugins stamping one title would
	 * show the date twice. Power Editor owns it wherever it is installed: it is
	 * the plugin about how a note looks, and its version of the setting is the
	 * older one, so a vault running both keeps the settings it already tuned.
	 * Here it is the same feature for a vault that only has this plugin. */

	/** Whether WE are the one drawing the stamp. False while Power Editor is
	 *  installed, whatever it is itself set to: the choice belongs to one plugin
	 *  at a time, and switching owners on its "off" would put a stamp back that
	 *  someone had just turned off over there. */
	editedStampMine(): boolean {
		return !(this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins?.powereditor;
	}

	/** The stamp's text for the chosen format. Clicking it adds the exact date
	 *  to whatever the setting says, so a glanceable "3 minutes ago" can be
	 *  pinned down without changing the setting. */
	private editedText(when: number, expanded: boolean): string {
		const label = this.settings.showEdited === "bare" ? "" : "Edited ";
		const mode = expanded ? "both" : this.settings.editedFormat;
		const rel = relativeEdited(when, Date.now());
		const abs = absoluteEdited(when);
		if (mode === "exact") return label + abs;
		if (mode === "both") return `${label}${rel} · ${abs}`;
		return label + rel;
	}

	/** Notes whose stamp the reader clicked to expand, by path. Session-only: a
	 *  preference for one glance, not something worth writing to disk. */
	private editedExpanded = new Set<string>();

	/** Draws (or clears) the stamp on one markdown view. The title copy sits
	 *  next to .inline-title so a cover image moves it too; the bottom copy goes
	 *  in .cm-sizer, where Obsidian puts in-document backlinks, so it scrolls
	 *  with the note and CodeMirror keeps ownership of the content itself. */
	private applyEditedStamp(view: MarkdownView) {
		const file = view.file;
		const when = file ? editedAt(this.app.metadataCache.getFileCache(file)?.frontmatter, file.stat?.mtime ?? 0) : 0;
		const on = this.settings.showEdited !== "off" && this.editedStampMine() && !!file && !!when;
		const pos = this.settings.editedPosition;
		const wantTitle = on && (pos === "title" || pos === "rule" || pos === "both");
		const wantBottom = on && (pos === "bottom" || pos === "both");
		const expanded = !!file && this.editedExpanded.has(file.path);
		const text = on ? this.editedText(when, expanded) : "";
		const exact = on ? absoluteEdited(when) : "";
		// Whatever the note opens with brings its own top spacing, and a heading
		// brings a great deal of it while a paragraph brings none. One gap under
		// the stamp therefore cannot serve both: it reads as adrift over a
		// heading and as cramped over prose. The section list says which it is
		// (frontmatter is a section too, so it is skipped).
		const opensOnHeading =
			(file ? this.app.metadataCache.getFileCache(file)?.sections : undefined)?.find((s) => s.type !== "yaml")?.type === "heading";

		const place = (host: HTMLElement, where: "title" | "bottom", anchor: Element | null, wanted: boolean) => {
			let el = host.querySelector(`:scope > .ptc-edited.is-${where}`) as HTMLElement | null;
			if (!wanted) {
				el?.remove();
				return;
			}
			if (!el) {
				el = createDiv({ cls: `ptc-edited is-${where}` });
				if (anchor) anchor.insertAdjacentElement("afterend", el);
				else host.appendChild(el);
				el.onclick = () => {
					if (!file) return;
					if (this.editedExpanded.has(file.path)) this.editedExpanded.delete(file.path);
					else this.editedExpanded.add(file.path);
					this.refreshEditedStamps();
				};
			} else if (!anchor && el !== host.lastElementChild) {
				host.appendChild(el); // stay last as the note grows
			}
			// set every pass, not just on create: the stamp outlives a change of
			// these settings, so the old look has to come back off it
			el.toggleClass("is-rule", where === "title" && pos === "rule");
			el.toggleClass("is-tight", where === "title" && opensOnHeading);
			el.setText(text);
			el.setAttribute("aria-label", exact);
			el.setAttribute("title", exact);
		};

		for (const titleEl of Array.from(view.containerEl.querySelectorAll(".inline-title"))) {
			if (titleEl.parentElement) place(titleEl.parentElement, "title", titleEl, wantTitle);
		}
		// .cm-sizer is editing view; .markdown-preview-sizer is reading view
		for (const sizer of Array.from(view.containerEl.querySelectorAll(".cm-sizer, .markdown-preview-sizer"))) {
			place(sizer as HTMLElement, "bottom", null, wantBottom);
		}
	}

	/** Re-time every open note's stamp. Also the cleanup path: it runs with the
	 *  feature off, and off is what removes a stamp already on the page. */
	refreshEditedStamps() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView) this.applyEditedStamp(view);
		}
	}

	/** The views block for a generated base. With Power Bases installed that is
	 *  its richer table plus a calendar; without it, core's plain table, which is
	 *  the most any vault can render on its own. */
	private baseViews(name: string, order: string[], colorProp: string, calendar: { name: string; dateProp: string }): string[] {
		const pb = this.powerBasesReady();
		const out = ["views:", `  - type: ${pb ? "powerbases-table" : "table"}`, `    name: ${name}`, "    order:"];
		for (const o of order) out.push(`      - ${o}`);
		if (pb) {
			out.push(`    color:${colorProp}: value`);
			out.push("  - type: powerbases-calendar", `    name: ${calendar.name}`, `    dateProp: ${calendar.dateProp}`);
		}
		return out;
	}

	/** Says what was written, and why it is plainer than advertised when Power
	 *  Bases is not installed: silently producing a base missing its calendar
	 *  would just look broken. */
	private baseCreatedNotice(file: string) {
		new Notice(
			this.powerBasesReady()
				? `Power Assistant: ${file} created in the output folder.`
				: `Power Assistant: ${file} created in the output folder, as a plain table. Install Power Bases for the calendar view and per-value colors.`,
			this.powerBasesReady() ? 5000 : 10000
		);
	}

	/** A base over the processed documents: a sortable table and (with Power
	 *  Bases) a calendar of due dates, so bills and receipts are filterable. */
	async createFinancesBase() {
		const path = normalizePath(`${this.settings.outputFolder}/Finances.base`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice("Power Assistant: Finances.base already exists.");
			return;
		}
		const yaml = [
			"filters:",
			"  and:",
			'    - note.type == "capture-doc"',
			...this.baseViews(
				"Documents",
				["file.name", "vendor", "doc-type", "amount", "currency", "date", "due"],
				"note.doc-type",
				{ name: "Due dates", dateProp: "note.due" }
			),
			"",
		].join("\n");
		await this.ensureFolder(this.settings.outputFolder);
		await this.app.vault.create(path, yaml);
		this.baseCreatedNotice("Finances.base");
	}

	async createMeetingsBase() {
		const path = normalizePath(`${this.settings.outputFolder}/Meetings.base`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice("Power Assistant: Meetings.base already exists.");
			return;
		}
		const yaml = [
			"filters:",
			"  and:",
			'    - note.tags.contains("capture")',
			'    - note.type != "capture-person"',
			'    - note.type != "capture-digest"',
			...this.baseViews(
				"Meetings",
				["file.name", "date", "series", "attendees", "speakers", "cost"],
				"note.series",
				{ name: "Calendar", dateProp: "note.date" }
			),
			"",
		].join("\n");
		await this.ensureFolder(this.settings.outputFolder);
		await this.app.vault.create(path, yaml);
		this.baseCreatedNotice("Meetings.base");
	}

	/** Milliseconds of ACTUAL recording since it started (0 when idle) — paused
	 *  spans are excluded so stamps map to positions in the gapless audio. */
	recElapsedMs(): number {
		if (!this.recStart || !this.recStream) return 0;
		const pausedNow = this.pauseStart ? Date.now() - this.pauseStart : 0;
		return Math.max(0, Date.now() - this.recStart - this.recPausedMs - pausedNow);
	}

	/** Pause or resume the in-progress recording. MediaRecorder stops emitting
	 *  data while paused, so the saved audio has no gap; we track the paused
	 *  time only to keep elapsed-based stamps accurate. */
	private togglePause() {
		const rec = this.recorder;
		if (!rec) return;
		if (rec.state === "recording") {
			rec.pause();
			this.pauseStart = Date.now();
			this.ribbon.addClass("ptc-paused");
			this.liveView()?.setStatus("Paused");
			new Notice("Power Assistant: recording paused. Run the command again to resume.");
		} else if (rec.state === "paused") {
			if (this.pauseStart) {
				this.recPausedMs += Date.now() - this.pauseStart;
				this.pauseStart = 0;
			}
			rec.resume();
			this.ribbon.removeClass("ptc-paused");
			this.liveView()?.setStatus("Recording");
			new Notice("Power Assistant: recording resumed.");
		}
	}

	/** Retroactive speaker tagging: reopen the naming dialog on an existing
	 *  capture note, rewrite its transcript labels, talk-share line, and
	 *  attendees in place. The Otter click-a-speaker flow, after the fact. */
	/** Correct a misheard name/word in `file`: replace it everywhere (speaker
	 *  labels, mentions, and, when the term is an attendee, the frontmatter link),
	 *  and optionally remember it for future transcripts. */
	async correctTermIn(file: TFile, prefill: string) {
		new CorrectionModal(this.app, prefill, async (fromRaw, toRaw, remember) => {
			const from = fromRaw.trim();
			const to = toRaw;
			if (!from || from === to.trim()) {
				new Notice("Power Assistant: enter a term and a different replacement.");
				return;
			}
			let count = 0;
			const open = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (open && open.file?.path === file.path) {
				// edit in the open note so scroll position and the transcript's
				// expanded state are kept (rewriting the whole file reloads the view)
				const editor = open.editor;
				const ranges = correctionRanges(editor.getValue(), from);
				count = ranges.length;
				for (let i = ranges.length - 1; i >= 0; i--) editor.replaceRange(to, editor.offsetToPos(ranges[i].start), editor.offsetToPos(ranges[i].end));
			} else {
				await this.app.vault.process(file, (data) => {
					count = countTerm(data, from);
					return count ? applyCorrections(data, [{ from, to }]) : data;
				});
			}
			// a diarization letter may be corrected in THIS note, but never
			// remembered: the next recording's "Speaker A" is a different person
			const remembered = remember && !isSpeakerLetterTerm(from);
			if (remembered) {
				this.settings.corrections = this.settings.corrections.filter((cc) => cc.from !== from);
				this.settings.corrections.push({ from, to });
				await this.saveSettings();
			}
			if (remember && !remembered)
				new Notice(
					`Power Assistant: applied in this note only. "${from}" is a per-recording letter, so a remembered rule would mislabel future transcripts. Click a speaker label in the transcript to name that voice.`,
					10000
				);
			new Notice(
				count
					? `Power Assistant: replaced ${count} occurrence${count === 1 ? "" : "s"} of "${from}"${remembered ? ", and will remember it" : ""}.`
					: `Power Assistant: "${from}" was not found in this note${remember ? "; remembered for future transcripts" : ""}.`
			);
		}).open();
	}

	/** Upgrade an older note's [!quote]- Transcript to the purpose-built
	 *  [!transcript] block, so it picks up the speaker colors and click-to-rename. */
	/** Convert this note's transcript callout to plain, always-editable speaker
	 *  lines. Also upgrades a legacy `[!quote]` callout on the way. */
	async convertTranscriptIn(file: TFile) {
		let changed = false;
		await this.app.vault.process(file, (d) => {
			const n = stripTranscriptCallout(d.replace(/> \[!quote\]([-+]?) Transcript/g, "> [!transcript]$1 Transcript"));
			changed = n !== d;
			return n;
		});
		new Notice(changed ? "Power Assistant: transcript converted to plain, editable lines." : "Power Assistant: this note's transcript is already plain text.");
	}

	/** Convert every capture note's transcript callout to plain lines. */
	async convertAllTranscripts() {
		let count = 0;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!isCaptureNote(fm as Record<string, unknown> | undefined)) continue;
			let hit = false;
			await this.app.vault.process(file, (d) => {
				const n = stripTranscriptCallout(d.replace(/> \[!quote\]([-+]?) Transcript/g, "> [!transcript]$1 Transcript"));
				hit = n !== d;
				return n;
			});
			if (hit) count++;
		}
		new Notice(`Power Assistant: converted ${count} transcript${count === 1 ? "" : "s"} to plain text.`);
	}

	/** A speaker's color: the user's override if set, else the automatic one. */
	speakerColorFor(name: string): string {
		return this.settings.speakerColors[name] || speakerColor(name);
	}

	/** A speaker's saved emoji (or empty). */
	emojiFor(name: string): string {
		return this.settings.speakerEmoji[name] || "";
	}

	private restyle(scope: HTMLElement, name: string) {
		restyleSpeaker(scope, name, this.speakerColorFor(name), this.emojiFor(name));
		this.refreshTranscriptStyling();
	}

	/** Nudge every open Live Preview editor to restyle its transcript, so a color
	 *  or emoji change shows immediately in Edit mode instead of on the next edit. */
	private refreshTranscriptStyling() {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			cm?.dispatch({ effects: refreshTranscriptEffect.of(null) });
		}
	}

	/** The menu that opens when a speaker's name or avatar is clicked. */
	/** Resolve the audio embed's total length in the active editor (Edit mode),
	 *  where the reading-view post-processor never runs. Idempotent per audio
	 *  element, so the brief observer that catches a late-loading embed is safe. */
	scanActiveAudio() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			this.refreshPlayer();
			return;
		}
		const root = view.containerEl;
		fixAudioDurations(root);
		this.refreshPlayer();
		const obs = new MutationObserver(() => {
			fixAudioDurations(root);
			this.refreshPlayer();
		});
		obs.observe(root, { childList: true, subtree: true });
		window.setTimeout(() => obs.disconnect(), 6000); // embeds load fast; never watch forever
	}

	private player: TranscriptPlayer | null = null;

	/** Resolve the audio file a capture note embeds (from its `![[…]]` link),
	 *  regardless of whether that embed has rendered yet. */
	private noteAudioFile(view: MarkdownView): TFile | null {
		if (!view.file) return null;
		const m = /!\[\[([^\]|]+\.(?:webm|m4a|mp3|wav|ogg|flac|mp4))(?:\|[^\]]*)?\]\]/i.exec(view.editor?.getValue() ?? "");
		if (!m) return null;
		const f = this.app.metadataCache.getFirstLinkpathDest(m[1], view.file.path);
		return f instanceof TFile ? f : null;
	}

	/** Every video file a note embeds, in document order.
	 *
	 *  A rotated recording embeds one player per part, and a stamp belongs to
	 *  exactly one of them, so the whole list is needed rather than the first
	 *  match: `partForStamp` says which. */
	private noteVideoFiles(view: MarkdownView): TFile[] {
		if (!view.file) return [];
		const out: TFile[] = [];
		const re = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(view.editor?.getValue() ?? ""))) {
			if (!VIDEO_EXTS.has((m[1].split(".").pop() ?? "").toLowerCase())) continue;
			const f = this.app.metadataCache.getFirstLinkpathDest(m[1], view.file.path);
			if (f instanceof TFile) out.push(f);
		}
		return out;
	}

	/** Scan a video for the moments its picture changed, save those frames into
	 *  the vault, and hand back what the "## Screens" section needs.
	 *
	 *  `url` is anything the element can load, which is deliberately wider than
	 *  the vault: a Teams recording is hundreds of megabytes and belongs in
	 *  Downloads, so the caller can hand over a blob URL for a file that is never
	 *  imported and only the frames land in the vault.
	 *
	 *  Nothing is written until the scan has finished picking, so stopping it
	 *  leaves no half-set of images in the vault. Saving is not itself
	 *  interruptible: it is a dozen frames and a couple of seconds, and a stop
	 *  part-way through it would orphan the files already written. */
	async framesFromVideo(
		url: string,
		notePath: string,
		noteBase: string,
		opts: { everyMs: number; threshold: number; max: number; captions: boolean; moments?: Moment[] }
	): Promise<{ frames: Frame[]; stopped: boolean }> {
		const progress = new Notice("Power Assistant: scanning the recording…", 0);
		// a scan of an hour of video runs for about a minute, which is long enough
		// that starting one by accident must be undoable: the thing telling you it
		// is running is the thing that stops it, the same gesture as the queue count
		let cancelled = false;
		progress.noticeEl.style.cursor = "pointer";
		progress.noticeEl.addEventListener("click", () => {
			cancelled = true;
			progress.setMessage("Power Assistant: stopping the scan…");
		});
		// reading each frame needs a model; twelve calls that each fail for the
		// same missing key is worse than saying so once and keeping the pictures
		const captions = opts.captions && this.llmReady();
		if (opts.captions && !captions) new Notice("Power Assistant: no AI model is configured, so the screens are saved as pictures without being read.", 9000);
		const el = await openVideo(url);
		try {
			const samples = await scanScenes(el, opts.everyMs, opts.threshold, (at, of, hits) => {
				progress.setMessage(`Power Assistant: scanning the recording, ${fmtTime(at)} of ${fmtTime(of)} (${hits} screen${hits === 1 ? "" : "s"} so far). Click to stop.`);
				return !cancelled;
			});
			// a stop is a stop: the frames are not written, and the caller says so
			// rather than reporting the empty result as "nothing changed"
			if (cancelled) return { frames: [], stopped: true };
			const scenes = pickSceneFrames(samples, opts.threshold, opts.max);
			// a mark is someone saying "this bit matters", which beats any pixel
			// measurement, so marks join the list whatever the scan thought
			const picked = withMomentFrames(scenes, opts.moments ?? []);
			const over = samples.filter((s) => s.diff > opts.threshold).length;
			// a cap that dropped real screens must say so: silently keeping 12 of 40
			// reads as "this recording had 12 screens", which is a different claim
			if (over > scenes.length) new Notice(`Power Assistant: ${over} screens changed, keeping the ${scenes.length} biggest (raise the maximum in settings to keep more).`, 9000);
			if (picked.length > scenes.length) new Notice(`Power Assistant: also grabbing ${picked.length - scenes.length} frame(s) at the moments you marked.`, 7000);
			const frames: Frame[] = [];
			for (const [i, ms] of picked.entries()) {
				progress.setMessage(`Power Assistant: saving screen ${i + 1} of ${picked.length}…`);
				await seekVideo(el, ms / 1000);
				const { bytes, mime } = await frameBytes(el, FRAME_MAX_WIDTH);
				const dest = await this.app.fileManager.getAvailablePathForAttachment(frameFileName(noteBase, ms / 1000), notePath);
				const saved = await this.app.vault.createBinary(dest, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
				let text = "";
				if (captions) {
					progress.setMessage(`Power Assistant: reading screen ${i + 1} of ${picked.length}…`);
					try {
						text = await this.claudeVision(bytes, mime, "screens", "screen");
					} catch (e) {
						// one unreadable frame must not lose the whole scan
						console.error("Power Assistant:", e);
					}
				}
				frames.push({ ms, link: saved.path, text });
			}
			return { frames, stopped: false };
		} finally {
			cancelled = true;
			closeVideo(el);
			progress.hide();
		}
	}

	/** Scan a recording for its screens and write them into `note`.
	 *
	 *  A picked file is loaded through a blob URL, so a 400 MB Teams recording in
	 *  Downloads is read where it sits and never copied into the vault. The URL is
	 *  revoked afterwards whatever happens, or the file stays in memory for as
	 *  long as Obsidian runs. */
	async addScreens(note: TFile, picked: File | null, embedded: TFile | null, opts: { everyMs: number; threshold: number; max: number; captions: boolean }) {
		const url = picked ? URL.createObjectURL(picked) : embedded ? this.app.vault.getResourcePath(embedded) : "";
		if (!url) return;
		try {
			// the note's own marks are grab points too, read from the section it
			// already carries so this works on a note recorded long before now
			const moments = momentsFromNote(await this.app.vault.cachedRead(note));
			const { frames, stopped } = await this.framesFromVideo(url, note.path, note.basename, { ...opts, moments });
			if (stopped) {
				new Notice("Power Assistant: the scan was stopped, so no screens were added.", 7000);
				return;
			}
			if (!frames.length) {
				new Notice("Power Assistant: nothing in that recording changed enough to keep. Lower the change threshold to keep more.", 9000);
				return;
			}
			// the manifest first: it is what lets a later re-extract put these same
			// frames back beside the new body instead of losing them with the old one
			await this.app.fileManager.processFrontMatter(note, (f: Record<string, unknown>) => {
				f["pa-screens"] = JSON.stringify(frames);
			});
			let placed = 0;
			await this.rewriteNote(note, (md) => {
				const shown = illustrateNote(md, frames);
				placed = frames.length - shown.unused.length;
				return withScreensSection(shown.md, formatScreens(shown.unused));
			});
			const beside = placed ? `, ${placed} beside the point ${placed === 1 ? "it shows" : "they show"}` : "";
			new Notice(`Power Assistant: ${frames.length} screen${frames.length === 1 ? "" : "s"} added to ${note.basename}${beside}.`, 7000);
		} catch (e) {
			new Notice("Power Assistant: " + (e instanceof Error ? e.message : String(e)), 12_000);
		} finally {
			if (picked) URL.revokeObjectURL(url);
		}
	}

	/** Save one frame from the note's video at the stamp under the cursor, and
	 *  write it into the note just below that line.
	 *
	 *  This is the smallest useful shape of "the recap had screenshots": you are
	 *  reading a turn, the shared screen is what the turn is about, and one
	 *  command puts that screen in the note beside the words. The frame carries
	 *  its own stamp, so it is also a jump back to the moment it came from. */
	async grabFrameAtStamp(view: MarkdownView) {
		const editor = view.editor;
		if (!view.file || !editor) return;
		const cur = editor.getCursor();
		const secs = stampSecsOnLine(editor.getLine(cur.line), cur.ch);
		if (secs == null) {
			new Notice("Power Assistant: put the cursor on a line with a [m:ss] stamp (a transcript turn, or a moment) first.", 8000);
			return;
		}
		const videos = this.noteVideoFiles(view);
		if (!videos.length) {
			new Notice("Power Assistant: this note embeds no video to grab a frame from. Add the recording as an embed first.", 8000);
			return;
		}
		const fm = this.app.metadataCache.getFileCache(view.file)?.frontmatter;
		const partsMs = Array.isArray(fm?.parts) ? (fm.parts as unknown[]).map(Number) : [0];
		const { index, secondsInPart } = partForStamp(partsMs.length ? partsMs : [0], secs);
		const file = videos[Math.min(index, videos.length - 1)];
		const stamp = fmtTime(Math.round(secs) * 1000);
		const lineText = editor.getLine(cur.line);
		const working = new Notice(`Power Assistant: grabbing the frame at ${stamp}…`, 0);
		try {
			const { bytes } = await grabVideoFrame(this.app.vault.getResourcePath(file), secondsInPart, FRAME_MAX_WIDTH);
			const dest = await this.app.fileManager.getAvailablePathForAttachment(frameFileName(view.file.basename, secs), view.file.path);
			const saved = await this.app.vault.createBinary(dest, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
			// decoding takes about a second, and an edit elsewhere in that second
			// shifts every line below it, so the target is re-found by its own text
			// rather than trusting a line number from before the await
			const line = findLine(editor, cur.line, lineText);
			editor.replaceRange(`\n${frameEmbedLine(secs, saved.path)}`, { line, ch: editor.getLine(line).length });
			new Notice(`Power Assistant: frame at ${stamp} added.`);
		} catch (e) {
			new Notice("Power Assistant: " + (e instanceof Error ? e.message : String(e)), 10_000);
		} finally {
			working.hide();
		}
	}

	/** Show the sticky transcript player for the active capture note, and tear it
	 *  down when you move to another note. Driven by the note's audio file, so it
	 *  is ready immediately — no need to scroll the embed into view. */
	refreshPlayer() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const fm = view?.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter : undefined;
		const file = view && isCaptureNote(fm as Record<string, unknown> | undefined) ? this.noteAudioFile(view) : null;
		if (!view || !file) {
			this.player?.destroy();
			this.player = null;
			return;
		}
		if (this.player?.isFor(view, file)) return;
		this.player?.destroy();
		this.player = new TranscriptPlayer(this, view, file);
	}

	/** Resolve the total duration for a capture note's audio embed. The embed
	 *  loads after the post-processor runs, so watch for it and fix it once it
	 *  appears; the observer is tied to the rendered section and self-stops. */
	watchAudioDurations(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		fixAudioDurations(el);
		if (el.querySelector("audio, video")) return;
		const obs = new MutationObserver(() => {
			if (el.querySelector("audio, video")) {
				fixAudioDurations(el);
				obs.disconnect();
			}
		});
		obs.observe(el, { childList: true, subtree: true });
		const child = new MarkdownRenderChild(el);
		child.register(() => obs.disconnect());
		ctx.addChild(child);
		window.setTimeout(() => obs.disconnect(), 8000); // never watch forever
	}

	/** Open the speaker menu from a click on a Live Preview avatar, resolving the
	 *  file and scope from the active editor — plus which LINE was clicked, so
	 *  the menu can act on that one turn. */
	openSpeakerMenuFromEditor(name: string, evt: MouseEvent) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) return;
		let turn: { stampSecs: number | null; ref: TurnRef } | undefined;
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (cm && evt.target instanceof Node) {
			try {
				const line = cm.state.doc.lineAt(cm.posAtDOM(evt.target));
				turn = turnFromLine(line.text) ?? undefined;
			} catch {
				/* the widget could not be located in the doc; the menu still works */
			}
		}
		this.openSpeakerMenu(name, evt, view.file, view.containerEl, turn);
	}

	/** Seek from a timestamp/word click in the editor: drive the sticky player if
	 *  one is up (it owns the audio), else fall back to a rendered <audio> embed. */
	seekFromEditor(secs: number) {
		if (!Number.isFinite(secs)) return;
		this.refreshPlayer(); // make sure the player exists for this note
		if (this.player) {
			this.player.seek(secs);
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const audios = view ? Array.from(view.containerEl.querySelectorAll<HTMLMediaElement>("audio, video")) : [];
		if (!audios.length) {
			new Notice("Power Assistant: the recording is not loaded yet.");
			return;
		}
		const fm = view!.file ? this.app.metadataCache.getFileCache(view!.file)?.frontmatter : undefined;
		const partsMs = Array.isArray(fm?.parts) ? (fm!.parts as unknown[]).map(Number) : [0];
		const { index, secondsInPart } = partForStamp(partsMs.length ? partsMs : [0], secs);
		const audio = audios[Math.min(index, audios.length - 1)];
		for (const other of audios) if (other !== audio) other.pause();
		audio.currentTime = secondsInPart;
		void audio.play();
	}

	/** Estimate the audio time of the word at document position `pos`, by where it
	 *  sits in its turn's spoken text (Alt/Ctrl+click to play from a word). Returns
	 *  null when the position is not inside a timestamped turn. */
	wordTimeAt(view: EditorView, pos: number): number | null {
		const doc = view.state.doc;
		const line = doc.lineAt(pos);
		const sp = parseTranscriptSpeakerLine(line.text);
		if (!sp || sp.stampFrom == null || sp.stampTo == null) return null;
		const start = parseStamp(line.text.slice(sp.stampFrom, sp.stampTo).replace(/[[\]]/g, ""));
		if (start == null) return null;
		// spoken text begins just after the "…]:** " label
		const after = /^:\*\*\s?/.exec(line.text.slice(sp.stampTo));
		const spokenAt = sp.stampTo + (after ? after[0].length : 0);
		// the next timestamped turn (or the section end) bounds this turn's span
		let next = start + 8; // last turn: assume a short tail
		for (let i = line.number + 1; i <= doc.lines; i++) {
			const t = doc.line(i).text;
			if (/^#{1,6}\s/.test(t)) break;
			const s2 = parseTranscriptSpeakerLine(t);
			if (s2 && s2.stampFrom != null && s2.stampTo != null) {
				const ns = parseStamp(t.slice(s2.stampFrom, s2.stampTo).replace(/[[\]]/g, ""));
				if (ns != null && ns > start) {
					next = ns;
					break;
				}
			}
		}
		return interpolatedTime(start, next, pos - line.from - spokenAt, line.length - spokenAt);
	}

	openSpeakerMenu(name: string, evt: MouseEvent, file: TFile, scope: HTMLElement, turn?: { stampSecs: number | null; ref: TurnRef }) {
		const menu = new Menu();
		// per-turn actions first: they act on THIS line, not on the name everywhere
		if (turn?.stampSecs != null) {
			const secs = turn.stampSecs;
			menu.addItem((i) => i.setTitle("Play this turn").setIcon("play").onClick(() => this.seekFromEditor(secs)));
		}
		if (turn) {
			menu.addItem((i) =>
				i
					.setTitle("Move this turn to someone else…")
					.setIcon("arrow-right-left")
					.onClick(() => new ReassignTurnModal(this.app, this, file, turn.ref).open())
			);
		}
		if (/^Speaker /.test(name)) {
			// one-click identities, Otter's suggested-speakers gesture: the AI's
			// guess for THIS letter first, then the note's own attendees, then
			// frequent attendees from earlier meetings
			const seen = new Set<string>();
			const options: { who: string; icon: string }[] = [];
			const offer = (who: string | undefined, icon: string) => {
				const w = who?.trim();
				if (!w || /^Speaker /.test(w) || seen.has(w) || options.length >= 8) return;
				seen.add(w);
				options.push({ who: w, icon });
			};
			offer(this.speakerGuesses[file.path]?.[name], "sparkles");
			const fmAtt = this.app.metadataCache.getFileCache(file)?.frontmatter?.attendees as unknown;
			if (Array.isArray(fmAtt)) for (const a of fmAtt.map(personName)) offer(a, "user");
			for (const a of this.knownAttendees()) offer(a, "user");
			for (const o of options) {
				menu.addItem((i) => i.setTitle(`This is ${o.who}`).setIcon(o.icon).onClick(() => void this.assignSpeakerLabel(file, name, o.who)));
			}
			menu.addItem((i) =>
				i
					.setTitle("This is someone else…")
					.setIcon("user-plus")
					.onClick(() =>
						new TextPromptModal(this.app, `Who is ${name}?`, "Every turn with this letter gets the name.", "", (v) => {
							if (v.trim()) void this.assignSpeakerLabel(file, name, v.trim());
						}).open()
					)
			);
			menu.addItem((i) => i.setTitle("Name all the speakers…").setIcon("users").onClick(() => void this.renameSpeakersIn(file)));
		}
		// a named speaker's rename is a standing correction; a letter is not a
		// name, and its identity is assigned per note by the items above
		if (!/^Speaker /.test(name))
			menu.addItem((i) => i.setTitle(`Rename ${name}…`).setIcon("pencil").onClick(() => void this.correctTermIn(file, name)));
		menu.addItem((i) =>
			i
				.setTitle("Change color…")
				.setIcon("palette")
				.onClick(() =>
					new SpeakerColorModal(this.app, name, this.speakerColorFor(name), (color) => {
						if (color) this.settings.speakerColors[name] = color;
						else delete this.settings.speakerColors[name];
						void this.saveSettings();
						this.restyle(scope, name);
					}).open()
				)
		);
		menu.addItem((i) =>
			i
				.setTitle("Set emoji…")
				.setIcon("smile")
				.onClick(() =>
					new SpeakerEmojiModal(this.app, name, this.emojiFor(name), (emoji) => {
						if (emoji) this.settings.speakerEmoji[name] = emoji;
						else delete this.settings.speakerEmoji[name];
						void this.saveSettings();
						this.restyle(scope, name);
					}).open()
				)
		);
		if (this.settings.speakerColors[name] || this.settings.speakerEmoji[name]) {
			menu.addItem((i) =>
				i.setTitle("Reset to automatic").setIcon("rotate-ccw").onClick(() => {
					delete this.settings.speakerColors[name];
					delete this.settings.speakerEmoji[name];
					void this.saveSettings();
					this.restyle(scope, name);
				})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	async renameSpeakersIn(file: TFile) {
		const md = await this.app.vault.read(file);
		const labels = transcriptSpeakers(md);
		if (!labels.length) {
			new Notice("Power Assistant: no speaker labels found in this note's transcript.");
			return;
		}
		const guesses: Record<string, string> = {};
		for (const l of labels) if (!/^Speaker /.test(l)) guesses[l] = l;
		// the same listen-first help the post-recording dialog gets: clips come
		// from the note's own audio embeds, located by the transcript's stamps
		const noteUtts = transcriptToUtterances(md);
		const offsets = partOffsetsOf(this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined);
		const partFiles: TFile[] = [];
		const embedRe = /!\[\[([^\]|]+\.(?:webm|m4a|mp3|wav|ogg|flac|mp4))(?:\|[^\]]*)?\]\]/gi;
		let em: RegExpExecArray | null;
		while ((em = embedRe.exec(md))) {
			const f = this.app.metadataCache.getFirstLinkpathDest(em[1], file.path);
			if (f instanceof TFile && !partFiles.includes(f)) partFiles.push(f);
		}
		const player = partFiles.length ? new SegmentPlayer(this, partFiles, offsets.length ? offsets : [0]) : null;
		const names = await confirmSpeakerNames(this.app, labels, {
			guesses,
			suggestions: this.knownAttendees(),
			rawLabels: true,
			samples: player ? pickSpeakerSamples(noteUtts) : undefined,
			player,
		});
		const mapping: Record<string, string> = {};
		for (const [from, to] of Object.entries(names)) if (to && to !== from) mapping[from] = to;
		if (!Object.keys(mapping).length) return;
		await this.applySpeakerMapping(file, mapping);
		new Notice("Power Assistant: speakers renamed.");
	}

	/** Apply a label→name mapping across a note: every matching turn label, the
	 *  talk-share line, and the attendees list. The shared engine behind the
	 *  rename dialog and the one-click label menu. */
	private async applySpeakerMapping(file: TFile, mapping: Record<string, string>) {
		await this.app.vault.process(file, (data) => {
			let next = renameSpeakerLabels(data, mapping);
			// the talk-share line names people outside the **Label:** format;
			// same single-pass rule so swaps never collapse
			next = next.replace(/^\*\*Speakers:\*\* .*$/m, (line) => {
				const alternation = Object.keys(mapping)
					.map(escapeRe)
					.sort((a, b) => b.length - a.length)
					.join("|");
				return line.replace(
					new RegExp(`(^\\*\\*Speakers:\\*\\* |, )(${alternation})(?= \\()`, "g"),
					(_m, pre: string, from: string) => pre + (mapping[from] ?? from)
				);
			});
			return next;
		});
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const prev = Array.isArray(fm.attendees)
				? (fm.attendees as unknown[]).map(personName)
				: [];
			const renamed = new Set(Object.keys(mapping));
			const next = [...new Set([...prev.filter((p) => !renamed.has(p)), ...Object.values(mapping)])].filter(
				(n) => n && !/^Speaker /.test(n)
			);
			fm.attendees = next.map((n) => personLink(n, this.peopleFolderPath()));
		});
		// voice identity: naming letters is the enrollment moment (opt-in).
		// The letters' voices were remembered at processing time, possibly on
		// another device, and reached this one through settings sync.
		if (this.settings.voiceIdentity) void this.enrollFromMapping(file.path, mapping);
	}

	/** One lettered voice becomes one person, straight from a click on the
	 *  transcript label — Otter's tag gesture. */
	async assignSpeakerLabel(file: TFile, label: string, to: string) {
		await this.applySpeakerMapping(file, { [label]: to });
		const g = this.speakerGuesses[file.path];
		if (g) delete g[label];
		new Notice(`Power Assistant: ${label} is now ${to}.`);
		this.refreshTranscriptStyling();
	}

	/** Move one transcript turn to `to`: rewrite that line's label, refresh the
	 *  talk-share line, and true up the attendees (the new person joins; the old
	 *  one leaves only when none of their turns remain). */
	async reassignTurnIn(file: TFile, ref: TurnRef, to: string) {
		let changed = false;
		await this.app.vault.process(file, (data) => {
			const r = reassignTranscriptTurn(data, ref, to);
			changed = r.changed;
			return r.changed ? rebuildSpeakersLine(r.md) : data;
		});
		if (!changed) {
			new Notice("Power Assistant: that turn was not found in the note (was it edited since?).");
			return;
		}
		const left = transcriptSpeakers(await this.app.vault.read(file));
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			const prev = Array.isArray(fm.attendees) ? (fm.attendees as unknown[]).map(personName) : [];
			const keep = prev.filter((n) => n !== ref.name || left.includes(ref.name));
			const next = [...new Set([...keep, to])].filter((n) => n && !/^Speaker /.test(n));
			fm.attendees = next.map((n) => personLink(n, this.peopleFolderPath()));
		});
		new Notice(`Power Assistant: the turn now belongs to ${to}.`);
		this.refreshTranscriptStyling();
	}

	/** Per-meeting chat: the whole note fits in context, so no retrieval —
	 *  just the note, the question, and real follow-ups. */
	async openMeetingAsk(file: TFile) {
		if (!this.llmReady()) {
			new Notice("Power Assistant: " + this.llmMissingMsg());
			return;
		}
		const md = await this.app.vault.cachedRead(file);
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as { attendees?: unknown } | undefined;
		const attendees = Array.isArray(fm?.attendees)
			? (fm.attendees as unknown[]).map(personName).filter(Boolean)
			: [];
		new MeetingAskModal(this.app, this, file.basename, md, attendees).open();
	}

	/** True when an AI model is configured (Anthropic key, or a custom endpoint
	 *  with a model name). The gate for every AI-written surface. */
	llmReady(): boolean {
		return llmConfigured(this.settings);
	}

	/** The "set up AI first" clause for the configured provider, ready to sit
	 *  after "Power Assistant: " in a Notice or stand alone in an error. */
	llmMissingMsg(): string {
		return this.settings.llmProvider === "custom"
			? "set the AI endpoint and model in settings first."
			: "set the Anthropic API key in settings first.";
	}

	/** The model id notes and the usage meter report for the active provider. */
	llmModelName(): string {
		return resolveLlmTarget(this.settings).model;
	}

	/** A Messages-API client for the configured provider: Anthropic's cloud, or
	 *  the custom endpoint (Ollama, LM Studio, llama.cpp) speaking the same
	 *  protocol. Every AI call in the plugin goes through this one door. */
	private llmClient(): Anthropic {
		const t = resolveLlmTarget(this.settings);
		return t.baseURL
			? new Anthropic({ apiKey: t.apiKey, baseURL: t.baseURL, dangerouslyAllowBrowser: true })
			: new Anthropic({ apiKey: t.apiKey, dangerouslyAllowBrowser: true });
	}

	/** One multi-turn Claude conversation with the configured model. */
	async claudeChat(
		p: { system: string; messages: { role: "user" | "assistant"; content: string }[] },
		maxTokens: number,
		feature = "chat"
	): Promise<string> {
		const anthropic = this.llmClient();
		const model = this.llmModelName();
		const msg = await anthropic.messages.create({
			model,
			max_tokens: maxTokens,
			system: p.system,
			messages: p.messages,
		});
		this.logLlmUsage(feature, model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
		return msg.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");
	}

	/** Read one image with Claude: the words in it plus a short description of
	 *  what it shows. Slides are mostly charts, diagrams, and screenshots, where
	 *  plain character recognition returns disconnected word soup, so the model
	 *  is asked for the meaning alongside the text. Costs land in the usage
	 *  meter exactly like every other call. */
	async claudeVision(bytes: Uint8Array, mediaType: string, feature = "powerpoint", kind: "slide" | "screen" = "slide"): Promise<string> {
		const anthropic = this.llmClient();
		const model = this.llmModelName();
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		// a frame out of a meeting recording is not a slide: it is whatever was on
		// the shared screen, often an application window, and what matters is which
		// document was being looked at. Asking for a slide reading of it produces
		// descriptions of window chrome.
		const system =
			kind === "screen"
				? "You read frames captured from a screen share during a recorded meeting. Reply with the meaningful text in the image verbatim (headings and body, not window chrome, tabs, or toolbar labels), " +
					"then one short line naming what is being shown. No preamble. If the frame shows no shared content (a camera view, a participant grid, an empty desktop), reply with exactly: (decorative)"
				: "You read images from presentation slides. Reply with the text in the image verbatim, then one short line describing what it shows. " +
					"No preamble. If the image is purely decorative and carries no information, reply with exactly: (decorative)";
		const msg = await anthropic.messages.create({
			model,
			max_tokens: 700,
			system,
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: mediaType as "image/png", data: btoa(binary) } },
						{ type: "text", text: kind === "screen" ? "Read this screen frame." : "Read this slide image." },
					],
				},
			],
		});
		this.logLlmUsage(feature, model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
		const text = msg.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		return /^\(decorative\)$/i.test(text) ? "" : text;
	}

	/** Streamed one-shot generation: calls onDelta with the accumulated text as
	 *  it arrives, and returns the final text. Used for the long-form surfaces
	 *  (assistant chat, the writer) so the answer types out live. */
	async claudeStream(
		p: { system: string; messages: { role: "user" | "assistant"; content: string }[] },
		maxTokens: number,
		onDelta: (text: string) => void,
		feature = "chat"
	): Promise<string> {
		const anthropic = this.llmClient();
		const model = this.llmModelName();
		let text = "";
		// token counts ride the stream itself: input arrives on message_start and
		// the running output total on message_delta, so a streamed answer is
		// metered without a second round trip
		let tokIn = 0;
		let tokOut = 0;
		try {
			const stream = await anthropic.messages.create({
				model,
				max_tokens: maxTokens,
				system: p.system,
				messages: p.messages,
				stream: true,
			});
			for await (const event of stream) {
				const e = event as {
					type: string;
					delta?: { type?: string; text?: string };
					message?: { usage?: { input_tokens?: number } };
					usage?: { output_tokens?: number };
				};
				if (e.type === "message_start") tokIn = e.message?.usage?.input_tokens ?? 0;
				else if (e.type === "message_delta") tokOut = e.usage?.output_tokens ?? tokOut;
				else if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
					text += e.delta.text;
					onDelta(text);
				}
			}
			this.logLlmUsage(feature, model, tokIn, tokOut);
		} catch (e) {
			// streaming unsupported or dropped: a partial answer beats re-billing;
			// otherwise fall back to a single (non-streamed) response. Meter what
			// actually streamed before the drop so the partial is not free.
			console.warn("Power Assistant: streaming failed; using a single response.", e);
			this.logLlmUsage(feature, model, tokIn, tokOut);
			if (text) return text;
			return this.claudeChat(p, maxTokens, feature);
		}
		return text || this.claudeChat(p, maxTokens, feature);
	}

	/** Latest note in the same series STRICTLY BEFORE the given meeting date
	 *  (frontmatter key, else derived; ordered by meeting date, not ctime).
	 *  The strict bound is what lets an archive import in any order: a July-1
	 *  meeting must never inherit carry-over from July 8. */
	private findPreviousNote(key: string, folder: string, excludePath: string, beforeDate: string): TFile | null {
		const dir = normalizePath(folder);
		let best: TFile | null = null;
		let bestDate = "";
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (f.path === excludePath || !f.path.startsWith(dir + "/")) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
				| { series?: string; type?: string; tags?: unknown; date?: unknown }
				| undefined;
			if (!isCaptureNote(fm)) continue;
			if ((fm?.series ?? seriesKey(f.basename)) !== key) continue;
			const date = String(fm?.date ?? "").slice(0, 10) || dayOf(new Date(f.stat.ctime));
			if (date >= beforeDate) continue;
			if (!best || date > bestDate) {
				best = f;
				bestDate = date;
			}
		}
		return best;
	}

	/** Record one Claude call in the usage ledger. Costs are estimated from the
	 *  token counts the API reports, so the meter counts every AI surface (not
	 *  just captures) without a second API round trip. */
	logLlmUsage(feature: string, model: string, tokIn: number, tokOut: number) {
		if (tokIn <= 0 && tokOut <= 0) return;
		this.recordUsage({ ts: Date.now(), feature, model, tokIn, tokOut, minutes: 0, usd: llmCostUsd(model, tokIn, tokOut) });
	}

	/** Record one stretch of transcription. Kept separate from Claude spend so
	 *  the meter can show the two bills apart instead of one blended figure. */
	logAudioUsage(feature: string, provider: string, providerModel: string, minutes: number) {
		if (minutes <= 0) return;
		this.recordUsage({
			ts: Date.now(),
			feature,
			model: `${provider}/${providerModel}`,
			tokIn: 0,
			tokOut: 0,
			minutes,
			usd: transcriptionCostUsd(provider, minutes),
		});
	}

	/** Append to the ledger, keep an open meter live, and persist shortly after.
	 *  The save is debounced so a burst of calls writes data.json once. */
	private recordUsage(event: UsageEvent) {
		if (!this.settings.usageMeterEnabled) return;
		this.settings.usageLedger = pushUsageEvent(this.settings.usageLedger, event);
		for (const leaf of this.app.workspace.getLeavesOfType(USAGE_VIEW)) {
			if (leaf.view instanceof UsageMeterView) leaf.view.refresh();
		}
		if (this.usageSaveTimer != null) window.clearTimeout(this.usageSaveTimer);
		this.usageSaveTimer = window.setTimeout(() => {
			this.usageSaveTimer = null;
			void this.saveSettings();
		}, 2000);
	}

	/** One Claude round trip with the configured model; text out. `usage` is a
	 *  caller-owned accumulator, so concurrent features (a digest built while a
	 *  naming dialog waits) can never pollute each other's cost lines. */
	async claude(p: { system: string; user: string }, maxTokens: number, usage?: { tokIn: number; tokOut: number }, feature = "misc"): Promise<string> {
		const anthropic = this.llmClient();
		const model = this.llmModelName();
		const msg = await anthropic.messages.create({
			model,
			max_tokens: maxTokens,
			system: p.system,
			messages: [{ role: "user", content: p.user }],
		});
		const tokIn = msg.usage?.input_tokens ?? 0;
		const tokOut = msg.usage?.output_tokens ?? 0;
		if (usage) {
			usage.tokIn += tokIn;
			usage.tokOut += tokOut;
		}
		this.logLlmUsage(feature, model, tokIn, tokOut);
		return msg.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");
	}

	/* ---------------- transcript import ---------------- */

	/** Otter/Teams/Zoom transcript in, first-class capture note out — the same
	 *  post-pipeline as audio (naming, tasks, series, keywords), no
	 *  transcription key needed. Pre-named labels skip the naming dialog. */
	async importTranscript(filename: string, content: string, dateHint?: string) {
		const s = this.settings;
		const utts = parseTranscriptFile(filename, content);
		const title = filename.replace(/\.[^.]+$/, "").replace(/_+/g, " ").trim() || "Imported meeting";
		const date = dateHint ?? today();
		const o: ProcessOverrides = {
			extractions: s.extractions,
			includeTranscript: s.includeTranscript,
			outputFolder: s.outputFolder,
			filenameTemplate: s.filenameTemplate,
		};
		const notePath = normalizePath(`${o.outputFolder}/${renderFilename(o.filenameTemplate, title, date)}`);
		if (this.app.vault.getAbstractFileByPath(notePath)) {
			new Notice("Power Assistant: a note for this transcript already exists (rename or delete it first).");
			return;
		}
		if (!utts && !content.trim()) {
			new Notice("Power Assistant: that file is empty.");
			return;
		}
		new Notice(`Power Assistant: importing ${filename}…`);
		try {
			await this.finishNote({
				utts,
				plainText: utts ? "" : content.trim(),
				overrides: o,
				notePath,
				date,
				title,
				sourceText: `import: ${filename}`,
				embedText: null,
			});
		} catch (e) {
			console.error("Power Assistant:", e);
			new Notice("Power Assistant import failed: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/** Which sections the Re-extract dialog opens with. A note's own heading says
	 *  what kind of capture it is: a post takes the short set that suits a
	 *  sentence or two, a page takes the web set, and everything else keeps the
	 *  meeting set it always had. Read from the metadata cache, so opening the
	 *  dialog costs no file read. */
	reExtractSeed(file: TFile): Record<ExtractionKey, boolean> {
		const heads = (this.app.metadataCache.getFileCache(file)?.headings ?? []).map((h) => h.heading.trim());
		if (heads.includes("Post")) return postExtractions(this.settings.mediaExtractions);
		if (heads.includes("Article")) return { ...this.settings.webExtractions };
		return { ...this.settings.extractions };
	}

	/** Re-extract one note in place, with no talking. "no-text" means the note
	 *  kept nothing to work from; a real API failure throws, so a bulk run can
	 *  count it and carry on to the next note. */
	private async reExtractOnce(file: TFile, chosen: Record<ExtractionKey, boolean>): Promise<"ok" | "no-text"> {
		const md = await this.app.vault.read(file);
		// a post stores its words under "## Post" and a page under "## Article", so
		// keying off "## Transcript" alone left both un-re-extractable; the text may
		// also be wrapped in a foldable callout, and the extractor wants the words
		const transcript = captureSourceText(md);
		if (!transcript) return "no-text";
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as { date?: unknown; "pa-screens"?: unknown } | undefined;
		const meetingDate = String(fm?.date ?? "").slice(0, 10) || today();
		const body = await withRetry(() =>
			this.extract(transcript, chosen, { actionsAsTasks: this.settings.actionsAsTasks, meetingDate })
		);
		// The note's frames are recorded in its frontmatter precisely so this works:
		// a fresh body has fresh (or no) stamps, so which screen illustrates which
		// point is re-decided here, and anything unplaced goes back to the section.
		// Without this a re-extract would drop every illustrated frame and leave its
		// image file in the vault with nothing pointing at it.
		const screens = parseScreensJson(fm?.["pa-screens"]);
		const shown = screens.length ? illustrateBody(body, screens) : { body, unused: [] as Frame[] };
		await this.rewriteNote(file, (data) => withScreensSection(replaceExtractedBody(data, shown.body), formatScreens(shown.unused)));
		await this.app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
			f.model = this.llmModelName();
		});
		return "ok";
	}

	/** Re-run extraction on an existing capture note (new template, model, or
	 *  prompt era) from its own captured text — no re-transcription. */
	async reExtract(file: TFile, chosen: Record<ExtractionKey, boolean>) {
		if (!this.llmReady()) {
			new Notice("Power Assistant: " + this.llmMissingMsg());
			return;
		}
		new Notice("Power Assistant: re-extracting…");
		try {
			const r = await this.reExtractOnce(file, chosen);
			new Notice(r === "ok" ? "Power Assistant: note re-extracted." : "Power Assistant: this note has no captured text to re-extract from.");
		} catch (e) {
			console.error("Power Assistant:", e);
			new Notice("Power Assistant re-extract failed: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/** Where a link capture should write, or the note that already captured this
	 *  very link.
	 *
	 *  Every capture used to refuse outright when a note sat at the path it had
	 *  computed. But the path is the date plus the title, and a post's title is
	 *  its own first words trimmed to fit a filename: two DIFFERENT posts from
	 *  one day whose openings agree render the same name, and the second was
	 *  dropped with a notice reading as "you already have this". Now the note
	 *  that is in the way is asked what it captured. The same link stops the
	 *  capture, as before; anything else gets -2, -3, … the way two meetings on
	 *  one day do. */
	private captureNotePath(folder: string, base: string, url: string): { path: string } | { duplicate: TFile } {
		const at = (name: string) => this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${name}`));
		const sitting = at(base);
		if (sitting instanceof TFile) {
			const fm = this.app.metadataCache.getFileCache(sitting)?.frontmatter as { source?: unknown } | undefined;
			const src = String(fm?.source ?? "").trim();
			if (src && sameCaptureSource(src, url)) return { duplicate: sitting };
		}
		return { path: normalizePath(`${folder}/${freeNoteName(base, (name) => !!at(name))}`) };
	}

	/** Every capture note in a folder, in path order so the run is predictable
	 *  and its progress line reads like the file list. */
	capturesIn(folder: TFolder, recurse: boolean): TFile[] {
		const out: TFile[] = [];
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFolder) {
					if (recurse) walk(child);
					continue;
				}
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const fm = this.app.metadataCache.getFileCache(child)?.frontmatter as { type?: string; tags?: unknown } | undefined;
				if (isCaptureNote(fm)) out.push(child);
			}
		};
		walk(folder);
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Set while a bulk run is going, so the Stop command can appear and the run
	 *  can see that it was asked to stop. */
	private bulkStop = false;
	bulkRunning = false;

	stopBulkReExtract() {
		this.bulkStop = true;
	}

	/** Re-extract a whole folder, one note at a time.
	 *
	 *  Sequential on purpose: this spends money per note, and a serial run can be
	 *  watched, counted, and stopped part-way with everything done so far already
	 *  written. `chosen` null means each note gets the sections that suit its own
	 *  kind, which is what a mixed folder wants. */
	async reExtractFolder(folder: TFolder, opts: { recurse: boolean; chosen: Record<ExtractionKey, boolean> | null }) {
		if (!this.llmReady()) {
			new Notice("Power Assistant: " + this.llmMissingMsg());
			return;
		}
		if (this.bulkRunning) {
			new Notice("Power Assistant: a bulk re-extract is already running.");
			return;
		}
		const files = this.capturesIn(folder, opts.recurse);
		if (!files.length) {
			new Notice("Power Assistant: no capture notes in that folder.");
			return;
		}
		this.bulkRunning = true;
		this.bulkStop = false;
		// 0 = sticky: the run owns this notice until it is done and updates it in
		// place, rather than stacking one toast per note
		const progress = new Notice("Power Assistant: re-extracting…", 0);
		let done = 0;
		let skipped = 0;
		const failed: string[] = [];
		try {
			for (const [i, f] of files.entries()) {
				if (this.bulkStop) break;
				progress.setMessage(`Power Assistant: re-extracting ${i + 1} of ${files.length} — ${f.basename}`);
				try {
					const r = await this.reExtractOnce(f, opts.chosen ?? this.reExtractSeed(f));
					if (r === "ok") done++;
					else skipped++;
				} catch (e) {
					console.warn(`Power Assistant bulk re-extract: ${f.path} failed.`, e);
					failed.push(f.basename);
				}
			}
		} finally {
			this.bulkRunning = false;
			progress.hide();
		}
		// every outcome is named: a silent "done" over a run that quietly failed
		// half its notes would be worse than no summary at all
		const parts = [`re-extracted ${done} note${done === 1 ? "" : "s"}`];
		if (skipped) parts.push(`${skipped} had no captured text`);
		if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ", …" : ""}; see the console)`);
		if (this.bulkStop) parts.push(`stopped early, ${files.length - done - skipped - failed.length} left untouched`);
		new Notice("Power Assistant: " + parts.join("; ") + ".", 12000);
	}

	private async transcribeWhisper(file: TFile): Promise<{ text: string; utts: Utterance[] | null }> {
		const s = this.settings;
		const data = await this.app.vault.readBinary(file);
		const mime =
			file.extension === "mp3" ? "audio/mpeg" : file.extension === "m4a" ? "audio/mp4" : `audio/${file.extension}`;
		const { contentType, body } = buildMultipart(
			{ model: s.transcriptionModel, response_format: "json" },
			"file",
			file.name,
			mime,
			data
		);
		// a single request: safe to retry — a failed call transcribed nothing
		const res = await withRetry(() =>
			requestUrl({
				url: s.transcriptionEndpoint.replace(/\/+$/, "") + "/audio/transcriptions",
				method: "POST",
				headers: { ...(s.transcriptionKey ? { Authorization: `Bearer ${s.transcriptionKey}` } : {}), "Content-Type": contentType },
				body,
				throw: true,
			})
		);
		return { text: (res.json as { text?: string }).text ?? "", utts: null };
	}

	/** AssemblyAI: upload the raw bytes, request a diarized transcript, poll
	 *  until it settles. Raw utterances out; the caller formats and names them. */
	/** Whether a provider has the key (or LAN endpoint) it needs. Asked per
	 *  provider rather than per settings object, so the settings tab can label
	 *  which ones are actually set up and a capture can check the one it will
	 *  really use, not whichever happens to be the default. */
	providerReady(p: TranscriptionProvider): boolean {
		const s = this.settings;
		if (p === "assemblyai") return !!s.assemblyaiKey.trim();
		if (p === "deepgram") return !!s.deepgramKey.trim();
		if (p === "whisperx") return !!s.whisperxEndpoint.trim();
		return !!s.transcriptionKey.trim() || /localhost|127\.0\.0\.1|192\.168\./.test(s.transcriptionEndpoint);
	}

	/** The provider a given kind of capture transcribes with: its own choice, or
	 *  the default when it has not been given one. */
	providerFor(ctx: "meeting" | "capture" | "youtube" | "media"): TranscriptionProvider {
		const s = this.settings;
		const choice = ctx === "meeting" ? s.meetingProvider : ctx === "youtube" ? s.youtubeProvider : ctx === "media" ? s.mediaProvider : s.captureProvider;
		return choice === "default" ? s.transcriptionProvider : choice;
	}

	/** Dispatch to a specific transcription provider. The extras are WhisperX
	 *  only: `onStage` hears human-readable progress, `maxSpeakers` caps the
	 *  diarizer's speaker count (from the invite), `wantVoices` asks for
	 *  voice vectors so the cluster review and voiceprints can run. */
	private transcribeFile(
		file: TFile,
		provider: TranscriptionProvider,
		extra?: { onStage?: (stage: string) => void; maxSpeakers?: number; wantVoices?: boolean }
	): Promise<{ text: string; utts: Utterance[] | null; voice?: VoiceData }> {
		if (provider === "assemblyai") return this.transcribeAssemblyAI(file);
		if (provider === "deepgram") return this.transcribeDeepgram(file);
		if (provider === "whisperx") return this.transcribeWhisperX(file, extra);
		return this.transcribeWhisper(file);
	}

	/** A self-hosted WhisperX server (tools/whisperx-server): submit the audio,
	 *  get a job id, poll until it settles — like the AssemblyAI flow, so a
	 *  dropped socket or a plugin reload mid-job never loses minutes of server
	 *  work. Speaker labels without a cloud provider, and no audio leaves your
	 *  network. A v1 server that answers with segments directly is still read. */
	private async transcribeWhisperX(
		file: TFile,
		extra?: { onStage?: (stage: string) => void; maxSpeakers?: number; wantVoices?: boolean }
	): Promise<{ text: string; utts: Utterance[] | null; voice?: VoiceData }> {
		const onStage = extra?.onStage;
		const base = this.settings.whisperxEndpoint.trim().replace(/\/+$/, "");
		const data = await this.app.vault.readBinary(file);
		const mime: Record<string, string> = {
			webm: "audio/webm",
			m4a: "audio/mp4",
			mp4: "audio/mp4",
			mp3: "audio/mpeg",
			wav: "audio/wav",
			ogg: "audio/ogg",
			flac: "audio/flac",
		};
		const fields: Record<string, string> = {};
		if (extra?.wantVoices) fields.embeddings = "1";
		if (extra?.maxSpeakers && extra.maxSpeakers > 0) fields.max_speakers = String(Math.round(extra.maxSpeakers));
		const { contentType, body } = buildMultipart(fields, "file", file.name, mime[file.extension.toLowerCase()] ?? "application/octet-stream", data);
		// the submit is retried as a whole: a failed submit transcribed nothing
		const submitted = await withRetry(() =>
			requestUrl({ url: base + "/transcribe", method: "POST", headers: { "Content-Type": contentType }, body, throw: true })
		);
		const first = submitted.json as WhisperXResponse & { job?: string };
		// the fine-grained pieces and vectors ride along only when they came
		// back, so every other provider path stays exactly what it was
		const unpack = (j: WhisperXResponse) => {
			const r = parseWhisperX(j);
			const voice = r.utts && r.fine ? { fine: r.fine, embeddings: r.embeddings, turnEmbeddings: r.turnEmbeddings } : undefined;
			return { text: r.text, utts: r.utts, voice };
		};
		if (!first.job) return unpack(first); // a v1 server answered inline
		// poll every 3s like AssemblyAI; each poll retried individually so a
		// transient network blip never abandons a job the server is still doing.
		// The ceiling is generous: an hour of audio on a CPU box takes a while.
		const stageWords: Record<string, string> = {
			queued: "waiting for the server, another recording is ahead",
			transcribing: "transcribing",
			aligning: "aligning words",
			diarizing: "separating speakers",
			embedding: "reading the voices",
		};
		let lastStage = "";
		for (let tries = 0; tries < 3600; tries++) {
			await sleep(3000);
			const res = await withRetry(() => requestUrl({ url: `${base}/jobs/${first.job}`, throw: true }));
			const j = res.json as { status: string; stage?: string; result?: WhisperXResponse; error?: string };
			if (j.stage && j.stage !== lastStage && onStage && stageWords[j.stage]) {
				lastStage = j.stage;
				onStage(stageWords[j.stage]);
			}
			if (j.status === "done") return unpack(j.result ?? {});
			if (j.status === "error") throw new Error(j.error || "the WhisperX server reported a failure; check its log.");
		}
		throw new Error("the WhisperX job did not finish within three hours; check the server.");
	}

	/** Write the bundled server files into the plugin folder and hand back the
	 *  one command that installs and starts everything. The plugin never runs
	 *  the installer itself: the user sees exactly what executes.
	 *
	 *  Antivirus tools treat "an app writes a .ps1 script" as dropper
	 *  behavior (Bitdefender has blocked exactly this write, EPERM at open,
	 *  while a person copying the same file is allowed), so every file gets
	 *  a second chance through remove-then-write, failures are collected per
	 *  file instead of aborting the batch, and the error says which files
	 *  are missing and why that usually is. Never renamed or disguised to
	 *  slip past a scanner: the honest fix is an antivirus exclusion the
	 *  user chooses to make, or copying the files from a synced device. */
	async installWhisperxFiles(): Promise<{ dir: string; command: string }> {
		const rel = `${this.app.vault.configDir}/plugins/powerassistant/server`;
		const ad = this.app.vault.adapter;
		if (!(await ad.exists(rel))) await ad.mkdir(rel);
		const bundle: [string, string][] = [
			["server.py", whisperxServerPy],
			["requirements.txt", whisperxRequirementsTxt],
			["setup.ps1", whisperxSetupPs1],
			["setup.sh", whisperxSetupSh],
		];
		const failed: string[] = [];
		for (const [name, content] of bundle) {
			const p = `${rel}/${name}`;
			try {
				await ad.write(p, content);
			} catch {
				try {
					if (await ad.exists(p)) await ad.remove(p);
					await ad.write(p, content);
				} catch (e2) {
					console.error(`Power Assistant: could not write ${p}`, e2);
					failed.push(name);
				}
			}
		}
		if (failed.length) {
			throw new Error(
				`${failed.join(", ")} could not be written into ${rel}. An antivirus is usually the reason (it sees a plugin writing scripts as suspicious; Bitdefender has blocked this setup script before). The files that did write are current. To finish: allow this folder in the antivirus and press the button again, or copy the missing files from the plugin's GitHub repo (tools/whisperx-server) or from any synced device where the write succeeded.`
			);
		}
		const sep = Platform.isWin ? "\\" : "/";
		const base = ad instanceof FileSystemAdapter ? ad.getBasePath() : "";
		const dir = base ? base + sep + rel.split("/").join(sep) : rel;
		const command = Platform.isWin ? `powershell -ExecutionPolicy Bypass -File "${dir}${sep}setup.ps1"` : `bash "${dir}/setup.sh"`;
		return { dir, command };
	}

	async openServerInstall() {
		if (!Platform.isDesktopApp) {
			new Notice("Power Assistant: install the server from a desktop; phones point at it over the network.");
			return;
		}
		try {
			new ServerInstallModal(this.app, this, await this.installWhisperxFiles()).open();
		} catch (e) {
			// long on purpose: this message carries the way out (antivirus
			// exclusion or copying the file), not just the failure
			new Notice("Power Assistant: could not write the server files: " + (e instanceof Error ? e.message : String(e)), 20000);
		}
	}

	/** This machine's private LAN address, for endpoints the whole fleet reads.
	 *  Falls back to localhost when there is none to find (or on mobile). */
	private lanAddress(): string {
		try {
			const req = (window as unknown as { require?: (m: string) => unknown }).require;
			const os = req?.("os") as { networkInterfaces(): Record<string, { family: string; internal: boolean; address: string }[] | undefined> } | undefined;
			// scored rather than first-match: a VPN tunnel's address answers here
			// but is unreachable from the other devices this setting syncs to
			return pickLanAddress(os?.networkInterfaces() ?? {});
		} catch {
			/* sandboxed or mobile; localhost still works on this device */
		}
		return "localhost";
	}

	/** Probe this machine for Ollama and the WhisperX server and fill in their
	 *  addresses, using the LAN form so the settings sync usefully to the rest
	 *  of the fleet. Detection changes endpoints only, never the provider
	 *  choice: switching the AI to the custom endpoint stays an explicit act. */
	async detectLocalAi() {
		new Notice("Power Assistant: probing this machine for local AI…");
		const lan = this.lanAddress();
		const found: string[] = [];
		let missingEmbed = false;
		let lanBlocked = false;
		try {
			const r = await requestUrl({ url: "http://127.0.0.1:11434/api/tags", throw: true });
			const models = ((r.json as { models?: { name?: string }[] }).models ?? []).map((m) => m.name).filter((n): n is string => !!n);
			// Ollama binds to localhost only unless OLLAMA_HOST says otherwise, so
			// the LAN address is what the fleet needs but not always what works.
			// Probe it: a reachable LAN address serves every device, an
			// unreachable one would hand this machine a broken endpoint.
			let host = `${lan}`;
			try {
				await requestUrl({ url: `http://${lan}:11434/api/tags`, throw: true });
			} catch {
				host = "localhost";
				lanBlocked = true;
			}
			this.settings.llmEndpoint = `http://${host}:11434`;
			if (!this.settings.llmModel.trim() && models.length) this.settings.llmModel = models[0];
			found.push(`Ollama (${models.length} model${models.length === 1 ? "" : "s"} installed)`);
			// the same server also serves embeddings on its OpenAI-compatible
			// route, so meaning-based search costs nothing extra once it is here
			const embedModel = models.find((m) => /embed/i.test(m));
			// repair a stale local address as well as filling an empty one: the
			// whole point of detection is to fix the endpoint, and an old host
			// (a VPN address, a machine that moved) is exactly what goes wrong.
			// A deliberate hosted provider is left alone — only Ollama-shaped
			// addresses on its own port are rewritten.
			const current = this.settings.embeddingsEndpoint.trim();
			if (!current || /:11434(\/|$)/.test(current)) this.settings.embeddingsEndpoint = `http://${host}:11434/v1`;
			if (embedModel) {
				this.settings.embeddingsModel = embedModel.replace(/:latest$/, "");
				found.push(`its embedding model ${this.settings.embeddingsModel}`);
			} else {
				// running but with nothing that can embed: the quiet failure mode
				// worth naming, since search would just stay keyword-only
				missingEmbed = true;
			}
		} catch {
			/* not running here */
		}
		try {
			const r = await requestUrl({ url: "http://127.0.0.1:8571/health", throw: true });
			const j = r.json as { ok?: boolean; diarization?: boolean };
			if (j.ok) {
				this.settings.whisperxEndpoint = `http://${lan}:8571`;
				found.push(`the WhisperX server (speaker labels ${j.diarization ? "on" : "off"})`);
			}
		} catch {
			/* not running here */
		}
		if (found.length) {
			await this.saveSettings();
			this.refreshSettingsTab?.();
			new Notice(
				`Power Assistant: found ${found.join(" and ")}. Endpoint${found.length > 1 ? "s" : ""} filled in as ${lan}. To run the AI locally, set the provider dropdown to Custom endpoint.`,
				12000
			);
			if (missingEmbed)
				new Notice(
					"Power Assistant: Ollama has no embedding model, so search stays keyword-only. Run \"ollama pull nomic-embed-text\" on that machine, then Detect again.",
					14000
				);
			if (lanBlocked)
				new Notice(
					`Power Assistant: Ollama answers on this computer but not on ${lan}, so the address was set to localhost and only this device can use it. To serve your other devices, set OLLAMA_HOST=0.0.0.0 on this machine and restart Ollama, then Detect again.`,
					15000
				);
		} else {
			new Notice(
				"Power Assistant: nothing answered on this machine (Ollama port 11434, WhisperX port 8571). Install them here first, or run detection on the machine they live on.",
				10000
			);
		}
	}

	/** Actually embed a sample string and report what came back.
	 *
	 *  Worth its own button because every failure here is otherwise silent:
	 *  embedTexts returns [] on a bad endpoint, a missing model, or a timeout,
	 *  and search quietly stays keyword-only with nothing to explain it. */
	async verifyEmbeddings(): Promise<void> {
		const s = this.settings;
		if (!s.embeddingsEndpoint.trim()) {
			new Notice("Power Assistant: set an embeddings endpoint first (Ollama answers on http://localhost:11434/v1).", 9000);
			return;
		}
		new Notice("Power Assistant: testing the embeddings endpoint…");
		const started = Date.now();
		const vecs = await this.embedTexts(["a short sentence to embed"]);
		const took = Date.now() - started;
		const dim = vecs[0]?.length ?? 0;
		if (!dim) {
			new Notice(
				`Power Assistant: no embedding came back from ${s.embeddingsEndpoint} (model "${s.embeddingsModel}"). Check the server is running, the URL ends in /v1, and the model is pulled ("ollama pull ${s.embeddingsModel || "nomic-embed-text"}"). The console has the exact error.`,
				15000
			);
			return;
		}
		new Notice(`Power Assistant: embeddings work. ${s.embeddingsModel} returned a ${dim}-dimension vector in ${took} ms.`, 9000);
	}

	/** Confirm the WhisperX server is up and what it is running. */
	async verifyWhisperX() {
		const base = this.settings.whisperxEndpoint.trim().replace(/\/+$/, "");
		if (!base) {
			new Notice("Power Assistant: enter the WhisperX server address first.");
			return;
		}
		new Notice("Power Assistant: checking the WhisperX server…");
		try {
			const r = await requestUrl({ url: base + "/health", throw: false });
			const j = (r.json ?? {}) as { ok?: boolean; model?: string; diarization?: boolean; diarization_model?: string };
			if (r.status === 200 && j.ok)
				new Notice(
					`Power Assistant: WhisperX server is up (${j.model ?? "model unknown"}${
						j.diarization === false
							? ", diarization off"
							: `, speaker labels on${j.diarization_model ? ` via ${String(j.diarization_model).replace("pyannote/speaker-diarization-", "")}` : ""}`
					}).`,
					8000
				);
			else new Notice(`Power Assistant: the server answered with status ${r.status}; check the address and the server log.`, 8000);
		} catch (e) {
			new Notice("Power Assistant: could not reach the WhisperX server: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/** Deepgram pre-recorded transcription with speaker diarization. A single
	 *  request (retried as a whole), unlike AssemblyAI's upload/create/poll.
	 *  diarize_model=v2 selects Deepgram's next-gen diarizer (batch-only, which
	 *  this endpoint is); the legacy diarize=true routed to the old v1 model,
	 *  which is what kept gluing two people into one speaker. The two params are
	 *  mutually exclusive — sending both is rejected. */
	private async transcribeDeepgram(file: TFile): Promise<{ text: string; utts: Utterance[] | null }> {
		const key = this.settings.deepgramKey;
		const model = this.settings.deepgramModel.trim() || "nova-2";
		const data = await this.app.vault.readBinary(file);
		const mime: Record<string, string> = {
			webm: "audio/webm",
			m4a: "audio/mp4",
			mp4: "audio/mp4",
			mp3: "audio/mpeg",
			wav: "audio/wav",
			ogg: "audio/ogg",
			flac: "audio/flac",
		};
		const res = await withRetry(() =>
			requestUrl({
				url: `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&diarize_model=v2&punctuate=true&smart_format=true&utterances=true`,
				method: "POST",
				headers: { Authorization: `Token ${key}`, "Content-Type": mime[file.extension.toLowerCase()] ?? "application/octet-stream" },
				body: data,
				throw: true,
			})
		);
		return parseDeepgram(res.json as DeepgramResponse);
	}

	/** Validate the Deepgram key with a cheap authenticated request. */
	async verifyDeepgramKey() {
		const key = this.settings.deepgramKey.trim();
		if (!key) {
			new Notice("Power Assistant: enter your Deepgram key first.");
			return;
		}
		new Notice("Power Assistant: checking your Deepgram key…");
		try {
			const r = await requestUrl({ url: "https://api.deepgram.com/v1/projects", headers: { Authorization: `Token ${key}` }, throw: false });
			if (r.status === 200) new Notice("Power Assistant: Deepgram key works. Set Provider to Deepgram and record to get speaker labels.", 8000);
			else if (r.status === 401 || r.status === 403) new Notice("Power Assistant: Deepgram rejected that key. Check it and try again.", 8000);
			else new Notice(`Power Assistant: Deepgram check returned status ${r.status}.`, 8000);
		} catch (e) {
			new Notice("Power Assistant: could not reach Deepgram: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/** Validate the AssemblyAI key with a cheap authenticated request, so you
	 *  know it works before recording a real meeting. */
	async verifyAssemblyKey() {
		const key = this.settings.assemblyaiKey.trim();
		if (!key) {
			new Notice("Power Assistant: enter your AssemblyAI key first.");
			return;
		}
		new Notice("Power Assistant: checking your AssemblyAI key…");
		try {
			const r = await requestUrl({ url: "https://api.assemblyai.com/v2/transcript?limit=1", headers: { authorization: key }, throw: false });
			if (r.status === 200) new Notice("Power Assistant: AssemblyAI key works. Set Provider to AssemblyAI and record to get speaker labels.", 8000);
			else if (r.status === 401) new Notice("Power Assistant: AssemblyAI rejected that key (401). Check it and try again.", 8000);
			else new Notice(`Power Assistant: AssemblyAI check returned status ${r.status}.`, 8000);
		} catch (e) {
			new Notice("Power Assistant: could not reach AssemblyAI: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	private async transcribeAssemblyAI(file: TFile): Promise<{ text: string; utts: Utterance[] | null }> {
		const key = this.settings.assemblyaiKey;
		const data = await this.app.vault.readBinary(file);
		// each step is retried INDIVIDUALLY: a retry only re-runs the request
		// that actually failed, so a transient poll error never re-submits a
		// second (billable) transcript job for the same audio.
		const up = await withRetry(() =>
			requestUrl({
				url: "https://api.assemblyai.com/v2/upload",
				method: "POST",
				headers: { authorization: key, "Content-Type": "application/octet-stream" },
				body: data,
				throw: true,
			})
		);
		const created = await withRetry(() =>
			requestUrl({
				url: "https://api.assemblyai.com/v2/transcript",
				method: "POST",
				headers: { authorization: key, "Content-Type": "application/json" },
				body: JSON.stringify({ audio_url: (up.json as { upload_url: string }).upload_url, speaker_labels: true }),
				throw: true,
			})
		);
		const id = (created.json as { id: string }).id;
		for (let tries = 0; tries < 200; tries++) {
			await new Promise((r) => setTimeout(r, 3000));
			const res = await withRetry(() =>
				requestUrl({ url: `https://api.assemblyai.com/v2/transcript/${id}`, headers: { authorization: key }, throw: true })
			);
			const j = res.json as { status: string; error?: string; text?: string; utterances?: Utterance[] };
			if (j.status === "completed") {
				const utts = j.utterances ?? [];
				return utts.length ? { text: j.text ?? "", utts } : { text: j.text ?? "", utts: null };
			}
			if (j.status === "error") throw new Error(j.error ?? "AssemblyAI transcription failed.");
		}
		throw new Error("AssemblyAI transcription timed out after 10 minutes.");
	}

	private async extract(
		transcript: string,
		chosen: Record<ExtractionKey, boolean>,
		opts: { actionsAsTasks?: boolean; meetingDate?: string; priorContext?: string | null; stampSections?: boolean } = {},
		usage?: { tokIn: number; tokOut: number }
	): Promise<string> {
		const selected = EXTRACTIONS.map((e) => e.key).filter((k) => chosen[k]);
		// one setting decides this for every caller: stamps are only useful when the
		// transcript has them, and every path that extracts has a transcript
		return this.claude(buildExtractionPrompt(selected, transcript, { stampSections: this.settings.stampSummaries, ...opts }), 8192, usage, "meeting");
	}

	/** Run the configured AI model over every `pa-eval: true` note and write a
	 *  scored comparison report. An eval note is a finished capture note you
	 *  copied somewhere and marked; its existing sections are the golden, its
	 *  transcript is the input. This is how "is the local model good enough"
	 *  becomes a table instead of a feeling, and how a prompt change proves it
	 *  did not regress last month's meetings. */
	async runEvals() {
		if (!this.llmReady()) {
			new Notice("Power Assistant: " + this.llmMissingMsg());
			return;
		}
		const cases: TFile[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (fm?.["pa-eval"] === true) cases.push(f);
		}
		if (!cases.length) {
			new Notice("Power Assistant: no eval notes found. Copy a few finished capture notes into a folder, add pa-eval: true to their frontmatter, and run this again.", 12000);
			return;
		}
		const model = this.llmModelName();
		new Notice(`Power Assistant: running ${cases.length} extraction eval${cases.length === 1 ? "" : "s"} against ${model}. This can take a while…`);
		const rows: { title: string; score: EvalScore; fresh: string }[] = [];
		let failed = 0;
		for (const f of cases) {
			try {
				const md = await this.app.vault.cachedRead(f);
				const transcript = captureSourceText(md);
				if (!transcript || !evalSections(md).size) {
					console.warn(`Power Assistant eval: ${f.path} has no transcript or no extracted sections; skipped.`);
					continue;
				}
				const chosen = {} as Record<ExtractionKey, boolean>;
				const golden = evalSections(md);
				for (const e of EXTRACTIONS) chosen[e.key] = golden.has(e.label);
				const fresh = await withRetry(() => this.extract(transcript, chosen, { actionsAsTasks: this.settings.actionsAsTasks }));
				rows.push({ title: f.basename, score: scoreExtraction(md, fresh), fresh });
			} catch (e) {
				failed++;
				console.error(`Power Assistant eval: ${f.path} failed.`, e);
			}
		}
		if (!rows.length) {
			new Notice("Power Assistant: no eval produced a result (empty cases or every call failed); see the developer console.", 10000);
			return;
		}
		const date = today();
		const stamp = clockOf(new Date()).slice(0, 5).replace("-", ""); // local HHMM, to tell two runs on one day apart
		const folder = cases[0].parent?.path || this.settings.outputFolder;
		const safeModel = model.replace(/[\\/:*?"<>|#^[\]]/g, "-");
		const reportPath = normalizePath(`${folder}/Eval report ${date} ${stamp} (${safeModel}).md`);
		await this.writeNote(reportPath, folder, buildEvalReport(rows, model, date));
		if (failed) new Notice(`Power Assistant: eval report written; ${failed} case${failed === 1 ? "" : "s"} failed (see console).`, 8000);
	}

	/* ---------------- YouTube pipeline ---------------- */

	/** Best-effort: download a video's audio and transcribe it through the
	 *  configured provider, for accurate names and numbers that auto-captions
	 *  miss. Returns "" (and the caller falls back to captions) when the audio
	 *  cannot be fetched or transcribed. The audio is a temporary file, removed
	 *  after transcription. */
	private async transcribeYoutubeAudio(videoId: string, formats: YoutubeFormat[]): Promise<string> {
		const audio = pickYoutubeAudio(formats);
		if (!audio) {
			new Notice("Power Assistant: no downloadable audio for this video; using captions.");
			return "";
		}
		const tmpPath = normalizePath(`${this.recordingFolder()}/youtube-${videoId}.${audio.ext}`);
		let tmp: TFile | null = null;
		try {
			new Notice("Power Assistant: downloading and transcribing the audio…");
			const res = await requestUrl({ url: audio.url, throw: true });
			const bytes = res.arrayBuffer;
			const provider = this.providerFor("youtube");
			if (provider === "whisper") {
				const warn = whisperSizeWarning(bytes.byteLength, this.settings.transcriptionEndpoint);
				if (warn) {
					new Notice("Power Assistant: " + warn, 12000);
					return "";
				}
			}
			await this.ensureFolder(this.recordingFolder());
			this.directProcess.add(tmpPath); // the create event must not auto-process this temp
			const existing = this.app.vault.getAbstractFileByPath(tmpPath);
			if (existing instanceof TFile) {
				await this.app.vault.modifyBinary(existing, bytes);
				tmp = existing;
			} else {
				tmp = await this.app.vault.createBinary(tmpPath, bytes);
			}
			const r = await this.transcribeFile(tmp, provider);
			return r.text.trim();
		} catch (e) {
			console.warn("Power Assistant: audio transcription failed; falling back to captions.", e);
			new Notice("Power Assistant: could not transcribe the audio; using captions instead.");
			return "";
		} finally {
			this.directProcess.delete(tmpPath);
			if (tmp)
				try {
					await this.app.vault.trash(tmp, true);
				} catch {
					/* already gone */
				}
		}
	}

	async captureYoutube(url: string) {
		url = ensureUrlScheme(url);
		const s = this.settings;
		try {
			const videoId = youtubeVideoId(url);
			if (!videoId) {
				new Notice("Power Assistant: couldn't find a video id in that URL.");
				return;
			}
			new Notice("Power Assistant: fetching the transcript…");
			// Primary: the InnerTube player API as the Android client — its caption
			// URLs work outside a browser session, where the watch-page ones return
			// empty bodies (YouTube's proof-of-origin enforcement).
			let title = "YouTube video";
			let blocked = "";
			let tracks: { baseUrl: string; languageCode?: string }[] = [];
			let audioFormats: YoutubeFormat[] = [];
			let info: YoutubeInfo | null = null;
			try {
				const player = await requestUrl({
					url: "https://www.youtube.com/youtubei/v1/player",
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
					},
					body: JSON.stringify({
						context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" } },
						videoId,
					}),
					throw: true,
				});
				const j = player.json as {
					videoDetails?: { title?: string };
					playabilityStatus?: { status?: string; reason?: string };
					captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl: string; languageCode?: string }[] } };
					streamingData?: { adaptiveFormats?: YoutubeFormat[] };
				};
				// a refusal arrives as an ordinary 200 with everything missing, so
				// the reason has to be read off the payload or it is lost
				blocked = youtubeBlockReason(j.playabilityStatus?.status ?? "", j.playabilityStatus?.reason ?? "");
				title = j.videoDetails?.title ?? title;
				tracks = j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
				audioFormats = j.streamingData?.adaptiveFormats ?? [];
			} catch (e) {
				console.warn("Power Assistant: InnerTube player fetch failed, falling back to page scrape.", e);
			}
			// the watch page carries the channel metadata (subscribers live only
			// here, not in the InnerTube response) and is the caption fallback
			try {
				const page = await requestUrl({ url, throw: false });
				if (page.status < 400 && page.text) {
					info = extractYoutubeInfo(page.text);
					if (info.title && info.title !== "YouTube video") title = info.title;
					if (!tracks.length) {
						const meta = extractYoutubeMeta(page.text);
						if (meta) tracks = meta.tracks;
					}
				}
			} catch (e) {
				console.warn("Power Assistant: could not read the video page for metadata.", e);
			}
			// YouTube tells a client it has decided is a robot nothing at all: no
			// title, no formats, and an empty caption list that reads exactly like a
			// video with no subtitles. yt-dlp is a second opinion that can carry
			// cookies where requestUrl cannot, and it runs before the duplicate
			// check because the note's name depends on the title it brings back.
			let viaYtDlp = "";
			if (!tracks.length || title === "YouTube video") {
				const got = await this.youtubeViaYtDlp(url);
				if (got) {
					if (got.info?.title) title = got.info.title;
					// the page reader gets almost nothing through a bot wall, so the
					// note's channel, views, date and length come from here too —
					// otherwise a capture that got through still reads half-empty
					info = mergeYoutubeInfo(info, got.info);
					viaYtDlp = got.text;
				}
			}

			// Checked here rather than after the work: a note that already holds this
			// video should not cost a transcript and a summary first. captureMedia has
			// always checked before its download; YouTube paid for both and then
			// refused, which is how an extraction can sit in the usage ledger with no
			// note anywhere to show for it.
			const date = today();
			const folder = cleanFolderPath(s.youtubeFolder) || s.outputFolder;
			const where = this.captureNotePath(folder, renderMeetingFilename(s.youtubeFilename, title, date), url);
			if ("duplicate" in where) {
				new Notice(`Power Assistant: this video is already captured (see ${where.duplicate.basename}.`, 8000);
				return;
			}
			const notePath = where.path;

			// transcript source: the actual audio when the user opted in and a key is
			// set (accurate names and numbers), otherwise the free caption track
			let transcript = "";
			if (s.youtubeTranscribeAudio && this.providerReady(this.providerFor("youtube"))) transcript = await this.transcribeYoutubeAudio(videoId, audioFormats);
			if (!transcript) transcript = viaYtDlp;
			if (!transcript && !tracks.length) {
				new Notice(
					blocked
						? `Power Assistant: ${blocked} Set a cookies file (or Cookies from browser) in settings, or try again later.`
						: s.youtubeTranscribeAudio
							? "Power Assistant: could not get the audio, and this video has no captions."
							: "Power Assistant: this video has no captions to fetch.",
					blocked ? 15000 : 8000
				);
				return;
			}
			if (!transcript) {
				const track = tracks.find((t) => t.languageCode?.startsWith("en")) ?? tracks[0];
				const tt = await requestUrl({ url: track.baseUrl + (track.baseUrl.includes("fmt=") ? "" : "&fmt=json3"), throw: true });
				const raw = tt.text ?? "";
				transcript = raw.trimStart().startsWith("<") ? parseTimedTextXml(raw) : parseTimedText(JSON.parse(raw || "{}"));
				if (!transcript) {
					new Notice("Power Assistant: YouTube returned an empty caption track (try again in a minute).");
					return;
				}
			}
			if (s.corrections.length) transcript = applyCorrections(transcript, s.corrections);
			let body: string | null = null;
			let extractionError: string | null = null;
			if (this.llmReady()) {
				new Notice("Power Assistant: extracting notes…");
				// never lose a good transcript: if extraction fails, still write the
				// note with the transcript and the error, like the meeting flow does
				try {
					body = await withRetry(() => this.extract(transcript, s.youtubeExtractions));
				} catch (e) {
					extractionError = humanizeError(e instanceof Error ? e.message : String(e));
					new Notice("Power Assistant: extraction failed; saving the transcript. Run Re-extract to retry. " + extractionError, 12000);
				}
			}
			await this.ensureFolder(folder);
			const note = assembleNote({
				title,
				date,
				source: url,
				embed: null,
				body,
				transcript,
				includeTranscript: s.includeTranscript,
				model: body ? this.llmModelName() : null,
				extractionError,
				props: info ? youtubeProps(info) : [],
				filename: notePath,
			});
			await this.writeNote(notePath, folder, note);
		} catch (e) {
			console.error("Power Assistant:", e);
			new Notice("Power Assistant failed: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/* ---------------- PowerPoint capture ---------------- */

	/** Index a deck. A .pptx is a zip of XML, so the slides, speaker notes, and
	 *  pictures come straight out of the file with nothing installed. Pictures
	 *  are saved into the vault and, per the chosen mode, read by Claude. The
	 *  deck itself stays put and the note links back to it. */
	async capturePptx(file: TFile, mode: OcrMode) {
		const s = this.settings;
		if (mode !== "none" && !this.llmReady()) {
			new Notice("Power Assistant: set up the AI model in settings to read slide images. Capturing the text only.");
			mode = "none";
		}
		// a sticky notice: reading pictures is one call each, and a deck of
		// charts is a long enough wait that silence reads as nothing happening
		const progress = new Notice(`Power Assistant: reading ${file.basename}…`, 0);
		try {
			const entries = unzipSync(new Uint8Array(await this.app.vault.readBinary(file)));
			const order = slideOrder(Object.keys(entries));
			if (!order.length) {
				progress.hide();
				new Notice("Power Assistant: no slides found in that file.");
				return;
			}
			const date = today();
			const folder = cleanFolderPath(s.pptxFolder) || s.outputFolder;
			await this.ensureFolder(folder);
			const notePath = normalizePath(`${folder}/${renderFilename(s.filenameTemplate, file.basename, date)}`);
			if (this.app.vault.getAbstractFileByPath(notePath)) {
				progress.hide();
				new Notice("Power Assistant: a note for this deck already exists.");
				return;
			}
			const slides: DeckSlide[] = [];
			let readCount = 0;
			let skipped = 0;
			for (let i = 0; i < order.length; i++) {
				const name = order[i];
				const xml = strFromU8(entries[name]);
				const { title, lines } = slideText(xml);
				const relsName = name.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels");
				const rels = entries[relsName] ? strFromU8(entries[relsName]) : "";
				// a slide's notes are wired through its rels, not by matching numbers
				const notesName = (rels.match(/Target="([^"]*notesSlide\d+\.xml)"/)?.[1] ?? "").replace(/^\.\.\//, "ppt/");
				const notes = notesName && entries[notesName] ? notesText(strFromU8(entries[notesName])) : "";
				const images: DeckImage[] = [];
				for (const pic of slidePictures(xml, rels)) {
					const action = pictureAction(pic.inches, mode, s.pptxMinInches);
					if (action === "skip") {
						skipped++;
						continue;
					}
					const bytes = entries[pic.entry];
					if (!bytes) continue;
					progress.setMessage(`Power Assistant: slide ${i + 1} of ${order.length}${readCount ? `, ${readCount} read` : ""}…`);
					const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
					const dest = await this.app.fileManager.getAvailablePathForAttachment(
						`${file.basename} ${i + 1} ${pic.entry.split("/").pop() ?? "image"}`,
						notePath
					);
					const saved = await this.app.vault.createBinary(dest, buf);
					const media = VISION_TYPES[(pic.entry.split(".").pop() ?? "").toLowerCase()];
					let text = "";
					if (action === "read" && media) {
						try {
							text = await this.claudeVision(bytes, media);
							readCount++;
						} catch (e) {
							// one unreadable picture must not lose the whole deck
							console.error("Power Assistant:", e);
						}
					}
					images.push({ link: saved.path, text });
				}
				slides.push({ n: i + 1, title, lines, notes, images });
				progress.setMessage(`Power Assistant: slide ${i + 1} of ${order.length}${readCount ? `, ${readCount} read` : ""}…`);
			}
			const note = buildDeckNote({ name: file.basename, source: file.path, date, slides });
			await this.writeNote(notePath, folder, note);
			progress.hide();
			const n = order.length;
			const read = readCount ? `, read ${readCount} image${readCount === 1 ? "" : "s"}` : "";
			const dec = skipped ? `, skipped ${skipped} decorative` : "";
			new Notice(`Power Assistant: captured ${n} slide${n === 1 ? "" : "s"}${read}${dec}.`);
		} catch (e) {
			progress.hide();
			console.error("Power Assistant:", e);
			new Notice("Power Assistant failed: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/* ---------------- video and social capture (yt-dlp) ---------------- */

	/** Run yt-dlp and hand back its stdout, trying each way of invoking it until
	 *  one exists on this machine. A pip install routinely leaves the launcher off
	 *  PATH, so "not on PATH" is not the same as "not installed" and the Python
	 *  module form gets a turn before this gives up on the user. */
	private runYtDlp(args: string[], timeoutMs: number): Promise<string> {
		const cp = this.nodeCp();
		if (!cp) return Promise.reject(new Error("capturing an X post needs the desktop app."));
		const tries = ytDlpInvocations(this.settings.ytDlpPath);
		const attempt = (i: number): Promise<string> =>
			new Promise<string>((resolve, reject) => {
				const t = tries[i];
				cp.execFile(t.cmd, [...t.pre, ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
					if (!err) return resolve(stdout);
					// A missing binary (ENOENT) or a Python without the module means
					// only that this particular way of calling yt-dlp is not the one;
					// any other failure came from yt-dlp itself and is worth showing.
					const notHere = (err as NodeJS.ErrnoException).code === "ENOENT" || /No module named/i.test(stderr || "");
					if (notHere) {
						if (i + 1 < tries.length) return attempt(i + 1).then(resolve, reject);
						return reject(new YtDlpMissing());
					}
					const last = (stderr || "").trim().split("\n").filter(Boolean).pop();
					reject(new Error(last || err.message));
				});
			});
		return attempt(0);
	}

	/* ---------------- signing in to YouTube, in the app ---------------- */

	/** Electron's renderer module, or null on mobile and anywhere it is not
	 *  exposed. Everything that opens a window or reads a session goes through
	 *  here, so one absence is handled in one place. */
	private electron(): ElectronBits | null {
		try {
			const req = (window as unknown as { require?: (m: string) => unknown }).require;
			return (req?.("electron") as ElectronBits) ?? null;
		} catch {
			return null;
		}
	}

	/** The session the in-app YouTube window uses.
	 *
	 *  Its own partition, deliberately: it persists (sign in once, not once per
	 *  capture), it is separate from Obsidian's own browsing so nothing else in
	 *  the app inherits the sign-in, and signing out is one clearStorageData
	 *  call rather than an attempt to pick cookies back out of a shared jar. */
	private youtubeSession(): YoutubeSession | null {
		const remote = this.electron()?.remote;
		if (!remote?.session) return null;
		return remote.session.fromPartition(YOUTUBE_PARTITION) as YoutubeSession;
	}

	/** Open YouTube in a window and let the user sign in. Resolves when they
	 *  close it, with whether a signed-in session came out of it. */
	async signInToYoutube(): Promise<boolean> {
		const remote = this.electron()?.remote;
		if (!remote?.BrowserWindow || !remote.session) {
			// say which half is missing: on mobile there is no Electron at all,
			// and on a desktop that withholds the remote module the answer is a
			// different one (the cookies file below still works)
			new Notice(
				this.electron()
					? "Power Assistant: this Obsidian does not let a plugin open a sign-in window. Use the cookies file setting instead."
					: "Power Assistant: signing in needs the desktop app.",
				12000
			);
			return false;
		}
		// Google will not accept a password typed into an embedded browser —
		// "this browser or app may not be secure" — and that check is there for
		// a good reason, so this does not try to look like something it is not.
		// It uses the flow Google built for exactly this case instead: YouTube's
		// TV interface, which shows a pairing code you approve in the browser
		// you already trust. Nothing is typed in here at all.
		const win = new remote.BrowserWindow({
			width: 1280,
			height: 760,
			title: "Sign in to YouTube — Power Assistant",
			autoHideMenuBar: true,
			// the same partition the cookies are later read from, and no Node in
			// it: this window loads a real website, and it gets no more power
			// than a browser tab would
			webPreferences: { partition: YOUTUBE_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
		});
		try {
			// the TV agent is what makes YouTube serve the pairing interface
			// rather than the ordinary site with its password form
			const ses = this.youtubeSession();
			ses?.setUserAgent?.(TV_USER_AGENT);
			await win.loadURL("https://www.youtube.com/tv", { userAgent: TV_USER_AGENT });
			new Notice(
				"Power Assistant: in that window choose Sign in, and YouTube will show a short code. Enter it at youtube.com/activate in your normal browser, then pick your account in the window and wait for YouTube's home screen before closing it.",
				20000
			);
			await new Promise<void>((resolve) => win.on("closed", () => resolve()));
		} catch (e) {
			console.warn("Power Assistant: the YouTube sign-in window failed.", e);
			try {
				win.destroy();
			} catch {
				/* already gone */
			}
			new Notice("Power Assistant: could not open the sign-in window. " + (e instanceof Error ? e.message : String(e)), 10000);
			return false;
		}
		const cookies = await this.youtubeCookies();
		new Notice(
			cookies.length
				? `Power Assistant: saved a YouTube session (${cookies.length} cookies). Press Test YouTube to see whether captures get through with it.`
				: "Power Assistant: that window left no session behind. If the sign-in did not finish, try again; the console lists what was there.",
			12000
		);
		return cookies.length > 0;
	}

	/** Whatever the sign-in window left behind, for YouTube and the Google
	 *  domains its sign-in actually lives on. */
	async youtubeCookies(): Promise<SessionCookie[]> {
		const ses = this.youtubeSession();
		if (!ses) return [];
		try {
			// the whole jar, filtered here. Asking the session for a domain means
			// matching on its terms, and a filter that quietly matches nothing
			// reads exactly like not being signed in — which is how a session
			// paired from the television looked absent when it was right there.
			const all = (await ses.cookies.get({})) as SessionCookie[];
			const mine = all.filter((c) => isYoutubeCookieDomain(c.domain));
			// diagnostics only: the names are worth having when a session does not
			// work, and no longer decide whether it is used
			if (!hasYoutubeLogin(mine))
				console.info(
					`Power Assistant: ${mine.length} YouTube cookies in that session (of ${all.length}), none named like a sign-in. Names: ${[...new Set(mine.map((c) => c.name))].join(", ") || "none"}`
				);
			return mine;
		} catch (e) {
			console.warn("Power Assistant: could not read the YouTube session cookies.", e);
			return [];
		}
	}

	/** Forget the in-app YouTube session entirely. */
	async signOutOfYoutube(): Promise<void> {
		const ses = this.youtubeSession();
		if (!ses) return;
		try {
			await ses.clearStorageData();
			new Notice("Power Assistant: signed out of YouTube.");
		} catch (e) {
			new Notice("Power Assistant: could not clear that session. " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/** The cookie arguments for a YouTube call, and the cleanup that goes with
	 *  them. The in-app sign-in wins; the exported file and the browser store
	 *  stay behind it for anyone who set them up before this existed.
	 *
	 *  The signed-in session is written to a temp file for the length of one
	 *  call and deleted afterwards, in a finally: it is a live login, and it has
	 *  no business outliving the download that needed it. */
	private async youtubeCookieArgs(): Promise<{ args: string[]; done: () => void }> {
		const fs = this.nodeFs();
		const os = this.nodeOs();
		const cookies = fs && os ? await this.youtubeCookies() : [];
		// Any session at all is worth handing over. This used to require a cookie
		// whose NAME was on a list of sign-in cookies, which put my guess about
		// how a sign-in looks in front of the one thing that can actually answer
		// it: a signed-in TV session with 19 cookies was refused because none of
		// them were named what I expected. yt-dlp and YouTube are the judges of
		// whether a session works, not a list in here.
		if (!fs || !os || !cookies.length) return { args: cookieArgs(this.settings.cookieBrowser, this.settings.cookieFile), done: () => {} };
		const path = `${os.tmpdir()}/pa-yt-cookies-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
		fs.writeFileSync(path, netscapeCookieFile(cookies), "utf8");
		return {
			args: ["--cookies", path],
			done: () => {
				try {
					fs.unlinkSync(path);
				} catch {
					/* already gone */
				}
			},
		};
	}

	/** yt-dlp's version, or a throw carrying the setup hint. Backs the Check
	 *  button, so "is this set up?" is answerable without capturing anything. */
	async ytDlpVersion(): Promise<string> {
		return (await this.runYtDlp(["--version"], 20_000)).trim();
	}

	/** Can this device read YouTube right now, with whatever cookies are set?
	 *
	 *  Worth its own button because the answer has nothing to do with being
	 *  signed in to YouTube in a browser — a capture goes out from Obsidian and
	 *  yt-dlp, neither of which shares the browser's cookie jar — and because
	 *  the wall comes and goes, so "try again later" needs something cheap to
	 *  try with. Asks for one public video's title and downloads nothing. */
	async youtubeReach(): Promise<string> {
		const cookies = await this.youtubeCookieArgs();
		try {
			const out = await this.runYtDlp(["--skip-download", "--no-playlist", "--no-warnings", "--print", "title", ...cookies.args, YOUTUBE_REACH_PROBE], 90_000);
			return out.trim().split("\n").filter(Boolean).pop() ?? "";
		} finally {
			cookies.done();
		}
	}

	/** A text-only post's own words, and the post it was answering or holding up.
	 *
	 *  yt-dlp refuses a post with no video, and x.com serves a logged-out client a
	 *  JavaScript shell rather than the words, so the page reader finds nothing
	 *  there either. Two endpoints still answer, and both are tried: the embed
	 *  payload first, because it alone carries the quoted and replied-to posts
	 *  that a quote-post's own words depend on, then oEmbed, which is documented
	 *  and stable and will still be there if the first is ever withdrawn.
	 *
	 *  The replies underneath are not reachable from either: X serves the
	 *  conversation only to a logged-in client. The reply count is captured
	 *  instead, so a note at least records how much discussion a post drew. */
	private async readTweetText(url: string): Promise<TweetRead | null> {
		const id = xStatusId(url);
		if (id) {
			try {
				const res = await requestUrl({ url: xSyndicationUrl(id), headers: { "User-Agent": WEB_UA }, throw: false });
				if (res.status < 400) {
					const read = parseTweetEmbed(res.json as TweetEmbed);
					if (read) return read;
				}
			} catch (e) {
				console.warn("Power Assistant: the X embed read failed; falling back to oEmbed.", e);
			}
		}
		try {
			const res = await requestUrl({ url: xOembedUrl(url), headers: { "User-Agent": WEB_UA }, throw: false });
			if (res.status >= 400) return null;
			return parseTweetOembed(res.json as TweetOembed);
		} catch (e) {
			console.warn("Power Assistant: the X oEmbed read failed.", e);
			return null;
		}
	}

	/** A video's title and caption text, read by yt-dlp rather than by asking
	 *  YouTube directly.
	 *
	 *  The direct route is one unauthenticated request, and YouTube increasingly
	 *  answers it with a polite 200 that carries nothing: the video looks like it
	 *  has no captions when what it has is a bot wall. yt-dlp knows more ways to
	 *  ask, and can present cookies. Null when it is not installed or comes back
	 *  with nothing, which leaves the caller's own diagnosis to stand.
	 *
	 *  Subtitles are downloaded rather than read from a caption URL because the
	 *  URLs YouTube hands a logged-out client return empty bodies. Uploaded
	 *  subtitles beat the automatic ones: same words, real punctuation. */
	private async youtubeViaYtDlp(url: string): Promise<{ info: YoutubeInfo | null; text: string } | null> {
		const fs = this.nodeFs();
		const os = this.nodeOs();
		if (!fs || !os) return null;
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const stem = `${os.tmpdir()}/pa-yt-${stamp}`;
		const written: string[] = [];
		try {
			const cookies = await this.youtubeCookieArgs();
			let printed: string;
			try {
				printed = await this.runYtDlp([...ytDlpSubsArgs(url, `${stem}.%(ext)s`), ...cookies.args], 5 * 60_000);
			} finally {
				cookies.done();
			}
			// the metadata line is the last thing printed; the subtitle writer's
			// own chatter comes before it
			const meta = parseYtDlpMeta(printed.trim().split("\n").filter(Boolean).pop() ?? "");
			const dir = os.tmpdir();
			const mine = (fs.readdirSync(dir) as string[]).filter((f) => f.startsWith(`pa-yt-${stamp}`) && f.endsWith(".vtt"));
			for (const f of mine) written.push(`${dir}/${f}`);
			// an uploaded track and an automatic one can land side by side, and the
			// filename does not say which is which. A human-written track reads
			// better, so it wins on content; between two of a kind, the longer one
			// is the more complete.
			let best = "";
			let bestAuto = true;
			for (const p of written) {
				const raw = fs.readFileSync(p, "utf8");
				const text = captionsToText(raw);
				if (!text) continue;
				const auto = looksAutoCaptioned(raw);
				if (!best || (bestAuto && !auto) || (bestAuto === auto && text.length > best.length)) {
					best = text;
					bestAuto = auto;
				}
			}
			return best || meta ? { info: meta, text: best } : null;
		} catch (e) {
			if (!(e instanceof YtDlpMissing)) console.warn("Power Assistant: the yt-dlp caption fallback failed.", e);
			return null;
		} finally {
			for (const p of written)
				try {
					fs.unlinkSync(p);
				} catch {
					/* already gone */
				}
		}
	}

	/** Download a post's audio with yt-dlp and transcribe it.
	 *
	 *  Three outcomes, and the caller needs all three kept apart: the transcript,
	 *  "" for audio that carried no speech (a reaction clip, music over a still),
	 *  and null for a real failure, already reported. Collapsing the last two is
	 *  what made a speechless clip vanish without a word.
	 *
	 *  yt-dlp writes to the OS temp directory rather than straight into the vault:
	 *  it writes behind Obsidian's back, so a file landing in a watched folder
	 *  would race the auto-processor. The bytes are then handed to the vault the
	 *  same way a YouTube capture hands over what it downloaded, which keeps both
	 *  on one transcription path. */
	private async transcribeMediaAudio(url: string, provider: TranscriptionProvider): Promise<string | null> {
		const fs = this.nodeFs();
		const os = this.nodeOs();
		if (!fs || !os) {
			new Notice("Power Assistant: capturing a video or post needs the desktop app.");
			return null;
		}
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		let downloaded: string | null = null;
		let tmp: TFile | null = null;
		let tmpPath = "";
		try {
			new Notice("Power Assistant: downloading the audio…");
			const printed = await this.runYtDlp(ytDlpAudioArgs(url, `${os.tmpdir()}/pa-x-${stamp}.%(ext)s`, this.settings.cookieBrowser, this.settings.cookieFile), 15 * 60_000);
			downloaded = printed.trim().split("\n").filter(Boolean).pop() ?? null;
			if (!downloaded || !fs.existsSync(downloaded)) {
				new Notice("Power Assistant: yt-dlp reported no audio file for that post.");
				return null;
			}
			const buf = fs.readFileSync(downloaded);
			if (provider === "whisper") {
				const warn = whisperSizeWarning(buf.byteLength, this.settings.transcriptionEndpoint);
				if (warn) {
					new Notice("Power Assistant: " + warn, 12000);
					return null;
				}
			}
			const ext = (downloaded.slice(downloaded.lastIndexOf(".") + 1).toLowerCase() || "mp4").replace(/[^a-z0-9]/g, "");
			tmpPath = normalizePath(`${this.recordingFolder()}/x-${stamp}.${ext}`);
			await this.ensureFolder(this.recordingFolder());
			this.directProcess.add(tmpPath); // the create event must not auto-process this temp
			tmp = await this.app.vault.createBinary(tmpPath, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
			new Notice("Power Assistant: transcribing the audio…");
			// a diarizing provider can put the words only in utterances, so the
			// joined form is the honest test of "was there any speech"
			const r = await this.transcribeFile(tmp, provider);
			return (r.text.trim() || (r.utts ?? []).map((u) => u.text).join(" ").trim()) ?? "";
		} catch (e) {
			console.warn("Power Assistant: the audio capture failed.", e);
			new Notice("Power Assistant: could not capture that post's audio. " + (e instanceof Error ? e.message : String(e)), 12000);
			return null;
		} finally {
			if (tmpPath) this.directProcess.delete(tmpPath);
			if (tmp)
				try {
					await this.app.vault.trash(tmp, true);
				} catch {
					/* already gone */
				}
			if (downloaded)
				try {
					fs.unlinkSync(downloaded);
				} catch {
					/* yt-dlp may have cleaned it up already */
				}
		}
	}

	/** Run the extraction over captured text and assemble the note, the part every
	 *  link capture does identically once it has words to work with. A failed
	 *  extraction never costs the text: the note is written with it anyway. */
	private async writeCapture(o: {
		url: string;
		title: string;
		text: string;
		folder: string;
		notePath: string;
		extractions: Record<ExtractionKey, boolean>;
		includeText: boolean;
		props: { key: string; value: string }[];
		heading?: string;
		/** The captured text IS the content, so it leads the note. */
		leadWithText?: boolean;
	}) {
		const s = this.settings;
		const text = s.corrections.length ? applyCorrections(o.text, s.corrections) : o.text;
		let body: string | null = null;
		let extractionError: string | null = null;
		// nothing to extract from is not an extraction failure: the captured text is
		// the whole note. Asking anyway spends a call to be told, in the note's own
		// Summary, that a URL cannot be summarized
		if (this.llmReady() && hasWordsToExtract(text)) {
			new Notice("Power Assistant: extracting notes…");
			// never lose good text: if extraction fails, still write the note with the
			// text and the error, like the meeting flow does
			try {
				body = await withRetry(() => this.extract(text, o.extractions));
			} catch (e) {
				extractionError = humanizeError(e instanceof Error ? e.message : String(e));
				new Notice("Power Assistant: extraction failed; saving what was captured. Run Re-extract to retry. " + extractionError, 12000);
			}
		}
		await this.ensureFolder(o.folder);
		const note = assembleNote({
			title: o.title,
			date: today(),
			source: o.url,
			embed: null,
			body,
			transcript: text,
			includeTranscript: o.includeText,
			model: body ? this.llmModelName() : null,
			extractionError,
			props: o.props,
			transcriptHeading: o.heading,
			leadWithText: o.leadWithText,
			filename: o.notePath,
		});
		await this.writeNote(o.notePath, o.folder, note);
	}

	/** Capture any site yt-dlp handles. One method serves all of them because
	 *  yt-dlp normalizes its metadata across every extractor; the site only
	 *  decides the label and where the note files itself. */
	async captureMedia(url: string) {
		url = ensureUrlScheme(url);
		const s = this.settings;
		try {
			const site = mediaSiteFor(url);
			new Notice("Power Assistant: reading the post…");

			// A post is its words; the audio is a bonus. yt-dlp only knows about the
			// bonus, and refuses a post that has none, so its refusal routes here
			// rather than ending the capture.
			let info: MediaInfo;
			let postText = "";
			let hasAudio = true;
			// a post read without yt-dlp explains itself differently when it turns out
			// to have nothing to say: the words are missing because it has none, and
			// the speech is missing because the program that fetches it is not here
			let ytDlpAbsent = false;
			let postHasVideo = false;
			try {
				const out = await this.runYtDlp(ytDlpInfoArgs(url, s.cookieBrowser, s.cookieFile), 90_000);
				const dump = JSON.parse(out.trim().split("\n")[0] || "{}") as MediaDump;
				info = parseMediaInfo(dump, site?.label);
				postText = (dump.description ?? "").trim();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				// A missing yt-dlp costs the audio, not the post. Most posts are words,
				// and the words come from elsewhere, so this joins the "nothing to play"
				// route rather than ending a capture that never needed the program.
				const absent = e instanceof YtDlpMissing;
				if (!absent && !NO_MEDIA_RE.test(msg)) {
					new Notice("Power Assistant: could not read that link. " + msg, 12000);
					return;
				}
				hasAudio = false;
				ytDlpAbsent = absent;
				const read = site?.id === "x" ? await this.readTweetText(url) : null;
				if (!read) {
					// Every other site: hand it to the page reader, which is what a link
					// with nothing to play usually wanted anyway.
					new Notice(absent ? "Power Assistant: yt-dlp is not installed, so reading it as a page instead…" : "Power Assistant: nothing to play there, reading it as a page instead…", 8000);
					return this.captureWeb(url);
				}
				// the words are saved either way, but a post carrying video quietly loses
				// its transcript here, and the user is owed the reason. A post with no
				// words of its own has nothing left to save, and says so below instead.
				if (absent && read.text) new Notice("Power Assistant: saving the post's text. " + YTDLP_HINT, 12000);
				info = read.info;
				postText = read.text;
				postHasVideo = read.hasVideo === true;
			}

			// only matters when there is audio: a text post costs no transcription
			const provider = this.providerFor("media");
			if (hasAudio && !this.providerReady(provider)) {
				new Notice(`Power Assistant: set the ${provider} API key in settings before capturing a video or post.`, 10000);
				return;
			}

			// A post that is all video and no words comes back looking like a one-line
			// post whose line is the link X appends to its own media. There is nothing
			// there to file, and saying so is the whole answer: with yt-dlp installed
			// this same post captures fine, because the words are in the audio. Asked
			// before the folder and the note path, which are answers to a question that
			// no longer arises.
			if (!hasAudio && !postText.trim()) {
				new Notice(
					!ytDlpAbsent
						? "Power Assistant: that post has no video and no words of its own, so there is nothing to capture."
						: postHasVideo
							? "Power Assistant: that post is a video with no words of its own, so its audio is the only thing to capture, and that needs yt-dlp. " + YTDLP_HINT
							: "Power Assistant: that post has no words of its own. If it carries a video, capturing it needs yt-dlp. " + YTDLP_HINT,
					ytDlpAbsent ? 14000 : 10000,
				);
				return;
			}

			const label = info.site ?? "";
			const folder = renderFolder(s.mediaFolder, label) || s.outputFolder;
			// checked before the download rather than after it: transcribing spends
			// credits worth keeping for a note that does not exist yet
			const where = this.captureNotePath(folder, renderMeetingFilename(s.mediaFilename, info.title, today(), label), url);
			if ("duplicate" in where) {
				new Notice(`Power Assistant: this post is already captured (see ${where.duplicate.basename}.`, 8000);
				return;
			}
			const notePath = where.path;

			let text = postText;
			let spoken = false;
			if (hasAudio) {
				const transcript = await this.transcribeMediaAudio(url, provider);
				if (transcript === null) return; // a real failure, already reported
				if (transcript) {
					text = transcript;
					spoken = true;
				} else if (postText) {
					// a clip with no speech (a reaction video, music over a still) is
					// ordinary, not a failure, and the post's own words are still the point
					new Notice("Power Assistant: no speech in that video, so the post's own text was saved instead.", 10000);
				}
			}
			// the wordless case was settled above; this one is a video that turned out
			// to have no speech in it either, which is only knowable after transcribing
			if (!text.trim()) {
				new Notice("Power Assistant: that post has no speech and no text, so there is nothing to capture.", 10000);
				return;
			}
			await this.writeCapture({
				url,
				title: info.title,
				text,
				folder,
				notePath,
				// a video gets the full set; two sentences of text get the three
				// sections that can say anything about two sentences
				extractions: spoken ? s.mediaExtractions : postExtractions(s.mediaExtractions),
				// a transcript is a by-product and follows that setting; a post's own
				// words are the content itself, so dropping them would empty the note
				includeText: spoken ? s.includeTranscript : true,
				props: mediaProps(info),
				heading: spoken ? undefined : "Post",
				// and being the content, they lead the note: a post is a sentence or
				// two, and reading it should not mean scrolling past a summary of it.
				// A video's transcript is long, and stays under the notes about it.
				leadWithText: !spoken,
			});
		} catch (e) {
			console.error("Power Assistant:", e);
			new Notice("Power Assistant failed: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/* ---------------- web page capture ---------------- */

	/** Read a page down to its article text.
	 *
	 *  Readability is what Firefox's Reader View runs, and it wants a real
	 *  Document, which Obsidian has because the renderer is Chromium. It also
	 *  mutates the document it is handed, so this parses its own copy. Turndown
	 *  then converts the article HTML it returns into Markdown, which is what the
	 *  vault actually wants to store: searchable, editable, and diffable, rather
	 *  than a wall of tags. */
	private readArticle(html: string, url: string): { title: string; markdown: string; info: WebInfo } | null {
		const doc = new DOMParser().parseFromString(html, "text/html");
		// Readability resolves relative links against the document's base, which a
		// string parsed out of thin air does not have, so links would otherwise
		// come out pointing nowhere
		if (!doc.querySelector("base")) {
			const base = doc.createElement("base");
			base.setAttribute("href", url);
			doc.head?.appendChild(base);
		}
		const meta = parseWebMeta(html);
		const article = new Readability(doc).parse();
		const title = (article?.title || meta.title || siteNameFromUrl(url)).trim();
		if (!article?.content) return null;
		const markdown = cleanArticleMarkdown(this.turndown().turndown(article.content), title);
		if (markdown.trim().length < MIN_ARTICLE_CHARS) return null;
		// Readability finds a byline and site name on well-marked pages; the meta
		// tags cover the rest, and the host is the last resort for a site name
		const info: WebInfo = {
			title,
			site: meta.site || article.siteName || siteNameFromUrl(url),
			author: meta.author || article.byline || undefined,
			published: meta.published || (article.publishedTime ?? "").slice(0, 10) || undefined,
		};
		if (info.author) info.author = info.author.replace(/^\s*by\s+/i, "").trim() || undefined;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(info.published ?? "")) info.published = undefined;
		return { title, markdown, info };
	}

	/** One Turndown for every article path, so a page read through a site's own
	 *  API produces the same Markdown as one read off its HTML. */
	private turndown(): TurndownService {
		return new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	}

	/** MSN serves a script shell, so the page reader has nothing to read. Its
	 *  article text comes from MSN's own content API instead, keyed by the id in
	 *  the URL. Returns null on anything unexpected, which drops the capture back
	 *  onto the ordinary reader rather than failing outright. */
	private async readMsn(url: string): Promise<{ title: string; markdown: string; info: WebInfo; canonical?: string } | null> {
		const ref = msnArticleRef(url);
		if (!ref) return null;
		try {
			const res = await requestUrl({ url: msnApiUrl(ref), headers: { "User-Agent": WEB_UA, Accept: "application/json" }, throw: false });
			if (res.status !== 200) return null;
			const read = parseMsnArticle(res.json);
			if (!read) return null;
			const markdown = cleanArticleMarkdown(this.turndown().turndown(read.html), read.title);
			if (markdown.trim().length < MIN_ARTICLE_CHARS) return null;
			return { title: read.title, markdown, info: read.info, canonical: read.canonical };
		} catch {
			return null;
		}
	}

	/** Capture a web page as an article note. No audio and no yt-dlp, so this
	 *  costs no transcription at all: the only paid step is the extraction, and
	 *  even that is optional. */
	async captureWeb(url: string) {
		url = ensureUrlScheme(url);
		try {
			new Notice("Power Assistant: reading the page…");
			// MSN is read through its own API; the note then records the original
			// article rather than the feed link that led to it
			const msn = await this.readMsn(url);
			if (msn) return this.writeArticle(msn.canonical ?? url, msn.title, msn.markdown, msn.info);
			let html = "";
			try {
				// a browser-ish User-Agent, because a fair number of publishers serve a
				// stub or a block page to anything that looks automated
				const res = await requestUrl({
					url,
					headers: { "User-Agent": WEB_UA, Accept: "text/html,application/xhtml+xml" },
					throw: false,
				});
				if (res.status >= 400) {
					new Notice(`Power Assistant: that page returned ${res.status}.`, 10000);
					return;
				}
				html = res.text ?? "";
			} catch (e) {
				new Notice("Power Assistant: could not fetch that page. " + (e instanceof Error ? e.message : String(e)), 12000);
				return;
			}
			if (!html.trim()) {
				new Notice("Power Assistant: that page came back empty.");
				return;
			}
			const read = this.readArticle(html, url);
			if (!read) {
				new Notice("Power Assistant: could not find an article on that page. If it is a video, run the capture again and choose Video.", 12000);
				return;
			}
			await this.writeArticle(url, read.title, read.markdown, read.info);
		} catch (e) {
			console.error("Power Assistant:", e);
			new Notice("Power Assistant failed: " + (e instanceof Error ? e.message : String(e)), 8000);
		}
	}

	/** File a read article, however it was read: the site's folder and filename
	 *  patterns, the duplicate check, then the note itself. */
	private async writeArticle(url: string, title: string, markdown: string, info: WebInfo) {
		const s = this.settings;
		const site = info.site ?? "";
		const folder = renderFolder(s.webFolder, site) || s.outputFolder;
		const where = this.captureNotePath(folder, renderMeetingFilename(s.webFilename, title, today(), site), url);
		if ("duplicate" in where) {
			new Notice(`Power Assistant: this page is already captured (see ${where.duplicate.basename}.`, 8000);
			return;
		}
		const notePath = where.path;
		await this.writeCapture({
			url,
			title,
			text: markdown,
			folder,
			notePath,
			extractions: s.webExtractions,
			includeText: s.webIncludeArticle,
			props: webProps(info),
			heading: "Article",
		});
	}

	/** The one front door: send a pasted link wherever it belongs. `force` is the
	 *  dialog's override, for the blog that is really a video and the video site
	 *  the router has never heard of. */
	async captureLink(url: string, force: CaptureRoute | "auto" = "auto") {
		url = ensureUrlScheme(url);
		const route = force === "auto" ? routeFor(url) : force;
		if (route === "youtube") return this.captureYoutube(url);
		if (route === "media") return this.captureMedia(url);
		return this.captureWeb(url);
	}

	/* ---------------- ask-your-vault ---------------- */

	private indexedFolders(): string[] {
		const folders = this.settings.indexFolders
			.split(",")
			.map((f) => normalizePath(f.trim()))
			.filter((f) => f.length && f !== ".");
		const base = folders.length ? folders : [normalizePath(this.settings.outputFolder)];
		// mail is imported precisely so it can be asked about, so its folder is
		// always indexed; leaving that to the user means a silent corpus that
		// answers nothing and gives no clue why
		return coverIndexFolders(base, this.settings.mailImportFolder.trim());
	}

	private indexable(path: string): boolean {
		if (!path.endsWith(".md")) return false;
		return this.indexedFolders().some((f) => f === "/" || path === f || path.startsWith(f + "/"));
	}

	private indexStorePath(): string {
		return `${this.manifest.dir}/search-index.json`;
	}

	private async loadIndex() {
		try {
			const raw = await this.app.vault.adapter.read(this.indexStorePath());
			const data = JSON.parse(raw) as { v: number; files: Record<string, { mtime: number; chunks: Chunk[] }> };
			for (const [path, f] of Object.entries(data.files ?? {})) {
				this.index.addFile(path, f.chunks);
				this.indexMeta[path] = f.mtime;
				this.indexChunks[path] = f.chunks;
			}
		} catch {
			/* first run — no index yet */
		}
	}

	/** Bring the index in line with the vault: (re)index new or changed notes in
	 *  the configured folders, drop notes that left them. Returns the file count. */
	async syncIndex(force: boolean): Promise<number> {
		const current = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.indexable(file.path)) continue;
			current.add(file.path);
			if (force || this.indexMeta[file.path] !== file.stat.mtime) await this.indexFile(file, true);
		}
		for (const path of Object.keys(this.indexMeta)) {
			if (!current.has(path)) this.dropFromIndex(path);
		}
		this.schedulePersist();
		return current.size;
	}

	private async indexFile(file: TFile, quiet = false) {
		try {
			const chunks = chunkNote(await this.app.vault.cachedRead(file));
			this.index.addFile(file.path, chunks);
			this.indexMeta[file.path] = file.stat.mtime;
			this.indexChunks[file.path] = chunks;
			if (!quiet) this.schedulePersist();
		} catch (e) {
			console.warn("Power Assistant: failed to index", file.path, e);
		}
	}

	private dropFromIndex(path: string) {
		this.index.removeFile(path);
		delete this.indexMeta[path];
		delete this.indexChunks[path];
		this.schedulePersist();
	}

	private schedulePersist() {
		if (this.persistTimer) window.clearTimeout(this.persistTimer);
		this.persistTimer = window.setTimeout(() => {
			this.persistTimer = null;
			const files: Record<string, { mtime: number; chunks: Chunk[] }> = {};
			for (const [path, mtime] of Object.entries(this.indexMeta)) {
				files[path] = { mtime, chunks: this.indexChunks[path] ?? [] };
			}
			void this.app.vault.adapter.write(this.indexStorePath(), JSON.stringify({ v: 1, files }));
		}, 2000);
	}

	/** Vault-wide retrieval shared by Ask and the sidebar assistant. When Power
	 *  Explorer is installed, its vault-wide index answers (one shared index,
	 *  PDF pages and OCR'd screenshots included); this plugin's own scoped
	 *  index is the fallback. */
	vaultHits(terms: string[], k: number): { path: string; heading: string; text: string }[] {
		const px = (
			this.app as unknown as {
				plugins?: {
					plugins?: Record<
						string,
						{ search?: { retrieve?: (terms: string[], k: number) => { path: string; heading: string; text: string }[] } }
					>;
				};
			}
		).plugins?.plugins?.powerexplorer?.search;
		const viaExplorer = typeof px?.retrieve === "function" ? px.retrieve(terms, k) : null;
		const notes = viaExplorer?.length ? viaExplorer : this.index.search(terms, k);
		// fold in the rolling mail window when it is on, so Ask answers from
		// recent email as well as notes; mail hits carry an email: path so the
		// answer layer can cite them back to Outlook
		if (!this.mailWindowEnabled() || !this.mailMeta.size) return notes;
		const mail = this.mailHits(terms, Math.max(4, Math.ceil(k / 2)));
		return [...notes, ...mail].slice(0, k + mail.length);
	}

	/* ---------------- semantic search (opt-in embeddings) ---------------- */

	semanticEnabled(): boolean {
		return !!this.settings.embeddingsEndpoint.trim();
	}

	private embedStorePath(): string {
		return `${this.manifest.dir}/embeddings.json`;
	}

	/** Embed one or more texts through the configured OpenAI-compatible endpoint.
	 *  Returns [] on any failure so semantic search degrades to keyword-only. */
	async embedTexts(texts: string[]): Promise<number[][]> {
		const s = this.settings;
		const base = s.embeddingsEndpoint.trim().replace(/\/+$/, "");
		if (!base || !texts.length) return [];
		const url = /\/embeddings$/.test(base) ? base : `${base}/embeddings`;
		try {
			// timeboxed: a hung or unreachable endpoint must never block an Ask or
			// chat answer (the query embed sits on the retrieval path)
			const r = await withTimeout(
				requestUrl({
					url,
					method: "POST",
					contentType: "application/json",
					headers: s.embeddingsKey.trim() ? { Authorization: `Bearer ${s.embeddingsKey.trim()}` } : {},
					body: JSON.stringify({ model: s.embeddingsModel.trim() || "nomic-embed-text", input: texts }),
					throw: false,
				}),
				15_000
			);
			if (r === "pcap-timeout") {
				console.warn("Power Assistant: embeddings request timed out; falling back to keyword search.");
				return [];
			}
			if (r.status >= 400) {
				console.warn("Power Assistant: embeddings request failed", r.status, r.text?.slice(0, 200));
				return [];
			}
			return parseEmbeddingResponse(r.json);
		} catch (e) {
			console.warn("Power Assistant: embeddings endpoint unreachable.", e);
			return [];
		}
	}

	/** The text embedded for a note: its title plus the indexed chunk text,
	 *  capped so a long transcript does not dominate the vector. */
	private embedText(path: string): string {
		const chunks = this.indexChunks[path] ?? [];
		const title = path.split("/").pop()?.replace(/\.md$/, "") ?? "";
		return `${title}\n${chunks.map((c) => c.text).join("\n")}`.slice(0, 8000);
	}

	/** Bring embeddings in line with the index: embed notes that are new or
	 *  changed, drop notes that left the index. Batched and best-effort. */
	async syncEmbeddings(force = false): Promise<void> {
		if (!this.semanticEnabled() || this.embedding) return;
		this.embedding = true;
		try {
			// drop vectors for notes that left the index (persisted below either way)
			for (const p of Object.keys(this.embeds)) if (!(p in this.indexMeta)) delete this.embeds[p];
			const todo = Object.keys(this.indexMeta).filter((p) => force || this.embeds[p]?.mtime !== this.indexMeta[p]);
			if (todo.length) {
				const job = this.startJob("Building embeddings", todo.length);
				let stopped = "";
				for (let i = 0; i < todo.length; i += 32) {
					const batch = todo.slice(i, i + 32);
					const vecs = await this.embedTexts(batch.map((p) => this.embedText(p)));
					if (vecs.length !== batch.length) {
						stopped = "embeddings stopped (endpoint error). Keyword search still works.";
						break;
					}
					batch.forEach((p, j) => (this.embeds[p] = { mtime: this.indexMeta[p], vec: vecs[j] }));
					job.tick(Math.min(i + 32, todo.length));
				}
				job.done(stopped || `embedded ${Object.keys(this.embeds).length} notes`);
			}
			this.scheduleEmbedPersist();
		} finally {
			this.embedding = false;
		}
	}

	/** Semantic hits for a query: embed it, cosine against the stored note
	 *  vectors, top-k, mapped to the shared hit shape. Empty when off or the
	 *  query cannot be embedded. */
	private async semanticHits(query: string, k: number): Promise<{ path: string; heading: string; text: string }[]> {
		const paths = Object.keys(this.embeds);
		if (!this.semanticEnabled() || !paths.length) return [];
		const [qv] = await this.embedTexts([query]);
		if (!qv?.length) return [];
		return paths
			.map((p) => ({ p, score: cosine(qv, this.embeds[p].vec) }))
			.filter((x) => x.score > 0.2)
			.sort((a, b) => b.score - a.score)
			.slice(0, k)
			.map((x) => ({ path: x.p, heading: "", text: (this.indexChunks[x.p]?.[0]?.text ?? "").slice(0, 1200) }));
	}

	/** Keyword and (when enabled) meaning, fused: the retrieval behind Ask and
	 *  the assistant chat. Falls back to keyword-only if embeddings are off. */
	async hybridHits(query: string, terms: string[], k: number): Promise<{ path: string; heading: string; text: string }[]> {
		const bm25 = this.vaultHits(terms, k);
		if (!this.semanticEnabled()) return bm25;
		const sem = await this.semanticHits(query, k);
		return sem.length ? fuseHits([bm25, sem], k) : bm25;
	}

	private scheduleEmbedPersist() {
		if (this.embedTimer) window.clearTimeout(this.embedTimer);
		this.embedTimer = window.setTimeout(() => {
			this.embedTimer = null;
			void this.app.vault.adapter.write(this.embedStorePath(), JSON.stringify({ v: 1, model: this.settings.embeddingsModel, embeds: this.embeds }));
		}, 2000);
	}

	private async loadEmbeddings() {
		try {
			const raw = await this.app.vault.adapter.read(this.embedStorePath());
			const data = JSON.parse(raw) as { model?: string; embeds?: Record<string, { mtime: number; vec: number[] }> };
			// a model change invalidates every vector (dimensions/space differ)
			if (data.model === this.settings.embeddingsModel) this.embeds = data.embeds ?? {};
		} catch {
			/* no embeddings yet */
		}
	}

	/** Question → Claude expands it into search terms → BM25 retrieval → Claude
	 *  answers from the winning excerpts with [[wiki-link]] citations. Optional
	 *  filters narrow to a date window or an attendee before answering. */
	/** Retrieval for every ask surface, filters included.
	 *
	 *  Shared rather than copied: the chat and askVault must agree about what
	 *  a question can see, and a filter that works in one place and not the
	 *  other is worse than no filter. Filtering widens the net first (a date
	 *  window or one attendee can cut a page of hits to nothing) and trims back
	 *  to twelve afterwards. */
	async retrieveFiltered(
		question: string,
		terms: string[],
		filters?: { after?: string | null; attendee?: string | null }
	): Promise<{ path: string; heading: string; text: string }[]> {
		const filtering = !!(filters?.after || filters?.attendee);
		const hits = await this.hybridHits(question, terms, filtering ? 40 : 12);
		if (!filtering) return hits;
		return filterHitsByMeta(
			hits,
			(p) => {
				const af = this.app.vault.getAbstractFileByPath(p);
				if (!(af instanceof TFile)) return null;
				const fm = this.app.metadataCache.getFileCache(af)?.frontmatter as { date?: unknown; attendees?: unknown } | undefined;
				if (!fm) return null;
				return {
					date: String(fm.date ?? "").slice(0, 10) || undefined,
					attendees: Array.isArray(fm.attendees) ? (fm.attendees as unknown[]).map(personName) : undefined,
				};
			},
			filters ?? {}
		).slice(0, 12);
	}
	async askVault(
		question: string,
		filters?: { after?: string | null; attendee?: string | null }
	): Promise<{ answer: string; hits: number }> {
		if (!this.llmReady()) throw new Error(this.llmMissingMsg());
		const anthropic = this.llmClient();
		const model = this.llmModelName();
		const expansion = await anthropic.messages.create({
			model,
			max_tokens: 300,
			system: "You generate search keywords. Reply with one term per line, nothing else.",
			messages: [
				{
					role: "user",
					content: `List 12 short search terms (synonyms, related concepts, likely note wording) for finding notes that answer: "${question}"`,
				},
			],
		});
		this.logLlmUsage("ask", model, expansion.usage?.input_tokens ?? 0, expansion.usage?.output_tokens ?? 0);
		const expanded = parseSearchTerms(
			expansion.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n")
		);
		const terms = [...tokenize(question), ...expanded.flatMap((t) => tokenize(t))];
		const hits = await this.retrieveFiltered(question, terms, filters);
		if (!hits.length) return { answer: "*No matching notes in the index. Check the indexed folders in settings, widen the filters, or run “Rebuild the Ask index”.*", hits: 0 };
		const { system, user } = buildAskPrompt(question, hits);
		const msg = await anthropic.messages.create({
			model,
			max_tokens: 2000,
			system,
			messages: [{ role: "user", content: user }],
		});
		this.logLlmUsage("ask", model, msg.usage?.input_tokens ?? 0, msg.usage?.output_tokens ?? 0);
		const raw = msg.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		// mail citations point at synthetic email: paths; turn them into links
		// back to Outlook so they are not dead wiki-links
		const answer = this.mailMeta.size ? linkifyMailCitations(raw, (id) => this.mailMeta.get(id) ?? null) : raw;
		return { answer, hits: hits.length };
	}

	/* ---------------- shared ---------------- */

	/** The folder recordings are written to: the dedicated audio folder when
	 *  set, otherwise the capture folder (so an empty setting is unchanged). */
	private recordingFolder(): string {
		return resolveRecordingFolder(this.settings.audioFolder, this.settings.captureFolder);
	}

	/** Where person pages live: attendee links are qualified into this folder
	 *  (so clicking a not-yet-created name lands there) and person reports are
	 *  written to it. Empty setting = People under the output folder. */
	peopleFolderPath(): string {
		return cleanFolderPath(this.settings.peopleFolder) || `${this.settings.outputFolder}/People`;
	}

	/** Folders whose new audio auto-processes: the capture (watch) folder plus
	 *  the recordings folder when it differs. Recovery scans the same set, so
	 *  recordings that predate the setting (still in the capture folder) are
	 *  found alongside new ones. */
	private recordingWatchFolders(): string[] {
		const cap = normalizePath(this.settings.captureFolder);
		const rec = normalizePath(this.recordingFolder());
		return rec === cap ? [cap] : [cap, rec];
	}

	/** A stable, human-scannable name for this device ("pc-4f2a"), minted once
	 *  into per-device storage. Claims and progress lines carry it so the fleet
	 *  can see who is doing what. */
	deviceName(): string {
		let name = this.app.loadLocalStorage("pa-device-name") as string | null;
		if (!name) {
			const kind = Platform.isIosApp ? "iphone" : Platform.isAndroidApp ? "android" : Platform.isMacOS ? "mac" : "pc";
			name = `${kind}-${Math.random().toString(36).slice(2, 6)}`;
			this.app.saveLocalStorage("pa-device-name", name);
		}
		return name;
	}

	/** What the file at an output path is, queue-wise: a finished note, our own
	 *  working stub, a live rival's stub, a stale stub whose device died, or a
	 *  failed run waiting for a person. Decides who may (re)take the path. */
	private stubState(file: TFile): "note" | "mine" | "claimed-other" | "stale" | "failed" {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const state = pendingState(fm, Date.now());
		if (state === "failed") return "failed";
		if (state === "claimed") return fm?.["pa-claimed"] === this.deviceName() ? "mine" : "claimed-other";
		if (state === "stale") return "stale";
		return "note"; // no queue marker: a real, finished note
	}

	private stubBody(): string {
		const me = this.deviceName();
		return `---\npa-status: processing\npa-claimed: ${me}\npa-claimed-at: ${Date.now()}\n---\n\nPower Assistant is transcribing this recording on ${me}. This page fills in when it finishes.\n`;
	}

	/** Claim a standalone recording by creating its output note as a stub: the
	 *  stub syncs, and every other device's "note already exists" check bows
	 *  out. Our own stub and a stale one (a processor that died mid-job) are
	 *  re-stamped and taken; the settle pause then catches the near-tie where
	 *  two devices stubbed before either sync landed. */
	private async claimByStub(notePath: string, folder: string): Promise<boolean> {
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			const st = this.stubState(existing);
			if (st !== "mine" && st !== "stale") return false;
			await this.app.vault.process(existing, () => this.stubBody());
		} else {
			try {
				await this.ensureFolder(folder);
				await this.app.vault.create(notePath, this.stubBody());
			} catch {
				return false; // someone's note (or faster stub) got there first
			}
		}
		await sleep(CLAIM_SETTLE_MS);
		return this.ownsStub(notePath);
	}

	/** Whether the note at this path is OUR working stub (and not a finished
	 *  note, or a rival's stub that sync merged in over ours). */
	private async ownsStub(notePath: string): Promise<boolean> {
		const af = this.app.vault.getAbstractFileByPath(notePath);
		if (!(af instanceof TFile)) return false;
		const md = await this.app.vault.cachedRead(af);
		return md.includes("\npa-status: processing\n") && md.includes(`\npa-claimed: ${this.deviceName()}\n`);
	}

	/** A claimed run that cannot finish turns its stub into a visible failed
	 *  note instead of vanishing: the sweep skips failed items (no poison-file
	 *  retry loop), the error is written where the note would have been, and
	 *  deleting that page is the retry. No-op if the stub is not ours. */
	private async failStub(notePath: string, reason: string) {
		if (!(await this.ownsStub(notePath))) return;
		const af = this.app.vault.getAbstractFileByPath(notePath);
		if (!(af instanceof TFile)) return;
		const msg = reason.replace(/\s+/g, " ").trim();
		await this.app.vault
			.process(
				af,
				() =>
					`---\npa-status: failed\n---\n\n> [!warning] Processing failed\n> ${msg}\n\nThe audio is untouched. Delete this page and run "Process the active audio file" on the recording to retry (or let the sweep retry after you delete it).\n`
			)
			.catch((e) => console.warn("Power Assistant: could not mark the failed run.", e));
	}

	private async writeNote(notePath: string, folder: string, note: string) {
		await this.ensureFolder(folder);
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		if (existing instanceof TFile) {
			// the claim stub becomes the real note; a stub that stopped being
			// ours mid-job means another device took over, and its result (not
			// ours) is the one this path keeps
			if (!(await this.ownsStub(notePath))) {
				new Notice("Power Assistant: another device finished this recording first; leaving its note in place.");
				return;
			}
			await this.app.vault.process(existing, () => note);
			new Notice(`Power Assistant: created ${existing.basename}.`);
			await this.app.workspace.getLeaf(false).openFile(existing);
			return;
		}
		const created = await this.app.vault.create(notePath, note);
		new Notice(`Power Assistant: created ${created.basename}.`);
		await this.app.workspace.getLeaf(false).openFile(created);
	}

	private async ensureFolder(path: string) {
		const p = normalizePath(path);
		if (this.app.vault.getAbstractFileByPath(p) instanceof TFolder) return;
		await this.app.vault.createFolder(p).catch(() => {});
	}

	private stashSecrets() {
		const out: Record<string, unknown> = {};
		const s = this.settings as unknown as Record<string, unknown>;
		for (const k of DEVICE_KEYS) out[k] = s[k];
		this.app.saveLocalStorage("pa-secrets", JSON.stringify(out));
	}

	private overlaySecrets(target: PowerAssistantSettings) {
		const raw = this.app.loadLocalStorage("pa-secrets") as string | null;
		if (!raw) return;
		try {
			const sec = JSON.parse(raw) as Record<string, unknown>;
			const t = target as unknown as Record<string, unknown>;
			for (const k of DEVICE_KEYS) if (k in sec) t[k] = sec[k];
		} catch {
			/* unreadable stash; re-entering the keys recreates it */
		}
	}

	private redactForFile(s: PowerAssistantSettings): PowerAssistantSettings {
		const out = structuredClone(s) as unknown as Record<string, unknown>;
		for (const k of DEVICE_KEYS) out[k] = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k];
		return out as unknown as PowerAssistantSettings;
	}

	private stripSecrets(disk: Partial<PowerAssistantSettings> | null): Partial<PowerAssistantSettings> | null {
		if (!disk) return null;
		const d = { ...disk } as Record<string, unknown>;
		for (const k of DEVICE_KEYS) delete d[k];
		return d as Partial<PowerAssistantSettings>;
	}

	/**
	 * Take on new settings CONTENTS without swapping the object.
	 *
	 * Settings tabs and modals capture this object once (`const s =
	 * plugin.settings`, then `s.key = v`), so replacing it strands every one of
	 * those writes on an orphan and the setting silently stops sticking. Every
	 * assignment to this.settings goes through here for that reason.
	 */
	private adoptSettings(next: PowerAssistantSettings) {
		if (this.settings) Object.assign(this.settings, next);
		else this.settings = { ...next };
	}

	async loadSettings() {
		const file = (await this.loadData()) as Partial<PowerAssistantSettings> | null;
		this.adoptSettings(Object.assign({}, DEFAULT_SETTINGS, file) as PowerAssistantSettings);
		this.settings.extractions = Object.assign({}, DEFAULT_SETTINGS.extractions, this.settings.extractions);
		// per-recording diarization letters must never be standing corrections:
		// "Speaker A → Darwin" renames a DIFFERENT person in every future
		// recording. Old label-click gestures saved such rules; shed them in
		// memory on every load (the next natural save persists the removal).
		const letterRules = this.settings.corrections.filter((cc) => isSpeakerLetterTerm(cc.from));
		if (letterRules.length) {
			this.settings.corrections = this.settings.corrections.filter((cc) => !isSpeakerLetterTerm(cc.from));
			if (!this.warnedLetterRules) {
				this.warnedLetterRules = true;
				new Notice(
					`Power Assistant: dropped ${letterRules.length} speaker-letter correction${letterRules.length === 1 ? "" : "s"} (${letterRules
						.map((cc) => cc.from)
						.join(", ")}). Letters rotate with every recording, so those rules mislabel future transcripts. Name speakers by clicking their label in the transcript instead.`,
					15000
				);
			}
		}
		// a template still matching a default this plugin used to ship was never
		// edited, so it follows the new one; an edited template is untouchable
		if (LEGACY_MEETING_TEMPLATES.includes(this.settings.meetingTemplate)) this.settings.meetingTemplate = DEFAULT_MEETING_TEMPLATE;
		const f = file as Record<string, unknown> | null;
		const fileHasSecrets = !!f && SECRET_KEYS.some((k) => f[k] != null && f[k] !== "" && f[k] !== 0);
		// upgrade path: credentials found in data.json move into localStorage
		// once, then the file is rewritten without them
		if (fileHasSecrets && this.app.loadLocalStorage("pa-secrets") == null) this.stashSecrets();
		this.overlaySecrets(this.settings);
		// role migration: a device that had "Process on this device" off was the
		// record-only phone. A stash without a role adopts that meaning once;
		// from here the role is per-device and the old toggle is never read again.
		const raw = this.app.loadLocalStorage("pa-secrets") as string | null;
		let stashHasRole = false;
		try {
			stashHasRole = !!raw && "deviceRole" in (JSON.parse(raw) as Record<string, unknown>);
		} catch {
			/* unreadable stash counts as no role yet */
		}
		if (!stashHasRole) this.settings.deviceRole = this.settings.processHere === false ? "capture" : "full";
		this.baseline = structuredClone(this.settings);
		if (fileHasSecrets) await this.saveSettings();
	}

	/**
	 * The one write path, and it merges rather than overwrites.
	 *
	 * data.json is synced, so this file belongs to every device at once. Writing
	 * memory wholesale reverts whatever any other device changed since this one
	 * last read it. Credentials never touch the file at all: they live in
	 * per-device localStorage, are stripped from what disk offers, and the file
	 * is written redacted, so a synced data.json can neither leak keys nor log
	 * another device out.
	 */
	async saveSettings() {
		this.stashSecrets();
		const disk = this.stripSecrets((await this.loadData()) as Partial<PowerAssistantSettings> | null);
		this.adoptSettings(mergeForSave(this.settings, this.baseline, disk));
		await this.saveData(this.redactForFile(this.settings));
		this.baseline = structuredClone(this.settings);
	}

	/** Obsidian calls this when Sync lands another device's write. Adopting it
	 *  keeps this device from holding a stale snapshot it would later write back. */
	async onExternalSettingsChange() {
		await this.loadSettings();
	}
}

/** Prep a meeting before it starts: name it, list who is coming, jot an agenda,
 *  pick which sections the AI should pull. Create the dated note, or create it
 *  and start recording so everything folds into that one page. */
class NewMeetingModal extends Modal {
	private mtitle = "";
	private attendees = "";
	private agenda = "";
	private extractions: ProcessOverrides["extractions"] | null = null;
	// filled from a pasted invite / .ics
	private date = "";
	private location = "";
	private when = "";
	private teamsUrl = "";
	private meetingId = "";
	private passcode = "";
	private titleInput?: HTMLInputElement;
	private attInput?: HTMLInputElement;
	private agendaInput?: HTMLTextAreaElement;
	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private prefill?: ParsedInvite
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("New meeting note");
		this.modalEl.addClass("pcap-meeting-modal");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Creates a dated note in your meetings folder with these fields, ready to prep in. Record straight into it and the summary, action items, and transcript land below your agenda.",
		});
		// paste an Outlook/Teams invite or a saved .ics to auto-fill the fields
		c.createEl("label", { cls: "pcap-field-label", text: "Paste from Outlook / Teams" });
		c.createEl("p", {
			cls: "pcap-field-sub",
			text: "Paste an invite or a saved .ics to fill the fields below. Forwarding the meeting to yourself, or File > Save As > iCalendar, gives the fullest result.",
		});
		const pasteEl = c.createEl("textarea", { cls: "pcap-field-input pcap-paste" });
		pasteEl.rows = 3;
		pasteEl.placeholder = "Paste invite text or .ics here…";
		const pasteBtns = c.createDiv({ cls: "pcap-btn-row" });
		pasteBtns.createEl("button", { text: "Fill fields from paste" }).addEventListener("click", () => this.applyParsed(parseMeetingInvite(pasteEl.value)));
		pasteBtns.createEl("button", { text: "From clipboard" }).addEventListener("click", async () => {
			try {
				const txt = await navigator.clipboard.readText();
				if (!txt.trim()) return void new Notice("Power Assistant: the clipboard is empty.");
				pasteEl.value = txt;
				this.applyParsed(parseMeetingInvite(txt));
			} catch {
				new Notice("Power Assistant: could not read the clipboard; paste into the box instead.");
			}
		});
		// load a saved .ics directly, so an Outlook "Save As > iCalendar" export
		// fills every field (attendees included) without any copy/paste
		const fileInput = pasteBtns.createEl("input", { type: "file", cls: "ptc-hidden-file", attr: { accept: ".ics,text/calendar" } });
		fileInput.addEventListener("change", async () => {
			const f = fileInput.files?.[0];
			if (!f) return;
			try {
				const txt = await f.text();
				pasteEl.value = txt;
				this.applyParsed(parseMeetingInvite(txt));
			} catch {
				new Notice("Power Assistant: could not read that file.");
			}
			fileInput.value = "";
		});
		pasteBtns.createEl("button", { text: "Load .ics file…" }).addEventListener("click", () => fileInput.click());
		// pick one meeting straight off the connected Microsoft 365 calendar and
		// fill this dialog with it, no paste needed
		pasteBtns.createEl("button", { text: "From calendar…" }).addEventListener("click", () => {
			void this.plugin.calendarInvites().then((invites) => {
				if (!invites) return; // a notice already explained (not connected, fetch failed)
				if (!invites.length) {
					new Notice("Power Assistant: no upcoming meetings in the next two weeks.");
					return;
				}
				new InvitePickModal(this.app, invites, (inv) => this.applyParsed(inv)).open();
			});
		});

		c.createEl("label", { cls: "pcap-field-label", text: "Title" });
		this.titleInput = c.createEl("input", { cls: "pcap-field-input", attr: { type: "text", placeholder: "Weekly sync" } });
		this.titleInput.addEventListener("input", () => (this.mtitle = this.titleInput?.value ?? ""));

		c.createEl("label", { cls: "pcap-field-label", text: "Attendees" });
		c.createEl("p", { cls: "pcap-field-sub", text: "Comma-separated; each becomes a linked person." });
		this.attInput = c.createEl("input", { cls: "pcap-field-input", attr: { type: "text", placeholder: "Steve, Rachel" } });
		this.attInput.addEventListener("input", () => (this.attendees = this.attInput?.value ?? ""));

		c.createEl("label", { cls: "pcap-field-label", text: "Meeting type" });
		const sel = c.createEl("select", { cls: "pcap-field-input dropdown" });
		sel.createEl("option", { value: "", text: "Default sections" });
		for (const t of allTemplates(this.plugin.settings.customTemplates)) sel.createEl("option", { value: t.id, text: t.name });
		sel.addEventListener("change", () => {
			const t = allTemplates(this.plugin.settings.customTemplates).find((x) => x.id === sel.value);
			this.extractions = t ? extractionsFromKeys(t.sections) : null;
		});

		c.createEl("label", { cls: "pcap-field-label", text: "Agenda" });
		c.createEl("p", { cls: "pcap-field-sub", text: "One item per line." });
		this.agendaInput = c.createEl("textarea", { cls: "pcap-field-input pcap-agenda" });
		this.agendaInput.rows = 6;
		this.agendaInput.placeholder = "- First topic\n- Second topic";
		this.agendaInput.addEventListener("input", () => (this.agenda = this.agendaInput?.value ?? ""));

		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Create" }).addEventListener("click", () => this.submit(false));
		btns.createEl("button", { text: "Create and record", cls: "mod-cta" }).addEventListener("click", () => this.submit(true));
		this.titleInput.focus();
		if (this.prefill) this.applyParsed(this.prefill, true);
	}
	/** Fill the visible fields and stash the invite context from a parsed paste. */
	private applyParsed(p: ParsedInvite, quiet = false) {
		const got: string[] = [];
		if (p.title) ((this.mtitle = p.title), this.titleInput && (this.titleInput.value = p.title), got.push("title"));
		if (p.attendees.length) ((this.attendees = p.attendees.join(", ")), this.attInput && (this.attInput.value = this.attendees), got.push("attendees"));
		if (p.agenda) ((this.agenda = p.agenda), this.agendaInput && (this.agendaInput.value = p.agenda), got.push("agenda"));
		if (p.date) ((this.date = p.date), got.push("date"));
		if (p.location) ((this.location = p.location), got.push("location"));
		if (p.when) this.when = p.when;
		if (p.teamsUrl) ((this.teamsUrl = p.teamsUrl), got.push("Teams link"));
		if (p.meetingId) this.meetingId = p.meetingId;
		if (p.passcode) this.passcode = p.passcode;
		if (!quiet) new Notice(got.length ? `Power Assistant: filled ${got.join(", ")} from the invite.` : "Power Assistant: nothing recognizable in that paste.");
	}
	private submit(record: boolean) {
		const attendees = this.attendees
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean);
		this.close();
		void this.plugin.createMeetingNote({
			title: this.mtitle.trim(),
			attendees,
			agenda: this.agenda,
			extractions: this.extractions,
			record,
			date: this.date || undefined,
			location: this.location,
			when: this.when,
			teamsUrl: this.teamsUrl,
			meetingId: this.meetingId,
			passcode: this.passcode,
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Device-code sign-in dialog: shows the code + link and finishes as the plugin
 *  polls in the background. `waiting` gates that poll loop; cancel stops it. */
/** Pick a deck out of the vault when the command is run without one open. */
class PptxSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder("Which PowerPoint?");
	}
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pptx");
	}
	getItemText(f: TFile): string {
		return f.path;
	}
	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

/** Choose how a deck's pictures are read, then capture it. The choice is per
 *  deck: a slide deck of screenshots is worth reading, one of stock art is not. */
class PptxModal extends Modal {
	private mode: OcrMode;
	constructor(app: App, private plugin: PowerAssistantPlugin, private file: TFile) {
		super(app);
		this.mode = plugin.settings.pptxOcr;
	}

	onOpen() {
		this.titleEl.setText("Capture a PowerPoint");
		const c = this.contentEl;
		c.createEl("p", { text: this.file.name, cls: "pa-pptx-name" });
		new Setting(c)
			.setName("Read slide images")
			.setDesc("Reading uses your Anthropic key and shows up in the usage meter. Slide text and speaker notes are always captured. Bullet icons and other decoration are dropped either way.")
			.addDropdown((d) =>
				d
					.addOption("none", "No images, text only")
					.addOption("large", "Real pictures only (skips bullet icons)")
					.addOption("all", "Every image, icons included")
					.setValue(this.mode)
					.onChange((v) => (this.mode = v as OcrMode))
			);
		new Setting(c).addButton((b) =>
			b
				.setButtonText("Capture")
				.setCta()
				.onClick(() => {
					this.close();
					void this.plugin.capturePptx(this.file, this.mode);
				})
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class DeviceCodeModal extends Modal {
	waiting = true;
	constructor(
		app: App,
		private dc: DeviceCode
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Connect Microsoft 365");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Sign in with your Microsoft account so Power Assistant can read your calendar. Open the page, enter the code, and approve. This window finishes automatically.",
		});
		c.createEl("div", { cls: "ptc-devicecode", text: this.dc.user_code });
		const row = c.createDiv({ cls: "ptc-modal-btns ptc-left" });
		row.createEl("button", { text: "Copy code" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.dc.user_code);
			new Notice("Power Assistant: code copied.");
		});
		row.createEl("button", { text: "Open sign-in page", cls: "mod-cta" }).addEventListener("click", () => window.open(this.dc.verification_uri, "_blank"));
		c.createEl("p", { cls: "ptc-modal-desc ptc-devicecode-url", text: this.dc.verification_uri });
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
	}
	onClose() {
		this.waiting = false;
		this.contentEl.empty();
	}
}

/** Single-select calendar picker: choose one upcoming meeting to prefill the
 *  already-open New meeting dialog (the From calendar button). */
class InvitePickModal extends FuzzySuggestModal<ParsedInvite> {
	constructor(
		app: App,
		private invites: ParsedInvite[],
		private onPick: (inv: ParsedInvite) => void
	) {
		super(app);
		this.setPlaceholder("Pick a meeting to fill the dialog with…");
	}
	getItems(): ParsedInvite[] {
		return this.invites;
	}
	getItemText(inv: ParsedInvite): string {
		return `${inv.date}  ${inv.when}  ·  ${inv.title}`;
	}
	onChooseItem(inv: ParsedInvite): void {
		this.onPick(inv);
	}
}

/** Calendar picker: choose which upcoming meetings become notes (bulk), or open
 *  one prefilled in the New meeting dialog to prep and record it now. */
class CalendarPickerModal extends Modal {
	private checked = new Set<number>();
	private filter = "";
	private listEl!: HTMLElement;
	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private invites: ParsedInvite[]
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Import meetings from your calendar");
		const c = this.contentEl;
		c.createEl("p", { cls: "ptc-modal-desc", text: "Pick the meetings to turn into notes. Each becomes a dated meeting note, prefilled and ready to record into." });
		new Setting(c).setName("Filter").addText((t) =>
			t.setPlaceholder("Search title…").onChange((v) => {
				this.filter = v.toLowerCase();
				this.renderList();
			})
		);
		this.listEl = c.createDiv({ cls: "ptc-cal-list" });
		this.renderList();
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Create notes", cls: "mod-cta" }).addEventListener("click", () => void this.createSelected());
	}
	private renderList() {
		this.listEl.empty();
		const rows = this.invites.map((inv, i) => ({ inv, i })).filter((x) => !this.filter || x.inv.title.toLowerCase().includes(this.filter));
		if (!rows.length) {
			this.listEl.createEl("div", { cls: "pe-empty", text: "No matching meetings." });
			return;
		}
		for (const { inv, i } of rows) {
			const row = this.listEl.createDiv({ cls: "ptc-cal-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.checked.has(i);
			cb.addEventListener("change", () => (cb.checked ? this.checked.add(i) : this.checked.delete(i)));
			const label = row.createDiv({ cls: "ptc-cal-label" });
			label.addEventListener("click", () => {
				cb.checked = !cb.checked;
				if (cb.checked) this.checked.add(i);
				else this.checked.delete(i);
			});
			label.createEl("div", { cls: "ptc-cal-title", text: inv.title });
			label.createEl("div", { cls: "ptc-cal-meta", text: [inv.date, inv.when, inv.location].filter(Boolean).join("  ·  ") });
			row.createEl("button", { text: "Record", attr: { "aria-label": "Create the note and start recording now" } }).addEventListener("click", () => {
				this.close();
				void this.plugin.createMeetingNote({
					title: inv.title,
					attendees: inv.attendees,
					agenda: inv.agenda,
					extractions: null,
					record: true,
					open: true,
					date: inv.date || undefined,
					location: inv.location,
					when: inv.when,
					teamsUrl: inv.teamsUrl,
					meetingId: inv.meetingId,
					passcode: inv.passcode,
				});
			});
			row.createEl("button", { text: "Prep…" }).addEventListener("click", () => {
				this.close();
				new NewMeetingModal(this.app, this.plugin, inv).open();
			});
		}
	}
	private async createSelected() {
		const picked = [...this.checked]
			.sort((a, b) => a - b)
			.map((i) => this.invites[i])
			.filter(Boolean);
		if (!picked.length) {
			new Notice("Power Assistant: pick at least one meeting.");
			return;
		}
		this.close();
		let n = 0;
		let failed = 0;
		for (const inv of picked) {
			try {
				await this.plugin.createMeetingNote({
					title: inv.title,
					attendees: inv.attendees,
					agenda: inv.agenda,
					extractions: null,
					record: false,
					open: false,
					date: inv.date || undefined,
					location: inv.location,
					when: inv.when,
					teamsUrl: inv.teamsUrl,
					meetingId: inv.meetingId,
					passcode: inv.passcode,
				});
				n++;
			} catch (e) {
				failed++;
				console.error("Power Assistant: could not create a meeting note", e);
			}
		}
		new Notice(`Power Assistant: created ${n} meeting note${n === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** The Meeting-Processor-style dialog: pick what to extract from one file and
 *  where the note goes, then run the pipeline with those one-off choices. */
/** The server install steps, with the one command front and center. The files
 *  are already written by the time this opens; the person runs the command in
 *  their own terminal and watches it work. */
class ServerInstallModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private files: { dir: string; command: string }
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Install the WhisperX server");
		const c = this.contentEl;
		c.createEl("p", {
			text: "The server files are written to a folder next to the plugin. One command in a terminal does the rest: it sets up a private Python environment (outside your vault), installs the pieces matched to your hardware, starts the server, and registers it to start whenever you log in.",
		});
		c.createEl("p", { cls: "ptc-modal-desc", text: `Files: ${this.files.dir}` });
		const box = c.createEl("pre", { cls: "pa-install-cmd" });
		box.createEl("code", { text: this.files.command });
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { cls: "mod-cta", text: "Copy the command" }).addEventListener("click", () => {
			void navigator.clipboard.writeText(this.files.command);
			new Notice("Power Assistant: command copied. Paste it into PowerShell or a terminal.");
		});
		btns.createEl("button", { text: "Check server" }).addEventListener("click", () => void this.plugin.verifyWhisperX());
		c.createEl("p", {
			text: "The script asks for a Hugging Face token, which is what turns on speaker labels; pressing Enter skips it and plain transcription works right away (rerun the same command later to add the token). When it finishes it prints the server address: paste that into the WhisperX section and press Check server.",
		});
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Python 3.10 to 3.12 is the one prerequisite (the script tells you the winget command if it is missing). First run downloads a few GB of models; later starts are quick.",
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class ProcessModal extends Modal {
	private chosen: Record<ExtractionKey, boolean>;
	private includeTranscript: boolean;
	private outputFolder: string;
	private filenameTemplate: string;
	private rememberSeries = false;
	private screens: boolean;
	private readonly hasVideo: boolean;
	private readonly series: string;

	constructor(app: App, private plugin: PowerAssistantPlugin, private file: TFile) {
		super(app);
		const s = plugin.settings;
		this.series = seriesKey(file.basename);
		this.chosen = { ...s.extractions };
		this.includeTranscript = s.includeTranscript;
		this.outputFolder = s.outputFolder;
		this.filenameTemplate = s.filenameTemplate;
		this.hasVideo = VIDEO_EXTS.has(file.extension.toLowerCase());
		this.screens = s.framesFromVideo;
	}

	onOpen() {
		this.titleEl.setText(`Process ${this.file.name}`);
		this.render();
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		c.createEl("p", { cls: "ptc-modal-desc", text: "Choose what to extract from this audio and where the note goes." });
		new Setting(c)
			.setName("Template")
			.setDesc("Preset section picks for common meeting types; toggles below stay editable.")
			.addDropdown((d) => {
				const templates = allTemplates(this.plugin.settings.customTemplates);
				d.addOption("custom", "Custom");
				for (const t of templates) d.addOption(t.id, t.name);
				d.setValue("custom").onChange((v) => {
					const t = templates.find((x) => x.id === v);
					if (!t) return;
					for (const e of EXTRACTIONS) this.chosen[e.key] = t.sections.includes(e.key);
					this.render();
				});
			});
		for (const e of EXTRACTIONS) {
			new Setting(c)
				.setName(e.label)
				.setDesc(e.hint)
				.addToggle((t) => t.setValue(this.chosen[e.key]).onChange((v) => (this.chosen[e.key] = v)));
		}
		new Setting(c)
			.setName("Clean transcript")
			.setDesc("Append the full transcript to the note.")
			.addToggle((t) => t.setValue(this.includeTranscript).onChange((v) => (this.includeTranscript = v)));
		// only offered for a file that can actually carry a picture: on an mp3 the
		// toggle would be a promise the format cannot keep
		if (this.hasVideo) {
			new Setting(c)
				.setName("Screens")
				.setDesc("After the note is written, scan the video and add a frame wherever the picture changed. Takes about a minute per hour of recording.")
				.addToggle((t) => t.setValue(this.screens).onChange((v) => (this.screens = v)));
		}
		new Setting(c).setName("Output folder").addText((t) => t.setValue(this.outputFolder).onChange((v) => (this.outputFolder = v.trim())));
		new Setting(c)
			.setName("Filename template")
			.setDesc("{{basename}} = audio filename, {{date}} = today. Extension optional; defaults to .md.")
			.addText((t) => t.setValue(this.filenameTemplate).onChange((v) => (this.filenameTemplate = v)));
		if (this.series) {
			new Setting(c)
				.setName(`Remember for the "${this.series}" series`)
				.setDesc("Future recordings whose name matches this series auto-extract these same sections.")
				.addToggle((t) => t.setValue(this.rememberSeries).onChange((v) => (this.rememberSeries = v)));
		}
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const go = btns.createEl("button", { text: "Process", cls: "mod-cta" });
		go.addEventListener("click", () => {
			if (!Object.values(this.chosen).some(Boolean) && !this.includeTranscript) {
				new Notice("Pick at least one output.");
				return;
			}
			if (this.rememberSeries && this.series) {
				this.plugin.settings.seriesTemplates[this.series] = chosenKeys(this.chosen);
				void this.plugin.saveSettings();
			}
			this.close();
			void this.plugin.process(this.file, {
				extractions: this.chosen,
				includeTranscript: this.includeTranscript,
				outputFolder: this.outputFolder || this.plugin.settings.outputFolder,
				filenameTemplate: this.filenameTemplate,
				screens: this.hasVideo && this.screens,
			});
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Add a "## Screens" section to a capture note by scanning a video for the
 *  moments its picture changed.
 *
 *  The source may be the recording the note already embeds, or a file picked
 *  from anywhere on disk. The second is the case this was built for: a Teams
 *  recording is downloaded next to the transcript, is far too big to want in a
 *  synced vault, and only its frames need to end up there. */
class ScreensModal extends Modal {
	private everyMs: number;
	private threshold: number;
	private max: number;
	private captions: boolean;
	private picked: File | null = null;
	private readonly embedded: TFile | null;

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private note: TFile,
		embedded: TFile | null
	) {
		super(app);
		const s = plugin.settings;
		this.embedded = embedded;
		this.everyMs = Math.max(1, s.frameEvery) * 1000;
		this.threshold = s.frameThreshold;
		this.max = s.frameMax;
		this.captions = s.frameCaptions;
	}

	onOpen() {
		this.titleEl.setText("Add screens");
		this.render();
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Walks the recording and keeps a frame wherever the picture changed, which on a screen share is every time the shared window did. The frames land in this note under Screens, each with the timestamp it came from.",
		});
		const sourceName = this.picked ? this.picked.name : this.embedded ? this.embedded.name : "(none chosen)";
		new Setting(c)
			.setName("Recording")
			.setDesc(
				this.embedded && !this.picked
					? `This note's own recording (${sourceName}). Choose a file instead if the video lives outside the vault, such as a downloaded Teams recording.`
					: `Scanning ${sourceName}. Nothing is imported: only the frames are written into the vault.`
			)
			.addButton((b) =>
				b.setButtonText("Choose a file…").onClick(() => {
					const input = document.createElement("input");
					input.type = "file";
					input.accept = "video/mp4,video/webm,video/x-matroska,video/quicktime,.mp4,.webm,.mkv,.mov,.m4v";
					input.onchange = () => {
						const f = input.files?.[0];
						if (f) {
							this.picked = f;
							this.render();
						}
					};
					input.click();
				})
			);
		new Setting(c)
			.setName("Sample every")
			.setDesc("Seconds between looks. Smaller catches a screen that was only up briefly, and costs one seek per step (an hour at 5 seconds is around 720 of them).")
			.addText((t) =>
				t.setValue(String(Math.round(this.everyMs / 1000))).onChange((v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 1) this.everyMs = Math.round(n) * 1000;
				})
			);
		new Setting(c)
			.setName("Change threshold")
			.setDesc("How much of the picture must change (percent) to count as a new screen. Lower keeps more, including a talking head shifting in frame; higher keeps only real redraws.")
			.addText((t) =>
				t.setValue(String(this.threshold)).onChange((v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 0 && n <= 100) this.threshold = n;
				})
			);
		new Setting(c)
			.setName("Maximum screens")
			.setDesc("The cap for one recording. When more changes than this are found, the biggest changes are kept and you are told how many were left out.")
			.addText((t) =>
				t.setValue(String(this.max)).onChange((v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= 1) this.max = Math.round(n);
				})
			);
		new Setting(c)
			.setName("Read each screen")
			.setDesc("Have the AI model read every kept frame and quote what it found under the image, so the screens are searchable as text. Costs one image call per frame.")
			.addToggle((t) => t.setValue(this.captions).onChange((v) => (this.captions = v)));
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const go = btns.createEl("button", { text: "Find the screens", cls: "mod-cta" });
		go.addEventListener("click", () => {
			if (!this.picked && !this.embedded) {
				new Notice("Power Assistant: choose a recording to scan first.");
				return;
			}
			this.close();
			void this.plugin.addScreens(this.note, this.picked, this.embedded, {
				everyMs: this.everyMs,
				threshold: this.threshold,
				max: this.max,
				captions: this.captions,
			});
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

interface SpeakerNameOptions {
	guesses: Record<string, string>;
	/** Talk share + first words per label, so "who is this?" answers itself. */
	stats?: Record<string, { share: number; first: string }>;
	/** Attendees from earlier captures, offered as type-ahead suggestions. */
	suggestions?: string[];
	/** Labels are full display labels ("Rachel"), not letters to prefix. */
	rawLabels?: boolean;
	/** Listenable clips per label, and the player to run them — hearing the
	 *  voice beats guessing it from the first words. Each click on a row's play
	 *  button moves to that speaker's next clip. */
	samples?: Record<string, { startMs: number; durMs: number }[]>;
	player?: SegmentPlayer | null;
}

/** Confirm (or fix) the speaker-name guesses. Resolves {} to keep the current
 *  labels; closing the dialog counts as keeping them. */
function confirmSpeakerNames(app: App, labels: string[], opts: SpeakerNameOptions): Promise<Record<string, string>> {
	return new Promise((resolve) => new SpeakerNamesModal(app, labels, opts, resolve).open());
}

class SpeakerNamesModal extends Modal {
	private values: Record<string, string>;
	private settled = false;
	private playing: string | null = null;
	private clipAt: Record<string, number> = {};

	constructor(
		app: App,
		private labels: string[],
		private opts: SpeakerNameOptions,
		private resolveNames: (names: Record<string, string>) => void
	) {
		super(app);
		this.values = { ...opts.guesses };
	}

	onOpen() {
		this.titleEl.setText("Who was speaking?");
		this.contentEl.createEl("p", {
			cls: "ptc-modal-desc",
			text: this.opts.rawLabels
				? "Rename anyone; an empty or unchanged box leaves that speaker as is."
				: "Names guessed from the transcript itself, busiest speaker first. Fix anything wrong; an empty box keeps the letter.",
		});
		let listId: string | null = null;
		if (this.opts.suggestions?.length) {
			listId = "ptc-speaker-suggest";
			const dl = this.contentEl.createEl("datalist", { attr: { id: listId } });
			for (const s of this.opts.suggestions) dl.createEl("option", { attr: { value: s } });
		}
		for (const label of this.labels) {
			const display = this.opts.rawLabels ? label : `Speaker ${label}`;
			const st = this.opts.stats?.[label];
			const pct = st ? (st.share < 0.01 ? "<1%" : `${Math.round(st.share * 100)}%`) : null;
			const row = new Setting(this.contentEl).setName(pct ? `${display} · ${pct}` : display);
			const clips = this.opts.samples?.[label];
			const player = this.opts.player;
			if (clips?.length && player) {
				row.addExtraButton((b) => {
					b.setIcon("play").setTooltip(clips.length > 1 ? `Hear this speaker (${clips.length} clips)` : "Hear this speaker");
					b.extraSettingsEl.addClass("pa-name-play");
					b.onClick(() => {
						if (this.playing === label) {
							player.stop(); // settles the clip, which resets the icon below
							return;
						}
						this.playing = label;
						const idx = (this.clipAt[label] = ((this.clipAt[label] ?? -1) + 1) % clips.length);
						setIcon(b.extraSettingsEl, "square");
						void player.play(clips[idx].startMs, clips[idx].durMs, () => {
							if (this.playing === label) this.playing = null;
							setIcon(b.extraSettingsEl, "play");
						});
					});
				});
			}
			row.addText((t) => {
				t.setPlaceholder(display)
					.setValue(this.values[label] ?? "")
					.onChange((v) => (this.values[label] = v.trim()));
				if (listId) t.inputEl.setAttribute("list", listId);
			});
			if (st?.first) row.setDesc(`“${st.first}…”`);
		}
		const btns = this.contentEl.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: this.opts.rawLabels ? "Cancel" : "Keep letters" }).addEventListener("click", () =>
			this.finish({})
		);
		const go = btns.createEl("button", { text: "Apply names", cls: "mod-cta" });
		go.addEventListener("click", () => {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(this.values)) if (v?.trim()) out[k] = v.trim();
			this.finish(out);
		});
	}

	private finish(names: Record<string, string>) {
		this.settled = true;
		this.close();
		this.resolveNames(names);
	}

	onClose() {
		this.opts.player?.destroy();
		this.contentEl.empty();
		if (!this.settled) this.resolveNames({});
	}
}

/** Move ONE transcript turn to a different speaker — the fix when the diarizer
 *  glued two voices under one label, where renaming the label would just paint
 *  the wrong name onto both people. Existing speakers are one click; anyone
 *  else types ahead from known attendees. */
class ReassignTurnModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private file: TFile,
		private ref: TurnRef
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Move this turn");
		const stamp = this.ref.stamp ? ` at ${this.ref.stamp.replace(/[[\]]/g, "")}` : "";
		this.contentEl.createEl("p", {
			cls: "ptc-modal-desc",
			text: `Only this one turn moves (${this.ref.name}${stamp}); every other ${this.ref.name} line stays as it is.`,
		});
		if (this.ref.textHint) this.contentEl.createEl("p", { cls: "ptc-modal-desc pa-turn-quote", text: `“${this.ref.textHint}…”` });
		void this.render();
	}

	private async render() {
		const md = await this.app.vault.read(this.file);
		const others = transcriptSpeakers(md).filter((s) => s !== this.ref.name);
		if (others.length) {
			const wrap = this.contentEl.createDiv({ cls: "pa-turn-move" });
			for (const o of others) {
				const b = wrap.createEl("button", { text: o });
				b.addEventListener("click", () => this.choose(o));
			}
		}
		let typed = "";
		const row = new Setting(this.contentEl).setName(others.length ? "Or someone else" : "Who said it?");
		row.addText((t) => {
			t.setPlaceholder("Type a name");
			t.onChange((v) => (typed = v));
			const dl = this.contentEl.createEl("datalist", { attr: { id: "pa-turn-move-suggest" } });
			for (const s of this.plugin.knownAttendees()) dl.createEl("option", { attr: { value: s } });
			t.inputEl.setAttribute("list", "pa-turn-move-suggest");
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.choose(typed);
				}
			});
		});
		row.addButton((b) => b.setButtonText("Move").setCta().onClick(() => this.choose(typed)));
	}

	private choose(to: string) {
		const name = to.trim();
		if (!name) return;
		this.close();
		void this.plugin.reassignTurnIn(this.file, this.ref, name);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** The mic button records with no destination; when such a recording stops,
 *  this asks where the note should live. Meeting files it exactly like a
 *  recording started from a meeting note; Capture keeps the usual path.
 *  Closing the dialog counts as Capture, so audio is never held hostage by an
 *  unanswered box. */
class QuickFilingModal extends Modal {
	private settled = false;
	private titleText = "";

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private resolveChoice: (meeting: { title: string } | null) => void
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Where should this recording go?");
		this.contentEl.createEl("p", {
			cls: "ptc-modal-desc",
			text: "A meeting note is named by date and title, transcribed with the meeting provider, and filed in the Meetings folder. A capture note keeps the usual quick-recording path. Closing this keeps it a capture.",
		});
		new Setting(this.contentEl).setName("Meeting title").addText((t) => {
			t.setPlaceholder("Used when filing as a meeting");
			t.onChange((v) => (this.titleText = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.finish({ title: this.titleText });
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		const btns = this.contentEl.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Capture note" }).addEventListener("click", () => this.finish(null));
		const go = btns.createEl("button", { text: "Meeting note", cls: "mod-cta" });
		go.addEventListener("click", () => this.finish({ title: this.titleText }));
	}

	private finish(meeting: { title: string } | null) {
		this.settled = true;
		this.close();
		this.resolveChoice(meeting);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) this.resolveChoice(null);
	}
}

/** Per-meeting chat with starter chips and real follow-ups; the note itself is
 *  the only context, so every answer is grounded in this one conversation. */
class MeetingAskModal extends Modal {
	private turns: { role: "user" | "assistant"; content: string }[] = [];
	private busy = false;
	private threadEl!: HTMLElement;
	private inputEl!: HTMLInputElement;

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private noteTitle: string,
		private noteMd: string,
		private attendees: string[]
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("ptc-meeting-ask");
		this.titleEl.setText(`Ask: ${this.noteTitle}`);
		const c = this.contentEl;
		wireInternalLinks(this.app, c);
		const chips = c.createDiv({ cls: "ptc-chips" });
		for (const chip of meetingAskChips(this.attendees, this.plugin.settings.yourName)) {
			const b = chips.createEl("button", { cls: "ptc-chip", text: chip.label });
			b.addEventListener("click", () => void this.send(chip.question));
		}
		this.threadEl = c.createDiv({ cls: "ptc-ask-results ptc-thread" });
		const row = c.createDiv({ cls: "ptc-ask-row" });
		this.inputEl = row.createEl("input", {
			type: "text",
			cls: "ptc-ask-input",
			attr: { placeholder: "Ask anything about this meeting…" },
		});
		const go = row.createEl("button", { text: "Ask", cls: "mod-cta" });
		go.addEventListener("click", () => void this.send(this.inputEl.value));
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void this.send(this.inputEl.value);
		});
		window.setTimeout(() => this.inputEl.focus(), 20);
	}

	private async send(question: string) {
		const q = question.trim();
		if (!q || this.busy) return;
		this.busy = true;
		this.inputEl.value = "";
		this.threadEl.createDiv({ cls: "ptc-turn-q", text: q });
		const a = this.threadEl.createDiv({ cls: "ptc-turn-a", text: "Thinking…" });
		a.scrollIntoView({ block: "nearest" });
		this.turns.push({ role: "user", content: q });
		try {
			const answer = await this.plugin.claudeChat(buildMeetingChat(this.noteMd, this.turns), 1500);
			this.turns.push({ role: "assistant", content: answer });
			a.empty();
			await MarkdownRenderer.render(this.app, answer, a, "", this.plugin);
			a.scrollIntoView({ block: "nearest" });
		} catch (e) {
			this.turns.pop(); // the failed question can be re-asked
			a.setText("Ask failed: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			this.busy = false;
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Pick an attendee from across your captures. */
class PersonPickModal extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private names: string[],
		private onPick: (name: string) => void
	) {
		super(app);
		this.setPlaceholder("Whose report?");
	}

	getItems(): string[] {
		return this.names;
	}

	getItemText(n: string): string {
		return n;
	}

	onChooseItem(n: string): void {
		this.onPick(n);
	}
}

/** Template + section picks for re-running extraction on an existing note. */
class ReExtractModal extends Modal {
	private chosen: Record<ExtractionKey, boolean>;

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private file: TFile,
		seed?: Record<ExtractionKey, boolean>
	) {
		super(app);
		this.chosen = seed ?? { ...plugin.settings.extractions };
	}

	onOpen() {
		this.titleEl.setText(`Re-extract ${this.file.basename}`);
		this.render();
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Re-runs extraction from this note's own captured text with the current model (no re-transcription). The transcript (or the post or article it captured), moments, carried-over items, and audio embeds stay untouched. The sections start where this kind of capture normally sits.",
		});
		new Setting(c).setName("Template").addDropdown((d) => {
			d.addOption("custom", "Custom");
			for (const t of allTemplates(this.plugin.settings.customTemplates)) d.addOption(t.id, t.name);
			d.setValue("custom").onChange((v) => {
				const t = allTemplates(this.plugin.settings.customTemplates).find((x) => x.id === v);
				if (!t) return;
				for (const e of EXTRACTIONS) this.chosen[e.key] = t.sections.includes(e.key);
				this.render();
			});
		});
		for (const e of EXTRACTIONS) {
			new Setting(c)
				.setName(e.label)
				.addToggle((t) => t.setValue(this.chosen[e.key]).onChange((v) => (this.chosen[e.key] = v)));
		}
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const go = btns.createEl("button", { text: "Re-extract", cls: "mod-cta" });
		go.addEventListener("click", () => {
			if (!Object.values(this.chosen).some(Boolean)) {
				new Notice("Pick at least one section.");
				return;
			}
			this.close();
			void this.plugin.reExtract(this.file, this.chosen);
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Pick any note in the vault. Used for the meeting template, where typing a
 *  path from memory is the part people get wrong. */
class NotePickModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private onPick: (f: TFile) => void
	) {
		super(app);
		this.setPlaceholder("Which note is the template?");
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

/** Pick a folder to re-extract, for the palette route into the bulk run. Right-
 *  clicking the folder is the direct one; this is for when the folder is not on
 *  screen. */
class FolderPickModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private onPick: (folder: TFolder) => void
	) {
		super(app);
		this.setPlaceholder("Which folder?");
	}

	getItems(): TFolder[] {
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	getItemText(f: TFolder): string {
		return f.path || "/";
	}

	onChooseItem(f: TFolder): void {
		this.onPick(f);
	}
}

/** Re-extract every capture in a folder. Spends money per note, so the count,
 *  the sections, and the cost are all on screen before the button is live. */
class BulkReExtractModal extends Modal {
	private recurse = true;
	/** null = give each note the sections that suit its own kind. */
	private chosen: Record<ExtractionKey, boolean> | null = null;

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private folder: TFolder
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(`Re-extract captures in ${this.folder.name || "the vault"}`);
		this.render();
	}

	private render() {
		const c = this.contentEl;
		c.empty();
		const files = this.plugin.capturesIn(this.folder, this.recurse);
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Re-runs extraction on every capture note in this folder from each note's own captured text (no re-transcription). Transcripts, posts, articles, moments, carried-over items, and audio embeds stay untouched; only the AI sections are rewritten. Each note costs an extraction, and the run can be stopped part-way with everything done so far already saved.",
		});
		new Setting(c)
			.setName(`${files.length} capture note${files.length === 1 ? "" : "s"}`)
			.setDesc(
				files.length
					? files.slice(0, 4).map((f) => f.basename).join(", ") + (files.length > 4 ? `, and ${files.length - 4} more` : "")
					: "Nothing to re-extract here."
			);
		new Setting(c)
			.setName("Include subfolders")
			.addToggle((t) => t.setValue(this.recurse).onChange((v) => ((this.recurse = v), this.render())));
		new Setting(c)
			.setName("Sections")
			.setDesc("Each note's kind: a post gets the short set, a page your web sections, a meeting your meeting sections.")
			.addDropdown((d) => {
				d.addOption("kind", "Match each note's kind");
				d.addOption("custom", "Choose sections");
				d.setValue(this.chosen ? "custom" : "kind").onChange((v) => {
					this.chosen = v === "custom" ? { ...this.plugin.settings.extractions } : null;
					this.render();
				});
			});
		if (this.chosen) {
			const chosen = this.chosen;
			for (const e of EXTRACTIONS)
				new Setting(c)
					.setName(e.label)
					.addToggle((t) => t.setValue(chosen[e.key]).onChange((v) => (chosen[e.key] = v)))
					.setClass("pcap-subsetting");
		}
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const go = btns.createEl("button", { text: `Re-extract ${files.length} note${files.length === 1 ? "" : "s"}`, cls: "mod-cta" });
		go.disabled = !files.length;
		go.addEventListener("click", () => {
			if (this.chosen && !Object.values(this.chosen).some(Boolean)) {
				new Notice("Pick at least one section.");
				return;
			}
			this.close();
			void this.plugin.reExtractFolder(this.folder, { recurse: this.recurse, chosen: this.chosen });
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Edit a custom template's name and section set. The template object is a live
 *  reference into settings.customTemplates, so edits persist on close. */
class TemplateEditModal extends Modal {
	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private tpl: { name: string; sections: ExtractionKey[] },
		private onDone: () => void
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Edit template");
		const c = this.contentEl;
		new Setting(c).setName("Name").addText((t) => t.setValue(this.tpl.name).onChange((v) => (this.tpl.name = v.trim() || "Untitled")));
		for (const e of EXTRACTIONS) {
			new Setting(c)
				.setName(e.label)
				.setDesc(e.hint)
				.addToggle((t) =>
					t.setValue(this.tpl.sections.includes(e.key)).onChange((v) => {
						const has = this.tpl.sections.includes(e.key);
						if (v && !has) this.tpl.sections.push(e.key);
						else if (!v && has) this.tpl.sections = this.tpl.sections.filter((k) => k !== e.key);
					})
				);
		}
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Done", cls: "mod-cta" }).addEventListener("click", () => this.close());
	}

	onClose() {
		void this.plugin.saveSettings();
		this.onDone();
		this.contentEl.empty();
	}
}

/* ---------------- clickable [m:ss] stamps ---------------- */

const STAMP_RE = /\[(\d+:\d{2}(?::\d{2})?)\]/g;

/** Wrap every [m:ss] stamp in rendered capture notes in a link that seeks the
 *  note's embedded audio player to that moment (Reading view). Rotated notes
 *  embed one player per part; `partsMs` picks the right one and rebases. */
/** In Live Preview a plain click inside a rendered callout drops the editor
 *  cursor into it, which un-renders the whole block to raw `> …` source. Our
 *  transcript widgets (stamp links, speaker names, avatars, the toggle) exist
 *  to be clicked, so suppress that cursor placement on mousedown — the click
 *  itself still fires, and in Reading view this is a harmless no-op. */
function keepRendered(el: HTMLElement) {
	el.addEventListener("mousedown", (e) => e.preventDefault());
}

/** The line `text` is on now, searching outwards from where it used to be.
 *
 *  An edit anywhere above shifts every line below it, and a grabbed frame landing
 *  in the wrong transcript turn is worse than one landing at the end of the right
 *  one. Falls back to the remembered line when the text is gone, which is what a
 *  user editing that very line looks like. */
function findLine(editor: Editor, from: number, text: string): number {
	const last = editor.lastLine();
	const at = Math.max(0, Math.min(from, last));
	if (editor.getLine(at) === text) return at;
	for (let d = 1; d <= 300; d++) {
		if (at - d >= 0 && editor.getLine(at - d) === text) return at - d;
		if (at + d <= last && editor.getLine(at + d) === text) return at + d;
	}
	return at;
}

/** Resolve on a media element's next `type` event; reject on its error event or
 *  after `ms`. A file that is still syncing, or that Electron cannot decode,
 *  raises `error` and never the event being waited for, so without this a frame
 *  grab would hang the command instead of saying what went wrong. */
function mediaEvent(el: HTMLMediaElement, type: string, ms: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const clear = () => {
			el.removeEventListener(type, ok);
			el.removeEventListener("error", bad);
			window.clearTimeout(timer);
		};
		const ok = () => {
			clear();
			resolve();
		};
		const bad = () => {
			clear();
			reject(new Error("that file could not be read (it may still be syncing, or not be a video)."));
		};
		const timer = window.setTimeout(() => {
			clear();
			reject(new Error("reading the video timed out."));
		}, ms);
		el.addEventListener(type, ok, { once: true });
		el.addEventListener("error", bad, { once: true });
	});
}

/** Put a media element exactly at `at` seconds and wait until it is there.
 *
 *  A duration probe's own seek is often still in flight, and its `seeked` event
 *  would otherwise settle this wait while the element still sits at the end of
 *  the file, handing back the wrong frame. So the landing spot is checked, and
 *  the seek re-issued when the event turns out to have belonged to someone else. */
async function seekMedia(el: HTMLMediaElement, at: number, ms: number): Promise<void> {
	for (let i = 0; i < 4; i++) {
		el.currentTime = at;
		await mediaEvent(el, "seeked", ms);
		if (Math.abs(el.currentTime - at) < 0.5) return;
	}
	throw new Error("the video would not seek to that moment.");
}

/** A hidden <video> holding `url`, ready to be seeked and drawn.
 *
 *  Obsidian's Electron already decodes everything it will embed, so a <video>
 *  and a canvas lift frames with no ffmpeg and nothing for anyone to install.
 *  A MediaRecorder webm ships without a duration in its header, the same problem
 *  the embedded players have, so the end-probe they use runs here too when the
 *  duration is unknown; without it a seek can be clamped to zero.
 *
 *  The caller owns the element and must call `closeVideo` when done: one scan
 *  seeks it hundreds of times, so opening it per frame would pay the metadata
 *  round trip every time. */
async function openVideo(url: string): Promise<HTMLVideoElement> {
	const el = document.createElement("video");
	el.muted = true;
	el.preload = "auto";
	el.src = url;
	try {
		await mediaEvent(el, "loadedmetadata", 30_000);
		if (!el.videoWidth || !el.videoHeight) throw new Error("that recording carries no video, only sound.");
		if (!(Number.isFinite(el.duration) && el.duration > 0)) {
			try {
				el.currentTime = 1e101;
			} catch {
				/* seeking can be rejected this early; the wait below still times out */
			}
			await mediaEvent(el, "durationchange", 10_000).catch(() => {
				/* no header duration and no scan: the seek is attempted anyway */
			});
		}
		return el;
	} catch (e) {
		closeVideo(el);
		throw e;
	}
}

/** Let the decoder go; a held-open 1080p mp4 costs real memory. */
function closeVideo(el: HTMLVideoElement) {
	el.removeAttribute("src");
	el.load();
}

/** Seek an open video to `secs`, clamped inside the file. */
async function seekVideo(el: HTMLVideoElement, secs: number): Promise<void> {
	const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
	// a stamp on the last turn can sit a hair past the final frame
	await seekMedia(el, Math.max(0, dur ? Math.min(secs, dur - 0.05) : secs), 30_000);
	// `seeked` normally means the frame is decoded and drawable; when the element
	// disagrees, wait for it to say so rather than drawing a blank
	if (el.readyState < 2) await mediaEvent(el, "loadeddata", 10_000).catch(() => {});
}

/** The frame currently displayed, as webp bytes, scaled to `maxWidth`. */
async function frameBytes(el: HTMLVideoElement, maxWidth: number): Promise<{ bytes: Uint8Array; mime: string }> {
	const scale = Math.min(1, maxWidth / el.videoWidth);
	const w = Math.max(1, Math.round(el.videoWidth * scale));
	const h = Math.max(1, Math.round(el.videoHeight * scale));
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("this device could not open a canvas to draw the frame.");
	ctx.drawImage(el, 0, 0, w, h);
	const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.8));
	if (!blob) throw new Error("the frame could not be encoded.");
	return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || "image/webp" };
}

/** One frame out of a video file, as webp bytes. */
async function grabVideoFrame(url: string, secs: number, maxWidth: number): Promise<{ bytes: Uint8Array; mime: string }> {
	const el = await openVideo(url);
	try {
		await seekVideo(el, secs);
		return await frameBytes(el, maxWidth);
	} finally {
		closeVideo(el);
	}
}

/* ---------------- finding the screens in a recording ---------------- */

/** The scan draws to this size: big enough that a slide change moves a lot of
 *  pixels, small enough that reading them back costs nothing. */
const SCAN_W = 160;
const SCAN_H = 90;

/** A greyscale fingerprint of the frame currently displayed.
 *
 *  Luma alone is the right measure here: a shared screen changes by REDRAWING,
 *  and a redraw moves brightness everywhere. Comparing colour as well would cost
 *  three times the arithmetic to answer the same question. */
function lumaOf(el: HTMLVideoElement, ctx: CanvasRenderingContext2D): Uint8ClampedArray {
	ctx.drawImage(el, 0, 0, SCAN_W, SCAN_H);
	const d = ctx.getImageData(0, 0, SCAN_W, SCAN_H).data;
	const out = new Uint8ClampedArray(SCAN_W * SCAN_H);
	for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
	return out;
}

/** How much of the picture changed between two fingerprints, 0 to 100: the mean
 *  absolute difference per pixel, as a percentage of full range. */
function lumaDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return (sum / a.length) * (100 / 255);
}

/** Walk a recording and report the moments where the picture changed.
 *
 *  Each sample is compared against the last frame that counted as a change, not
 *  against the previous sample: a slow fade would otherwise creep past the
 *  threshold a pixel at a time and register as a new screen every few seconds.
 *  The first sample has nothing to compare against and is treated as a full
 *  change, since a recording's opening screen is a screen.
 *
 *  Sampling is what costs the time (one seek and one small draw per interval),
 *  so the caller gets progress per sample and can be cancelled between them. */
async function scanScenes(
	el: HTMLVideoElement,
	everyMs: number,
	threshold: number,
	onProgress: (atMs: number, ofMs: number, hits: number) => boolean
): Promise<FrameSample[]> {
	const canvas = document.createElement("canvas");
	canvas.width = SCAN_W;
	canvas.height = SCAN_H;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("this device could not open a canvas to scan the video.");
	const durMs = Math.floor((Number.isFinite(el.duration) ? el.duration : 0) * 1000);
	if (durMs <= 0) throw new Error("the length of that recording could not be read, so it cannot be scanned.");
	const samples: FrameSample[] = [];
	let last: Uint8ClampedArray | null = null;
	let hits = 0;
	for (let ms = 0; ms < durMs; ms += everyMs) {
		await seekVideo(el, ms / 1000);
		const sig = lumaOf(el, ctx);
		const diff = last ? lumaDiff(last, sig) : 100;
		samples.push({ ms, diff });
		if (diff > threshold) {
			last = sig;
			hits++;
		}
		if (!onProgress(ms, durMs, hits)) break;
	}
	return samples;
}

/** Decode an image and hand back its pixels as PNG, with its natural size.
 *
 *  Chromium decodes webp; the .docx format does not carry it, so this is the
 *  bridge. Drawing to a canvas also happens to be the only way to learn a
 *  picture's dimensions in a renderer, which the document needs in order to scale
 *  it, so the conversion costs nothing that was not already being paid. */
async function pngForDocx(url: string): Promise<ResolvedImage> {
	const img = new Image();
	img.src = url;
	await new Promise<void>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new Error("reading the image timed out.")), 15_000);
		img.onload = () => {
			window.clearTimeout(timer);
			resolve();
		};
		img.onerror = () => {
			window.clearTimeout(timer);
			reject(new Error("that image could not be read."));
		};
	});
	const w = img.naturalWidth;
	const h = img.naturalHeight;
	if (!w || !h) throw new Error("that image has no size.");
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("this device could not open a canvas to convert the image.");
	ctx.drawImage(img, 0, 0);
	const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
	if (!blob) throw new Error("the image could not be re-encoded.");
	return { data: new Uint8Array(await blob.arrayBuffer()), width: w, height: h, type: "png" };
}

/** MediaRecorder .webm files usually ship without a duration in their header,
 *  so the audio player shows no total time (just a 0:00 that never fills in).
 *  Force the browser to resolve the real duration by seeking to the end once,
 *  then rewind — after which the native control shows the total length. */
function fixAudioDuration(el: HTMLMediaElement) {
	if (el.dataset.paDurfix) return;
	el.dataset.paDurfix = "1";
	const known = () => Number.isFinite(el.duration) && el.duration > 0;
	const probe = () => {
		if (known()) return; // duration is already good; the control shows it
		const reset = () => {
			if (!known()) return;
			el.removeEventListener("durationchange", reset);
			el.removeEventListener("timeupdate", reset);
			el.currentTime = 0; // rewind now that the real duration is resolved
		};
		el.addEventListener("durationchange", reset);
		el.addEventListener("timeupdate", reset);
		try {
			el.currentTime = 1e101; // seek past the end to force a full scan
		} catch {
			/* seeking can be rejected before metadata; loadedmetadata retries */
		}
	};
	if (el.readyState >= 1) probe();
	else el.addEventListener("loadedmetadata", probe, { once: true });
}

/** Resolve durations for every recording embed under `root`. A capture whose
 *  source is a video embeds a <video>, which has the same missing-duration
 *  problem and takes the same fix. */
function fixAudioDurations(root: HTMLElement) {
	for (const el of Array.from(root.querySelectorAll<HTMLMediaElement>("audio, video"))) fixAudioDuration(el);
}

/** Plays short clips out of a recording's part files — the "let me hear this
 *  speaker" button in the naming dialog. Owns one hidden <audio>; a new play()
 *  supersedes the clip before it, and whoever asked is always told when their
 *  clip stops (ended, superseded, or torn down), so buttons never stick on
 *  "playing". MediaRecorder webm reports no duration until a full scan, so
 *  every seek waits for the same end-probe the embeds use. */
class SegmentPlayer {
	private audio: HTMLAudioElement | null = null;
	private srcIdx = -1;
	private stopAt = Infinity;
	private gen = 0;
	/** True from a play() call until its playback actually begins; the pause
	 *  event of the clip being superseded arrives on a QUEUED task, and without
	 *  this window it would settle the new clip's callback the moment it starts. */
	private starting = false;
	private onDone: (() => void) | null = null;

	constructor(
		private plugin: PowerAssistantPlugin,
		private parts: TFile[],
		private offsetsMs: number[]
	) {}

	/** Fire (once) the pending clip's done callback. */
	private settle() {
		const cb = this.onDone;
		this.onDone = null;
		cb?.();
	}

	/** Resolve once the element can seek reliably: webm needs the seek-past-the-
	 *  end probe to learn its duration first. Times out rather than hanging the
	 *  dialog on a damaged file. */
	private seekable(el: HTMLAudioElement): Promise<void> {
		return new Promise((res) => {
			const ok = () => Number.isFinite(el.duration) && el.duration > 0;
			if (ok()) return res();
			let settled = false;
			const done = () => {
				if (settled || !ok()) return;
				settled = true;
				el.removeEventListener("durationchange", done);
				res();
			};
			el.addEventListener("durationchange", done);
			const probe = () => {
				try {
					el.currentTime = 1e101;
				} catch {
					/* not ready yet; durationchange still lands */
				}
			};
			if (el.readyState >= 1) probe();
			else el.addEventListener("loadedmetadata", probe, { once: true });
			window.setTimeout(() => {
				if (settled) return;
				settled = true;
				el.removeEventListener("durationchange", done);
				res();
			}, 4000);
		});
	}

	/** Play up to `capMs` of the clip starting at global `startMs`. */
	async play(startMs: number, durMs: number, onDone: () => void, capMs = 10000) {
		const gen = ++this.gen;
		this.starting = true;
		this.audio?.pause(); // its queued pause event is ignored while starting
		this.settle(); // release the superseded clip's button now
		this.onDone = onDone;
		const { index, secondsInPart } = partForStamp(this.offsetsMs.length ? this.offsetsMs : [0], startMs / 1000);
		const file = this.parts[Math.min(index, this.parts.length - 1)];
		if (!file) return this.settle();
		if (!this.audio || this.srcIdx !== index) {
			if (this.audio) this.audio.src = "";
			const el = new Audio(this.plugin.app.vault.getResourcePath(file));
			el.addEventListener("timeupdate", () => {
				if (el.currentTime >= this.stopAt) {
					this.stopAt = Infinity;
					el.pause();
				}
			});
			el.addEventListener("pause", () => {
				if (!this.starting) this.settle();
			});
			el.addEventListener("ended", () => this.settle());
			this.audio = el;
			this.srcIdx = index;
		}
		await this.seekable(this.audio);
		if (gen !== this.gen) return; // another click superseded this one mid-await
		this.stopAt = secondsInPart + Math.min(Math.max(durMs, 1500), capMs) / 1000;
		this.audio.currentTime = secondsInPart;
		try {
			await this.audio.play();
			if (gen === this.gen) this.starting = false;
		} catch {
			if (gen === this.gen) this.starting = false;
			this.settle(); // the file is gone or undecodable; release the button
		}
	}

	stop() {
		this.gen++;
		this.starting = false;
		this.stopAt = Infinity;
		this.audio?.pause();
		this.settle();
	}

	destroy() {
		this.stop();
		if (this.audio) this.audio.src = "";
		this.audio = null;
	}
}

/** The avatar badge drawn before a speaker in the Live Preview transcript.
 *  Clicking it opens the speaker menu (rename, color, emoji) — the way to reach
 *  those actions now that the transcript is plain lines, not a clickable card.
 *  A null onClick renders an inert badge: crosstalk turns have no ONE speaker
 *  for a menu to act on, so their badge just states the voice count. */
class TranscriptAvatarWidget extends WidgetType {
	constructor(private name: string, private glyph: string, private color: string, private hasEmoji: boolean, private onClick: ((name: string, e: MouseEvent) => void) | null) {
		super();
	}
	eq(o: TranscriptAvatarWidget) {
		return o.name === this.name && o.glyph === this.glyph && o.color === this.color && o.hasEmoji === this.hasEmoji && !o.onClick === !this.onClick;
	}
	toDOM() {
		const s = document.createElement("span");
		s.className = "pa-tr-avatar pa-lp-avatar" + (this.hasEmoji ? " has-emoji" : "") + (this.onClick ? "" : " pa-lp-avatar-x");
		s.style.setProperty("--pa-speaker-color", this.color);
		s.textContent = this.glyph;
		s.setAttribute("aria-label", this.onClick ? `Speaker options for ${this.name}` : this.name);
		const onClick = this.onClick;
		if (onClick) {
			s.addEventListener("mousedown", (e) => e.preventDefault()); // keep the click from moving the cursor
			s.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				onClick(this.name, e);
			});
		}
		return s;
	}
	ignoreEvent() {
		return true;
	}
}

/** A zero-width line break dropped after a turn's "Name  time" label so the
 *  spoken text sits on its own line below it, Otter-style, without touching the
 *  underlying single-line Markdown. */
class TranscriptBreakWidget extends WidgetType {
	eq() {
		return true;
	}
	toDOM() {
		const br = document.createElement("br");
		br.className = "pa-lp-br";
		return br;
	}
	ignoreEvent() {
		return true;
	}
}

/** Live Preview styling for the transcript. The transcript is plain speaker
 *  lines under the "## Transcript" heading, so it is always visible and
 *  editable; this badges each turn with the speaker's avatar and tints the name
 *  and timestamp, right where you edit. Legacy notes whose transcript is still
 *  wrapped in a `> [!transcript]` callout are handled too (the `> ` markers and
 *  callout syntax are hidden), until they are migrated to plain lines. In Source
 *  mode this does nothing — the real Markdown shows. */
function transcriptLivePreview(plugin: PowerAssistantPlugin) {
	// decorate one line of the transcript section: a speaker turn, a legacy
	// callout header, or a legacy `> ` quote line
	const styleLine = (line: { from: number; text: string }, cur: number, decos: Range<Decoration>[]) => {
		const header = parseTranscriptHeaderLine(line.text);
		if (header) {
			if (header.hideTo > 0) decos.push(Decoration.replace({}).range(line.from, line.from + header.hideTo));
			return;
		}
		const sp = parseTranscriptSpeakerLine(line.text);
		if (sp) {
			// a crosstalk turn (several voices at once) gets a muted label and
			// an inert voice-count badge instead of one speaker's color and
			// menu: there is no single person to rename or restyle here
			const cross = !!sp.voices;
			const emoji = cross ? "" : plugin.emojiFor(sp.name);
			const color = cross ? "var(--text-muted)" : plugin.speakerColorFor(sp.name);
			decos.push(Decoration.line({ class: "pa-lp-tr" + (cross ? " pa-lp-tr-x" : "") + (line.from === cur ? " pa-lp-tr-current" : "") }).range(line.from));
			if (sp.prefixLen > 0) decos.push(Decoration.replace({}).range(line.from, line.from + sp.prefixLen));
			decos.push(
				Decoration.widget({
					widget: new TranscriptAvatarWidget(
						sp.name,
						cross ? String(sp.voices!.length) : speakerGlyph(sp.name, emoji),
						color,
						!!emoji,
						cross ? null : (name, e) => plugin.openSpeakerMenuFromEditor(name, e)
					),
					side: -1,
				}).range(line.from + sp.prefixLen)
			);
			decos.push(
				Decoration.mark({
					class: "pa-lp-tr-name" + (cross ? " pa-lp-tr-name-x" : ""),
					attributes: { style: `--pa-speaker-color:${color}`, ...(cross ? {} : { "data-speaker": sp.name }) },
				}).range(line.from + sp.nameFrom, line.from + sp.nameTo)
			);
			if (sp.stampFrom != null && sp.stampTo != null) {
				const secs = parseStamp(line.text.slice(sp.stampFrom, sp.stampTo).replace(/[[\]]/g, ""));
				// hide the "[ … ]:" around the time, showing just "m:ss" in gray
				decos.push(Decoration.replace({}).range(line.from + sp.stampFrom, line.from + sp.stampFrom + 1));
				decos.push(
					Decoration.mark({ class: "pa-lp-tr-stamp", attributes: secs != null ? { "data-secs": String(secs) } : {} }).range(line.from + sp.stampFrom + 1, line.from + sp.stampTo - 1)
				);
				decos.push(Decoration.replace({}).range(line.from + sp.stampTo - 1, line.from + sp.stampTo + 1));
			}
			// drop the spoken text onto its own line below the "Name  time" header
			const label = /^(?:>[ \t]?)?\*\*.+?:\*\*[ \t]?/.exec(line.text);
			if (label && label[0].length < line.text.length)
				decos.push(Decoration.widget({ widget: new TranscriptBreakWidget(), side: -1 }).range(line.from + label[0].length));
			return;
		}
		const prefix = /^>[ \t]?/.exec(line.text); // legacy blank/continuation quote line
		if (prefix && prefix[0].length > 0) decos.push(Decoration.replace({}).range(line.from, line.from + prefix[0].length));
		else if (line.text.trim() && !/^!\[\[/.test(line.text))
			// a continuation line of a multi-line turn: align it with the body text
			decos.push(Decoration.line({ class: "pa-lp-tr-cont" }).range(line.from));
	};
	const build = (view: EditorView): DecorationSet => {
		// Live Preview only; in Source mode Obsidian should show the real Markdown
		if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
		const decos: Range<Decoration>[] = [];
		try {
			const doc = view.state.doc;
			const cur = view.state.field(playingTurnField, false) ?? -1;
			let i = 1;
			while (i <= doc.lines) {
				if (!/^##\s+Transcript\s*$/.test(doc.line(i).text)) {
					i++;
					continue;
				}
				// style every line of the section until the next heading (or EOF)
				for (i++; i <= doc.lines && !/^#{1,6}\s/.test(doc.line(i).text); i++) styleLine(doc.line(i), cur, decos);
			}
		} catch (e) {
			console.error("Power Assistant: transcript Live Preview failed", e);
		}
		return Decoration.set(decos, true);
	};
	const view = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(u: ViewUpdate) {
				const forced = u.transactions.some((t) => t.effects.some((e) => e.is(refreshTranscriptEffect) || e.is(setPlayingTurn)));
				if (u.docChanged || u.selectionSet || u.viewportChanged || forced) this.decorations = build(u.view);
			}
		},
		{ decorations: (v) => v.decorations }
	);
	// click a speaker name to open its menu, or a timestamp to seek the audio —
	// mousedown is suppressed first so the click does not just move the cursor
	const clicks = EditorView.domEventHandlers({
		mousedown: (e: MouseEvent, cmView: EditorView) => {
			// a crosstalk label (-x) opens no menu, so its text keeps the
			// normal click-to-place-cursor behavior instead of a dead click
			if ((e.target as HTMLElement)?.closest?.(".pa-lp-tr-name:not(.pa-lp-tr-name-x), .pa-lp-tr-stamp")) {
				e.preventDefault();
				return;
			}
			// Alt/Ctrl+click a word inside a turn: play the audio from about there
			if ((e.altKey || e.ctrlKey || e.metaKey) && (e.target as HTMLElement)?.closest?.(".cm-line.pa-lp-tr")) {
				const pos = cmView.posAtCoords({ x: e.clientX, y: e.clientY });
				const secs = pos == null ? null : plugin.wordTimeAt(cmView, pos);
				if (secs != null) {
					e.preventDefault();
					plugin.seekFromEditor(secs);
				}
			}
		},
		click: (e: MouseEvent) => {
			const t = e.target as HTMLElement;
			const nameEl = t?.closest?.(".pa-lp-tr-name") as HTMLElement | null;
			if (nameEl?.dataset.speaker) {
				plugin.openSpeakerMenuFromEditor(nameEl.dataset.speaker, e);
				return true;
			}
			const stampEl = t?.closest?.(".pa-lp-tr-stamp") as HTMLElement | null;
			if (stampEl?.dataset.secs) {
				plugin.seekFromEditor(Number(stampEl.dataset.secs));
				return true;
			}
			return false;
		},
	});
	return [playingTurnField, view, clicks];
}

/** Cached height (px) of the app's bottom-chrome bar the player aligns with,
 *  captured the last time a player could measure it. Reused as a fallback if a
 *  later mount reads zero (e.g. the footer is momentarily absent). */
let lastBottomBarHeight = 0;

/** An Otter-style sticky player for a capture note's audio: transport controls,
 *  a scrubbable progress bar with a hover time tooltip, playback speed, and a
 *  live link to the transcript — the turn playing now is highlighted and, while
 *  playing, scrolled into view. It drives the note's own <audio> embed. */
class TranscriptPlayer {
	readonly bar: HTMLElement;
	private playBtn!: HTMLElement;
	private curEl!: HTMLElement;
	private totEl!: HTMLElement;
	private fill!: HTMLElement;
	private knob!: HTMLElement;
	private tip!: HTMLElement;
	private speedBtn!: HTMLElement;
	private readonly speeds = [1, 1.25, 1.5, 2];
	private speedIdx = 0;
	private lastPos = -2;
	private scrubbing = false; // true only while the user is dragging the scrub bar
	private readonly off: Array<() => void> = [];

	private readonly frame: HTMLElement;
	readonly audio: HTMLAudioElement;

	constructor(private plugin: PowerAssistantPlugin, readonly view: MarkdownView, readonly file: TFile) {
		// drive the audio file directly rather than the note's rendered <audio>
		// embed, which Obsidian only renders once you scroll to the bottom of a
		// long transcript — so the player is ready the moment the note opens
		this.audio = new Audio(plugin.app.vault.getResourcePath(file));
		fixAudioDuration(this.audio);
		this.bar = this.build();
		// mount on the (non-scrolling) content frame so the bar stays pinned to
		// the bottom of the view while the transcript scrolls inside it
		this.frame = (this.view.containerEl.querySelector(".view-content") as HTMLElement | null) ?? this.view.containerEl;
		this.frame.appendChild(this.bar);
		this.frame.addClass("pa-has-player");
		// match the player's height to the app's bottom chrome so their top edges
		// line up: the bottom-left vault/profile footer (the bar sitting beside it),
		// or the status bar if that footer is hidden. The vault footer isn't hidden
		// by the player, so this reads true even on remounts; cache the last good value.
		const doc = this.frame.ownerDocument;
		const bottomBar = (doc.body.querySelector(".workspace-sidedock-vault-profile") ?? doc.body.querySelector(".status-bar")) as HTMLElement | null;
		const barH = bottomBar?.offsetHeight ?? 0;
		if (barH > 0) lastBottomBarHeight = barH;
		if (lastBottomBarHeight > 0) this.frame.style.setProperty("--pa-player-h", `${lastBottomBarHeight}px`);
		document.body.addClass("pa-player-active"); // let CSS clear the status bar off the player
		this.render();
	}

	isFor(view: MarkdownView, file: TFile) {
		return this.view === view && this.file === file && this.bar.isConnected;
	}

	/** Seek to `secs` and play — used by timestamp/word clicks in the transcript. */
	seek(secs: number) {
		if (!Number.isFinite(secs)) return;
		const fm = this.file ? this.plugin.app.metadataCache.getFileCache(this.view.file ?? this.file)?.frontmatter : undefined;
		const partsMs = Array.isArray(fm?.parts) ? (fm!.parts as unknown[]).map(Number) : [0];
		const { secondsInPart } = partForStamp(partsMs.length ? partsMs : [0], secs);
		this.audio.currentTime = secondsInPart;
		void this.audio.play();
	}

	private cm(): EditorView | undefined {
		return (this.view.editor as unknown as { cm?: EditorView }).cm;
	}

	private build(): HTMLElement {
		const bar = createDiv({ cls: "pa-player" });
		const btn = (icon: string, label: string, onClick: () => void, skip?: string) => {
			const b = bar.createEl("button", { cls: "pa-player-btn", attr: { "aria-label": label } });
			setIcon(b, icon);
			if (skip) b.createSpan({ cls: "pa-player-skip", text: skip });
			b.addEventListener("click", onClick);
			return b;
		};
		btn("rotate-ccw", "Back 5 seconds", () => (this.audio.currentTime = Math.max(0, this.audio.currentTime - 5)), "5");
		this.playBtn = btn("play", "Play or pause", () => (this.audio.paused ? void this.audio.play() : this.audio.pause()));
		this.playBtn.addClass("pa-player-play");
		btn("rotate-cw", "Forward 5 seconds", () => (this.audio.currentTime = Math.min(this.dur() || 1e9, this.audio.currentTime + 5)), "5");
		this.speedBtn = bar.createEl("button", { cls: "pa-player-btn pa-player-speed", text: "1x", attr: { "aria-label": "Playback speed" } });
		this.speedBtn.addEventListener("click", () => this.cycleSpeed());
		this.curEl = bar.createEl("span", { cls: "pa-player-time", text: "0:00" });
		const track = bar.createDiv({ cls: "pa-player-track" });
		this.fill = track.createDiv({ cls: "pa-player-fill" });
		this.knob = track.createDiv({ cls: "pa-player-knob" });
		this.tip = track.createDiv({ cls: "pa-player-tip" });
		this.totEl = bar.createEl("span", { cls: "pa-player-time", text: "0:00" });
		this.wireTrack(track);
		const on = (ev: string, fn: () => void) => {
			this.audio.addEventListener(ev, fn);
			this.off.push(() => this.audio.removeEventListener(ev, fn));
		};
		on("timeupdate", () => this.render());
		on("durationchange", () => this.render());
		on("play", () => setIcon(this.playBtn, "pause"));
		on("pause", () => setIcon(this.playBtn, "play"));
		return bar;
	}

	private dur() {
		return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
	}

	private cycleSpeed() {
		this.speedIdx = (this.speedIdx + 1) % this.speeds.length;
		const rate = this.speeds[this.speedIdx];
		this.audio.playbackRate = rate;
		this.speedBtn.setText(`${rate}x`);
	}

	private wireTrack(track: HTMLElement) {
		const frac = (clientX: number) => {
			const r = track.getBoundingClientRect();
			return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		};
		const seek = (clientX: number) => {
			if (this.dur() > 0) this.audio.currentTime = frac(clientX) * this.dur();
		};
		track.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.scrubbing = true;
			seek(e.clientX);
			const move = (ev: MouseEvent) => seek(ev.clientX);
			const up = () => {
				this.scrubbing = false;
				document.removeEventListener("mousemove", move);
				document.removeEventListener("mouseup", up);
			};
			document.addEventListener("mousemove", move);
			document.addEventListener("mouseup", up);
		});
		track.addEventListener("mousemove", (e) => {
			if (this.dur() <= 0) return;
			const f = frac(e.clientX);
			this.tip.setText(fmtClock(f * this.dur()));
			this.tip.style.left = `${f * 100}%`;
			this.tip.addClass("is-visible");
		});
		track.addEventListener("mouseleave", () => this.tip.removeClass("is-visible"));
	}

	private render() {
		const dur = this.dur();
		const cur = this.audio.currentTime || 0;
		this.curEl.setText(fmtClock(cur));
		this.totEl.setText(fmtClock(dur));
		const pct = dur > 0 ? (cur / dur) * 100 : 0;
		this.fill.style.width = `${pct}%`;
		this.knob.style.left = `${pct}%`;
		this.syncTranscript(cur);
	}

	/** Highlight the turn playing now, and scroll to it while playing. */
	private syncTranscript(cur: number) {
		const cm = this.cm();
		if (!cm) return;
		const doc = cm.state.doc;
		let pos = -1;
		for (let i = 1; i <= doc.lines; i++) {
			const line = doc.line(i);
			const sp = parseTranscriptSpeakerLine(line.text);
			if (!sp || sp.stampFrom == null || sp.stampTo == null) continue;
			const secs = parseStamp(line.text.slice(sp.stampFrom, sp.stampTo).replace(/[[\]]/g, ""));
			if (secs == null) continue;
			if (secs <= cur + 0.25) pos = line.from;
			else break;
		}
		if (pos === this.lastPos) return;
		this.lastPos = pos;
		cm.dispatch({ effects: setPlayingTurn.of(pos) });
		// follow the turn ONLY while the audio is playing or the user is actively
		// scrubbing. Otherwise opening a note (audio parked at 0:00, paused) would
		// scroll straight to the first turn instead of leaving you at the top. A
		// manual scroll never changes currentTime, so this never fights you.
		if (pos >= 0 && (!this.audio.paused || this.scrubbing)) cm.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
	}

	destroy() {
		for (const off of this.off) off();
		this.audio.pause();
		this.audio.src = "";
		this.bar.remove();
		this.frame.removeClass("pa-has-player");
		document.body.removeClass("pa-player-active");
		this.cm()?.dispatch({ effects: setPlayingTurn.of(-1) });
	}
}

function decorateStamps(root: HTMLElement, partsMs?: number[]) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const hits: Text[] = [];
	let node: Node | null;
	while ((node = walker.nextNode())) {
		STAMP_RE.lastIndex = 0;
		if (STAMP_RE.test(node.nodeValue ?? "")) hits.push(node as Text);
	}
	for (const text of hits) {
		const parent = text.parentElement;
		if (!parent || parent.closest("a, code, pre, .ptc-stamp")) continue;
		const s = text.nodeValue ?? "";
		const frag = document.createDocumentFragment();
		let at = 0;
		STAMP_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = STAMP_RE.exec(s))) {
			if (m.index > at) frag.appendChild(document.createTextNode(s.slice(at, m.index)));
			const secs = parseStamp(m[1]);
			const a = document.createElement("a");
			a.className = "ptc-stamp";
			a.textContent = m[0];
			a.setAttribute("aria-label", "Jump the recording to " + m[1]);
			keepRendered(a);
			a.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (secs == null) return;
				const scope = a.closest(".markdown-reading-view, .markdown-preview-view, .markdown-embed") ?? document;
				const audios = Array.from(scope.querySelectorAll<HTMLMediaElement>("audio, video"));
				if (!audios.length) {
					new Notice("Power Assistant: open the note in Reading view so the recording is loaded.");
					return;
				}
				const { index, secondsInPart } = partForStamp(partsMs?.length ? partsMs : [0], secs);
				const audio = audios[Math.min(index, audios.length - 1)];
				for (const other of audios) if (other !== audio) other.pause();
				audio.currentTime = secondsInPart;
				void audio.play();
			});
			frag.appendChild(a);
			at = m.index + m[0].length;
		}
		if (at < s.length) frag.appendChild(document.createTextNode(s.slice(at)));
		parent.replaceChild(frag, text);
	}
}

/** The purpose-built transcript block: inside a [!transcript] callout, every
 *  speaker label (named or "Speaker X") gets that speaker's color and, on
 *  click, opens the Correct dialog prefilled with the name — so renaming a
 *  speaker is one click and is remembered for future meetings. */
const TRANSCRIPT_LABEL_RE = /^(.+?) \[\d{1,2}:\d{2}(?::\d{2})?\]:$/;
/** Turn context for the speaker menu, from one raw transcript line (the Live
 *  Preview path, where the clicked avatar's document line is knowable). */
function turnFromLine(text: string): { stampSecs: number | null; ref: TurnRef } | null {
	const sp = parseTranscriptSpeakerLine(text);
	if (!sp) return null;
	const stamp = sp.stampFrom != null && sp.stampTo != null ? text.slice(sp.stampFrom, sp.stampTo) : null;
	const labelEnd = sp.stampTo ?? sp.nameTo;
	const after = /^:\*\*[ \t]?/.exec(text.slice(labelEnd));
	const hint = text
		.slice(labelEnd + (after ? after[0].length : 0))
		.trim()
		.slice(0, 60);
	return {
		stampSecs: stamp ? parseStamp(stamp.replace(/[[\]]/g, "")) : null,
		ref: { name: sp.name, stamp, textHint: hint || undefined },
	};
}

/** Turn context for a rendered label: the stamp read out of the label itself,
 *  and the turn's first words (the paragraph minus its labels and avatars) to
 *  break a same-second tie. Chunked rendering has no line numbers, so this is
 *  how a Reading-view click finds its ONE line again. */
function turnFromRendered(strong: HTMLElement, name: string): { stampSecs: number | null; ref: TurnRef } {
	const sm = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/.exec(strong.textContent ?? "");
	let hint = "";
	const p = strong.parentElement;
	if (p) {
		const clone = p.cloneNode(true) as HTMLElement;
		for (const kill of Array.from(clone.querySelectorAll("strong, .pa-tr-avatar"))) kill.remove();
		hint = (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
	}
	return { stampSecs: sm ? parseStamp(sm[1]) : null, ref: { name, stamp: sm ? `[${sm[1]}]` : null, textHint: hint || undefined } };
}

/** Decorate one rendered `**Name [m:ss]:**` label: speaker color, an avatar
 *  before it, and the speaker menu on click — with the clicked TURN identified,
 *  so the menu can play or move that one line. */
function decorateTurnLabel(
	strong: HTMLElement,
	colorFor: (name: string) => string,
	emojiFor: (name: string) => string,
	onSpeaker: (name: string, evt: MouseEvent, turn?: { stampSecs: number | null; ref: TurnRef }) => void,
	onPlay?: (secs: number) => void
) {
	if (strong.classList.contains("pa-tr-speaker")) return;
	const m = TRANSCRIPT_LABEL_RE.exec(strong.textContent ?? "");
	if (!m) return;
	const name = m[1].trim();
	const color = colorFor(name);
	const openMenu = (e: Event) => {
		e.preventDefault();
		e.stopPropagation();
		onSpeaker(name, e as MouseEvent, turnFromRendered(strong, name));
	};
	strong.classList.add("pa-tr-speaker");
	strong.dataset.speaker = name;
	strong.style.setProperty("--pa-speaker-color", color);
	strong.setAttribute("aria-label", `Speaker options for ${name}`);
	// the [m:ss] stamp inside the label keeps its own click (it stops
	// propagation); clicking the name opens the speaker menu
	keepRendered(strong);
	strong.addEventListener("click", openMenu);
	// a colored avatar (the speaker's emoji, or their initial) before the label
	const p = strong.parentElement;
	if (p && !p.querySelector(".pa-tr-avatar")) {
		const av = document.createElement("span");
		av.className = "pa-tr-avatar";
		av.dataset.speaker = name;
		av.style.setProperty("--pa-speaker-color", color);
		const emoji = emojiFor(name);
		av.textContent = speakerGlyph(name, emoji);
		av.toggleClass("has-emoji", !!emoji);
		av.setAttribute("aria-label", `Speaker options for ${name}`);
		keepRendered(av);
		av.addEventListener("click", openMenu);
		p.insertBefore(av, p.firstChild);
	}
	// Otter's gesture: click anywhere in the turn's words to hear that turn.
	// Labels, stamps, and avatars keep their own clicks; a text selection in
	// progress means copying, not asking for playback.
	if (p && onPlay && !p.classList.contains("pa-tr-turn")) {
		p.classList.add("pa-tr-turn");
		p.addEventListener("click", (e) => {
			const t = e.target as HTMLElement;
			if (t.closest(".pa-tr-avatar, .pa-tr-speaker, a, button")) return;
			const sel = window.getSelection();
			if (sel && !sel.isCollapsed) return;
			const sm = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/.exec(strong.textContent ?? "");
			const secs = sm ? parseStamp(sm[1]) : null;
			if (secs != null) onPlay(secs);
		});
	}
}

function enhanceTranscriptCallout(
	root: HTMLElement,
	colorFor: (name: string) => string,
	emojiFor: (name: string) => string,
	onSpeaker: (name: string, evt: MouseEvent, turn?: { stampSecs: number | null; ref: TurnRef }) => void,
	onPlay?: (secs: number) => void
) {
	for (const callout of Array.from(root.querySelectorAll<HTMLElement>('.callout[data-callout="transcript"]'))) {
		callout.classList.add("pa-transcript");
		// a "Highlights only" toggle in the header filters to highlighted turns
		const title = callout.querySelector<HTMLElement>(".callout-title");
		if (title && !title.querySelector(".pa-tr-hltoggle")) {
			const btn = title.createEl("button", { cls: "pa-tr-hltoggle", text: "Highlights only" });
			keepRendered(btn);
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation(); // do not fold the callout
				btn.toggleClass("is-on", callout.classList.toggle("pa-only-highlights"));
			});
		}
		// a turn line that starts with 💬 is a comment: render it as a soft bubble
		for (const p of Array.from(callout.querySelectorAll<HTMLElement>(".callout-content > p"))) {
			if (!p.classList.contains("pa-tr-comment") && (p.textContent ?? "").trimStart().startsWith("💬")) p.classList.add("pa-tr-comment");
		}
		for (const strong of Array.from(callout.querySelectorAll<HTMLElement>("strong"))) decorateTurnLabel(strong, colorFor, emojiFor, onSpeaker, onPlay);
	}
	// plain transcripts (no callout wrapper — every capture since the callout
	// retired) get the same treatment in Reading view: a stamped label is a
	// transcript turn, and body prose never bolds a "Name [m:ss]:" shape
	for (const strong of Array.from(root.querySelectorAll<HTMLElement>("strong"))) {
		if (strong.closest('.callout[data-callout="transcript"]')) continue;
		decorateTurnLabel(strong, colorFor, emojiFor, onSpeaker, onPlay);
	}
}

/** The avatar glyph for a speaker: their emoji if set, else their initial. */
function speakerGlyph(name: string, emoji: string): string {
	return emoji || (name.replace(/^Speaker\s*/i, "").trim()[0] || "?").toUpperCase();
}

/** Restyle every visible label and avatar for `name` after its color or emoji
 *  changes, so the edit shows immediately without a re-render. */
function restyleSpeaker(scope: HTMLElement | Document, name: string, color: string, emoji: string) {
	for (const el of Array.from(scope.querySelectorAll<HTMLElement>(".pa-tr-speaker, .pa-tr-avatar"))) {
		if (el.dataset.speaker !== name) continue;
		el.style.setProperty("--pa-speaker-color", color);
		if (el.classList.contains("pa-tr-avatar")) {
			el.textContent = speakerGlyph(name, emoji);
			el.toggleClass("has-emoji", !!emoji);
		}
	}
}

/** Unnamed "Speaker X" labels in Reading view open the rename dialog on
 *  click — Otter's tag-a-speaker gesture. Named labels stay plain text, and
 *  the stamp link inside a label keeps its own click (it stops propagation). */
function decorateSpeakerLabels(root: HTMLElement, onRename: () => void) {
	for (const strong of Array.from(root.querySelectorAll("strong"))) {
		if (strong.classList.contains("ptc-speaker") || strong.classList.contains("pa-tr-speaker")) continue;
		if (strong.closest('.callout[data-callout="transcript"]')) continue;
		// diarization labels only (A, B, 1A, 2B…) — never body prose like "Speaker notes:"
		if (!/^Speaker \d{0,2}[A-Z]{1,3}( \[\d+:\d{2}(?::\d{2})?\])?:$/.test(strong.textContent ?? "")) continue;
		strong.classList.add("ptc-speaker");
		strong.setAttribute("aria-label", "Rename speakers");
		keepRendered(strong);
		strong.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onRename();
		});
	}
}

/* ---------------- live transcript (sidebar) ---------------- */

const LIVE_VIEW = "pcap-live";
const ASSIST_VIEW = "pa-chat";
const USAGE_VIEW = "pa-usage";

/** The sidebar assistant: a running conversation over the vault. Each turn
 *  retrieves fresh excerpts (Power Explorer's shared index when present) and
 *  answers with wiki-link citations; Save summary writes the conversation up
 *  as a note in the Chats folder. */
class AssistantChatView extends ItemView {
	private turns: ChatTurn[] = [];
	private logEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private busy = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PowerAssistantPlugin
	) {
		super(leaf);
	}
	getViewType(): string {
		return ASSIST_VIEW;
	}
	getDisplayText(): string {
		return "Assistant";
	}
	getIcon(): string {
		return "sparkles";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("pa-chat");
		// cited [[notes]] in an answer are only links if we open them ourselves
		wireInternalLinks(this.app, root);
		const head = root.createDiv({ cls: "pa-chat-head" });
		head.createEl("button", { text: "New chat" }).addEventListener("click", () => this.reset());
		head.createEl("button", { text: "Save summary" }).addEventListener("click", () => void this.saveSummary());
		// Narrowing by who was there and how recent it was, carried over from the
		// dialog this panel replaced. They apply to the NEXT question rather than
		// the thread so far, so changing one mid-conversation is a normal move.
		const who = head.createEl("select", { cls: "dropdown pa-chat-filter" });
		who.createEl("option", { value: "", text: "Anyone" });
		for (const n of this.plugin.knownAttendees()) who.createEl("option", { value: n, text: n });
		who.addEventListener("change", () => (this.attendee = who.value));
		const when = head.createEl("select", { cls: "dropdown pa-chat-filter" });
		for (const [v, label] of [
			["0", "Any time"],
			["30", "Last 30 days"],
			["90", "Last 90 days"],
		] as const) {
			when.createEl("option", { value: v, text: label });
		}
		when.addEventListener("change", () => (this.afterDays = Number(when.value)));
		this.logEl = root.createDiv({ cls: "pa-chat-log" });
		this.hint();
		const row = root.createDiv({ cls: "pa-chat-inputrow" });
		this.inputEl = row.createEl("textarea", {
			cls: "pa-chat-input",
			attr: { rows: "2", placeholder: "Ask about your notes, meetings, people…" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		});
		row.createEl("button", { cls: "mod-cta pa-chat-send", text: "Send" }).addEventListener("click", () => void this.send());
		// the running conversation survives closing the panel and reloading:
		// restore it from settings and re-render the bubbles
		this.turns = [...this.plugin.settings.chatTurns];
		if (this.turns.length) {
			this.logEl.empty();
			for (const t of this.turns) {
				if (t.role === "user") this.bubble("pa-chat-user").setText(t.content);
				else await MarkdownRenderer.render(this.app, t.content, this.bubble("pa-chat-assist"), "", this);
			}
			this.logEl.lastElementChild?.scrollIntoView({ block: "nearest" });
		}
	}

	focusInput() {
		this.inputEl?.focus();
	}

	/** Persist the conversation (capped so data.json stays small). */
	private remember() {
		this.plugin.settings.chatTurns = this.turns.slice(-60);
		void this.plugin.saveSettings();
	}

	private hint() {
		if (!this.turns.length)
			this.logEl.createDiv({
				cls: "pa-chat-hint",
				text: "Ask anything about your vault: meetings, people, commitments, documents. Answers cite the notes they came from. Save summary writes the conversation up as a note when you are done.",
			});
	}

	private reset() {
		this.turns = [];
		this.remember();
		this.logEl.empty();
		this.hint();
	}

	private bubble(cls: string): HTMLElement {
		return this.logEl.createDiv({ cls: `pa-chat-b ${cls}` });
	}

	/** Filter state for the next question: nobody in particular, any time. */
	private attendee = "";
	private afterDays = 0;

	private async send() {
		const q = this.inputEl.value.trim();
		if (!q || this.busy) return;
		if (!this.plugin.llmReady()) {
			new Notice("Power Assistant: " + this.plugin.llmMissingMsg());
			return;
		}
		this.busy = true;
		this.inputEl.value = "";
		if (!this.turns.length) this.logEl.empty(); // drop the hint
		this.bubble("pa-chat-user").setText(q);
		const a = this.bubble("pa-chat-assist");
		a.setText("…");
		a.scrollIntoView({ block: "nearest" });
		try {
			// a short follow-up ("what about Rachel?") borrows the previous
			// question's words so retrieval keeps the thread's subject
			const prevQ = [...this.turns].reverse().find((t) => t.role === "user")?.content ?? "";
			const terms = tokenize(q.length < 30 && prevQ ? `${prevQ} ${q}` : q);
			const after = this.afterDays ? daysAgo(this.afterDays) : null;
			const hits = await this.plugin.retrieveFiltered(q.length < 30 && prevQ ? `${prevQ}\n${q}` : q, terms, {
				after,
				attendee: this.attendee || null,
			});
			if (!hits.length && (after || this.attendee)) {
				// silence here is the filters' doing, not the vault's: say so rather
				// than letting the model answer from nothing
				a.setText(`Nothing matched with those filters (${this.attendee || "anyone"}, ${this.afterDays ? `last ${this.afterDays} days` : "any time"}). Widen them and ask again.`);
				return;
			}
			// stream the reply as plain text (cheap, live), then render the final
			// answer as Markdown once complete (re-rendering Markdown per token janks)
			const answer = await this.plugin.claudeStream({ system: ASSISTANT_SYSTEM, messages: buildAssistantMessages(this.turns, q, hits) }, 1500, (snap) => {
				a.setText(snap);
				a.scrollIntoView({ block: "nearest" });
			});
			this.turns.push({ role: "user", content: q }, { role: "assistant", content: answer });
			this.remember();
			a.empty();
			await MarkdownRenderer.render(this.app, answer, a, "", this);
			a.scrollIntoView({ block: "nearest" });
		} catch (e) {
			a.setText("Failed: " + humanizeError(e instanceof Error ? e.message : String(e)));
		} finally {
			this.busy = false;
			this.inputEl.focus();
		}
	}

	private async saveSummary() {
		if (this.turns.length < 2) {
			new Notice("Power Assistant: nothing to summarize yet.");
			return;
		}
		if (this.busy) return;
		this.busy = true;
		try {
			const transcript = this.turns.map((t) => `${t.role === "user" ? "You" : "Assistant"}: ${t.content}`).join("\n\n");
			const raw = await this.plugin.claudeChat(
				{
					system:
						"You summarize a conversation between the user and their notes assistant. First line exactly: TITLE: <a short 3-6 word topic>. Then a concise Markdown summary: what was asked, what was found (keep any [[wiki-links]]), and decisions or follow-ups. No preamble.",
					messages: [{ role: "user", content: transcript }],
				},
				900
			);
			const { title, summary } = parseChatSummary(raw);
			const date = today();
			const md = buildChatNote({ title, date, time: clockTime(Date.now()), summary, turns: this.turns });
			await this.plugin.saveChatNote(`${date} ${title}`, md);
		} catch (e) {
			new Notice("Power Assistant: could not save the summary. " + humanizeError(e instanceof Error ? e.message : String(e)), 8000);
		} finally {
			this.busy = false;
		}
	}
}

/** Obsidian wires [[wiki-link]] clicks inside its own markdown views, but not
 *  inside a panel or modal we render into ourselves: the citation renders as a
 *  proper link and then does nothing when clicked. Open it by hand. Delegated
 *  from a stable container, so it keeps working as chat bubbles and answers are
 *  emptied and re-rendered underneath, and it never stacks duplicate handlers.
 *  Ctrl/Cmd-click opens in a new tab, matching the rest of Obsidian. */
function wireInternalLinks(app: App, container: HTMLElement, sourcePath = "") {
	container.addEventListener("click", (evt) => {
		const link = (evt.target as HTMLElement | null)?.closest?.("a.internal-link") as HTMLElement | null;
		if (!link) return;
		evt.preventDefault();
		// data-href carries the real target; href and the label are fallbacks
		const href = link.getAttribute("data-href") || link.getAttribute("href") || link.textContent || "";
		if (href) void app.workspace.openLinkText(href, sourcePath, evt.ctrlKey || evt.metaKey);
	});
}

/** Money for the meter: cents matter here, so a real-but-tiny total must not
 *  round down to a flat $0.00 and read as "free". */
function usdLabel(n: number): string {
	if (n <= 0) return "$0.00";
	return n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

function tokenLabel(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Ledger feature tags are terse (they are written on every call); the meter
 *  spells them out. Unknown tags show as-is rather than vanishing. */
const FEATURE_LABELS: Record<string, string> = {
	meeting: "Meeting extraction",
	transcribe: "Transcription",
	chat: "Assistant chat",
	ask: "Ask your vault",
	ocr: "Document extraction",
	names: "Speaker names",
	agenda: "1:1 agenda",
	summary: "Weekly digest",
	misc: "Other",
};

/** The AI usage meter: what this vault has spent on Claude and on transcription,
 *  totalled from the ledger every AI call appends to. These are estimates, not a
 *  bill: the Anthropic Console is the truth for Claude, and the transcription
 *  provider's own dashboard is the truth for audio. */
class UsageMeterView extends ItemView {
	private rangeDays = 30;
	private bodyEl!: HTMLElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: PowerAssistantPlugin
	) {
		super(leaf);
	}
	getViewType(): string {
		return USAGE_VIEW;
	}
	getDisplayText(): string {
		return "AI usage";
	}
	getIcon(): string {
		return "gauge";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("pa-usage");
		const head = root.createDiv({ cls: "pa-usage-head" });
		const sel = head.createEl("select", { cls: "dropdown pa-usage-range" });
		for (const [value, label] of [
			["1", "Today"],
			["7", "Last 7 days"],
			["30", "Last 30 days"],
			["0", "All time"],
		])
			sel.createEl("option", { value, text: label });
		sel.value = String(this.rangeDays);
		sel.addEventListener("change", () => {
			this.rangeDays = Number(sel.value);
			this.refresh();
		});
		head.createEl("button", { text: "Refresh" }).addEventListener("click", () => this.refresh());
		this.bodyEl = root.createDiv({ cls: "pa-usage-body" });
		this.refresh();
	}

	/** Re-render from the ledger. Called on open, on a range change, and by the
	 *  plugin after every logged call, so an open meter ticks up live. */
	refresh() {
		if (!this.bodyEl) return;
		// "Today" means since local midnight, not the last 24 hours
		const since =
			this.rangeDays === 0
				? 0
				: this.rangeDays === 1
					? new Date().setHours(0, 0, 0, 0)
					: Date.now() - this.rangeDays * 86400000;
		const s = summarizeUsage(this.plugin.settings.usageLedger, since);
		const b = this.bodyEl;
		b.empty();
		if (!this.plugin.settings.usageMeterEnabled) {
			b.createEl("p", { cls: "pa-usage-empty", text: "Usage logging is off. Turn it on in Power Assistant settings to start metering." });
			return;
		}
		if (!s.calls) {
			b.createEl("p", {
				cls: "pa-usage-empty",
				text: "Nothing recorded in this window yet. Transcribe a meeting or ask the assistant something and it will show up here.",
			});
			return;
		}
		const totals = b.createDiv({ cls: "pa-usage-totals" });
		this.card(totals, "Claude", usdLabel(s.llmUsd), `${tokenLabel(s.tokIn + s.tokOut)} tokens`);
		this.card(totals, "Transcription", usdLabel(s.audioUsd), `${Math.round(s.minutes)} min audio`);
		this.card(totals, "Total", usdLabel(s.totalUsd), `${s.calls} call${s.calls === 1 ? "" : "s"}`);
		this.table(
			b,
			"By feature",
			["Feature", "Calls", "Cost"],
			s.byFeature.map((f) => [FEATURE_LABELS[f.feature] ?? f.feature, String(f.calls), usdLabel(f.usd)])
		);
		this.table(b, "By model", ["Model", "Calls", "Cost"], s.byModel.map((m) => [m.model, String(m.calls), usdLabel(m.usd)]));
		this.table(
			b,
			"By day",
			["Day", "Claude", "Audio", "Total"],
			s.byDay
				.slice(-14)
				.reverse()
				.map((d) => [d.day, usdLabel(d.llmUsd), usdLabel(d.audioUsd), usdLabel(d.usd)])
		);
		b.createEl("p", {
			cls: "pa-usage-note",
			text: "Estimated from token counts and audio length at published rates. Your billed Claude total lives in the Anthropic Console; transcription is billed by your provider.",
		});
	}

	private card(parent: HTMLElement, label: string, value: string, sub: string) {
		const c = parent.createDiv({ cls: "pa-usage-card" });
		c.createDiv({ cls: "pa-usage-card-label", text: label });
		c.createDiv({ cls: "pa-usage-card-value", text: value });
		c.createDiv({ cls: "pa-usage-card-sub", text: sub });
	}

	private table(parent: HTMLElement, title: string, headers: string[], rows: string[][]) {
		if (!rows.length) return;
		parent.createEl("h4", { cls: "pa-usage-h", text: title });
		const t = parent.createEl("table", { cls: "pa-usage-table" });
		const hr = t.createEl("thead").createEl("tr");
		for (const h of headers) hr.createEl("th", { text: h });
		const tb = t.createEl("tbody");
		for (const row of rows) {
			const tr = tb.createEl("tr");
			for (const cell of row) tr.createEl("td", { text: cell });
		}
	}
}

class LiveView extends ItemView {
	private statusEl!: HTMLElement;
	private turnsEl!: HTMLElement;
	private partialEl!: HTMLElement;
	private marksEl!: HTMLElement;
	private panelEl!: HTMLElement;
	private recBarEl!: HTMLElement;
	private timerEl: HTMLElement | null = null;
	private meterBar: HTMLElement | null = null;
	private hintEl: HTMLElement | null = null;
	/** Recording monitor: the timer/meter animation loop and its analyser. */
	private monitorRAF: number | null = null;
	private monitorCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	/** Finished turns with their moment in the recording, for the copilot. */
	private turns: LiveTurn[] = [];
	private actionsSeen: string[] = [];
	private actionTimer: number | null = null;
	private lastScanIdx = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: PowerAssistantPlugin) {
		super(leaf);
	}

	getViewType() {
		return LIVE_VIEW;
	}

	getDisplayText() {
		return "Live transcript";
	}

	getIcon() {
		return "mic";
	}

	async onOpen() {
		const c = this.contentEl;
		c.empty();
		c.addClass("pcap-live");
		wireInternalLinks(this.app, c);
		const head = c.createDiv({ cls: "pcap-live-head" });
		this.statusEl = head.createDiv({ cls: "pcap-live-status", text: "Waiting for a recording…" });
		const btns = head.createDiv({ cls: "pcap-live-btns" });
		const catchUp = btns.createEl("button", { text: "Catch me up" });
		catchUp.addEventListener("click", () => void this.catchUp());
		const mark = btns.createEl("button", { text: "⚑ Mark moment", cls: "mod-cta" });
		mark.addEventListener("click", () => this.plugin.markMoment());
		this.recBarEl = c.createDiv({ cls: "pcap-live-recbar" });
		this.panelEl = c.createDiv({ cls: "pcap-live-panel" });
		this.hintEl = c.createDiv({ cls: "pcap-live-hint" });
		this.turnsEl = c.createDiv({ cls: "pcap-live-turns" });
		this.partialEl = c.createDiv({ cls: "pcap-live-partial" });
		this.marksEl = c.createDiv({ cls: "pcap-live-marks" });
	}

	/** Show the recording bar (a pulsing dot, a ticking elapsed timer, and a live
	 *  input-level meter) so a recording is visibly confirmed on ANY provider,
	 *  even when there is no streaming transcript. `live` = an AssemblyAI stream
	 *  will fill the transcript below; otherwise say it lands after you stop. */
	startMonitor(stream: MediaStream, live: boolean) {
		this.setStatus(live ? "Recording — live transcript on" : "Recording");
		this.recBarEl.empty();
		this.recBarEl.addClass("is-recording");
		this.recBarEl.createDiv({ cls: "pcap-rec-dot" });
		this.timerEl = this.recBarEl.createDiv({ cls: "pcap-rec-timer", text: "0:00" });
		const meter = this.recBarEl.createDiv({ cls: "pcap-rec-meter" });
		this.meterBar = meter.createDiv({ cls: "pcap-rec-meter-bar" });
		const stop = this.recBarEl.createEl("button", { cls: "pcap-rec-stop mod-warning", text: "◼ Stop" });
		stop.addEventListener("click", () => void this.plugin.toggleRecording());
		this.hintEl?.setText(live ? "" : "Live text needs AssemblyAI. Your full transcript appears here after you stop.");
		let buf: Uint8Array<ArrayBuffer> | null = null;
		try {
			this.monitorCtx = new AudioContext();
			this.analyser = this.monitorCtx.createAnalyser();
			this.analyser.fftSize = 512;
			this.monitorCtx.createMediaStreamSource(stream).connect(this.analyser);
			buf = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
		} catch {
			this.analyser = null; // meter unavailable; timer still runs
		}
		const tick = () => {
			this.timerEl?.setText(fmtTime(this.plugin.recElapsedMs()));
			if (this.analyser && buf) {
				this.analyser.getByteTimeDomainData(buf);
				let sum = 0;
				for (const v of buf) {
					const x = (v - 128) / 128;
					sum += x * x;
				}
				const pct = Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 240));
				if (this.meterBar) this.meterBar.style.width = `${pct}%`;
			}
			this.monitorRAF = window.requestAnimationFrame(tick);
		};
		this.monitorRAF = window.requestAnimationFrame(tick);
	}

	/** Freeze the recording bar when the recording ends. */
	stopMonitor() {
		if (this.monitorRAF != null) {
			window.cancelAnimationFrame(this.monitorRAF);
			this.monitorRAF = null;
		}
		void this.monitorCtx?.close().catch(() => {});
		this.monitorCtx = null;
		this.analyser = null;
		this.recBarEl?.removeClass("is-recording");
		if (this.meterBar) this.meterBar.style.width = "0%";
		this.setStatus("Recording ended.");
	}

	/** New recording session: clear the previous meeting's state. */
	reset() {
		this.turns = [];
		this.actionsSeen = [];
		this.lastScanIdx = 0;
		if (this.actionTimer != null) {
			window.clearTimeout(this.actionTimer);
			this.actionTimer = null;
		}
		this.turnsEl?.empty();
		this.marksEl?.empty();
		this.panelEl?.empty();
		this.partialEl?.setText("");
	}

	setStatus(t: string) {
		this.statusEl?.setText(t);
	}

	addTurn(t: string) {
		if (!t.trim()) return;
		this.turns.push({ ms: this.plugin.recElapsedMs(), text: t.trim() });
		this.turnsEl?.createDiv({ cls: "pcap-live-turn", text: t.trim() });
		this.partialEl?.setText("");
		this.turnsEl?.lastElementChild?.scrollIntoView({ block: "nearest" });
		this.queueActionScan();
	}

	setPartial(t: string) {
		this.partialEl?.setText(t);
	}

	addMark(m: Moment) {
		this.marksEl?.createDiv({ cls: "pcap-live-mark", text: `⚑ [${fmtTime(m.ms)}] ${m.label || "Mark"}` });
	}

	/** On-demand "what did I miss": the last ten minutes, summarized. */
	private async catchUp() {
		if (!this.plugin.llmReady()) {
			new Notice("Power Assistant: " + this.plugin.llmMissingMsg());
			return;
		}
		// after a recording ends, the window anchors at the meeting's last turn
		const nowMs = this.plugin.recElapsedMs() || this.turns[this.turns.length - 1]?.ms || 0;
		const text = recentTurnsText(this.turns, nowMs + 1, 10 * 60000);
		if (!text.trim()) {
			new Notice("Power Assistant: nothing to summarize yet.");
			return;
		}
		this.setStatus("Summarizing the last few minutes…");
		try {
			const summary = await this.plugin.claude(buildCatchUpPrompt(text, 10), 400);
			this.panelEl.empty();
			this.panelEl.createDiv({ cls: "pcap-live-panel-title", text: "Catch-up" });
			await MarkdownRenderer.render(this.app, summary, this.panelEl.createDiv(), "", this.plugin);
		} catch (e) {
			new Notice("Power Assistant: catch-up failed: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			this.setStatus("Live — transcribing…");
		}
	}

	/** Best-effort commitment spotting over fresh turns, debounced so the
	 *  meeting costs pennies, silent on failure. */
	private queueActionScan() {
		if (!this.plugin.llmReady() || this.actionTimer != null) return;
		this.actionTimer = window.setTimeout(() => {
			this.actionTimer = null;
			void this.scanActions();
		}, 45000);
	}

	private async scanActions() {
		const fresh = this.turns.slice(this.lastScanIdx);
		if (fresh.length < 2) return;
		this.lastScanIdx = this.turns.length;
		try {
			const reply = await this.plugin.claude(
				buildLiveActionsPrompt(fresh.map((t) => t.text).join("\n").slice(-8000)),
				300
			);
			for (const a of parseLineList(reply, 5)) {
				const norm = a.toLowerCase().replace(/\W+/g, " ").trim();
				if (this.actionsSeen.includes(norm)) continue;
				this.actionsSeen.push(norm);
				this.marksEl?.createDiv({ cls: "pcap-live-action", text: `☐ ${a}` });
			}
		} catch (e) {
			console.warn("Power Assistant: live action scan failed.", e);
		}
	}
}

/** A floating on-page recording bar: a pulsing dot, a running timer, a live
 *  input-level meter, and Mark / Stop buttons. Bound to the note the recording
 *  started from, so it shows only when that note is the active tab and hides
 *  when you switch away (a note-less recording stays visible). */
class RecordingBar {
	private el: HTMLElement;
	private timerEl: HTMLElement;
	private meterBar: HTMLElement;
	private raf: number | null = null;
	private ctx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private buf: Uint8Array<ArrayBuffer> | null = null;
	private evRefs: EventRef[] = [];
	private stopClicked = false;

	constructor(
		private plugin: PowerAssistantPlugin,
		private notePath: string | null,
		stream: MediaStream
	) {
		this.el = document.body.createDiv({ cls: "pcap-recbar" });
		this.el.createDiv({ cls: "pcap-rec-dot" });
		this.timerEl = this.el.createDiv({ cls: "pcap-rec-timer", text: "0:00" });
		const meter = this.el.createDiv({ cls: "pcap-rec-meter" });
		this.meterBar = meter.createDiv({ cls: "pcap-rec-meter-bar" });
		this.el.createEl("button", { cls: "pcap-recbar-btn", text: "⚑ Mark" }).addEventListener("click", () => this.plugin.markMoment());
		const stopBtn = this.el.createEl("button", { cls: "pcap-rec-stop mod-warning", text: "◼ Stop" });
		stopBtn.addEventListener("click", () => {
			// second click while still stopping = force-release immediately; the
			// user should never be stuck watching "stopping…"
			if (this.stopClicked) {
				this.plugin.forceStopNow();
				return;
			}
			this.stopClicked = true;
			stopBtn.setText("◼ Force stop");
			void this.plugin.toggleRecording();
		});
		try {
			this.ctx = new AudioContext();
			this.analyser = this.ctx.createAnalyser();
			this.analyser.fftSize = 512;
			this.ctx.createMediaStreamSource(stream).connect(this.analyser);
			this.buf = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
		} catch {
			this.analyser = null;
		}
		this.evRefs.push(this.plugin.app.workspace.on("active-leaf-change", () => this.updateVisibility()));
		this.evRefs.push(this.plugin.app.workspace.on("file-open", () => this.updateVisibility()));
		this.updateVisibility();
		const tick = () => {
			// self-heal: a bar whose session ended, whose owner was replaced, or
			// whose plugin instance was unloaded must never linger as a zombie
			if (this.plugin.unloaded || !this.plugin.sessionActive() || this.plugin.recBar !== this) {
				this.destroy();
				return;
			}
			this.timerEl.setText(fmtTime(this.plugin.recElapsedMs()));
			if (this.analyser && this.buf) {
				this.analyser.getByteTimeDomainData(this.buf);
				let sum = 0;
				for (const v of this.buf) {
					const x = (v - 128) / 128;
					sum += x * x;
				}
				this.meterBar.style.width = `${Math.min(100, Math.round(Math.sqrt(sum / this.buf.length) * 240))}%`;
			}
			this.raf = window.requestAnimationFrame(tick);
		};
		this.raf = window.requestAnimationFrame(tick);
	}

	/** Show the bar only when the note it belongs to is the active tab. */
	private updateVisibility() {
		if (!this.notePath) return; // a note-less recording: always visible
		const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		this.el.toggleClass("is-hidden", active?.file?.path !== this.notePath);
	}

	destroy() {
		// never throws: callers treat destroy as unconditional cleanup
		if (this.raf != null) window.cancelAnimationFrame(this.raf);
		this.raf = null;
		try {
			void this.ctx?.close().catch(() => {});
		} catch {
			/* already closed */
		}
		this.ctx = null;
		try {
			this.evRefs.forEach((r) => this.plugin.app.workspace.offref(r));
		} catch {
			/* workspace gone */
		}
		this.evRefs = [];
		this.el.remove();
	}
}

/** The realtime leg: a temp-token websocket to AssemblyAI streaming fed by a
 *  16 kHz PCM tap on the recording stream. Strictly best-effort — any failure
 *  here leaves the actual recording (and batch transcription) untouched. */
class LiveSession {
	private ws: WebSocket | null = null;
	private ctx: AudioContext | null = null;
	private nodes: AudioNode[] = [];
	private stopped = false;

	constructor(
		private plugin: PowerAssistantPlugin,
		private stream: MediaStream,
		private view: LiveView | null
	) {}

	async start() {
		this.view?.reset();
		const key = this.plugin.settings.assemblyaiKey;
		let url: string;
		try {
			// v3 Universal-Streaming; token rides the query string (browsers
			// can't set websocket headers)
			const res = await requestUrl({
				url: "https://streaming.assemblyai.com/v3/token?expires_in_seconds=600",
				headers: { authorization: key },
				throw: true,
			});
			url = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true&token=${(res.json as { token: string }).token}`;
		} catch {
			// older accounts: the v2 realtime endpoint
			const res = await requestUrl({
				url: "https://api.assemblyai.com/v2/realtime/token",
				method: "POST",
				headers: { authorization: key, "Content-Type": "application/json" },
				body: JSON.stringify({ expires_in: 600 }),
				throw: true,
			});
			url = `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${(res.json as { token: string }).token}`;
		}
		if (this.stopped) return;
		const ws = new WebSocket(url);
		this.ws = ws;
		ws.binaryType = "arraybuffer";
		ws.onopen = () => {
			this.view?.setStatus("Live — transcribing…");
			this.tapAudio();
		};
		ws.onmessage = (ev) => {
			try {
				const j = JSON.parse(String(ev.data)) as Record<string, unknown>;
				if (j.type === "Turn") {
					// v3 shape
					const t = String(j.transcript ?? "");
					if (j.end_of_turn) this.view?.addTurn(t);
					else this.view?.setPartial(t);
				} else if (j.message_type === "FinalTranscript") this.view?.addTurn(String(j.text ?? ""));
				else if (j.message_type === "PartialTranscript") this.view?.setPartial(String(j.text ?? ""));
			} catch {
				/* non-JSON frame: ignore */
			}
		};
		ws.onerror = () => this.view?.setStatus("Live transcript connection error (recording is unaffected).");
		ws.onclose = () => {
			if (!this.stopped) this.view?.setStatus("Live transcript ended (recording continues).");
		};
	}

	private tapAudio() {
		const ctx = new AudioContext();
		this.ctx = ctx;
		const src = ctx.createMediaStreamSource(this.stream);
		const proc = ctx.createScriptProcessor(4096, 1, 1);
		const mute = ctx.createGain();
		mute.gain.value = 0; // the processor needs a route to destination to run; never audibly
		proc.onaudioprocess = (e) => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				const pcm = downsamplePCM16(e.inputBuffer.getChannelData(0), ctx.sampleRate);
				this.ws.send(pcm.buffer);
			}
		};
		src.connect(proc);
		proc.connect(mute);
		mute.connect(ctx.destination);
		this.nodes = [src, proc, mute];
	}

	stop(status?: string) {
		this.stopped = true;
		try {
			// both protocol generations understand their half of this
			if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "Terminate", terminate_session: true }));
		} catch {
			/* closing anyway */
		}
		try {
			this.ws?.close();
		} catch {
			/* closing anyway */
		}
		this.ws = null;
		for (const n of this.nodes) {
			try {
				n.disconnect();
			} catch {
				/* detached */
			}
		}
		this.nodes = [];
		void this.ctx?.close();
		this.ctx = null;
		if (status) this.view?.setStatus(status);
	}
}

/** A one-line human summary of a filing rule for the settings list. */
/** One line describing a mail rule, for the settings list. */
/** Pick a mail folder, then import it or scan its senders. Two actions on one
 *  list, because deciding what to block is a step you take before importing. */
class MailFolderModal extends Modal {
	private rows: { accountId: string; accountName: string; id: string; name: string; path: string }[] = [];

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin
	) {
		super(app);
	}

	async onOpen() {
		this.titleEl.setText("Import a mail folder");
		const c = this.contentEl;
		c.createEl("p", { cls: "pcap-field-help", text: "Loading folders…" });
		try {
			const imp = (this.plugin as unknown as { mailImporter(): { folders: () => Promise<typeof this.rows> } | null }).mailImporter();
			this.rows = imp ? await imp.folders() : [];
		} catch (e) {
			this.rows = [];
			console.warn("Power Assistant: could not list mail folders.", e);
		}
		c.empty();
		if (!this.rows.length) {
			c.createEl("p", { cls: "pcap-field-help", text: "No mail folders found. Connect a mailbox in Power Desk, open the inbox once so its folder tree loads, then try again." });
			return;
		}
		c.createEl("p", {
			cls: "pcap-field-help",
			text: "Scan senders first to see who fills a folder and block the noisy ones, then import. Importing collapses each back-and-forth into one note and writes a report of anything skipped.",
		});
		for (const row of this.rows) {
			new Setting(c)
				.setName(row.name)
				.setDesc(row.accountName)
				.addButton((b) =>
					b.setButtonText("Scan senders").onClick(() => {
						this.close();
						void this.plugin.mailSenderReport(row.accountId, row.id, row.name);
					})
				)
				.addButton((b) =>
					b
						.setButtonText("Import")
						.setCta()
						.onClick(() => {
							this.close();
							void this.plugin.importMailFolder(row.accountId, row.id, row.name);
						})
				)
				.addExtraButton((b) =>
					b
						.setIcon("sparkles")
						.setTooltip("Import with the AI relevance pass")
						.onClick(() => {
							this.close();
							void this.plugin.importMailFolder(row.accountId, row.id, row.name, { useAi: true });
						})
				);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

function txnRuleSummary(r: TxnRule): string {
	const when: string[] = [];
	if (r.from) when.push(`from ~ "${r.from}"`);
	if (r.subject) when.push(`subject ~ "${r.subject}"`);
	if (r.hasAttachment != null) when.push(r.hasAttachment ? "has attachment" : "no attachment");
	const then: string[] = [];
	if (r.vendor) then.push(`vendor = ${r.vendor}`);
	if (r.scope) then.push(r.scope);
	if (r.folder) then.push(`-> ${r.folder}`);
	if (r.enabled === false) then.push("(off)");
	return `${r.name ? r.name + ": " : ""}${when.join(", ") || "(no conditions)"}   ${then.join("  ")}`;
}

class TxnRuleModal extends Modal {
	private rule: TxnRule;
	constructor(
		app: App,
		existing: TxnRule,
		private onSave: (r: TxnRule) => void
	) {
		super(app);
		this.rule = { ...existing };
	}
	onOpen() {
		this.titleEl.setText("Mail rule");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "pcap-field-help",
			text: "When an incoming message matches every condition you set, its orders and bills are captured. Leave a condition blank to ignore it. Match the sender's real domain (bills often come from a mailing service, not the company's own website).",
		});
		new Setting(c).setName("Name").addText((t) => t.setPlaceholder("Amazon orders").setValue(this.rule.name ?? "").onChange((v) => (this.rule.name = v.trim() || undefined)));
		new Setting(c)
			.setName("From contains")
			.setDesc("Matched against the sender's name, address, and domain.")
			.addText((t) => t.setPlaceholder("amazon.com").setValue(this.rule.from ?? "").onChange((v) => (this.rule.from = v.trim() || undefined)));
		new Setting(c)
			.setName("Subject contains")
			.addText((t) => t.setPlaceholder("ordered:").setValue(this.rule.subject ?? "").onChange((v) => (this.rule.subject = v.trim() || undefined)));
		new Setting(c)
			.setName("Attachment")
			.setDesc("Require, or exclude, a message with files attached.")
			.addDropdown((d) => {
				d.addOption("", "Either");
				d.addOption("yes", "Must have one");
				d.addOption("no", "Must not have one");
				d.setValue(this.rule.hasAttachment == null ? "" : this.rule.hasAttachment ? "yes" : "no");
				d.onChange((v) => (this.rule.hasAttachment = v === "" ? undefined : v === "yes"));
			});
		new Setting(c)
			.setName("Vendor")
			.setDesc("Overrides the vendor name, for senders whose mail comes from a billing service.")
			.addText((t) => t.setPlaceholder("CoServ").setValue(this.rule.vendor ?? "").onChange((v) => (this.rule.vendor = v.trim() || undefined)));
		new Setting(c)
			.setName("Scope")
			.setDesc("Keeps company spending out of the household rollup.")
			.addDropdown((d) => {
				d.addOption("", "As extracted");
				d.addOption("personal", "Personal");
				d.addOption("business", "Business");
				d.setValue(this.rule.scope ?? "").onChange((v) => (this.rule.scope = v || undefined));
			});
		new Setting(c).setName("Enabled").addToggle((t) => t.setValue(this.rule.enabled !== false).onChange((v) => (this.rule.enabled = v)));
		new Setting(c).addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					if (!this.rule.from && !this.rule.subject && this.rule.hasAttachment == null) {
						new Notice("Power Assistant: a rule needs at least one condition, or it would match every message.");
						return;
					}
					this.onSave(this.rule);
					this.close();
				})
		);
	}
	onClose() {
		this.contentEl.empty();
	}
}

function docRuleSummary(r: DocRule): string {
	const when: string[] = [];
	if (r.vendor) when.push(`vendor ~ "${r.vendor}"`);
	if (r.docType) when.push(r.docType);
	if (r.amountOver != null) when.push(`amount ≥ ${r.amountOver}`);
	if (r.textContains) when.push(`text ~ "${r.textContains}"`);
	const then: string[] = [];
	if (r.folder) then.push(`→ ${r.folder}`);
	if (r.tags) then.push(`+${r.tags}`);
	if (r.flag) then.push("flag");
	return `${when.join(", ") || "(no conditions)"}   ${then.join("  ") || "(no actions)"}`;
}

/** Add or edit one document filing rule. */
class DocRuleModal extends Modal {
	private rule: DocRule;
	constructor(
		app: App,
		existing: DocRule,
		private onSave: (r: DocRule) => void
	) {
		super(app);
		this.rule = { ...existing };
	}
	onOpen() {
		this.titleEl.setText("Filing rule");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "setting-item-description",
			text: "When a processed document matches every condition you set, it is filed and tagged as below. Leave a condition blank to ignore it.",
		});
		new Setting(c).setName("Vendor contains").addText((t) => t.setValue(this.rule.vendor ?? "").onChange((v) => (this.rule.vendor = v.trim() || undefined)));
		new Setting(c).setName("Type").addDropdown((d) => {
			d.addOption("", "Any");
			for (const t of ["receipt", "bill", "invoice", "statement", "contract", "letter", "other"]) d.addOption(t, t[0].toUpperCase() + t.slice(1));
			d.setValue(this.rule.docType ?? "").onChange((v) => (this.rule.docType = v || undefined));
		});
		new Setting(c).setName("Amount over").addText((t) => {
			t.inputEl.type = "number";
			t.setValue(this.rule.amountOver != null ? String(this.rule.amountOver) : "").onChange((v) => {
				const n = parseFloat(v);
				this.rule.amountOver = isFinite(n) ? n : undefined;
			});
		});
		new Setting(c).setName("Text contains").addText((t) => t.setValue(this.rule.textContains ?? "").onChange((v) => (this.rule.textContains = v.trim() || undefined)));
		new Setting(c)
			.setName("File to folder")
			.setDesc("Supports {year}, {type}, {vendor}. Empty keeps the default type/year folder.")
			.addText((t) => t.setPlaceholder("Utilities/{year}").setValue(this.rule.folder ?? "").onChange((v) => (this.rule.folder = v.trim() || undefined)));
		new Setting(c).setName("Add tags").setDesc("Comma-separated.").addText((t) => t.setValue(this.rule.tags ?? "").onChange((v) => (this.rule.tags = v.trim() || undefined)));
		new Setting(c).setName("Flag for review").addToggle((t) => t.setValue(!!this.rule.flag).onChange((v) => (this.rule.flag = v)));
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { cls: "mod-cta", text: "Save" }).addEventListener("click", () => {
			if (!this.rule.vendor && !this.rule.docType && this.rule.amountOver == null && !this.rule.textContains) {
				new Notice("Power Assistant: a rule needs at least one condition.");
				return;
			}
			this.onSave(this.rule);
			this.close();
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

const SHARE_SUMMARY_SYSTEM =
	"You summarize a document for someone who has not read it and cannot see it. Lead with what it is and why it matters, then the substance: decisions, numbers, names, dates, and anything asked of the reader. " +
	"Use only what the document says; never invent, never soften, never pad. Markdown, a short paragraph plus tight bullets, no heading, no preamble, no sign-off. Aim for under 250 words.";

/** Send a page to someone who does not have the vault: the whole thing, or a
 *  summary of it, from the user's own mailbox.
 *
 *  Sending cannot be taken back, so nothing here is one click: the body is shown
 *  as it will be read before Send does anything, and Send stays disabled until
 *  there is somewhere valid for it to go. */
class SharePageModal extends Modal {
	private to = "";
	private cc = "";
	private subject = "";
	private intro = "";
	private mode: "full" | "summary" = "full";
	/** Cached so flipping back and forth does not buy the same summary twice. */
	private summary = "";
	private busy = false;
	private bodyEl!: HTMLElement;
	private sendEl!: HTMLButtonElement;

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private file: TFile,
		private markdown: string,
		private source: string
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Email this page");
		const c = this.contentEl;
		c.addClass("pcap-share");
		this.subject = this.file.basename;

		c.createEl("label", { cls: "pcap-field-label", text: "To" });
		const to = c.createEl("input", { cls: "pcap-field-input", attr: { type: "text", placeholder: "name@company.com, someone@else.com" } });
		to.addEventListener("input", () => ((this.to = to.value), this.paintSend()));

		c.createEl("label", { cls: "pcap-field-label", text: "Cc" });
		const cc = c.createEl("input", { cls: "pcap-field-input", attr: { type: "text", placeholder: "Optional" } });
		cc.addEventListener("input", () => ((this.cc = cc.value), this.paintSend()));

		c.createEl("label", { cls: "pcap-field-label", text: "Subject" });
		const subj = c.createEl("input", { cls: "pcap-field-input", attr: { type: "text" } });
		subj.value = this.subject;
		subj.addEventListener("input", () => ((this.subject = subj.value), this.paintSend()));

		c.createEl("label", { cls: "pcap-field-label", text: "Send" });
		const mode = c.createEl("select", { cls: "pcap-field-input dropdown" });
		mode.createEl("option", { value: "full", text: "The whole page" });
		mode.createEl("option", { value: "summary", text: "A summary of it" });
		mode.addEventListener("change", () => {
			this.mode = mode.value as "full" | "summary";
			void this.paintBody();
		});

		c.createEl("label", { cls: "pcap-field-label", text: "Your note" });
		const intro = c.createEl("textarea", { cls: "pcap-field-input", attr: { rows: "2", placeholder: "A line to open with (optional)…" } });
		intro.addEventListener("input", () => (this.intro = intro.value));

		c.createEl("label", { cls: "pcap-field-label", text: "What they will get" });
		this.bodyEl = c.createDiv({ cls: "pcap-share-body" });

		const foot = c.createDiv({ cls: "ptc-modal-btns" });
		this.sendEl = foot.createEl("button", { cls: "mod-cta", text: "Send" });
		this.sendEl.addEventListener("click", () => void this.send());
		foot.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

		this.paintSend();
		void this.paintBody();
	}

	/** The page as the reader will get it: the vault-only syntax is already gone,
	 *  so this shows what leaves, not what the note looks like in here. */
	private shareText(): string {
		return this.mode === "summary" ? this.summary : flattenForShare(this.markdown);
	}

	private async paintBody() {
		if (this.mode === "summary" && !this.summary) {
			if (!this.plugin.llmReady()) {
				this.bodyEl.setText("Set up the AI model in settings to summarize a page.");
				this.paintSend();
				return;
			}
			this.busy = true;
			this.paintSend();
			this.bodyEl.setText("Summarizing…");
			try {
				this.summary = await this.plugin.claude(
					{ system: SHARE_SUMMARY_SYSTEM, user: `Title: ${this.file.basename}\n\n${flattenForShare(this.markdown)}` },
					1200,
					undefined,
					"share"
				);
			} catch (e) {
				this.bodyEl.setText("Could not summarize: " + (e instanceof Error ? e.message : String(e)));
				this.busy = false;
				this.paintSend();
				return;
			}
			this.busy = false;
		}
		this.bodyEl.empty();
		const text = this.shareText();
		if (!text.trim()) {
			this.bodyEl.setText("This page has nothing in it to send.");
			this.paintSend();
			return;
		}
		await MarkdownRenderer.render(this.app, text, this.bodyEl, this.file.path, this.plugin);
		this.paintSend();
	}

	/** Send is off until there is a valid address, a subject, and something to
	 *  put in the mail. */
	private paintSend() {
		const to = parseRecipients(this.to);
		const bad = invalidRecipients([...to, ...parseRecipients(this.cc)]);
		const ready = !this.busy && to.length > 0 && bad.length === 0 && !!this.subject.trim() && !!this.shareText().trim();
		this.sendEl.disabled = !ready;
		this.sendEl.setText(ready && to.length > 1 ? `Send to ${to.length} people` : "Send");
	}

	private async send() {
		if (this.sendEl.disabled || this.busy) return;
		const to = parseRecipients(this.to);
		const cc = parseRecipients(this.cc);
		this.busy = true;
		this.paintSend();
		this.sendEl.setText("Sending…");
		try {
			// the page's own headline titles the mail when it has one, so the
			// reader gets the piece's name rather than a filename
			const { title, body } = splitLeadingTitle(this.shareText());
			await this.plugin.sendPageMail({
				to,
				cc,
				subject: this.subject.trim(),
				html: shareEmailHtml({ title: title || this.file.basename, markdown: body, intro: this.intro, source: this.source }),
			});
			new Notice(`Power Assistant: sent to ${to.concat(cc).join(", ")}.`, 8000);
			this.close();
		} catch (e) {
			new Notice("Power Assistant: " + (e instanceof Error ? e.message : String(e)), 12000);
			this.busy = false;
			this.paintSend();
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** The writer: pick a draft type and tone, generate from a meeting's context
 *  (grounded, never invented), then copy or insert the result. */
class DraftModal extends Modal {
	private kind: DraftKind = "followup";
	private tone = "Neutral";
	private instruction = "";
	private busy = false;
	private outEl!: HTMLElement;
	private draft = "";

	constructor(
		app: App,
		private plugin: PowerAssistantPlugin,
		private context: string,
		private target: TFile | null
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Draft from context");
		const c = this.contentEl;
		wireInternalLinks(this.app, c);

		c.createEl("label", { cls: "pcap-field-label", text: "Draft" });
		const kindSel = c.createEl("select", { cls: "pcap-field-input dropdown" });
		for (const k of DRAFT_KINDS) kindSel.createEl("option", { value: k.id, text: k.label });
		kindSel.value = this.kind;
		kindSel.addEventListener("change", () => {
			this.kind = kindSel.value as DraftKind;
			instr.placeholder = this.kind === "custom" ? "What should it say?" : "Anything to add or emphasize (optional)…";
		});

		c.createEl("label", { cls: "pcap-field-label", text: "Tone" });
		const toneSel = c.createEl("select", { cls: "pcap-field-input dropdown" });
		for (const t of ["Neutral", "Warm", "Formal", "Casual", "Concise"]) toneSel.createEl("option", { value: t, text: t });
		toneSel.addEventListener("change", () => (this.tone = toneSel.value));

		const instrRow = c.createDiv();
		instrRow.createEl("label", { cls: "pcap-field-label", text: "Instructions" });
		const instr = instrRow.createEl("textarea", { cls: "pcap-field-input", attr: { rows: "2", placeholder: "Anything to add or emphasize (optional)…" } });
		instr.addEventListener("input", () => (this.instruction = instr.value));

		const btns = c.createDiv({ cls: "ptc-modal-btns ptc-left" });
		const gen = btns.createEl("button", { cls: "mod-cta", text: "Generate" });
		gen.addEventListener("click", () => void this.generate());

		this.outEl = c.createDiv({ cls: "pcap-draft-out" });

		const foot = c.createDiv({ cls: "ptc-modal-btns" });
		foot.createEl("button", { text: "Copy" }).addEventListener("click", () => {
			if (!this.draft) return;
			void navigator.clipboard.writeText(this.draft);
			new Notice("Power Assistant: draft copied.");
		});
		if (this.target)
			foot.createEl("button", { text: "Insert into note" }).addEventListener("click", () => void this.insert());
		foot.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
	}

	private async generate() {
		if (this.busy) return;
		if (!this.plugin.llmReady()) {
			new Notice("Power Assistant: " + this.plugin.llmMissingMsg());
			return;
		}
		if (this.kind === "custom" && !this.instruction.trim()) {
			new Notice("Power Assistant: describe what to write for a custom draft.");
			return;
		}
		this.busy = true;
		this.outEl.setText("Writing…");
		try {
			const desc = DRAFT_KINDS.find((k) => k.id === this.kind)?.desc ?? "";
			const { system, user } = buildDraftPrompt(desc, this.context, { tone: this.tone, instruction: this.instruction, yourName: this.plugin.settings.yourName });
			this.draft = await this.plugin.claudeStream({ system, messages: [{ role: "user", content: user }] }, 1500, (snap) => {
				this.outEl.setText(snap);
			});
			this.outEl.empty();
			await MarkdownRenderer.render(this.app, this.draft, this.outEl, "", this.plugin);
		} catch (e) {
			this.outEl.setText("Draft failed: " + humanizeError(e instanceof Error ? e.message : String(e)));
		} finally {
			this.busy = false;
		}
	}

	private async insert() {
		if (!this.draft || !this.target) return;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path === this.target.path) {
			view.editor.replaceSelection(`\n${this.draft}\n`);
		} else {
			await this.app.vault.append(this.target, `\n\n${this.draft}\n`);
		}
		new Notice("Power Assistant: draft inserted.");
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** A one-field text prompt (emoji, a comment, …). */
class TextPromptModal extends Modal {
	private value: string;
	constructor(app: App, private titleText: string, private desc: string, initial: string, private onSubmit: (v: string) => void) {
		super(app);
		this.value = initial;
	}
	onOpen() {
		this.titleEl.setText(this.titleText);
		const c = this.contentEl;
		if (this.desc) c.createEl("p", { cls: "ptc-modal-desc", text: this.desc });
		let input: HTMLInputElement | null = null;
		new Setting(c).addText((t) => {
			input = t.inputEl;
			t.setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.style.width = "100%";
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.submit();
				}
			});
		});
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Save", cls: "mod-cta" }).addEventListener("click", () => this.submit());
		window.setTimeout(() => input?.focus(), 20);
	}
	private submit() {
		this.close();
		this.onSubmit(this.value);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Pick a color for a speaker: palette swatches, a custom picker, or reset to
 *  the automatic color. The chosen color is remembered per speaker. */
class SpeakerColorModal extends Modal {
	constructor(app: App, private name: string, private current: string, private onPick: (color: string | null) => void) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(`Color for ${this.name}`);
		const c = this.contentEl;
		c.createEl("p", { cls: "ptc-modal-desc", text: "Pick a color for this speaker. It is remembered and used in every meeting they are in." });
		const grid = c.createDiv({ cls: "pa-color-swatches" });
		for (const col of SPEAKER_PALETTE) {
			const sw = grid.createEl("button", { cls: "pa-color-swatch", attr: { "aria-label": col } });
			sw.style.background = col;
			if (col.toLowerCase() === (this.current || "").toLowerCase()) sw.addClass("is-current");
			sw.addEventListener("click", () => {
				this.onPick(col);
				this.close();
			});
		}
		const custom = new Setting(c).setName("Custom color").setDesc("Click the swatch to pick any color.");
		const input = custom.controlEl.createEl("input", { attr: { type: "color", "aria-label": "Pick a custom color" } });
		input.value = /^#[0-9a-f]{6}$/i.test(this.current) ? this.current : "#7c6cf5";
		// apply the moment a color is chosen, so it works whether or not the
		// button is clicked afterward (the button just confirms and closes)
		input.addEventListener("change", () => this.onPick(input.value));
		custom.addButton((b) =>
			b.setButtonText("Use custom").onClick(() => {
				this.onPick(input.value);
				this.close();
			})
		);
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Reset to automatic" }).addEventListener("click", () => {
			this.onPick(null);
			this.close();
		});
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** A curated set of avatar-friendly emoji for the speaker picker, each with a
 *  few search keywords. Not exhaustive — the picker also takes a pasted emoji. */
const EMOJI_CHOICES: { e: string; k: string }[] = [
	{ e: "😀", k: "smile happy grin face" },
	{ e: "😄", k: "smile happy joy face" },
	{ e: "😁", k: "grin beaming happy" },
	{ e: "😂", k: "laugh tears joy funny" },
	{ e: "🙂", k: "smile slight face" },
	{ e: "😉", k: "wink face" },
	{ e: "😊", k: "smile blush happy" },
	{ e: "😇", k: "angel halo innocent" },
	{ e: "🥰", k: "love hearts adore" },
	{ e: "😍", k: "love heart eyes" },
	{ e: "😎", k: "cool sunglasses" },
	{ e: "🤩", k: "star struck excited wow" },
	{ e: "🤔", k: "think thinking hmm" },
	{ e: "🤓", k: "nerd geek glasses smart" },
	{ e: "🧐", k: "monocle inspect curious" },
	{ e: "😴", k: "sleep tired zzz" },
	{ e: "🥳", k: "party celebrate hat" },
	{ e: "😅", k: "sweat nervous laugh" },
	{ e: "🙃", k: "upside down silly" },
	{ e: "😜", k: "wink tongue silly" },
	{ e: "🤠", k: "cowboy hat" },
	{ e: "🥸", k: "disguise glasses incognito" },
	{ e: "👍", k: "thumbs up like yes good" },
	{ e: "👋", k: "wave hello hi hand" },
	{ e: "🙌", k: "hands raise celebrate" },
	{ e: "👏", k: "clap applause hands" },
	{ e: "🤝", k: "handshake deal agree" },
	{ e: "✌️", k: "peace victory hand" },
	{ e: "💪", k: "muscle strong flex" },
	{ e: "🫡", k: "salute respect" },
	{ e: "🧑", k: "person adult" },
	{ e: "👩", k: "woman person" },
	{ e: "👨", k: "man person" },
	{ e: "🧔", k: "beard man person" },
	{ e: "👱", k: "blond person" },
	{ e: "👵", k: "old woman grandma" },
	{ e: "👴", k: "old man grandpa" },
	{ e: "🧑‍💻", k: "developer coder tech laptop" },
	{ e: "👩‍💻", k: "developer coder woman tech" },
	{ e: "👨‍💻", k: "developer coder man tech" },
	{ e: "🕵️", k: "detective spy investigate" },
	{ e: "👮", k: "police officer cop" },
	{ e: "👷", k: "worker builder construction" },
	{ e: "🦸", k: "hero super" },
	{ e: "🧙", k: "wizard mage magic" },
	{ e: "🧑‍🏫", k: "teacher instructor" },
	{ e: "🧑‍🔬", k: "scientist research" },
	{ e: "🧑‍🚀", k: "astronaut space" },
	{ e: "🐶", k: "dog puppy animal" },
	{ e: "🐱", k: "cat kitten animal" },
	{ e: "🦊", k: "fox animal" },
	{ e: "🐻", k: "bear animal" },
	{ e: "🐼", k: "panda animal" },
	{ e: "🐨", k: "koala animal" },
	{ e: "🐯", k: "tiger animal" },
	{ e: "🦁", k: "lion animal" },
	{ e: "🐮", k: "cow animal" },
	{ e: "🐷", k: "pig animal" },
	{ e: "🐸", k: "frog animal" },
	{ e: "🐵", k: "monkey animal" },
	{ e: "🐧", k: "penguin animal" },
	{ e: "🦉", k: "owl bird animal" },
	{ e: "🦄", k: "unicorn animal" },
	{ e: "🐝", k: "bee animal" },
	{ e: "🦋", k: "butterfly animal" },
	{ e: "🐢", k: "turtle animal" },
	{ e: "🐬", k: "dolphin animal" },
	{ e: "🐳", k: "whale animal" },
	{ e: "🦈", k: "shark animal" },
	{ e: "🐙", k: "octopus animal" },
	{ e: "☕", k: "coffee drink" },
	{ e: "🍕", k: "pizza food" },
	{ e: "🍔", k: "burger food" },
	{ e: "🍎", k: "apple fruit food" },
	{ e: "🍺", k: "beer drink" },
	{ e: "🍷", k: "wine drink" },
	{ e: "🍰", k: "cake dessert food" },
	{ e: "⭐", k: "star favorite" },
	{ e: "🌟", k: "star sparkle glow" },
	{ e: "🔥", k: "fire hot flame" },
	{ e: "⚡", k: "lightning bolt fast" },
	{ e: "💡", k: "idea bulb light" },
	{ e: "🎯", k: "target goal bullseye" },
	{ e: "🚀", k: "rocket launch fast" },
	{ e: "📌", k: "pin marker" },
	{ e: "📝", k: "note memo write" },
	{ e: "📊", k: "chart graph data" },
	{ e: "💻", k: "laptop computer tech" },
	{ e: "🎧", k: "headphones audio music" },
	{ e: "🎤", k: "mic microphone sing" },
	{ e: "🔔", k: "bell alert notify" },
	{ e: "🏆", k: "trophy win award" },
	{ e: "🎉", k: "party celebrate confetti" },
	{ e: "💎", k: "gem diamond jewel" },
	{ e: "🔑", k: "key access unlock" },
	{ e: "🛠️", k: "tools build fix" },
	{ e: "⚙️", k: "gear settings cog" },
	{ e: "🌈", k: "rainbow color" },
	{ e: "🌙", k: "moon night" },
	{ e: "☀️", k: "sun sunny bright" },
	{ e: "🌻", k: "sunflower flower" },
	{ e: "🍀", k: "clover luck lucky" },
	{ e: "❤️", k: "heart love red" },
	{ e: "🧡", k: "heart orange" },
	{ e: "💛", k: "heart yellow" },
	{ e: "💚", k: "heart green" },
	{ e: "💙", k: "heart blue" },
	{ e: "💜", k: "heart purple" },
	{ e: "💯", k: "hundred perfect score" },
	{ e: "✅", k: "check done yes complete" },
];

/** Pick an emoji for a speaker's avatar: a searchable grid of common emoji, a
 *  paste-your-own field, or remove. The choice is remembered per speaker. */
class SpeakerEmojiModal extends Modal {
	constructor(app: App, private name: string, private current: string, private onPick: (emoji: string | null) => void) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(`Emoji for ${this.name}`);
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Pick an emoji for this speaker's avatar, or paste your own below. It is remembered and used in every meeting they are in.",
		});
		const search = c.createEl("input", { cls: "pa-emoji-search", attr: { type: "text", placeholder: "Search emoji…" } });
		const grid = c.createDiv({ cls: "pa-emoji-grid" });
		const render = (q: string) => {
			grid.empty();
			const query = q.trim().toLowerCase();
			let shown = 0;
			for (const { e, k } of EMOJI_CHOICES) {
				if (query && !k.includes(query) && e !== q.trim()) continue;
				shown++;
				const b = grid.createEl("button", { cls: "pa-emoji", text: e, attr: { "aria-label": k.split(" ")[0] || e } });
				if (e === this.current) b.addClass("is-current");
				b.addEventListener("click", () => {
					this.onPick(e);
					this.close();
				});
			}
			if (!shown) grid.createEl("div", { cls: "pa-emoji-empty", text: "No matches. Paste your own below." });
		};
		render("");
		search.addEventListener("input", () => render(search.value));

		const custom = new Setting(c).setName("Paste your own");
		const input = custom.controlEl.createEl("input", { attr: { type: "text", placeholder: "😀" } });
		input.value = this.current || "";
		input.style.width = "6rem";
		const useCustom = () => {
			const v = input.value.trim();
			this.onPick(v || null);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				useCustom();
			}
		});
		custom.addButton((b) => b.setButtonText("Use").onClick(useCustom));

		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Remove emoji" }).addEventListener("click", () => {
			this.onPick(null);
			this.close();
		});
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		window.setTimeout(() => search.focus(), 20);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Fix a misheard name/word: replace it across this note, and optionally
 *  remember it so future transcripts get the same fix. */
class CorrectionModal extends Modal {
	private from: string;
	private to = "";
	private remember = true;
	constructor(app: App, prefill: string, private onApply: (from: string, to: string, remember: boolean) => void) {
		super(app);
		this.from = prefill;
	}
	onOpen() {
		this.titleEl.setText("Correct a name or term");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Replace a misheard word or name everywhere in this note. A remembered correction is applied to every new transcript, so captures get more accurate over time.",
		});
		new Setting(c).setName("Find").setClass("pcap-correct-row").addText((t) => {
			t.setPlaceholder("the misheard word or name").setValue(this.from).onChange((v) => (this.from = v));
		});
		let toInput: HTMLInputElement | null = null;
		new Setting(c).setName("Replace with").setClass("pcap-correct-row").addText((t) => {
			toInput = t.inputEl;
			t.setPlaceholder("the correct spelling").onChange((v) => (this.to = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.submit();
				}
			});
		});
		new Setting(c)
			.setName("Remember for future meetings")
			.setDesc("Apply this correction automatically to every new transcript.")
			.addToggle((t) => t.setValue(this.remember).onChange((v) => (this.remember = v)));
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Replace", cls: "mod-cta" }).addEventListener("click", () => this.submit());
		window.setTimeout(() => toInput?.focus(), 20);
	}
	private submit() {
		this.close();
		this.onApply(this.from, this.to, this.remember);
	}
	onClose() {
		this.contentEl.empty();
	}
}

class YoutubeModal extends Modal {
	private url = "";

	constructor(app: App, private plugin: PowerAssistantPlugin) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Capture a YouTube video");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Fetches the video's caption track and turns it into a structured note using your extraction settings.",
		});
		this.modalEl.addClass("pcap-yt-modal");
		let input: HTMLInputElement | null = null;
		new Setting(c)
			.setName("Video URL")
			.setClass("pcap-yt-url-row")
			.addText((t) => {
				input = t.inputEl;
				t.setPlaceholder("https://www.youtube.com/watch?v=…").onChange((v) => (this.url = v.trim()));
				// Enter in the URL field acts like clicking Capture
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.submit();
					}
				});
			});
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Capture", cls: "mod-cta" }).addEventListener("click", () => this.submit());
		window.setTimeout(() => input?.focus(), 20);
	}

	private submit() {
		// default the scheme so a copied "youtube.com/…" with no https:// still works
		const url = ensureUrlScheme(this.url);
		if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url)) {
			new Notice("That doesn't look like a YouTube URL.");
			return;
		}
		this.close();
		void this.plugin.captureYoutube(url);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class XModal extends Modal {
	private url = "";

	constructor(app: App, private plugin: PowerAssistantPlugin) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText("Capture an X post");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Turns a post into a structured note using your extraction settings, along with the post it quotes or replies to. A post that is only words needs nothing installed. One carrying video has its audio downloaded with yt-dlp and transcribed, and since an X post has no captions, that uses your transcription provider. The replies underneath are not captured (X shows those only to a logged-in client), so the note keeps the reply count instead.",
		});
		this.modalEl.addClass("pcap-yt-modal");
		let input: HTMLInputElement | null = null;
		new Setting(c)
			.setName("Post URL")
			.setClass("pcap-yt-url-row")
			.addText((t) => {
				input = t.inputEl;
				t.setPlaceholder("https://x.com/user/status/…").onChange((v) => (this.url = v.trim()));
				// Enter in the URL field acts like clicking Capture
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.submit();
					}
				});
			});
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Capture", cls: "mod-cta" }).addEventListener("click", () => this.submit());
		window.setTimeout(() => input?.focus(), 20);
	}

	private submit() {
		// default the scheme so a copied "x.com/…" with no https:// still works
		const url = ensureUrlScheme(this.url);
		if (!isXUrl(url)) {
			new Notice("That doesn't look like a link to an X post.");
			return;
		}
		this.close();
		void this.plugin.captureMedia(url);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** The one front door: paste any link and let the router decide. The Reads-as
 *  choice exists because the router goes on the host alone, which is right
 *  nearly always and wrong in two knowable ways: a blog that is really a video
 *  page, and a video site the list has never heard of. */
class LinkModal extends Modal {
	private url = "";
	private mode: CaptureRoute | "auto";

	constructor(app: App, private plugin: PowerAssistantPlugin, mode: CaptureRoute | "auto" = "auto") {
		super(app);
		this.mode = mode;
	}

	onOpen() {
		this.titleEl.setText("Capture from a link");
		const c = this.contentEl;
		c.createEl("p", {
			cls: "ptc-modal-desc",
			text: "Paste a link to a video, a social post, or an article. A YouTube video uses its free captions, a video or social post is downloaded and transcribed, and anything else is read as a web page.",
		});
		this.modalEl.addClass("pcap-yt-modal");
		let input: HTMLInputElement | null = null;
		const hint = c.createDiv({ cls: "ptc-modal-desc pcap-link-hint" });
		const paintHint = () => {
			const url = ensureUrlScheme(this.url);
			if (!this.url.trim()) return hint.setText("");
			if (this.mode !== "auto") return hint.setText("");
			const route = routeFor(url);
			const site = mediaSiteFor(url)?.label;
			hint.setText(
				route === "youtube"
					? "Reads as: YouTube, using its free captions."
					: route === "media"
						? `Reads as: ${site ?? "a video"}, downloaded and transcribed (costs credits).`
						: "Reads as: a web page, no transcription needed."
			);
		};
		new Setting(c)
			.setName("Link")
			.setClass("pcap-yt-url-row")
			.addText((t) => {
				input = t.inputEl;
				t.setPlaceholder("https://…").onChange((v) => ((this.url = v.trim()), paintHint()));
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.submit();
					}
				});
			});
		new Setting(c)
			.setName("Read it as")
			.setDesc("Auto goes by the site. Override it for a blog that is really a video page, or a video site Auto does not recognize.")
			.addDropdown((d) => {
				d.addOptions({ auto: "Auto", media: "Video or post", web: "Web page" });
				d.setValue(this.mode).onChange((v) => ((this.mode = v as CaptureRoute | "auto"), paintHint()));
				d.selectEl.addClass("dropdown");
			});
		const btns = c.createDiv({ cls: "ptc-modal-btns" });
		btns.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		btns.createEl("button", { text: "Capture", cls: "mod-cta" }).addEventListener("click", () => this.submit());
		window.setTimeout(() => input?.focus(), 20);
	}

	private submit() {
		const url = ensureUrlScheme(this.url);
		if (!/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(url)) {
			new Notice("That doesn't look like a link.");
			return;
		}
		this.close();
		void this.plugin.captureLink(url, this.mode);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class AssistantSettingTab extends PluginSettingTab {
	/** Which settings tab is showing; kept across re-renders. */
	private activeTab = "transcription";
	/** Current search filter; when set, matching settings show across all tabs. */
	private query = "";
	/** The one open help popover, if any, and the icon it hangs from. */
	private helpEl: HTMLElement | null = null;
	private helpAnchor: HTMLElement | null = null;
	private helpPinned = false;
	private helpCleanup: (() => void) | null = null;
	constructor(app: App, private plugin: PowerAssistantPlugin) {
		super(app, plugin);
	}

	/** Land the next render on the given tab; how a notice jumps to Connect. */
	showTab(id: string) {
		this.activeTab = id;
	}

	hide() {
		this.plugin.refreshSettingsTab = null;
		this.closeHelp();
	}

	private closeHelp() {
		this.helpCleanup?.();
		this.helpCleanup = null;
		this.helpEl?.remove();
		this.helpEl = null;
		this.helpAnchor = null;
		this.helpPinned = false;
	}

	/** Show the help popover for `icon`: a soft theme-colored card rather than
	 *  the native black tooltip. Opens on hover; a click pins it so it survives
	 *  the pointer leaving; Esc, a click elsewhere, or scrolling closes it.
	 *  Opening for a new icon replaces the old popover. */
	private openHelp(icon: HTMLElement, text: string, pin: boolean) {
		if (this.helpAnchor === icon && this.helpEl) {
			if (pin) this.helpPinned = true;
			return;
		}
		this.closeHelp();
		const el = document.body.createDiv({ cls: "ptc-help-pop", text });
		this.helpEl = el;
		this.helpAnchor = icon;
		this.helpPinned = pin;
		const r = icon.getBoundingClientRect();
		el.style.left = Math.max(8, Math.min(r.left - 12, window.innerWidth - el.offsetWidth - 8)) + "px";
		const below = r.bottom + 8;
		el.style.top = (below + el.offsetHeight > window.innerHeight - 8 ? r.top - el.offsetHeight - 8 : below) + "px";
		const onDocDown = (e: MouseEvent) => {
			if (e.target instanceof Node && (el.contains(e.target) || icon.contains(e.target))) return;
			this.closeHelp();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closeHelp();
		};
		const onScroll = () => this.closeHelp();
		document.addEventListener("pointerdown", onDocDown, true);
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("scroll", onScroll, true);
		this.helpCleanup = () => {
			document.removeEventListener("pointerdown", onDocDown, true);
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("scroll", onScroll, true);
		};
	}

	display() {
		const root = this.containerEl;
		root.empty();
		this.closeHelp(); // a re-render orphans any popover anchored to the old DOM
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();
		this.plugin.refreshSettingsTab = () => this.display();

		// grouped by what a person is trying to do, not by which feature grew
		// first: mail lives with mail, capture with capture, and the provider
		// keys stay together in one place you visit once
		const TABS: { id: string; label: string }[] = [
			{ id: "setup", label: "Setup" },
			{ id: "audio", label: "Audio" },
			{ id: "meetings", label: "Meetings" },
			{ id: "capture", label: "Capture" },
			{ id: "mail", label: "Mail" },
			{ id: "spending", label: "Spending" },
			{ id: "search", label: "Search" },
			{ id: "notes", label: "Notes" },
			{ id: "privacy", label: "Privacy" },
		];
		if (!TABS.some((t) => t.id === this.activeTab)) this.activeTab = TABS[0].id;

		const searchWrap = root.createDiv({ cls: "ptc-settings-search" });
		const searchInput = searchWrap.createEl("input", { cls: "ptc-settings-search-input" });
		searchInput.type = "search";
		searchInput.placeholder = "Search settings...";
		searchInput.value = this.query;

		const tabBar = root.createDiv({ cls: "ptc-settings-tabs" });
		const body = root.createDiv({ cls: "ptc-settings-body" });

		// each heading opens a section div tagged with its tab; the settings that
		// follow render into it because c points at the current section
		let c: HTMLElement = body;
		// open by default: a settings page exists to be changed, and a fold that
		// hides everything until clicked costs more than the scrolling it saves.
		// Folding stays available for a section someone is done with.
		const isExpanded = (name: string, tab: string) => !this.plugin.settings.foldedSections.includes(`${tab}/${name}`);

		const section = (name: string, tab: string) => {
			c = body.createDiv({ cls: "ptc-settings-section" });
			c.dataset.tab = tab;
			c.dataset.name = name.toLowerCase();
			const head = new Setting(c).setName(name).setHeading();
			head.settingEl.addClass("ptc-section-head");
			head.settingEl.addEventListener("click", () => {
				const key = `${tab}/${name.toLowerCase()}`;
				const folded = this.plugin.settings.foldedSections;
				const at = folded.indexOf(key);
				if (at >= 0) folded.splice(at, 1);
				else folded.push(key);
				void this.plugin.saveSettings();
				applyView();
			});
			return head;
		};

		// A section's opening paragraph, built as a real Setting rather than a bare
		// <p>: the theme cards every .setting-item, so loose text floats outside
		// the boxes and breaks the column the rest of the rows line up on.
		const intro = (text: string) => new Setting(c).setDesc(text).setClass("ptc-section-intro");

		// A key-set / no-key pill on a provider heading, so the provider list
		// answers "which of these am I actually set up for" at a glance. Repainted
		// in place rather than via display(), which would steal focus mid-key.
		const pill = (head: Setting, ready: () => boolean) => {
			const el = head.nameEl.createSpan({ cls: "ptc-prov-pill" });
			const paint = () => {
				const ok = ready();
				el.setText(ok ? "Key set" : "No key");
				el.toggleClass("is-set", ok);
				el.toggleClass("is-unset", !ok);
			};
			paint();
			return paint;
		};

		// A per-capture provider choice. Each option says whether that provider
		// actually has a key, so the pick is informed by what is set up rather
		// than by memory, and "Use the default" keeps one lever for everything
		// that does not need its own answer. The keys live on another tab and
		// switching tabs does not re-render, so every pick can be repainted when
		// a key or the default changes; otherwise "(no key)" would go stale.
		const providerPicks: (() => void)[] = [];
		const refreshPicks = () => providerPicks.forEach((f) => f());
		const providerPick = (name: string, desc: string, get: () => ProviderChoice, set: (v: ProviderChoice) => void, helpText: string) => {
			const label = (p: TranscriptionProvider, base: string) => `${base}${this.plugin.providerReady(p) ? "" : p === "whisperx" ? " (no server)" : " (no key)"}`;
			new Setting(c)
				.setName(name)
				.setDesc(desc)
				.then((st) => help(st, helpText))
				.addDropdown((d) => {
					const paint = () => {
						d.selectEl.empty();
						d.addOptions({
							default: `Use the default (${s.transcriptionProvider})`,
							whisper: label("whisper", "Whisper"),
							assemblyai: label("assemblyai", "AssemblyAI (speaker labels)"),
							deepgram: label("deepgram", "Deepgram (speaker labels)"),
							whisperx: label("whisperx", "WhisperX (speaker labels, local)"),
						});
						d.setValue(get());
					};
					paint();
					providerPicks.push(paint);
					d.onChange((v) => (set(v as ProviderChoice), save()));
				});
		};

		// a small help icon after the setting name carrying the deeper "what does
		// this actually do" explanation; hover shows it, a click pins it open. No
		// aria-label on the icon or Obsidian's native black tooltip doubles up.
		const help = (st: Setting, text: string) => {
			const ic = st.nameEl.createSpan({ cls: "ptc-setting-help" });
			setIcon(ic, "help-circle");
			ic.addEventListener("mouseenter", () => this.openHelp(ic, text, false));
			ic.addEventListener("mouseleave", () => {
				if (!this.helpPinned && this.helpAnchor === ic) this.closeHelp();
			});
			ic.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				if (this.helpPinned && this.helpAnchor === ic) this.closeHelp();
				else this.openHelp(ic, text, true);
			});
		};

		// deeper explanation for each extraction section, shared by the meeting
		// and YouTube section checklists
		const SECTION_HELP: Record<string, string> = {
			summary: "A short prose recap at the top of the note, so you get the gist without reading the whole transcript. It draws only on what was actually said.",
			takeaways: "The main arguments and conclusions as bullets, focused on the ideas rather than raw numbers (those go to Facts & figures, so the two do not repeat). Best for talks and videos.",
			facts: "Concrete facts, statistics, and figures quoted as they were stated. It never calculates or estimates a number that was not actually said, so a percentage or total appears only if the source gave it.",
			resources: "External tools, papers, posts, people, products, and links that were referenced, each with a few words on what it is. On-screen visuals do not count, only things actually mentioned.",
			quotes: "A few memorable or important lines reproduced word-for-word in quotation marks, ready to pull out or cite.",
			actions: "The to-dos: who does what by when. Whether they render as a checklist or a table is set by 'Action items as tasks'. Owners and dates are filled only when the source states them.",
			decisions: "The confirmed choices and the reasoning behind them, so you can see not just what was decided but why. Suited to meetings more than videos.",
			risks: "Issues, dependencies, and open risks raised in the discussion, gathered in one place so nothing important slips.",
			questions: "Open questions and follow-ups that were left unresolved, so they can be chased later. The morning briefing can also surface recent ones.",
			keywords: "A single comma-separated line of the main topics, handy as tags or for search. It stays to one line rather than a long list.",
		};

		section("Transcription", "audio");
		new Setting(c)
			.setName("Default provider")
			.setDesc("Used by anything that has not been given its own provider. Whisper is the cheapest but has no speaker labels. AssemblyAI and Deepgram both add them. Check each provider's own site for current rates.")
			.then((s) =>
				help(
					s,
					"Whisper returns one unlabeled block of text, so it cannot tell who said what. AssemblyAI and Deepgram diarize, tagging each turn Speaker A, Speaker B, and so on, which is what powers naming the speakers and the per-person talk-time shares. Meetings, Capture, and YouTube can each pick their own provider on their own tab; whatever they leave on Use the default lands here. Keys for every provider live on the API keys tab."
				)
			)
			.addDropdown((d) =>
				d
					.addOptions({
						whisper: "Whisper (OpenAI-compatible)",
						assemblyai: "AssemblyAI (speaker labels)",
						deepgram: "Deepgram (speaker labels)",
						whisperx: "WhisperX (speaker labels, your own server)",
					})
					.setValue(s.transcriptionProvider)
					.onChange((v) => ((s.transcriptionProvider = v as TranscriptionProvider), save(), refreshPicks()))
			);

		// Where the AI calls go, ahead of the per-provider key groups: the
		// provider choice decides which of those groups is actually in play.
		const llmHead = section("AI model", "setup");
		const llmPillEl = llmHead.nameEl.createSpan({ cls: "ptc-prov-pill" });
		const llmPill = () => {
			const ready = llmConfigured(s);
			llmPillEl.setText(ready ? "Ready" : "Not set");
			llmPillEl.toggleClass("is-set", ready);
			llmPillEl.toggleClass("is-unset", !ready);
		};
		llmPill();
		intro(
			"Which server writes the notes and answers questions: Anthropic's cloud (the default), or a custom endpoint speaking the Anthropic Messages API, such as Ollama, LM Studio, or llama.cpp on your own machine or LAN. Transcription and embeddings have their own endpoints and are unaffected."
		);
		new Setting(c)
			.setName("Provider")
			.setDesc("Custom endpoint keeps every AI feature on a server you run. The Anthropic key below stays put for switching back.")
			.then((st) =>
				help(
					st,
					"Every AI call (summaries, chat, the writer, slide reading) goes to one place. Anthropic (cloud) uses the key and model below. Custom endpoint sends the identical calls to a server you run instead: Ollama 0.14 and later, LM Studio, and llama.cpp all speak the Anthropic Messages API. Reading slide images needs a vision-capable model on that server; without one, deck capture still saves the slide text. The usage meter keeps counting tokens either way and prices custom-endpoint calls at $0.00."
				)
			)
			.addDropdown((d) =>
				d
					.addOptions({ anthropic: "Anthropic (cloud)", custom: "Custom endpoint (local or LAN)" })
					.setValue(s.llmProvider)
					.onChange((v) => {
						s.llmProvider = v as LlmProvider;
						save();
						llmPill();
						paintCustom();
					})
			);
		new Setting(c)
			.setName("Detect local AI on this machine")
			.setDesc("Probes this computer for Ollama (port 11434) and the WhisperX server (port 8571) and fills in their addresses for the whole fleet.")
			.then((st) =>
				help(
					st,
					"Detection fills endpoints with this machine's network address rather than localhost, so the setting is useful on every synced device at once. It never switches the provider by itself: the dropdown above stays the explicit choice of where the AI runs. Run it on the machine where Ollama or the WhisperX server actually live."
				)
			)
			.addButton((b) => b.setButtonText("Detect").onClick(() => void this.plugin.detectLocalAi()));
		// the three custom fields only matter for the custom provider, so they
		// fold away rather than sit there implying they are always read
		const customBox = c.createDiv();
		const paintCustom = () => (customBox.style.display = s.llmProvider === "custom" ? "" : "none");
		new Setting(customBox)
			.setName("Endpoint")
			.setDesc("The server's base URL. Ollama answers on http://localhost:11434; use the machine's LAN address when the model runs on another computer.")
			.then((st) =>
				help(
					st,
					"The base URL every AI call is sent to. Nothing but these calls goes there, and nothing goes to Anthropic while this provider is active. For a server on another machine, use that machine's address and make sure it listens beyond localhost (for Ollama, set OLLAMA_HOST=0.0.0.0)."
				)
			)
			.addText((t) => {
				t.inputEl.placeholder = "http://localhost:11434";
				t.setValue(s.llmEndpoint).onChange((v) => ((s.llmEndpoint = v.trim()), save(), llmPill()));
			});
		new Setting(customBox)
			.setName("Model")
			.setDesc("The model name the server should run, exactly as the server lists it (for example qwen3:30b-a3b on Ollama).")
			.addText((t) => {
				t.inputEl.placeholder = "qwen3:30b-a3b";
				t.setValue(s.llmModel).onChange((v) => ((s.llmModel = v.trim()), save(), llmPill()));
			});
		new Setting(customBox)
			.setName("API key")
			.setDesc("Only if your server checks one (local servers usually do not).")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.llmKey).onChange((v) => ((s.llmKey = v.trim()), save()));
			});
		paintCustom();

		// Every key in the plugin lives on this one tab, each provider in its own
		// group with a pill: which providers you are set up for is a separate
		// question from which one does which job, and the answer belongs in one
		// place rather than scattered across the tabs that happen to use them.
		const anthropicHead = section("Anthropic", "setup");
		const anthropicPill = pill(anthropicHead, () => !!s.anthropicKey.trim());
		intro("Writes the notes when the AI model provider is Anthropic (cloud): summaries, action items, and every other extracted section, plus Ask your vault and the assistant chat. Without it you still get transcripts, just no AI-written notes.");
		new Setting(c)
			.setName("API key")
			.setDesc("Used to turn transcripts into structured notes. Leave empty to save transcripts only.")
			.then((st) =>
				help(
					st,
					"This is the key for the summary, action items, and every other extracted section, plus Ask your vault and the assistant chat. Without it you still get the raw transcript, just no AI-written notes. Stored locally and sent only to Anthropic."
				)
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.anthropicKey).onChange((v) => ((s.anthropicKey = v.trim()), save(), anthropicPill(), llmPill()));
			});
		new Setting(c)
			.setName("Model")
			.setDesc("claude-haiku-4-5 is the fast, inexpensive default; use claude-opus-4-8 for the highest quality. The AI usage meter shows what this vault is actually spending.")
			.then((st) =>
				help(
					st,
					"Which Claude model writes the notes. Haiku is fast and cheap and handles most meetings well; Opus is slower and pricier but sharper on long or messy transcripts. The AI usage meter totals what each model has actually cost you."
				)
			)
			.addText((t) => t.setValue(s.anthropicModel).onChange((v) => ((s.anthropicModel = v.trim()), save())));

		const whisperHead = section("Whisper", "setup");
		const whisperPill = pill(whisperHead, () => !!s.transcriptionKey.trim() || /localhost|127\.0\.0\.1|192\.168\./.test(s.transcriptionEndpoint));
		intro("Cheapest, and the only one that can run entirely on this machine, but it returns one unlabeled block of text with no speakers.");
		new Setting(c)
			.setName("Endpoint")
			.setDesc("Any OpenAI-compatible base URL: Groq (default), OpenAI (https://api.openai.com/v1), or a self-hosted Whisper server.")
			.then((st) =>
				help(
					st,
					"The base URL your audio is sent to for transcription; only the /audio/transcriptions path under it is used. Groq hosts Whisper cheaply and is the default. Point it at a server on your own machine to keep audio fully local, in which case no key is needed."
				)
			)
			.addText((t) => t.setValue(s.transcriptionEndpoint).onChange((v) => ((s.transcriptionEndpoint = v.trim()), save(), whisperPill(), refreshPicks())));
		new Setting(c)
			.setName("API key")
			.then((st) => help(st, "The bearer token for the endpoint above. It is stored in this vault's local data file and sent only to that endpoint. Groq and OpenAI both issue keys from their dashboards; a server on your own machine may need none."))
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.transcriptionKey).onChange((v) => ((s.transcriptionKey = v.trim()), save(), whisperPill(), refreshPicks()));
			});
		new Setting(c)
			.setName("Model")
			.then((st) => help(st, "The transcription model name the endpoint expects, for example whisper-large-v3 on Groq. Use whatever Whisper model your provider recommends; a name it does not recognize makes it reject the request."))
			.addText((t) => t.setValue(s.transcriptionModel).onChange((v) => ((s.transcriptionModel = v.trim()), save())));

		const whisperxHead = section("WhisperX", "setup");
		const whisperxPillEl = whisperxHead.nameEl.createSpan({ cls: "ptc-prov-pill" });
		const whisperxPill = () => {
			const ready = !!s.whisperxEndpoint.trim();
			whisperxPillEl.setText(ready ? "Ready" : "Not set");
			whisperxPillEl.toggleClass("is-set", ready);
			whisperxPillEl.toggleClass("is-unset", !ready);
		};
		whisperxPill();
		intro(
			"Speaker labels from your own machine: a self-hosted WhisperX server transcribes AND diarizes, so meetings get Speaker A/B naming with no cloud provider and no audio leaving your network. The server ships inside the plugin; installing it is one button and one command (a machine with an NVIDIA card is strongly recommended)."
		);
		new Setting(c)
			.setName("Install the server on this machine")
			.setDesc("Writes the server files out of the plugin and shows the one command that sets everything up (private Python environment, GPU-matched install, start at login).")
			.then((st) =>
				help(
					st,
					"The plugin never runs installers itself; you see the exact command and run it in your own terminal. The script is safe to rerun any time (to add the Hugging Face token later, or after an update). Run it on the machine that should do the transcribing; every other device just uses the address it prints."
				)
			)
			.addButton((b) => b.setButtonText("Show install steps").setCta().onClick(() => void this.plugin.openServerInstall()));
		new Setting(c)
			.setName("Server address")
			.setDesc("Where the WhisperX server listens, for example http://192.168.1.50:8571. No key; keep it on your own network.")
			.then((st) =>
				help(
					st,
					"The address of the machine running tools/whisperx-server. Audio is POSTed there and diarized segments come back; nothing else is sent. The address syncs to your other devices, so set it once and the whole fleet knows where the box lives. Check server responds only after the server has loaded its models, which takes a minute after it starts."
				)
			)
			.addText((t) => {
				t.inputEl.placeholder = "http://192.168.1.50:8571";
				t.setValue(s.whisperxEndpoint).onChange((v) => ((s.whisperxEndpoint = v.trim()), save(), whisperxPill(), refreshPicks()));
			})
			.addButton((b) => b.setButtonText("Check server").onClick(() => void this.plugin.verifyWhisperX()));

		const assemblyHead = section("AssemblyAI", "setup");
		const assemblyPill = pill(assemblyHead, () => !!s.assemblyaiKey.trim());
		new Setting(c)
			.setName("API key")
			.setDesc("Create a key at assemblyai.com; the same key handles upload, transcription, and speaker diarization. Recording gives Speaker A / Speaker B labels, then a dialog to name them.")
			.then((st) =>
				help(
					st,
					"One key does the whole job: it uploads the audio, transcribes it, and separates the speakers. Afterward you get a dialog to put real names to Speaker A / Speaker B, which then become attendee links in the note. Test key checks the key without spending credits."
				)
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.assemblyaiKey).onChange((v) => ((s.assemblyaiKey = v.trim()), save(), assemblyPill(), refreshPicks()));
			})
			.addButton((b) => b.setButtonText("Test key").onClick(() => void this.plugin.verifyAssemblyKey()));

		const ribbonHead = section("Ribbon icons", "setup");
		void ribbonHead;
		const ribbonRow = (name: string, desc: string, get: () => boolean, set: (v: boolean) => void) =>
			new Setting(c)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(get()).onChange((v) => {
						set(v);
						save();
						this.plugin.applyRibbonVisibility();
					})
				);
		ribbonRow("Start recording", "The microphone icon. Its command works either way.", () => s.ribbonRecord, (v) => (s.ribbonRecord = v));
		ribbonRow("New meeting note", "The calendar icon.", () => s.ribbonMeeting, (v) => (s.ribbonMeeting = v));
		ribbonRow("Morning briefing", "The sunrise icon.", () => s.ribbonBriefing, (v) => (s.ribbonBriefing = v));
		ribbonRow("Open the assistant", "The sparkles icon.", () => s.ribbonAssistant, (v) => (s.ribbonAssistant = v));

		const deepgramHead = section("Deepgram", "setup");
		const deepgramPill = pill(deepgramHead, () => !!s.deepgramKey.trim());
		new Setting(c)
			.setName("API key")
			.setDesc("Create a key at deepgram.com; new accounts start with free credit. Recording gives Speaker A / Speaker B labels, then a dialog to name them.")
			.then((st) =>
				help(
					st,
					"New accounts start with free credit, which usually makes this the cheapest way to try speaker labels. Like AssemblyAI it diarizes and then prompts you to name the speakers. Test key verifies it without spending credit. Deepgram publishes its current rates on its own site; they are deliberately not repeated here, since a number baked into a plugin goes stale without anyone noticing."
				)
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.deepgramKey).onChange((v) => ((s.deepgramKey = v.trim()), save(), deepgramPill(), refreshPicks()));
			})
			.addButton((b) => b.setButtonText("Test key").onClick(() => void this.plugin.verifyDeepgramKey()));
		new Setting(c)
			.setName("Model")
			.setDesc("nova-2 is a good default; nova-3 is the newest.")
			.then((st) => help(st, "Which Deepgram speech model transcribes your audio. nova-2 is accurate and inexpensive; nova-3 is the latest. Leaving it empty falls back to nova-2. Speaker separation always uses Deepgram's newest diarizer (v2), whichever model is chosen here."))
			.addText((t) => t.setValue(s.deepgramModel).onChange((v) => ((s.deepgramModel = v.trim() || "nova-2"), save())));

		section("Extraction", "audio");
		// the Anthropic key and model live on the API keys tab with every other key
		for (const e of EXTRACTIONS) {
			new Setting(c)
				.setName(e.label)
				.setDesc(e.hint)
				.then((st) => help(st, SECTION_HELP[e.key] ?? e.hint))
				.addToggle((t) => t.setValue(s.extractions[e.key]).onChange((v) => ((s.extractions[e.key] = v), save())));
		}
		new Setting(c)
			.setName("Include raw transcript")
			.setDesc("Append the full transcript to every note for traceability.")
			.then((s) =>
				help(
					s,
					"Keeps the verbatim transcript under a Transcript heading so you can always check the summary against what was actually said, and re-extract later. Off saves only the AI notes and drops the raw text. A failed extraction still writes the transcript regardless, so nothing is ever lost."
				)
			)
			.addToggle((t) => t.setValue(s.includeTranscript).onChange((v) => ((s.includeTranscript = v), save())));

		section("Meetings", "meetings");
		providerPick(
			"Transcription provider",
			"Which provider transcribes a recording that folds into a meeting note. Meetings usually want speaker labels, so AssemblyAI or Deepgram.",
			() => s.meetingProvider,
			(v) => (s.meetingProvider = v),
			"Only a recording started from a meeting note counts as a meeting here; a standalone recording from the ribbon is treated as a capture and uses the Capture tab's provider. Whisper cannot tell speakers apart, so choosing it here costs you the speaker labels, the naming dialog, and the per-person talk-time shares."
		);
		new Setting(c)
			.setName("Name the speakers")
			.setDesc("After a diarized transcription, guess who Speaker A/B are from the words themselves; the guesses become one-click suggestions when you name the speakers.")
			.then((s) =>
				help(
					s,
					"Only works after a diarized transcription (AssemblyAI, Deepgram, or WhisperX). Claude reads the words to guess who each speaker is. With naming set to the transcript, the guesses appear at the top of the label menu as one-click choices; with the dialog, they prefill the form. Off skips the guessing and leaves plain letters either way."
				)
			)
			.addToggle((t) => t.setValue(s.nameSpeakers).onChange((v) => ((s.nameSpeakers = v), save())));
		new Setting(c)
			.setName("Name speakers")
			.setDesc("In the transcript: the note opens with lettered voices, click a turn to hear it and click the letter to tag it (the Otter way). In a dialog: a form asks before the note is written.")
			.then((st) =>
				help(
					st,
					"Where the letters become people. In the transcript, the finished note opens immediately: click anywhere in a turn to play that voice, then click the letter and pick who it is (the AI guess, the note's attendees, and frequent attendees are one click; Move this turn fixes a single misattributed line). In a dialog, transcription pauses on a form that names every letter up front, with a play button per voice. The Rename speakers command opens that form any time either way."
				)
			)
			.addDropdown((d) =>
				d
					.addOption("transcript", "In the transcript")
					.addOption("dialog", "In a dialog first")
					.setValue(s.speakerNaming)
					.onChange((v) => ((s.speakerNaming = v === "dialog" ? "dialog" : "transcript"), save()))
			);
		const voiceHead = section("Voice identity", "meetings");
		const voicePillEl = voiceHead.nameEl.createSpan({ cls: "ptc-prov-pill" });
		const voicePill = () => {
			voicePillEl.setText(s.voiceIdentity ? "On" : "Off");
			voicePillEl.toggleClass("is-set", s.voiceIdentity);
			voicePillEl.toggleClass("is-unset", !s.voiceIdentity);
		};
		voicePill();
		new Setting(c)
			.setName("Recognize voices across meetings")
			.setDesc("Name a speaker once and the voice is remembered; the next recording arrives with that letter already suggesting the name, and a merged speaker is split apart by voice.")
			.then((st) =>
				help(
					st,
					"A voiceprint is a fingerprint of a voice (a biometric), so this stays off until you turn it on. Prints are computed by your own WhisperX server, stored only in the vault file named below, synced only where your vault syncs, and never sent to any cloud service. Recognition is a suggestion, never an assertion: a matched voice appears at the top of the letter's menu as a one-click choice, exactly like the text guesses. It also audits every diarized cluster turn by turn, so a Speaker 2 that is secretly two people is split before the note is written. Needs WhisperX as the meeting provider and the pyannote/embedding model accepted on the server (see the server README). Forget below truly deletes a voice; deleting the vault file deletes them all."
				)
			)
			.addToggle((t) => t.setValue(s.voiceIdentity).onChange((v) => ((s.voiceIdentity = v), save(), voicePill(), this.display())));
		if (s.voiceIdentity) {
			new Setting(c)
				.setName("Voiceprint file")
				.setDesc("Where the voice library lives in your vault. It syncs with the vault, so voices named on one device are recognized on the others.")
				.addText((t) =>
					t.setValue(s.voiceprintsFile).onChange((v) => ((s.voiceprintsFile = v.trim() || "_resources/voiceprints.json"), save()))
				);
			const voicesEl = c.createDiv();
			void (async () => {
				const rows = summarizeVoiceprints(await this.plugin.loadVoiceprints());
				if (!rows.length) {
					new Setting(voicesEl)
						.setName("No voices remembered yet")
						.setDesc("Name a speaker on a WhisperX transcript and that voice is learned from the meeting itself.");
					return;
				}
				for (const r of rows) {
					new Setting(voicesEl)
						.setName(r.person)
						.setDesc(`${r.samples} enrollment${r.samples === 1 ? "" : "s"} across ${r.centroids} voice profile${r.centroids === 1 ? "" : "s"} (a headset and a room mic count separately)`)
						.addButton((b) =>
							b
								.setButtonText("Forget")
								.setWarning()
								.onClick(async () => {
									await this.plugin.saveVoiceprints(forgetVoiceprint(await this.plugin.loadVoiceprints(), r.person));
									new Notice(`Power Assistant: forgot ${r.person}'s voice.`);
									this.display();
								})
						);
				}
			})();
		}
		new Setting(c)
			.setName("Action items as tasks")
			.setDesc("Emit action items as '- [ ] Task [[Owner]] 📅 date' checklist lines (Tasks format), so they appear in todo dashboards with a backlink to the meeting. Off = the classic table.")
			.then((s) =>
				help(
					s,
					"On, each action becomes a checkbox line with an owner link and a due date, so it shows up in Tasks and to-do dashboards and links back to the meeting. Off lays the actions out as a plain Owner / Task / Deadline table instead. Owners and dates are only filled when the transcript actually states them."
				)
			)
			.addToggle((t) => t.setValue(s.actionsAsTasks).onChange((v) => ((s.actionsAsTasks = v), save())));
		new Setting(c)
			.setName("Timestamp each point")
			.setDesc("End every summary, decision, risk and question with the [m:ss] it came from, so each point clicks back to that moment in the recording.")
			.then((st) =>
				help(
					st,
					"A summary tells you what was decided; a stamp tells you where to go and hear it, which is what you want when the summary is not quite enough. It also lets a screen be placed beside the point it shows rather than in a gallery at the bottom, so this is worth turning on if you use Screens. The model is told to leave the stamp off rather than guess, so an item it cannot place carries none. Action items and Keywords never take stamps: both have a fixed shape that a trailing stamp would break."
				)
			)
			.addToggle((t) => t.setValue(s.stampSummaries).onChange((v) => ((s.stampSummaries = v), save())));
		new Setting(c)
			.setName("Link recurring meetings")
			.setDesc("When a capture's name matches an earlier one, give the extractor last time's decisions and open items as context, and add a 'Carried over' section for anything still open.")
			.then((s) =>
				help(
					s,
					"When a new capture's name matches an earlier one (a standing weekly, say), the extractor is handed last time's decisions and still-open items, and the note gets a Carried over section linking anything not yet resolved. The match ignores dates and counters in the name, so 'Weekly sync' lines up across weeks."
				)
			)
			.addToggle((t) => t.setValue(s.seriesAware).onChange((v) => ((s.seriesAware = v), save())));
		new Setting(c)
			.setName("Recording panel")
			.setDesc("Show a sidebar while recording with a running timer, an input-level meter, and a Mark moment button, so capture is always visibly confirmed. On desktop with AssemblyAI it also streams the live transcript; on other providers the full transcript appears after you stop. Purely additive; the recording never depends on it.")
			.then((s) =>
				help(
					s,
					"The on-page bar that proves the recording is really running: a timer, a moving input-level meter, and a Mark moment button. On desktop with AssemblyAI it also streams the transcript live; other providers show it after you stop. It is only a display, so closing it never affects the recording."
				)
			)
			.addToggle((t) => t.setValue(s.liveTranscript).onChange((v) => ((s.liveTranscript = v), save())));
		new Setting(c)
			.setName("Your name")
			.setDesc('Enables the "Was I mentioned?" quick question, and tags solo voice memos as you.')
			.then((s) =>
				help(
					s,
					"Lets the plugin tell which voice and which mentions are yours: it powers the 'Was I mentioned?' quick question and tags solo voice memos as spoken by you. Used only for matching; nothing beyond that is written into notes."
				)
			)
			.addText((t) => t.setPlaceholder("Steve").setValue(s.yourName).onChange((v) => ((s.yourName = v.trim()), save())));
		new Setting(c)
			.setName("Auto weekly digest")
			.setDesc("On the first launch of each week, quietly build the meeting digest if the week had meetings. Never steals focus.")
			.then((s) =>
				help(
					s,
					"At the first launch of a new week, if the previous week had meetings, the digest note (owner task table, decisions, open questions) is built in the background. It never steals focus, and you can always run it by hand from the command palette."
				)
			)
			.addToggle((t) => t.setValue(s.autoWeeklyDigest).onChange((v) => ((s.autoWeeklyDigest = v), save())));
		const seriesCount = Object.keys(s.seriesTemplates).length;
		if (seriesCount) {
			new Setting(c)
				.setName("Per-series section defaults")
				.setDesc(`${seriesCount} series remember their own extraction sections. Set these from a recording's Process dialog.`)
				.then((st) =>
					help(
						st,
						"Some recurring meetings always want the same sections. When you tick 'remember for this series' in a Process dialog, that choice is stored here and reused automatically next time the series comes up. Clear all forgets every remembered series."
					)
				)
				.addButton((b) =>
					b.setButtonText("Clear all").onClick(() => {
						s.seriesTemplates = {};
						save();
						this.display();
					})
				);
		}
		new Setting(c)
			.setName("Rotate recording parts after (minutes)")
			.setDesc("Long recordings split into parts so transcription size limits never truncate a meeting; parts are transcribed together into one note. 0 turns rotation off.")
			.then((s) =>
				help(
					s,
					"Long recordings are split into parts of this length so a single file never exceeds a provider's upload size limit and gets cut off; the parts are transcribed and stitched back into one note. 0 turns splitting off. Only matters for very long sessions."
				)
			)
			.addText((t) =>
				t.setValue(String(s.maxPartMinutes)).onChange((v) => {
					const n = Math.max(0, Math.floor(Number(v) || 0));
					s.maxPartMinutes = n;
					save();
				})
			);

		section("Morning briefing", "meetings");
		new Setting(c)
			.setName("Auto morning briefing")
			.setDesc("On the first launch of each day, open a briefing with today's meetings, commitments coming due, documents due soon, and open questions. Also available any time via the sunrise ribbon or the Morning briefing command.")
			.then((s) =>
				help(
					s,
					"At the first launch each day, a briefing note is built and opened: today's meetings (with a foldable details callout each), your commitments coming due, bills and documents due soon, and recent open questions. It fires once a day; the sunrise ribbon and Morning briefing command run it any time."
				)
			)
			.addToggle((t) => t.setValue(s.autoMorningBriefing).onChange((v) => ((s.autoMorningBriefing = v), save())));
		new Setting(c)
			.setName("Briefing horizon (days)")
			.setDesc("How far ahead a commitment or document counts as coming due in the briefing.")
			.then((s) =>
				help(
					s,
					"The look-ahead window for the Commitments and Bills sections: a task or document counts as coming due if its date falls within this many days. Anything already overdue always shows regardless. 3 is a sensible default; raise it to see further out."
				)
			)
			.addText((t) =>
				t
					.setValue(String(s.briefingHorizonDays))
					.onChange((v) => ((s.briefingHorizonDays = Math.max(0, Math.min(30, parseInt(v, 10) || 0))), save()))
			);
		new Setting(c)
			.setName("Briefing folder")
			.setDesc("Where morning briefings are saved. Empty keeps them in a Briefings folder under the output folder. Example: Capture/Notes/Briefings")
			.then((s) =>
				help(
					s,
					"The folder each day's briefing note is written to, created if missing. Leave it empty to keep the default, a Briefings folder under your output folder. One note is written per day, named by its date."
				)
			)
			.addText((t) =>
				t.setPlaceholder(`${s.outputFolder}/Briefings`).setValue(s.briefingsFolder).onChange((v) => ((s.briefingsFolder = cleanFolderPath(v)), save()))
			);

		section("Capture", "audio");
		providerPick(
			"Transcription provider",
			"Which provider transcribes dropped audio and standalone recordings. A solo memo has nothing to diarize, so Whisper is usually enough and costs the least.",
			() => s.captureProvider,
			(v) => (s.captureProvider = v),
			"This covers audio dropped into the capture folder, files you hand-pick to process, and recordings started from the ribbon without a meeting note. If you record a real multi-person meeting this way, Whisper gives you no speaker labels, and recovering them means re-processing the saved audio."
		);
		new Setting(c)
			.setName("Capture system audio")
			.setDesc("Desktop only: also record what plays through your speakers/headset, so both sides of Teams/Zoom/Meet calls are captured. The recording notice tells you which sources are live.")
			.then((s) =>
				help(
					s,
					"Records the audio playing through your speakers or headset alongside your microphone, so both sides of a Teams, Zoom, or Meet call are captured, not just you. The recording notice lists which sources are live. Desktop only; ignored on mobile."
				)
			)
			.addToggle((t) => t.setValue(s.captureSystemAudio).onChange((v) => ((s.captureSystemAudio = v), save())));
		new Setting(c)
			.setName("Capture folder")
			.setDesc("Audio dropped or recorded into this folder is processed automatically.")
			.then((s) =>
				help(
					s,
					"The drop zone for hands-off capture: any audio you record or move into this folder is transcribed and turned into a note without further prompting. Useful for saving a voice memo from your phone and letting it process when it syncs in."
				)
			)
			.addText((t) => t.setValue(s.captureFolder).onChange((v) => ((s.captureFolder = v.trim() || "Capture"), save())));
		new Setting(c)
			.setName("Folder for recordings")
			.setDesc("Empty keeps recordings in the capture folder. When set, recordings land here instead, and the folder is created if missing. Example: _resources/audio")
			.then((s) =>
				help(
					s,
					"Where the audio files themselves are stored. Empty leaves them in the capture folder; set it to keep recordings out of the way, for example under _resources/audio, created if missing. The notes still land in the output folder either way."
				)
			)
			.addText((t) =>
				t.setPlaceholder("_resources/audio").setValue(s.audioFolder).onChange((v) => ((s.audioFolder = cleanFolderPath(v)), save()))
			);
		new Setting(c)
			.setName("Output folder")
			.then((s) => help(s, "Where finished notes are written. Most other features (briefings, people pages, chats) nest under this folder unless you point them somewhere else. Defaults to Capture/Notes."))
			.addText((t) => t.setValue(s.outputFolder).onChange((v) => ((s.outputFolder = v.trim() || "Capture/Notes"), save())));
		new Setting(c)
			.setName("Filename template")
			.setDesc("{{basename}} = audio filename, {{date}} = today. Extension optional; defaults to .md.")
			.then((s) =>
				help(
					s,
					"The name pattern for a note made from an audio file. {{basename}} is the audio file's own name and {{date}} is today; for example {{date}} {{basename}} dates each note. Add an extension or it defaults to .md."
				)
			)
			.addText((t) => t.setValue(s.filenameTemplate).onChange((v) => ((s.filenameTemplate = v), save())));
		section("PowerPoint", "capture");
		new Setting(c)
			.setName("Deck notes folder")
			.setDesc("Where a captured deck's note is written. Empty uses the output folder.")
			.then((st) =>
				help(
					st,
					"Drop a .pptx onto a note, or run 'Capture a PowerPoint', and the deck is indexed into a note here: a section per slide with its text, its pictures, and the speaker notes. The deck file itself stays where it landed and the note links back to it. The folder is created if it is missing."
				)
			)
			.addText((t) => t.setPlaceholder("Sources/Decks").setValue(s.pptxFolder).onChange((v) => ((s.pptxFolder = cleanFolderPath(v)), save())));
		new Setting(c)
			.setName("Read slide images")
			.setDesc("Whether slide pictures are read for the text in them. Each capture asks, so this is only the starting choice.")
			.then((st) =>
				help(
					st,
					"Slide text and speaker notes always come through and cost nothing extra. Reading pictures sends them to Claude on your key, which is what catches the words inside charts, diagrams, and screenshots, and it lands in the usage meter. 'Larger images only' is the sensible middle: it keeps the real pictures and drops the bullet icons a deck is littered with. 'Every image' spares nothing, for the rare deck where the small marks matter."
				)
			)
			.addDropdown((d) =>
				d
					.addOption("none", "No images, text only")
					.addOption("large", "Larger images only")
					.addOption("all", "Every image")
					.setValue(s.pptxOcr)
					.onChange((v) => {
						s.pptxOcr = v as OcrMode;
						save();
						this.display();
					})
			);
		if (s.pptxOcr !== "all")
			new Setting(c)
				.setName("Smallest picture to keep")
				.setDesc("Pictures drawn smaller than this on the slide, in inches, are decoration: they are neither kept nor read.")
				.then((st) =>
					help(
						st,
						"This measures how big a picture is DRAWN on the slide, not how many pixels it holds. Bullet icons routinely ship as 256x256 images and render at a third of an inch, so pixels tell you nothing about the job a picture does. One inch clears the icons and keeps the charts. Raise it if decorative art still lands in the note, lower it if a small chart is being dropped."
					)
				)
				.addText((t) =>
					t
						.setPlaceholder("1")
						.setValue(String(s.pptxMinInches))
						.onChange((v) => {
							const n = Number(v.trim());
							if (Number.isFinite(n) && n >= 0) {
								s.pptxMinInches = n;
								save();
							}
						})
				);

		section("Screens", "audio");
		intro(
			"A recorded meeting is mostly a shared screen, and the screen is often the point. Turned on, a video capture is walked after its note is written and a frame is kept wherever the picture changed, landing under a Screens heading with the timestamp each one came from. Audio-only captures are unaffected. Run Add screens from a video file to do this to any note by hand, including from a recording that is not in the vault."
		);
		new Setting(c)
			.setName("Screens from a video capture")
			.setDesc("Scan video captures for the moments the picture changed and add those frames to the note. Off by default: it costs a decode of the whole recording and puts image files in your vault.")
			.then((st) =>
				help(
					st,
					"Nothing needs installing for this. Obsidian already decodes a video in order to play it, so the frames come from the same decoder, not from ffmpeg. The cost is time and space: roughly a minute of background work per hour of recording, and about a megabyte of images per meeting at the default cap. The per-file dialog has its own toggle, so you can leave this off and still ask for screens on the recordings where the screen mattered."
				)
			)
			.addToggle((t) => t.setValue(s.framesFromVideo).onChange((v) => ((s.framesFromVideo = v), save(), this.display())));
		if (s.framesFromVideo) {
			new Setting(c)
				.setName("Sample every")
				.setDesc("Seconds between looks at the picture. Smaller catches a screen that was only up briefly and costs one seek per step; an hour at 5 seconds is around 720 of them.")
				.addText((t) =>
					t
						.setPlaceholder("5")
						.setValue(String(s.frameEvery))
						.onChange((v) => {
							const n = Number(v.trim());
							if (Number.isFinite(n) && n >= 1) {
								s.frameEvery = Math.round(n);
								save();
							}
						})
				);
			new Setting(c)
				.setName("Change threshold")
				.setDesc("How much of the picture must change, as a percentage, to count as a new screen.")
				.then((st) =>
					help(
						st,
						"Each look is compared with the last frame that counted as a change, not with the one before it, so a slow fade cannot creep past this a pixel at a time. 12 percent clears a person shifting in their chair and still catches a slide advancing. Lower it if a screen you wanted was skipped; raise it if you are getting the same screen several times."
					)
				)
				.addText((t) =>
					t
						.setPlaceholder("12")
						.setValue(String(s.frameThreshold))
						.onChange((v) => {
							const n = Number(v.trim());
							if (Number.isFinite(n) && n >= 0 && n <= 100) {
								s.frameThreshold = n;
								save();
							}
						})
				);
			new Setting(c)
				.setName("Maximum screens")
				.setDesc("The cap for one recording. When more changes are found than this, the biggest changes are kept and a notice says how many were left out.")
				.addText((t) =>
					t
						.setPlaceholder("12")
						.setValue(String(s.frameMax))
						.onChange((v) => {
							const n = Number(v.trim());
							if (Number.isFinite(n) && n >= 1) {
								s.frameMax = Math.round(n);
								save();
							}
						})
				);
			new Setting(c)
				.setName("Read each screen")
				.setDesc("Have the AI model read every kept frame and quote what it found under the image, so a screen is searchable as text. Costs one image call per frame.")
				.then((st) =>
					help(
						st,
						"Without this a screen is only a picture: it shows up in the note but no search will ever find it by what it said. Reading them turns each frame into a few lines of quoted text under the image, which is what makes an architecture page or a number on a slide findable later. It is a separate image call per frame, so twelve screens is twelve calls, and it lands in the usage meter with everything else."
					)
				)
				.addToggle((t) => t.setValue(s.frameCaptions).onChange((v) => ((s.frameCaptions = v), save())));
		}

		section("YouTube", "capture");
		providerPick(
			"Transcription provider",
			"Which provider transcribes a video's audio, when Transcribe the audio below is on. A video is usually one narrator, so Whisper is normally the right call.",
			() => s.youtubeProvider,
			(v) => (s.youtubeProvider = v),
			"Only used when Transcribe the audio is on and the plugin downloads the audio instead of taking the free caption track. Speaker labels rarely matter for a video, so the cheapest provider is usually the right one here."
		);
		new Setting(c)
			.setName("YouTube folder")
			.setDesc("Where captured YouTube notes are written. Empty uses the output folder.")
			.then((s) => help(s, "Where notes captured from a YouTube URL are written. Empty uses your main output folder; set it to keep video notes somewhere separate like Personal/YouTube, created if missing."))
			.addText((t) => t.setPlaceholder("Personal/YouTube").setValue(s.youtubeFolder).onChange((v) => ((s.youtubeFolder = cleanFolderPath(v)), save())));
		new Setting(c)
			.setName("YouTube filename")
			.setDesc("{{title}} = the video title, {{date}} = today. For example {{date}} {{title}} puts the date in front. Extension optional; defaults to .md.")
			.then((s) => help(s, "The name pattern for a captured video note. {{title}} is the video's title and {{date}} is today, so {{date}} {{title}} dates each one. Add an extension or it defaults to .md."))
			.addText((t) => t.setPlaceholder("{{title}}").setValue(s.youtubeFilename).onChange((v) => ((s.youtubeFilename = v || "{{title}}"), save())));
		new Setting(c)
			.setName("Transcribe the audio")
			.setDesc("Transcribe the video's actual audio through your transcription provider instead of its auto-captions. More accurate for names and numbers, but it costs transcription credits and downloads the audio. Best-effort: it falls back to captions when the audio cannot be fetched. Off uses the free captions.")
			.then((s) =>
				help(
					s,
					"On, the video's audio is downloaded and run through your transcription provider, which gets names and numbers right where YouTube's auto-captions mangle them, at the cost of transcription credits and a short download. It quietly falls back to captions if the audio cannot be fetched. Off uses the free captions."
				)
			)
			.addToggle((t) => t.setValue(s.youtubeTranscribeAudio).onChange((v) => ((s.youtubeTranscribeAudio = v), save())));
		new Setting(c)
			.setName("YouTube sections")
			.setDesc("Which sections a captured video's notes include. The defaults are tuned for video content (takeaways, facts, resources, quotes) rather than meeting minutes.")
			.then((s) =>
				help(
					s,
					"The checklist below picks which sections a captured video's note contains, kept separate from your meeting sections. The defaults lean toward video content (takeaways, facts, resources, quotes) instead of meeting minutes like decisions and action items."
				)
			);
		for (const e of EXTRACTIONS)
			new Setting(c)
				.setName(e.label)
				.setDesc(e.hint)
				.then((st) => help(st, SECTION_HELP[e.key] ?? e.hint))
				.addToggle((t) => t.setValue(!!s.youtubeExtractions[e.key]).onChange((v) => ((s.youtubeExtractions[e.key] = v), save())))
				.setClass("pcap-subsetting");
		section("Capture from a link", "capture");
		intro(
			'Paste a link and Power Assistant decides how to read it: a YouTube video uses its free captions, a video or social post is downloaded and transcribed, and anything else is read as a web page. Downloading needs yt-dlp, a separate free program; install it with "pip install yt-dlp". Reading a web page needs nothing extra.'
		);
		// The recognized sites as chips rather than a sentence. The question this
		// list answers is "can I paste this?", and scanning a name out of a dozen
		// beats reading a comma list to find it. The lock marks the ones that show
		// a logged-out visitor nothing, since "supported" and "will work for you"
		// are different promises for those three.
		// not ptc-section-intro: that class hides the name, and this row wants one
		const sitesRow = new Setting(c).setName("Recognized video and social sites")
			.then((st) => help(st, "The sites a link capture reads as video or a social post rather than an article. Roughly 1,750 more work through Read it as > Video even when they are not listed here. A marked site serves almost nothing to a logged-out visitor, so those need the Cookies from browser setting before a capture will find anything.")).setClass("pcap-sites-row");
		const chips = sitesRow.descEl.createDiv({ cls: "pcap-site-chips" });
		for (const m of MEDIA_SITES) {
			const chip = chips.createSpan({ cls: "pcap-site-chip" });
			if (m.login) {
				chip.addClass("is-login");
				setIcon(chip.createSpan({ cls: "pcap-site-lock" }), "lock");
			}
			chip.createSpan({ text: m.label });
		}
		chips.createSpan({ cls: "pcap-site-chip is-more", text: "+ ~1,750 more" });
		sitesRow.descEl.createDiv({
			cls: "pcap-site-legend",
			text: "Locked sites show a logged-out visitor almost nothing, so they need Cookies from browser below. Anything not listed is read as a web page; choose Video in the capture dialog to send it to yt-dlp instead.",
		});
		new Setting(c)
			.setName("yt-dlp path")
			.setDesc("The full path to yt-dlp. Empty searches your PATH and then Python's module form, which is what a pip install usually leaves working. Use Check to see which one answers.")
			.then((st) =>
				help(
					st,
					"Where to find yt-dlp, the program that downloads a post's audio. Empty is normally right: it tries your PATH first, then runs it through Python, which covers a pip install that put the launcher somewhere PATH does not look. Set a full path only when Check cannot find it. Not needed at all for web pages."
				)
			)
			.addText((t) => t.setPlaceholder("Leave empty to search").setValue(s.ytDlpPath).onChange((v) => ((s.ytDlpPath = v.trim()), save())))
			.addButton((b) =>
				b.setButtonText("Check").onClick(async () => {
					b.setDisabled(true).setButtonText("Checking…");
					try {
						new Notice(`Power Assistant: yt-dlp ${await this.plugin.ytDlpVersion()} is working.`, 6000);
					} catch (e) {
						new Notice("Power Assistant: " + (e instanceof Error ? e.message : String(e)), 12000);
					} finally {
						b.setDisabled(false).setButtonText("Check");
					}
				})
			);
		{
			// The one that should be enough: sign in here, in a window, the way
			// you would sign in anywhere. Everything below it is for the cases
			// this cannot reach.
			const row = new Setting(c)
				.setName("YouTube sign-in")
				.setDesc("Checking…")
				.then((st) =>
					help(
						st,
						"YouTube increasingly answers a device it does not recognise with \"Sign in to confirm you're not a bot\", and a capture then looks like a video with no captions. Being signed in to youtube.com in your browser does not help: a capture goes out from Obsidian and from yt-dlp, and neither can see your browser's cookies. This signs in here instead, and it never asks for your password. Google will not accept one typed into a window inside another app, which is a sensible rule and not one worth dodging, so this uses the flow built for devices in that position: the window opens YouTube's TV interface, you choose Sign in, and it shows a short code. Enter that code at youtube.com/activate in the browser you already trust (the arrow button opens it), approve, and the window is signed in. Then close it. The session is kept in this plugin's own store, separate from the rest of Obsidian, and is never written into your vault or into a note; when a capture needs it, it is handed to yt-dlp as a temporary file deleted the moment the download ends. Sign out clears the whole thing."
					)
				);
			// The label has to agree with the words beside it: a row saying a
			// session is saved, next to a button saying Sign in, reads as a
			// contradiction and sends you round the sign-in again for nothing.
			let signedIn = false;
			let openBtn: ButtonComponent | null = null;
			const paint = async () => {
				const cookies = await this.plugin.youtubeCookies();
				signedIn = cookies.length > 0;
				// a count and a way to check, rather than a verdict: whether a
				// session works is answered by YouTube, and Test YouTube asks it
				row.setDesc(
					signedIn
						? `A YouTube session is saved (${cookies.length} cookies)${hasYoutubeLogin(cookies) ? ", signed in" : ""}. Captures use it. Test says whether it gets through.`
						: "No session saved. Sign in here if YouTube says a video has no captions, or asks this device to confirm it is not a bot. No password is typed here: YouTube shows a code you approve in your own browser."
				);
				openBtn?.setButtonText(signedIn ? "Open YouTube" : "Sign in");
				openBtn?.setTooltip(signedIn ? "Open the signed-in window again, to check it or switch account" : "Open YouTube's TV interface and pair a code");
			};
			void paint();
			row.addButton((b) =>
				b.setButtonText("Test").setTooltip("Ask YouTube for one video's title with this session. Downloads nothing.").onClick(async () => {
					b.setDisabled(true).setButtonText("Testing…");
					try {
						const title = await this.plugin.youtubeReach();
						new Notice(
							title ? `Power Assistant: YouTube answered — “${title}”. Captures work.` : "Power Assistant: YouTube answered, but said nothing. Try again in a minute.",
							8000
						);
					} catch (e) {
						const m = e instanceof Error ? e.message : String(e);
						new Notice(
							/sign in|not a bot|cookies/i.test(m)
								? "Power Assistant: YouTube still will not talk to this device" +
										(signedIn ? ", even with the saved session. Tell Steve — the session works in the window but not for a download." : ". Sign in above.")
								: "Power Assistant: " + m,
							15000
						);
					} finally {
						b.setDisabled(false).setButtonText("Test");
					}
				})
			);
			row.addButton((b) => {
				openBtn = b;
				b.setButtonText("Sign in").onClick(async () => {
					b.setDisabled(true).setButtonText("Waiting…");
					try {
						await this.plugin.signInToYoutube();
					} finally {
						b.setDisabled(false);
						void paint();
					}
				});
			});
			row.addExtraButton((b) =>
				b
					.setIcon("external-link")
					.setTooltip("Open youtube.com/activate in your browser, to enter the code")
					.onClick(() => window.open("https://www.youtube.com/activate"))
			);
			row.addExtraButton((b) =>
				b
					.setIcon("log-out")
					.setTooltip("Sign out and forget the session")
					.onClick(async () => {
						await this.plugin.signOutOfYoutube();
						void paint();
					})
			);
		}
		new Setting(c)
			.setName("Cookies from browser")
			.setDesc(
				"Only needed for Instagram, Facebook, and LinkedIn, which show almost nothing to a logged-out visitor. Everything else captures fine with this off. On Windows this often fails with Chrome and Edge; see the help."
			)
			.then((st) =>
				help(
					st,
					"Off by default, and off means the plugin never touches your browser. Turned on, yt-dlp reads that browser's cookie store at download time so gated sites see you as signed in. Nothing is copied into the vault or into the plugin's settings; the cookies are read per run. Two things to know before turning it on. It applies to every download, not just the gated sites, so your other captures would go out signed in as you when they do not need to be. And on Windows, Chrome and Edge encrypt their cookie stores in a way yt-dlp usually cannot read (Edge reports a DPAPI failure; Chrome also locks its database while it is running), so it may simply not work no matter how it is set. Firefox is the reliable one on Windows."
				)
			)
			.addDropdown((d) => {
				d.addOptions({ "": "Off", chrome: "Chrome", chromium: "Chromium", edge: "Edge", firefox: "Firefox", brave: "Brave" });
				d.setValue(s.cookieBrowser).onChange((v) => ((s.cookieBrowser = (COOKIE_BROWSERS.includes(v as CookieBrowser) ? v : "") as CookieBrowser), save()));
				d.selectEl.addClass("dropdown");
			});
		new Setting(c)
			.setName("Cookies file")
			.setDesc(
				"Full path to a cookies.txt exported from your browser. Used ahead of the setting above, and the one that works on Windows where reading Chrome or Edge directly does not. Being signed in to YouTube in your browser does not by itself reach a capture; see the help."
			)
			.then((st) =>
				help(
					st,
					"YouTube now answers an unrecognised device with \"Sign in to confirm you're not a bot\", and a capture then looks like a video with no captions. Being signed in to youtube.com in your browser does NOT fix this: a capture goes out from Obsidian and from yt-dlp, and neither shares your browser's cookie jar — as far as YouTube can tell, they are a stranger. What gets through is handing those programs a copy of the cookies. Reading them straight out of Chrome or Edge fails on Windows (both encrypt the store), so export a cookies.txt with a browser extension and point this at the file, then press Test YouTube. Keep the file outside your vault: it holds live sessions for whatever sites it covers, anyone with it is signed in as you, and a vault that syncs would carry it to every device and to your cloud folder. It is read at download time and never copied into a note or into these settings. Export it from a private window you close afterwards, so ordinary browsing does not rotate the session out from under it, and re-export when captures start failing again."
				)
			)
			.addText((t) => t.setPlaceholder("C:\\Users\\you\\cookies.txt").setValue(s.cookieFile).onChange((v) => ((s.cookieFile = v.trim()), save())));
		providerPick(
			"Transcription provider",
			"Which provider transcribes a video or post's audio. These are usually one voice, so Whisper is normally the right call.",
			() => s.mediaProvider,
			(v) => (s.mediaProvider = v),
			"A social post has no caption track, so this provider is always the one that reads it. Speaker labels rarely matter for a short clip, so the cheapest provider is usually the right one here. Web pages never reach this setting."
		);
		new Setting(c)
			.setName("Video and social folder")
			.setDesc("Where captured videos and posts are written. {{site}} becomes X, TikTok, Reddit, and so on. Empty uses the output folder.")
			.then((st) =>
				help(
					st,
					"Where a captured video or post lands. Empty uses your main output folder. {{site}} fills in the source, so Social/{{site}} keeps X and TikTok in their own folders without a settings tab for each. Created if missing."
				)
			)
			.addText((t) => t.setPlaceholder("Sources/Social/{{site}}").setValue(s.mediaFolder).onChange((v) => ((s.mediaFolder = v.trim()), save())));
		new Setting(c)
			.setName("Video and social filename")
			.setDesc("{{title}} = the post's text, {{date}} = today, {{site}} = X, TikTok, and so on. Extension optional; defaults to .md.")
			.then((st) => help(st, "The name pattern for a captured video or post. {{title}} is the post's own text trimmed to fit a filename, {{date}} is today, and {{site}} is the source. Add an extension or it defaults to .md."))
			.addText((t) => t.setPlaceholder("{{date}} {{title}}").setValue(s.mediaFilename).onChange((v) => ((s.mediaFilename = v || "{{date}} {{title}}"), save())));
		new Setting(c)
			.setName("Video and social sections")
			.setDesc("Which sections a captured video or post includes. The defaults are tuned for content (takeaways, facts, resources, quotes) rather than meeting minutes. A text-only post takes a shorter list; see the help.")
			.then((st) =>
				help(
					st,
					"The checklist below picks which sections a captured video or post contains, kept separate from your meeting, YouTube, and web sections. The defaults lean toward content (takeaways, facts, resources, quotes) instead of meeting minutes like decisions and action items. A post with no video is usually a sentence or two, and most of these sections have nothing to work with there, so a text-only post narrows to Summary, Key takeaways, and Keywords: the rest would only write \"None identified\" above the post itself. Switching one of those three off here switches it off there too; nothing is ever turned back on."
				)
			);
		for (const e of EXTRACTIONS)
			new Setting(c)
				.setName(e.label)
				.setDesc(e.hint)
				.then((st) => help(st, SECTION_HELP[e.key] ?? e.hint))
				.addToggle((t) => t.setValue(!!s.mediaExtractions[e.key]).onChange((v) => ((s.mediaExtractions[e.key] = v), save())))
				.setClass("pcap-subsetting");
		section("Web pages", "capture");
		intro("Reading a web page costs no transcription: the page is fetched, reduced to its article, converted to Markdown, and extracted like anything else. Only the AI extraction costs anything, and that is optional too.");
		new Setting(c)
			.setName("Web folder")
			.setDesc("Where captured pages are written. One folder is usually right here; see the help for why {{site}} suits social but not the web. Empty uses the output folder.")
			.then((st) =>
				help(
					st,
					"Where a captured page lands. Empty uses your main output folder. {{site}} works here, but it is rarely what you want: for social it is a dozen tidy labels like X and TikTok, while for a web page it comes from that page's own og:site_name, which is unbounded and often untidy (real examples: \"Wikimedia Foundation, Inc.\", \"Simon Willison's Weblog\"). That means a new folder per publication. One folder reads better, and the site is a property on every note, so a Base can still group by it. Created if missing."
				)
			)
			.addText((t) => t.setPlaceholder("Sources/Articles").setValue(s.webFolder).onChange((v) => ((s.webFolder = v.trim()), save())));
		new Setting(c)
			.setName("Web filename")
			.setDesc("{{title}} = the article's headline, {{date}} = today, {{site}} = the publication. Extension optional; defaults to .md.")
			.then((st) => help(st, "The name pattern for a captured page. {{title}} is the article's headline, {{date}} is today, and {{site}} is the publication. Add an extension or it defaults to .md."))
			.addText((t) => t.setPlaceholder("{{date}} {{title}}").setValue(s.webFilename).onChange((v) => ((s.webFilename = v || "{{date}} {{title}}"), save())));
		new Setting(c)
			.setName("Keep the article text")
			.setDesc("Store the full article under an Article heading, below the AI notes. Off keeps only the notes and the link.")
			.then((st) =>
				help(
					st,
					"On, the whole article is saved into the note so it stays searchable, quotable, and readable after the page changes or disappears. This is separate from the transcript setting on purpose: a transcript is a by-product of transcribing, while an article is the thing itself. Off keeps only the AI sections and the source link."
				)
			)
			.addToggle((t) => t.setValue(s.webIncludeArticle).onChange((v) => ((s.webIncludeArticle = v), save())));
		new Setting(c)
			.setName("Web sections")
			.setDesc("Which sections a captured page includes.")
			.then((st) => help(st, "The checklist below picks which sections a captured page contains, kept separate from your other capture kinds. The defaults lean toward written content: summary, takeaways, facts, resources, and quotes."));
		for (const e of EXTRACTIONS)
			new Setting(c)
				.setName(e.label)
				.setDesc(e.hint)
				.then((st) => help(st, SECTION_HELP[e.key] ?? e.hint))
				.addToggle((t) => t.setValue(!!s.webExtractions[e.key]).onChange((v) => ((s.webExtractions[e.key] = v), save())))
				.setClass("pcap-subsetting");
		section("Meeting notes", "meetings");
		new Setting(c)
			.setName("Meetings folder")
			.setDesc("Where the New meeting note command creates pages. Empty uses the output folder. Created if missing.")
			.then((s) =>
				help(
					s,
					"Where the New meeting note command (and its ribbon icon) puts the page it creates, so you can prep an agenda before a call and record straight into it. Empty uses the output folder; created if missing."
				)
			)
			.addText((t) =>
				t.setPlaceholder("Meetings").setValue(s.meetingsFolder).onChange((v) => ((s.meetingsFolder = cleanFolderPath(v)), save()))
			);
		new Setting(c)
			.setName("Ask where a quick recording goes")
			.setDesc("When a mic-button recording stops, ask whether it becomes a meeting note in the Meetings folder or the usual capture note.")
			.then((st) =>
				help(
					st,
					"The mic button records without a meeting note, and those recordings normally become capture notes in the output folder. With this on, stopping one asks whether it should instead become a meeting note: filed in the Meetings folder, named by date and title, transcribed by the meeting provider, and eligible for series carry-over. Closing the dialog keeps it a capture, and a recording left unanswered is simply saved (Process pending recordings picks it up). Recordings started from a meeting note never ask; they already have a home."
				)
			)
			.addToggle((t) => t.setValue(s.askQuickFiling).onChange((v) => ((s.askQuickFiling = v), save())));
		new Setting(c)
			.setName("Meeting filename")
			.setDesc("{{date}} = today, {{title}} = what you type. Extension optional; defaults to .md.")
			.then((s) => help(s, "The name pattern for a page from the New meeting note command. {{date}} is today and {{title}} is what you type in the dialog. Add an extension or it defaults to .md."))
			.addText((t) => t.setValue(s.meetingFilename).onChange((v) => ((s.meetingFilename = v || "{{date}} {{title}}"), save())));
		new Setting(c)
			.setName("Meeting template note")
			.setDesc("A note in your vault whose body is the template. Its own properties are ignored; the plugin writes the meeting's. Empty uses the box below.")
			.then((st) =>
				help(
					st,
					"The better place to keep a template, if you already keep them as notes: you write it in the editor with live preview instead of a settings box, it syncs with the vault, and its history is your vault's history. Name any note here and its body becomes what a new meeting note starts with, tokens and all. Whatever properties the template note carries — an icon, a description, the fields some other template tool wants — are ignored: they describe the template, not the meeting, and the plugin writes the meeting's own properties itself. Tokens this plugin does not know are left exactly as they are, so a template shared with another tool keeps that tool's placeholders intact. If the note is renamed or deleted, a new meeting says so once and falls back to the box below rather than failing."
				)
			)
			.addText((t) => t.setPlaceholder("Templates/Meeting Notes").setValue(s.meetingTemplateFile).onChange((v) => ((s.meetingTemplateFile = v.trim()), save())))
			.addExtraButton((b) =>
				b
					.setIcon("search")
					.setTooltip("Pick a note")
					.onClick(() =>
						new NotePickModal(this.app, (f) => {
							s.meetingTemplateFile = f.path;
							save();
							this.display();
						}).open()
					)
			);
		new Setting(c)
			.setName("Meeting note template")
			.setDesc(`What a new meeting note starts with. Tokens: ${MEETING_TOKENS.map((t) => `{{${t.token}}}`).join(", ")}. A line whose tokens are all empty is left out.`)
			.then((st) =>
				help(
					st,
					"The body of a new meeting note, yours to arrange. The properties above it are not part of this: they are structured fields Obsidian edits in place, and one malformed line in a template would break every note's YAML, so the plugin keeps writing those.\n\n" +
						MEETING_TOKENS.map((t) => `{{${t.token}}} — ${t.what}`).join("\n") +
						"\n\nA line that carries tokens and gets nothing back is dropped, label and all: put \"**Where:** {{where}}\" in and a meeting with no location leaves no orphan \"Where:\" behind. A line with no tokens is kept exactly as written, so headings and checklists survive untouched. An unknown token counts as empty, which takes its line with it — worth knowing if a line disappears and you expected it. Empty resets to the default."
				)
			)
			.then((st) => st.settingEl.addClass("pcap-template-item"))
			.addTextArea((t) => {
				t.setPlaceholder(DEFAULT_MEETING_TEMPLATE)
					.setValue(s.meetingTemplate)
					.onChange((v) => ((s.meetingTemplate = v), save()));
				t.inputEl.rows = 8;
				t.inputEl.addClass("pcap-template-area");
			})
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Back to the default template")
					.onClick(() => {
						s.meetingTemplate = DEFAULT_MEETING_TEMPLATE;
						save();
						this.display();
					})
			);
		new Setting(c)
			.setName("People folder")
			.setDesc("Attendee names link into this folder, so clicking one creates the person page there, and person reports are written to it. Empty uses People under the output folder.")
			.then((s) =>
				help(
					s,
					"Attendee names are linked into this folder, so clicking one opens or creates that person's page here rather than at the vault root, and person reports (their meetings, open items, decisions) are written here too. Empty uses a People folder under the output folder."
				)
			)
			.addText((t) =>
				t.setPlaceholder("Capture/Notes/People").setValue(s.peopleFolder).onChange((v) => ((s.peopleFolder = cleanFolderPath(v)), save()))
			);
		section("Documents", "capture");
		intro("Right-click an image or PDF and choose Process document: its text is read (Text Extractor OCRs images; PDFs need nothing extra), the vendor, date, amount, and type are extracted, the file is renamed and filed by type and year, and a note with those properties lands beside it.");
		new Setting(c)
			.setName("Documents folder")
			.setDesc("Where processed documents are filed, organized by type and year. Empty leaves files where they are and only writes the note.")
			.then((s) =>
				help(
					s,
					"The root a processed bill, receipt, or statement is moved into, sorted automatically by type and year (for example Documents/Bills/2026). Empty leaves the original file where it sits and only writes the note beside it. Filing rules below can override this per document."
				)
			)
			.addText((t) => t.setPlaceholder("Documents").setValue(s.docsFolder).onChange((v) => ((s.docsFolder = cleanFolderPath(v)), save())));
		new Setting(c)
			.setName("Documents inbox")
			.setDesc("Watched folder: an image or PDF dropped here is processed and filed automatically. Empty turns the watcher off.")
			.then((s) =>
				help(
					s,
					"A drop zone for documents: an image or PDF you move here is OCR'd, its vendor, date, amount, and type extracted, and it is filed and noted without a right-click. Empty turns the watcher off so documents are only processed when you ask."
				)
			)
			.addText((t) => t.setPlaceholder("Documents/Inbox").setValue(s.docInbox).onChange((v) => ((s.docInbox = cleanFolderPath(v)), save())));

		new Setting(c)
			.setName("Filing rules")
			.setDesc("Route and tag documents by their extracted fields. The first matching rule wins; its folder (with {year}, {type}, {vendor}) overrides the default, and its tags add to the extracted ones. No match keeps filing by type and year.")
			.then((s) =>
				help(
					s,
					"Rules that route and tag documents by what was extracted, for example send anything from Meralco to Utilities/{year} and tag it electricity. The first matching rule wins; its folder overrides the default and its tags add to the extracted ones. With no match, filing falls back to type and year."
				)
			)
			.addButton((b) =>
				b.setButtonText("Add rule").setCta().onClick(() => {
					new DocRuleModal(this.app, {}, (rule) => {
						s.docRules.push(rule);
						save();
						this.display();
					}).open();
				})
			);
		s.docRules.forEach((rule, i) => {
			new Setting(c)
				.setName(docRuleSummary(rule))
				.then((st) => help(st, "A saved filing rule. Incoming documents are checked against the rules top to bottom and the first match wins; the pencil edits its conditions and destination, the trash removes it."))
				.addExtraButton((b) => b.setIcon("pencil").setTooltip("Edit").onClick(() => new DocRuleModal(this.app, rule, (edited) => ((s.docRules[i] = edited), save(), this.display())).open()))
				.addExtraButton((b) => b.setIcon("trash").setTooltip("Delete").onClick(() => ((s.docRules.splice(i, 1)), save(), this.display())));
		});

		section("Transactions", "spending");
		intro(
			"Order confirmations and bills become notes: one per order, plus one per line item so spending reports by category. Power Desk watches your mailboxes and hands matching messages over; the Spending base and rollup read what lands. Amounts are checked against the totals the vendor printed, and anything that does not add up is flagged rather than trusted."
		);
		new Setting(c)
			.setName("Transactions folder")
			.setDesc("Root for captured orders and line items, each under a year folder. Empty turns transaction capture off.")
			.then((st) =>
				help(
					st,
					"Where captured purchases live: orders land in <folder>/Orders/<year> and their line items in <folder>/Items/<year>. Line items are separate notes so a mixed order reports correctly by category. Empty turns capture off entirely."
				)
			)
			.addText((t) => t.setPlaceholder("Finance").setValue(s.txnFolder).onChange((v) => ((s.txnFolder = cleanFolderPath(v)), save())));
		new Setting(c)
			.setName("Mail rules")
			.setDesc("Which incoming messages are captured. The first matching rule wins. Match the sender's real domain: bills often arrive from a mailing service rather than the company's own website.")
			.then((st) =>
				help(
					st,
					"Rules deciding which messages become transactions, checked top to bottom with the first match winning. A rule can also override the vendor name and mark a sender as business spending, which keeps company purchases out of the household rollup."
				)
			)
			.addButton((b) =>
				b.setButtonText("Add rule").setCta().onClick(() => {
					new TxnRuleModal(this.app, {}, (rule) => {
						s.txnRules.push(rule);
						save();
						this.display();
					}).open();
				})
			);
		s.txnRules.forEach((rule, i) => {
			new Setting(c)
				.setName(txnRuleSummary(rule))
				.then((st) => help(st, "A saved mail rule. The pencil edits its conditions and overrides, the trash removes it."))
				.addExtraButton((b) => b.setIcon("pencil").setTooltip("Edit").onClick(() => new TxnRuleModal(this.app, rule, (edited) => ((s.txnRules[i] = edited), save(), this.display())).open()))
				.addExtraButton((b) => b.setIcon("trash").setTooltip("Delete").onClick(() => ((s.txnRules.splice(i, 1)), save(), this.display())));
		});
		new Setting(c)
			.setName("Captured messages")
			.setDesc(`${s.txnSeen.length} message${s.txnSeen.length === 1 ? "" : "s"} already captured and skipped on future scans. Clearing this lets them be captured again.`)
			.then((st) => help(st, "The ledger of message ids already turned into notes, which is what stops a re-scan from counting the same order twice. Clear it only if you deleted the notes and want them rebuilt."))
			.addButton((b) => b.setButtonText("Clear").onClick(() => ((s.txnSeen = []), save(), this.display())));

		section("Import a mail folder", "mail");
		intro(
			"Turn a folder you already curate (a work folder, a project folder) into notes you can ask questions about. Each back-and-forth becomes ONE note holding the newest message, whose quoted history carries the rest of the thread, so a twenty-message exchange is one note rather than twenty copies of the same text. Run it from the command palette: \"Import a mail folder as notes\"."
		);
		new Setting(c)
			.setName("Folder for imported mail")
			.setDesc("Each mail folder becomes a subfolder here. Empty turns import off. Point it at a Power Connect encrypted folder to keep work mail encrypted on Dropbox.")
			.then((st) => help(st, "Imported exchanges land in <folder>/<mail folder name>. A conversation already imported is updated in place as it grows, so an active thread stays one note."))
			.addText((t) => t.setPlaceholder("Email").setValue(s.mailImportFolder).onChange((v) => ((s.mailImportFolder = cleanFolderPath(v)), save())));
		new Setting(c)
			.setName("Only Focused mail")
			.setDesc("Skip what Outlook classified as Other. That verdict is Microsoft's own, already learned from how you treat your mail, and it costs nothing to use.")
			.then((st) => help(st, "Outlook's Focused/Other split rides along with every message. An allow rule for a sender overrides this, so a newsletter you actually want is still kept."))
			.addToggle((t) => t.setValue(s.mailImportFocusedOnly).onChange((v) => ((s.mailImportFocusedOnly = v), save())));
		new Setting(c)
			.setName("Skip near-empty exchanges")
			.then((st) => help(st, "Drops an exchange whose newest message is barely there: a one-word reply, a read receipt, an acknowledgement. These carry no information worth searching and would otherwise sit in the corpus diluting real results. Set it to 0 to keep everything regardless of length."))
			.setDesc(`Drop an exchange whose newest message is under ${s.mailImportMinChars} characters ("thanks!", read receipts). 0 keeps everything.`)
			.addSlider((sl) =>
				sl
					.setLimits(0, 300, 10)
					.setValue(s.mailImportMinChars)
					.setDynamicTooltip()
					.onChange((v) => ((s.mailImportMinChars = v), save()))
			);
		new Setting(c)
			.setName("Messages read per import")
			.then((st) => help(st, "How many messages one import reads from a folder before stopping. A bound rather than a target: a folder holding years of mail would otherwise fetch all of it in a single run. Raise it for a deep backfill, then leave it lower for the routine top-ups."))
			.setDesc(`Read at most ${s.mailImportCap} messages from a folder in one run.`)
			.addSlider((sl) =>
				sl
					.setLimits(100, 5000, 100)
					.setValue(s.mailImportCap)
					.setDynamicTooltip()
					.onChange((v) => ((s.mailImportCap = v), save()))
			);
		new Setting(c)
			.setName("Sender rules")
			.setDesc("Block a sender to skip it, or allow one to keep it even when Outlook calls it Other. Run \"Scan senders\" on a folder first to see who actually fills it.")
			.then((st) => help(st, "Matched against the sender's name, address, and domain. A block rule always wins over an allow rule, and an empty rule never matches so it cannot become a catch-all."))
			.addButton((b) =>
				b.setButtonText("Add rule").setCta().onClick(() => {
					s.mailImportRules.push({ match: "", block: true, enabled: true });
					save();
					this.display();
				})
			);
		s.mailImportRules.forEach((rule, i) => {
			new Setting(c)
				.setName(rule.block ? "Block" : "Allow")
				.addText((t) =>
					t
						.setPlaceholder("name, address, or domain")
						.setValue(rule.match)
						.onChange((v) => ((s.mailImportRules[i].match = v.trim()), save()))
				)
				.addDropdown((d) =>
					d
						.addOptions({ block: "Block", allow: "Allow" })
						.setValue(rule.block ? "block" : "allow")
						.onChange((v) => ((s.mailImportRules[i].block = v === "block"), save(), this.display()))
				)
				.addExtraButton((b) => b.setIcon("trash").setTooltip("Delete").onClick(() => ((s.mailImportRules.splice(i, 1)), save(), this.display())));
		});

		section("Ask your email", "mail");
		intro(
			"A rolling window of your recent email, indexed locally so “Ask your vault” can answer from it (“what did the electric bill run last month”, “what did Dana send about the contract”). Nothing becomes a note and nothing syncs: the index lives in this plugin's folder and rebuilds from the mailbox. Needs Power Desk with a mailbox connected."
		);
		const mailReady = this.plugin.mailFeedAvailable();
		new Setting(c)
			.setName("Mail search window (days)")
			.setDesc(
				mailReady
					? "How many days of recent email to keep searchable. 0 turns it off. Larger windows index more mail but cost more memory. The window only reaches as far back as Power Desk has listed, so very old mail may not appear until it is opened."
					: "Install Power Desk and connect a mailbox to search your email here."
			)
			.then((st) => help(st, "The index is keyword search over stripped message text, the same engine Ask uses for notes. Each message contributes its subject, sender, and the head of its body. Turning this to 0 clears it on the next launch."))
			.addText((t) =>
				t
					.setPlaceholder("0")
					.setValue(String(s.mailWindowDays || ""))
					.onChange((v) => {
						const n = parseInt(v, 10);
						s.mailWindowDays = isFinite(n) && n > 0 ? Math.min(n, 365) : 0;
						save();
					})
			);
		if (mailReady && s.mailWindowDays > 0) {
			new Setting(c)
				.setName("Indexed now")
			.then((st) => help(st, "How much mail is currently searchable and how far back it reaches. The window only holds what Power Desk has already fetched, so if this looks short, raise Power Desk's mail history and messages-per-folder first, then refresh here."))
				.setDesc(this.plugin.mailWindowSummary())
				.addButton((b) => b.setButtonText("Refresh now").onClick(() => void this.plugin.refreshMailWindow().then(() => this.display())));
		}

		section("AI usage", "privacy");
		intro("Every Claude call and every stretch of transcription is logged locally, so the usage meter can total what this vault is spending. Nothing leaves your machine: the meter reads that log, not your provider accounts.");
		new Setting(c)
			.setName("Log AI usage")
			.setDesc("Record each AI call so the meter can total it. Turning this off stops logging; whatever is already recorded stays.")
			.then((st) =>
				help(
					st,
					"Each Claude call logs its model and the token counts the API reports back; each transcription logs its provider and audio length. The meter turns those into an estimated cost and keeps the two apart, because they are two different bills. These are estimates from published rates, not invoices: your billed Claude total lives in the Anthropic Console, and transcription is billed by your provider."
				)
			)
			.addToggle((t) => t.setValue(s.usageMeterEnabled).onChange((v) => ((s.usageMeterEnabled = v), save())));
		new Setting(c)
			.setName("Usage meter")
			.then((st) => help(st, "Opens the running tally of what this vault has spent on AI and transcription, split by feature and provider. These are estimates from published rates rather than invoices: the billed figure lives in your provider's own console, and this is for spotting which feature is costing what."))
			.setDesc(`Open the meter in the sidebar. ${s.usageLedger.length} call${s.usageLedger.length === 1 ? "" : "s"} recorded so far.`)
			.addButton((b) => b.setButtonText("Open").setCta().onClick(() => void this.plugin.openUsageMeter()))
			.addButton((b) =>
				b
					.setButtonText("Reset")
					.setWarning()
					.onClick(() => {
						s.usageLedger = [];
						save();
						this.display();
						new Notice("Power Assistant: usage ledger cleared.");
					})
			);

		section("Microsoft 365 calendar", "meetings");
		intro("Import upcoming meetings straight from your Outlook/Teams calendar. Register a free Azure app (Entra ID > App registrations), turn on 'Allow public client flows', add the delegated Calendars.Read permission, and paste its Application (client) ID below. The README has the exact steps. Sign-in tokens are stored locally in this vault.");
		new Setting(c)
			.setName("Application (client) ID")
			.setDesc("From your Azure app registration.")
			.then((s) =>
				help(
					s,
					"The identifier of the Azure app you register to reach your calendar; paste it from the app's Overview page. The README walks through creating the app (Entra ID, App registrations, allow public client flows, delegated Calendars.Read). It is not a secret, and sign-in tokens are stored only in this vault."
				)
			)
			.addText((t) => t.setPlaceholder("00000000-0000-0000-0000-000000000000").setValue(s.graphClientId).onChange((v) => ((s.graphClientId = v.trim()), save())));
		new Setting(c)
			.setName("Tenant")
			.setDesc(
				"If your app's Supported account types is 'My organization only' (the registration default), paste the Directory (tenant) ID from the app's Overview page. 'common' only works for apps registered as multi-tenant."
			)
			.then((s) =>
				help(
					s,
					"Leave this 'common' only if the app is registered as multi-tenant. If its Supported account types is 'My organization only' (the registration default), 'common' fails sign-in with an AADSTS error and you must paste the Directory (tenant) ID from the app's Overview page here instead."
				)
			)
			.addText((t) => t.setPlaceholder("common").setValue(s.graphTenant).onChange((v) => ((s.graphTenant = v.trim() || "common"), save())));
		new Setting(c)
			.setName("Connection")
			.setDesc(this.plugin.graphConnected() ? "Connected. Run 'Import meeting from calendar' to pick meetings." : "Not connected.")
			.then((s) =>
				help(
					s,
					"Runs the one-time device-code sign-in: you open a link and type a code in your own browser, so the plugin never sees your password. Once connected, Import meeting from calendar lets you pick meetings to pull in as notes. Disconnect clears the stored tokens."
				)
			)
			.addButton((b) => {
				if (this.plugin.graphConnected()) b.setButtonText("Disconnect").onClick(() => this.plugin.disconnectGraph());
				else b.setButtonText("Connect").setCta().onClick(() => void this.plugin.connectGraph());
			});
		section("Processing", "audio");
		new Setting(c)
			.setName("Process new audio automatically")
			.then((s) =>
				help(
					s,
					"On, audio that lands in the capture folder is transcribed and turned into a note on its own. Off means nothing happens until you run Process on a file by hand, which is handy when you want to choose the sections or template first."
				)
			)
			.addToggle((t) => t.setValue(s.autoProcess).onChange((v) => ((s.autoProcess = v), save())));
		new Setting(c)
			.setName("This device's role")
			.setDesc("What this device does with new recordings. Per-device (never synced), so a phone can record while a desktop or home server transcribes.")
			.then((st) =>
				help(
					st,
					"Record and process is the everything device, exactly as before. Record only saves audio and marks it pending; nothing is transcribed on this device (right for phones, tablets, and machines without keys). Processor also watches the vault and claims pending items other devices parked; run it on the machine that holds the keys or the local AI. Queued items show in the status bar, and the command \"Process pending recordings on this device now\" is the manual override from anywhere. Rotated recordings park their part timing in a small .json next to the audio, so a sync service that skips .json files should be set to sync all file types."
				)
			)
			.addDropdown((d) =>
				d
					.addOptions({
						full: "Record and process (default)",
						capture: "Record only (queue for another device)",
						processor: "Processor (handles queued items too)",
					})
					.setValue(s.deviceRole)
					.onChange((v) => ((s.deviceRole = v as DeviceRole), save(), this.plugin.paintQueueStatus()))
			);
		new Setting(c)
			.setName("Audio after processing")
			.setDesc("Keep the recording (embedded in the note), or trash it once the note is written. The transcript is the durable record. Trashing frees space and tightens privacy.")
			.then((s) =>
				help(
					s,
					"Keep embeds the recording in the note and leaves the file in place. Trash moves it to the system trash (recoverable) once the note is written, since the transcript is the lasting record; it saves space and tightens privacy. Only auto-captured audio is ever trashed, never a file you picked by hand."
				)
			)
			.addDropdown((d) =>
				d
					.addOptions({ keep: "Keep the audio", trash: "Move to trash after the note is written" })
					.setValue(s.audioRetention)
					.onChange((v) => ((s.audioRetention = v as "keep" | "trash"), save()))
			);

		section("Custom templates", "audio");
		new Setting(c).setDesc(
			"Named section presets that appear in the Process and Re-extract dialogs, alongside the built-ins. Handy for a recurring meeting type that always needs the same sections."
		);
		for (const [i, tpl] of s.customTemplates.entries()) {
			new Setting(c)
				.setName(tpl.name || "(unnamed)")
				.setDesc(tpl.sections.length ? tpl.sections.join(", ") : "no sections yet, edit below")
				.then((st) => help(st, "A saved section preset. It appears in the Process and Re-extract dialogs so you can apply this exact set of sections in one pick; Edit renames it or changes its sections, and the trash removes it."))
				.addButton((b) =>
					b
						.setButtonText("Edit")
						.onClick(() => new TemplateEditModal(this.app, this.plugin, tpl, () => this.display()).open())
				)
				.addExtraButton((b) =>
					b.setIcon("trash").setTooltip("Delete").onClick(() => {
						s.customTemplates.splice(i, 1);
						save();
						this.display();
					})
				);
		}
		new Setting(c).addButton((b) =>
			b.setButtonText("New template").setCta().onClick(() => {
				const tpl = { name: "New template", sections: ["summary", "actions"] as ExtractionKey[] };
				s.customTemplates.push(tpl);
				save();
				new TemplateEditModal(this.app, this.plugin, tpl, () => this.display()).open();
			})
		);

		section("Transcript corrections", "audio");
		new Setting(c)
			.setName("How corrections work")
			.setDesc("Fixes for misheard names, places, and words. Each is applied to every new transcript automatically, so captures get more accurate over time. Add one from any note with the 'Correct a name or term' command (select the wrong text first), or with Add below.")
			.then((st) =>
				help(
					st,
					"A correction replaces a whole word or name everywhere it appears, so a full invite name like 'Deverakonda Rajasekhar' or a misheard 'Shaker' both become 'Sekhar'. Matching is case-sensitive and whole-word, so a name rule never rewrites an unrelated word. Remove one and new transcripts stop applying it."
				)
			);
		for (const [i, corr] of s.corrections.entries()) {
			new Setting(c)
				.setName(`${corr.from}  →  ${corr.to}`)
				.addExtraButton((b) =>
					b.setIcon("trash").setTooltip("Remove").onClick(() => {
						s.corrections.splice(i, 1);
						save();
						this.display();
					})
				);
		}
		new Setting(c).addButton((b) =>
			b.setButtonText("Add correction").onClick(() =>
				new CorrectionModal(this.app, "", (fromRaw, toRaw) => {
					const from = fromRaw.trim();
					if (!from || from === toRaw.trim()) return;
					s.corrections = s.corrections.filter((cc) => cc.from !== from);
					s.corrections.push({ from, to: toRaw });
					save();
					this.display();
				}).open()
			)
		);

		section("Sharing & privacy", "privacy");
		new Setting(c)
			.setName("Redact sensitive info when sharing")
			.setDesc("Mask matches when you Copy summary or Export to Word. Never changes the note itself. There's also a one-off 'Copy redacted summary' command.")
			.then((s) =>
				help(
					s,
					"Masks matches only when you Copy summary or Export to Word, never in the note itself, so the vault keeps the full text while what leaves your machine is scrubbed. Turning it on reveals which categories to mask. There is also a one-off Copy redacted summary command."
				)
			)
			.addToggle((t) => t.setValue(s.redactShare).onChange((v) => ((s.redactShare = v), save(), this.display())));
		if (s.redactShare) {
			const cat = (name: string, get: () => boolean, set: (v: boolean) => void, hint: string) =>
				new Setting(c)
					.setName(name)
					.then((st) => help(st, hint))
					.addToggle((t) => t.setValue(get()).onChange((v) => (set(v), save())));
			cat("Mask email addresses", () => s.redactEmails, (v) => (s.redactEmails = v), "Replaces anything shaped like an email address with [redacted] in shared copies.");
			cat("Mask phone numbers", () => s.redactPhones, (v) => (s.redactPhones = v), "Replaces phone-number patterns with [redacted] in shared copies.");
			cat("Mask SSNs", () => s.redactSsns, (v) => (s.redactSsns = v), "Replaces US Social Security number patterns with [redacted] in shared copies.");
			cat("Mask card numbers", () => s.redactCards, (v) => (s.redactCards = v), "Replaces long card-number-like digit runs with [redacted] in shared copies.");
			cat("Mask attendee names", () => s.redactAttendees, (v) => (s.redactAttendees = v), "Replaces the meeting's attendee names with [redacted] in shared copies, header included, so a recap can go out without naming who was there.");
			new Setting(c)
				.setName("Also redact these terms")
				.setDesc("Comma-separated names or words to mask (whole-word, case-insensitive).")
				.then((s) =>
					help(
						s,
						"Extra names or words to mask, comma-separated, matched whole-word and case-insensitively so a term never clips the middle of another word. Use it for client names, project code names, or anything else specific to you."
					)
				)
				.addText((t) => t.setPlaceholder("Acme, Project X").setValue(s.redactTerms).onChange((v) => ((s.redactTerms = v), save())));
		}

		section("Ask your vault", "search");
		new Setting(c)
			.setName("Folders to index")
			.setDesc("Comma-separated folders whose notes can be asked about. Use / to index the entire vault; leave empty for just the output folder. Changes re-index automatically.")
			.then((s) =>
				help(
					s,
					"The folders whose notes Ask your vault and the assistant chat can search, comma-separated. Use / for the whole vault, or leave it empty for just the output folder. The index rebuilds itself as you edit, so changes take effect without a restart."
				)
			)
			.addText((t) =>
				t.setValue(s.indexFolders).onChange((v) => {
					s.indexFolders = v;
					save();
					void this.plugin.syncIndex(false);
				})
			);

		section("Semantic search", "search");
		intro("Optional: find notes by meaning, not just keywords, by embedding them through an OpenAI-compatible endpoint. Point it at local Ollama (http://localhost:11434/v1, model nomic-embed-text) to keep everything on your machine, or a hosted provider. Leave the endpoint empty to use keyword search only. Ask and the assistant chat blend keyword and meaning when this is on.");
		new Setting(c)
			.setName("Embeddings endpoint")
			.setDesc("OpenAI-compatible base URL. Empty turns semantic search off.")
			.then((s) =>
				help(
					s,
					"The OpenAI-compatible URL used to turn notes into vectors for meaning-based search. Point it at local Ollama to keep everything on your machine, or a hosted provider. Empty turns semantic search off, and Ask falls back to keyword matching."
				)
			)
			.addText((t) =>
				t.setPlaceholder("http://localhost:11434/v1").setValue(s.embeddingsEndpoint).onChange((v) => ((s.embeddingsEndpoint = v.trim()), save()))
			);
		new Setting(c)
			.setName("Embeddings API key")
			.setDesc("Leave empty for local endpoints like Ollama.")
			.then((s) => help(s, "The key for the embeddings endpoint. Leave it empty for a local server like Ollama that needs none; a hosted provider will require one. Stored locally and sent only to that endpoint."))
			.addText((t) => t.setValue(s.embeddingsKey).onChange((v) => ((s.embeddingsKey = v.trim()), save())));
		new Setting(c)
			.setName("Embeddings model")
			.setDesc("Changing this rebuilds all embeddings (a different model is a different vector space).")
			.then((s) =>
				help(
					s,
					"Which embedding model turns your notes into vectors, for example nomic-embed-text on Ollama. Changing it rebuilds every embedding, because a different model produces a different, incompatible vector space."
				)
			)
			.addText((t) => t.setPlaceholder("nomic-embed-text").setValue(s.embeddingsModel).onChange((v) => ((s.embeddingsModel = v.trim() || "nomic-embed-text"), save())));
		new Setting(c)
			.setName("Test the endpoint")
			.setDesc("Embed one sentence and report the vector size. Every failure here is otherwise silent: search just stays keyword-only with no explanation.")
			.then((st) => help(st, "Sends a single short string to the endpoint and reports what came back. Use it after setting the endpoint or changing the model, before building embeddings over the whole vault."))
			.addButton((b) => b.setButtonText("Test").onClick(() => void this.plugin.verifyEmbeddings()));
		new Setting(c)
			.setName("Build embeddings")
			.setDesc("Embed the indexed notes now (also runs quietly on launch). Re-run after changing the model.")
			.then((s) =>
				help(
					s,
					"Embeds your indexed notes right now instead of waiting for the quiet pass that runs on launch. Use it after you first set an endpoint or change the model, so meaning-based search covers everything."
				)
			)
			.addButton((b) =>
				b.setButtonText("Build now").onClick(() => {
					if (!this.plugin.semanticEnabled()) {
						new Notice("Power Assistant: set an embeddings endpoint first.");
						return;
					}
					void this.plugin.syncEmbeddings(true);
				})
			);

		section("Last edited, on the page", "notes");
		// Said up front rather than as a footnote on each row: with Power Editor
		// installed these three settings change nothing, and a setting that
		// silently does nothing is worse than one that says why.
		intro(
			this.plugin.editedStampMine()
				? "A quiet \"Edited 3 minutes ago\" line on the note itself, read from the file's own modified time. A note's own `updated:` (or `modified:`) property wins over that where it exists, which matters in a synced vault: the sync client can rewrite a file's modified time when a note arrives from another device and make it look freshly edited."
				: "Power Editor is installed, and it draws this line, so these settings are not in use here. Power Editor's own copy of them is what to change. They take over again if it is ever removed."
		);
		new Setting(c)
			.setName("Show when the note was last edited")
			.setDesc("A quiet line under the note's title: “Edited 3 minutes ago”. Click it to swap between the relative time and the exact date.")
			.addDropdown((d) =>
				d
					.addOption("labeled", "Yes, with the word Edited")
					.addOption("bare", "Yes, just the time")
					.addOption("off", "Off")
					.setValue(s.showEdited)
					.onChange((v) => {
						s.showEdited = v as PowerAssistantSettings["showEdited"];
						save();
						this.plugin.refreshEditedStamps();
					})
			)
			.then((st) =>
				help(
					st,
					"Reads the file's own modified time, so it is right without you maintaining anything. If a note has an `updated:` (or `modified:`) property in its frontmatter, that wins instead — useful in a synced vault, where the sync client can rewrite the file's modified time when a note arrives from another device and make it look freshly edited."
				)
			);
		new Setting(c)
			.setName("Where to show it")
			.setDesc("Under the note's title, at the very end of the note, or in both places.")
			.addDropdown((d) =>
				d
					.addOption("title", "Under the title")
					.addOption("rule", "Under the title, with a line above it")
					.addOption("bottom", "At the end of the note")
					.addOption("both", "Both")
					.setValue(s.editedPosition)
					.onChange((v) => {
						s.editedPosition = v as PowerAssistantSettings["editedPosition"];
						save();
						this.plugin.refreshEditedStamps();
					})
			)
			.then((st) =>
				help(
					st,
					"Under the title is the Notion habit: you see it as you arrive. The line variant is the same spot pulled tight against the title with a hairline drawn between them, so the title and the date read as one page header instead of as two stray lines above your first paragraph. At the end is closer to 1Password, where the detail sits out of the way until you go looking. Both is fine on long notes, where the title has scrolled away by the time you wonder."
				)
			);
		new Setting(c)
			.setName("Time format")
			.setDesc("How the time itself reads.")
			.addDropdown((d) =>
				d
					.addOption("relative", "Relative (3 minutes ago)")
					.addOption("exact", "Exact date and time")
					.addOption("both", "Relative, then the exact date")
					.setValue(s.editedFormat)
					.onChange((v) => {
						s.editedFormat = v as PowerAssistantSettings["editedFormat"];
						save();
						this.plugin.refreshEditedStamps();
					})
			)
			.then((st) =>
				help(
					st,
					"Relative answers 'is this stale?' at a glance; exact answers 'which version is this?'. Whichever you pick, clicking the stamp shows both for that note until you click it again, and hovering always shows the exact time."
				)
			);

		const setVisible = (el: HTMLElement, v: boolean) => (el.style.display = v ? "" : "none");
		const applyView = () => {
			const q = this.query.trim().toLowerCase();
			setVisible(tabBar, !q);
			for (const sec of Array.from(body.children) as HTMLElement[]) {
				const items = Array.from(sec.querySelectorAll(":scope > .setting-item:not(.setting-item-heading)")) as HTMLElement[];
				if (!q) {
					for (const it of items) setVisible(it, true);
					const mine = sec.dataset.tab === this.activeTab;
					setVisible(sec, mine);
					// a collapsed section shows its heading and nothing else, so a
					// tab reads as a short list of topics rather than a wall of rows
					if (mine) sec.toggleClass("ptc-collapsed", !isExpanded(sec.dataset.name ?? "", sec.dataset.tab ?? ""));
					continue;
				}
				// a search reaches into collapsed sections too: folding a topic away
				// must never mean losing the ability to find what is inside it
				sec.removeClass("ptc-collapsed");
				// a heading-name match reveals the whole section; otherwise match each row
				const nameHit = (sec.dataset.name ?? "").includes(q);
				let anyHit = false;
				for (const it of items) {
					const name = it.querySelector(".setting-item-name")?.textContent?.toLowerCase() ?? "";
					const desc = it.querySelector(".setting-item-description")?.textContent?.toLowerCase() ?? "";
					const hit = nameHit || name.includes(q) || desc.includes(q);
					setVisible(it, hit);
					if (hit) anyHit = true;
				}
				setVisible(sec, anyHit);
			}
		};

		for (const t of TABS) {
			const btn = tabBar.createEl("button", { text: t.label, cls: "ptc-settings-tab" });
			btn.toggleClass("is-active", t.id === this.activeTab);
			btn.onclick = () => {
				if (this.activeTab === t.id) return;
				this.activeTab = t.id;
				for (const other of Array.from(tabBar.children) as HTMLElement[]) other.toggleClass("is-active", other === btn);
				applyView();
			};
		}

		searchInput.addEventListener("input", () => {
			this.query = searchInput.value;
			applyView();
		});

		applyView();
	}
}
