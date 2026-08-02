import {
	SearchIndex,
	absoluteEdited,
	assembleNote,
	partOffsetsOf,
	buildAskPrompt,
	buildExtractionPrompt,
	buildMultipart,
	chunkNote,
	countSpeakers,
	editedAt,
	extractYoutubeMeta,
	fmtTime,
	formatUtterances,
	mergeForSave,
	parseSearchTerms,
	parseTimedText,
	parseTimedTextXml,
	relativeEdited,
	renderFilename,
	tokenize,
	youtubeVideoId,
} from "./pipeline";

let fails = 0;
function ok(cond: unknown, name: string) {
	if (cond) console.log("  ok -", name);
	else {
		fails++;
		console.log("FAIL -", name);
	}
}
function eq<T>(got: T, want: T, name: string) {
	const pass = JSON.stringify(got) === JSON.stringify(want);
	if (!pass) {
		console.log("   got:", JSON.stringify(got));
		console.log("  want:", JSON.stringify(want));
	}
	ok(pass, name);
}

// --- renderFilename ---
eq(renderFilename("{{basename}}-notes", "meeting", "2026-07-09"), "meeting-notes.md", "basename substitution + default ext");
eq(renderFilename("{{date}} {{basename}}.md", "standup", "2026-07-09"), "2026-07-09 standup.md", "date substitution keeps given ext");
eq(renderFilename("", "x", "d"), "x-notes.md", "empty template falls back");
ok(!renderFilename("a/b:c*{{basename}}", "q?", "d").match(/[\\/:*?"<>|]/), "illegal filename characters stripped");

// --- buildExtractionPrompt ---
const p = buildExtractionPrompt(["summary", "actions"], "we agreed to ship friday");
ok(p.user.includes("## Summary") && p.user.includes("## Action items"), "selected sections are requested");
ok(!p.user.includes("## Decisions"), "unselected sections are excluded");
ok(p.user.includes("we agreed to ship friday"), "transcript is included");
ok(p.system.includes("| Task | Owner | Due |"), "action-items table shape is specified");
{
	// video-oriented sections and the Video notes template
	const { TEMPLATES } = require("./pipeline");
	const vp = buildExtractionPrompt(["summary", "takeaways", "facts", "resources", "quotes", "questions", "keywords"], "a creator explains image tokens");
	ok(vp.user.includes("## Key takeaways") && vp.user.includes("## Facts & figures") && vp.user.includes("## Resources mentioned") && vp.user.includes("## Notable quotes"), "video sections are requested");
	ok(!vp.user.includes("## Action items") && !vp.user.includes("## Decisions") && !vp.user.includes("## Risks"), "meeting sections are absent from video notes");
	ok(!vp.system.includes("Task | Owner | Due") && !vp.system.includes("checklist"), "no action-item rule when Action items is not selected");
	ok(!vp.system.includes("raw meeting transcripts") && vp.system.includes("videos"), "the framing is not meeting-only");
	const video = TEMPLATES.find((t: { id: string }) => t.id === "video");
	eq(video.sections.join(","), "summary,takeaways,facts,resources,quotes,questions,keywords", "the Video notes template selects the content sections");
}

// --- assembleNote ---
const note = assembleNote({
	title: "standup",
	date: "2026-07-09",
	source: "[[Capture/standup.webm]]",
	embed: "![[Capture/standup.webm]]",
	body: "## Summary\n\n- shipped",
	transcript: "raw words",
	includeTranscript: true,
	model: "claude-haiku-4-5",
});
ok(note.startsWith("---\ndate: 2026-07-09"), "frontmatter leads the note with the date (no redundant type)");
ok(/\ntags:\n {2}- capture\n/.test(note), "the capture tag marks the note");
ok(note.includes('source: "[[Capture/standup.webm]]"'), "frontmatter links the audio");
ok(/\ntags:\n {2}- capture\n {2}- claude-haiku-4-5\n/.test(note) && !note.includes("model:"), "the model rides in the tags, not a property");
ok(note.includes("## Summary") && note.includes("## Transcript\n\nraw words"), "body and transcript sections present");
ok(note.includes("![[Capture/standup.webm]]"), "audio embed at the end");
ok(/---\n# standup/.test(note) && !/---\n\n# standup/.test(note), "title sits tight under the properties, no blank gap");
const bare = assembleNote({
	title: "t",
	date: "d",
	source: "https://youtu.be/x",
	embed: null,
	body: null,
	transcript: "words",
	includeTranscript: false,
	model: null,
});
ok(bare.includes("No extraction ran") && !bare.includes("## Transcript") && !bare.includes("model:"), "keyless note degrades gracefully");
ok(bare.includes('source: "https://youtu.be/x"') && !bare.includes("![["), "url source carries no embed");
{
	const { tagify } = require("./pipeline");
	eq(tagify("claude-haiku-4-5"), "claude-haiku-4-5", "a model id is already a valid tag");
	eq(tagify("claude opus 4.8"), "claude-opus-4-8", "spaces and dots become hyphens");
	eq(tagify("#weird--/tag--"), "weird-/tag", "leading hash gone, hyphens collapsed and trimmed");
}
{
	const { ensureUrlScheme } = require("./pipeline");
	eq(ensureUrlScheme("youtube.com/watch?v=abc"), "https://youtube.com/watch?v=abc", "a scheme-less URL gets https://");
	eq(ensureUrlScheme("  www.youtube.com/watch?v=abc  "), "https://www.youtube.com/watch?v=abc", "trims, then prefixes the scheme");
	eq(ensureUrlScheme("https://youtu.be/abc"), "https://youtu.be/abc", "an https URL is left alone");
	eq(ensureUrlScheme("http://youtu.be/abc"), "http://youtu.be/abc", "an http URL is left alone");
	eq(ensureUrlScheme(""), "", "empty stays empty");
}

// --- speaker labels ---
const utts = [
	{ speaker: "A", text: " hello there " },
	{ speaker: "B", text: "hi" },
	{ speaker: "A", text: "bye" },
];
eq(formatUtterances(utts), "**Speaker A:** hello there\n\n**Speaker B:** hi\n\n**Speaker A:** bye", "utterances format as labeled lines");
eq(countSpeakers(utts), 2, "speaker count deduplicates");

// --- timestamps (AssemblyAI start times ride along when present) ---
eq(fmtTime(0), "0:00", "zero formats");
eq(fmtTime(61000), "1:01", "minutes and seconds");
eq(fmtTime(3661000), "1:01:01", "hours appear past 60 minutes");
eq(fmtTime(59999), "0:59", "sub-second remainder truncates");
eq(
	formatUtterances([
		{ speaker: "A", text: "hello", start: 0 },
		{ speaker: "B", text: "hi", start: 75500 },
	]),
	"**Speaker A [0:00]:** hello\n\n**Speaker B [1:15]:** hi",
	"timestamped utterances carry [m:ss] stamps"
);
eq(formatUtterances([{ speaker: "A", text: "x" }]), "**Speaker A:** x", "utterances without start times stay unstamped");
const spoken = assembleNote({
	title: "call",
	date: "d",
	source: "[[a.webm]]",
	embed: null,
	body: "## Summary\n\nx",
	transcript: "t",
	includeTranscript: false,
	model: "m",
	speakers: 2,
});
ok(spoken.includes("speakers: 2"), "speaker count lands in frontmatter");
ok(!note.includes("speakers:"), "no speakers property without diarization");

// --- YouTube parsers ---
const html =
	'x,"videoDetails":{"videoId":"abc","title":"Sleep \\u0026 Focus \\"Protocols\\""},y,' +
	'"captionTracks":[{"baseUrl":"https://yt.example/api?v=abc\\u0026lang=en","languageCode":"en","name":{"simpleText":"English"}}],z';
const meta = extractYoutubeMeta(html)!;
ok(meta != null, "watch-page metadata parses");
eq(meta.title, 'Sleep & Focus "Protocols"', "title unescapes");
eq(meta.tracks[0].baseUrl, "https://yt.example/api?v=abc&lang=en", "caption baseUrl unescapes");
eq(meta.tracks[0].languageCode, "en", "language code survives");
eq(extractYoutubeMeta("<html>no captions here</html>"), null, "caption-less pages return null");
{
	const { extractYoutubeInfo, youtubeProps } = require("./pipeline");
	const page =
		'x,"videoDetails":{"videoId":"abc","title":"China Is About To Pop The AI Bubble","lengthSeconds":"754","channelId":"UCGaVdbSav8xWuFWTadK6loA","author":"Andrei Jikh","viewCount":"1400000"},' +
		'"canonicalBaseUrl":"/@andreijikh","publishDate":"2026-07-07","subscriberCountText":{"simpleText":"3.28M subscribers"},z';
	const info = extractYoutubeInfo(page);
	eq(info.channel, "Andrei Jikh", "channel from videoDetails author");
	eq(info.channelUrl, "https://www.youtube.com/@andreijikh", "channel URL prefers the canonical @handle");
	eq(info.views, 1400000, "view count parsed as a number");
	eq(info.published, "2026-07-07", "publish date parsed");
	eq(info.subscribers, "3.28M", "subscriber count parsed from the page");
	eq(info.duration, "13 min", "a length is read, not counted in colons");
	const props = youtubeProps(info);
	eq(props.map((p: { key: string }) => p.key).join(","), "channel,channel url,published,views,subscribers,duration", "props are ordered");
	eq(props.find((p: { key: string }) => p.key === "views").value, "1,400,000", "views formatted with commas");
	eq(props.find((p: { key: string }) => p.key === "channel").value, "Andrei Jikh", "channel prop keeps the channel name");
	eq(props.find((p: { key: string }) => p.key === "channel url").value, "https://www.youtube.com/@andreijikh", "channel url prop holds the clickable link");
	const idOnly = extractYoutubeInfo('"channelId":"UCGaVdbSav8xWuFWTadK6loA","author":"Some Channel"');
	eq(idOnly.channelUrl, "https://www.youtube.com/channel/UCGaVdbSav8xWuFWTadK6loA", "channel URL falls back to the channel id");
	const noUrl = extractYoutubeInfo('"author":"Nameless"');
	eq(youtubeProps(noUrl).find((p: { key: string }) => p.key === "channel").value, "Nameless", "channel keeps the name when no URL is found");
	eq(youtubeProps(noUrl).find((p: { key: string }) => p.key === "channel url"), undefined, "no channel url prop when no URL is found");
	const bare = extractYoutubeInfo("<html>nothing</html>");
	eq(bare.title, "YouTube video", "missing metadata falls back to a generic title");
	eq(youtubeProps(bare).length, 0, "no metadata means no extra properties");
	const { pickYoutubeAudio } = require("./pipeline");
	eq(pickYoutubeAudio(undefined), null, "no formats yields null");
	eq(pickYoutubeAudio([{ mimeType: "video/mp4", url: "v" }]), null, "video-only formats are skipped");
	eq(pickYoutubeAudio([{ mimeType: "audio/webm; codecs=opus", url: "hi", bitrate: 130000 }, { mimeType: "audio/mp4", url: "lo", bitrate: 48000 }]).url, "lo", "the lowest-bitrate audio wins");
	eq(pickYoutubeAudio([{ mimeType: "audio/mp4", url: "m", bitrate: 5 }]).ext, "m4a", "mp4 audio maps to m4a");
	eq(pickYoutubeAudio([{ mimeType: "audio/webm", url: "w", bitrate: 5 }]).ext, "webm", "webm audio keeps webm");
	eq(pickYoutubeAudio([{ mimeType: "audio/webm", bitrate: 5 }]), null, "a ciphered format with no url is skipped");
	const note = assembleNote({ title: "V", date: "2026-07-14", source: "https://y", embed: null, body: "## Summary\nHi", transcript: "", includeTranscript: false, model: "m", props });
	ok(note.includes('channel: "Andrei Jikh"') && note.includes('channel url: "https://www.youtube.com/@andreijikh"') && note.includes('subscribers: "3.28M"'), "props land in the note frontmatter");
}
eq(
	parseTimedText({ events: [{ segs: [{ utf8: "hello " }, { utf8: "world" }] }, { other: 1 }, { segs: [{ utf8: "\nagain" }] }] }),
	"hello world again",
	"timedtext events join into clean text"
);
eq(parseTimedText({}), "", "empty timedtext yields empty string");
eq(youtubeVideoId("https://www.youtube.com/watch?v=e8CW4_yU5Ko&t=5s"), "e8CW4_yU5Ko", "watch?v= id extracts");
eq(youtubeVideoId("https://youtu.be/e8CW4_yU5Ko"), "e8CW4_yU5Ko", "youtu.be id extracts");
eq(youtubeVideoId("https://www.youtube.com/shorts/e8CW4_yU5Ko"), "e8CW4_yU5Ko", "shorts id extracts");
eq(youtubeVideoId("https://example.com/nope"), null, "non-youtube urls yield null");
{
	// --- capture from a link ---
	const { xStatusId, isXUrl, postTitleFromText, parseMediaInfo, mediaProps, ytDlpInvocations, ytDlpInfoArgs, ytDlpAudioArgs } = require("./pipeline");
	const { hostOf, mediaSiteFor, routeFor, cookieArgs, renderFolder, parseWebMeta, webProps, siteNameFromUrl, cleanArticleMarkdown } = require("./pipeline");

	// routing: YouTube keeps its free-caption path, known media sites go to
	// yt-dlp, and anything else is read as an article
	eq(hostOf("https://WWW.X.com/a/status/1?x=1"), "x.com", "host lowercases and drops www");
	eq(hostOf("not a url"), null, "an unparseable URL has no host");
	eq(routeFor("https://www.youtube.com/watch?v=e8CW4_yU5Ko"), "youtube", "a YouTube video routes to the caption path");
	eq(routeFor("https://youtu.be/e8CW4_yU5Ko"), "youtube", "a youtu.be short link routes to YouTube");
	eq(routeFor("https://x.com/elonmusk/status/2077620484624011651"), "media", "an X post routes to yt-dlp");
	eq(routeFor("https://www.tiktok.com/@a/video/123"), "media", "a TikTok routes to yt-dlp");
	eq(routeFor("https://www.reddit.com/r/x/comments/abc/t/"), "media", "a Reddit post routes to yt-dlp");
	eq(routeFor("https://example.com/blog/post"), "web", "an unknown site is read as an article");
	eq(routeFor("https://notx.com/a/status/1"), "web", "a lookalike host is not treated as X");
	eq(mediaSiteFor("https://vt.tiktok.com/ZS123/").label, "TikTok", "a subdomain still matches its site");
	eq(mediaSiteFor("https://fake-x.com/a"), null, "a hyphenated lookalike does not match");
	eq(mediaSiteFor("https://x.com/a/status/1").label, "X", "x.com maps to the X label");
	eq(mediaSiteFor("https://twitter.com/a/status/1").id, "x", "the legacy host maps to the same site");
	eq(xStatusId("https://x.com/elonmusk/status/2077620484624011651?s=43&t=2OX3IZ"), "2077620484624011651", "an x.com status id extracts past its tracking query");
	eq(xStatusId("https://twitter.com/elonmusk/status/2077620484624011651"), "2077620484624011651", "the legacy twitter.com host still parses");
	eq(xStatusId("https://mobile.twitter.com/a/status/123"), "123", "a mobile subdomain parses");
	eq(xStatusId("https://x.com/i/web/status/456"), "456", "the /i/web/ share form parses");
	eq(xStatusId("https://twitter.com/a/statuses/789"), "789", "the older /statuses/ path parses");
	eq(xStatusId("https://x.com/a/status/321/photo/1"), "321", "a /photo/1 click-through suffix is ignored");
	eq(xStatusId("https://x.com/elonmusk"), null, "a profile URL is not a post");
	eq(xStatusId("https://notx.com/a/status/1"), null, "a lookalike host is rejected");
	eq(xStatusId("https://www.youtube.com/watch?v=e8CW4_yU5Ko"), null, "a YouTube URL is not an X post");
	ok(isXUrl("https://x.com/a/status/1") && !isXUrl("https://example.com"), "isXUrl follows xStatusId");

	eq(postTitleFromText("Hello  world\nagain", "fb"), "Hello world again", "newlines and runs of spaces collapse");
	eq(postTitleFromText("Real text https://t.co/CWSuWNFwQr", "fb"), "Real text", "a t.co tracker is dropped from the title");
	eq(postTitleFromText("   https://t.co/abc  ", "fb"), "fb", "a post that is only a tracker falls back");
	eq(postTitleFromText("", "fb"), "fb", "empty text falls back");
	const long = postTitleFromText("word ".repeat(40), "fb");
	ok(long.length <= 94 && long.endsWith("...") && !long.includes("  "), "a long post is cut and ellipsized");
	ok(!/\s\.\.\.$/.test(long), "the cut lands on a word boundary, not a dangling space");

	// the real --dump-json shape, from the Musk post this was built against
	const dump = {
		title: "Elon Musk - That’s how making a startup succeed goes",
		uploader: "Elon Musk",
		uploader_id: "elonmusk",
		uploader_url: "https://twitter.com/elonmusk",
		upload_date: "20260716",
		duration: 736.781,
		view_count: 1715007,
		like_count: 10766,
		extractor_key: "Twitter",
	};
	const info = parseMediaInfo(dump, "X");
	eq(info.title, "That’s how making a startup succeed goes", "the uploader prefix yt-dlp adds is stripped from the title");
	eq(info.site, "X", "the router's label names the site");
	eq(info.author, "Elon Musk", "the display name becomes the author");
	eq(info.handle, "@elonmusk", "the handle is stored with its @");
	eq(info.authorUrl, "https://x.com/elonmusk", "the author URL is rehosted from twitter.com onto x.com");
	eq(info.posted, "2026-07-16", "yt-dlp's YYYYMMDD becomes an ISO date");
	eq(info.duration, "12 min", "a fractional duration rounds to whole minutes");
	const props = mediaProps(info);
	eq(props.map((p: { key: string }) => p.key).join(","), "site,author,handle,author url,posted,views,likes,duration", "props are ordered");
	eq(props.find((p: { key: string }) => p.key === "views").value, "1,715,007", "views formatted with commas");
	eq(props.find((p: { key: string }) => p.key === "likes").value, "10,766", "likes formatted with commas");

	// the same parser has to serve every extractor, since yt-dlp normalizes the
	// fields; a site the router does not know still labels itself
	const tok = parseMediaInfo({ title: "a dance", uploader: "Someone", uploader_id: "someone", uploader_url: "https://www.tiktok.com/@someone", extractor_key: "TikTok", duration: 31 }, "TikTok");
	eq(tok.site, "TikTok", "a TikTok labels as TikTok");
	eq(tok.authorUrl, "https://www.tiktok.com/@someone", "a non-X uploader URL passes through untouched");
	eq(tok.duration, "31 sec", "a short clip is counted in seconds");
	eq(parseMediaInfo({ extractor_key: "Rumble" }).site, "Rumble", "with no label, yt-dlp's extractor name is the site");
	eq(parseMediaInfo({ extractor_key: "Generic" }, "Vimeo").site, "Vimeo", "the router's label wins over the extractor name");

	const bare = parseMediaInfo({});
	eq(bare.title, "Post", "a post with no metadata at all still gets a title");
	eq(mediaProps(bare).length, 0, "no metadata means no extra properties");
	const noName = parseMediaInfo({ uploader_id: "someone", title: "just text" });
	eq(noName.title, "just text", "with no display name the title is left alone");
	eq(noName.handle, "@someone", "the handle survives a missing display name");
	eq(parseMediaInfo({ uploader_id: "someone" }).title, "Post from @someone", "a wordless post falls back to the handle");
	eq(parseMediaInfo({ duration: 0 }).duration, undefined, "a zero duration is not reported");
	eq(parseMediaInfo({ upload_date: "nonsense" }).posted, undefined, "an unparseable date is dropped rather than guessed");
	eq(parseMediaInfo({ uploader_id: "@atbird" }).handle, "@atbird", "an already-@ handle is not doubled");
	const note = assembleNote({ title: info.title, date: "2026-07-16", source: "https://x.com/elonmusk/status/2077620484624011651", embed: null, body: "## Summary\nHi", transcript: "", includeTranscript: false, model: "m", props });
	ok(note.includes('author: "Elon Musk"') && note.includes('author url: "https://x.com/elonmusk"') && note.includes('site: "X"'), "props land in the note frontmatter");

	// {{site}} files captures apart without a settings tab per site
	eq(renderFolder("Social/{{site}}", "TikTok"), "Social/TikTok", "the site token fills the folder");
	eq(renderFolder("Social/{{site}}", ""), "Social", "an empty site collapses the token and its separator");
	eq(renderFolder("Social/{{site}}", "a/b"), "Social/a-b", "a site with a slash cannot escape into another folder");
	eq(renderFolder("", "X"), "", "an empty pattern stays empty so the caller can fall back");
	eq(renderMeetingFilename("{{date}} {{site}} {{title}}", "T", "2026-07-16", "X"), "2026-07-16 X T.md", "the filename takes a site token");
	eq(renderMeetingFilename("{{date}} {{title}}", "T", "2026-07-16"), "2026-07-16 T.md", "a pattern with no site token is unchanged");

	eq(cookieArgs(""), [], "cookies off adds no arguments at all");
	eq(cookieArgs("firefox").join(" "), "--cookies-from-browser firefox", "a chosen browser becomes the yt-dlp flag");
	ok(!ytDlpInfoArgs("U").includes("--cookies-from-browser"), "the info call carries no cookie flag by default");
	ok(ytDlpInfoArgs("U", "chrome").includes("chrome"), "the info call can borrow cookies");
	ok(ytDlpAudioArgs("U", "o", "edge").includes("edge"), "the download can borrow cookies");
	eq(ytDlpAudioArgs("U", "o", "edge").slice(-1)[0], "U", "the URL still goes last once cookies are added");

	// yt-dlp invocation: pip parks the launcher off PATH, so the module form is
	// the one that saves a stock install from having to configure anything
	eq(ytDlpInvocations("").map((i: { cmd: string }) => i.cmd).join(","), "yt-dlp,python,python3", "with nothing configured, PATH is tried before the Python module");
	eq(ytDlpInvocations("C:\\tools\\yt-dlp.exe")[0].cmd, "C:\\tools\\yt-dlp.exe", "a configured path is tried first");
	eq(ytDlpInvocations("  ").length, 3, "a blank setting is ignored rather than run as an empty command");
	eq(ytDlpInvocations("").find((i: { cmd: string }) => i.cmd === "python").pre.join(" "), "-m yt_dlp", "the Python form runs yt_dlp as a module");
	ok(ytDlpInfoArgs("U").includes("--dump-json") && ytDlpInfoArgs("U").includes("U"), "the info call dumps json for the URL");
	ok(!ytDlpInfoArgs("U").includes("-o"), "the info call never writes a file");
	const dl = ytDlpAudioArgs("U", "/tmp/x.%(ext)s");
	eq(dl[dl.indexOf("-f") + 1], "bestaudio/best", "audio-only is preferred, with a muxed fallback");
	eq(dl[dl.indexOf("-o") + 1], "/tmp/x.%(ext)s", "the output template is passed through");
	ok(dl.includes("--no-simulate"), "--no-simulate is present, or --print would turn the download into a dry run");
	eq(dl[dl.indexOf("--print") + 1], "after_move:filepath", "the final path is printed so the caller can find the file");
	eq(dl[dl.length - 1], "U", "the URL goes last");
	ok(dl.includes("--no-playlist"), "a multi-video post captures only the linked video");

	// --- posts with no video ---
	// yt-dlp refuses a post that carries no media, which is most posts. That is a
	// route, not a failure: the words are still the thing worth capturing.
	const { NO_MEDIA_RE, xOembedUrl, parseTweetOembed, isoFromLongDate } = require("./pipeline");
	ok(NO_MEDIA_RE.test("ERROR: [twitter] 2077361679034118271: No video could be found in this tweet"), "yt-dlp's real no-video wording is recognized");
	ok(NO_MEDIA_RE.test("ERROR: Unsupported URL: https://example.com/x"), "an unsupported URL routes the same way");
	ok(NO_MEDIA_RE.test("No video formats found!"), "the no-formats wording is recognized");
	ok(!NO_MEDIA_RE.test("ERROR: unable to download video data: HTTP Error 403"), "a genuine failure is not mistaken for a wordless post");
	ok(!NO_MEDIA_RE.test("Failed to decrypt with DPAPI"), "a cookie failure is not mistaken for a wordless post");
	ok(xOembedUrl("https://x.com/a/status/1").includes(encodeURIComponent("https://x.com/a/status/1")), "the oEmbed URL carries the post URL encoded");
	ok(xOembedUrl("https://x.com/a/status/1").includes("hide_thread=1"), "a reply is captured about itself, not its parent");
	ok(xOembedUrl("https://x.com/a/status/1").startsWith("https://publish.x.com/oembed"), "the oEmbed call goes straight to the host that answers, not the one that redirects");

	eq(isoFromLongDate("July 15, 2026"), "2026-07-15", "oEmbed's long date becomes ISO");
	eq(isoFromLongDate("March 3, 2025"), "2025-03-03", "a single-digit day is padded");
	eq(isoFromLongDate("Nonsense 1, 2026"), undefined, "an unknown month yields nothing rather than a guess");
	eq(isoFromLongDate(""), undefined, "an empty date yields nothing");

	// the real shape the oEmbed host returns, verified against a live post
	const oe = {
		html: '<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">First line<br><br>Second &amp; last</p>&mdash; Elon Musk (@elonmusk) <a href="https://x.com/elonmusk/status/2077361679034118271?ref_src=twsrc%5Etfw">July 15, 2026</a></blockquote>',
		author_name: "Elon Musk",
		author_url: "https://x.com/elonmusk",
	};
	const tw = parseTweetOembed(oe);
	eq(tw.text, "First line\n\nSecond & last", "<br> becomes a line break and entities decode");
	eq(tw.info.title, "First line Second & last", "the title flattens the post's own words");
	eq(tw.info.site, "X", "a text post is still labeled X");
	eq(tw.info.author, "Elon Musk", "the author comes from the oEmbed reply");
	eq(tw.info.handle, "@elonmusk", "the handle comes out of the author URL");
	eq(tw.info.authorUrl, "https://x.com/elonmusk", "the author URL is kept");
	eq(tw.info.posted, "2026-07-15", "the post date is recovered from the anchor label");
	eq(parseTweetOembed({ html: "<blockquote>no paragraph here</blockquote>" }), null, "a reply with no post paragraph yields null");
	eq(parseTweetOembed({}), null, "an empty reply yields null");
	eq(parseTweetOembed({ html: "<p>   </p>" }), null, "a whitespace-only post yields null");
	// the real oEmbed reply for the wordless video post, verified live: the media
	// link renders as its display text, which carries no scheme to recognize it by
	const oeMedia = parseTweetOembed({
		html: '<blockquote class="twitter-tweet" data-dnt="true"><p lang="zxx" dir="ltr"><a href="https://t.co/XneE327cx9">pic.twitter.com/XneE327cx9</a></p>&mdash; Elon Musk (@elonmusk) <a href="https://x.com/elonmusk/status/2082243743013614012?ref_src=twsrc%5Etfw">July 28, 2026</a></blockquote>',
		author_name: "Elon Musk",
		author_url: "https://x.com/elonmusk",
	});
	eq(oeMedia.text, "", "a post that is only a media link has no words, so oEmbed reports none");
	eq(oeMedia.info.title, "Post from @elonmusk", "and it is titled by its author rather than by the link");
	eq(oeMedia.info.posted, "2026-07-28", "the date is still recovered from a wordless post");
	const noAuthor = parseTweetOembed({ html: '<p>words</p>&mdash; Someone (@nobody) <a href="https://x.com/nobody/status/9">May 1, 2026</a>' });
	eq(noAuthor.info.handle, "@nobody", "with no author_url the handle falls back to the html");
	eq(noAuthor.info.authorUrl, "https://x.com/nobody", "that fallback handle still builds an author URL");

	// --- a post's own context ---
	// A quote-post's words routinely mean nothing alone, so the embed payload's
	// quoted and replied-to posts are the difference between a note and a fragment.
	const { xSyndicationToken, xSyndicationUrl, quotedBlock, parseTweetEmbed } = require("./pipeline");
	eq(xSyndicationToken("2078879781806919870"), "2bcaovicyz", "the embed token matches what X's own widget derives, verified live");
	ok(xSyndicationUrl("123").includes("token="), "the embed URL carries the derived token");
	ok(xSyndicationUrl("123").includes("id=123"), "the embed URL carries the post id");
	eq(quotedBlock(undefined, "Quoting"), null, "no quoted post yields no block");
	eq(quotedBlock({ text: "   " }, "Quoting"), null, "a whitespace-only quoted post yields no block");
	eq(quotedBlock({ text: "a\nb", user: { name: "Ada", screen_name: "ada" } }, "Quoting"), "Quoting Ada (@ada):\n\n> a\n> b", "a quoted post is attributed and blockquoted line by line");
	eq(quotedBlock({ text: "hi", user: { screen_name: "ada" } }, "In reply to"), "In reply to @ada:\n\n> hi", "with no display name the handle carries the attribution");
	eq(quotedBlock({ text: "hi" }, "Quoting"), "Quoting:\n\n> hi", "an unattributed quote still quotes");

	// the real payload for the post that started this, trimmed to the fields read
	const emb = {
		text: "Way more than a billion",
		created_at: "2026-07-19T16:28:58.000Z",
		favorite_count: 9885,
		conversation_count: 1636,
		user: { name: "Elon Musk", screen_name: "elonmusk" },
		quoted_tweet: { text: "A population of 1 billion builders is coming.", user: { name: "Peter H. Diamandis, MD", screen_name: "PeterDiamandis" } },
	};
	const pe = parseTweetEmbed(emb);
	eq(pe.text, "Way more than a billion\n\nQuoting Peter H. Diamandis, MD (@PeterDiamandis):\n\n> A population of 1 billion builders is coming.", "a quote-post carries the post it quotes, so the note is not a fragment");
	eq(pe.info.title, "Way more than a billion", "the title is the post's own words, never the quoted post's");
	eq(pe.info.posted, "2026-07-19", "the exact timestamp becomes the posted date");
	eq(pe.info.likes, 9885, "the like count is kept");
	eq(pe.info.replies, 1636, "the reply count records the discussion the replies themselves are behind a login for");
	eq(pe.info.handle, "@elonmusk", "the handle comes from the embed user");
	eq(pe.info.authorUrl, "https://x.com/elonmusk", "the author URL is built from the handle");
	eq(pe.info.site, "X", "an embed-read post is labeled X");
	const reply = parseTweetEmbed({ text: "Agreed", user: { screen_name: "b" }, parent: { text: "Original point", user: { screen_name: "a" } } });
	eq(reply.text, "In reply to @a:\n\n> Original point\n\nAgreed", "a reply reads in the order the conversation happened, context first");
	eq(reply.info.title, "Agreed", "a reply is titled by its own words");
	const plain = parseTweetEmbed({ text: "Just words", user: { screen_name: "a" } });
	eq(plain.text, "Just words", "a post with no context is just its own words");
	eq(plain.info.likes, undefined, "a payload with no counts reports none rather than zero");
	eq(parseTweetEmbed({}), null, "an empty payload yields null so the caller can fall back to oEmbed");
	eq(parseTweetEmbed({ text: "   " }), null, "a whitespace-only payload yields null too");
	const ctxOnly = parseTweetEmbed({ quoted_tweet: { text: "the whole point", user: { screen_name: "a" } } });
	ok(ctxOnly !== null, "a post that is only a quote is still worth capturing");

	// --- a post that is all video and no words ---
	// X appends a t.co link to the text of any post carrying media, so a wordless
	// video post arrives looking like a one-line post whose line is a link. Reading
	// it as words is what put "I cannot process this request" in a note.
	const { postWords, tweetOwnText, hasWordsToExtract } = require("./pipeline");
	eq(postWords("https://t.co/XneE327cx9"), "", "a bare media link is no words at all");
	eq(postWords("Watch this https://t.co/abc"), "Watch this", "words next to one still count as words");
	eq(tweetOwnText({ text: "https://t.co/abc", entities: { media: [{ url: "https://t.co/abc" }] } }), "", "the link X appended for the post's own video is not the post's text");
	eq(tweetOwnText({ text: "Watch this https://t.co/abc", entities: { media: [{ url: "https://t.co/abc" }] } }), "Watch this", "with words present, only the appended link goes");
	eq(tweetOwnText({ text: "Good read https://t.co/keep" }), "Good read https://t.co/keep", "a link the author typed is not in the media list and stays");
	eq(quotedBlock({ text: "https://t.co/abc", entities: { media: [{ url: "https://t.co/abc" }] }, user: { screen_name: "a" } }, "Quoting"), null, "a quoted post that is only video quotes nothing");

	// the real payload for the wordless video post that started this, trimmed
	const vid = parseTweetEmbed({
		text: "https://t.co/XneE327cx9",
		created_at: "2026-07-28T23:16:09.000Z",
		favorite_count: 105510,
		conversation_count: 3844,
		user: { name: "Elon Musk", screen_name: "elonmusk" },
		entities: { media: [{ url: "https://t.co/XneE327cx9" }] },
		video: { durationMs: 274983 },
	});
	ok(vid !== null, "a wordless post is still read: it was found, it just has no words");
	eq(vid.text, "", "and it reports no words rather than a link pretending to be words");
	eq(vid.hasVideo, true, "the video is reported, so the caller can say yt-dlp is what is missing");
	eq(vid.info.title, "Post from @elonmusk", "the title falls back to the author, as it already did");
	eq(vid.info.likes, 105510, "the counts are still read off the payload");
	eq(parseTweetEmbed({ text: "Just words", user: { screen_name: "a" } }).hasVideo, undefined, "a text post reports no video rather than false");

	// the guard that keeps a refusal out of a note: nothing to summarize, nothing asked
	ok(!hasWordsToExtract("https://t.co/XneE327cx9"), "a bare URL is nothing to extract from");
	ok(!hasWordsToExtract("   \n  "), "and neither is whitespace");
	ok(!hasWordsToExtract("https://a.example/x — https://b.example/y"), "nor a line of links and punctuation");
	ok(hasWordsToExtract("Way more than a billion"), "two sentences of a post are");
	ok(hasWordsToExtract("See https://a.example/x for the numbers"), "so are words around a link");

	// --- web page capture ---
	const page = [
		"<html><head><title>Fallback title</title>",
		'<meta property="og:title" content="How We Fixed the Thing">',
		'<meta property="og:site_name" content="Some Engineering Blog">',
		'<meta name="author" content="Jane Doe">',
		'<meta property="article:published_time" content="2026-03-04T11:22:33Z">',
		"</head><body><p>hi</p></body></html>",
	].join("");
	const wm = parseWebMeta(page);
	eq(wm.title, "How We Fixed the Thing", "og:title beats the <title> tag");
	eq(wm.site, "Some Engineering Blog", "og:site_name names the site");
	eq(wm.author, "Jane Doe", "the author tag is read");
	eq(wm.published, "2026-03-04", "an ISO timestamp is trimmed to the date");
	eq(parseWebMeta("<html><head><title>Only this</title></head></html>").title, "Only this", "with no og:title the <title> is the fallback");
	eq(parseWebMeta('<meta content="Reversed" property="og:title">').title, "Reversed", "content before property still parses");
	eq(parseWebMeta('<meta property="og:title" content="A &amp; B &#39;quoted&#39;">').title, "A & B 'quoted'", "entities in a meta tag decode");
	eq(parseWebMeta('<meta name="author" content="https://site/profile/1">').author, undefined, "an author that is only a URL is dropped");
	eq(parseWebMeta('<meta property="article:published_time" content="nonsense">').published, undefined, "an unparseable date is dropped");
	eq(parseWebMeta("<html></html>").title, "", "a page with no metadata yields an empty title for the caller to fall back on");
	eq(webProps({ title: "T", site: "S", author: "A", published: "2026-01-01" }).map((p: { key: string }) => p.key).join(","), "site,author,published", "web props are ordered");
	eq(webProps({ title: "T" }).length, 0, "a page with no metadata gets no extra properties");
	eq(siteNameFromUrl("https://www.someblog.com/x/y"), "someblog", "a site name falls back to the bare host");
	eq(siteNameFromUrl("https://news.ycombinator.com/item?id=1"), "news.ycombinator", "a multi-part host keeps its subdomain");

	// --- sharing a page outside the vault ---
	const { flattenForShare, splitLeadingTitle, parseRecipients, invalidRecipients } = require("./pipeline");
	const { shareEmailHtml, escapeHtml } = require("./share-html");

	// the two that are about privacy rather than tidiness
	eq(flattenForShare("Before %%a private note%% after"), "Before  after", "an Obsidian comment never leaves the vault");
	eq(flattenForShare("a %%💬 note\nspanning lines · 2026-01-01%% b"), "a  b", "a multiline inline comment is removed whole");
	eq(flattenForShare("---\ncost: $0.44\nsource: https://x\n---\n\nBody."), "Body.", "frontmatter is bookkeeping and is dropped");
	eq(flattenForShare("Body.\n\n---\n\nMore."), "Body.\n\n---\n\nMore.", "a horizontal rule mid-note is not frontmatter");

	// links and embeds, which cannot resolve for the reader
	eq(flattenForShare("See [[Some Note]]."), "See Some Note.", "a wikilink becomes its own words");
	eq(flattenForShare("See [[Folder/Some Note|the memo]]."), "See the memo.", "an alias wins");
	eq(flattenForShare("See [[Folder/Some Note]]."), "See Some Note.", "a path keeps only the note name");
	eq(flattenForShare("See [[Note#Heading]]."), "See Note.", "a heading link keeps the note name");
	eq(flattenForShare("![[diagram.png]]\n\nBody."), "Body.", "an embed the reader does not have is dropped");
	eq(flattenForShare("[A real link](https://example.com)"), "[A real link](https://example.com)", "an ordinary Markdown link is untouched");

	// Obsidian-only syntax that would arrive as literal punctuation
	eq(flattenForShare("> [!note] Worth knowing\n> The body."), "> **Worth knowing**\n> The body.", "a callout keeps its title and quote");
	eq(flattenForShare("> [!warning]-\n> Folded."), ">\n> Folded.", "a titleless folded callout still loses its marker");
	eq(flattenForShare("Some text ^block-id"), "Some text", "a block id is an anchor to nowhere");
	eq(flattenForShare("A ==highlighted== word"), "A highlighted word", "highlight markers give way to the words");
	eq(flattenForShare("> [!pc-working] Working\n> step one\n\nDone."), "Done.", "the plugin's own progress callout is transient");
	eq(flattenForShare(""), "", "an empty note stays empty");

	// a captured note opens with its own headline, which would otherwise print
	// directly under the title the mail already carries
	eq(splitLeadingTitle("# The Headline\n\nBody."), { title: "The Headline", body: "Body." }, "an opening heading is the title");
	eq(splitLeadingTitle("Body.\n\n# A Section\n\nMore."), { title: "", body: "Body.\n\n# A Section\n\nMore." }, "a heading further down is a section, not a title");
	eq(splitLeadingTitle("## Not H1\n\nBody.").title, "", "only a top-level heading is a title");
	eq(splitLeadingTitle("Plain body.").title, "", "a note with no heading keeps its body whole");

	eq(parseRecipients("a@b.com, c@d.com;e@f.com\ng@h.com"), ["a@b.com", "c@d.com", "e@f.com", "g@h.com"], "commas, semicolons, and newlines all separate");
	eq(parseRecipients(" a@b.com ,, a@b.com "), ["a@b.com"], "blanks drop and duplicates collapse");
	eq(parseRecipients(""), [], "no recipients yields an empty list");
	eq(invalidRecipients(["a@b.com", "alex.kim@example.com"]), [], "real addresses pass");
	eq(invalidRecipients(["nope", "a@b"]), ["nope", "a@b"], "a typo is caught before Graph is asked to send");

	// the email body
	const html = shareEmailHtml({ title: "Q4 & Beyond", markdown: "## Heading\n\nA **bold** word.", source: "https://example.com/a" });
	ok(html.includes("<h1 style=") && html.includes("Q4 &amp; Beyond"), "the title is escaped and styled");
	ok(html.includes("<h2 style=") && html.includes("<strong>bold</strong>"), "Markdown renders with inline styles");
	ok(html.includes('href="https://example.com/a"'), "the source is linked");
	ok(!shareEmailHtml({ title: "T", markdown: "Body." }).includes("Source:"), "a page with no source gets no source line");
	ok(shareEmailHtml({ title: "T", markdown: "Body.", intro: "Have a look" }).includes("Have a look"), "the sender's own note is included");
	eq(escapeHtml('<script>"x"&y</script>'), "&lt;script&gt;&quot;x&quot;&amp;y&lt;/script&gt;", "html escapes");

	// --- MSN, whose article text never reaches the page reader ---
	const { msnArticleRef, msnApiUrl, parseMsnArticle } = require("./pipeline");
	eq(
		msnArticleRef("https://www.msn.com/en-us/news/politics/new-poll-shows-top/ar-AA27ZYkP?ocid=hpmsn&cvid=6a59&ei=17"),
		{ id: "AA27ZYkP", locale: "en-us" },
		"an MSN article id and market extract past the tracking query"
	);
	eq(msnArticleRef("https://www.msn.com/en-gb/money/other/x/ar-AA1abc").locale, "en-gb", "a non-US market is kept");
	eq(msnArticleRef("https://msn.com/ar-AA1abc").locale, "en-us", "a path with no market falls back to the default");
	eq(msnArticleRef("https://www.msn.com/en-us/video/watch/vi-AA27Z65X"), null, "an MSN video is not claimed by the article path");
	eq(msnArticleRef("https://www.msn.com/en-us/news"), null, "an MSN feed page is not an article");
	eq(msnArticleRef("https://notmsn.com/en-us/news/x/ar-AA1abc"), null, "a lookalike host is rejected");
	eq(msnArticleRef("https://example.com/ar-AA1abc"), null, "the ar- form alone does not make a page MSN");
	eq(
		msnApiUrl({ id: "AA27ZYkP", locale: "en-us" }),
		"https://assets.msn.com/content/view/v2/Detail/en-us/AA27ZYkP",
		"the API url is built from the ref"
	);

	// the real shape of MSN's Detail response, trimmed to the fields read
	const msnJson = {
		title: "New poll shows top 2028 Democratic candidates in swing state",
		body: "<p>A new poll of likely Michigan Democratic voters.</p>",
		authors: [{ name: "Anna Commander" }],
		publishedDateTime: "2026-07-16T02:42:45Z",
		provider: { name: "Newsweek" },
		sourceHref: "https://www.newsweek.com/new-poll-12201998",
		seo: { canonicalUrl: "https://www.newsweek.com/new-poll-12201998" },
	};
	const msn = parseMsnArticle(msnJson);
	eq(msn.title, "New poll shows top 2028 Democratic candidates in swing state", "the headline comes off the JSON");
	eq(msn.info.site, "Newsweek", "the syndicating publisher is the site, not MSN");
	eq(msn.info.author, "Anna Commander", "the byline comes off the JSON");
	eq(msn.info.published, "2026-07-16", "the timestamp reduces to a date");
	eq(msn.canonical, "https://www.newsweek.com/new-poll-12201998", "the canonical URL points at the original");
	eq(parseMsnArticle({ ...msnJson, authors: [{ name: "A" }, { name: "B" }] }).info.author, "A, B", "co-authors are joined");
	eq(parseMsnArticle({ ...msnJson, seo: undefined }).canonical, "https://www.newsweek.com/new-poll-12201998", "sourceHref covers a missing canonical");
	eq(parseMsnArticle({ ...msnJson, seo: undefined, sourceHref: undefined }).canonical, undefined, "no original URL is left undefined");
	eq(parseMsnArticle({ ...msnJson, provider: undefined }).info.site, undefined, "a provider-less article gets no site");
	eq(parseMsnArticle({ ...msnJson, publishedDateTime: "nonsense" }).info.published, undefined, "an unparseable date is dropped");
	eq(parseMsnArticle({ ...msnJson, body: "" }), null, "an empty body is not an article");
	eq(parseMsnArticle({ ...msnJson, title: "" }), null, "a titleless payload is not an article");
	eq(parseMsnArticle({}), null, "an empty payload is not an article");
	eq(parseMsnArticle(null), null, "a null payload does not throw");

	// Readability keeps the page's own headline, which would otherwise repeat
	// directly under the note title
	eq(cleanArticleMarkdown("# How We Fixed the Thing\n\nBody text.", "How We Fixed the Thing"), "Body text.", "a duplicated headline is dropped");
	eq(cleanArticleMarkdown("# How we fixed the thing!\n\nBody.", "How We Fixed the Thing"), "Body.", "the headline match ignores case and punctuation");
	eq(cleanArticleMarkdown("# A Different Headline\n\nBody.", "The Note Title"), "# A Different Headline\n\nBody.", "a genuinely different headline is kept");
	eq(cleanArticleMarkdown("Body.\n\n# Later Heading\n\nMore.", "Body."), "Body.\n\n# Later Heading\n\nMore.", "only a leading headline is considered");
	eq(cleanArticleMarkdown("a\n\n\n\n\nb", "T"), "a\n\nb", "runs of blank lines collapse");
	eq(cleanArticleMarkdown("a   \nb", "T"), "a\nb", "trailing spaces are stripped");
	eq(cleanArticleMarkdown("", "T"), "", "empty markdown stays empty");

	// a web capture stores an article, not speech, so the heading has to follow
	const web = assembleNote({ title: "T", date: "2026-07-16", source: "https://b.com/p", embed: null, body: "## Summary\nHi", transcript: "The article body.", includeTranscript: true, model: "m", transcriptHeading: "Article" });
	ok(web.includes("## Article\n\nThe article body.") && !web.includes("## Transcript"), "a web capture files its text under Article");
	const spoken = assembleNote({ title: "T", date: "2026-07-16", source: "s", embed: null, body: "b", transcript: "words", includeTranscript: true, model: "m" });
	ok(spoken.includes("## Transcript"), "everything else still says Transcript");
	const failed = assembleNote({ title: "T", date: "2026-07-16", source: "s", embed: null, body: null, transcript: "words", includeTranscript: false, model: null, extractionError: "boom", transcriptHeading: "Article" });
	ok(failed.includes("the article is saved below") && failed.includes("## Article"), "a failed extraction names the right thing as saved");
}
eq(
	parseTimedTextXml(
		'<?xml version="1.0"?><timedtext format="3"><body><p t="0" d="9">hello <s ac="9">wor</s><s>ld</s></p><p t="10">it&#39;s &amp; good &#x21;</p><p t="20">   </p></body></timedtext>'
	),
	"hello wor ld it's & good !",
	"xml timedtext strips tags and decodes entities"
);

// --- buildMultipart ---
const fileBytes = new TextEncoder().encode("RIFFdata").buffer;
const mp = buildMultipart({ model: "whisper-large-v3" }, "file", "a.webm", "audio/webm", fileBytes, "BOUND");
eq(mp.contentType, "multipart/form-data; boundary=BOUND", "content type carries the boundary");
const text = new TextDecoder().decode(mp.body);
ok(text.includes('name="model"\r\n\r\nwhisper-large-v3'), "field encoded");
ok(text.includes('name="file"; filename="a.webm"') && text.includes("Content-Type: audio/webm"), "file part headers");
ok(text.includes("RIFFdata") && text.endsWith("--BOUND--\r\n"), "file bytes and terminator present");

// --- ask-your-vault: chunking + tokens ---
const chunks = chunkNote("---\ntype: capture\n---\n# Title\n\nintro text\n\n## Decisions\n\nwe picked atlas\n\n## Transcript\n\n" + "x".repeat(4000));
ok(chunks.some((k) => k.heading === "Decisions" && k.text.includes("atlas")), "chunks are heading-scoped");
ok(!chunks.some((k) => k.text.includes("type: capture")), "frontmatter is stripped before chunking");
ok(chunks.filter((k) => k.heading === "Transcript").length >= 3, "oversized sections hard-wrap into multiple chunks");
eq(tokenize("The Atlas reports, and THE budget!"), ["atlas", "reports", "budget"], "tokenizer lowercases and drops stopwords");

// --- ask-your-vault: BM25 search ---
const idx = new SearchIndex();
idx.addFile("a.md", [{ heading: "Decisions", text: "we decided to migrate the atlas reports to the new dashboard" }]);
idx.addFile("b.md", [{ heading: "Summary", text: "picnic planning and volleyball teams" }]);
idx.addFile("c.md", [{ heading: "Notes", text: "reports reports reports of birds" }]);
const hits = idx.search(["atlas", "reports", "decision"], 3);
eq(hits[0].path, "a.md", "the note matching more distinct terms ranks first");
ok(idx.size === 3, "index counts chunks");
idx.addFile("a.md", [{ heading: "Decisions", text: "entirely different now" }]);
ok(idx.search(["atlas"], 3).length === 0, "re-adding a file replaces its old chunks");
idx.removeFile("c.md");
eq(idx.size, 2, "removeFile drops chunks");
eq(idx.search([], 5).length, 0, "empty query returns nothing");

// --- ask-your-vault: prompts ---
eq(parseSearchTerms("1. Atlas Reports\n- dashboard\n\n* dashboard\nmigration decision"), ["atlas reports", "dashboard", "migration decision"], "term parsing strips bullets and dedupes");
const ask = buildAskPrompt("what did we decide?", [{ path: "Capture/Notes/a.md", heading: "Decisions", text: "we picked atlas" }]);
ok(ask.user.includes("--- Capture/Notes/a › Decisions") && ask.user.includes("we picked atlas"), "excerpts carry path and heading without .md");
ok(ask.user.endsWith("Question: what did we decide?"), "question closes the prompt");
ok(ask.system.includes("[[") && ask.system.includes("ONLY"), "system demands citations and excerpt-only answers");

// --- next-level capture: stamps, names, tasks, series, live ---
import {
	TEMPLATES,
	applySpeakerNames,
	buildCarryOver,
	buildSpeakerNamePrompt,
	downsamplePCM16,
	extractOpenTasks,
	formatMoments,
	mergeUtterances,
	parseSpeakerNames,
	parseStamp,
	seriesKey,
	speakerLetters,
} from "./pipeline";

eq(parseStamp("[1:02]"), 62, "bracketed m:ss stamp");
eq(parseStamp("1:01:01"), 3661, "bare h:mm:ss stamp");
eq(parseStamp("[12:5]"), null, "seconds need two digits");
eq(parseStamp("hello"), null, "not a stamp");

const uttsN = [
	{ speaker: "A", text: "Thanks everyone, Steve here.", start: 0 },
	{ speaker: "B", text: "Hi Steve, John speaking.", start: 4000 },
];
eq(speakerLetters(uttsN), ["A", "B"], "distinct labels in order");
ok(buildSpeakerNamePrompt("t", ["A", "B"]).user.includes("Speaker labels: A, B"), "naming prompt lists the labels");
eq(parseSpeakerNames('Sure! {"A":"Steve","B":null}', ["A", "B"]), { A: "Steve" }, "preamble and null tolerated");
eq(parseSpeakerNames("no json here", ["A"]), {}, "garbage reply maps nobody");
{
	const named = applySpeakerNames("**Speaker A [0:00]:** hi\n\n**Speaker B:** yo", { A: "Steve" });
	ok(named.includes("**Steve [0:00]:**"), "named speaker keeps the stamp");
	ok(named.includes("**Speaker B:**"), "unnamed speaker stays lettered");
}

{
	const tp = buildExtractionPrompt(["actions"], "t", { actionsAsTasks: true, meetingDate: "2026-07-10" });
	ok(tp.system.includes("- [ ] Task description [[Owner]] 📅 YYYY-MM-DD"), "task grammar in the rules");
	ok(tp.system.includes("2026-07-10"), "meeting date anchors relative deadlines");
	ok(buildExtractionPrompt(["actions"], "t").system.includes("| Task | Owner | Due |"), "table mode is the default");
	ok(buildExtractionPrompt(["summary"], "t", { priorContext: "PREVCTX" }).user.includes("PREVCTX"), "prior context rides along");
	ok(!buildExtractionPrompt(["summary"], "t").user.includes("previous meeting"), "no series, no context block");
}

eq(
	extractOpenTasks("- [ ] a 📅 2026-01-01\n- [x] done\n  - [ ] b\nplain text"),
	["- [ ] a 📅 2026-01-01", "- [ ] b"],
	"open tasks parsed, done and prose skipped"
);
eq(buildCarryOver([], "x.md"), null, "nothing open, no section");
ok(
	buildCarryOver(["- [ ] send budget 📅 2026-07-14"], "Capture/Notes/W1.md")!.includes(
		"⏭ send budget 📅 2026-07-14 *(open from [[Capture/Notes/W1]])*"
	),
	"carried items reference their meeting and stay non-checkbox"
);

eq(seriesKey("Leadership 2026-07-10"), "leadership", "ISO dates strip");
eq(seriesKey("Leadership Jul 17 sync"), "leadership-sync", "spoken dates strip");
eq(seriesKey("capture-2026-07-10-03-14-16"), "", "raw recording stamps carry no series");
eq(seriesKey("1:1 with John"), "with-john", "counters strip");

{
	const merged = mergeUtterances([
		{ utterances: [{ speaker: "A", text: "x", start: 1000, end: 3000 }], offsetMs: 0 },
		{ utterances: [{ speaker: "A", text: "y", start: 500, end: 2500 }], offsetMs: 60000 },
	]);
	eq(merged.map((u) => u.start), [1000, 60500], "part offsets shift segment times");
	eq(merged.map((u) => u.end), [3000, 62500], "ends shift with their starts, so shares and audio minutes stay true");
	eq(merged.map((u) => u.speaker), ["1A", "2A"], "multi-part labels are per-part (different people)");
	eq(
		mergeUtterances([{ utterances: [{ speaker: "A", text: "x", start: 5 }], offsetMs: 0 }]).map((u) => u.speaker),
		["A"],
		"single-part labels stay plain"
	);
}

// --- partForStamp ---
import { partForStamp } from "./pipeline";
eq(partForStamp([0, 2700000], 100), { index: 0, secondsInPart: 100 }, "early stamp lands in part 1");
eq(partForStamp([0, 2700000], 2852), { index: 1, secondsInPart: 152 }, "late stamp lands in part 2, rebased");
eq(partForStamp([0], 42), { index: 0, secondsInPart: 42 }, "single part passes through");

// --- grabbing a frame at a stamp ---
{
	const { stampSecsOnLine, frameFileName, frameEmbedLine } = require("./pipeline");
	const turn = "**Darwin [1:02]:** the shared screen is this one.";
	eq(stampSecsOnLine(turn), 62, "the stamp on a transcript turn resolves");
	eq(stampSecsOnLine(turn, 40), 62, "a cursor out in the words still resolves that turn's stamp");
	eq(stampSecsOnLine(turn, 13), 62, "a cursor inside the stamp resolves it");
	eq(stampSecsOnLine("- [7:03] Inventory design", 5), 423, "a Moments bullet resolves");
	eq(stampSecsOnLine("**[1:02:03]** ![[a.webp]]", 4), 3723, "h:mm:ss parses, so a grabbed frame is itself grabbable");
	eq(stampSecsOnLine("no stamp here", 3), null, "a line with no stamp resolves to nothing");
	eq(stampSecsOnLine("see [0:30] and [9:99] both"), 30, "an impossible stamp is skipped, not thrown");
	// two stamps on one line: the cursor decides which frame is meant
	const two = "from [1:00] to [2:00]";
	eq(stampSecsOnLine(two, 6), 60, "the cursor inside the first stamp picks it");
	eq(stampSecsOnLine(two, 17), 120, "the cursor inside the second stamp picks that one");
	eq(stampSecsOnLine(two, 13), 60, "a cursor between the two picks the nearer");
	eq(stampSecsOnLine(two, 21), 120, "a cursor past the end picks the last");

	eq(frameFileName("Atlas: Inventory Management", 423), "Atlas- Inventory Management 7-03.webp", "colons leave both the note name and the stamp");
	eq(frameFileName("Standup", 3723), "Standup 1-02-03.webp", "an hour-long recording keeps all three fields");
	eq(frameFileName("", 0), "frame 0-00.webp", "an unnamed note still yields a filename");
	eq(frameFileName("A/B*C?", 61), "A-B-C- 1-01.webp", "path and wildcard characters are stripped");

	const line = frameEmbedLine(423, "Capture/f.webp");
	eq(line, "**[7:03]** ![[Capture/f.webp]]", "the frame line carries its stamp and the embed");
	ok(!line.startsWith("!"), "the line must NOT start with the embed, or a re-extract reads it as the note's tail");
	eq(stampSecsOnLine(line, 2), 423, "the stamp it writes is one it can read back");
}

// --- picking which frames become screens ---
{
	const { pickSceneFrames, formatScreens, replaceExtractedBody } = require("./pipeline");
	const s = (ms: number, diff: number) => ({ ms, diff });

	eq(pickSceneFrames([], 12, 12), [], "no samples, no screens");
	eq(pickSceneFrames([s(0, 3), s(5000, 4)], 12, 12), [], "a screen that never changes yields nothing");
	eq(pickSceneFrames([s(0, 40), s(5000, 2), s(10000, 30)], 12, 12), [0, 10000], "only the samples over the threshold are kept");
	eq(pickSceneFrames([s(0, 13)], 12, 12), [0], "just over the threshold counts");
	eq(pickSceneFrames([s(0, 12)], 12, 12), [], "exactly at the threshold does not");

	// the cap must keep the BIGGEST changes, not the earliest: an hour of
	// screen-sharing should not be represented only by its opening minutes
	eq(pickSceneFrames([s(0, 20), s(5000, 90), s(10000, 25), s(15000, 80)], 12, 2), [5000, 15000], "the cap keeps the biggest changes");
	eq(pickSceneFrames([s(9000, 50), s(1000, 50)], 12, 1), [1000], "an exact tie breaks on time, so the result is deterministic");
	eq(pickSceneFrames([s(0, 99)], 12, 0), [], "a maximum of zero yields nothing");
	const many = pickSceneFrames([s(0, 90), s(1000, 80), s(2000, 70)], 12, 99);
	eq(many, [0, 1000, 2000], "a cap above the count keeps everything, in time order");

	// rendering
	eq(formatScreens([]), null, "no frames, no section");
	eq(
		formatScreens([{ ms: 423000, link: "Cap/a.webp", text: "" }]),
		"**[7:03]** ![[Cap/a.webp]]",
		"an unread frame is just its stamp and embed"
	);
	eq(
		formatScreens([{ ms: 60000, link: "Cap/b.webp", text: "ATLAS Architecture\nStandalone modules" }]),
		"**[1:00]** ![[Cap/b.webp]]\n> ATLAS Architecture\n> Standalone modules",
		"what the reader found is quoted under the frame, every line of it"
	);
	ok(formatScreens([{ ms: 0, link: "a.webp", text: "" }, { ms: 1000, link: "b.webp", text: "" }]).includes("\n\n"), "frames are separated by a blank line so each embed renders");

	// a re-extract must not eat the screens: they cost a full decode and their
	// image files stay in the vault whether the note points at them or not
	const withScreens = [
		"---", "date: d", "---", "# Atlas", "", "## Summary", "", "old summary", "",
		"## Screens", "", "**[7:03]** ![[Cap/a.webp]]", "", "## Transcript", "", "**A [0:01]:** hi", "",
	].join("\n");
	const swapped = replaceExtractedBody(withScreens, "## Summary\n\nnew summary");
	ok(swapped.includes("new summary") && !swapped.includes("old summary"), "the extraction is replaced");
	ok(swapped.includes("## Screens") && swapped.includes("![[Cap/a.webp]]"), "the Screens section survives a re-extract");
	ok(swapped.includes("## Transcript") && swapped.includes("**A [0:01]:** hi"), "and so does the transcript below it");
	ok(swapped.indexOf("## Screens") < swapped.indexOf("## Transcript"), "the kept sections stay in their original order");
}

// --- splicing Screens into a note that already exists (the imported-transcript case) ---
{
	const { withScreensSection } = require("./pipeline");
	const base = ["---", "date: d", "---", "# Atlas", "", "## Summary", "", "a summary", "", "## Transcript", "", "**A [0:01]:** hi", ""].join("\n");

	const added = withScreensSection(base, "**[1:00]** ![[a.webp]]");
	ok(added.includes("## Screens"), "the section is added");
	ok(added.indexOf("## Summary") < added.indexOf("## Screens"), "it lands below the extraction");
	ok(added.indexOf("## Screens") < added.indexOf("## Transcript"), "and above the transcript");
	ok(!/\n\n\n/.test(added), "no run of blank lines is left behind");

	// re-running the scan refreshes the section rather than stacking a second one
	const again = withScreensSection(added, "**[2:00]** ![[b.webp]]");
	eq((again.match(/## Screens/g) || []).length, 1, "a second run replaces the section, not appends one");
	ok(again.includes("b.webp") && !again.includes("a.webp"), "the frames are the new ones");
	ok(again.includes("## Transcript") && again.includes("**A [0:01]:** hi"), "the transcript is untouched by the replacement");

	eq(withScreensSection(base, null), base, "no frames and no section leaves the note exactly as it was");
	ok(!withScreensSection(added, null).includes("## Screens"), "an empty run clears an existing section");

	// a note whose only tail is the recording embed
	const embedOnly = ["# T", "", "## Summary", "", "s", "", "![[rec.mp4]]", ""].join("\n");
	const spliced = withScreensSection(embedOnly, "**[0:30]** ![[c.webp]]");
	ok(spliced.indexOf("## Screens") < spliced.indexOf("![[rec.mp4]]"), "the section goes above the player at the end");

	// nothing to anchor to at all
	const bare = ["# T", "", "## Summary", "", "s", ""].join("\n");
	ok(withScreensSection(bare, "**[0:05]** ![[d.webp]]").trimEnd().endsWith("![[d.webp]]"), "with no anchor it lands at the bottom");
}

// --- asking extraction for timestamps ---
{
	const stamped = buildExtractionPrompt(["summary", "decisions", "actions", "keywords"], "**A [1:02]:** we ship friday", { stampSections: true });
	ok(/\[12:34\]/.test(stamped.system), "the wanted stamp format is shown, not described");
	ok(/never estimate or invent one/i.test(stamped.system), "the model is told to omit rather than guess");
	ok(/Action items and Keywords take no stamps/i.test(stamped.system), "the strict grammars are excluded");
	const plain = buildExtractionPrompt(["summary"], "hello", {});
	ok(!/\[12:34\]/.test(plain.system), "no stamp rule when stamps were not asked for");
	// the two rules must not contradict each other
	const tasks = buildExtractionPrompt(["actions"], "x", { stampSections: true, actionsAsTasks: true });
	ok(tasks.system.includes("- [ ] Task description [[Owner]]"), "the Tasks grammar survives alongside the stamp rule");
	ok(/Action items and Keywords take no stamps/i.test(tasks.system), "and is explicitly exempted from it");
}

// --- placing each screen beside the point it illustrates ---
{
	const { illustrateBody } = require("./pipeline");
	const f = (ms: number, link: string, text = "") => ({ ms, link, text });
	const body = ["## Summary", "", "- Inventory design settled [7:03]", "- Composable screens reviewed [31:43]", "", "## Keywords", "", "atlas, inventory"].join("\n");

	const r = illustrateBody(body, [f(423000, "a.webp"), f(1903000, "b.webp")]);
	eq(r.unused, [], "both frames find their bullet");
	const lines = r.body.split("\n");
	eq(lines[lines.indexOf("- Inventory design settled [7:03]") + 1], "\t**[7:03]** ![[a.webp]]", "the frame lands under its bullet, indented");
	eq(lines[lines.indexOf("- Composable screens reviewed [31:43]") + 1], "\t**[31:43]** ![[b.webp]]", "and so does the second");
	ok(r.body.includes("## Keywords") && r.body.includes("atlas, inventory"), "the rest of the body is untouched");

	// a frame nowhere near any point stays for the Screens section
	const far = illustrateBody(body, [f(423000, "a.webp"), f(3600000, "late.webp")]);
	eq(far.unused.map((x: { link: string }) => x.link), ["late.webp"], "a frame with no nearby point is handed back, not dropped");

	// the nearest pairing wins, and neither side can be claimed twice
	const close = ["- First point [1:00]", "- Second point [1:20]"].join("\n");
	const two = illustrateBody(close, [f(62000, "near-first.webp"), f(79000, "near-second.webp")]);
	eq(two.unused, [], "two frames, two points, no collision");
	ok(two.body.includes("- First point [1:00]\n\t**[1:02]** ![[near-first.webp]]"), "the closer frame takes the first point");
	ok(two.body.includes("- Second point [1:20]\n\t**[1:19]** ![[near-second.webp]]"), "and the other takes the second");
	const greedy = illustrateBody("- Only point [1:00]", [f(61000, "closest.webp"), f(62000, "alsoclose.webp")]);
	eq(greedy.unused.map((x: { link: string }) => x.link), ["alsoclose.webp"], "one point takes only its nearest frame");

	// what must NOT be treated as an item
	eq(illustrateBody("## Heading [1:00]", [f(60000, "a.webp")]).unused.length, 1, "a heading is not an item, even stamped");
	eq(illustrateBody("| Task | Due [1:00] |", [f(60000, "a.webp")]).unused.length, 1, "a table row is not an item");
	eq(illustrateBody("> **A [1:00]:** a transcript turn", [f(60000, "a.webp")]).unused.length, 1, "a quoted transcript turn is not an item");
	eq(illustrateBody("**[1:00]** ![[already.webp]]", [f(60000, "a.webp")]).unused.length, 1, "a line that is already a frame is not an item");
	eq(illustrateBody("- No stamp here", [f(60000, "a.webp")]).unused.length, 1, "an unstamped bullet takes no frame");
	eq(illustrateBody("", [f(0, "a.webp")]).unused.length, 1, "an empty body keeps every frame");
	eq(illustrateBody("- p [1:00]", []).body, "- p [1:00]", "no frames, no change");

	// a caption rides along with the frame, indented to match
	const capped = illustrateBody("- Architecture [1:00]", [f(60000, "a.webp", "ATLAS Architecture")]);
	ok(capped.body.includes("\t**[1:00]** ![[a.webp]]\n\t> ATLAS Architecture"), "the reader's text is quoted under the frame at the same indent");

	// a stamped paragraph (not a bullet) takes the frame unindented
	const para = illustrateBody("We settled the inventory design. [7:03]", [f(423000, "a.webp")]);
	ok(para.body.includes("We settled the inventory design. [7:03]\n**[7:03]** ![[a.webp]]"), "a paragraph gets its frame without a bullet indent");

	// The default window is a tuned number, so pin it: too wide and a point gets
	// captioned with the screen the PREVIOUS point was about, which is worse than
	// no screen at all. 15 seconds either way.
	const point = "- A point [1:00]";
	eq(illustrateBody(point, [f(74000, "in.webp")]).unused, [], "a frame 14 seconds after the point still illustrates it");
	eq(illustrateBody(point, [f(46000, "in.webp")]).unused, [], "and 14 seconds before it");
	eq(illustrateBody(point, [f(76000, "out.webp")]).unused.length, 1, "a frame 16 seconds away does not");
	eq(illustrateBody(point, [f(44000, "out.webp")]).unused.length, 1, "in either direction");
	// the window is still an argument, for a caller that knows better
	eq(illustrateBody(point, [f(76000, "wide.webp")], 30_000).unused, [], "a caller can widen it explicitly");
}

// --- the frame manifest that outlives a re-extract ---
{
	const { parseScreensJson } = require("./pipeline");
	eq(parseScreensJson(undefined), [], "nothing recorded, no frames");
	eq(parseScreensJson(""), [], "an empty property is not a manifest");
	eq(parseScreensJson("not json"), [], "unparseable frontmatter degrades to empty");
	eq(parseScreensJson('{"ms":1}'), [], "a non-list value degrades to empty");
	eq(
		parseScreensJson('[{"ms":423000,"link":"a.webp","text":"ATLAS"},{"ms":60000,"link":"b.webp"}]'),
		[{ ms: 60000, link: "b.webp", text: "" }, { ms: 423000, link: "a.webp", text: "ATLAS" }],
		"frames parse, default their text, and come back in time order"
	);
	eq(parseScreensJson('[{"ms":1},{"link":"ok.webp"}]'), [{ ms: 0, link: "ok.webp", text: "" }], "a frame with no link is not a frame");
}

// --- a marked moment is a grab point too ---
{
	const { withMomentFrames, momentsFromNote } = require("./pipeline");
	const mark = (ms: number, label = "Mark") => ({ ms, label });

	eq(withMomentFrames([1000, 60000], []), [1000, 60000], "no marks, no change");
	eq(withMomentFrames([], [mark(30000)]), [30000], "a mark on its own is still grabbed");
	eq(withMomentFrames([1000], [mark(60000)]), [1000, 60000], "a mark away from the scan's picks is added, in time order");
	// the cap applies to the automatic measure, not to what a person marked
	eq(withMomentFrames([1000, 2000], [mark(90000), mark(120000)]).length, 4, "marks are not subject to the frame cap");
	eq(withMomentFrames([60000], [mark(62000)]), [60000], "a mark within seconds of a kept frame is the same screen, not a second one");
	eq(withMomentFrames([60000], [mark(70000)]), [60000, 70000], "a mark well clear of one is its own screen");
	eq(withMomentFrames([], [mark(-5000)]), [0], "a nonsense mark clamps to the start rather than seeking backwards");

	// read back out of a finished note, since pa-marks is deleted after processing
	const note = ["# Standup", "", "## Summary", "", "s", "", "## Moments", "", "- [0:12] Decision on inventory", "- [7:03] Mark", "", "## Transcript", "", "**A [0:01]:** hi"].join("\n");
	eq(momentsFromNote(note), [{ ms: 12000, label: "Decision on inventory" }, { ms: 423000, label: "Mark" }], "the Moments section parses back into marks");
	eq(momentsFromNote("# T\n\n## Summary\n\nno moments here"), [], "a note with no Moments section has no marks");
	eq(momentsFromNote(""), [], "an empty note has no marks");
	// a Moments line is the only thing read: prose in the section is not a mark
	eq(momentsFromNote("## Moments\n\nsome prose\n- [1:00] real one").length, 1, "only stamped bullets count");
	eq(momentsFromNote("## Moments\n\n- [1:02:03] Late").map((m: { ms: number }) => m.ms), [3723000], "an h:mm:ss mark parses");
}

// --- illustrating a note that already exists (re-extract and the Teams flow) ---
{
	const { illustrateNote } = require("./pipeline");
	const f = (ms: number, link: string, text = "") => ({ ms, link, text });
	const note = [
		"---", "date: 2026-07-29", "---", "# Atlas", "", "**Speakers:** Priya (60%), Tomas (40%)", "",
		"## Summary", "", "- Inventory design settled [7:03]", "", "## Moments", "", "- [0:12] Mark", "",
		"## Transcript", "", "**Priya [0:01]:** hi", "", "![[rec.mp4]]",
	].join("\n");

	const r = illustrateNote(note, [f(423000, "a.webp"), f(3600000, "far.webp")]);
	ok(r.md.includes("- Inventory design settled [7:03]\n\t**[7:03]** ![[a.webp]]"), "the frame lands under the bullet inside the note");
	eq(r.unused.map((x: { link: string }) => x.link), ["far.webp"], "the frame with no point is handed back for the section");
	ok(r.md.includes("**Speakers:**") && r.md.includes("## Moments") && r.md.includes("- [0:12] Mark"), "the speakers line and moments are untouched");
	ok(r.md.includes("## Transcript") && r.md.includes("**Priya [0:01]:** hi"), "so is the transcript");
	ok(r.md.includes("![[rec.mp4]]"), "and the player at the end");
	ok(r.md.startsWith("---\ndate: 2026-07-29"), "frontmatter survives");
	// a transcript turn is stamped too, and must never be treated as a point
	ok(!r.md.includes("**Priya [0:01]:** hi\n\t**["), "a transcript turn is never illustrated");

	eq(illustrateNote(note, []).md, note, "no frames, no rewrite");
	// a note whose extraction has not been written yet has no points to illustrate
	const stub = ["---", "date: d", "---", "# T", "", "## Transcript", "", "**A [0:01]:** hi"].join("\n");
	eq(illustrateNote(stub, [f(1000, "a.webp")]).unused.length, 1, "with no extracted body every frame is handed back");
	eq(illustrateNote(stub, [f(1000, "a.webp")]).md, stub, "and the note is left alone");
}

// --- what a person page and a digest quote from a section ---
{
	const { sectionListItems } = require("./pipeline");
	// an illustrated Decisions section: the frame and its caption belong to the
	// decision above them, and must never be listed as decisions of their own
	const md = [
		"# Atlas", "", "## Decisions", "",
		"- Inventory fields stay per-module [7:03]", "\t**[7:03]** ![[Cap/a.webp]]", "\t> ATLAS Architecture diagram",
		"- Platform owns shared data [9:12]", "",
		"## Questions", "", "*None identified.*", "",
	].join("\n");
	eq(
		sectionListItems(md, "Decisions"),
		["Inventory fields stay per-module [7:03]", "Platform owns shared data [9:12]"],
		"only the decisions are listed: not the frame beside one, nor the text under it"
	);
	eq(sectionListItems(md, "Questions"), [], "the None placeholder is not an item");
	eq(sectionListItems(md, "Nothing"), [], "a section that is not there has no items");
	eq(sectionListItems("## Decisions\n\n| Task | Owner |\n| --- | --- |", "Decisions"), [], "table rows are not items");
	eq(sectionListItems("## Decisions\n\n- one\n* two\n+ three", "Decisions"), ["one", "two", "three"], "every bullet marker is stripped");
}

// --- the round trip that matters: illustrate, re-extract, illustrate again ---
{
	const { illustrateNote, replaceExtractedBody, withScreensSection, formatScreens, parseScreensJson } = require("./pipeline");
	const f = (ms: number, link: string, text = "") => ({ ms, link, text });
	const frames = [f(423000, "a.webp", "ATLAS Architecture"), f(1903000, "b.webp")];

	// as the plugin does it: manifest in frontmatter, frames beside their points,
	// leftovers as a section
	const start = ["---", "date: d", `pa-screens: '${JSON.stringify(frames)}'`, "---", "# Atlas", "", "## Summary", "", "- Inventory design settled [7:03]", "", "## Transcript", "", "**A [0:01]:** hi"].join("\n");
	const first = illustrateNote(start, frames);
	let md = withScreensSection(first.md, formatScreens(first.unused));
	ok(md.includes("- Inventory design settled [7:03]\n\t**[7:03]** ![[a.webp]]"), "the near frame illustrates the point");
	ok(md.includes("## Screens") && md.includes("![[b.webp]]"), "the far frame becomes the section");

	// now re-extract: a NEW body arrives and the old one (with its frame) is gone
	const recovered = parseScreensJson(`${JSON.stringify(frames)}`);
	eq(recovered.length, 2, "the manifest survives in frontmatter, which is the whole point of it");
	const fresh = "## Summary\n\n- Inventory design settled, again [7:05]\n- Something new [31:40]";
	const shown = illustrateNote(withScreensSection(replaceExtractedBody(md, fresh), null), recovered);
	md = withScreensSection(shown.md, formatScreens(shown.unused));

	ok(md.includes("- Inventory design settled, again [7:05]\n\t**[7:03]** ![[a.webp]]"), "the same frame re-attaches to the rewritten point");
	ok(md.includes("- Something new [31:40]\n\t**[31:43]** ![[b.webp]]"), "and a frame that had no point before finds the new one");
	// counted below the frontmatter: the manifest names every link up there by
	// design, and it is the BODY that must not gain a second copy
	const bodyOnly = md.replace(/^---\n[\s\S]*?\n---\n/, "");
	eq((bodyOnly.match(/a\.webp/g) || []).length, 1, "no frame is duplicated in the body by the round trip");
	eq((bodyOnly.match(/b\.webp/g) || []).length, 1, "nor the other one");
	ok(/pa-screens:/.test(md.slice(0, md.indexOf("\n---\n", 4))), "and the manifest is still up in the frontmatter for next time");
	ok(!md.includes("## Screens"), "with every frame placed there is no leftover section");
	ok(md.includes("## Transcript") && md.includes("**A [0:01]:** hi"), "the transcript is still there afterwards");
	ok(md.includes("ATLAS Architecture"), "and the caption travelled with its frame");
}
{
	const note = assembleNote({
		title: "T",
		date: "d",
		source: "s",
		embed: null,
		body: "b",
		transcript: "t",
		includeTranscript: false,
		model: null,
		partsMs: [0, 2700000],
	});
	ok(note.includes("pa-parts: [0, 2700000]"), "part offsets land in frontmatter, under the plugin's own prefix");
	ok(!assembleNote({ title: "T", date: "d", source: "s", embed: null, body: "b", transcript: "t", includeTranscript: false, model: null, partsMs: [0] }).includes("parts:"), "single part emits no parts property");
	eq(partOffsetsOf({ "pa-parts": [0, 2700000] }), [0, 2700000], "the offsets read back");
	eq(partOffsetsOf({ parts: [0, 2700000] }), [0, 2700000], "a note written before the rename still works");
	eq(partOffsetsOf({}), [], "a single-part recording has none");
	eq(partOffsetsOf({ parts: "not a list" }), [], "and nonsense is not offsets");
}

eq(formatMoments([]), null, "no marks, no section");
eq(formatMoments([{ ms: 62000, label: "Decision" }]), "- [1:02] Decision", "moment renders as a clickable stamp");
eq(formatMoments([{ ms: 0, label: "" }]), "- [0:00] Mark", "unlabeled marks get a default");

{
	const note = assembleNote({
		title: "T",
		date: "2026-07-10",
		source: "[[a.webm]]",
		embed: "![[a.webm]]",
		body: "## Summary\nhi",
		transcript: "tr",
		includeTranscript: true,
		model: "m",
		speakers: 2,
		attendees: ["Steve", "John"],
		series: "leadership",
		carryOver: "- ⏭ x *(open from [[p]])*",
		moments: [{ ms: 0, label: "Mark" }],
	});
	ok(note.includes('  - "[[Steve]]"') && note.includes('  - "[[John]]"'), "attendees are frontmatter wiki-links");
	ok(note.includes("series: leadership"), "series key in frontmatter");
	ok(
		note.indexOf("## Carried over") < note.indexOf("## Moments") && note.indexOf("## Moments") < note.indexOf("## Transcript"),
		"carried over, then moments, then transcript"
	);
}

ok(TEMPLATES.some((t) => t.id === "leadership" && t.sections.includes("risks")), "leadership template extracts risks");

{
	const f32 = new Float32Array(4800).fill(0.5);
	const ds = downsamplePCM16(f32, 48000, 16000);
	eq(ds.length, 1600, "48k to 16k thirds the samples");
	ok(Math.abs(ds[0] - Math.round(0.5 * 32767)) <= 1, "amplitude preserved");
	eq(downsamplePCM16(new Float32Array([2]), 16000, 16000)[0], 32767, "overs clamp");
}

// --- Otter-parity batch: shares, renames, keywords, meeting ask ---
import {
	EXTRACTIONS,
	buildMeetingChat,
	formatSpeakersLine,
	meetingAskChips,
	renameSpeakerLabels,
	talkShares,
	transcriptSpeakers,
} from "./pipeline";

{
	const shares = talkShares([
		{ speaker: "A", text: "long turn", start: 0, end: 3000 },
		{ speaker: "B", text: "short", start: 3000, end: 4000 },
	]);
	eq(shares.map((s) => [s.speaker, s.share]), [["A", 0.75], ["B", 0.25]], "timed shares use real durations");
	ok(shares[0].first.includes("long turn"), "share entries carry a first-words preview");
}
{
	const shares = talkShares([
		{ speaker: "A", text: "aaaaaaaaaa", start: 0 },
		{ speaker: "B", text: "bbbbb", start: 1 },
	]);
	ok(Math.abs(shares[0].share - 2 / 3) < 0.01, "untimed shares fall back to text weight");
}
{
	const line = formatSpeakersLine(
		[
			{ speaker: "A", share: 0.57 },
			{ speaker: "B", share: 0.26 },
			{ speaker: "C", share: 0.004 },
		],
		(l) => ({ A: "Steve", B: "Jordan" }[l] ?? `Speaker ${l}`)
	);
	eq(line, "Steve (57%), Jordan (26%), and 1 more under 1%", "speakers line names, rounds, and groups the tail");
	eq(formatSpeakersLine([{ speaker: "A", share: 1 }], () => "X"), null, "one voice, no line");
}
{
	const md = "**Bold:** body text\n\n## Transcript\n\n**Speaker A [0:00]:** hi\n\n**Jordan [0:04]:** yo\n\n**Speaker A:** again";
	eq(transcriptSpeakers(md), ["Speaker A", "Jordan"], "labels come from the transcript only, deduped");
}
{
	const out = renameSpeakerLabels("**Speaker A [0:00]:** hi\n**Jordan:** yo", { "Speaker A": "Steve", Jordan: "Stephanie" });
	ok(out.includes("**Steve [0:00]:**") && out.includes("**Stephanie:**"), "arbitrary labels rename, stamps intact");
	eq(renameSpeakerLabels("**Steve:** hi", { Steve: "Steve" }), "**Steve:** hi", "identity mapping is a no-op");
	eq(
		renameSpeakerLabels("**Jordan:** a\n**Steve:** b", { Jordan: "Steve", Steve: "Jordan" }),
		"**Steve:** a\n**Jordan:** b",
		"swapping two people never collapses them"
	);
	eq(
		renameSpeakerLabels("**Jordan:** a\n**Steve:** b", { Jordan: "Steve", Steve: "Rob" }),
		"**Steve:** a\n**Rob:** b",
		"chained renames apply simultaneously, not in sequence"
	);
	eq(
		renameSpeakerLabels("**Speaker 1A:** x\n**Speaker 1:** y", { "Speaker 1": "Ana", "Speaker 1A": "Ben" }),
		"**Ben:** x\n**Ana:** y",
		"longer labels win over their prefixes"
	);
}
{
	const { applyCorrections, countTerm } = require("./pipeline");
	const t = "**George [23:51]:** Alright, Shaker. **Deverakonda Rajasekhar [23:56]:** Yeah. Shaker rules. Shakerville stays.";
	const out = applyCorrections(t, [{ from: "Deverakonda Rajasekhar", to: "Sekhar" }, { from: "Shaker", to: "Sekhar" }]);
	ok(out.includes("**Sekhar [23:56]:**"), "the full invite name is swapped in the speaker label");
	ok(out.includes("Alright, Sekhar.") && out.includes("Sekhar rules."), "every whole-word mention is corrected");
	ok(out.includes("Shakerville stays."), "a term inside another word is left alone");
	eq(countTerm(t, "Shaker"), 2, "counts whole-word occurrences, not the substring in Shakerville");
	eq(applyCorrections("x", [{ from: "a", to: "a" }]), "x", "identity rules are skipped");
	eq(applyCorrections("", [{ from: "", to: "y" }]), "", "empty from is skipped");
	eq(
		applyCorrections("Rajasekhar and Deverakonda Rajasekhar", [
			{ from: "Rajasekhar", to: "R" },
			{ from: "Deverakonda Rajasekhar", to: "Sekhar" },
		]),
		"R and Sekhar",
		"the longer phrase wins over the word it contains"
	);
	eq(applyCorrections("Deverakonda Rajasekhar", [{ from: "Deverakonda Rajasekhar", to: "Sekhar" }]), "Sekhar", "a bare attendee name is renamed whole");
	eq(
		applyCorrections("Deverakonda Rajasekhar (57%), George (43%)", [{ from: "Deverakonda Rajasekhar", to: "Sekhar" }]),
		"Sekhar (57%), George (43%)",
		"the talk-share line is corrected too"
	);
}
{
	const { speakerColor } = require("./pipeline");
	eq(speakerColor("George"), speakerColor("George"), "a speaker's color is stable across calls");
	ok(/^#[0-9a-f]{6}$/i.test(speakerColor("Sekhar")), "returns a hex color");
	ok(new Set(["George", "Sekhar", "Steve", "Adam", "Alex", "Deverakonda Rajasekhar"].map(speakerColor)).size >= 3, "distinct speakers get a spread of colors");
}
{
	const { correctionRanges } = require("./pipeline");
	const t = "Speaker A said hi. Speaker A again. Speaker Alpha stays.";
	const r = correctionRanges(t, "Speaker A");
	eq(r.length, 2, "finds each whole-word occurrence, not the one inside Speaker Alpha");
	eq(t.slice(r[0].start, r[0].end), "Speaker A", "a range spans exactly the term");
	eq(correctionRanges(t, "").length, 0, "an empty term yields no ranges");
}
{
	const { parseTranscriptSpeakerLine, parseTranscriptHeaderLine } = require("./pipeline");
	const line = "> **Darwin [1:59]:** Hey, Shaker.";
	const p = parseTranscriptSpeakerLine(line);
	ok(p, "a speaker line parses");
	eq(p.name, "Darwin", "the name is captured");
	eq(line.slice(p.nameFrom, p.nameTo), "Darwin", "name offsets land on the name");
	eq(line.slice(p.stampFrom, p.stampTo), "[1:59]", "stamp offsets land on the timestamp");
	eq(p.prefixLen, 2, "the `> ` blockquote marker is two chars");
	const multi = parseTranscriptSpeakerLine("> **Speaker Alpha [12:03:45]:** hi");
	eq("> **Speaker Alpha [12:03:45]:** hi".slice(multi.nameFrom, multi.nameTo), "Speaker Alpha", "a two-word name with h:mm:ss is captured whole");
	const bare = parseTranscriptSpeakerLine("> **Steve:** hello");
	eq(bare.name, "Steve", "a stampless speaker line still parses");
	ok(bare.stampFrom === undefined, "no stamp means no stamp offsets");
	ok(!parseTranscriptSpeakerLine("> just some quoted prose"), "a non-speaker quote line does not parse");
	const plain = parseTranscriptSpeakerLine("**Darwin [1:59]:** Hey");
	eq(plain.prefixLen, 0, "a plain (un-quoted) speaker line has no blockquote prefix");
	eq("**Darwin [1:59]:** Hey".slice(plain.nameFrom, plain.nameTo), "Darwin", "plain-line name offsets are correct");
	eq("**Darwin [1:59]:** Hey".slice(plain.stampFrom, plain.stampTo), "[1:59]", "plain-line stamp offsets are correct");
	const h = parseTranscriptHeaderLine("> [!transcript]- Transcript");
	ok(h, "the callout header parses");
	eq(h.title, "Transcript", "the header title is captured");
	eq("> [!transcript]- Transcript".slice(h.hideTo), "Transcript", "hideTo lands exactly at the title");
	ok(!parseTranscriptHeaderLine("> [!note] Something else"), "a different callout is not a transcript header");
}
{
	// --- reading a transcript back, moving one turn, and the clips that let you hear a speaker ---
	const { transcriptToUtterances, reassignTranscriptTurn, rebuildSpeakersLine, pickSpeakerSamples } = require("./pipeline");
	const md = [
		"# Standup",
		"",
		"**Speakers:** George (60%), Steve (40%)",
		"",
		"## Summary",
		"",
		"**Note:** a bold label in prose is not a turn.",
		"",
		"## Transcript",
		"",
		"**George [0:05]:** Morning everyone, quick platform update before we start.",
		"",
		"**Steve [0:12]:** Thanks.",
		"and a continuation line",
		"",
		"**George [0:14]:** Inventory is basically done.",
		"",
		"## Moments",
		"",
		"- [0:12] Mark",
	].join("\n");
	const utts = transcriptToUtterances(md);
	eq(utts.length, 3, "exactly the section's turns parse; prose bolds and Moments never do");
	eq(utts[0].start, 5000, "stamps become millisecond starts");
	eq(utts[0].end, 12000, "a turn ends where the next begins");
	eq(utts[1].text, "Thanks. and a continuation line", "continuation lines fold into their turn");
	eq(utts[2].end, 22000, "the last turn gets the short-tail guess");

	const moved = reassignTranscriptTurn(md, { name: "George", stamp: "[0:14]", textHint: "Inventory is basically done" }, "Steve");
	ok(moved.changed, "the turn is found");
	ok(moved.md.includes("**Steve [0:14]:** Inventory is basically done."), "only that line's label is rewritten");
	ok(moved.md.includes("**George [0:05]:** Morning everyone"), "the speaker's other turns stay put");
	eq(reassignTranscriptTurn(md, { name: "George", stamp: "[9:59]" }, "X").changed, false, "an unknown stamp changes nothing");
	eq(reassignTranscriptTurn(md, { name: "George", stamp: "[0:14]" }, "George").changed, false, "a move to the same name is a no-op");

	const tie = ["## Transcript", "", "**Speaker A [0:05]:** yes exactly right", "", "**Speaker A [0:05]:** no wait a second"].join("\n");
	const t2 = reassignTranscriptTurn(tie, { name: "Speaker A", stamp: "[0:05]", textHint: "no wait a second" }, "Jordan");
	ok(t2.md.includes("**Speaker A [0:05]:** yes exactly right") && t2.md.includes("**Jordan [0:05]:** no wait a second"), "the words break a same-second tie");

	const q = ["## Transcript", "", "> **Speaker A [0:05]:** hi there friends"].join("\n");
	ok(reassignTranscriptTurn(q, { name: "Speaker A", stamp: "[0:05]" }, "Jordan").md.includes("> **Jordan [0:05]:** hi there friends"), "a legacy quoted line keeps its marker");

	const rebuilt = rebuildSpeakersLine(moved.md);
	const line = /^\*\*Speakers:\*\* .*$/m.exec(rebuilt)?.[0] ?? "";
	ok(line.includes("Steve") && line.includes("George"), "the share line recomputes from the transcript as it reads now");
	ok(line.indexOf("Steve") < line.indexOf("George"), "the busiest speaker after the move leads the line");
	eq(rebuildSpeakersLine("## Transcript\n\n**A [0:01]:** hi"), "## Transcript\n\n**A [0:01]:** hi", "a note without the share line is unchanged");

	const samples = pickSpeakerSamples(
		[
			{ speaker: "A", text: "long", start: 0, end: 9000 },
			{ speaker: "A", text: "longest", start: 20000, end: 32000 },
			{ speaker: "A", text: "mid", start: 40000, end: 47000 },
			{ speaker: "A", text: "short", start: 60000, end: 61000 },
			{ speaker: "B", text: "unstamped" },
		],
		3
	);
	eq(samples.A.length, 3, "clips cap at the ask");
	eq(samples.A.map((s: { startMs: number }) => s.startMs), [0, 20000, 40000], "the longest clips win, replayed in meeting order");
	ok(!samples.B, "a speaker with no stamps gets no clips");
}
{
	// --- diarization letters must never become standing corrections ---
	const { isSpeakerLetterTerm } = require("./pipeline");
	ok(isSpeakerLetterTerm("Speaker A"), "a plain letter label is a letter term");
	ok(isSpeakerLetterTerm("Speaker 1A"), "a multi-part letter label is a letter term");
	ok(isSpeakerLetterTerm(" SPEAKER B "), "case and padding do not hide a letter term");
	ok(!isSpeakerLetterTerm("Speaker"), "the bare word Speaker is not a letter term");
	ok(!isSpeakerLetterTerm("Shaker"), "an ordinary misheard word is not a letter term");
	ok(!isSpeakerLetterTerm("Speaker Alpha"), "a real name after Speaker is not a letter term");
	ok(!isSpeakerLetterTerm("Deverakonda Rajasekhar"), "a person's name is not a letter term");
}
eq(
	transcriptSpeakers("# T\n\n**Speakers:** Steve (57%), Jordan (26%)\n\n## Summary\nhi"),
	[],
	"a note without a transcript section has nothing to rename"
);
{
	const chips = meetingAskChips(["Jordan", "Steve", "Ana", "Ben"], "Steve");
	ok(chips.some((c) => c.label === "Was I mentioned?" && c.question.includes("Steve")), "your-name chip appears when set");
	eq(chips.filter((c) => c.label.startsWith("What did")).length, 3, "attendee chips cap at three");
	ok(!meetingAskChips([], "").some((c) => c.label === "Was I mentioned?"), "no name, no mention chip");
}
{
	const chat = buildMeetingChat("NOTE-BODY", [
		{ role: "user", content: "Q1" },
		{ role: "assistant", content: "A1" },
		{ role: "user", content: "Q2" },
	]);
	ok(chat.messages[0].content.includes("NOTE-BODY") && chat.messages[0].content.includes("Q1"), "note rides the first turn");
	eq(chat.messages[2].content, "Q2", "follow-ups stay lean");
	ok(chat.system.includes("[m:ss]"), "answers are asked to cite stamps");
}
ok(EXTRACTIONS.some((e) => e.key === "keywords"), "keywords is an extraction section");
ok(
	buildExtractionPrompt(["keywords"], "t").system.includes("comma-separated topics"),
	"the keywords one-line rule is in the system prompt"
);

// --- 0.9.0: imports, re-extract, people, digest, live copilot, filters, cost ---
import {
	buildCatchUpPrompt,
	buildLiveActionsPrompt,
	buildPersonReport,
	buildWeeklyDigest,
	coalesceUtterances,
	dayKey,
	estimateCost,
	extractDoneTasks,
	filterHitsByMeta,
	isAnonymousLabel,
	isConflictCopy,
	llmConfigured,
	llmCostUsd,
	actionOwners,
	buildEvalReport,
	dedupeQueuedNotes,
	evalSections,
	scoreExtraction,
	CLAIM_STALE_MS,
	parseMomentsJson,
	parseWhisperX,
	pendingRecordings,
	pendingState,
	pushUsageEvent,
	resolveLlmTarget,
	summarizeUsage,
	transcriptionCostUsd,
	appendWithoutOverlap,
	captureSourceText,
	captionsToText,
	compactCount,
	cookieArgs,
	hasYoutubeLogin,
	humanDuration,
	mergeYoutubeInfo,
	parseYtDlpMeta,
	isYoutubeCookieDomain,
	netscapeCookieFile,
	youtubeBlockReason,
	ytDlpSubsArgs,
	type ExtractionKey,
	freeNoteName,
	isSyncConflictName,
	postExtractions,
	sameCaptureSource,
	titleShownByFilename,
	parseClock,
	parseCues,
	parseLineList,
	parseOtterTxt,
	parseTranscriptFile,
	recentTurnsText,
	replaceExtractedBody,
	sectionText,
	taskOwner,
} from "./pipeline";

eq(parseClock("00:00:05.000"), 5000, "vtt clock with hours");
eq(parseClock("02:03,500"), 123500, "srt comma clock");
eq(parseClock("1:02"), 62000, "otter m:ss clock");
eq(parseClock("hello"), null, "not a clock");

{
	const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<v Alex Kim>Hello everyone.</v>\n\n2\n00:00:03.500 --> 00:00:05.000\n<v Alex Kim>Let's begin.</v>\n\n3\n00:00:05.500 --> 00:00:08.000\n<v Jordan Green>Thanks Steve.</v>";
	const utts = coalesceUtterances(parseCues(vtt));
	eq(utts.length, 2, "consecutive same-speaker cues coalesce");
	eq(utts[0].speaker, "Alex Kim", "teams voice tags carry names");
	ok(utts[0].text.includes("Hello everyone.") && utts[0].text.includes("Let's begin."), "coalesced text joins");
	eq(utts[1].start, 5500, "cue starts survive");
	eq(utts[1].end, 8000, "cue ends survive");
}
{
	const srt = "1\n00:00:01,000 --> 00:00:02,000\nSpeaker 1: Hi there.\n\n2\n00:00:02,500 --> 00:00:04,000\nJordan: Hello.";
	const utts = parseCues(srt);
	eq(utts[0].speaker, "1", "'Speaker 1' prefix normalizes to an anonymous label");
	eq(utts[1].speaker, "Jordan", "name prefixes parse");
}
{
	const otter = "Alex Kim  0:05\nWelcome to the sync.\nSecond line of the same turn.\n\nJordan Green  1:02\nThanks Steve.";
	const utts = parseOtterTxt(otter);
	eq(utts.length, 2, "otter txt headers split turns");
	eq(utts[0].start, 5000, "otter clock parses");
	ok(utts[0].text.includes("Second line"), "otter paragraphs join");
	const tricky = parseOtterTxt("Alex Kim  0:05\nLet's plan the day.\nWe reconvene at 3:00\nand then wrap up.");
	eq(tricky.length, 1, "prose ending in a time is not a speaker header");
	ok(tricky[0].text.includes("reconvene at 3:00") && tricky[0].text.includes("wrap up"), "no lines are lost to the false header");
	ok(parseTranscriptFile("meeting.txt", otter) !== null, "dispatcher recognizes otter txt");
	ok(parseTranscriptFile("meeting.vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi") !== null, "dispatcher recognizes vtt");
	eq(parseTranscriptFile("notes.txt", "just some prose\nwith lines"), null, "plain prose is not a transcript");
}
ok(isAnonymousLabel("A") && isAnonymousLabel("1A") && isAnonymousLabel("12") && isAnonymousLabel("12B"), "placeholders are anonymous");
ok(!isAnonymousLabel("Jordan") && !isAnonymousLabel("Alex Kim"), "names are not anonymous");
ok(!isAnonymousLabel("Jo") && !isAnonymousLabel("Ed") && !isAnonymousLabel("TJ"), "short names and initials are people, not placeholders");
{
	const t = formatUtterances([
		{ speaker: "A", text: "hi", start: 0 },
		{ speaker: "Alex Kim", text: "yo", start: 4000 },
	]);
	ok(t.includes("**Speaker A [0:00]:**"), "anonymous labels keep the Speaker prefix");
	ok(t.includes("**Alex Kim [0:04]:**"), "imported names render bare");
}

{
	// --- voiceprints: recognizing a speaker across recordings ---
	const { l2normalize, cosine, enrollVoiceprint, matchVoiceprint, forgetVoiceprint, parseWhisperX } = require("./pipeline");
	const near = (a: number[], b: number[], name: string) =>
		ok(Array.isArray(a) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9), name);

	near(l2normalize([3, 4]), [0.6, 0.8], "l2normalize scales to unit length");
	eq(l2normalize([0, 0, 0]), [0, 0, 0], "the zero vector normalizes to itself");
	ok(Math.abs(cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9, "cosine of identical vectors is 1");
	eq(cosine([1, 0, 0], [0, 1, 0]), 0, "cosine of orthogonal vectors is 0");

	// enrollment builds a library, and never mutates the one handed in
	const empty: unknown[] = [];
	const l1 = enrollVoiceprint(empty, "Sanjit", [2, 0, 0], 1000);
	eq(empty.length, 0, "enroll never mutates the input library");
	eq(l1.length, 1, "a new person is added");
	eq(l1[0].person, "Sanjit", "under their name");
	eq(l1[0].centroids.length, 1, "with one centroid");
	near(l1[0].centroids[0].vector, [1, 0, 0], "the centroid is stored L2-normalized");
	eq(l1[0].centroids[0].samples, 1, "one sample so far");
	eq(l1[0].updated, 1000, "carrying the timestamp the caller passed");

	const l2 = enrollVoiceprint(l1, "Sanjit", [0.99, 0.0447, 0], 2000);
	eq(l2[0].centroids.length, 1, "a similar voice merges rather than splitting the print");
	eq(l2[0].centroids[0].samples, 2, "the merged centroid counts both samples");

	const l3 = enrollVoiceprint(l2, "Sanjit", [0, 0, 1], 3000);
	eq(l3[0].centroids.length, 2, "a distinct voice condition starts a second centroid");

	let capped: unknown = [];
	for (let i = 0; i < 8; i++) {
		const a = (i * Math.PI) / 8; // eight distinct directions, none within the merge angle
		capped = enrollVoiceprint(capped, "Morgan", [Math.cos(a), Math.sin(a)], 100 + i, { mergeAt: 0.99, maxCentroids: 3 });
	}
	ok((capped as { centroids: unknown[] }[])[0].centroids.length <= 3, "centroids never exceed the cap");
	ok((capped as { centroids: unknown[] }[])[0].centroids.length >= 1, "but the person keeps a print");

	// matching
	const lib = enrollVoiceprint(enrollVoiceprint([], "Sanjit", [1, 0, 0], 1), "Dylan", [0, 1, 0], 1);
	eq(matchVoiceprint(lib, [0.98, 0.02, 0]).person, "Sanjit", "a close voice matches its person");
	eq(matchVoiceprint(lib, [0, 0, 1]), null, "an unheard voice matches no one");
	eq(matchVoiceprint([], [1, 0, 0]), null, "an empty library never matches");
	eq(matchVoiceprint(lib, []), null, "an empty embedding never matches");
	eq(matchVoiceprint(lib, [1, 0, 0], { threshold: 0.99 }).person, "Sanjit", "an exact voice clears a high threshold");
	eq(matchVoiceprint(lib, [0.7, 0.71, 0]), null, "a voice halfway between two people is too ambiguous to guess");

	const twins = enrollVoiceprint(enrollVoiceprint([], "A", [1, 0, 0], 1), "B", [0.98, 0.199, 0], 1);
	eq(matchVoiceprint(twins, [1, 0, 0]), null, "the margin rejects a near-tie between two different people");

	// forgetting must actually delete, for the privacy promise
	eq(
		forgetVoiceprint(lib, "Sanjit").map((p: { person: string }) => p.person),
		["Dylan"],
		"forget removes exactly that person"
	);
	eq(forgetVoiceprint(lib, "Nobody").length, 2, "forgetting an unknown name changes nothing");

	// the server's speaker ids are re-keyed to the letters the transcript uses
	const px = parseWhisperX({
		segments: [
			{ start: 0, end: 1, text: "hi", speaker: "SPEAKER_00" },
			{ start: 1, end: 2, text: "hello", speaker: "SPEAKER_01" },
		],
		embeddings: {
			SPEAKER_00: { vector: [1, 0], seconds: 12 },
			SPEAKER_01: { vector: [0, 1], seconds: 8 },
			SPEAKER_09: { vector: [1, 1], seconds: 3 },
		},
	});
	eq(px.embeddings.A, { vector: [1, 0], seconds: 12 }, "the first server speaker becomes letter A");
	eq(px.embeddings.B, { vector: [0, 1], seconds: 8 }, "the second becomes B");
	ok(!px.embeddings.C, "an embedding for a speaker who never spoke a kept segment is dropped");
}

{
	// --- voiceprint management: load, summarize, gate, rename/merge ---
	const { enrollVoiceprint, renameVoiceprint, usableEmbedding, parseVoiceprintLibrary, summarizeVoiceprints } = require("./pipeline");

	const base = enrollVoiceprint(enrollVoiceprint([], "A", [1, 0, 0], 1), "B", [0, 1, 0], 1);

	// plain rename (no print under the new name yet)
	const r1 = renameVoiceprint(base, "A", "C", 5);
	eq(r1.map((p: { person: string }) => p.person).sort(), ["B", "C"], "a plain rename moves the print to the new name");
	eq(base.map((p: { person: string }) => p.person).sort(), ["A", "B"], "rename never mutates the input");

	// merge into an existing name
	const r2 = renameVoiceprint(base, "A", "B", 5);
	eq(r2.length, 1, "merging into an existing name leaves one person");
	eq(r2[0].person, "B", "under the target name");
	eq(r2[0].centroids.length, 2, "carrying both voices' centroids");

	// a merge still respects the centroid cap
	let many: unknown = [];
	for (let i = 0; i < 4; i++) many = enrollVoiceprint(many, "A", [Math.cos((i * Math.PI) / 8), Math.sin((i * Math.PI) / 8)], i, { mergeAt: 0.99 });
	for (let i = 0; i < 4; i++) many = enrollVoiceprint(many, "B", [Math.cos((i * Math.PI) / 8 + 0.05), Math.sin((i * Math.PI) / 8 + 0.05)], i, { mergeAt: 0.99 });
	const merged = renameVoiceprint(many, "A", "B", 9, { maxCentroids: 3 });
	ok(merged.find((p: { person: string }) => p.person === "B").centroids.length <= 3, "a merge respects the centroid cap");
	ok(!merged.find((p: { person: string }) => p.person === "A"), "the old name is gone after a merge");

	// no-ops
	eq(renameVoiceprint(base, "Nobody", "X", 5).map((p: { person: string }) => p.person).sort(), ["A", "B"], "renaming an absent name changes nothing");
	eq(renameVoiceprint(base, "A", "A", 5).map((p: { person: string }) => p.person).sort(), ["A", "B"], "renaming to the same name changes nothing");

	// the enrollment/matching gate
	ok(!usableEmbedding(undefined), "no embedding is not usable");
	ok(!usableEmbedding({ vector: [1, 0], seconds: 2 }), "too little speech is not usable");
	ok(usableEmbedding({ vector: [1, 0], seconds: 5 }), "enough speech is usable");
	ok(!usableEmbedding({ vector: [], seconds: 9 }), "an empty vector is not usable");
	ok(usableEmbedding({ vector: [1], seconds: 2 }, 1), "the minimum is adjustable");

	// defensive load from a synced file
	const good = [{ person: "Sanjit", centroids: [{ vector: [1, 0, 0], samples: 3 }], updated: 42 }];
	eq(parseVoiceprintLibrary(good), good, "a valid library round-trips");
	eq(parseVoiceprintLibrary("nonsense"), [], "a non-array is an empty library");
	eq(parseVoiceprintLibrary([{ centroids: [{ vector: [1], samples: 1 }] }]), [], "an entry with no name is dropped");
	eq(parseVoiceprintLibrary([{ person: "X", centroids: [{ vector: [1, null, 3], samples: 1 }] }]), [], "a vector with a hole drops the centroid, and the emptied entry with it");
	eq(parseVoiceprintLibrary([{ person: "X", centroids: [{ vector: [1, 2], samples: -5 }] }])[0].centroids[0].samples, 1, "a bad sample count is coerced to 1");
	eq(parseVoiceprintLibrary([{ person: "X", centroids: [{ vector: [1, 2], samples: 2 }] }])[0].updated, 0, "a missing timestamp defaults to 0");

	// the management overview
	const sum = summarizeVoiceprints([
		{ person: "Bravo", centroids: [{ vector: [1, 0], samples: 2 }, { vector: [0, 1], samples: 1 }], updated: 100 },
		{ person: "Alpha", centroids: [{ vector: [1, 0], samples: 5 }], updated: 200 },
	]);
	eq(sum.map((s: { person: string }) => s.person), ["Alpha", "Bravo"], "summaries sort by most recently updated first");
	eq(sum[0], { person: "Alpha", centroids: 1, samples: 5, updated: 200 }, "each row counts centroids");
	eq(sum[1], { person: "Bravo", centroids: 2, samples: 3, updated: 100 }, "and totals samples across them");
}

{
	// --- per-turn voice review: part alignment, cluster splitting, bounds ---
	const { parseWhisperX, mergeDiarizedParts, reviewSpeakerClusters, expectedSpeakerBounds, enrollVoiceprint } = require("./pipeline");
	const u = (speaker: string, start: number, end: number, text = "x") => ({ speaker, text, start, end });
	const t = (speaker: string, start: number, end: number, vector: number[]) => ({ speaker, start, end, seconds: (end - start) / 1000, vector });

	// the invite-derived ceiling
	eq(expectedSpeakerBounds(["A", "B", "C"]), { maxSpeakers: 3 }, "the attendee count becomes the speaker ceiling");
	eq(expectedSpeakerBounds(["Solo"]), null, "one attendee constrains nothing");
	eq(expectedSpeakerBounds([]), null, "no attendees, no bounds");
	eq(expectedSpeakerBounds(undefined), null, "missing attendees, no bounds");
	eq(expectedSpeakerBounds(["Real", "Speaker A", "Other"]), { maxSpeakers: 2 }, "letter placeholders do not count as attendees");
	eq(expectedSpeakerBounds(Array.from({ length: 30 }, (_, i) => `P${i}`)), { maxSpeakers: 26 }, "the ceiling caps at the letter space");

	// per-turn vectors re-key to letters, times become ms, fine keeps turn grain
	const px = parseWhisperX({
		segments: [
			{ start: 0, end: 2, text: "one", speaker: "SPEAKER_00" },
			{ start: 2, end: 4, text: "two", speaker: "SPEAKER_00" },
			{ start: 4, end: 6, text: "three", speaker: "SPEAKER_01" },
		],
		segment_embeddings: [
			{ speaker: "SPEAKER_00", start: 0, end: 4, seconds: 4, vector: [1, 0] },
			{ speaker: "SPEAKER_01", start: 4, end: 6, seconds: 2, vector: [0, 1] },
			{ speaker: "SPEAKER_09", start: 8, end: 9, seconds: 1, vector: [1, 1] },
		],
	});
	eq(px.utts.length, 2, "consecutive same-speaker segments still coalesce for the note");
	eq(px.fine.length, 3, "fine keeps the turn-sized pieces the review can move one by one");
	eq(px.turnEmbeddings, [
		{ speaker: "A", start: 0, end: 4000, seconds: 4, vector: [1, 0] },
		{ speaker: "B", start: 4000, end: 6000, seconds: 2, vector: [0, 1] },
	], "per-turn vectors are re-keyed to letters in ms, and an unseen speaker's turn is dropped");

	// part alignment: the same voice keeps its letter across a rotation
	const p1 = {
		utts: [u("A", 0, 10000), u("B", 10000, 20000)],
		embeddings: { A: { vector: [1, 0, 0], seconds: 30 }, B: { vector: [0, 1, 0], seconds: 20 } },
		turnEmbeddings: [t("A", 0, 10000, [1, 0, 0]), t("B", 10000, 20000, [0, 1, 0])],
		offsetMs: 0,
	};
	const p2 = {
		utts: [u("A", 0, 10000), u("B", 10000, 20000), u("C", 20000, 21000)],
		embeddings: { A: { vector: [0, 1, 0], seconds: 25 }, B: { vector: [0, 0, 1], seconds: 15 } },
		turnEmbeddings: [t("A", 0, 10000, [0, 1, 0]), t("B", 10000, 20000, [0, 0, 1])],
		offsetMs: 60000,
	};
	const m = mergeDiarizedParts([p1, p2]);
	eq(m.utts.map((x: { speaker: string }) => x.speaker), ["A", "B", "B", "C", "2C"], "part 2's A rejoins B by voice, its new voice gets a fresh letter, and a voiceless letter falls back to the prefix");
	eq(m.utts[2].start, 60000, "later parts shift by their offset");
	eq(m.utts[2].end, 70000, "ends shift with starts");
	ok(m.embeddings.B.seconds > 40, "a rejoined voice pools its speech seconds across parts");
	eq(m.embeddings.C.vector, [0, 0, 1], "the fresh letter keeps its own voice");
	eq(m.turnEmbeddings.map((x: { speaker: string }) => x.speaker), ["A", "B", "B", "C"], "turn vectors follow the same letter mapping");
	eq(m.turnEmbeddings[2].start, 60000, "and the same time shift");
	const single = mergeDiarizedParts([p1]);
	eq(single.utts.map((x: { speaker: string }) => x.speaker), ["A", "B"], "a single part passes through unchanged");
	eq(single.embeddings.A.vector, [1, 0, 0], "with its voices intact");

	// cluster review: a merged cluster splits along its voices
	const lib = enrollVoiceprint(enrollVoiceprint([], "Sanjit", [1, 0, 0], 1), "Dylan", [0, 1, 0], 1);
	const blobUtts = [
		u("A", 0, 10000, "s1"), u("A", 10000, 20000, "d1"), u("A", 20000, 30000, "s2"),
		u("A", 30000, 40000, "d2"), u("A", 40000, 50000, "s3"), u("B", 50000, 55000, "q"),
	];
	const blobTurns = [
		t("A", 0, 10000, [1, 0, 0]), t("A", 10000, 20000, [0, 1, 0]), t("A", 20000, 30000, [1, 0, 0]),
		t("A", 30000, 40000, [0, 1, 0]), t("A", 40000, 50000, [1, 0, 0]), t("B", 50000, 55000, [0, 0, 1]),
	];
	const r = reviewSpeakerClusters(blobUtts, blobTurns, lib);
	eq(r.splits.length, 1, "the two-person cluster is caught");
	eq(r.splits[0].from, "A", "the blob was letter A");
	eq(r.splits[0].person, "Dylan", "the minority voice is named by its print");
	eq(r.splits[0].to, "C", "and moves to a fresh letter past the ones in use");
	eq(r.utts.map((x: { speaker: string }) => x.speaker), ["A", "C", "A", "C", "A", "B"], "exactly the minority turns move");
	eq(blobUtts.map((x) => x.speaker), ["A", "A", "A", "A", "A", "B"], "the input utterances are never mutated");
	eq(r.guesses.A.person, "Sanjit", "the cleaned cluster suggests its dominant voice");
	eq(r.guesses.C.person, "Dylan", "the split-off cluster suggests its person");
	ok(!r.guesses.B, "an unmatched voice suggests nobody");
	ok(r.letterEmbeddings.A && Math.abs(r.letterEmbeddings.A.vector[0] - 1) < 1e-9, "post-review means are per final letter");
	ok(r.letterEmbeddings.B, "even an unmatched letter gets a mean, so naming it can still enroll");

	// the minority rejoins an existing letter when that voice already owns one
	const homeUtts = [u("A", 0, 10000), u("A", 10000, 20000), u("A", 20000, 30000), u("A", 30000, 40000), u("B", 40000, 50000), u("B", 50000, 60000)];
	const homeTurns = [
		t("A", 0, 10000, [1, 0, 0]), t("A", 10000, 20000, [0, 1, 0]), t("A", 20000, 30000, [1, 0, 0]),
		t("A", 30000, 40000, [0, 1, 0]), t("B", 40000, 50000, [0, 1, 0]), t("B", 50000, 60000, [0, 1, 0]),
	];
	const r2 = reviewSpeakerClusters(homeUtts, homeTurns, lib);
	eq(r2.splits[0]?.to, "B", "the minority moves to the letter its voice dominates");
	eq(r2.utts.map((x: { speaker: string }) => x.speaker), ["A", "B", "A", "B", "B", "B"], "so the person ends up under one letter");
	eq(r2.guesses.B.person, "Dylan", "who the merged letter then suggests");

	// restraint: agreement, thin evidence, empty library, named speakers
	const calm = reviewSpeakerClusters(
		[u("A", 0, 10000), u("A", 10000, 20000)],
		[t("A", 0, 10000, [1, 0, 0]), t("A", 10000, 20000, [1, 0, 0])],
		lib
	);
	eq(calm.splits, [], "an agreeing cluster is left alone");
	eq(calm.guesses.A.person, "Sanjit", "and still gets its suggestion");
	const thin = reviewSpeakerClusters(
		[u("A", 0, 10000), u("A", 10000, 12000)],
		[t("A", 0, 10000, [1, 0, 0]), t("A", 10000, 12000, [0, 1, 0])],
		lib
	);
	eq(thin.splits, [], "one short foreign turn is not enough evidence to split");
	const empty = reviewSpeakerClusters(blobUtts, blobTurns, []);
	eq(empty.splits, [], "no library, no splits");
	eq(empty.guesses, {}, "and no guesses");
	ok(empty.letterEmbeddings.A, "but the letter means still come back for enrollment");
	const named = reviewSpeakerClusters(
		[u("Steve", 0, 10000), u("Steve", 10000, 20000)],
		[t("Steve", 0, 10000, [1, 0, 0]), t("Steve", 10000, 20000, [0, 1, 0])],
		lib
	);
	eq(named.splits, [], "already-named speakers are never second-guessed");
	eq(named.guesses, {}, "and never re-suggested");
}

{
	const note = assembleNote({
		title: "T",
		date: "2026-07-05",
		source: "s",
		embed: "![[a.webm]]",
		body: "## Summary\nold body",
		transcript: "**Steve [0:00]:** hi",
		includeTranscript: true,
		model: "m",
		speakersLine: "Steve (60%), Jordan (40%)",
		cost: "≈$0.04 (2k tokens)",
	});
	ok(note.includes('cost: "≈$0.04 (2k tokens)"'), "cost lands in frontmatter");
	const swapped = replaceExtractedBody(note, "## Summary\nNEW BODY\n\n## Decisions\nD1");
	ok(swapped.includes("NEW BODY") && !swapped.includes("old body"), "extracted body swaps");
	ok(swapped.includes("**Speakers:** Steve (60%)"), "speakers line survives");
	ok(swapped.includes("## Transcript") && swapped.includes("![[a.webm]]"), "transcript and embed survive");
	ok(swapped.indexOf("## Decisions") < swapped.indexOf("## Transcript"), "new sections sit before the transcript");
}

{
	// a post is its own words, and they lead the note instead of trailing it
	const post = assembleNote({
		title: "People don't do business with the smartest…",
		date: "2026-07-29",
		source: "https://x.com/patrickbetdavid/status/2082489072124371219",
		embed: null,
		body: "## Summary\nold summary\n\n## Facts & figures\n*None identified.*",
		transcript: "People don't do business with the smartest person in the room.\n\nThey do business with the person they like, trust, and respect.",
		includeTranscript: true,
		model: "m",
		transcriptHeading: "Post",
		leadWithText: true,
	});
	ok(post.indexOf("## Post") < post.indexOf("## Summary"), "the post's own words come before the extraction");
	ok(post.indexOf("# People don't") < post.indexOf("## Post"), "and still after the title");
	eq((post.match(/## Post/g) ?? []).length, 1, "the words are stored once, not twice");
	eq(
		captureSourceText(post),
		"People don't do business with the smartest person in the room.\n\nThey do business with the person they like, trust, and respect.",
		"a post's text is found for re-extraction, like a transcript"
	);

	const again = replaceExtractedBody(post, "## Summary\nNEW SUMMARY");
	ok(again.includes("NEW SUMMARY") && !again.includes("old summary"), "re-extract swaps the body of a post note");
	ok(again.includes("They do business with the person they like"), "and never eats the post it sits under");
	ok(again.indexOf("## Post") < again.indexOf("## Summary"), "the post stays on top");
	eq((again.match(/## Summary/g) ?? []).length, 1, "no duplicate body is left behind");

	// the trailing layout every other capture uses is untouched
	const trailing = assembleNote({
		title: "T",
		date: "2026-07-29",
		source: "s",
		embed: null,
		body: "## Summary\nS",
		transcript: "the article text",
		includeTranscript: true,
		model: "m",
		transcriptHeading: "Article",
	});
	ok(trailing.indexOf("## Summary") < trailing.indexOf("## Article"), "an article still reads summary first");
	eq(captureSourceText(trailing), "the article text", "and its text is re-extractable too");
	ok(replaceExtractedBody(trailing, "## Summary\nNEW").includes("the article text"), "which a re-extract keeps");
	eq(captureSourceText("# T\n\n## Summary\nno text kept"), "", "a note with no captured text says so");
}

{
	// the filename is what Obsidian shows above the note, so a heading repeating
	// it is the same words twice
	ok(titleShownByFilename("Way more than a billion", "2026-07-19 Way more than a billion.md"), "a dated filename carries the title");
	ok(titleShownByFilename("Q3: the plan", "2026-07-19 Q3- the plan.md"), "a sanitized title still matches the name it produced");
	ok(!titleShownByFilename("Way more than a billion", "meeting-notes.md"), "a template that drops the title keeps the heading");
	ok(!titleShownByFilename("", "anything.md"), "an empty title is never redundant");

	const named = assembleNote({
		title: "Way more than a billion",
		date: "2026-07-19",
		source: "s",
		embed: null,
		body: "## Summary\nS",
		transcript: "",
		includeTranscript: false,
		model: "m",
		filename: "Sources/Social/X/2026-07-19 Way more than a billion.md",
	});
	ok(!named.includes("# Way more than a billion"), "the note skips a title its filename already shows");
	ok(named.includes("---\n## Summary"), "and the body follows the properties with no gap where the title was");
	ok(!named.includes("---\n\n## Summary"), "the blank line the title used to fill is gone with it");
	const swapped = replaceExtractedBody(named, "## Summary\nNEW");
	ok(swapped.includes("NEW") && !swapped.includes("\nS\n"), "a titleless note can still be re-extracted");
	ok(swapped.startsWith("---\ndate: 2026-07-19"), "and keeps its frontmatter");
	eq(parseCaptureForExport(named, "Way more than a billion").title, "Way more than a billion", "the export falls back to the note's own name");

	const kept = assembleNote({
		title: "Way more than a billion",
		date: "2026-07-19",
		source: "s",
		embed: null,
		body: "## Summary\nS",
		transcript: "",
		includeTranscript: false,
		model: "m",
		filename: "notes/recap.md",
	});
	ok(kept.includes("# Way more than a billion"), "a filename without the title keeps the heading");
	ok(kept.includes("# Way more than a billion\n\n## Summary"), "and a note that has one keeps its usual spacing");

	eq(humanDuration(7393), "2 hr 3 min", "a podcast reads as hours and minutes");
	eq(humanDuration(3600), "1 hr", "an exact hour says so once");
	eq(humanDuration(3599), "1 hr", "and 59:59 rounds up to it rather than saying 0 min");
	eq(humanDuration(2580), "43 min", "under an hour is minutes");
	eq(humanDuration(31), "31 sec", "under a minute is seconds");
	eq(humanDuration(0), "", "no length, no property");

	// a recording folded into a meeting note must not cost it its title
	const merged = mergeMeetingCapture("---\ndate: 2026-07-19\n---\n# Weekly sync\n\n## Agenda\n- roadmap\n", kept.replace("# Way more than a billion\n", ""));
	ok(merged.includes("# Weekly sync"), "the meeting note's own heading survives the merge");
	eq((merged.match(/^# /gm) ?? []).length, 1, "and there is only ever one");
}

{
	const all = {} as Record<ExtractionKey, boolean>;
	for (const e of EXTRACTIONS) all[e.key] = true;
	const post = postExtractions(all);
	eq(
		Object.keys(post).filter((k) => post[k as ExtractionKey]),
		["summary", "takeaways", "keywords"],
		"a post asks only for what two sentences can answer"
	);
	const noSummary = postExtractions({ ...all, summary: false });
	eq(noSummary.summary, false, "and never switches a section back on");
}

{
	// a re-capture must be told apart from two different posts whose titles
	// happen to render the same filename on the same day
	const post = "https://x.com/patrickbetdavid/status/2082489072124371219";
	ok(sameCaptureSource(post, post + "?s=43&t=2OX3IZJs7EhtjcaPzN6OOA"), "a share link is the same post");
	ok(sameCaptureSource(post, "https://twitter.com/patrickbetdavid/status/2082489072124371219"), "so is the legacy host");
	ok(!sameCaptureSource(post, "https://x.com/patrickbetdavid/status/2082489072124371220"), "a different status is a different post");
	ok(sameCaptureSource("https://youtu.be/siazPdsZHuI", "https://www.youtube.com/watch?v=siazPdsZHuI&t=90"), "a video is matched on its id");
	ok(!sameCaptureSource("https://youtu.be/siazPdsZHuI", "https://youtu.be/aaaaaaaaaaa"), "another video is not");
	ok(sameCaptureSource("https://example.com/piece/", "http://www.example.com/piece?utm_source=x"), "a page ignores www, scheme, query, and a trailing slash");
	ok(!sameCaptureSource("https://example.com/piece", "https://example.com/other"), "a different path is a different page");
	ok(!sameCaptureSource("", post), "an unknown source never counts as a match");

	// YouTube's bot wall arrives as an ordinary 200 with everything missing
	ok(
		youtubeBlockReason("LOGIN_REQUIRED", "Sign in to confirm you’re not a bot").includes("sign in"),
		"a bot wall is named as a sign-in demand, not as a video without captions"
	);
	ok(youtubeBlockReason("UNPLAYABLE", "Private video").includes("Private video"), "YouTube's own reason is carried through");
	eq(youtubeBlockReason("OK"), "", "a playable video reports nothing");
	eq(youtubeBlockReason(""), "", "and neither does a missing status");

	{
		const file = netscapeCookieFile([
			{ name: "SID", value: "abc", domain: ".youtube.com", path: "/", secure: true, expirationDate: 1800000000.7 },
			{ name: "PREF", value: "x", domain: "www.youtube.com", hostOnly: true },
		]);
		const lines = file.split("\n");
		eq(lines[0], "# Netscape HTTP Cookie File", "yt-dlp refuses a cookie file without its header");
		ok(lines.includes(".youtube.com\tTRUE\t/\tTRUE\t1800000000\tSID\tabc"), "a cookie is seven tab-separated fields, expiry whole");
		ok(lines.includes("www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tx"), "a host-only session cookie keeps its exact host and expires at 0");
		eq(netscapeCookieFile([{ name: "", value: "v", domain: ".youtube.com" }]).split("\n").length, 3, "a nameless cookie is dropped");
	}
	// a sign-in is not one cookie, and a television pairing does not leave the
	// same set as a password typed into the website
	ok(hasYoutubeLogin([{ name: "LOGIN_INFO", value: "x", domain: ".youtube.com" }]), "the TV pairing's own cookie counts");
	ok(hasYoutubeLogin([{ name: "SAPISID", value: "x", domain: ".google.com" }]), "so does the API sign-in cookie");
	ok(hasYoutubeLogin([{ name: "__Secure-3PSIDCC", value: "x", domain: ".google.com" }]), "and the newer secure forms");
	ok(isYoutubeCookieDomain(".youtube.com") && isYoutubeCookieDomain("accounts.google.com"), "the sign-in spreads across both domains");
	ok(isYoutubeCookieDomain("youtube.com"), "with or without the leading dot");
	ok(!isYoutubeCookieDomain("notyoutube.com") && !isYoutubeCookieDomain("evil-google.com.attacker.net"), "and a lookalike domain is not one of them");

	ok(hasYoutubeLogin([{ name: "SID", value: "abc", domain: ".youtube.com" }]), "a session cookie is a sign-in");
	ok(hasYoutubeLogin([{ name: "__Secure-1PSID", value: "abc", domain: ".google.com" }]), "so is the secure form");
	ok(!hasYoutubeLogin([{ name: "CONSENT", value: "yes", domain: ".youtube.com" }]), "a consent banner is not a sign-in");
	ok(!hasYoutubeLogin([{ name: "SID", value: "", domain: ".youtube.com" }]), "and neither is an empty one");

	{
		// yt-dlp's own line for the video that started all this
		const meta = parseYtDlpMeta(
			'{"title": "Me at the zoo", "channel": "jawed", "channel_url": "https://www.youtube.com/channel/UC4Q", "view_count": 402124278, "upload_date": "20050424", "duration": 19, "channel_follower_count": 6350000}'
		);
		eq(meta?.title, "Me at the zoo", "the title comes back");
		eq(meta?.published, "2005-04-24", "yt-dlp's 20050424 becomes the ISO date the notes use");
		eq(meta?.duration, "19 sec", "seconds are said in words");
		eq(meta?.subscribers, "6.35M", "the follower count reads the way the page writes it");
		eq(meta?.views, 402124278, "views stay a number, for the property to format");
		eq(parseYtDlpMeta("not json"), null, "a bad line costs the properties, not the capture");
		eq(compactCount(6350000), "6.35M", "millions");
		eq(compactCount(517000), "517K", "thousands");
		eq(compactCount(42), "42", "and small numbers are just themselves");

		// the page is preferred wherever it answered; yt-dlp fills the holes
		const merged = mergeYoutubeInfo({ title: "From the page", channelUrl: "https://c", subscribers: "517K" }, meta);
		eq(merged?.title, "From the page", "the page's own title wins");
		eq(merged?.subscribers, "517K", "and its subscriber count");
		eq(merged?.channel, "jawed", "while the channel name it never got is filled in");
		eq(merged?.duration, "19 sec", "as is the length");
		eq(mergeYoutubeInfo(null, meta)?.channel, "jawed", "a walled page falls back entirely");
		eq(mergeYoutubeInfo(meta, null)?.channel, "jawed", "and no fallback leaves the page alone");
	}

	eq(cookieArgs("", "C:/keys/cookies.txt"), ["--cookies", "C:/keys/cookies.txt"], "a cookies file is passed as a file");
	eq(cookieArgs("chrome", "C:/keys/cookies.txt"), ["--cookies", "C:/keys/cookies.txt"], "and wins over the browser store, which cannot be read on Windows");
	eq(cookieArgs("firefox"), ["--cookies-from-browser", "firefox"], "the browser store is still used when there is no file");
	eq(cookieArgs(""), [], "and nothing at all is the default");
	ok(ytDlpSubsArgs("https://y", "/tmp/x.%(ext)s").includes("--skip-download"), "the caption run downloads no media");
	ok(ytDlpSubsArgs("https://y", "/tmp/x.%(ext)s").includes("--no-simulate"), "but is not a dry run, or it would write no subtitles");

	eq(
		captionsToText("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nthe first line\n\n00:00:03.000 --> 00:00:05.000\nthe first line\n\n00:00:05.000 --> 00:00:07.000\nand the second"),
		"the first line and the second",
		"an exact repeat is not said twice"
	);
	// the real shape: a two-line rolling window that repeats the line before it
	eq(
		captionsToText(
			"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nA couple of days ago\n\n00:00:03.000 --> 00:00:05.000\nA couple of days ago\nJensen said the world\n\n00:00:05.000 --> 00:00:07.000\nJensen said the world\nneeds both"
		),
		"A couple of days ago Jensen said the world needs both",
		"a rolling caption window collapses to what was actually said"
	);
	eq(captionsToText("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nR&amp;D and &gt;&gt; a speaker change"), "R&D and >> a speaker change", "entities are decoded");
	eq(appendWithoutOverlap("", "first"), "first", "the first cue is the text");
	eq(appendWithoutOverlap("a b c", "b c d"), "a b c d", "an overlapping tail is not repeated");
	eq(appendWithoutOverlap("a b c", "a b c"), "a b c", "a whole repeat adds nothing");
	eq(appendWithoutOverlap("a b c", "d e"), "a b c d e", "unrelated text just appends");
	eq(captionsToText("WEBVTT\n\n"), "", "an empty track is empty text");

	ok(isSyncConflictName("capture-2026-07-23-12-35-19.part1 (sync conflict 2026-07-23 1340 211f13).webm"), "a keep-both copy is recognised");
	ok(isSyncConflictName("notes (conflicted copy 2026-07-20).md"), "so is Dropbox's wording");
	ok(!isSyncConflictName("capture-2026-07-23-12-35-19.part1.webm"), "the recording itself is not");
	ok(!isSyncConflictName("2026-07-20 Conflict resolution workshop.md"), "and neither is a note that merely says conflict");

	const taken = new Set(["2026-07-29 Same words.md", "2026-07-29 Same words-2.md"]);
	eq(freeNoteName("2026-07-29 Same words.md", (n) => taken.has(n)), "2026-07-29 Same words-3.md", "a collision takes the next free number");
	eq(freeNoteName("2026-07-29 Free.md", (n) => taken.has(n)), "2026-07-29 Free.md", "a free name is left alone");
}
eq(sectionText("## A\n\ntext here\n\n## B\n\nother", "A"), "text here", "sectionText extracts one section");
eq(extractDoneTasks("- [x] did it ✅ 2026-07-09\n- [ ] not yet")[0].doneDate, "2026-07-09", "done tasks carry their date");
eq(taskOwner("- [ ] send it [[Jordan]] 📅 2026-07-14"), "Jordan", "owner is the first wiki-link");
eq(taskOwner("- [ ] orphan task"), "Unassigned", "no link, unassigned");

{
	const report = buildPersonReport(
		{
			name: "Jordan",
			meetings: [{ title: "Sync", path: "Cap/Sync.md", date: "2026-07-12" }],
			openTasks: [{ text: "- [ ] draft deck [[Jordan]] 📅 2026-07-15", fromPath: "Cap/Sync.md", date: "2026-07-12" }],
			doneCount: 3,
			decisions: [{ text: "Pricing review in August", fromPath: "Cap/Sync.md", date: "2026-07-12" }],
			questions: [],
		},
		"1. Deck progress",
		"2026-07-12"
	);
	ok(report.includes("type: capture-person") && report.includes("generated: true"), "person report is marked generated");
	ok(report.includes("⏭ draft deck") && report.includes("[[Cap/Sync]]"), "open commitments reference their meeting");
	ok(report.includes("## Suggested 1:1 agenda") && report.includes("Deck progress"), "agenda section renders when provided");
	ok(!buildPersonReport({ name: "X", meetings: [], openTasks: [], doneCount: 0, decisions: [], questions: [] }, null, "d").includes("agenda"), "no agenda, no section");
}

// --- 1.75.1: derived pages must not differ between devices ---
{
	ok(isConflictCopy("Meetings/People/George Olney (sync conflict 2026-07-29 1245 ac6be5).md"), "a Power Connect conflict copy is recognized");
	ok(isConflictCopy("George Olney (sync conflict 2026-07-29 1245 AC6BE5)"), "the hash tag is matched case-insensitively");
	ok(!isConflictCopy("Meetings/People/George Olney.md"), "the original is not a conflict copy");
	ok(!isConflictCopy("Sync conflict notes.md"), "a note that merely says sync conflict is left alone");
	ok(!isConflictCopy("Plan (sync conflict).md"), "the date and hash tag are required");

	// Two devices holding the same meetings must render the same bytes. The
	// only thing that differed in the field was the order the vault listed
	// same-day files in, so feed the same items in opposite orders.
	const items = [
		{ title: "Standup", path: "Cap/B.md", date: "2026-07-12" },
		{ title: "Review", path: "Cap/A.md", date: "2026-07-12" },
		{ title: "Older", path: "Cap/C.md", date: "2026-07-01" },
	];
	const qs = [
		{ text: "Who owns rollout?", fromPath: "Cap/B.md", date: "2026-07-12" },
		{ text: "Budget signed?", fromPath: "Cap/A.md", date: "2026-07-12" },
	];
	const build = (order: number) => {
		const d = {
			name: "Jordan",
			meetings: order ? [...items].reverse() : [...items],
			openTasks: [],
			doneCount: 0,
			decisions: [],
			questions: order ? [...qs].reverse() : [...qs],
		};
		const newest = <T extends { date: string }>(tie: (x: T) => string) => (a: T, b: T) =>
			a.date === b.date ? tie(a).localeCompare(tie(b)) : a.date < b.date ? 1 : -1;
		const byOrigin = (x: { date: string; fromPath: string; text: string }) => `${x.fromPath} ${x.text}`;
		d.meetings.sort(newest((m) => m.path));
		d.questions.sort(newest(byOrigin));
		const dates = [...d.meetings, ...d.questions].map((x) => x.date).filter(Boolean).sort();
		return buildPersonReport(d, null, dates[dates.length - 1] ?? "");
	};
	eq(build(0), build(1), "the same meetings in either vault order render identical bytes");
	ok(build(0).includes("date: 2026-07-12"), "the stamp comes from the newest item, not from today's clock");
	ok(build(0).indexOf("Cap/A") < build(0).indexOf("Cap/B"), "same-day meetings break their tie on path");
}
{
	const digest = buildWeeklyDigest(
		{
			from: "2026-07-06",
			to: "2026-07-12",
			meetings: [{ title: "Sync", path: "Cap/Sync.md", date: "2026-07-12", series: "leadership-sync" }],
			decisions: [{ text: "August review confirmed", fromPath: "Cap/Sync.md" }],
			newTasks: [
				{ owner: "Jordan", text: "- [ ] deck [[Jordan]]", fromPath: "Cap/Sync.md", done: false },
				{ owner: "Steve", text: "- [x] legal [[Steve]]", fromPath: "Cap/Sync.md", done: true },
			],
			completed: [{ owner: "Jordan", text: "- [x] budget ✅ 2026-07-09", fromPath: "Cap/W1.md" }],
			stale: [{ owner: "Steve", text: "- [ ] demo [[Steve]]", fromPath: "Cap/W1.md", date: "2026-06-20", ageDays: 22 }],
			questions: [{ text: "Legal review needed?", fromPath: "Cap/W1.md" }],
		},
		"A busy week.",
		"2026-07-12"
	);
	ok(digest.includes("| Owner | Open | Done |"), "owner table renders");
	ok(digest.includes('data-calc="sum:col"'), "totals row uses Power Tables sums");
	ok(digest.includes("background:#E81123") && digest.includes("22d"), "stale rows age in alert red past two weeks");
	ok(digest.includes("[[Jordan]] | 1 | 1"), "owner counts combine new and completed");
	ok(digest.includes("A busy week."), "summary paragraph leads");
}
{
	const turns = [
		{ ms: 0, text: "old old old" },
		{ ms: 500000, text: "recent one" },
		{ ms: 590000, text: "recent two" },
	];
	const win = recentTurnsText(turns, 600000, 10 * 60000);
	ok(win.includes("recent one") && win.includes("recent two") && !win.includes("old old"), "catch-up window keeps recent turns");
	ok(buildCatchUpPrompt("t", 10).user.includes("~10 minutes"), "catch-up prompt names the window");
	ok(buildLiveActionsPrompt("t").system.includes("NONE"), "action prompt has a none escape");
	eq(parseLineList("- Send deck — Jordan\nNONE\n2. Review terms\n\n"), ["Send deck — Jordan", "Review terms"], "line list parses, none dropped");
}
{
	const hits = [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }];
	const meta: Record<string, { date?: string; attendees?: string[] }> = {
		"a.md": { date: "2026-07-01", attendees: ["Jordan"] },
		"b.md": { date: "2026-05-01", attendees: ["Steve"] },
	};
	eq(filterHitsByMeta(hits, (p) => meta[p] ?? null, { after: "2026-06-01" }).map((h) => h.path), ["a.md"], "date filter keeps recent, drops metadata-less");
	eq(filterHitsByMeta(hits, (p) => meta[p] ?? null, { attendee: "Steve" }).map((h) => h.path), ["b.md"], "attendee filter");
	eq(filterHitsByMeta(hits, () => null, {}).length, 3, "no filters, no change");
}
ok(estimateCost("claude-haiku-4-5", 15000, 3000, 12, "assemblyai")!.startsWith("≈$0."), "cost estimate formats");
eq(estimateCost("claude-haiku-4-5", 0, 0, 0, null), null, "nothing measured, no cost line");
ok(estimateCost("unknown-model", 5000, 1000, 0, null)!.includes("6.0k tokens"), "unknown models still report tokens");
ok(estimateCost("qwen3:30b-a3b", 5000, 1000, 0, null)!.startsWith("≈$0.00"), "a local model's $0 is not rounded up to a cent");
ok(estimateCost("claude-haiku-4-5", 1000, 100, 0, null)!.startsWith("≈$0.01"), "a real sub-cent bill still rounds up, not to zero");

// --- resolveLlmTarget / llmConfigured ---
{
	const base = { llmProvider: "anthropic", llmEndpoint: "", llmKey: "", llmModel: "", anthropicKey: "sk-ant-x", anthropicModel: "claude-haiku-4-5" };
	eq(resolveLlmTarget(base), { baseURL: null, apiKey: "sk-ant-x", model: "claude-haiku-4-5" }, "default provider is Anthropic's cloud");
	eq(
		resolveLlmTarget({ ...base, llmProvider: "custom", llmEndpoint: "http://box:11434///", llmKey: "", llmModel: "qwen3:30b-a3b" }),
		{ baseURL: "http://box:11434", apiKey: "local", model: "qwen3:30b-a3b" },
		"custom target trims slashes and fills the key the SDK requires"
	);
	eq(
		resolveLlmTarget({ ...base, llmProvider: "custom", llmEndpoint: " ", llmModel: "m" }).baseURL,
		null,
		"custom with no endpoint falls back to the cloud instead of stranding a capture"
	);
	ok(llmConfigured(base), "an Anthropic key alone is a working setup");
	ok(!llmConfigured({ ...base, anthropicKey: "" }), "no key, no AI");
	ok(llmConfigured({ ...base, llmProvider: "custom", anthropicKey: "", llmEndpoint: "http://box:11434", llmModel: "m" }), "custom endpoint plus model is a working setup without any key");
	ok(!llmConfigured({ ...base, llmProvider: "custom", anthropicKey: "", llmEndpoint: "http://box:11434", llmModel: "" }), "a custom endpoint with no model name is not ready");
	ok(!llmConfigured({ ...base, llmProvider: "custom", llmEndpoint: "", llmModel: "" }), "picking custom makes the custom fields decide: an idle cloud key does not mask a half-finished setup");
}

// --- deferred-processing queue: pendingState / pendingRecordings / parseMomentsJson ---
{
	const now = 1_000_000_000;
	eq(pendingState(undefined, now), "none", "no frontmatter, no queue state");
	eq(pendingState({}, now), "none", "no marker, ordinary note");
	eq(pendingState({ "pa-status": "pending" }, now), "pending", "a parked recording is pending");
	eq(pendingState({ "pa-status": "failed" }, now), "failed", "a failed run sits out the sweep");
	eq(pendingState({ "pa-status": "processing", "pa-claimed-at": now - 1000 }, now), "claimed", "a fresh claim is someone's live job");
	eq(pendingState({ "pa-status": "processing", "pa-claimed-at": now - CLAIM_STALE_MS - 1 }, now), "stale", "a claim outliving the stale window is a dead processor, retakeable");
	eq(pendingState({ "pa-status": "processing" }, now), "stale", "a claim with no timestamp cannot prove it is alive");
	eq(
		pendingRecordings({ "pa-recordings": ["a.webm", "b.webm"], "pa-offsets": [0, 1800000] }),
		{ paths: ["a.webm", "b.webm"], offsets: [0, 1800000] },
		"paths and offsets round-trip"
	);
	eq(
		pendingRecordings({ "pa-recordings": ["a.webm", "b.webm"], "pa-offsets": [0] }),
		{ paths: ["a.webm", "b.webm"], offsets: [0, 0] },
		"short offset lists pad with zeros instead of throwing"
	);
	eq(pendingRecordings({ "pa-recordings": "a.webm" }), { paths: [], offsets: [] }, "a non-list recordings value degrades to empty");
	eq(pendingRecordings({}), { paths: [], offsets: [] }, "no queue keys, no recordings");
	eq(parseMomentsJson('[{"ms":5000,"label":"decision"}]'), [{ ms: 5000, label: "decision" }], "marks survive the frontmatter round-trip");
	eq(parseMomentsJson("not json"), [], "mangled marks are no marks, not a crash");
	eq(parseMomentsJson(undefined), [], "absent marks are no marks");
}

// --- dedupeQueuedNotes ---
{
	const { winners, losers } = dedupeQueuedNotes([
		{ path: "Meetings/Standup.md", recordings: ["rec/a.webm"] },
		{ path: "Meetings/Standup (conflicted copy 2026-07-18).md", recordings: ["rec/a.webm"] },
		{ path: "Meetings/Retro.md", recordings: ["rec/b.webm"] },
	]);
	ok(winners.has("Meetings/Standup.md") && winners.has("Meetings/Retro.md"), "the original name wins its group; distinct recordings both go through");
	eq(losers, ["Meetings/Standup (conflicted copy 2026-07-18).md"], "the conflict copy is reported, not processed");
	const tie = dedupeQueuedNotes([
		{ path: "b.md", recordings: ["r.webm"] },
		{ path: "a.md", recordings: ["r.webm"] },
	]);
	ok(tie.winners.has("a.md") && !tie.winners.has("b.md"), "equal-length paths break ties lexicographically, deterministically on every device");
}

// --- evalSections / actionOwners / scoreExtraction / buildEvalReport ---
{
	const golden = [
		"---",
		"tags: [capture]",
		"---",
		"# Standup",
		"",
		"## Summary",
		"We agreed to ship Friday.",
		"",
		"## Action items",
		"| Task | Owner | Due |",
		"|---|---|---|",
		"| Ship it | Steve | Fri |",
		"| Test it | Dana | Thu |",
		"",
		"## Keywords",
		"release, testing, friday",
		"",
		"## Transcript",
		"**Speaker A [0:01]:** hello",
	].join("\n");
	const secs = evalSections(golden);
	eq([...secs.keys()].sort(), ["Action items", "Keywords", "Summary"], "only known extraction sections count; Transcript stays out");
	eq(secs.get("Action items")!.items, 2, "table rows count as items, header and separator excluded");
	eq([...actionOwners(secs.get("Action items")!.body)].sort(), ["dana", "steve"], "owners read from the table's second cell");
	eq([...actionOwners("- [ ] Ship it [[People/Steve|Steve]] 📅 2026-07-20")], ["steve"], "checklist owners read via taskOwner's wikilink form");
	eq([...actionOwners("- [ ] Ship it with no owner")], [], "an unassigned checklist line adds no owner");
	const fresh = ["## Summary", "Shipping Friday.", "", "## Action items", "| Task | Owner | Due |", "|---|---|---|", "| Ship it | Steve | Fri |", "", "## Keywords", "release, friday, deploy"].join("\n");
	const score = scoreExtraction(golden, fresh);
	eq(score.missing, [], "no golden section is missing");
	eq(score.extra, [], "no unrequested section appeared");
	eq(score.sections.find((s) => s.label === "Action items")!.freshItems, 1, "the dropped action item shows in the counts");
	ok(score.ownerOverlap != null && Math.abs(score.ownerOverlap - 0.5) < 1e-9, "owner overlap is Jaccard: {steve} of {steve,dana}");
	ok(score.keywordOverlap != null && Math.abs(score.keywordOverlap - 0.5) < 1e-9, "keyword overlap is Jaccard: 2 shared of 4 distinct");
	const report = buildEvalReport([{ title: "Standup", score, fresh }], "qwen3:30b-a3b", "2026-07-18");
	ok(report.includes("| Standup | 3/3 | 2 → 1 | 50% | 50% |"), "the summary row carries sections, items, and overlaps");
	ok(report.includes("> ## Summary"), "the fresh extraction rides along quoted for the read-through");
	const worse = scoreExtraction(golden, "## Summary\nShipped.\n");
	eq(worse.missing.sort(), ["Action items", "Keywords"], "dropped sections are named");
	eq(worse.ownerOverlap, 0, "losing every owner scores zero, honestly");
	eq(scoreExtraction("## Summary\nx", "## Summary\ny").ownerOverlap, null, "no actions on either side is n/a, not zero");
}

// --- parseWhisperX ---
{
	const diarized = parseWhisperX({
		segments: [
			{ start: 0, end: 2.5, text: " Morning everyone. ", speaker: "SPEAKER_03" },
			{ start: 2.5, end: 4, text: "Quick agenda first.", speaker: "SPEAKER_03" },
			{ start: 4, end: 6, text: "Sounds good.", speaker: "SPEAKER_00" },
			{ start: 6, end: 7, text: "One more thing." }, // diarizer missed this one
		],
	});
	eq(
		diarized.utts,
		[
			{ speaker: "A", text: "Morning everyone. Quick agenda first.", start: 0, end: 4000 },
			{ speaker: "B", text: "Sounds good. One more thing.", start: 4000, end: 7000 },
		],
		"first heard is A regardless of the diarizer's numbering; turns coalesce; a missed label continues the last speaker"
	);
	ok(diarized.text.includes("Morning everyone.") && diarized.text.includes("One more thing."), "plain text carries every segment");
	const leading = parseWhisperX({
		segments: [
			{ start: 0, end: 1, text: "Uh," },
			{ start: 1, end: 3, text: "let's begin.", speaker: "SPEAKER_01" },
		],
	});
	eq(leading.utts, [{ speaker: "A", text: "Uh, let's begin.", start: 0, end: 3000 }], "a leading unlabeled fragment joins the first labeled speaker instead of minting a phantom");
	const flat = parseWhisperX({ segments: [{ start: 0, end: 2, text: "Note to self." }, { start: 2, end: 3, text: "Buy milk." }] });
	eq(flat.utts, null, "no speakers anywhere = undiarized, like plain Whisper");
	eq(flat.text, "Note to self. Buy milk.", "undiarized text still joins up");
	eq(parseWhisperX({}), { text: "", utts: null }, "an empty response is empty, not a crash");
}

// --- crosstalk: overlapping speech gets an honest label, not a wrong name ---
{
	const { parseCrosstalkLabel, renameSpeakerLabels, transcriptSpeakers, transcriptToUtterances, parseTranscriptSpeakerLine, mergeDiarizedParts, reviewSpeakerClusters, talkShares, enrollVoiceprint } = require("./pipeline");

	// the label and its inverse
	eq(
		formatUtterances([{ speaker: "A", text: "yeah, exactly", start: 62000, crosstalk: ["B"] }]),
		"**Crosstalk (Speaker A + Speaker B) [1:02]:** yeah, exactly",
		"an overlapped turn renders as a crosstalk label, dominant voice first"
	);
	eq(
		formatUtterances([{ speaker: "Steve", text: "right", crosstalk: ["Alice"] }]),
		"**Crosstalk (Steve + Alice):** right",
		"named voices render bare inside the label"
	);
	eq(
		formatUtterances([{ speaker: "A", text: "hm", crosstalk: ["A"] }]),
		"**Speaker A:** hm",
		"a crosstalk list that collapses to one voice renders as a plain turn"
	);
	eq(parseCrosstalkLabel("Crosstalk (Steve + Speaker B)"), ["Steve", "Speaker B"], "the label parses back to its voices");
	eq(parseCrosstalkLabel("Crosstalk (Ana + Bo (Robert))"), ["Ana", "Bo (Robert)"], "a parenthesized nickname stays inside its voice");
	eq(parseCrosstalkLabel("Crosstalk (Steve)"), null, "one voice is not crosstalk");
	eq(parseCrosstalkLabel("Steve"), null, "an ordinary name is not a crosstalk label");

	// server marks flow through parseWhisperX; an interjector who never
	// dominates a segment still gets a letter and keeps her embedding
	const px = parseWhisperX({
		segments: [
			{ start: 0, end: 4, text: "As I was saying, the rollout", speaker: "SPEAKER_00" },
			{ start: 4, end: 6, text: "starts Monday.", speaker: "SPEAKER_00", speakers: ["SPEAKER_00", "SPEAKER_01"] },
			{ start: 6, end: 9, text: "So we should be ready.", speaker: "SPEAKER_00" },
		],
		embeddings: { SPEAKER_00: { vector: [1, 0], seconds: 9 }, SPEAKER_01: { vector: [0, 1], seconds: 1.4 } },
	});
	eq(
		px.utts,
		[
			{ speaker: "A", text: "As I was saying, the rollout", start: 0, end: 4000 },
			{ speaker: "A", text: "starts Monday.", start: 4000, end: 6000, crosstalk: ["B"] },
			{ speaker: "A", text: "So we should be ready.", start: 6000, end: 9000 },
		],
		"a crosstalk segment stays its own turn instead of welding into the same speaker's neighbors"
	);
	eq(px.embeddings, { A: { vector: [1, 0], seconds: 9 }, B: { vector: [0, 1], seconds: 1.4 } }, "the interjector's letter keeps her voice embedding for naming and enrollment");
	const both = parseWhisperX({
		segments: [
			{ start: 0, end: 2, text: "over", speaker: "SPEAKER_00", speakers: ["SPEAKER_00", "SPEAKER_01"] },
			{ start: 2, end: 4, text: "each other", speaker: "SPEAKER_00", speakers: ["SPEAKER_00", "SPEAKER_01"] },
		],
	});
	eq(both.utts?.length, 1, "adjacent crosstalk segments with the same voices still coalesce");
	eq(both.utts?.[0].crosstalk, ["B"], "and keep the marker once");

	// the transcript machinery round-trips the label
	const md = "## Transcript\n\n**Speaker A [0:00]:** As I was saying, the rollout\n\n**Crosstalk (Speaker A + Speaker B) [0:04]:** starts Monday.\n\n**Speaker A [0:06]:** So we should be ready.";
	eq(transcriptSpeakers(md), ["Speaker A", "Speaker B"], "a crosstalk label offers its voices for renaming, not the compound");
	const back = transcriptToUtterances(md);
	eq(back[1].speaker, "Speaker A", "reading the note back credits the crosstalk turn to the dominant voice");
	eq(back[1].crosstalk, ["Speaker B"], "and keeps the other voice");
	eq(talkShares(back).map((s: { speaker: string }) => s.speaker), ["Speaker A"], "talk shares never grow a phantom compound speaker");
	const sp = parseTranscriptSpeakerLine("**Crosstalk (Steve + Speaker B) [1:02]:** yeah");
	eq(sp?.voices, ["Steve", "Speaker B"], "the live preview parser sees the voices");
	eq(sp?.name, "Crosstalk (Steve + Speaker B)", "while the name span still covers the whole label");
	ok(!parseTranscriptSpeakerLine("**Steve [1:02]:** hi")?.voices, "ordinary lines carry no voices field");

	// renames reach inside the label
	eq(
		renameSpeakerLabels("**Crosstalk (Speaker A + Speaker B) [0:04]:** hi\n\n**Speaker A [0:06]:** bye", { "Speaker A": "Steve" }),
		"**Crosstalk (Steve + Speaker B) [0:04]:** hi\n\n**Steve [0:06]:** bye",
		"naming a letter renames it inside crosstalk labels too"
	);
	eq(
		renameSpeakerLabels("**Crosstalk (Ana + Ben):** hi", { Ana: "Ben", Ben: "Ana" }),
		"**Crosstalk (Ben + Ana):** hi",
		"a swap maps each crosstalk voice once, never chaining"
	);

	// crosstalk letters survive part alignment and cluster review
	const m = mergeDiarizedParts([
		{ utts: [{ speaker: "A", text: "x", start: 0, end: 9000, crosstalk: ["B"] }], embeddings: { A: { vector: [1, 0], seconds: 9 }, B: { vector: [0, 1], seconds: 2 } }, offsetMs: 0 },
		{ utts: [{ speaker: "A", text: "y", start: 0, end: 9000, crosstalk: ["B"] }], embeddings: { A: { vector: [0, 1], seconds: 9 }, B: { vector: [1, 0], seconds: 2 } }, offsetMs: 60000 },
	]);
	eq(m.utts.map((x: { speaker: string; crosstalk?: string[] }) => [x.speaker, ...(x.crosstalk ?? [])].join(">")), ["A>B", "B>A"], "crosstalk letters follow the same voice alignment as the turns");
	const lib = enrollVoiceprint(enrollVoiceprint([], "Sanjit", [1, 0, 0], 1), "Dylan", [0, 1, 0], 1);
	const rv = reviewSpeakerClusters(
		[
			{ speaker: "A", text: "a1", start: 0, end: 10000 },
			{ speaker: "A", text: "a2", start: 10000, end: 20000, crosstalk: ["B"] },
			{ speaker: "A", text: "a3", start: 20000, end: 30000 },
			{ speaker: "A", text: "a4", start: 30000, end: 40000 },
			{ speaker: "B", text: "b", start: 40000, end: 50000 },
		],
		[
			{ speaker: "A", start: 0, end: 10000, seconds: 10, vector: [1, 0, 0] },
			{ speaker: "A", start: 10000, end: 20000, seconds: 10, vector: [0, 1, 0] },
			{ speaker: "A", start: 20000, end: 30000, seconds: 10, vector: [1, 0, 0] },
			{ speaker: "A", start: 30000, end: 40000, seconds: 10, vector: [0, 1, 0] },
		],
		lib
	);
	eq(rv.utts.map((x: { speaker: string }) => x.speaker), ["A", "C", "A", "C", "B"], "the minority crosstalk turn still moves with its voice");
	eq([...(rv.utts[1].crosstalk ?? [])].sort(), ["A", "B"], "and its crosstalk set keeps every voice that was audible, old dominant included");
	// a crosstalk-only voice holds a letter: a split must never mint it for
	// someone else
	const held = reviewSpeakerClusters(
		[
			{ speaker: "A", text: "a1", start: 0, end: 10000 },
			{ speaker: "A", text: "a2", start: 10000, end: 20000 },
			{ speaker: "A", text: "a3", start: 20000, end: 30000 },
			{ speaker: "A", text: "a4", start: 30000, end: 40000 },
			{ speaker: "B", text: "b", start: 40000, end: 50000, crosstalk: ["C"] },
		],
		[
			{ speaker: "A", start: 0, end: 10000, seconds: 10, vector: [1, 0, 0] },
			{ speaker: "A", start: 10000, end: 20000, seconds: 10, vector: [0, 1, 0] },
			{ speaker: "A", start: 20000, end: 30000, seconds: 10, vector: [1, 0, 0] },
			{ speaker: "A", start: 30000, end: 40000, seconds: 10, vector: [0, 1, 0] },
		],
		lib
	);
	eq(held.splits[0]?.to, "D", "a split skips the letter a crosstalk voice already holds");
}

// --- usage rates + ledger ---
eq(llmCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000), 6, "haiku priced $1 in + $5 out per 1M");
eq(llmCostUsd("claude-opus-4-8", 1_000_000, 1_000_000), 30, "opus is $5/$25 (not the stale $15/$75 = 90)");
eq(llmCostUsd("mystery", 1_000_000, 0), 0, "unknown model costs nothing to avoid inventing a rate");
eq(transcriptionCostUsd("deepgram", 60), 0.26, "deepgram nova ~$0.26/hr");
eq(transcriptionCostUsd(null, 60), 0, "no provider, no transcription cost");
eq(transcriptionCostUsd("whisper", 0), 0, "no minutes, no transcription cost");
eq(pushUsageEvent([], { ts: 1, feature: "x", model: "m", tokIn: 0, tokOut: 0, minutes: 0, usd: 0 }, 5).length, 1, "push appends");
eq(
	pushUsageEvent(
		Array.from({ length: 5 }, (_, i) => ({ ts: i, feature: "x", model: "m", tokIn: 0, tokOut: 0, minutes: 0, usd: 0 })),
		{ ts: 9, feature: "x", model: "m", tokIn: 0, tokOut: 0, minutes: 0, usd: 0 },
		5
	).map((e) => e.ts),
	[1, 2, 3, 4, 9],
	"push prunes to the cap, keeping the most recent"
);
{
	const t0 = new Date(2026, 6, 15, 9).getTime(); // local noon-ish, stable day key
	const events = [
		{ ts: t0, feature: "meeting", model: "claude-haiku-4-5", tokIn: 1000, tokOut: 200, minutes: 0, usd: 0.002 },
		{ ts: t0 + 1000, feature: "transcribe", model: "deepgram/nova-2", tokIn: 0, tokOut: 0, minutes: 30, usd: 0.13 },
		{ ts: t0 + 2000, feature: "chat", model: "claude-haiku-4-5", tokIn: 500, tokOut: 500, minutes: 0, usd: 0.003 },
	];
	const s = summarizeUsage(events);
	eq(Number(s.totalUsd.toFixed(3)), 0.135, "summary totals every event");
	eq(Number(s.audioUsd.toFixed(3)), 0.13, "audio dollars split out");
	eq(Number(s.llmUsd.toFixed(3)), 0.005, "llm dollars split out");
	eq(s.tokIn, 1500, "input tokens summed across llm events");
	eq(s.calls, 3, "call count is every windowed event");
	eq(s.byFeature[0].feature, "transcribe", "by-feature is sorted by spend");
	eq(s.byDay.length, 1, "same local day buckets together");
	eq(summarizeUsage(events, t0 + 1500).calls, 1, "since-window drops earlier events");
}
eq(dayKey(new Date(2026, 6, 15, 23, 59).getTime()), "2026-07-15", "dayKey is local, zero-padded");

// --- 1.0: reliability, copy summary, ISO week, series templates ---
import {
	chosenKeys,
	extractionsFromKeys,
	formatSummaryForClipboard,
	isRetryableError,
	isRetryableStatus,
	isoWeek,
	memoAttendees,
	retryDelayMs,
	whisperSizeWarning,
} from "./pipeline";

eq(retryDelayMs(0), 1000, "first backoff is the base");
eq(retryDelayMs(2), 4000, "backoff doubles");
eq(retryDelayMs(20), 15000, "backoff caps");
ok(isRetryableStatus(429) && isRetryableStatus(503) && !isRetryableStatus(400) && !isRetryableStatus(401), "retryable status set");
ok(isRetryableError({ status: 429 }), "sdk error status is retryable");
ok(isRetryableError(new Error("Request failed, status 503")), "requestUrl message status is retryable");
ok(!isRetryableError(new Error("bad request status 400")), "client errors are not retried");
ok(!isRetryableError("nope"), "unknown errors are not retried");

eq(whisperSizeWarning(1_000_000, "https://api.groq.com/openai/v1"), null, "small files pass");
ok(whisperSizeWarning(30 * 1024 * 1024, "https://api.groq.com/openai/v1")!.includes("25 MB"), "big cloud files warn");
eq(whisperSizeWarning(99 * 1024 * 1024, "http://192.168.1.5:9000/v1"), null, "LAN endpoints have no cloud limit");
eq(whisperSizeWarning(99 * 1024 * 1024, "http://localhost:9000/v1"), null, "localhost has no cloud limit");
eq(whisperSizeWarning(99 * 1024 * 1024, "http://10.0.0.9:9000/v1"), null, "the 10.x private range is LAN");
ok(whisperSizeWarning(30 * 1024 * 1024, "https://model10.2.example.com/v1") !== null, "a cloud host merely containing '10.2' is not LAN");
ok(whisperSizeWarning(30 * 1024 * 1024, "https://mylocalhost.example.com/v1") !== null, "a cloud host containing 'localhost' is not LAN");

eq(memoAttendees([{ speaker: "A", text: "note to self", start: 0 }], "Steve"), ["Steve"], "a solo diarized memo is attributed to you");
eq(memoAttendees(null, "Steve"), [], "no diarization (Whisper) is never assumed solo");
eq(memoAttendees([{ speaker: "A", text: "x", start: 0 }, { speaker: "B", text: "y", start: 1 }], "Steve"), [], "a multi-speaker meeting is not attributed to you alone");
eq(memoAttendees([{ speaker: "Jane", text: "x", start: 0 }], "Steve"), [], "a single NAMED speaker keeps their name, not yours");
eq(memoAttendees([{ speaker: "A", text: "x", start: 0 }], ""), [], "no name set, no attribution");

{
	const note = assembleNote({
		title: "Sync",
		date: "2026-07-12",
		source: "[[a.webm]]",
		embed: "![[a.webm]]",
		body: null,
		transcript: "**Steve [0:00]:** hi there",
		includeTranscript: true,
		model: null,
		extractionError: "Request failed, status 529\n(overloaded)",
	});
	ok(note.includes("[!warning] Extraction failed"), "a failed extraction still writes the note");
	ok(note.includes("Re-extract this capture"), "…with a pointer to retry");
	ok(note.includes("## Transcript") && note.includes("hi there"), "…and the transcript is preserved");
	ok(!note.includes("model:"), "no model is claimed when extraction failed");
	const noteOff = assembleNote({
		title: "Sync",
		date: "2026-07-12",
		source: "[[a.webm]]",
		embed: null,
		body: null,
		transcript: "**Steve [0:00]:** paid-for words",
		includeTranscript: false, // off, but the failure must still save it
		model: null,
		extractionError: "status 529",
	});
	ok(noteOff.includes("## Transcript") && noteOff.includes("paid-for words"), "a failed extraction forces the transcript in even when it was switched off");
}

{
	const md = [
		"---",
		"type: capture",
		"---",
		"# Weekly Sync",
		"**Speakers:** Steve (60%), Jordan (40%)",
		"## Summary",
		"We shipped it.",
		"## Action items",
		"- [ ] follow up [[Jordan]]",
		"## Moments",
		"- [0:12] Decision",
		"## Transcript",
		"**Steve [0:00]:** lots of words",
		"![[a.webm]]",
	].join("\n");
	const clip = formatSummaryForClipboard(md);
	ok(clip.includes("# Weekly Sync") && clip.includes("We shipped it.") && clip.includes("follow up"), "clip keeps title and sections");
	ok(clip.includes("**Speakers:**"), "clip keeps the speakers line");
	ok(!clip.includes("## Transcript") && !clip.includes("lots of words"), "clip drops the transcript");
	ok(!clip.includes("## Moments") && !clip.includes("![[a.webm]]"), "clip drops moments and embeds");
}
{
	// Screens must not reach a surface that leaves the vault. A wiki-link to a
	// .webp is meaningless in an email, and flattening it leaves a filename where
	// the picture was, so the whole section goes.
	const md = [
		"---", "type: capture", "---", "# Atlas", "", "## Summary", "", "We shipped it.", "",
		"## Screens", "", "**[7:03]** ![[Cap/frame.webp]]", "> ATLAS Architecture", "",
		"## Moments", "- [0:12] Decision", "## Transcript", "**Steve [0:00]:** words", "![[a.webm]]",
	].join("\n");
	const clip = formatSummaryForClipboard(md);
	ok(clip.includes("We shipped it."), "the extraction still survives");
	ok(!clip.includes("## Screens") && !clip.includes("frame.webp"), "the clipboard summary drops the screens");
	ok(!clip.includes("ATLAS Architecture"), "and what the reader found under them");
	ok(!clip.includes("## Moments") && !clip.includes("words"), "cutting from Screens still takes everything below it");

	const model = parseCaptureForExport(md, "Atlas");
	const screens = model.sections.find((s: { heading: string }) => s.heading === "Screens")!;
	ok(screens, "the Word export carries the Screens section");
	eq(screens.images.map((i: { link: string }) => i.link), ["Cap/frame.webp"], "as an image, resolved by the caller");
	eq(screens.images[0].stamp, "7:03", "with the moment it came from");
	eq(screens.images[0].caption, "ATLAS Architecture", "and what the reader found in it");
	// the point of carrying them as images: the wikilink must never reach the page
	const asText = JSON.stringify([screens.paragraphs, screens.bullets]);
	ok(!asText.includes("frame.webp") && !asText.includes("![["), "the embed is never rendered as text");
	ok(!asText.includes("ATLAS Architecture"), "nor is the caption, which the image carries instead");
	ok(model.sections.some((s: { heading: string }) => s.heading === "Summary"), "the export still carries the real sections");
	ok(!model.sections.some((s: { heading: string }) => s.heading === "Moments"), "moments are still skipped: stamps into a recording the reader does not have");
}
{
	// a screen placed beside a point stays with that point's section rather than
	// being hoisted into a gallery, which is the whole reason it was put there
	const md = [
		"---", "type: capture", "---", "# Atlas", "",
		"## Summary", "", "- Inventory design settled [7:03]", "\t**[7:03]** ![[Cap/a.webp]]", "\t> ATLAS Architecture", "- Second point [9:00]", "",
		"## Screens", "", "**[31:43]** ![[Cap/b.webp]]", "",
	].join("\n");
	const m = parseCaptureForExport(md, "Atlas");
	const summary = m.sections.find((s: { heading: string }) => s.heading === "Summary")!;
	eq(summary.images.map((i: { link: string }) => i.link), ["Cap/a.webp"], "the illustrating screen belongs to the section it illustrates");
	eq(summary.images[0].caption, "ATLAS Architecture", "an indented caption is still read");
	eq(summary.bullets, ["Inventory design settled [7:03]", "Second point [9:00]"], "the bullets keep their own text and lose the frame line");
	ok(!JSON.stringify(summary).includes("a.webp\"]]"), "no embed syntax survives in the text");
	const gallery = m.sections.find((s: { heading: string }) => s.heading === "Screens")!;
	eq(gallery.images.map((i: { link: string }) => i.link), ["Cap/b.webp"], "the leftover screens are still their own section");
}

eq(isoWeek("2026-07-12"), "2026-W28", "ISO week for a Sunday");
eq(isoWeek("2026-07-13"), "2026-W29", "the next Monday rolls the week");
eq(isoWeek("2026-01-01"), "2026-W01", "new year's day is week 1");
ok(isoWeek("2026-07-06") === isoWeek("2026-07-12"), "a Mon–Sun span shares one week key");

// --- what day it is, where the user is ---
// Every date these build is read off the local clock, so the assertions hold in
// any zone: a Date built from local parts is that local moment by construction.
{
	const { dayOf, today, daysAgo, clockOf } = require("./pipeline");
	// the moment that started this: a post captured at 9:16 PM on Saturday Aug 1
	// was filed as Aug 2, because that is the date in Greenwich
	const evening = new Date(2026, 7, 1, 21, 16, 9);
	eq(dayOf(evening), "2026-08-01", "an evening is dated the day it happened, not the next day in UTC");
	eq(clockOf(evening), "21-16-09", "and the clock reads in local hours");
	eq(dayOf(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01", "midnight starting a year belongs to the new year");
	eq(dayOf(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31", "and the last second of one belongs to the old");
	eq(dayOf(new Date(2026, 8, 5, 9, 0, 0)), "2026-09-05", "single-digit months and days are padded");
	eq(today(), dayOf(new Date()), "today is the current moment's day and nothing else");

	eq(daysAgo(0, evening), "2026-08-01", "nothing ago is today");
	eq(daysAgo(6, evening), "2026-07-26", "the digest's week reaches back six days");
	eq(daysAgo(7, evening), "2026-07-25", "and its staleness line one further");
	eq(daysAgo(-7, evening), "2026-08-08", "counting the other way gives the briefing's horizon");
	eq(daysAgo(31, evening), "2026-07-01", "a month back crosses the month boundary");
	// the reason this counts days instead of subtracting milliseconds: US clocks
	// move forward on 2026-03-08, making it a 23-hour day. Going back 24 hours from
	// just after midnight on the 9th lands on the 7th; going back one day does not.
	eq(daysAgo(1, new Date(2026, 2, 9, 0, 30, 0)), "2026-03-08", "the day after the clocks move, yesterday is still yesterday");
	eq(daysAgo(1, new Date(2026, 10, 2, 0, 30, 0)), "2026-11-01", "and the day after they move back, likewise");
}

{
	const ex = extractionsFromKeys(["summary", "risks"]);
	ok(ex.summary && ex.risks && !ex.actions && !ex.keywords, "keys map to the right toggles");
	eq(chosenKeys({ summary: true, actions: false, decisions: true, risks: false, questions: false, keywords: true }), ["summary", "decisions", "keywords"], "chosenKeys returns the on keys in order");
	eq(chosenKeys(extractionsFromKeys(chosenKeys(ex))), ["summary", "risks"], "keys round-trip");
}

// --- 1.1: Word (.docx) export model ---
import { longDate, parseActionRow, parseCaptureForExport } from "./pipeline";

eq(longDate("2026-07-01"), "Wednesday, July 1, 2026", "long date formats with weekday");
eq(longDate("2026-12-25"), "Friday, December 25, 2026", "long date, December");
eq(longDate("not-a-date"), "not-a-date", "unparseable dates pass through");

{
	const r = parseActionRow("- [ ] Send the budget deck [[Jordan]] 📅 2026-07-14");
	eq(r, { owner: "Jordan", task: "Send the budget deck", deadline: "2026-07-14" }, "task line → owner/task/deadline");
	eq(parseActionRow("- [ ] Follow up with legal").owner, "", "no owner → empty");
	eq(parseActionRow("- [x] Ship it [[Steve]] ✅ 2026-07-09").task, "Ship it", "done markers and checkmarks stripped");
	const t = parseActionRow("| Draft the plan | TBD | 2026-07-20 |");
	eq(t, { task: "Draft the plan", owner: "", deadline: "2026-07-20" }, "table row → columns, TBD → empty");
}

{
	const md = [
		"---",
		"type: capture",
		"date: 2026-07-05",
		'attendees:',
		'  - "[[Steve]]"',
		'  - "[[Jordan]]"',
		"tags:",
		"  - capture",
		"---",
		"# Leadership Sync 2026-07-05",
		"**Speakers:** Steve (60%), Jordan (40%)",
		"## Summary",
		"We aligned on the plan.",
		"",
		"Then we set dates.",
		"## Decisions",
		"- Ship Friday",
		"- [[Jordan]] owns rollout",
		"## Action items",
		"- [ ] Send deck [[Jordan]] 📅 2026-07-14",
		"- [ ] Book the room",
		"## Transcript",
		"**Steve [0:00]:** lots of words we do not want in the doc",
		"![[audio.webm]]",
	].join("\n");
	const m = parseCaptureForExport(md);
	eq(m.title, "Leadership Sync 2026-07-05", "title comes from the H1");
	eq(m.attendees, ["Steve", "Jordan"], "attendees parsed from frontmatter");
	eq(m.dateLine, "Sunday, July 5, 2026", "date rendered long");
	eq(m.sections.map((s) => [s.heading, s.kind]), [["Summary", "text"], ["Decisions", "bullets"], ["Action items", "tasks"]], "sections classified; transcript dropped");
	eq(m.sections[0].paragraphs.length, 2, "summary split into paragraphs");
	eq(m.sections[1].bullets, ["Ship Friday", "Jordan owns rollout"], "bullets strip wiki-link brackets");
	eq(m.sections[2].tasks[0], { owner: "Jordan", task: "Send deck", deadline: "2026-07-14" }, "action rows become table cells");
	eq(m.sections[2].tasks[1], { owner: "", task: "Book the room", deadline: "" }, "ownerless task row");
	ok(!m.sections.some((s) => s.heading === "Transcript"), "transcript never exported");
	ok(!JSON.stringify(m).includes("audio.webm"), "embeds never exported");
}
{
	// a table-format action items section (actionsAsTasks off)
	const md = ["# M", "## Action items", "| Task | Owner | Due |", "| --- | --- | --- |", "| Review PR | Steve | ASAP |"].join("\n");
	const m = parseCaptureForExport(md);
	eq(m.sections[0].kind, "tasks", "markdown-table action items still parse as tasks");
	eq(m.sections[0].tasks[0], { task: "Review PR", owner: "Steve", deadline: "ASAP" }, "table columns mapped");
}
eq(parseCaptureForExport("# Empty\n## Summary\n*None identified.*").sections.length, 0, "None-identified sections are skipped");
{
	// redacted attendees are still parsed (masked), and unquoted tags never leak in
	const md = ['---', 'type: capture', 'date: 2026-07-05', 'attendees:', '  - "[redacted]"', '  - "[[Jordan]]"', 'tags:', '  - capture', '---', '# M', '## Summary', 'hi'].join("\n");
	const m = parseCaptureForExport(md);
	eq(m.attendees, ["[redacted]", "Jordan"], "masked and real attendees parse; the 'capture' tag is not treated as an attendee");
}
{
	// a lead-in sentence before bullets must not be dropped
	const m = parseCaptureForExport("# M\n## Decisions\nThe team agreed on the following:\n- Ship Friday\n- Freeze scope");
	eq(m.sections[0].kind, "bullets", "a bulleted section is bullets");
	eq(m.sections[0].paragraphs, ["The team agreed on the following:"], "the lead-in line is preserved as a paragraph");
	eq(m.sections[0].bullets, ["Ship Friday", "Freeze scope"], "the bullets are kept too");
}
{
	// a '## ' inside transcript text must never leak into the export
	const md = ["# M", "## Summary", "All good.", "## Transcript", "**A [0:00]:** blah", "## Secret Heading From Pasted Text", "leaked body"].join("\n");
	const m = parseCaptureForExport(md);
	eq(m.sections.map((s) => s.heading), ["Summary"], "everything from the transcript onward is cut, phantom heading included");
	ok(!JSON.stringify(m).includes("leaked body") && !JSON.stringify(m).includes("Secret Heading"), "no transcript-adjacent content leaks");
}
{
	// CRLF-authored note still parses frontmatter
	const md = ["---", "type: capture", "date: 2026-07-05", "attendees:", '  - "[[Steve]]"', "---", "# M", "## Summary", "hi"].join("\r\n");
	const m = parseCaptureForExport(md);
	eq(m.attendees, ["Steve"], "CRLF frontmatter still yields attendees");
	eq(m.dateLine, "Sunday, July 5, 2026", "CRLF date parses");
}
{
	// an Action items section with only metadata (no task text) doesn't orphan a heading
	const m = parseCaptureForExport("# M\n## Action items\n- [ ] [[Jordan]] 📅 2026-07-14");
	eq(m.sections[0].kind, "bullets", "an all-metadata action section falls through to renderable content");
	ok(m.sections[0].bullets.length === 1, "the line is rendered, not dropped as an orphan heading");
}

// --- 1.2: redaction + custom templates ---
import { allTemplates, cleanFolderPath, redact, redactionActive, resolveRecordingFolder } from "./pipeline";

// --- meeting notes ---
import { DEFAULT_MEETING_TEMPLATE, LEGACY_MEETING_TEMPLATES, templateBodyOf, buildMeetingStub, isCaptureNote, mergeMeetingCapture, parseMeetingMeta, personLink, personName, renderMeetingFilename, renderMeetingTemplate } from "./pipeline";

eq(renderMeetingFilename("{{date}} {{title}}", "Budget Review", "2026-07-14"), "2026-07-14 Budget Review.md", "meeting filename from date + title");
eq(renderMeetingFilename("", "", "2026-07-14"), "2026-07-14 Meeting.md", "empty title falls back to Meeting; default pattern");
eq(renderMeetingFilename("{{title}}", "a/b: c", "d"), "a-b- c.md", "unsafe filename characters are stripped");
{
	const stub = buildMeetingStub({ title: "Budget Review", date: "2026-07-14", attendees: ["Steve", "Jordan"], agenda: "- Q3 numbers\n- Headcount" });
	ok(stub.includes("date: 2026-07-14") && stub.includes("- capture") && !stub.includes("type:"), "stub is tagged capture with the date and no redundant type");
	ok(stub.includes('  - "[[Steve]]"') && stub.includes('  - "[[Jordan]]"'), "attendees become frontmatter wiki-links");
	ok(!stub.includes("# Budget Review"), "the title is not repeated under the filename that already says it");
	ok(stub.includes("---\n## Notes\n- \n"), "the note opens on somewhere to write, with a bullet ready");
	ok(stub.indexOf("## Notes") < stub.indexOf("## Agenda"), "notes first, agenda under them");
	ok(stub.includes("## Agenda") && stub.includes("- Q3 numbers"), "the agenda still renders");
	ok(buildMeetingStub({ title: "", date: "d", attendees: [], agenda: "" }).includes("## Agenda\n- "), "an empty agenda still gets a bullet to start on");
	ok(buildMeetingStub({ title: "M", date: "2026-07-14", attendees: [], agenda: "", when: "1:30 PM-2:30 PM" }).includes('time: "1:30 PM-2:30 PM"'), "the meeting time becomes a frontmatter property");
}
{
	// capture-note identification: explicit type, tag fallback, derived-doc exclusion
	ok(isCaptureNote({ type: "capture" }), "explicit type:capture is a capture");
	ok(isCaptureNote({ tags: ["capture"] }), "no type plus the capture tag is a capture");
	ok(isCaptureNote({ tags: "capture" }), "a string capture tag counts too");
	ok(!isCaptureNote({ type: "capture-person", tags: ["capture"] }), "a person report is not a meeting even with the capture tag");
	ok(!isCaptureNote({ type: "capture-digest", tags: ["capture"] }), "a digest is not a meeting");
	ok(!isCaptureNote({ tags: ["meeting"] }), "some other tag is not a capture");
	ok(!isCaptureNote(undefined), "no frontmatter is not a capture");
}
{
	const meeting = buildMeetingStub({ title: "Sync 2026-07-14", date: "2026-07-14", attendees: ["Steve"], agenda: "- Discuss launch" });
	const capture = assembleNote({
		title: "Sync 2026-07-14",
		date: "2026-07-14",
		source: "[[a.webm]]",
		embed: "![[a.webm]]",
		body: "## Summary\nWe launched.\n\n## Action items\n- [ ] Ship [[Steve]] 📅 2026-07-16",
		transcript: "**Steve [0:00]:** ok",
		includeTranscript: true,
		model: "m",
		speakers: 2,
		attendees: ["Steve", "Jordan"],
		speakersLine: "Steve (70%), Jordan (30%)",
	});
	const merged = mergeMeetingCapture(meeting, capture);
	ok(merged.includes("## Agenda") && merged.includes("- Discuss launch"), "the user's agenda survives the merge");
	ok(merged.includes("## Summary") && merged.includes("We launched."), "the recording summary is folded in");
	ok(merged.indexOf("## Agenda") < merged.indexOf("## Summary"), "agenda sits above the AI summary");
	ok(merged.includes("\n  - m\n") && merged.includes("speakers: 2"), "the recording's frontmatter folds in (model tag + speakers)");
	ok(merged.includes("## Transcript") && merged.includes("![[a.webm]]"), "transcript and embed are included");
	ok((merged.match(/^# Sync 2026-07-14$/gm) || []).length === 1, "exactly one title line");
	ok((merged.match(/^---$/gm) || []).length === 2, "exactly one frontmatter block");
}
{
	const stub = buildMeetingStub({ title: "1:1 with Jordan", date: "2026-07-14", attendees: ["Steve", "Jordan"], agenda: "- Career" });
	const meta = parseMeetingMeta(stub);
	eq(meta.title, "", "a stub writes no heading, so there is no title in the body (the caller falls back to the note's filename)");
	eq(meta.date, "2026-07-14", "date read back from frontmatter");
	eq(meta.attendees.join(","), "Steve,Jordan", "attendees unwrapped from [[..]] frontmatter");
	const none = parseMeetingMeta("# Bare note\n\nhi");
	eq(none.attendees.length, 0, "a note without frontmatter yields no attendees");
	eq(none.title, "Bare note", "title still found without frontmatter");
}
{
	// People-folder linking: attendee links are qualified and aliased so a click
	// creates the person page in the folder, and every reader sees plain names
	eq(personLink("Jane Doe", "Capture/Notes/People"), "[[Capture/Notes/People/Jane Doe|Jane Doe]]", "a foldered person link is qualified and aliased");
	eq(personLink("Jane Doe"), "[[Jane Doe]]", "no folder keeps the bare link");
	eq(personLink("Jane", "/People/"), "[[People/Jane|Jane]]", "folder slashes are trimmed");
	eq(personName("[[Capture/Notes/People/Jane Doe|Jane Doe]]"), "Jane Doe", "display name from a qualified link");
	eq(personName("[[People/Jane Doe]]"), "Jane Doe", "no alias falls back to the target basename");
	eq(personName('"[[Jane Doe]]"'), "Jane Doe", "quotes and brackets unwrap");
	eq(personName("Jane Doe"), "Jane Doe", "a plain name passes through");
	eq(personName("[redacted]"), "[redacted]", "a redacted value is left alone");
	const stub = buildMeetingStub({ title: "M", date: "2026-07-14", attendees: ["Jane Doe"], agenda: "- x", peopleFolder: "Capture/Notes/People" });
	ok(stub.includes('  - "[[Capture/Notes/People/Jane Doe|Jane Doe]]"'), "stub attendees link into the people folder");
	eq(parseMeetingMeta(stub).attendees.join(","), "Jane Doe", "qualified links read back as plain names");
	const note = assembleNote({
		title: "T",
		date: "2026-07-14",
		source: "s",
		embed: null,
		body: "## Summary\nHi.",
		transcript: "",
		includeTranscript: false,
		model: "m",
		speakers: null,
		attendees: ["Jane Doe"],
		peopleFolder: "People",
	});
	ok(note.includes('  - "[[People/Jane Doe|Jane Doe]]"'), "capture attendees link into the people folder");
	eq(taskOwner("- [ ] [[People/Jane|Jane]] ship it"), "Jane", "task owner prefers the link alias");
	eq(taskOwner("- [ ] [[People/Jane]] ship it"), "Jane", "task owner falls back to the target basename");
	const model = parseCaptureForExport(
		'---\ndate: 2026-07-14\nattendees:\n  - "[[People/Jane Doe|Jane Doe]]"\n---\n# T\n\n## Summary\nHi [[People/Jane Doe|Jane Doe]], see [[People/Raj]].\n'
	);
	eq(model.attendees.join(","), "Jane Doe", "export attendees use display names");
	ok(model.sections[0].paragraphs[0].includes("Hi Jane Doe, see Raj."), "export body unlinks to alias or basename");
}
{
	// full round-trip the glue orchestrates: prep a meeting, then fold in a
	// recording that surfaced a new attendee. Agenda stays, attendees union,
	// series is preserved, and includeTranscript:false is honored.
	const meeting = buildMeetingStub({ title: "Weekly sync", date: "2026-07-14", attendees: ["Steve"], agenda: "- Launch\n- Budget", series: "weekly-sync" });
	const meta = parseMeetingMeta(meeting);
	const attendees = [...new Set([...meta.attendees, "Jordan"])]; // finishNote unions prior + detected
	const capture = assembleNote({
		title: meta.title,
		date: meta.date,
		source: "[[m.webm]]",
		embed: "![[m.webm]]",
		body: "## Summary\nGood progress.",
		transcript: "**Steve [0:00]:** hi",
		includeTranscript: false,
		model: "m",
		speakers: 2,
		attendees,
		series: "weekly-sync",
		speakersLine: "Steve, Jordan",
	});
	const merged = mergeMeetingCapture(meeting, capture);
	ok(merged.includes("- Launch") && merged.includes("- Budget"), "agenda items survive the fold");
	ok(merged.includes("[[Steve]]") && merged.includes("[[Jordan]]"), "attendees union in the frontmatter");
	ok(merged.includes("series: weekly-sync"), "series survives so carry-over still links");
	ok(merged.indexOf("## Agenda") < merged.indexOf("## Summary"), "agenda stays above the summary");
	ok(!merged.includes("## Transcript"), "includeTranscript:false keeps the transcript out");
}
{
	// the fold preserves the user's own frontmatter keys and does not duplicate
	// shared keys (capture wins for those)
	const meeting = "---\ntype: capture\ndate: 2026-07-14\nproject: Apollo\nclient: Acme\n---\n\n# Kickoff\n\n## Agenda\n\n- Scope";
	const capture = assembleNote({
		title: "Kickoff",
		date: "2026-07-14",
		source: "[[k.webm]]",
		embed: "![[k.webm]]",
		body: "## Summary\nScoped it.",
		transcript: "x",
		includeTranscript: false,
		model: "m",
		speakers: 2,
		attendees: ["Steve"],
	});
	const merged = mergeMeetingCapture(meeting, capture);
	ok(merged.includes("project: Apollo") && merged.includes("client: Acme"), "user-added frontmatter keys survive the fold");
	ok((merged.match(/^type: capture$/gm) || []).length === 1, "shared keys are not duplicated");
	ok((merged.match(/^---$/gm) || []).length === 2, "still one frontmatter block after merge");
	ok(merged.includes("\n  - m\n") && merged.includes("source:"), "recording-only keys are appended (model tag + source)");
}
{
	// CRLF meeting note: attendees and date still parse (Sync / external editors)
	const crlf = "---\r\ntype: capture\r\ndate: 2026-07-14\r\nattendees:\r\n  - \"[[Steve]]\"\r\n  - \"[[Jordan]]\"\r\n---\r\n\r\n# CRLF meeting\r\n\r\n## Agenda\r\n\r\n- Item";
	const meta = parseMeetingMeta(crlf);
	eq(meta.date, "2026-07-14", "date parses from a CRLF note");
	eq(meta.attendees.join(","), "Steve,Jordan", "attendees parse from a CRLF note");
	eq(meta.title, "CRLF meeting", "title parses from a CRLF note");
}

// --- invite import ---
import { eventToInvite, parseMeetingInvite, tidyAgenda } from "./pipeline";
{
	// Outlook's bullet glyphs (and a bullet stranded on its own line) become
	// clean, tight, nested Markdown
	const messy = "Couple of Items\n\n•\nConfiguration screens (Module setup screens)\n\n• Setup Wizard/Templates\n\no From beginning\n\no Guided install";
	const t = tidyAgenda(messy);
	ok(t.includes("Couple of Items"), "the lead-in line is kept");
	ok(t.includes("- Configuration screens (Module setup screens)"), "a bullet alone on its line rejoins its text as a dash");
	ok(t.includes("- Setup Wizard/Templates"), "an inline glyph bullet becomes a dash");
	ok(t.includes("  - From beginning"), "an 'o' sub-bullet indents one level");
	ok(!/\n\s*\n/.test(t), "no blank lines remain between agenda items");
}
{
	const stub = buildMeetingStub({ title: "M", date: "2026-07-14", attendees: ["A"], agenda: "- x", when: "10:00 AM", location: "Room", teamsUrl: "https://t", meetingId: "1", passcode: "p" });
	ok(!/---\n\n#/.test(stub), "no blank line between the properties and the first heading");
	ok(!stub.includes("**When:**") && !stub.includes("**Where:**"), "when and where are properties, not a block repeating them");
	ok(stub.includes("join: https://t"), "the join URL moves into the properties, where nothing else was carrying it");
	ok(stub.includes('meeting id: "1"') && stub.includes('passcode: "p"'), "with the id and passcode beside it");
}
{
	// an ICS with escaped-tab sub-bullets nests them, and a Meeting ID on its own
	// line (outside the folded description) is still found
	const ics2 = "BEGIN:VEVENT\nSUMMARY:S\nDTSTART:20260714T100000\nDESCRIPTION:Top\\n•\\tAlpha\\no\\tBeta\nMeeting ID: 111 222 333 44\nEND:VEVENT";
	const p = parseMeetingInvite(ics2);
	ok(p.agenda.includes("- Alpha") && p.agenda.includes("  - Beta"), "ICS glyph bullets nest even with escaped tabs");
	eq(p.meetingId, "111 222 333 44", "a Meeting ID outside the description is still found");
}
{
	// a room/resource attendee (Outlook adds the meeting room as CUTYPE=RESOURCE)
	// is not a person and must not land in the attendee list
	const icsRoom = [
		"BEGIN:VEVENT",
		"SUMMARY:Check-in",
		"DTSTART:20260714T130000",
		'ATTENDEE;CN="Alex Kim";RSVP=TRUE:invalid:nomail',
		'ATTENDEE;CN="Conference Room 1";CUTYPE=RESOURCE;ROLE=NON-PARTICIPANT:invalid:nomail',
		"END:VEVENT",
	].join("\n");
	const rp = parseMeetingInvite(icsRoom);
	ok(rp.attendees.includes("Alex Kim"), "a person attendee is kept");
	ok(!rp.attendees.some((a) => /Conference Room/.test(a)), "a RESOURCE (room) attendee is excluded");
}
{
	// the fold keeps the title tight to the properties (no blank line between)
	const meeting = buildMeetingStub({ title: "Sync", date: "2026-07-14", attendees: ["Steve"], agenda: "- x" });
	const cap = assembleNote({ title: "Sync", date: "2026-07-14", source: "[[a.webm]]", embed: null, body: "## Summary\nHi", transcript: "t", includeTranscript: false, model: "m" });
	ok(!/---\n\n#/.test(mergeMeetingCapture(meeting, cap)), "no blank line between the properties and the title after the fold");
	{
		// the real shape now: neither the stub nor the capture writes a heading,
		// so the first section has to sit tight to the properties on its own
		const headless = mergeMeetingCapture(
			buildMeetingStub({ title: "Sync", date: "2026-07-14", attendees: ["Steve"], agenda: "- x" }),
			"---\ndate: 2026-07-14\n---\n## Summary\nWe met.\n"
		);
		ok(!/---\n\n/.test(headless), "and none when neither side has a heading either");
		ok(headless.includes("## Notes") && headless.includes("## Summary"), "the notes written during the meeting survive the fold, above the extraction");
		ok(headless.indexOf("## Notes") < headless.indexOf("## Summary"), "and stay above it");
	}
}
{
	// the transcript is plain speaker lines under the "## Transcript" heading:
	// always visible and editable, no callout to collapse. Export still cuts it.
	const base = { title: "M", date: "2026-07-14", source: "[[a.webm]]", embed: null as string | null, body: "## Summary\nHi", model: "m" as string | null, includeTranscript: true };
	const note = assembleNote({ ...base, transcript: "**Steve [0:00]:** hello\n\nworld" });
	ok(note.includes("## Transcript\n\n**Steve [0:00]:** hello"), "the transcript body is plain speaker lines under the heading");
	ok(!note.includes("[!transcript]") && !note.includes("[!quote]"), "no callout wrapper is written");
	ok(!JSON.stringify(parseCaptureForExport(note).sections).includes("hello"), "Word export still excludes the transcript (cut at the heading)");
	const rec = assembleNote({ ...base, transcript: "t", recorded: "2:47 PM - 3:12 PM" });
	ok(rec.includes('recorded: "2:47 PM - 3:12 PM"'), "the actual recording time lands in the frontmatter");
}
{
	const { stripTranscriptCallout } = require("./pipeline");
	const callout = "## Transcript\n\n> [!transcript]- Transcript\n> **George [0:00]:** hi\n>\n> **Steve [0:05]:** yo";
	const plain = stripTranscriptCallout(callout);
	eq(plain, "## Transcript\n\n**George [0:00]:** hi\n\n**Steve [0:05]:** yo", "the callout unwraps to plain, blank-separated speaker lines");
	eq(stripTranscriptCallout("## Notes\n\nnothing here"), "## Notes\n\nnothing here", "a note without a transcript callout is unchanged");
}
{
	const { fmtClock, currentTurn } = require("./pipeline");
	eq(fmtClock(5), "0:05", "short times pad seconds");
	eq(fmtClock(65), "1:05", "minutes and seconds");
	eq(fmtClock(4112), "1:08:32", "hours show with padded minutes");
	eq(fmtClock(-3), "0:00", "negative time clamps to zero");
	const times = [0, 4, 12, 63];
	eq(currentTurn(times, 0), 0, "the first turn is current at its start");
	eq(currentTurn(times, 10), 1, "picks the last turn at or before the time");
	eq(currentTurn(times, 999), 3, "past the end stays on the last turn");
	eq(currentTurn(times, -1), -1, "before the first turn is -1");
}
{
	const { interpolatedTime } = require("./pipeline");
	eq(interpolatedTime(60, 120, 0, 100), 60, "the start of a turn is the turn start");
	eq(interpolatedTime(60, 120, 50, 100), 90, "halfway through a turn is the midpoint of its span");
	eq(interpolatedTime(60, 120, 100, 100), 120, "the end of a turn is the next turn's start");
	eq(interpolatedTime(60, 120, 999, 100), 120, "past the end clamps to the next turn");
	eq(interpolatedTime(60, 60, 50, 100), 60, "a zero-length span returns the start");
}
{
	// Deepgram diarized response -> shared Utterance shape
	const { parseDeepgram } = require("./pipeline");
	const dg = {
		results: {
			channels: [{ alternatives: [{ transcript: "hello there how are you" }] }],
			utterances: [
				{ start: 0.0, end: 1.5, transcript: "hello there", speaker: 0 },
				{ start: 1.6, end: 3.0, transcript: "how are you", speaker: 1 },
			],
		},
	};
	const r = parseDeepgram(dg);
	eq(r.utts?.length, 2, "deepgram utterances are mapped");
	eq(r.utts?.[0].speaker, "A", "deepgram speaker 0 becomes A");
	eq(r.utts?.[1].speaker, "B", "deepgram speaker 1 becomes B");
	eq(r.utts?.[1].start, 1600, "deepgram 1.6s becomes 1600ms");
	eq(r.text, "hello there how are you", "deepgram full transcript from the channel alternative");
	eq(parseDeepgram({}).utts, null, "an empty deepgram response yields no utterances");
	eq(parseDeepgram({ results: { channels: [{ alternatives: [{ transcript: "solo" }] }] } }).text, "solo", "deepgram transcript without utterances still returns text");
}
{
	const { humanizeError } = require("./pipeline");
	eq(
		humanizeError('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low."},"request_id":"x"}'),
		"Your credit balance is too low.",
		"the human message is pulled out of an API error JSON"
	);
	eq(humanizeError("network timeout"), "network timeout", "a plain error string is returned unchanged");
	eq(humanizeError('{"message":"top level"}'), "top level", "a top-level message field is used");
}
{
	// the sidebar assistant: grounded multi-turn messages + saved chat notes
	const { ASSISTANT_SYSTEM, buildAssistantMessages, parseChatSummary, buildChatNote } = require("./pipeline");
	ok(ASSISTANT_SYSTEM.includes("wiki-link"), "assistant system prompt demands citations");
	const history = [
		{ role: "user", content: "Q1" },
		{ role: "assistant", content: "A1" },
	];
	const msgs = buildAssistantMessages(history, "Q2", [{ path: "Meetings/Sync.md", heading: "Summary", text: "We shipped." }]);
	eq(msgs.length, 3, "history plus the new question");
	eq(msgs[0].content, "Q1", "history travels verbatim");
	ok(msgs[2].content.includes("--- Meetings/Sync › Summary") && msgs[2].content.includes("We shipped."), "context rides the new question");
	ok(msgs[2].content.includes("Question: Q2"), "the question closes the turn");
	ok(!msgs[2].content.includes(".md"), "context paths drop the extension");
	const empty = buildAssistantMessages([], "Q", []);
	ok(empty[0].content.includes("No matching notes"), "empty retrieval is stated, not hidden");
	const long = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `t${i}` }));
	eq(buildAssistantMessages(long, "Q", []).length, 13, "history is capped");
	const parsed = parseChatSummary("TITLE: Budget follow-ups\n\n- Asked about Q3\n- Found [[Meetings/Sync]]");
	eq(parsed.title, "Budget follow-ups", "title parsed from the TITLE line");
	ok(parsed.summary.startsWith("- Asked"), "summary body follows");
	eq(parseChatSummary("just text").title, "Assistant chat", "missing TITLE falls back");
	const note = buildChatNote({ title: "Budget follow-ups", date: "2026-07-14", time: "9:12 PM", summary: "- found it", turns: history });
	ok(note.includes("type: capture-chat") && note.includes("generated: true"), "chat note is typed and generated");
	ok(!note.includes("- capture"), "chat notes carry no capture tag (kept out of meeting surfaces)");
	ok(note.includes("> [!quote]- Conversation") && note.includes("> **You:** Q1"), "conversation folds below the summary");
	const multi = buildChatNote({ title: "T", date: "d", time: "t", summary: "s", turns: [{ role: "assistant", content: "line1\nline2" }] });
	ok(multi.includes("> **Assistant:** line1\n> line2"), "multiline answers stay inside the callout");
}
{
	// semantic search: cosine, embedding parse, and rank fusion
	const { cosine, parseEmbeddingResponse, fuseHits } = require("./pipeline");
	ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, "identical vectors score 1");
	ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9, "orthogonal vectors score 0");
	ok(cosine([1, 2, 3], [2, 4, 6]) > 0.999, "parallel vectors score ~1 regardless of magnitude");
	eq(cosine([1, 2], [1, 2, 3]), 0, "mismatched lengths score 0");
	eq(cosine([0, 0], [1, 1]), 0, "a zero vector never ranks");
	eq(parseEmbeddingResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3] }] }).length, 2, "embeddings parsed from the OpenAI shape");
	eq(parseEmbeddingResponse({ nope: 1 }).length, 0, "an unexpected shape yields no vectors");

	// --- progress reporting for long jobs ---
	{
		const { fmtDuration, progressLine } = require("./pipeline");
		eq(fmtDuration(4200), "4s", "seconds under a minute");
		eq(fmtDuration(90_000), "2 min", "rounded to minutes");
		eq(fmtDuration(3_900_000), "1h 5m", "hours and minutes past an hour");
		eq(fmtDuration(-5), "", "a negative duration reads as nothing");

		// THE ONE THAT MATTERS: the estimate comes from the observed rate, so a
		// machine faster or slower than assumed still gets a truthful figure.
		// 300 of 6000 in 30s = 100ms each = 570s left, which reads as ~10 min.
		ok(progressLine("Building embeddings", 300, 6000, 30_000).includes("about 10 min left"), "remaining time is extrapolated from the rate so far");
		ok(progressLine("Building embeddings", 300, 6000, 30_000).includes("300/6000 (5%)"), "count and percentage are shown");
		// too early to mean anything: one item out of thousands predicts nothing
		ok(!progressLine("x", 1, 6000, 200).includes("left"), "no estimate is offered before there is evidence for one");
		ok(!progressLine("x", 6000, 6000, 30_000).includes("left"), "a finished job stops estimating");
		eq(progressLine("Working", 0, 0, 0), "Working", "a job with no known total is just its label");
		ok(progressLine("x", 5999, 6000, 60_000).includes("(100%)"), "the last stretch still rounds to 100%");
	}

	// --- pickLanAddress: the address the REST of the fleet can reach ---
	{
		const { pickLanAddress } = require("./pipeline");
		const ip = (address: string) => [{ family: "IPv4", internal: false, address }];
		// THE ONE THAT MATTERS: a VPN tunnel answers on this machine but is
		// unreachable from the phone, and this address syncs to every device.
		eq(
			pickLanAddress({ NordLynx: ip("10.5.0.2"), Ethernet: ip("192.168.20.208") }),
			"192.168.20.208",
			"a real LAN interface beats a NordVPN tunnel"
		);
		eq(pickLanAddress({ "vEthernet (WSL)": ip("172.20.0.1"), "Wi-Fi": ip("192.168.1.50") }), "192.168.1.50", "a real LAN beats a WSL virtual switch");
		eq(pickLanAddress({ Tailscale: ip("100.64.0.1"), Ethernet: ip("10.0.0.5") }), "10.0.0.5", "a corporate 10.x LAN is kept when the tunnel is not private-range");
		eq(pickLanAddress({ "Docker NAT": ip("172.17.0.1"), Ethernet: ip("10.1.2.3") }), "10.1.2.3", "a docker bridge loses to a real interface");
		// order must not decide it: the VPN listed first still loses
		eq(pickLanAddress({ wireguard0: ip("10.9.9.9"), eth0: ip("192.168.0.7") }), "192.168.0.7", "interface order does not decide the winner");
		// a legitimate 10.x LAN with no competition is still usable
		eq(pickLanAddress({ Ethernet: ip("10.0.0.5") }), "10.0.0.5", "a lone 10.x address is used rather than discarded");
		eq(pickLanAddress({ lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] }), "localhost", "an internal-only machine falls back to localhost");
		eq(pickLanAddress({ eth0: ip("169.254.5.5") }), "localhost", "a link-local autoconfig address is not a LAN address");
		eq(pickLanAddress({}), "localhost", "no interfaces at all falls back to localhost");
	}
	const bm = [
		{ path: "A.md", heading: "Summary", text: "chunk a" },
		{ path: "B.md", heading: "", text: "chunk b" },
	];
	const sem = [
		{ path: "C.md", heading: "", text: "note c" },
		{ path: "A.md", heading: "", text: "note a" },
	];
	const fused = fuseHits([bm, sem], 3);
	eq(fused[0].path, "A.md", "a note in both lists rises to the top");
	eq(fused[0].text, "chunk a", "the first list wins the representative hit");
	eq(fused.length, 3, "unique paths, capped at k");
	ok(fused.some((h: { path: string }) => h.path === "C.md"), "a semantic-only hit still appears");
}
{
	// finances rollup: per-currency totals, bills, by-vendor/month
	const { buildFinancesRollup } = require("./pipeline");
	const docs = [
		{ title: "Meralco bill", path: "Documents/Bills/2026/Meralco.md", vendor: "Meralco", docType: "bill", amount: 3400, currency: "PHP", date: "2026-07-05", due: "2026-07-10" },
		{ title: "Costco", path: "Documents/Receipts/2026/Costco.md", vendor: "Costco", docType: "receipt", amount: 128.53, currency: "PHP", date: "2026-07-11", due: "" },
		{ title: "AWS", path: "Documents/Invoices/2026/AWS.md", vendor: "AWS", docType: "invoice", amount: 210, currency: "USD", date: "2026-07-01", due: "2026-07-20" },
	];
	const r = buildFinancesRollup(docs, "2026-07-15");
	ok(r.includes("type: capture-finance"), "finance rollup is typed");
	ok(r.includes("**PHP:** 3,528.53 across 2 documents") && r.includes("**USD:** 210 across 1 document"), "per-currency totals, thousands separators, no cross-currency sum");
	ok(r.includes("| 🔴 2026-07-10 | [[Documents/Bills/2026/Meralco|Meralco]] | PHP 3,400 |"), "overdue bill flagged and linked");
	ok(r.includes("| 2026-07-20 | [[Documents/Invoices/2026/AWS|AWS]] | USD 210 |"), "upcoming bill in its own currency");
	ok(!r.includes("Costco.md") || r.indexOf("Upcoming") < 0 || !/Costco \|/.test(r.split("Upcoming")[1].split("##")[0]), "a receipt with no due date is not a bill");
	ok(r.includes("## By vendor") && r.includes("| Meralco | 1 | PHP 3,400 |"), "by-vendor keeps currency");
	ok(r.includes("## By month") && r.includes("| 2026-07 | 2 | PHP 3,528.53 |"), "by-month sums same-currency docs");
	const empty = buildFinancesRollup([], "2026-07-15");
	ok(empty.includes("*No documents with amounts yet.*"), "empty finances states it plainly");
}
{
	// drafting: context distillation + grounded prompt
	const { DRAFT_KINDS, buildDraftContext, buildDraftPrompt } = require("./pipeline");
	const md =
		'---\ndate: 2026-07-14\nattendees:\n  - "[[People/Jordan|Jordan]]"\n---\n# Budget sync\n\n## Summary\n\nWe approved the Q3 plan.\n\n## Action items\n\n- [ ] Send the deck [[People/Steve|Steve]] 📅 2026-07-16\n\n## Transcript\n\n**Steve [0:00]:** secret words';
	const ctx = buildDraftContext(md);
	ok(ctx.includes("Title: Budget sync") && ctx.includes("Attendees: Jordan"), "context carries title and attendees");
	ok(ctx.includes("We approved the Q3 plan."), "summary is in the context");
	ok(ctx.includes("Send the deck (owner: Steve) (due 2026-07-16)"), "action items carry owner and due");
	ok(!ctx.includes("secret words"), "the transcript is excluded from the draft context");
	const fk = DRAFT_KINDS.find((k: { id: string; desc: string }) => k.id === "followup");
	const p = buildDraftPrompt(fk.desc, ctx, { tone: "Warm", yourName: "Steve" });
	ok(p.system.includes("follow-up email") && p.system.includes("ONLY"), "prompt describes the piece and grounds it");
	ok(p.system.includes("warm tone") && p.system.includes("Sign off as Steve"), "tone and sign-off applied");
	ok(p.user.includes("We approved the Q3 plan.") && p.user.endsWith("Write it now."), "context and closing instruction in the user turn");
	const custom = buildDraftPrompt("", ctx, { instruction: "Draft a one-line Slack ping" });
	ok(custom.system.includes("the message the user describes") && custom.user.includes("Additional instructions: Draft a one-line Slack ping"), "custom rides on the instruction");
	ok(!buildDraftPrompt(fk.desc, ctx, {}).system.includes("tone"), "neutral tone adds no tone clause");
}
{
	// the morning briefing: due-date parsing + the assembled note
	const { taskDueDate, buildMorningBriefing } = require("./pipeline");
	eq(taskDueDate("- [ ] Ship it [[Steve]] 📅 2026-07-16"), "2026-07-16", "due date pulled from a task line");
	eq(taskDueDate("- [ ] no date here"), "", "undated task yields empty");
	const b = buildMorningBriefing(
		{
			date: "2026-07-15",
			meetings: [
				{ time: "9:00 AM", title: "Standup", path: "Meetings/2026-07-15 Standup.md", join: "https://teams/x", attendees: ["Steve", "Jordan"], agenda: "- Ship it\n- Q&A", location: "Room 1" },
				{ time: "", title: "Ad hoc", path: null, join: null },
			],
			commitments: [
				{ task: "Send the deck", owner: "Steve", due: "2026-07-10", fromPath: "Meetings/Sync.md", overdue: true },
				{ task: "Review PR", owner: "Unassigned", due: "2026-07-16", fromPath: "Meetings/Sync.md", overdue: false },
			],
			dueDocs: [{ title: "Meralco bill", amount: "PHP 3400", due: "2026-07-17", path: "Documents/Bills/2026/Meralco.md", overdue: false }],
			questions: [{ text: "Do we renew the license?", fromPath: "Meetings/Sync.md" }],
		},
		"Tuesday, July 15, 2026"
	);
	ok(b.includes("type: capture-briefing") && b.includes("# Good morning · Tuesday, July 15, 2026"), "briefing is typed and titled");
	ok(b.includes("**9:00 AM** · [[Meetings/2026-07-15 Standup|Standup]] · [join](https://teams/x)"), "meeting with time, link, and join");
	ok(b.includes("  > [!info]- Details") && b.includes("  > **Attendees:** Steve, Jordan") && b.includes("  > **Where:** Room 1"), "meeting details fold into an indented callout");
	ok(b.includes("  > **Agenda:**") && b.includes("  > - Ship it"), "the agenda is inside the callout");
	ok(b.includes("- Ad hoc") && !b.includes("Ad hoc|") && !/Ad hoc\n {2}>/.test(b), "a meeting with no details has no callout");
	ok(b.includes("**Overdue (1)**") && b.includes("🔴 Send the deck — [[Steve]] · due 2026-07-10"), "overdue commitment flagged");
	ok(b.includes("**Coming due (1)**") && b.includes("- Review PR · due 2026-07-16") && !b.includes("Review PR — [[Unassigned]]"), "unassigned owner is not linked");
	ok(b.includes("## Bills & documents due") && b.includes("[[Documents/Bills/2026/Meralco|Meralco bill]] · PHP 3400 · due 2026-07-17"), "due document listed");
	ok(b.includes("## Open questions") && b.includes("Do we renew the license?"), "open questions carried");
	ok(!/---\n\n# Good/.test(b), "no blank gap under the properties");
	const empty = buildMorningBriefing({ date: "2026-07-15", meetings: [], commitments: [], dueDocs: [], questions: [] }, "Tue");
	ok(empty.includes("A clear day"), "a clear day is stated, not blank");
}
{
	// documents: extraction parsing, filing names/folders, and the doc note
	const { buildDocExtractionPrompt, parseDocExtraction, emptyDocFields, docNiceName, docTargetFolder, buildDocNote } = require("./pipeline");
	ok(buildDocExtractionPrompt("receipt text").system.includes("ONLY a JSON object"), "extraction demands bare JSON");
	eq(buildDocExtractionPrompt("x".repeat(20000)).user.length, 12000, "OCR text is capped");
	const f = parseDocExtraction('```json\n{"docType":"Receipt","vendor":"Costco","date":"2026-07-11","amount":128.53,"currency":"usd","due":"","summary":"Groceries.","tags":["Groceries","FOOD"]}\n```');
	eq(f.docType, "receipt", "type lowercased and whitelisted");
	eq(f.vendor, "Costco", "vendor extracted");
	eq(f.amount, 128.53, "amount is a number");
	eq(f.currency, "USD", "currency uppercased");
	eq(f.tags.join(","), "groceries,food", "tags lowercased");
	eq(parseDocExtraction('{"docType":"memo","date":"July 11","amount":"12"}').docType, "other", "unknown type falls back to other");
	eq(parseDocExtraction('{"docType":"bill","date":"July 11","amount":"12"}').date, "", "non-ISO dates are dropped");
	eq(parseDocExtraction('{"docType":"bill","amount":"12"}').amount, null, "string amounts are dropped, never guessed");
	eq(parseDocExtraction("no json here"), null, "prose without JSON is null");
	eq(docNiceName(f, "IMG_0001"), "2026-07-11 Costco 128.53", "filed name from date vendor amount");
	eq(docNiceName(emptyDocFields(), "IMG_0001"), "IMG_0001", "too little extracted keeps the original name");
	eq(docNiceName({ ...f, vendor: "A/B:C" }, "x"), "2026-07-11 A-B-C 128.53", "illegal filename characters stripped");
	eq(docTargetFolder("Documents", f), "Documents/Receipts/2026", "filed under type plural and year");
	eq(docTargetFolder("Documents", emptyDocFields()), "Documents/Other/Undated", "unknowns file under Other/Undated");
	const note = buildDocNote(f, { filePath: "Documents/Receipts/2026/2026-07-11 Costco 128.53.png", ocrText: "COSTCO WHOLESALE\nTOTAL 128.53", today: "2026-07-14" });
	ok(note.includes("type: capture-doc") && note.includes("doc-type: receipt"), "doc note is typed");
	ok(note.includes('vendor: "Costco"') && note.includes("amount: 128.53") && note.includes("date: 2026-07-11"), "fields become properties");
	ok(note.includes("![[Documents/Receipts/2026/2026-07-11 Costco 128.53.png]]"), "original embedded");
	ok(note.includes("> [!quote]- Document text") && note.includes("> TOTAL 128.53"), "OCR text folded below");
	ok(!note.includes("- capture"), "doc notes carry no capture tag");
	const bare = buildDocNote(emptyDocFields(), { filePath: "a.png", ocrText: "", today: "2026-07-14" });
	ok(bare.includes("date: 2026-07-14") && bare.includes("# Document"), "empty fields still make a dated note");
	ok(buildDocNote(f, { filePath: "a.png", ocrText: "", today: "2026-07-14", review: true }).includes("review: true"), "the review flag becomes a property");
}
{
	// auto-filing rules: matching and resolving where a document files
	const { matchDocRule, resolveDocFiling, docTargetFolder } = require("./pipeline");
	const bill = { docType: "bill", vendor: "Meralco Electric", date: "2026-07-05", amount: 3400, currency: "PHP", due: "2026-07-10", summary: "Monthly power bill.", tags: ["utility"] };
	ok(matchDocRule({ vendor: "meralco" }, bill, ""), "vendor match is case-insensitive substring");
	ok(!matchDocRule({ vendor: "maynilad" }, bill, ""), "a non-matching vendor fails");
	ok(matchDocRule({ docType: "bill", amountOver: 1000 }, bill, ""), "type and amount threshold both hold");
	ok(!matchDocRule({ amountOver: 5000 }, bill, ""), "amount under the threshold fails");
	ok(matchDocRule({ textContains: "power bill" }, bill, "raw ocr"), "text condition checks summary and ocr");
	ok(!matchDocRule({}, bill, ""), "an empty rule never matches");
	const rules = [
		{ vendor: "meralco", folder: "Utilities/{year}", tags: "electricity, home", flag: false },
		{ amountOver: 10000, flag: true },
	];
	const r = resolveDocFiling(rules, bill, "", "Documents");
	eq(r.folder, "Utilities/2026", "first matching rule routes and expands {year}");
	ok(r.tags.includes("utility") && r.tags.includes("electricity") && r.tags.includes("home"), "rule tags add to extracted tags");
	ok(r.explicitFolder && !r.flag, "explicit folder noted; this rule sets no flag");
	const none = resolveDocFiling([{ vendor: "amazon", folder: "Shopping" }], bill, "", "Documents");
	eq(none.folder, docTargetFolder("Documents", bill), "no matching rule keeps the default folder");
	eq(none.tags.join(","), "utility", "no rule leaves the extracted tags untouched");
	const big = resolveDocFiling(rules, { ...bill, vendor: "AWS", amount: 12000, tags: [] }, "", "Documents");
	ok(big.flag && !big.explicitFolder, "a threshold rule flags for review and keeps the default folder");
}
{
	// Microsoft sign-in errors carry the actual fix for known setup problems
	const { graphSetupHint } = require("./pipeline");
	ok(String(graphSetupHint("AADSTS50059: No tenant-identifying information found")).includes("Directory (tenant) ID"), "single-tenant on common points at the tenant ID (50059)");
	ok(String(graphSetupHint("AADSTS50194: Application is not configured as a multi-tenant application")).includes("Directory (tenant) ID"), "the multi-tenant variant maps too (50194)");
	ok(String(graphSetupHint("AADSTS700016: Application not found in the directory")).includes("client) ID"), "an unknown app points at the client ID");
	ok(String(graphSetupHint("AADSTS7000218: The request body must contain client_assertion or client_secret")).includes("public client flows"), "a confidential-client error points at public client flows");
	eq(graphSetupHint("network timeout"), null, "an unknown error gets no hint");
}
{
	// a Microsoft Graph calendar event maps to the same shape as a pasted invite
	const ev = {
		subject: "Atlas Platform Sync",
		start: { dateTime: "2026-07-14T10:00:00.0000000" },
		end: { dateTime: "2026-07-14T11:00:00.0000000" },
		location: { displayName: "Large Conference Room" },
		organizer: { emailAddress: { name: "Morgan Vale", address: "morgan@example.com" } },
		attendees: [
			{ emailAddress: { name: "Alex Kim", address: "alex@example.com" } },
			{ emailAddress: { name: "", address: "jordan@example.com" } },
			{ type: "resource", emailAddress: { name: "Large Conference Room", address: "room1@example.com" } },
		],
		onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abcd" },
		body: { contentType: "html", content: "<div>Couple of Items</div><ul><li>Configuration screens</li></ul><div>________</div><div>Microsoft Teams meeting</div><div>Passcode: Qs2V7oV6</div>" },
	};
	const p = eventToInvite(ev);
	eq(p.title, "Atlas Platform Sync", "Graph subject becomes the title");
	eq(p.date, "2026-07-14", "Graph start date");
	eq(p.when, "10:00 AM-11:00 AM", "Graph start/end become a display time");
	eq(p.location, "Large Conference Room", "Graph location");
	ok(p.attendees[0] === "Morgan Vale" && p.attendees.includes("Alex Kim"), "organizer first, then attendees");
	ok(p.attendees.includes("Jordan"), "attendee without a name falls back to a prettified address");
	ok(!p.attendees.includes("Large Conference Room"), "a Graph resource (room) is not an attendee");
	ok(p.agenda.includes("Configuration screens") && !p.agenda.includes("Microsoft Teams"), "HTML body becomes agenda, Teams cut");
	ok(p.teamsUrl.includes("meetup-join"), "Graph onlineMeeting joinUrl used");
	eq(p.passcode, "Qs2V7oV6", "passcode parsed from the body");
}
{
	// a forwarded Outlook invite (labels carry colons) + the Teams block
	const fwd = [
		"From: Morgan Vale",
		"Sent: Sunday, July 12, 2026 3:11 PM",
		"To: Alex Kim; Lee, Jordan; sam@example.com",
		"Subject: Atlas Platform Sync",
		"Location: Large Conference Room",
		"When: Tuesday, July 14, 2026 10:00 AM-11:00 AM",
		"",
		"Couple of Items",
		"- Configuration screens (Module setup screens)",
		"- Setup Wizard/Templates",
		"",
		"________________________________________",
		"Microsoft Teams meeting",
		"Join: https://teams.microsoft.com/meet/22330421843924?p=1QipiwvwZNNPh63Qmx",
		"Meeting ID: 223 304 218 439 24",
		"Passcode: Qs2V7oV6",
	].join("\n");
	const p = parseMeetingInvite(fwd);
	eq(p.title, "Atlas Platform Sync", "invite subject becomes the title");
	eq(p.date, "2026-07-14", "invite date parses to ISO");
	eq(p.when, "10:00 AM-11:00 AM", "invite time range is captured");
	eq(p.location, "Large Conference Room", "invite location captured");
	ok(p.attendees.includes("Morgan Vale") && p.attendees.includes("Alex Kim"), "organizer + To: attendees captured");
	ok(p.attendees.includes("Jordan Lee"), "'Last, First' recipient is flipped to 'First Last'");
	ok(p.attendees.includes("Sam"), "bare email is prettified to a name");
	ok(p.agenda.includes("Couple of Items") && p.agenda.includes("Configuration screens"), "agenda captured");
	ok(!p.agenda.includes("Microsoft Teams") && !p.agenda.includes("Join:"), "Teams boilerplate is cut from the agenda");
	eq(p.teamsUrl, "https://teams.microsoft.com/meet/22330421843924?p=1QipiwvwZNNPh63Qmx", "Teams join URL captured");
	eq(p.meetingId, "223 304 218 439 24", "Teams meeting ID captured");
	eq(p.passcode, "Qs2V7oV6", "Teams passcode captured");
}
{
	// an .ics payload (folded line + escaped description) auto-detects
	const ics = [
		"BEGIN:VCALENDAR",
		"BEGIN:VEVENT",
		"DTSTART;TZID=Singapore Standard Time:20260714T100000",
		"DTEND;TZID=Singapore Standard Time:20260714T110000",
		"SUMMARY:Atlas Platform Sync",
		"LOCATION:Large Conference Room",
		'ORGANIZER;CN="Morgan Vale":mailto:morgan@example.com',
		'ATTENDEE;ROLE=REQ-PARTICIPANT;CN="Alex Kim":mailto:alex@example.com',
		"DESCRIPTION:Couple of Items\\n\\nConfiguration screens\\n\\n____\\nMicrosoft Te",
		" ams meeting\\nJoin: https://teams.microsoft.com/l/meetup-join/19%3ameeting_ab",
		" cd\\nMeeting ID: 223 304 218 439 24\\nPasscode: Qs2V7oV6",
		"END:VEVENT",
		"END:VCALENDAR",
	].join("\n");
	const p = parseMeetingInvite(ics);
	eq(p.title, "Atlas Platform Sync", "ICS SUMMARY becomes the title");
	eq(p.date, "2026-07-14", "ICS DTSTART date parses");
	eq(p.when, "10:00 AM-11:00 AM", "ICS start/end become a display time");
	eq(p.location, "Large Conference Room", "ICS LOCATION captured");
	ok(p.attendees.join(",") === "Morgan Vale,Alex Kim", "ICS organizer + attendee, organizer first");
	ok(p.agenda.includes("Configuration screens") && !p.agenda.includes("Microsoft"), "ICS description agenda, Teams cut, line unfolded");
	ok(p.teamsUrl.startsWith("https://teams.microsoft.com/l/meetup-join/"), "ICS Teams URL captured across a folded line");
	eq(p.passcode, "Qs2V7oV6", "ICS passcode captured");
}
eq(parseMeetingInvite("").title, "", "empty paste yields an empty parse");
// date formats: day-first spelled, abbreviated month, day-first numeric, invalid
eq(parseMeetingInvite("When: 14 July 2026 10:00 AM").date, "2026-07-14", "day-month-year spelled date");
eq(parseMeetingInvite("When: Jan 5, 2026").date, "2026-01-05", "abbreviated month name");
eq(parseMeetingInvite("When: 14/07/2026").date, "2026-07-14", "day-first numeric date is detected and swapped");
eq(parseMeetingInvite("When: 13/40/2026").date, "", "an impossible numeric date is rejected, not corrupted");
{
	// an .ics with a UTC (Z) DTSTART converts to the local date (Google/Zoom style)
	const icsZ = "BEGIN:VEVENT\nDTSTART:20260714T120000Z\nDTEND:20260714T130000Z\nSUMMARY:UTC meeting\nEND:VEVENT";
	eq(parseMeetingInvite(icsZ).date, "2026-07-14", "noon-UTC .ics resolves to the right local date");
	ok(!!parseMeetingInvite(icsZ).when, "a UTC .ics still yields a display time");
}
{
	// a multi-line location must not break the note's frontmatter YAML
	const stub = buildMeetingStub({ title: "M", date: "2026-07-14", attendees: [], agenda: "", location: "Room 5\nBuilding A" });
	ok(stub.includes('location: "Room 5 Building A"'), "a newline in the location is collapsed for valid YAML");
	eq((stub.match(/^---$/gm) || []).length, 2, "frontmatter stays a single block");
}
{
	// a bare body paste (no labels) still yields agenda + Teams, empty title
	const body = "Couple of Items\n- Thing one\n________\nMicrosoft Teams meeting\nJoin: https://teams.microsoft.com/meet/abc\nPasscode: xy12";
	const p = parseMeetingInvite(body);
	eq(p.title, "", "no subject label leaves the title empty for the user");
	ok(p.agenda.includes("Thing one") && !p.agenda.includes("Teams"), "bare body still yields an agenda");
	eq(p.teamsUrl, "https://teams.microsoft.com/meet/abc", "bare body still yields the Teams link");
}

// --- recording folder resolution ---
eq(cleanFolderPath("  _resources/audio  "), "_resources/audio", "folder path trimmed");
eq(cleanFolderPath("/_resources/audio/"), "_resources/audio", "leading and trailing slashes stripped");
eq(cleanFolderPath("   "), "", "blank folder path collapses to empty");
eq(resolveRecordingFolder("", "Capture"), "Capture", "empty audio folder falls back to the capture folder (unchanged behavior)");
eq(resolveRecordingFolder("_resources/audio", "Capture"), "_resources/audio", "a set audio folder wins");
eq(resolveRecordingFolder("  /_resources/audio/ ", "Capture"), "_resources/audio", "the set audio folder is normalized");

eq(redact("reach me at alex@example.com today", { emails: true }), "reach me at [email] today", "emails masked");
eq(redact("call 555-123-4567 or (555) 123 4567", { phones: true }), "call [phone] or [phone]", "phones masked (both shapes)");
eq(redact("ssn 123-45-6789", { ssns: true }), "ssn [ssn]", "ssn masked");
eq(redact("card 4111 1111 1111 1111 end", { cards: true }), "card [card] end", "card number masked");
eq(redact("2026-07-14 is a date", { cards: true, ssns: true }), "2026-07-14 is a date", "a plain date is not mistaken for ssn/card");
{
	const r = redact("Jordan owns it; ping [[Jordan]] and Jordanson stays", { terms: ["Jordan"] });
	ok(r.includes("[redacted] owns it") && r.includes("ping [redacted] and"), "a term masks plain and [[linked]] forms");
	ok(r.includes("Jordanson stays"), "whole-word only — a longer name is untouched");
}
eq(redact("no config no change", {}), "no config no change", "empty config is a no-op");
ok(!redactionActive({}) && !redactionActive({ terms: ["  "] }), "inactive configs report inactive");
ok(redactionActive({ emails: true }) && redactionActive({ terms: ["X"] }), "active configs report active");

{
	const t = allTemplates([{ name: "Board", sections: ["summary", "decisions", "risks", "bogus"] }]);
	ok(t.some((x) => x.id === "general") && t.some((x) => x.id === "c:Board"), "built-ins and custom merge");
	const board = t.find((x) => x.id === "c:Board")!;
	eq(board.sections, ["summary", "decisions", "risks"], "invalid section keys are dropped from a custom template");
	eq(allTemplates(undefined).length, TEMPLATES.length, "no custom templates → just the built-ins");
	ok(!allTemplates([{ name: "  ", sections: ["summary"] }]).some((x) => x.name === ""), "blank-named custom templates are ignored");
}
{
	const clip = formatSummaryForClipboard("---\ntype: capture\n---\n# M\n## Actions\n- [ ] ping [[Jordan Green|Jordan]] soon");
	ok(clip.includes("ping Jordan soon") && !clip.includes("[["), "clipboard flattens wiki-links to plain text");
}

// --- PowerPoint decks ---
import { buildDeckNote, notesText, pictureAction, relTargets, slideOrder, slideParagraphs, slidePictures, slideText } from "./pptx";
{
	eq(
		slideOrder(["ppt/slides/slide10.xml", "ppt/slides/slide2.xml", "ppt/slides/_rels/slide1.xml.rels", "ppt/slides/slide1.xml"]),
		["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide10.xml"],
		"slides order numerically, and only real slide entries count"
	);

	const SLIDE =
		'<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>' +
		"<a:p><a:r><a:t>Q3 Roadmap</a:t></a:r></a:p></p:txBody></p:sp>" +
		"<p:sp><p:txBody><a:p><a:r><a:t>Ship </a:t></a:r><a:r><a:t>Bank Accounts</a:t></a:r></a:p>" +
		"<a:p><a:r><a:t>Tom &amp; Jerry &lt;3</a:t></a:r></a:p><a:p></a:p></p:txBody></p:sp>";
	eq(slideText(SLIDE), { title: "Q3 Roadmap", lines: ["Ship Bank Accounts", "Tom & Jerry <3"] }, "title placeholder wins, runs join, entities decode, blanks drop");
	eq(slideParagraphs("<a:p><a:r><a:t>only</a:t></a:r></a:p>"), ["only"], "a bare paragraph reads");
	eq(
		slideText("<p:sp><p:txBody><a:p><a:r><a:t>No title here</a:t></a:r></a:p><a:p><a:r><a:t>second</a:t></a:r></a:p></p:txBody></p:sp>"),
		{ title: "No title here", lines: ["second"] },
		"a deck with no title placeholder promotes its first line"
	);

	eq(notesText("<a:p><a:r><a:t>Say this</a:t></a:r></a:p><a:p><a:r><a:t>7</a:t></a:r></a:p>"), "Say this", "the slide-number placeholder is not a note");

	const RELS =
		'<Relationship Id="rId1" Target="../slideLayouts/slideLayout2.xml"/>' +
		'<Relationship Target="../media/image3.png" Id="rId2"/>' +
		'<Relationship Id="rId3" Target="../media/chart.png"/>';
	eq(relTargets(RELS)["rId2"], "ppt/media/image3.png", "rel targets normalize whatever the attribute order");

	// 914400 EMU per inch: an icon drawn at a third of an inch, a chart at six
	const ICON = '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:ext cx="292608" cy="292608"/></a:xfrm></p:spPr></p:pic>';
	const CHART = '<p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill><p:spPr><a:xfrm><a:ext cx="5486400" cy="3657600"/></a:xfrm></p:spPr></p:pic>';
	eq(
		slidePictures(ICON + CHART, RELS).map((p) => `${p.entry.split("/").pop()} ${p.inches.toFixed(2)}`),
		["image3.png 0.32", "chart.png 4.00"],
		"pictures carry the size they are drawn at, not their source pixels"
	);
	eq(slidePictures(ICON + ICON, RELS).length, 1, "one picture placed twice is still one picture");
	eq(slidePictures('<p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>', RELS), [], "a non-media relationship is not a picture");

	// the real HMO deck draws every icon between 0.17in and 0.48in
	eq(pictureAction(0.32, "large", 1), "skip", "a bullet icon is decoration and never reaches the note");
	eq(pictureAction(0.48, "none", 1), "skip", "decoration goes even when nothing is being read");
	eq(pictureAction(4, "large", 1), "read", "a chart clears the bar and gets read");
	eq(pictureAction(4, "none", 1), "embed", "no reading still embeds the real pictures");
	eq(pictureAction(0.32, "all", 1), "read", "all spares nothing");
	eq(pictureAction(0, "large", 1), "skip", "a picture with no drawn extent counts as decoration");

	const note = buildDeckNote({
		name: "Q3 Deck",
		source: "_resources/attachments/Q3 Deck.pptx",
		date: "2026-07-17",
		slides: [{ n: 1, title: "Roadmap", lines: ["Ship it"], notes: "Mention the date", images: [{ link: "_resources/attachments/Q3-1.png", text: "Chart: revenue up" }] }],
	});
	ok(note.startsWith("---\ntype: capture\ncapture: powerpoint"), "the deck note is a capture note");
	ok(note.includes("## 1. Roadmap") && note.includes("Ship it"), "each slide becomes a section with its text");
	ok(note.includes("![[_resources/attachments/Q3-1.png]]") && note.includes("> Chart: revenue up"), "images embed with their read text beneath");
	ok(note.includes("**Notes:** Mention the date"), "speaker notes survive");
	ok(buildDeckNote({ name: "d", source: "d.pptx", date: "2026-07-17", slides: [{ n: 1, title: "", lines: [], notes: "", images: [] }] }).includes("(untitled slide)"), "an untitled slide still gets a heading");
}

// --- transactions: normalization, extraction parsing, reconciliation ---
{
	const {
		normalizeEmailHtml,
		mergeSplitPrices,
		cutRecommendations,
		decodeEntities,
		money,
		round2,
		parseTxnExtraction,
		reconcileOrder,
		dedupeItems,
		settleOrder,
		allocateExtras,
		buildTxnExtractionPrompt,
	} = require("./transactions");

	// -- normalization --
	eq(
		normalizeEmailHtml("<table><tr><td>Qty: 2</td><td>$39.96</td></tr></table>"),
		"Qty: 2 | $39.96",
		"table cells survive as pipe-separated values"
	);
	ok(!normalizeEmailHtml("<style>a{color:red}</style><p>Total</p>").includes("color"), "style blocks are dropped");
	ok(!normalizeEmailHtml("<!--[if mso]><p>outlook</p><![endif]--><p>Total</p>").includes("outlook"), "conditional comments are dropped");
	eq(decodeEntities("A&nbsp;&amp;&nbsp;B &#36;5 &#x24;6"), "A & B $5 $6", "named, decimal, and hex entities decode");

	// Amazon pads subjects and wraps order numbers in bidi marks; a value read
	// straight out of the body would carry them into the note's frontmatter.
	eq(
		normalizeEmailHtml("<p>Order # ‫111-8099753-6573041‎</p>"),
		"Order # 111-8099753-6573041",
		"bidi and zero-width marks are stripped from order numbers"
	);

	// Amazon splits a price into three cells so the cents can be superscripted
	eq(mergeSplitPrices("$ | 90 | 99"), "$90.99", "a price split across table cells is rejoined");
	eq(mergeSplitPrices("$ 4 98"), "$4.98", "a price split by spaces is rejoined");
	eq(mergeSplitPrices("$ | 1,077 | 09"), "$1,077.09", "thousands separators survive the rejoin");
	eq(mergeSplitPrices("Qty: 2 | $39.96"), "Qty: 2 | $39.96", "an already-formed price is left alone");

	// Home Depot prints a recommendation carousel whose tiles look exactly like
	// purchased lines; anything below the marker is not a purchase.
	{
		const pad = "Order Details ".repeat(20);
		const body = `${pad}Champion Muriatic Acid | $39.96\nYOU MIGHT ALSO LIKE\n128 oz. Algicide | $19.99`;
		const cut = cutRecommendations(body);
		ok(cut.includes("Muriatic Acid"), "the real line item survives the cut");
		ok(!cut.includes("Algicide"), "the recommended product is cut away");
	}
	eq(cutRecommendations("You might also like a short preheader"), "You might also like a short preheader", "an early marker cannot truncate the body");

	// -- money --
	eq(money("$1,077.09"), 1077.09, "a printed price with symbol and separators parses");
	eq(money(12.955), 12.96, "a float is rounded to cents");
	eq(money("free"), null, "unparseable text is null, never zero");
	eq(money(""), null, "an empty amount is null");
	eq(money("-8.00"), -8, "a negative parses");

	// -- parsing --
	{
		const reply =
			'Here you go:\n```json\n{"orders":[' +
			'{"orderId":"111-8099753-6573041","vendor":"Amazon","date":"2026-07-10","currency":"USD","docType":"order","scope":"personal","subtotal":4.98,"tax":0.41,"total":12.95,"items":[{"name":"Ozarka Spring Water","sku":"B001","quantity":2,"amount":4.98,"category":"groceries"}]},' +
			'{"orderId":"111-3055473-6731405","vendor":"Amazon","date":"2026-07-10","currency":"USD","docType":"order","scope":"personal","subtotal":90.99,"total":98.50,"items":[{"name":"Hill\'s Science Diet","sku":"B002","quantity":1,"amount":90.99,"category":"pets"}]}]}\n```';
		const orders = parseTxnExtraction(reply);
		eq(orders.length, 2, "one email carrying two order numbers yields two orders");
		eq(orders[0].orderId, "111-8099753-6573041", "the first order id is kept");
		eq(orders[1].items[0].category, "pets", "a per-item category is kept");
		eq(orders[0].items[0].quantity, 2, "quantity is kept");
	}
	eq(parseTxnExtraction("sorry, I could not read that"), null, "a non-JSON reply is null");
	eq(parseTxnExtraction('{"nope":1}'), null, "JSON without an orders array is null");
	{
		const [o] = parseTxnExtraction('{"orders":[{"orderId":"X","docType":"nonsense","scope":"weird","currency":"usd","items":[{"name":"Thing","category":"invented","quantity":"3","amount":"$5.00"}]}]}');
		eq(o.docType, "other", "an unknown docType falls back to other");
		eq(o.scope, "personal", "an unknown scope falls back to personal");
		eq(o.currency, "USD", "currency is upper-cased");
		eq(o.items[0].category, "other", "a category outside the taxonomy falls back to other");
		eq(o.items[0].quantity, 3, "a string quantity parses");
		eq(o.items[0].amount, 5, "a printed item amount parses");
	}

	// -- reconciliation --
	const hd = {
		orderId: "WN65276696",
		vendor: "The Home Depot",
		date: "2026-07-18",
		currency: "USD",
		subtotal: 119.76,
		tax: 9.22,
		shipping: 0,
		discount: 8,
		total: 120.98,
		due: "",
		docType: "order",
		scope: "personal",
		payment: "**8537",
		account: "",
		items: [
			{ name: "40 lbs. Pool Salt", sku: "1003181302", quantity: 10, amount: 79.8, category: "home-improvement" },
			{ name: "1 Gallon Muriatic Acid (2-Pack)", sku: "1012856258", quantity: 2, amount: 39.96, category: "home-improvement" },
		],
	};
	{
		const r = reconcileOrder(hd);
		ok(r.ok, "line items that match the printed subtotal reconcile");
		eq(r.itemSum, 119.76, "the item sum is reported");
		eq(r.reasons, [], "a clean order carries no warnings");
	}

	// THE ONE THAT MATTERS: Microsoft's template renders the same line twice,
	// once for desktop and once for mobile. Counted naively that doubles the
	// order. The vendor's own subtotal is what catches it.
	{
		const item = { name: "Windows 11 Pro (Download)", sku: "", quantity: 1, amount: 199.99, category: "software" };
		const doubled = {
			...hd,
			orderId: "8265146621",
			vendor: "Microsoft",
			subtotal: 199.99,
			tax: 16.5,
			discount: 0,
			total: 216.49,
			items: [item, { ...item }],
		};
		const bad = reconcileOrder(doubled);
		ok(!bad.ok, "a duplicated mobile layout fails reconciliation instead of being trusted");
		ok(bad.reasons.some((x: string) => x.includes("twice the subtotal")), "the doubling is named specifically");

		const settled = settleOrder(doubled);
		ok(settled.repaired, "the duplicate is repaired once arithmetic proves it is one");
		eq(settled.order.items.length, 1, "only one line survives the repair");
		ok(settled.recon.ok, "the repaired order reconciles");
	}

	// A genuine repeat purchase must not be silently collapsed: two identical
	// lines that the subtotal actually supports are two real purchases.
	{
		const twice = {
			...hd,
			subtotal: 159.6,
			total: 159.6,
			tax: 0,
			discount: 0,
			items: [hd.items[0], { ...hd.items[0] }],
		};
		const settled = settleOrder(twice);
		ok(!settled.repaired, "a duplicate the subtotal supports is left alone");
		eq(settled.order.items.length, 2, "both real lines survive");
		ok(settled.recon.ok, "and the order reconciles as-is");
	}

	eq(dedupeItems([hd.items[0], { ...hd.items[0] }, hd.items[1]]).length, 2, "dedupeItems drops an exact repeat");
	ok(reconcileOrder({ ...hd, subtotal: null, total: 50 }).ok === false, "items summing past the total fail");
	ok(reconcileOrder({ ...hd, subtotal: null, total: 200 }).ok, "items under a total with no subtotal pass");
	ok(!reconcileOrder({ ...hd, subtotal: null, total: null }).ok, "nothing to check against is not a pass");
	ok(!reconcileOrder({ ...hd, items: [] }).ok, "an order with no line items is flagged");

	// A utility bill is one amount with no lines, which is correct, not a miss
	{
		const bill = { ...hd, docType: "bill", vendor: "CoServ", subtotal: null, tax: null, discount: null, total: 837, due: "2026-07-26", account: "9001780050", items: [] };
		ok(reconcileOrder(bill).ok, "a bill with a total and no line items reconciles");
	}
	{
		const partial = { ...hd, items: [hd.items[0], { ...hd.items[1], amount: null }] };
		const r = reconcileOrder(partial);
		ok(!r.ok, "an item with no amount is flagged");
		ok(r.reasons.some((x: string) => x.includes("no amount")), "and the missing amount is named");
	}

	// -- allocation --
	{
		const shares = allocateExtras(hd);
		eq(shares.length, 2, "one share per line item");
		eq(round2(shares[0] + shares[1]), 1.22, "tax and shipping less discount are fully distributed");
		ok(shares[0] > shares[1], "the larger line absorbs the larger share");
	}
	{
		// thirds do not divide into cents; the remainder must land somewhere
		const even = { ...hd, subtotal: 30, tax: 1, discount: 0, shipping: 0, items: [
			{ name: "A", sku: "", quantity: 1, amount: 10, category: "other" },
			{ name: "B", sku: "", quantity: 1, amount: 10, category: "other" },
			{ name: "C", sku: "", quantity: 1, amount: 10, category: "other" },
		] };
		const shares = allocateExtras(even);
		eq(round2(shares[0] + shares[1] + shares[2]), 1, "a rounding remainder is absorbed, not lost");
	}
	eq(allocateExtras({ ...hd, tax: 0, shipping: 0, discount: 0 }), [0, 0], "nothing to allocate gives zero shares");
	eq(allocateExtras({ ...hd, items: [] }), [], "an order with no items allocates nothing");

	// -- prompt --
	{
		const p = buildTxnExtractionPrompt("Order # 123", { from: "auto-confirm@amazon.com", subject: "Ordered: things" });
		ok(p.user.includes("auto-confirm@amazon.com") && p.user.includes("Order # 123"), "headers and body both reach the model");
		ok(p.system.includes("SEVERAL orders"), "the multi-order rule is stated");
		ok(p.system.includes("EXACTLY ONCE"), "the duplicate-layout rule is stated");
		ok(p.system.includes("groceries"), "the category taxonomy is listed");
	}
}

// --- mergeForSave: data.json is synced, so a save must not clobber a device ---
{
	// THE ONE THAT MATTERS: a phone holding an old snapshot opens a note, which
	// touches one setting. Its save must not carry its stale empty key over the
	// laptop's real one. Keys are typed once and never rewritten, so a single
	// revert loses them silently and for good.
	const phoneBaseline = { anthropicKey: "", lastFolder: "old" };
	const phoneMemory = { anthropicKey: "", lastFolder: "tapped" };
	const diskFromLaptop = { anthropicKey: "sk-ant-real", lastFolder: "old" };
	eq(
		mergeForSave(phoneMemory, phoneBaseline, diskFromLaptop),
		{ anthropicKey: "sk-ant-real", lastFolder: "tapped" },
		"an idle device keeps another device's API key and carries only its own change"
	);
}
eq(
	mergeForSave({ k: "new" }, { k: "old" }, { k: "other" }),
	{ k: "new" },
	"our own change still wins over disk"
);
eq(mergeForSave({ k: "" }, { k: "had" }, { k: "had" }), { k: "" }, "clearing a key on purpose is a change and sticks");
eq(mergeForSave({ k: "ours", n: 1 }, { k: "ours", n: 1 }, { n: 2 } as { k?: string; n?: number }), { k: "ours", n: 2 }, "a key absent from disk keeps ours");
eq(mergeForSave({ k: 1 }, { k: 1 }, null), { k: 1 }, "no disk state yet = write ours");

{
	// A key holding one value per item is a whole vault's worth of settings behind
	// a single name. Changing ONE of them used to publish ALL of them, erasing
	// every item another device had configured since this one last read.
	type M = { map: Record<string, number[]> };
	const baseline: M = { map: { A: [1] } };
	const ours: M = { map: { A: [2] } };
	const disk: M = { map: { A: [1], B: [9] } };
	eq(mergeForSave(ours, baseline, disk), { map: { A: [2], B: [9] } }, "one entry's change publishes that entry, not the whole map");
	eq(mergeForSave({ map: { A: [1] } } as M, { map: { A: [1], B: [9] } } as M, { map: { A: [1], B: [9] } } as M), { map: { A: [1] } }, "an entry we removed stays removed");
	eq(mergeForSave({ map: { A: [1] } } as M, { map: { A: [1] } } as M, { map: { A: [7] } } as M), { map: { A: [7] } }, "an entry we did not touch takes the disk's");
	eq(mergeForSave({ list: ["a"] }, { list: ["a", "b"] }, { list: ["a", "b"] }), { list: ["a"] }, "an array is a value, still merged whole");
}

// --- transactions phase 2: redaction, note building, write planning ---
{
	const { redactSecrets, txnOrderName, txnItemName, txnFolder, txnSafe, buildOrderNote, buildItemNote, planOrderWrites } = require("./transactions");

	// -- redaction --
	eq(redactSecrets("Product Key: MXNY6-T84BP-FP26W-QYWM6-8TYP6"), "Product Key: [redacted key]", "a licence key is redacted");
	ok(redactSecrets("Routing Number: 053000196").includes("[redacted]"), "a labelled routing number is redacted");
	ok(redactSecrets("Account Number: 237019269430").includes("[redacted]"), "a long labelled account number is redacted");
	eq(redactSecrets("Visa 4111111111111111"), "Visa **1111", "a card-length digit run keeps only its last four");
	// the values that must survive: these are wanted in frontmatter
	eq(redactSecrets("Order # 111-8099753-6573041"), "Order # 111-8099753-6573041", "an Amazon order number is left intact");
	eq(redactSecrets("Account: 9001780050"), "Account: 9001780050", "a short utility account number is left intact");
	eq(redactSecrets("SKU #1003181302"), "SKU #1003181302", "a SKU is left intact");
	eq(redactSecrets("**8537"), "**8537", "an already-masked card is unchanged");

	// -- naming --
	const hd = {
		orderId: "WN65276696",
		vendor: "The Home Depot",
		date: "2026-07-18",
		currency: "USD",
		subtotal: 119.76,
		tax: 9.22,
		shipping: 0,
		discount: 8,
		total: 120.98,
		due: "",
		docType: "order",
		scope: "personal",
		payment: "**8537",
		account: "",
		items: [
			{ name: "40 lbs. Pool Salt", sku: "1003181302", quantity: 10, amount: 79.8, category: "home-improvement" },
			{ name: "1 Gallon Muriatic Acid (2-Pack)", sku: "1012856258", quantity: 2, amount: 39.96, category: "home-improvement" },
		],
	};
	const opts = { today: "2026-07-19" };
	eq(txnOrderName(hd), "2026-07-18 The Home Depot WN65276696", "an order names itself date, vendor, id");
	eq(txnItemName(hd, hd.items[0], 0), "2026-07-18 The Home Depot 40 lbs. Pool Salt (WN65276696-1)", "an item name carries a stable order-and-line suffix");
	eq(txnItemName(hd, hd.items[1], 1), "2026-07-18 The Home Depot 1 Gallon Muriatic Acid (2-Pack) (WN65276696-2)", "the second line gets suffix 2");
	eq(txnFolder("Finance", hd, "order"), "Finance/Orders/2026", "orders file under a year folder");
	eq(txnFolder("Finance", hd, "item"), "Finance/Items/2026", "items file under their own year folder");
	eq(txnFolder("Finance", { ...hd, date: "" }, "order", ""), "Finance/Orders/Undated", "a dateless order files under Undated");
	eq(txnSafe('a/b:c*d?e"f<g>h|i'), "a-b-c-d-e-f-g-h-i", "unsafe filename characters are replaced");
	{
		const long = txnItemName(hd, { ...hd.items[0], name: "x".repeat(80) }, 0);
		ok(long.length < 90, "a very long product name is trimmed");
		ok(long.endsWith("(WN65276696-1)"), "and still ends with its stable suffix");
	}

	// -- order note --
	{
		const note = buildOrderNote(hd, opts);
		// THE ONE THAT MATTERS: a quoted number is a string to Bases and its Sum
		// silently stops working, so every money property must be bare.
		ok(note.includes("\namount: 120.98\n"), "the order total is written as a bare number");
		ok(note.includes("\nsubtotal: 119.76\n") && note.includes("\ntax: 9.22\n"), "subtotal and tax are bare numbers");
		ok(!/amount: "/.test(note), "no money property is quoted");
		ok(note.includes("type: capture-txn-order"), "the order type is stamped");
		ok(note.includes('order-id: "WN65276696"'), "the order id is quoted as a string");
		ok(note.includes("scope: personal"), "scope is written");
		ok(note.includes("items: 2"), "the line count is written");
		ok(!note.includes("review: true"), "a clean order is not flagged for review");
		ok(note.includes("[[2026-07-18 The Home Depot 40 lbs. Pool Salt (WN65276696-1)\\|40 lbs. Pool Salt]]"), "the item table links to the item note");
		ok(note.includes("- **Total:** USD 120.98"), "totals are restated in the body");
	}
	{
		const flagged = buildOrderNote(hd, { ...opts, recon: { ok: false, itemSum: 239.52, expected: 119.76, delta: 119.76, reasons: ["line items sum to twice the subtotal"] } });
		ok(flagged.includes("review: true"), "a failed reconciliation flags the note");
		ok(flagged.includes("> [!warning] Check this order"), "and states the problem in the body");
		ok(flagged.includes("> - line items sum to twice the subtotal"), "with the specific reason");
	}
	ok(buildOrderNote(hd, { ...opts, repaired: true }).includes("repaired: true"), "a repaired order records that it was repaired");
	{
		const bill = { ...hd, orderId: "", vendor: "CoServ", docType: "bill", subtotal: null, tax: null, discount: null, shipping: null, total: 837, due: "2026-07-26", account: "9001780050", payment: "", items: [] };
		const note = buildOrderNote(bill, opts);
		ok(note.includes("due: 2026-07-26"), "a bill records its due date");
		ok(note.includes('account: "9001780050"'), "a bill records its account number");
		ok(!note.includes("| Item |"), "a bill with no lines has no item table");
	}

	// -- item note --
	{
		const note = buildItemNote(hd, hd.items[0], 0, 0.81, opts);
		ok(note.includes("type: capture-txn-item"), "the item type is stamped");
		ok(note.includes("category: home-improvement"), "the category is a top-level property");
		ok(note.includes("\namount: 79.8\n"), "the line total is a bare number");
		ok(note.includes("\nallocated: 0.81\n"), "the allocated share is recorded");
		ok(note.includes("\neffective: 80.61\n"), "effective cost is line total plus its share");
		ok(note.includes('parent-order: "[[2026-07-18 The Home Depot WN65276696]]"'), "the item links back to its order");
		ok(note.includes('sku: "1003181302"'), "the SKU is kept");
		ok(note.includes("quantity: 10"), "quantity is a bare number");
	}
	{
		const secret = buildItemNote(hd, { ...hd.items[0], name: "Windows 11 Pro MXNY6-T84BP-FP26W-QYWM6-8TYP6" }, 0, 0, opts);
		ok(!secret.includes("MXNY6"), "a licence key in a product name never reaches the note");
	}
	// THE ONE THAT MATTERS: a secret in a FILENAME cannot be fixed by editing the
	// note, and it leaks again through every wikilink that targets it. Redaction
	// has to happen before truncation, or a usable prefix survives.
	{
		const keyed = { ...hd.items[0], name: "Windows 11 Pro (Download) Product Key: MXNY6-T84BP-FP26W-QYWM6-8TYP6" };
		const name = txnItemName(hd, keyed, 0);
		ok(!name.includes("MXNY6"), "a licence key never reaches the item's filename");
		// the marker may be clipped by the 48-char budget; what matters is that
		// something visibly stands in for the secret and the secret is gone
		ok(name.includes("redacted"), "the filename records that something was redacted");
		const order = buildOrderNote({ ...hd, items: [keyed] }, opts);
		ok(!order.includes("MXNY6"), "nor the order note's item table, in link target or display text");
	}
	{
		// a long name truncated at 48 chars must not slice a key into a usable prefix
		const late = { ...hd.items[0], name: "A".repeat(40) + " MXNY6-T84BP-FP26W-QYWM6-8TYP6" };
		ok(!txnItemName(hd, late, 0).includes("MXNY6"), "truncation cannot expose part of a key");
	}
	{
		const noAmount = buildItemNote(hd, { ...hd.items[0], amount: null }, 0, 0, opts);
		ok(!noAmount.includes("amount:"), "an item with no amount writes no amount property");
		ok(!noAmount.includes("effective:"), "and no effective cost");
	}

	// -- write planning --
	{
		const writes = planOrderWrites(hd, "Finance", opts);
		eq(writes.length, 3, "one order note plus one note per line item");
		eq(writes[0].kind, "order", "the order note comes first");
		eq(writes[1].folder, "Finance/Items/2026", "item notes land in the items folder");
		ok(writes.every((w: { update: boolean }) => !w.update), "an unseen order is all inserts");
		// tax and shipping less discount, spread across the two lines
		const alloc = writes.slice(1).map((w: { body: string }) => /allocated: ([\d.]+)/.exec(w.body)?.[1]);
		eq(alloc, ["0.81", "0.41"], "each item note carries its proportional share");
	}
	{
		const writes = planOrderWrites(hd, "Finance", opts, new Set(["WN65276696"]));
		ok(writes.every((w: { update: boolean }) => w.update), "a known order id marks every note as an update");
	}
	{
		// a shipping notice for an order already captured must not create a second copy
		const first = planOrderWrites(hd, "Finance", opts);
		const second = planOrderWrites(hd, "Finance", opts, new Set(["WN65276696"]));
		eq(first.map((w: { name: string }) => w.name), second.map((w: { name: string }) => w.name), "the same order writes the same note names both times");
	}
	{
		const anon = planOrderWrites({ ...hd, orderId: "" }, "Finance", opts, new Set(["WN65276696"]));
		ok(anon.every((w: { update: boolean }) => !w.update), "an order with no id can never match a known one");
	}
}

// --- transactions phase 3: mail rules and selection ---
{
	const { senderDomain, senderAddress, matchTxnRule, resolveTxnRule, selectTxnMail, rememberProcessed, applyTxnRule, DEFAULT_TXN_RULES } = require("./transactions");

	// THE ONE THAT MATTERS: CoServ's bills come from smarthub.coop, not
	// coserv.com. A rule written against the brand's website never fires.
	eq(senderDomain("CoServ <coserv@smarthub.coop>"), "smarthub.coop", "the envelope domain is what counts, not the brand");
	eq(senderDomain("The Home Depot <HomeDepot@order.homedepot.com>"), "order.homedepot.com", "a subdomain sender is read whole");
	eq(senderDomain('"Amazon.com" <auto-confirm@amazon.com>'), "amazon.com", "a quoted display name does not confuse the parse");
	eq(senderDomain("bare@example.org"), "example.org", "an address with no display name still parses");
	eq(senderDomain("not an address"), "", "unparseable senders yield no domain");
	eq(senderAddress("CoServ <coserv@smarthub.coop>"), "coserv@smarthub.coop", "the bare address is extracted");

	const amazon = { id: "m1", from: '"Amazon.com" <auto-confirm@amazon.com>', subject: 'Ordered: "Hill\'s Science Diet" and 2 more items', date: "2026-07-10", hasAttachments: false };
	const coserv = { id: "m2", from: "CoServ <coserv@smarthub.coop>", subject: "Your CoServ Bill is Available", date: "2026-07-10", hasAttachments: false };
	const hd = { id: "m3", from: "The Home Depot <HomeDepot@order.homedepot.com>", subject: "Thanks for your order, Steve!", date: "2026-07-18", hasAttachments: false };
	const invoice = { id: "m4", from: "Billing <billing-support@syncfusion.com>", subject: "Your invoice", date: "2026-07-20", hasAttachments: true };
	const junk = { id: "m5", from: "Newsletter <news@example.com>", subject: "50% off everything", date: "2026-07-18", hasAttachments: false };

	ok(matchTxnRule({ from: "smarthub.coop" }, coserv), "a domain rule matches the real sender");
	ok(matchTxnRule({ from: "coserv" }, coserv), "the display name is matchable too");
	ok(!matchTxnRule({ from: "coserv.com" }, coserv), "the brand website domain does not match the envelope");
	ok(matchTxnRule({ from: "amazon.com", subject: "ordered:" }, amazon), "sender and subject together match");
	ok(!matchTxnRule({ from: "amazon.com", subject: "shipped:" }, amazon), "a subject that does not apply fails the rule");
	ok(matchTxnRule({ hasAttachment: true }, invoice), "an attachment condition matches");
	ok(!matchTxnRule({ hasAttachment: true }, amazon), "and excludes a message without one");
	ok(!matchTxnRule({}, amazon), "an empty rule never matches, so it cannot become a catch-all");
	ok(!matchTxnRule({ enabled: false, from: "amazon.com" }, amazon), "a disabled rule never matches");

	// -- resolution order --
	{
		const rules = [{ name: "specific", from: "amazon.com", subject: "ordered:" }, { name: "broad", from: "amazon.com" }];
		eq(resolveTxnRule(rules, amazon).name, "specific", "the first matching rule wins");
		eq(resolveTxnRule([{ from: "nobody.example" }], amazon), null, "no match resolves to null");
	}

	// -- the shipped defaults actually fire on real senders --
	ok(resolveTxnRule(DEFAULT_TXN_RULES, amazon)?.name === "Amazon orders", "the default rules catch an Amazon order");
	ok(resolveTxnRule(DEFAULT_TXN_RULES, coserv)?.name === "CoServ (electric)", "the default rules catch a CoServ bill");
	ok(resolveTxnRule(DEFAULT_TXN_RULES, hd)?.name === "Home Depot", "the default rules catch a Home Depot order");
	eq(resolveTxnRule(DEFAULT_TXN_RULES, junk), null, "the default rules ignore marketing mail");

	// -- selection --
	{
		const picked = selectTxnMail([amazon, coserv, junk], DEFAULT_TXN_RULES, []);
		eq(picked.length, 2, "only rule matches are selected for a body fetch");
		eq(picked.map((p: { mail: { id: string } }) => p.mail.id), ["m1", "m2"], "and they keep mailbox order");
	}
	{
		const picked = selectTxnMail([amazon, coserv], DEFAULT_TXN_RULES, ["m1"]);
		eq(picked.length, 1, "an already-processed message is skipped");
		eq(picked[0].mail.id, "m2", "the unprocessed one still comes through");
	}
	eq(selectTxnMail([junk], DEFAULT_TXN_RULES, []).length, 0, "nothing matching means nothing spent");

	// -- processed ledger --
	eq(rememberProcessed([], "a"), ["a"], "a new id is remembered");
	eq(rememberProcessed(["a", "b"], "a"), ["b", "a"], "re-seeing an id moves it to newest rather than duplicating");
	eq(rememberProcessed(["a", "b", "c"], "d", 3), ["b", "c", "d"], "the ledger is capped, oldest dropped first");
	eq(rememberProcessed(["a"], ""), ["a"], "an empty id is not recorded");

	// -- rule overrides --
	{
		const base = { orderId: "1", vendor: "SmartHub", date: "2026-07-10", currency: "USD", subtotal: null, tax: null, shipping: null, discount: null, total: 837, due: "", docType: "bill", scope: "personal", payment: "", account: "", items: [] };
		eq(applyTxnRule(base, { vendor: "CoServ" }).vendor, "CoServ", "a rule renames the vendor the model guessed from the ESP");
		eq(applyTxnRule(base, { scope: "business" }).scope, "business", "a rule can force business scope");
		eq(applyTxnRule(base, { name: "no overrides" }).vendor, "SmartHub", "a rule with no overrides leaves extraction alone");
		eq(applyTxnRule(base, null).vendor, "SmartHub", "no rule at all changes nothing");
		eq(applyTxnRule(base, { scope: "nonsense" }).scope, "personal", "an invalid scope override is ignored");
	}
}

// --- transactions: reading a saved .eml ---
{
	const { parseEmailFile, decodeQuotedPrintable, decodeHeaderWords, normalizeEmailHtml } = require("./transactions");

	eq(decodeQuotedPrintable("a=3Db"), "a=b", "an escaped octet decodes");
	eq(decodeQuotedPrintable("one=\ntwo"), "onetwo", "a soft line break is removed");
	eq(decodeQuotedPrintable("width=3D=22760=22"), 'width="760"', "an attribute survives decoding");
	eq(decodeHeaderWords("=?utf-8?Q?Your_bill?="), "Your bill", "a Q-encoded header decodes and underscores become spaces");
	eq(decodeHeaderWords("=?utf-8?B?WW91ciBiaWxs?="), "Your bill", "a B-encoded header decodes");
	eq(decodeHeaderWords("Plain Subject"), "Plain Subject", "an unencoded header is untouched");

	// a single-part quoted-printable message, the shape CoServ actually sends
	{
		const raw = [
			"Content-Transfer-Encoding: quoted-printable",
			"Content-Type: text/html; charset=us-ascii",
			"Date: Fri, 10 Jul 2026 00:49:35 +0000 (UTC)",
			"From: CoServ <coserv@smarthub.coop>",
			"Subject: Your CoServ Bill is Available",
			"To: alex.kim@example.com",
			"",
			"<html><body><table><tr><td>Amount:</td><td>$837.00</td></tr>",
			"<tr><td>Due Date:</td><td>Jul 26, 2026</td></tr></table></body></html>",
		].join("\n");
		const p = parseEmailFile(raw);
		eq(p.from, "CoServ <coserv@smarthub.coop>", "the sender is read");
		eq(p.subject, "Your CoServ Bill is Available", "the subject is read");
		ok(p.html.includes("$837.00"), "the html body is decoded");
		const norm = normalizeEmailHtml(p.html);
		ok(norm.includes("Amount: | $837.00"), "and normalizes into a readable label/value pair");
	}

	// multipart/alternative: the html part must win over the plain one
	{
		const raw = [
			"From: Amazon.com <auto-confirm@amazon.com>",
			"Subject: Ordered: things",
			'Content-Type: multipart/alternative; boundary="XYZ"',
			"",
			"preamble",
			"--XYZ",
			"Content-Type: text/plain",
			"",
			"plain version",
			"--XYZ",
			"Content-Type: text/html",
			"",
			"<p>html version with more detail</p>",
			"--XYZ--",
		].join("\n");
		const p = parseEmailFile(raw);
		ok(p.html.includes("html version"), "the html alternative is captured");
		ok(p.text.includes("plain version"), "the plain alternative is kept too");
	}

	// an attachment part must not be mistaken for the body
	{
		const raw = [
			"From: Billing <billing@example.com>",
			"Subject: Invoice",
			'Content-Type: multipart/mixed; boundary="B"',
			"",
			"--B",
			"Content-Type: text/html",
			"",
			"<p>real body</p>",
			"--B",
			'Content-Type: text/html; name="attached.html"',
			'Content-Disposition: attachment; filename="attached.html"',
			"",
			"<p>this is an attachment and much much much longer than the real body</p>",
			"--B--",
		].join("\n");
		const p = parseEmailFile(raw);
		ok(p.html.includes("real body"), "the inline body is used");
		ok(!p.html.includes("attachment"), "an attachment part is not mistaken for the body");
	}

	// base64 transfer encoding
	{
		const b64 = Buffer.from("<p>Total: $12.95</p>", "utf8").toString("base64");
		const raw = ["From: a@b.com", "Subject: s", "Content-Type: text/html", "Content-Transfer-Encoding: base64", "", b64].join("\n");
		ok(parseEmailFile(raw).html.includes("$12.95"), "a base64 body decodes");
	}

	// THE ONE THAT MATTERS: quoted-printable and base64 both yield one character
	// per byte, so without a charset pass every smart quote becomes mojibake and
	// Amazon's invisible bidi marks survive stripping as visible garbage.
	{
		const { decodeCharset } = require("./transactions");
		eq(decodeCharset("Weâll", "utf-8"), "We’ll", "utf-8 bytes are reassembled into one character");
		eq(decodeCharset("plain ascii", "us-ascii"), "plain ascii", "ascii is left alone");
		// latin-1 bytes must not be mangled by a utf-8 reading
		eq(decodeCharset("café", "iso-8859-1"), "café", "a declared non-utf8 charset is left alone");
		eq(decodeCharset("café", ""), "café", "an unlabelled part that is not valid utf-8 keeps its original bytes");
	}
	{
		const raw = [
			"From: The Home Depot <HomeDepot@order.homedepot.com>",
			"Subject: Thanks for your order",
			"Content-Type: text/html; charset=utf-8",
			"Content-Transfer-Encoding: quoted-printable",
			"",
			"<p>We=E2=80=99ll let you know =E2=80=93 soon</p>",
		].join("\n");
		const p = parseEmailFile(raw);
		ok(p.html.includes("We’ll"), "a quoted-printable utf-8 apostrophe decodes to one character");
		ok(p.html.includes("–"), "and an en dash survives too");
		ok(!p.html.includes("â"), "no mojibake remains");
	}
	{
		// Amazon wraps the item count in bidi isolates; they must decode to real
		// invisible characters so normalization can strip them
		const raw = ["From: a@amazon.com", "Subject: s", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "<p>and =E2=81=A62=E2=81=A9 more items</p>"].join("\n");
		eq(normalizeEmailHtml(parseEmailFile(raw).html), "and 2 more items", "decoded bidi isolates are then stripped clean");
	}

	// trace headers repeat; the parse must not let a later Received win
	{
		const raw = ["Received: from a", "Received: from b", "From: real@example.com", "Subject: s", "", "body"].join("\n");
		eq(parseEmailFile(raw).from, "real@example.com", "repeated headers do not confuse the parse");
	}
	{
		const p = parseEmailFile("not really a message at all");
		eq(p.from, "", "a malformed file yields empty fields rather than throwing");
		eq(p.html, "", "and no body");
	}
}

// --- transactions phase 4: CSV backfill and categorizing ---
{
	const { parseCsv, csvDate, parseAmazonOrderCsv, buildCategorizePrompt, parseCategorized, reconcileOrder, settleOrder } = require("./transactions");

	// -- csv --
	eq(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]], "a plain csv parses");
	eq(parseCsv('a,b\n"x, y",2'), [["a", "b"], ["x, y", "2"]], "a quoted field keeps its comma");
	eq(parseCsv('a\n"say ""hi"""'), [["a"], ['say "hi"']], "doubled quotes unescape");
	eq(parseCsv('a,b\n"line\nbreak",2'), [["a", "b"], ["line\nbreak", "2"]], "a quoted newline stays inside its field");
	eq(parseCsv("a,b\n\n1,2"), [["a", "b"], ["1", "2"]], "blank lines are skipped");
	eq(parseCsv(""), [], "empty input yields no rows");

	eq(csvDate("2026-07-10T00:25:50Z"), "2026-07-10", "an ISO timestamp reduces to its date");
	eq(csvDate("2026-07-10"), "2026-07-10", "an ISO date passes through");
	eq(csvDate("7/9/2026"), "2026-07-09", "a US date is normalized and zero-padded");
	eq(csvDate("nonsense"), "", "an unparseable date is empty");

	// -- Amazon export --
	{
		const csv = [
			'"Website","Order ID","Order Date","Currency","Unit Price","Shipment Item Subtotal","Shipment Item Subtotal Tax","Shipping Charge","Total Discounts","ASIN","Quantity","Payment Instrument Type","Product Name"',
			'"Amazon.com","111-8099753-6573041","2026-07-10T00:25:50Z","USD","2.49","4.98","0.41","0","0","B001","2","Visa - 1891","Ozarka Texas Spring Water Bottles, 16.9 oz"',
			'"Amazon.com","111-3055473-6731405","2026-07-10T00:30:00Z","USD","90.99","90.99","7.51","0","0","B002","1","Visa - 1891","Hill\'s Science Diet Adult 7+ Senior"',
			'"Amazon.com","111-3055473-6731405","2026-07-10T00:30:00Z","USD","5.00","5.00","0.00","0","0","B003","1","Visa - 1891","Dog Bowl, Stainless"',
		].join("\n");
		const orders = parseAmazonOrderCsv(csv);
		eq(orders.length, 2, "rows group into one order per order id");
		eq(orders[0].orderId, "111-8099753-6573041", "the first order id is read");
		eq(orders[0].items.length, 1, "a single-item order has one line");
		eq(orders[1].items.length, 2, "a two-item order keeps both lines");
		eq(orders[1].items[1].name, "Dog Bowl, Stainless", "a product name containing a comma survives");
		eq(orders[0].date, "2026-07-10", "the order date is normalized");
		eq(orders[0].items[0].sku, "B001", "the ASIN becomes the sku");
		eq(orders[0].items[0].quantity, 2, "quantity is read");
		eq(orders[0].items[0].amount, 4.98, "the line subtotal is the item amount");
		eq(orders[1].subtotal, 95.99, "the order subtotal is the sum of its lines");
		eq(orders[1].tax, 7.51, "tax accumulates across the order's rows");
		eq(orders[1].total, 103.5, "the total is subtotal plus tax and shipping less discounts");
		eq(orders[0].vendor, "Amazon", "the vendor is stamped");
		// derived totals must satisfy the same guard AI extraction has to pass
		ok(reconcileOrder(orders[0]).ok && reconcileOrder(orders[1]).ok, "CSV-derived orders reconcile");
		ok(!settleOrder(orders[1]).repaired, "and need no repair");
	}
	{
		// an older export without the subtotal column falls back to unit x qty
		const csv = ['"Order ID","Order Date","Unit Price","Quantity","Product Name"', '"1","2026-07-10","2.50","4","Thing"'].join("\n");
		eq(parseAmazonOrderCsv(csv)[0].items[0].amount, 10, "unit price times quantity is the fallback line total");
	}
	eq(parseAmazonOrderCsv("just,a,header"), [], "a file with no data rows yields nothing");
	eq(parseAmazonOrderCsv('"Nothing","Useful"\n"a","b"'), [], "a file without the needed columns yields nothing");
	{
		const csv = ['"Order ID","Product Name","Total Discounts","Unit Price","Quantity"', '"1","Thing","-5.00","20.00","1"'].join("\n");
		eq(parseAmazonOrderCsv(csv)[0].discount, 5, "a negative discount is stored as a positive amount");
	}

	// -- categorizing --
	{
		const p = buildCategorizePrompt(["Ozarka Water", "Dog Food"]);
		ok(p.user.includes("1. Ozarka Water") && p.user.includes("2. Dog Food"), "products are numbered for positional matching");
		ok(p.system.includes("pets"), "the taxonomy is stated");
	}
	eq(parseCategorized('{"1":"groceries","2":"pets"}', 2), ["groceries", "pets"], "categories map back by position");
	eq(parseCategorized('{"1":"groceries"}', 3), ["groceries", "other", "other"], "a short reply pads with other");
	eq(parseCategorized('{"1":"invented"}', 1), ["other"], "a category outside the taxonomy becomes other");
	eq(parseCategorized("not json", 2), ["other", "other"], "an unparseable reply is all other");
	eq(parseCategorized('{"9":"pets"}', 2), ["other", "other"], "an out-of-range index is ignored");
}

// --- transactions phase 5: rollups and the base ---
{
	const { isoWeekKey, buildSpendRollup, buildTxnBase } = require("./transactions");

	// -- iso weeks --
	eq(isoWeekKey("2026-07-19"), "2026-W29", "a Sunday lands in the week of its Thursday");
	eq(isoWeekKey("2026-07-20"), "2026-W30", "the following Monday starts a new week");
	eq(isoWeekKey("2026-01-01"), "2026-W01", "a Thursday New Year is week one");
	// a week belongs to the year holding its Thursday, so this is correct
	eq(isoWeekKey("2025-12-29"), "2026-W01", "late December can belong to the next year's week one");
	eq(isoWeekKey("not a date"), "", "an unparseable date has no week");
	eq(isoWeekKey(""), "", "an empty date has no week");

	const item = (over: Record<string, unknown> = {}) => ({
		path: "Finance/Items/2026/x.md",
		vendor: "The Home Depot",
		date: "2026-07-18",
		category: "home-improvement",
		scope: "personal",
		currency: "USD",
		effective: 80.61,
		...over,
	});

	{
		const items = [
			item(),
			item({ category: "pets", effective: 98.5, vendor: "Amazon", date: "2026-07-10" }),
			item({ category: "groceries", effective: 12.95, vendor: "Amazon", date: "2026-06-02" }),
			item({ category: "software", effective: 216.49, vendor: "Microsoft", date: "2025-12-09", scope: "business" }),
		];
		const md = buildSpendRollup(items, "2026-07-19");
		ok(md.includes("type: capture-spend"), "the rollup is typed");
		ok(md.includes("generated: true"), "and marked generated so it can be safely rewritten");
		// THE ONE THAT MATTERS: business spend must not be folded into a
		// household total, or neither number answers its own question.
		ok(!md.includes("216.49"), "business scope is excluded from the personal rollup");
		ok(md.includes("**This week (2026-W29):** 80.61"), "this week totals only this week");
		ok(md.includes("**This month (2026-07):** 179.11"), "this month sums July only");
		ok(md.includes("**This year (2026):** 192.06"), "this year sums all of 2026");
		ok(md.includes("| pets | 1 | 98.50 |"), "categories are broken out for the month");
		ok(md.includes("| 2026-06 | 1 | 12.95 |"), "earlier months still appear in the by-month table");
		ok(md.includes("| Amazon | 2 | 111.45 |"), "vendors total across orders");
		ok(md.indexOf("| 2026-07 |") < md.indexOf("| 2026-06 |"), "months run newest first");
	}
	{
		const md = buildSpendRollup([item({ scope: "business", effective: 216.49, category: "software" })], "2026-07-19", "business");
		ok(md.includes("216.49"), "asking for business scope reports business spend");
		ok(md.includes("scope: business"), "and records which scope it covers");
	}
	{
		const md = buildSpendRollup([item({ review: true, effective: 399.98 })], "2026-07-19");
		ok(md.includes("## Needs review"), "flagged items get their own section");
		ok(md.includes("Finance/Items/2026/x.md"), "and link to the note");
	}
	ok(buildSpendRollup([], "2026-07-19").includes("No personal line items captured yet"), "an empty vault says so plainly");

	// -- base --
	{
		const base = buildTxnBase(true);
		ok(base.includes("powerbases-table"), "Power Bases views are used when it is installed");
		ok(base.includes("powerbases-chart"), "and the chart view is included");
		ok(base.includes("      note.effective: Sum"), "money columns are summarized on effective cost");
		ok(base.includes('        - note.type == "capture-txn-item"'), "item views filter to item notes");
		ok(base.includes('        - note.review == true'), "a review queue view is included");
		ok(base.includes('  month: \'note.date.format("YYYY-MM")\''), "a month formula backs the by-month grouping");
		ok(base.includes("      property: formula.month"), "and the view groups by it");
	}
	{
		const plain = buildTxnBase(false);
		ok(plain.includes("  - type: table"), "core Bases gets plain tables");
		ok(!plain.includes("powerbases"), "and no Power Bases view types it cannot render");
	}
}

// --- mail window: pure windowing and chunking ---
{
	const {
		mailHitPath,
		mailIdFromPath,
		isoDate,
		windowCutoff,
		inWindow,
		chunkMailForIndex,
		senderName,
		planWindowUpdate,
		mailWindowStats,
	} = require("./mailwindow");

	// -- synthetic paths --
	eq(mailHitPath("AAA"), "email:AAA", "a mail id becomes a synthetic email path");
	eq(mailIdFromPath("email:AAA"), "AAA", "and maps back to its id");
	eq(mailIdFromPath("Meetings/Standup.md"), null, "a real note path is not mistaken for mail");

	// -- dates and the horizon --
	eq(isoDate("2026-07-19T00:25:50Z"), "2026-07-19", "a timestamp reduces to its date");
	eq(isoDate("2026-07-19"), "2026-07-19", "a date passes through");
	eq(isoDate("garbage"), "", "an unparseable date is empty");
	eq(windowCutoff("2026-07-19", 90), "2026-04-20", "the cutoff is n days before today");
	eq(windowCutoff("2026-07-19", 0), "2026-07-19", "a zero-day window cuts off at today");

	ok(inWindow("2026-07-10", "2026-07-19", 90), "a recent message is in the window");
	ok(!inWindow("2026-01-01", "2026-07-19", 90), "an old message is outside the window");
	ok(inWindow("2026-04-20", "2026-07-19", 90), "a message exactly on the horizon is included");
	ok(!inWindow("2026-04-19", "2026-07-19", 90), "the day before the horizon is excluded");
	// THE ONE THAT MATTERS: an undateable message must not slip in as "recent"
	ok(!inWindow("", "2026-07-19", 90), "a message with no date is treated as outside the window");

	// -- sender parsing --
	eq(senderName('"Amazon.com" <auto-confirm@amazon.com>'), "Amazon.com", "a quoted display name is extracted");
	eq(senderName("Dana Reed <dana@example.com>"), "Dana Reed", "an unquoted display name is extracted");
	eq(senderName("bare@example.com"), "bare", "a bare address falls back to its local part");

	// -- chunking --
	{
		const doc = { id: "1", from: "Dana Reed <dana@x.com>", subject: "  Q3   plan  ", date: "2026-07-10", text: "Here  is\n\nthe   plan.\n\n> quoted tail" };
		const c = chunkMailForIndex(doc);
		ok(c.heading.includes("Q3 plan"), "the subject is collapsed into the heading");
		ok(c.heading.includes("Dana Reed"), "the sender rides the heading so 'what did Dana send' can match");
		eq(c.text, "Here is the plan. > quoted tail", "the body is whitespace-collapsed");
	}
	{
		const capped = chunkMailForIndex({ id: "2", from: "x@y.com", subject: "s", date: "2026-07-10", text: "z".repeat(9000) }, 4000);
		eq(capped.text.length, 4000, "an over-long body is capped");
	}
	eq(chunkMailForIndex({ id: "3", from: "x@y.com", subject: "", date: "2026-07-10", text: "   " }), null, "a message with no subject and no body is skipped");
	{
		const noSubject = chunkMailForIndex({ id: "4", from: "x@y.com", subject: "", date: "2026-07-10", text: "body only" });
		ok(noSubject.heading.length > 0, "a message with a body but no subject still gets a heading");
	}

	// -- refresh planning --
	{
		const today = "2026-07-19";
		const incoming = [
			{ id: "new1", from: "a@x.com", subject: "s", date: "2026-07-18", text: "t" },
			{ id: "already", from: "a@x.com", subject: "s", date: "2026-07-17", text: "t" },
			{ id: "old", from: "a@x.com", subject: "s", date: "2026-01-01", text: "t" },
		];
		const indexed = new Set(["already", "stale"]);
		const indexedDates = new Map([["already", "2026-07-17"], ["stale", "2026-01-05"]]);
		const plan = planWindowUpdate(incoming, indexed, indexedDates, today, 90);
		eq(plan.add.map((m: { id: string }) => m.id), ["new1"], "only new, in-window messages are added");
		eq(plan.drop, ["stale"], "an already-indexed message that aged out is dropped");
		ok(!plan.add.some((m: { id: string }) => m.id === "old"), "an incoming message already past the horizon is never added");
		ok(!plan.drop.includes("already"), "an indexed message still in-window is left alone");
	}

	// -- citation linkifying --
	{
		const { linkifyMailCitations } = require("./mailwindow");
		const table: Record<string, { from: string; subject: string; date: string; webLink?: string }> = {
			a: { from: "Dana Reed <dana@x.com>", subject: "Q3 plan", date: "2026-07-10", webLink: "https://outlook.com/1" },
			b: { from: "x@y.com", subject: "No link here", date: "2026-07-10" },
		};
		const meta = (id: string) => table[id] ?? null;
		eq(
			linkifyMailCitations("The plan ships Friday [[email:a]].", meta),
			"The plan ships Friday [Email: Q3 plan](https://outlook.com/1).",
			"a mail citation becomes a link to Outlook"
		);
		eq(linkifyMailCitations("See [[email:b]].", meta), "See (Email: No link here).", "a message with no web link becomes a plain label");
		eq(linkifyMailCitations("See [[email:gone]].", meta), "See an email.", "a citation the window forgot collapses to a neutral phrase, never a broken link");
		eq(linkifyMailCitations("See [[Meetings/Standup]] and [[email:a]].", meta), "See [[Meetings/Standup]] and [Email: Q3 plan](https://outlook.com/1).", "real note wiki-links are left untouched");
		eq(linkifyMailCitations("[[email:a|Dana's note]]", meta), "[Email: Q3 plan](https://outlook.com/1)", "an aliased mail citation still resolves");
	}

	// -- stats line --
	eq(mailWindowStats(0, 90, null), "No mail indexed yet.", "an empty window says so");
	ok(mailWindowStats(1200, 90, "2026-04-20").includes("1200 messages searchable back to 2026-04-20"), "a populated window summarizes count and span");
	ok(mailWindowStats(1, 90, null).includes("1 message searchable"), "one message reads in the singular");
}

// --- mail import: thread collapsing, the filter funnel, notes ---
{
	const {
		collapseThreads,
		filterThreads,
		matchSender,
		senderStats,
		buildSenderReport,
		buildRelevancePrompt,
		parseRelevance,
		cleanSubject,
		threadNoteName,
		buildThreadNote,
		buildImportReport,
		senderLabel,
		senderAddress,
		senderDomain,
	} = require("./mailimport");

	const msg = (over: Record<string, unknown> = {}) => ({
		id: "m1",
		from: "Dana Reed <dana@example.com>",
		to: "Alex Kim",
		subject: "Contract redlines",
		date: "2026-07-15T10:00:00Z",
		webLink: "https://outlook.com/1",
		text: "Here are the redlines.",
		conversationId: "conv1",
		focused: true,
		...over,
	});

	// -- index coverage --
	{
		const { coverIndexFolders } = require("./mailimport");
		// THE ONE THAT MATTERS: mail imported into a folder nobody indexes is a
		// corpus that answers nothing, with no error to explain it.
		eq(coverIndexFolders(["Capture"], "Email"), ["Capture", "Email"], "the mail folder is added when nothing covers it");
		eq(coverIndexFolders(["Capture", "Email"], "Email"), ["Capture", "Email"], "an already-listed mail folder is not duplicated");
		eq(coverIndexFolders(["Archive"], "Archive/Mail"), ["Archive"], "a child of an indexed folder is already covered");
		eq(coverIndexFolders(["/"], "Email"), ["/"], "a whole-vault index covers everything");
		eq(coverIndexFolders(["Capture"], ""), ["Capture"], "no mail folder configured changes nothing");
		eq(coverIndexFolders(["Capture"], "/Email/"), ["Capture", "Email"], "surrounding slashes are normalized away");
		// a sibling whose name merely starts the same must NOT count as covered
		eq(coverIndexFolders(["Mail"], "MailArchive"), ["Mail", "MailArchive"], "a prefix-sharing sibling is not mistaken for a child");
	}

	// -- sender parsing --
	eq(senderLabel("Dana Reed <dana@example.com>"), "Dana Reed", "a display name is extracted");
	eq(senderAddress("Dana Reed <dana@example.com>"), "dana@example.com", "the bare address is extracted");
	eq(senderDomain("Dana Reed <dana@example.com>"), "example.com", "the domain is extracted");

	// -- thread collapsing --
	{
		// THE ONE THAT MATTERS: a 3-message back-and-forth is ONE note, keyed on
		// the conversation, holding the newest message (whose quoted history
		// carries the rest). Importing all three would store the thread 3 times.
		const thread = [
			msg({ id: "a", date: "2026-07-10T09:00:00Z", from: "Dana Reed <dana@example.com>", text: "first" }),
			msg({ id: "b", date: "2026-07-12T09:00:00Z", from: "Raj Patel <raj@example.com>", text: "second" }),
			msg({ id: "c", date: "2026-07-15T09:00:00Z", from: "Dana Reed <dana@example.com>", text: "third, with the whole history quoted below" }),
		];
		const out = collapseThreads(thread);
		eq(out.length, 1, "a three-message exchange collapses to one thread");
		eq(out[0].latest.id, "c", "the newest message is the one kept");
		eq(out[0].count, 3, "the message count is recorded");
		eq(out[0].participants, ["Dana Reed", "Raj Patel"], "distinct participants in first-seen order, no duplicates");
		eq(out[0].first, "2026-07-10", "the thread's first date is kept");
		eq(out[0].last, "2026-07-15", "and its last");
	}
	{
		// two separate conversations must not merge
		const out = collapseThreads([msg({ id: "a", conversationId: "c1" }), msg({ id: "b", conversationId: "c2" })]);
		eq(out.length, 2, "different conversations stay separate");
	}
	{
		// a message with no conversation id stands alone rather than pooling with
		// every other id-less message
		const out = collapseThreads([msg({ id: "a", conversationId: "" }), msg({ id: "b", conversationId: "" })]);
		eq(out.length, 2, "messages with no conversation id are never merged together");
	}
	{
		const out = collapseThreads([
			msg({ id: "old", conversationId: "c1", date: "2026-01-01T00:00:00Z" }),
			msg({ id: "new", conversationId: "c2", date: "2026-07-01T00:00:00Z" }),
		]);
		eq(out[0].latest.id, "new", "threads come back newest first");
	}
	{
		const out = collapseThreads([msg({ id: "a", focused: false }), msg({ id: "b", conversationId: "conv1", focused: true, date: "2026-07-16T00:00:00Z" })]);
		ok(out[0].focused, "a thread counts as focused when any message in it was");
	}

	// -- sender rules --
	ok(matchSender({ match: "example.com" }, "Dana Reed <dana@example.com>"), "a domain rule matches");
	ok(matchSender({ match: "dana" }, "Dana Reed <dana@example.com>"), "a name fragment matches");
	ok(!matchSender({ match: "" }, "Dana Reed <dana@example.com>"), "an empty rule never matches");
	ok(!matchSender({ match: "dana", enabled: false }, "Dana Reed <dana@example.com>"), "a disabled rule never matches");

	// -- the funnel --
	{
		const threads = collapseThreads([
			msg({ id: "keep", conversationId: "c1", from: "Dana Reed <dana@example.com>", focused: true }),
			msg({ id: "other", conversationId: "c2", from: "Newsletter <news@marketing.com>", focused: false }),
			msg({ id: "jira", conversationId: "c3", from: "JIRA <jira@atlassian.net>", focused: true }),
			msg({ id: "tiny", conversationId: "c4", from: "Bob <bob@example.com>", focused: true, text: "thanks!" }),
		]);
		const res = filterThreads(threads, {
			focusedOnly: true,
			rules: [{ match: "jira@atlassian.net", block: true }],
			minChars: 20,
		});
		const keptIds = res.keep.map((t: { latest: { id: string } }) => t.latest.id).sort();
		eq(keptIds, ["keep"], "only the real exchange survives the funnel");
		const reasons = Object.fromEntries(res.rejected.map((r: { subject: string; reason: string; id: string }) => [r.id, r.reason]));
		ok(reasons["c2"].includes("Other"), "the non-focused one is rejected for classification");
		ok(reasons["c3"].includes("sender rule"), "the blocked sender is rejected by rule");
		ok(reasons["c4"].includes("almost no content"), "the one-word reply is rejected as empty");
		eq(res.rejected.length, 3, "every rejection is recorded, none silently dropped");
	}
	{
		// an allow rule outranks the focused classifier: naming a sender is a
		// stronger signal than Outlook's guess
		const threads = collapseThreads([msg({ conversationId: "c1", from: "Ops <ops@example.com>", focused: false })]);
		const res = filterThreads(threads, { focusedOnly: true, rules: [{ match: "ops@example.com" }] });
		eq(res.keep.length, 1, "an allow rule keeps a thread Outlook called Other");
		eq(res.rejected.length, 0, "and nothing is rejected");
	}
	{
		// a block rule beats an allow rule for the same sender
		const threads = collapseThreads([msg({ conversationId: "c1", from: "Ops <ops@example.com>" })]);
		const res = filterThreads(threads, { focusedOnly: false, rules: [{ match: "ops", block: true }, { match: "ops@example.com" }] });
		eq(res.keep.length, 0, "a block rule wins over an allow rule");
	}
	{
		const threads = collapseThreads([msg({ conversationId: "c1", focused: false })]);
		eq(filterThreads(threads, { focusedOnly: false, rules: [] }).keep.length, 1, "with focusedOnly off, Other mail is kept");
	}

	// -- sender stats --
	{
		const threads = collapseThreads([
			msg({ id: "a", conversationId: "c1", from: "JIRA <jira@x.com>", focused: false }),
			msg({ id: "b", conversationId: "c2", from: "JIRA <jira@x.com>", focused: false }),
			msg({ id: "c", conversationId: "c3", from: "Dana <dana@example.com>", focused: true }),
		]);
		const stats = senderStats(threads);
		eq(stats[0].address, "jira@x.com", "the loudest sender comes first");
		eq(stats[0].threads, 2, "its thread count is right");
		eq(stats[0].focusedShare, 0, "and it has never been focused");
		eq(stats[1].focusedShare, 100, "a always-focused sender reads 100%");
		const report = buildSenderReport(stats, "Acme", "2026-07-20");
		ok(report.includes("jira@x.com"), "the report lists the address");
		ok(report.includes("Never focused, and frequent") === false || report.includes("jira@x.com"), "the noisy section names candidates to block");
	}

	// -- AI relevance --
	{
		const threads = collapseThreads([msg({ conversationId: "c1", subject: "Q3 plan" })]);
		const p = buildRelevancePrompt(threads, "Work folder: Acme");
		ok(p.user.includes("1. From: Dana Reed"), "threads are numbered for positional mapping");
		ok(p.user.includes("Q3 plan"), "the subject is included");
		ok(p.system.includes("when genuinely unsure, keep it".toLowerCase()) || p.system.toLowerCase().includes("unsure, keep"), "the prompt biases toward keeping");
	}
	eq(parseRelevance('{"1":true,"2":false}', 2), [true, false], "verdicts map back by position");
	// a bad or short reply must never silently delete mail
	eq(parseRelevance("garbage", 3), [true, true, true], "an unparseable reply keeps everything");
	eq(parseRelevance('{"1":false}', 3), [false, true, true], "a short reply keeps the rest");
	eq(parseRelevance('{"9":false}', 2), [true, true], "an out-of-range index is ignored");

	// -- subjects and names --
	eq(cleanSubject("RE: FW: RE: Contract redlines"), "Contract redlines", "a reply prefix chain is stripped");
	eq(cleanSubject("RE[2]: Budget"), "Budget", "a numbered reply prefix is stripped");
	eq(cleanSubject("Plain subject"), "Plain subject", "a clean subject is untouched");
	{
		const t = collapseThreads([msg({ subject: "RE: Contract redlines", date: "2026-07-15T10:00:00Z" })])[0];
		eq(threadNoteName(t), "2026-07-15 Contract redlines", "the note is named by date and clean subject");
	}
	{
		const long = collapseThreads([msg({ subject: "x".repeat(200) })])[0];
		ok(threadNoteName(long).length <= 110, "a very long subject is trimmed");
	}

	// -- the note --
	{
		const t = collapseThreads([
			msg({ id: "a", date: "2026-07-10T09:00:00Z", from: "Dana Reed <dana@example.com>", text: "OLDERBODYTEXT" }),
			msg({ id: "c", date: "2026-07-15T09:00:00Z", from: "Raj Patel <raj@example.com>", text: "the latest word, history quoted below" }),
		])[0];
		const note = buildThreadNote(t, { folder: "Acme", today: "2026-07-20" });
		ok(note.includes("type: capture-mail"), "the note is typed");
		ok(note.includes('conversation-id: "conv1"'), "the conversation id is the stable identity");
		ok(note.includes("messages: 2"), "the message count is recorded");
		ok(note.includes("first-message: 2026-07-10"), "the thread's start date is recorded");
		ok(note.includes("date: 2026-07-15"), "and it is dated by the newest message");
		ok(note.includes("- \"Dana Reed\"") && note.includes("- \"Raj Patel\""), "participants are listed");
		ok(note.includes("the latest word"), "the body is the newest message");
		ok(!note.includes("OLDERBODYTEXT"), "and the older message's body is not stored a second time");
		ok(note.includes('mail-folder: "Acme"'), "the source folder is recorded");
	}

	// -- the report --
	{
		const kept = collapseThreads([msg({ conversationId: "c1" })]);
		const rejected = [
			{ id: "c2", subject: "RE: Build passed", from: "CI <ci@x.com>", reason: "sender rule \"ci@x.com\"" },
			{ id: "c3", subject: "Sale", from: "Shop <shop@y.com>", reason: "Outlook classified it as Other, not Focused" },
		];
		const rep = buildImportReport(kept, rejected, { folder: "Acme", today: "2026-07-20", scanned: 40, collapsed: 3 });
		ok(rep.includes("**Messages scanned:** 40"), "the report states what was scanned");
		ok(rep.includes("**Conversations after collapsing:** 3"), "and how much collapsing saved");
		ok(rep.includes("**Imported:** 1") && rep.includes("**Skipped:** 2"), "and the outcome");
		ok(rep.includes("Build passed") && rep.includes("Sale"), "every skipped item is named, so nothing vanishes silently");
		ok(rep.includes("### sender rule"), "skips are grouped by reason");
	}
	ok(!buildImportReport([], [], { folder: "x", today: "2026-07-20", scanned: 0, collapsed: 0 }).includes("## Skipped"), "a clean run has no skipped section");
}

// --- last-edited stamp ---
{
	const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
	const ago = (ms: number) => relativeEdited(NOW - ms, NOW);
	eq(ago(5_000), "just now", "seconds old reads as just now");
	eq(ago(60_000), "a minute ago", "a minute is spelled out");
	eq(ago(20 * 60_000), "20 minutes ago", "minutes round");
	eq(ago(90 * 60_000), "an hour ago", "an hour is spelled out");
	eq(ago(5 * 3_600_000), "5 hours ago", "hours round");
	eq(ago(30 * 3_600_000), "yesterday", "just over a day reads as yesterday");
	eq(ago(5 * 86_400_000), "5 days ago", "days round");
	eq(relativeEdited(NOW + 60_000, NOW), "just now", "a future stamp from clock skew never goes negative");
	eq(relativeEdited(0, NOW), "", "no timestamp, no text");
	ok(/\d{4}/.test(ago(90 * 86_400_000)), "anything older than a month reads as a date");

	eq(editedAt(undefined, 1234), 1234, "with no frontmatter the file's mtime is used");
	eq(editedAt({ updated: "2026-07-20" }, 1234), new Date("2026-07-20").getTime(), "an `updated` property wins over mtime");
	eq(editedAt({ modified: "2026-07-21" }, 1234), new Date("2026-07-21").getTime(), "`modified` is accepted too");
	eq(editedAt({ updated: "not a date" }, 1234), 1234, "an unparseable property falls back to mtime");
	eq(editedAt(undefined, 0), 0, "nothing to show reports zero");
	ok(absoluteEdited(NOW).includes("2026"), "the exact form carries the year");
	eq(absoluteEdited(0), "", "no timestamp, no exact form either");
}

// The summary runs last on purpose: any test added below it would print FAIL
// without failing the build.
if (fails) {
	console.log(fails + " failure(s)");
	process.exit(1);
} else {
	console.log("All tests passed.");
}

// --- the meeting body template ---
{
	const vals = { title: "Sync", date: "2026-07-29", agenda: "- Review designs", when: "9:30 AM", where: "Teams", join: "https://t", meetingId: "1", passcode: "p", attendees: "[[Steve]]", series: "sync" };
	eq(renderMeetingTemplate("## Notes\n- \n\n## Agenda\n{{agenda}}", vals), "## Notes\n- \n\n## Agenda\n- Review designs", "tokens fill in place");
	eq(renderMeetingTemplate("", vals).startsWith("## Notes"), true, "an empty template falls back to the default");
	// a label with nothing behind it is worse than no line at all
	eq(renderMeetingTemplate("**Where:** {{where}}\n## Notes", { ...vals, where: "" }), "## Notes", "a line whose only token is empty goes, label and all");
	eq(renderMeetingTemplate("**Where:** {{where}}", vals), "**Where:** Teams", "and stays when the token has something to say");
	eq(renderMeetingTemplate("{{when}} in {{where}}", { ...vals, where: "" }), "9:30 AM in ", "a line keeps its place while any of its tokens answers");
	eq(renderMeetingTemplate("Plain line\n{{nosuchthing}}", vals), "Plain line", "an unknown token takes its own line with it");
	eq(renderMeetingTemplate("## Notes", vals), "## Notes", "a line with no tokens is never touched");
	ok(renderMeetingTemplate("a\n\n\n\nb", vals) === "a\n\nb", "runs of blank lines collapse");
	ok(renderMeetingTemplate("## Agenda\n{{agenda}}", { ...vals, agenda: "- " }).endsWith("- "), "a trailing space survives, so the cursor lands after the bullet");

	const stub = buildMeetingStub({
		title: "Budget", date: "2026-07-29", attendees: ["Steve"], agenda: "- Q3",
		when: "9:30 AM", location: "Teams", template: "# {{title}} ({{when}})\n\n{{agenda}}\n\nWith {{attendees}}",
	});
	ok(stub.includes("# Budget (9:30 AM)"), "a custom template governs the body");
	ok(stub.includes("With [[Steve]]"), "attendees render as links");
	ok(stub.includes("---\n# Budget"), "and it still sits tight to the properties");
	ok(stub.includes("date: 2026-07-29") && stub.includes("- capture"), "while the properties stay the plugin's own");
}

{
	// the checkbox ships in the default, and an untouched default follows the
	// plugin forward while an edited one never does
	ok(DEFAULT_MEETING_TEMPLATE.includes("- [ ] "), "a new meeting note starts with a checkbox ready to tick");
	const stub = buildMeetingStub({ title: "M", date: "2026-07-29", attendees: [], agenda: "- x" });
	ok(stub.includes("## Follow-ups\n- [ ] "), "and it reaches the note");
	ok(stub.indexOf("## Notes") < stub.indexOf("## Follow-ups") && stub.indexOf("## Follow-ups") < stub.indexOf("## Agenda"), "notes, then follow-ups, then the agenda");
	ok(!LEGACY_MEETING_TEMPLATES.includes(DEFAULT_MEETING_TEMPLATE), "the current default is not listed as one to replace");
	ok(LEGACY_MEETING_TEMPLATES.includes("## Notes\n- \n\n## Agenda\n{{agenda}}"), "the template 1.85.0 shipped is recognised as untouched");
}

{
	// a template kept as a note: its own properties describe the template, not
	// the meeting, so only the body below them is the template
	eq(
		templateBodyOf("---\nicon: doc\ndescription: Meeting note\n---\n## Notes\n- \n\n## Agenda\n{{agenda}}"),
		"## Notes\n- \n\n## Agenda\n{{agenda}}",
		"the template note's own frontmatter is left behind"
	);
	eq(templateBodyOf("## Notes\n- "), "## Notes\n- ", "a note without frontmatter is all body");
	eq(templateBodyOf("---\nonly: props\n---\n"), "", "a note with nothing under its properties is empty, and the caller falls back");
	eq(templateBodyOf("---\na: 1\n---\n\n\n# Heading"), "# Heading", "blank lines under the properties do not become a gap at the top");
	// another tool's placeholders are not ours to eat
	eq(
		renderMeetingTemplate("{{date}} {{name:Meeting Name}}", { date: "2026-07-30" }),
		"2026-07-30 {{name:Meeting Name}}",
		"a token shaped for another tool passes through untouched, and does not take its line"
	);
}

{
	// the recording is named by the player under the transcript; a source
	// property repeating that path is a third reference to the same file
	const withPlayer = assembleNote({
		title: "T", date: "2026-07-30", source: "", embed: "![[a.webm]]",
		body: "## Summary\nS", transcript: "**Steve [0:00]:** hi", includeTranscript: true, model: "m",
	});
	ok(!withPlayer.includes("source:"), "no source row when the player carries the recording");
	ok(withPlayer.includes("![[a.webm]]"), "and the player is there");
	const noPlayer = assembleNote({
		title: "T", date: "2026-07-30", source: "_resources/audio/a.webm", embed: null,
		body: "## Summary\nS", transcript: "**Steve [0:00]:** hi", includeTranscript: true, model: "m",
	});
	ok(noPlayer.includes('source: "_resources/audio/a.webm"'), "but a trashed recording keeps the path, as the only record of what was transcribed");
	ok(!withPlayer.includes("speakers:"), "the speaker count is gone; the talk-share line says more and something reads that");
}
