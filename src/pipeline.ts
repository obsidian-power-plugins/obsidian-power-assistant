/* Pure pipeline logic: prompt building, note assembly, filename templates, and
 * multipart encoding. Everything here is deterministic and covered by tests.ts;
 * main.ts supplies the Obsidian and network glue. */

export const EXTRACTIONS = [
	{ key: "summary", label: "Summary", hint: "Concise recap of the key points." },
	{ key: "takeaways", label: "Key takeaways", hint: "The main arguments and conclusions, as bullets. Focus on the ideas; leave raw statistics to Facts & figures so the two do not repeat each other." },
	{ key: "facts", label: "Facts & figures", hint: "Concrete facts, statistics, and figures stated in the source, quoted as given. Never calculate, derive, or estimate a number that was not actually said." },
	{ key: "resources", label: "Resources mentioned", hint: "External tools, papers, blog posts, people, products, and links referenced (not in-video visuals), each with a few words on what it is." },
	{ key: "quotes", label: "Notable quotes", hint: "A few memorable or important direct quotes, each in quotation marks." },
	{ key: "actions", label: "Action items", hint: "Who does what by when." },
	{ key: "decisions", label: "Decisions", hint: "Confirmed choices and rationale." },
	{ key: "risks", label: "Risks & blockers", hint: "Issues, dependencies, open risks." },
	{ key: "questions", label: "Questions", hint: "Open questions or follow-ups." },
	{ key: "keywords", label: "Keywords", hint: "One line of comma-separated topics." },
] as const;

export type ExtractionKey = (typeof EXTRACTIONS)[number]["key"];

/** The sections worth asking for about a post that is a sentence or two. The
 *  rest were written for an hour of speech and have nothing to work with: a
 *  short post yields "*None identified.*" under Facts & figures, Resources
 *  mentioned, and Questions, and a Notable quotes section that quotes the whole
 *  post back, all of it above the post itself.
 *
 *  This narrows the user's picks and never widens them: a section switched off
 *  for social captures stays off. */
const POST_SECTIONS: ExtractionKey[] = ["summary", "takeaways", "keywords"];

export function postExtractions(chosen: Record<ExtractionKey, boolean>): Record<ExtractionKey, boolean> {
	const out = {} as Record<ExtractionKey, boolean>;
	for (const e of EXTRACTIONS) out[e.key] = !!chosen[e.key] && POST_SECTIONS.includes(e.key);
	return out;
}

/** "{{basename}}-notes" + "meeting" → "meeting-notes.md", with unsafe filename
 *  characters stripped and a default .md extension. */
export function renderFilename(template: string, basename: string, date: string): string {
	let name = (template || "{{basename}}-notes")
		.replace(/\{\{basename\}\}/g, basename)
		.replace(/\{\{date\}\}/g, date);
	name = name.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim();
	if (!/\.md$/i.test(name)) name += ".md";
	return name;
}

/* ---------------- meeting notes (create before, record into) ---------------- */

/** Filename for a new meeting note from a pattern with {{title}} and {{date}}. */
/** `site` lets a capture from a link file itself by source ("{{date}} {{site}}
 *  {{title}}") without needing a settings tab per site. It is empty for
 *  everything else, where the token simply collapses. */
export function renderMeetingFilename(pattern: string, title: string, date: string, site = ""): string {
	let name = (pattern || "{{date}} {{title}}")
		.replace(/\{\{title\}\}/g, title || "Meeting")
		.replace(/\{\{date\}\}/g, date)
		.replace(/\{\{site\}\}/g, site);
	name = name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
	if (!/\.md$/i.test(name)) name += ".md";
	return name;
}

/** Whether a note's filename already tells the reader the title, which is what
 *  Obsidian's inline title shows above the note. A "# Title" line then says the
 *  same words a second line down, so a capture leaves it out.
 *
 *  The comparison runs over the sanitized title, because that is what the
 *  filename renderers put in the name: a title with a colon or a slash in it
 *  reaches the file as dashes and would otherwise never look contained. A
 *  filename template that drops the title (\"{{basename}}-notes\") does not
 *  match, and that note keeps its heading. */
export function titleShownByFilename(title: string, filename: string): boolean {
	const clean = (s: string) =>
		s
			.replace(/\.md$/i, "")
			.replace(/[\\/:*?"<>|#^[\]]/g, "-")
			.replace(/\s+/g, " ")
			.trim()
			.toLowerCase();
	const t = clean(title);
	return !!t && clean(filename).includes(t);
}

/** The initial meeting note: capture frontmatter plus the user's agenda, ready
 *  to record into. It is `type: capture` from the start, so it is a first-class
 *  meeting for search, digests, and series linking even before any recording. */
/** A person's attendee wiki-link. With a folder, the link is qualified and
 *  aliased ("[[People/Jane Doe|Jane Doe]]"): only the name shows, and clicking
 *  a not-yet-created person lands the page in that folder instead of the
 *  vault's default new-note location. */
export function personLink(name: string, folder?: string | null): string {
	const f = (folder ?? "").trim().replace(/^\/+|\/+$/g, "");
	return f ? `[[${f}/${name}|${name}]]` : `[[${name}]]`;
}

/** The display name of a person value: unwraps quotes and [[wiki-links]],
 *  preferring the link's alias, else the basename of its target. Accepts both
 *  the old bare "[[Jane Doe]]" and the folder-qualified form. */
export function personName(v: unknown): string {
	const s = String(v ?? "").trim().replace(/^["']|["']$/g, "").trim();
	const m = s.match(/^\[\[([^\]]+)\]\]$/);
	if (!m) return s;
	const inner = m[1];
	const pipe = inner.indexOf("|");
	return (pipe >= 0 ? inner.slice(pipe + 1) : inner.slice(inner.lastIndexOf("/") + 1)).trim();
}

/** The body a new meeting note starts with, before anyone edits the setting.
 *  Notes first, because that is what a person does during a meeting, with a
 *  bullet already there to type into; the agenda under it for reference. */
export const DEFAULT_MEETING_TEMPLATE = "## Notes\n- \n\n## Follow-ups\n- [ ] \n\n## Agenda\n{{agenda}}";

/** Defaults this plugin has shipped before. A stored template that still
 *  matches one of them was never edited, so it can follow the default forward;
 *  anything else is someone's own and is left exactly alone. */
export const LEGACY_MEETING_TEMPLATES = ["## Notes\n- \n\n## Agenda\n{{agenda}}"];

/** Every {{token}} a meeting template understands, with a word on each for the
 *  settings help. Kept beside the renderer so the two cannot drift. */
export const MEETING_TOKENS: { token: string; what: string }[] = [
	{ token: "title", what: "the meeting's name" },
	{ token: "date", what: "its date, as 2026-07-29" },
	{ token: "agenda", what: "the agenda, from the invite when there is one" },
	{ token: "when", what: "the time, e.g. 9:30 AM-10:30 AM" },
	{ token: "where", what: "the location" },
	{ token: "join", what: "the meeting URL" },
	{ token: "meetingId", what: "the meeting ID" },
	{ token: "passcode", what: "the passcode" },
	{ token: "attendees", what: "the invited people, as links" },
	{ token: "series", what: "the recurring-meeting key" },
];

/** A template note's body: its own frontmatter stripped, nothing else touched.
 *
 *  A template kept as a note in the vault usually carries properties of its own
 *  (an icon, a description, whatever put it in a template folder) and those
 *  describe the template, not the meeting. The plugin writes the meeting's own
 *  properties, so only the body below them is the template. */
export function templateBodyOf(md: string): string {
	// trailing newlines go, a trailing space stays: a template ending "- " means
	// the cursor lands after the bullet, and trimming it takes that away
	return md
		.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "")
		.replace(/\r\n/g, "\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
}

/** Fill a meeting template.
 *
 *  A line that carries tokens and gets nothing back is dropped, label and all:
 *  a template with "**Where:** {{where}}" in it should leave no orphan "Where:"
 *  on a meeting that had no location. A line whose tokens all resolved is kept
 *  whole, and a line with no tokens is never touched. An unknown token resolves
 *  to nothing, which by the same rule takes its line with it. */
export function renderMeetingTemplate(template: string, values: Record<string, string>): string {
	const lines = (template.trim() ? template : DEFAULT_MEETING_TEMPLATE).replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	for (const line of lines) {
		const tokens = [...line.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
		if (tokens.length && tokens.every((t) => !(values[t] ?? "").trim())) continue;
		out.push(line.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? ""));
	}
	// trailing NEWLINES go; a trailing space does not. "- " ends the default
	// template, and trimming it leaves the cursor before the space rather than
	// after it, which is a small thing you feel on every meeting.
	return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}

export function buildMeetingStub(opts: {
	title: string;
	date: string;
	attendees: string[];
	agenda: string;
	/** The user's body template; the default when empty. Frontmatter is not
	 *  templated: those properties are structured, Obsidian edits them in place,
	 *  and one malformed line would break every note's YAML. */
	template?: string;
	series?: string | null;
	/** Attendee links are qualified into this folder when set. */
	peopleFolder?: string | null;
	/** Invite context, when created from an Outlook/Teams invite. */
	location?: string;
	when?: string;
	teamsUrl?: string;
	meetingId?: string;
	passcode?: string;
}): string {
	const attendees = [...new Set(opts.attendees.map((a) => a.trim()).filter(Boolean))];
	// collapse any newlines: location goes into a quoted YAML scalar, and a raw
	// newline there would break the note's frontmatter
	const loc = opts.location?.replace(/\s+/g, " ").trim();
	const wh = opts.when?.replace(/\s+/g, " ").trim();
	const fm = [
		"---",
		`date: ${opts.date}`,
		...(wh ? [`time: "${wh}"`] : []),
		...(attendees.length ? ["attendees:", ...attendees.map((a) => `  - "${personLink(a, opts.peopleFolder)}"`)] : []),
		...(loc ? [`location: "${loc.replace(/"/g, "'")}"`] : []),
		// the join details are the one part of the old invite block that was not
		// already said above it, so they live here now: the URL bare, which
		// Obsidian links in a property, and the id and passcode beside it for
		// anyone dialling in
		...(opts.teamsUrl?.trim() ? [`join: ${opts.teamsUrl.trim()}`] : []),
		...(opts.meetingId?.trim() ? [`meeting id: "${opts.meetingId.trim()}"`] : []),
		...(opts.passcode?.trim() ? [`passcode: "${opts.passcode.trim().replace(/"/g, "'")}"`] : []),
		...(opts.series ? [`series: ${opts.series}`] : []),
		"tags:",
		"  - capture",
		"---",
	].join("\n");
	// The title and the when/where lines used to open the note. They said what
	// the filename and the properties above them already said, so the note began
	// by repeating itself and the first thing worth reading sat a screen down.
	// The join details were the exception (nothing else carried them) so they
	// moved up into properties rather than going with the rest.
	//
	// What fills the body is the user's own template now; the default opens on
	// somewhere to write.
	const body = renderMeetingTemplate(opts.template ?? "", {
		title: opts.title.trim(),
		date: opts.date,
		// an empty agenda still gets a bullet, so its heading is not left bare
		agenda: opts.agenda.trim() || "- ",
		when: wh ?? "",
		where: loc ?? "",
		join: opts.teamsUrl?.trim() ?? "",
		meetingId: opts.meetingId?.trim() ?? "",
		passcode: opts.passcode?.trim() ?? "",
		attendees: attendees.map((a) => personLink(a, opts.peopleFolder)).join(", "),
		series: opts.series ?? "",
	});
	// tight to the properties: the first heading stands where the title used to
	return `${fm}
${body}
`;
}

/** Split a note into its raw frontmatter body (between the --- fences) and the
 *  remainder (title + body). CRLF-tolerant; no fences means an empty body. */
function splitFrontmatter(md: string): { fm: string; rest: string } {
	const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
	return m ? { fm: m[1], rest: md.slice(m[0].length) } : { fm: "", rest: md };
}

/** The note body after its first "# " title line (frontmatter already stripped). */
function afterTitleLine(rest: string): string {
	const t = rest.match(/^#[ \t]+.*$/m);
	if (!t) return rest.trim();
	return rest.slice(rest.indexOf(t[0]) + t[0].length).trim();
}

/** Parse a frontmatter body into ordered key blocks (a "key:" line plus any
 *  indented / list-item continuation lines). Good enough for this plugin's
 *  scalar-and-list frontmatter; values are kept verbatim, so unknown keys and
 *  exotic values survive untouched. Not a general YAML parser. */
function fmBlocks(body: string): { key: string; text: string }[] {
	const out: { key: string; text: string }[] = [];
	let cur: { key: string; text: string } | null = null;
	for (const line of body.split(/\r?\n/)) {
		const km = line.match(/^([A-Za-z0-9_][^:]*):/);
		if (km) {
			cur = { key: km[1].trim(), text: line };
			out.push(cur);
		} else if (cur && (/^[ \t]/.test(line) || /^-[ \t]/.test(line))) {
			cur.text += "\n" + line;
		}
	}
	return out;
}

/** Merge two frontmatter bodies: keep the meeting's keys and order, let the
 *  capture override shared keys (date, attendees, series, ...), and append the
 *  capture's recording-only keys (source, speakers, model, cost, ...). Keys the
 *  user added to the meeting note (project, client, aliases) are preserved. */
function mergeFrontmatter(meetingBody: string, captureBody: string): string {
	const cap = fmBlocks(captureBody);
	const capByKey = new Map(cap.map((b) => [b.key, b]));
	const used = new Set<string>();
	const rows: string[] = [];
	for (const b of fmBlocks(meetingBody)) {
		rows.push((capByKey.get(b.key) ?? b).text);
		used.add(b.key);
	}
	for (const b of cap) if (!used.has(b.key)) rows.push(b.text);
	return rows.join("\n");
}

/** Fold a freshly assembled capture note into an existing meeting note: merge
 *  their frontmatter (recording keys added, the user's own keys preserved),
 *  keep the meeting title, place the user's agenda first, then the recording's
 *  speakers line, sections, transcript, and embed below it. The capture is
 *  assembled with the meeting's own title, date, and unioned attendees. */
export function mergeMeetingCapture(meetingMd: string, captureMd: string): string {
	const meeting = splitFrontmatter(meetingMd);
	const capture = splitFrontmatter(captureMd);
	const fm = mergeFrontmatter(meeting.fm, capture.fm);
	const agenda = afterTitleLine(meeting.rest);
	const t = capture.rest.match(/^#[ \t]+.*$/m);
	// the meeting note's own heading wins, and a capture that wrote none (its
	// filename already carried the title) must not cost the note the one it has
	const title = meeting.rest.match(/^#[ \t]+.*$/m)?.[0] ?? t?.[0] ?? "";
	const capBody = t ? capture.rest.slice(capture.rest.indexOf(t[0]) + t[0].length).trim() : capture.rest.trim();
	// keep the title tight to the properties block (no blank line between them),
	// matching a freshly created meeting stub
	const head = fm.trim() ? `---\n${fm}\n---${title ? `\n${title}` : ""}` : title;
	const merged = [head, agenda, capBody].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
	// neither side had a title line, so the first heading takes its place and
	// its spacing: no gap between the properties panel and the note
	return title ? merged : merged.replace(/^(---\n[\s\S]*?\n---)\n\n/, "$1\n");
}

/** Read a meeting note's title, date, and attendees back out of its markdown,
 *  so a recording folded into it inherits the note's own values rather than the
 *  recording's. Tolerant of CRLF, quotes, and [[wiki-link]] wrappers. */
export function parseMeetingMeta(md: string): { title: string; date: string; attendees: string[] } {
	const { fm, rest } = splitFrontmatter(md);
	const date = (fm.match(/^date:[ \t]*(.+)$/m)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
	const attendees: string[] = [];
	const block = fm.match(/^attendees:[ \t]*\r?\n((?:[ \t]*-[ \t]*.+\r?\n?)+)/m);
	if (block) {
		for (const line of block[1].split(/\r?\n/)) {
			const v = personName(line.replace(/^[ \t]*-[ \t]*/, ""));
			if (v) attendees.push(v);
		}
	}
	const title = (rest.match(/^#[ \t]+(.+)$/m)?.[1] ?? "").trim().replace(/\r$/, "");
	return { title, date, attendees };
}

/** Whether a note's frontmatter marks it as a meeting capture. Newer notes drop
 *  the redundant `type: capture` and rely on the `capture` tag; older notes still
 *  have `type: capture`. Derived docs keep an explicit `type` (capture-person,
 *  capture-digest), so their own `capture` tag never makes them count as a
 *  meeting: an explicit type must equal "capture", otherwise the tag decides. */
export function isCaptureNote<T extends { type?: unknown; tags?: unknown }>(fm: T | null | undefined): fm is T {
	if (!fm) return false;
	const type = typeof fm.type === "string" ? fm.type.trim() : "";
	if (type) return type === "capture";
	const isCap = (t: unknown) => String(t).trim().toLowerCase() === "capture";
	return Array.isArray(fm.tags) ? fm.tags.some(isCap) : typeof fm.tags === "string" ? fm.tags.split(/[,\s]+/).some(isCap) : false;
}

/** Power Connect parks the losing side of a sync conflict beside the original,
 *  as "Name (sync conflict 2026-07-29 1245 ac6be5).md". Those copies are
 *  duplicates of a document that already exists, so nothing derived may read
 *  them: counted as a meeting they inflate a person's history, and treated as a
 *  person page they turn the conflict filename into an attendee and overwrite
 *  the preserved content with an empty hub. The date and hex tag are required,
 *  so a note actually named "Sync conflict notes.md" is not caught.
 *
 *  Deliberately narrower than `isSyncConflictName`, and both are kept. That one
 *  guards the recording sweep, where the cost of missing a copy is transcribing
 *  a meeting twice, so it matches every client's shape loosely. This one guards
 *  generated pages, where the cost of a FALSE match is overwriting a page a
 *  person named themselves ("Alex (conflict resolution).md") with an empty hub.
 *  Neither threshold is right for the other's job; do not collapse them. */
export function isConflictCopy(pathOrName: string): boolean {
	return /\(sync conflict \d{4}-\d{2}-\d{2} \d{4} [0-9a-f]{6}\)/i.test(pathOrName);
}

/* ---------------- invite import (paste .ics or Outlook text) ---------------- */

/** Everything the New meeting dialog can prefill from a calendar invite. Empty
 *  strings / empty array mean "not found" so the dialog leaves that field alone. */
export interface ParsedInvite {
	title: string;
	date: string; // YYYY-MM-DD
	when: string; // display time, e.g. "10:00 AM-11:00 AM"
	attendees: string[];
	location: string;
	agenda: string;
	teamsUrl: string;
	meetingId: string;
	passcode: string;
}

const EMPTY_INVITE: ParsedInvite = { title: "", date: "", when: "", attendees: [], location: "", agenda: "", teamsUrl: "", meetingId: "", passcode: "" };
const INVITE_MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Tidy a recipient/attendee into a person name: drop <email>, unwrap quotes,
 *  flip "Last, First" to "First Last", prettify a bare email's local part. */
function cleanInviteName(raw: string): string {
	let s = raw.trim().replace(/<[^>]*>/g, "").replace(/\(([^)]*)\)/g, "").trim();
	s = s.replace(/^["']|["']$/g, "").trim();
	if (!s) return "";
	if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) {
		s = s.split("@")[0].replace(/[._]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	} else if (/^[^,]+,\s*[^,]+$/.test(s)) {
		const [last, first] = s.split(",").map((x) => x.trim());
		if (last && first) s = `${first} ${last}`;
	}
	return s.trim();
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM-DD only when the parts are a real calendar date, else "". */
function isoIfValid(y: string, mo: number, d: number): string {
	return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${pad2(mo)}-${pad2(d)}` : "";
}

/** A date out of invite text -> YYYY-MM-DD, or "" when nothing valid is found.
 *  Handles ISO, spelled month-day-year AND day-month-year (abbreviated too), and
 *  numeric M/D/YYYY (falling back to D/M when the first field cannot be a month).
 *  Every branch is range-checked, so a malformed date never reaches a note. */
function parseInviteDate(s: string): string {
	const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
	if (iso) {
		const v = isoIfValid(iso[1], +iso[2], +iso[3]);
		if (v) return v;
	}
	const mo3 = INVITE_MONTH_NAMES.map((m) => m.slice(0, 3)).join("|");
	const idx = (abbr: string) => INVITE_MONTH_NAMES.findIndex((m) => m.startsWith(abbr.toLowerCase())) + 1;
	const mdy = s.match(new RegExp(`\\b(${mo3})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, "i"));
	if (mdy) {
		const v = isoIfValid(mdy[3], idx(mdy[1]), +mdy[2]);
		if (v) return v;
	}
	const dmy = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${mo3})[a-z]*\\.?,?\\s+(\\d{4})`, "i"));
	if (dmy) {
		const v = isoIfValid(dmy[3], idx(dmy[2]), +dmy[1]);
		if (v) return v;
	}
	const num = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/);
	if (num) {
		let mo = +num[1];
		let d = +num[2];
		if (mo > 12 && d <= 12) [mo, d] = [d, mo]; // a day-first (D/M/YYYY) input
		return isoIfValid(num[3], mo, d);
	}
	return "";
}

/** 24h "1430" or "14:30" -> "2:30 PM". */
function to12h(h: number, mi: number): string {
	const ap = h < 12 ? "AM" : "PM";
	const hr = h % 12 === 0 ? 12 : h % 12;
	return `${hr}:${String(mi).padStart(2, "0")} ${ap}`;
}

/** Pull the Teams join URL, meeting ID, and passcode out of any invite text. */
function extractTeams(text: string): { teamsUrl: string; meetingId: string; passcode: string } {
	const url =
		text.match(/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s>"'\]]+/i)?.[0] ??
		text.match(/https:\/\/teams\.microsoft\.com\/meet\/[^\s>"'\]]+/i)?.[0] ??
		"";
	const meetingId = (text.match(/Meeting ID:\s*([\d][\d ]{7,})/i)?.[1] ?? "").trim();
	const passcode = (text.match(/Passc(?:ode| ode):\s*([^\s]+)/i)?.[1] ?? "").trim();
	return { teamsUrl: url.replace(/[).,]+$/, ""), meetingId, passcode };
}

/** Cut the agenda off at the Microsoft Teams boilerplate or a divider rule. */
function agendaBeforeTeams(body: string): string {
	const cut = body.search(/(?:_{5,}|-{5,}|\bMicrosoft Teams meeting\b|_+Microsoft Teams|\bJoin on your computer\b)/i);
	const head = cut >= 0 ? body.slice(0, cut) : body;
	return head.replace(/\n{3,}/g, "\n\n").trim();
}

/** Tidy an invite agenda into clean Markdown: Outlook bullet glyphs (a filled
 *  dot, a hollow "o", a small square) become nested "- " list items, a bullet
 *  stranded alone on its line rejoins the text beneath it, and blank lines are
 *  dropped so the list is tight. A non-bullet lead-in line is kept verbatim. */
export function tidyAgenda(text: string): string {
	if (!text.trim()) return "";
	const raw = text.replace(/\r\n?/g, "\n").split("\n");
	// a lone bullet marker owns the next non-empty line's text
	const merged: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const alone = raw[i].match(/^[ \t]*([•◦▪·o*+–-])[ \t]*$/i);
		if (alone && raw[i + 1]?.trim()) merged.push(`${alone[1]} ${raw[++i].trim()}`);
		else merged.push(raw[i]);
	}
	const out: string[] = [];
	for (const line of merged) {
		if (!line.trim()) continue; // drop blank lines between items
		const m = line.match(/^[ \t]*([•◦▪·]|o|[*+–-])[ \t]+(.+)$/i);
		if (!m) {
			out.push(line.trim());
			continue;
		}
		const mk = m[1].toLowerCase();
		const depth = "•*+-–".includes(mk) ? 0 : "o◦·".includes(mk) ? 1 : 2;
		out.push(`${"  ".repeat(depth)}- ${m[2].trim()}`);
	}
	return out.join("\n").trim();
}

function unfoldIcs(text: string): string {
	return text.replace(/\r?\n[ \t]/g, "");
}
function icsUnescape(v: string): string {
	return v
		.replace(/\\[nN]/g, "\n")
		.replace(/\\t/gi, " ")
		.replace(/\\,/g, ",")
		.replace(/\\;/g, ";")
		.replace(/\\\\/g, "\\")
		.trim();
}
/** CN from an ICS ORGANIZER/ATTENDEE param string, else the mailto local part. */
function icsPersonName(line: string): string {
	const cn = line.match(/CN=("([^"]*)"|([^;:]*))/i);
	const name = cn ? (cn[2] ?? cn[3] ?? "").trim() : "";
	if (name) return cleanInviteName(name);
	const mail = line.match(/mailto:([^\s;>]+)/i)?.[1];
	return mail ? cleanInviteName(mail) : "";
}

/** An ICS date-time value -> { date, hh, mm }. A trailing Z means UTC (Google
 *  and Zoom exports use it), so convert to the viewer's local date and time;
 *  a floating or TZID value (Outlook's own export) is taken as wall-clock. */
function icsDateTime(val: string): { date: string; hh: number; mm: number } | null {
	const m = val.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?/);
	if (!m) return null;
	if (m[6] && m[4] !== undefined) {
		const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
		return { date: `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`, hh: dt.getHours(), mm: dt.getMinutes() };
	}
	return { date: `${m[1]}-${m[2]}-${m[3]}`, hh: m[4] !== undefined ? +m[4] : -1, mm: m[5] !== undefined ? +m[5] : 0 };
}

function parseIcsInvite(text: string): ParsedInvite {
	const unfolded = unfoldIcs(text);
	const block = unfolded.match(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/i)?.[1] ?? unfolded;
	const prop = (name: string): string => block.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, "im"))?.[1]?.trim() ?? "";
	const title = icsUnescape(prop("SUMMARY"));
	const location = icsUnescape(prop("LOCATION"));
	const description = icsUnescape(prop("DESCRIPTION"));
	const start = icsDateTime(prop("DTSTART"));
	const end = icsDateTime(prop("DTEND"));
	const date = start?.date ?? "";
	const when = start && start.hh >= 0 ? to12h(start.hh, start.mm) + (end && end.hh >= 0 ? `-${to12h(end.hh, end.mm)}` : "") : "";
	const people = new Map<string, true>();
	const org = block.match(/^ORGANIZER(?:;[^:\r\n]*)?:.*$/im)?.[0];
	if (org) {
		const n = icsPersonName(org);
		if (n) people.set(n, true);
	}
	for (const m of block.matchAll(/^ATTENDEE(?:;[^:\r\n]*)?:.*$/gim)) {
		if (/CUTYPE=(?:RESOURCE|ROOM)/i.test(m[0])) continue; // a room or equipment, not a person
		const n = icsPersonName(m[0]);
		if (n) people.set(n, true);
	}
	// scan the whole event: the join URL, meeting ID, and passcode may sit in the
	// description, an X-property, or their own lines, not always together
	const teams = extractTeams(description + "\n" + block);
	return { title, date, when, attendees: [...people.keys()], location, agenda: tidyAgenda(agendaBeforeTeams(description)), ...teams };
}

const INVITE_LABELS: Record<string, RegExp> = {
	title: /^(?:subject|title)\s*:\s*(.+)$/im,
	when: /^(?:when|time)\s*:\s*(.+)$/im,
	location: /^(?:where|location)\s*:\s*(.+)$/im,
};
const HEADER_LINE = /^(?:subject|title|when|time|where|location|organizer|from|sent|to|cc|bcc|required attendees|optional attendees|attendees|response|importance|meeting status|accepted on|this appointment)\s*:/i;

function parseOutlookInvite(text: string): ParsedInvite {
	const body = text.replace(/\r\n/g, "\n");
	const title = body.match(INVITE_LABELS.title)?.[1]?.trim() ?? "";
	const whenLine = body.match(INVITE_LABELS.when)?.[1]?.trim() ?? "";
	const location = body.match(INVITE_LABELS.location)?.[1]?.trim() ?? "";
	const date = parseInviteDate(whenLine || body);
	const timeRange = /\d{1,2}:\d{2}\s*[AP]M\s*(?:[---]|to)\s*\d{1,2}:\d{2}\s*[AP]M/i;
	const when = (whenLine.match(timeRange)?.[0] ?? body.match(timeRange)?.[0] ?? "").replace(/\s+/g, " ").trim();
	const attendees: string[] = [];
	const seen = new Set<string>();
	for (const m of body.matchAll(/^(?:to|required attendees|optional attendees|attendees)\s*:\s*(.+)$/gim)) {
		for (const part of m[1].split(";")) {
			const n = cleanInviteName(part);
			if (n && !seen.has(n.toLowerCase())) {
				seen.add(n.toLowerCase());
				attendees.push(n);
			}
		}
	}
	const org = body.match(/^(?:organizer|from)\s*:\s*(.+)$/im)?.[1];
	if (org) {
		const n = cleanInviteName(org.split(";")[0]);
		if (n && !seen.has(n.toLowerCase())) attendees.unshift(n);
	}
	// agenda: body minus header/metadata lines, cut at the Teams boilerplate
	const agendaSrc = body
		.split("\n")
		.filter((l) => !HEADER_LINE.test(l))
		.join("\n");
	return { title, date, when, attendees, location, agenda: tidyAgenda(agendaBeforeTeams(agendaSrc)), ...extractTeams(body) };
}

/** Parse a pasted calendar invite into fields the New meeting dialog prefills.
 *  Auto-detects an .ics payload versus Outlook forwarded/body text; every field
 *  is best-effort, so a bare agenda paste still fills what it can. */
export function parseMeetingInvite(text: string): ParsedInvite {
	if (!text || !text.trim()) return { ...EMPTY_INVITE };
	if (/BEGIN:VEVENT|BEGIN:VCALENDAR/i.test(text)) return parseIcsInvite(text);
	return parseOutlookInvite(text);
}

/** A Microsoft Graph calendar event, only the fields we read. */
export interface GraphEvent {
	subject?: string;
	start?: { dateTime?: string };
	end?: { dateTime?: string };
	location?: { displayName?: string };
	organizer?: { emailAddress?: { name?: string; address?: string } };
	attendees?: { type?: string; emailAddress?: { name?: string; address?: string } }[];
	onlineMeeting?: { joinUrl?: string } | null;
	bodyPreview?: string;
	body?: { contentType?: string; content?: string };
}

/** Reduce an HTML event body to readable text so the agenda extractor can run. */
function htmlToText(html: string): string {
	const stripped = html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<head[\s\S]*?<\/head>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ");
	return decodeXmlEntities(stripped)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Map a Graph calendar event to the same shape a pasted invite parses to, so
 *  the calendar picker and the paste box share one note-building path. Times are
 *  taken as-is from the event (fetch requests the user's own timezone). */
export function eventToInvite(ev: GraphEvent): ParsedInvite {
	const startDt = ev.start?.dateTime ?? "";
	const date = /^\d{4}-\d{2}-\d{2}/.test(startDt) ? startDt.slice(0, 10) : "";
	const st = startDt.match(/T(\d{2}):(\d{2})/);
	const en = (ev.end?.dateTime ?? "").match(/T(\d{2}):(\d{2})/);
	const when = st ? to12h(+st[1], +st[2]) + (en ? `-${to12h(+en[1], +en[2])}` : "") : "";
	const people = new Map<string, true>();
	const org = ev.organizer?.emailAddress;
	const on = cleanInviteName(org?.name || org?.address || "");
	if (on) people.set(on, true);
	for (const a of ev.attendees ?? []) {
		// a room or equipment attendee is a place, not a person (the .ics parser
		// already skips CUTYPE=RESOURCE; this is the Graph equivalent)
		if ((a.type ?? "").toLowerCase() === "resource") continue;
		const nm = cleanInviteName(a.emailAddress?.name || a.emailAddress?.address || "");
		if (nm) people.set(nm, true);
	}
	const bodyText = ev.body?.contentType?.toLowerCase() === "html" ? htmlToText(ev.body.content ?? "") : ev.bodyPreview || ev.body?.content || "";
	const teams = extractTeams((ev.onlineMeeting?.joinUrl ?? "") + "\n" + bodyText);
	return {
		title: (ev.subject ?? "").trim(),
		date,
		when,
		attendees: [...people.keys()],
		location: (ev.location?.displayName ?? "").trim(),
		agenda: tidyAgenda(agendaBeforeTeams(bodyText)),
		teamsUrl: teams.teamsUrl || (ev.onlineMeeting?.joinUrl ?? ""),
		meetingId: teams.meetingId,
		passcode: teams.passcode,
	};
}

/** Extraction options beyond the section pick: task-format action items (in
 *  Power Editor's Tasks grammar) and prior-meeting context for series. */
export interface ExtractionOpts {
	/** Emit action items as '- [ ] Task [[Owner]] 📅 YYYY-MM-DD' checklist
	 *  lines instead of a table, so they land in todo dashboards. */
	actionsAsTasks?: boolean;
	/** Meeting date, for resolving "by next Friday" into a real 📅 date. */
	meetingDate?: string;
	/** Decisions and open items from the previous meeting in this series. */
	priorContext?: string | null;
	/** Ask for a trailing [m:ss] on each item, pointing at where in the recording
	 *  it came from. Turns every bullet into a jump back to the moment, and is
	 *  what lets a screen be placed beside the point it illustrates. */
	stampSections?: boolean;
}

/** The extraction request sent to the model: only the sections the user picked,
 *  in a fixed order, with hard rules against invention. */
export function buildExtractionPrompt(
	selected: ExtractionKey[],
	transcript: string,
	opts: ExtractionOpts = {}
): { system: string; user: string } {
	const sections = EXTRACTIONS.filter((e) => selected.includes(e.key));
	// the action-item formatting rule is only relevant when that section is asked
	// for; a video's notes should not carry meeting-task instructions
	const actionRule = !selected.includes("actions")
		? ""
		: opts.actionsAsTasks
			? "Action items are a Markdown checklist, one item per line, exactly: '- [ ] Task description [[Owner]] 📅 YYYY-MM-DD'. " +
				"Include the [[Owner]] wiki-link ONLY when the transcript names who owns the task, and the 📅 due token ONLY when a deadline is actually stated" +
				(opts.meetingDate ? ` (resolve relative phrases like 'next Friday' against the meeting date ${opts.meetingDate})` : "") +
				". Bare '- [ ] Task description' is correct when owner and date are unknown, never invent either. "
			: "Action items are a Markdown table with columns | Task | Owner | Due |; use TBD for an unknown owner or date on a real task. ";
	// Stamps go on the narrative sections only. Action items are a strict grammar
	// in both their forms (a Tasks checklist line, or table columns), and a stamp
	// appended to either would either land inside a table cell or trail a due
	// date in every todo dashboard. Keywords is one comma-separated line.
	//
	// The model must also be told to OMIT rather than guess: an invented stamp
	// sends the reader, and the screen placed beside the item, to the wrong
	// minute, which is worse than carrying no stamp at all.
	const stampRule = !opts.stampSections
		? ""
		: "End each bullet or paragraph with the timestamp in the transcript it came from, in square brackets, exactly like [12:34] (or [1:12:34] past an hour). " +
			"Use the stamp of the turn the item is drawn from; for an item spanning several turns, use the first. " +
			"Omit the stamp entirely when the transcript carries no timestamps, or when you cannot tell which turn an item came from: NEVER estimate or invent one. " +
			"Action items and Keywords take no stamps, whatever their format. ";
	const system =
		"You turn raw transcripts of meetings, talks, videos, and voice memos into clean Markdown notes. " +
		"Produce ONLY the requested sections, in the order given, each as a '## Heading'. " +
		actionRule +
		stampRule +
		"The Keywords section, when requested, is a single line of 8 to 15 comma-separated topics: no bullets, no commentary. " +
		"Ignore sponsor read-outs and advertisement segments; they are not part of the content and must not appear in any section. " +
		"When a section has no real content in the transcript, write a single italic line such as *None identified.* under its heading, never an empty table or a placeholder-only row. " +
		"Be faithful to the transcript: never invent or calculate facts, names, dates, or numbers that are not stated in it, and flag uncertainty explicitly. " +
		"No preamble before the first heading.";
	const user =
		"Sections to produce:\n" +
		sections.map((s) => `- ## ${s.label}, ${s.hint}`).join("\n") +
		(opts.priorContext
			? `\n\nContext from the previous meeting in this series (for resolving references and status changes, do NOT re-summarize it):\n"""\n${opts.priorContext}\n"""`
			: "") +
		`\n\nTranscript:\n"""\n${transcript}\n"""`;
	return { system, user };
}

/** A diarized transcript segment from AssemblyAI. */
export interface Utterance {
	speaker: string;
	text: string;
	/** Segment start in milliseconds. AssemblyAI provides it; other sources may not. */
	start?: number;
	/** Segment end in milliseconds, when the source provides it. */
	end?: number;
	/** The OTHER voices the diarizer heard at the same time (crosstalk).
	 *  `speaker` stays the dominant voice, whose words the text mostly is;
	 *  an interjection under it is usually lost to the transcription. Only
	 *  WhisperX reports this today. */
	crosstalk?: string[];
}

/** 61000 ms → "1:01"; 3661000 ms → "1:01:01". */
export function fmtTime(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const two = (n: number) => String(n).padStart(2, "0");
	return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** One speaker as it reads in a transcript label: letters get the "Speaker "
 *  prefix, real names render bare. */
function displayLabel(speaker: string): string {
	return isAnonymousLabel(speaker) ? `Speaker ${speaker}` : speaker;
}

/** "A: hello / B: hi" utterances → a speaker-labeled Markdown transcript,
 *  timestamped when segment times are known: **Speaker A [1:02]:** text.
 *  Imported transcripts carry real names, which render bare (**Dana [1:02]:**).
 *  A turn the diarizer heard two voices in at once renders as
 *  **Crosstalk (Dana + Speaker B) [1:02]:**, an honest label beats
 *  confidently attributing overlapped speech to one name. The stamps are what
 *  audio-jump search anchors on. */
export function formatUtterances(utts: Utterance[]): string {
	return utts
		.map((u) => {
			const voices = [...new Set([u.speaker, ...(u.crosstalk ?? [])])];
			const label = voices.length > 1 ? `Crosstalk (${voices.map(displayLabel).join(" + ")})` : displayLabel(u.speaker);
			return `**${label}${u.start != null ? ` [${fmtTime(u.start)}]` : ""}:** ${u.text.trim()}`;
		})
		.join("\n\n");
}

/** The voices inside a "Crosstalk (Dana + Speaker B)" label, dominant first,
 *  or null when the label is an ordinary speaker name. The inverse of the
 *  label formatUtterances renders for overlapped turns. */
export function parseCrosstalkLabel(label: string): string[] | null {
	const m = /^Crosstalk \((.+)\)$/.exec(label.trim());
	if (!m) return null;
	const voices = m[1].split(" + ").map((v) => v.trim()).filter(Boolean);
	return voices.length >= 2 ? voices : null;
}

export function countSpeakers(utts: Utterance[]): number {
	return new Set(utts.map((u) => u.speaker)).size;
}

/** Attendees for a solo voice memo: your name, but ONLY for a genuinely solo,
 *  unlabeled, DIARIZED recording. Undiarized transcripts (Whisper returns no
 *  utterances) can't be proven solo, so they get nothing, a Whisper-captured
 *  team meeting must never be mis-tagged as attended alone. */
export function memoAttendees(utts: Utterance[] | null, yourName: string): string[] {
	if (!yourName.trim() || !utts?.length) return [];
	if (countSpeakers(utts) !== 1 || !isAnonymousLabel(utts[0].speaker)) return [];
	return [yourName.trim()];
}

/** Turn an arbitrary string into a safe Obsidian tag: word characters, slashes,
 *  and hyphens only, so a model id like "claude-haiku-4-5" tags cleanly. */
export function tagify(s: string): string {
	return s
		.trim()
		.replace(/^#+/, "")
		.replace(/[^\w/-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Where each part of a rotated recording starts, in milliseconds, read from a
 *  note's frontmatter.
 *
 *  Under "pa-parts" now, beside pa-recordings and pa-eval: the plugin's
 *  machine-only keys wear that prefix, and a bare "parts" both looked like
 *  something a person wrote and could collide with a property someone actually
 *  uses, which matters, because the plugin hides its own key from the
 *  properties panel and has no business hiding anyone else's. Notes written
 *  before the rename still say "parts", and still work.
 *
 *  Not decoration: every [m:ss] link in a rotated recording's transcript uses
 *  these to pick which part file to open and where in it. Without them a stamp
 *  an hour into a meeting opens part one at the hour mark, which does not
 *  exist. */
export function partOffsetsOf(fm: Record<string, unknown> | null | undefined): number[] {
	const raw = fm?.["pa-parts"] ?? fm?.parts;
	if (!Array.isArray(raw)) return [];
	return raw.map(Number).filter((n) => Number.isFinite(n));
}

/** The finished note: frontmatter properties, extracted body, carried-over
 *  items, marked moments, and the raw transcript for traceability. `source` is
 *  the frontmatter value, "[[vault/path.webm]]" for audio, a URL for YouTube. */
export function assembleNote(opts: {
	title: string;
	date: string;
	source: string;
	embed: string | null;
	body: string | null;
	transcript: string;
	includeTranscript: boolean;
	/** Actual recording wall-clock, e.g. "2:47 PM - 3:12 PM". */
	recorded?: string;
	model: string | null;
	speakers?: number | null;
	/** Resolved participant names; become wiki-links in frontmatter. */
	attendees?: string[];
	/** Recurring-meeting key linking this note to its series. */
	series?: string | null;
	/** "## Carried over" body: open items from the previous meeting. */
	carryOver?: string | null;
	/** Timestamped bookmarks dropped during the recording. */
	moments?: Moment[];
	/** Rotated recordings: each part's start offset in ms, so stamp clicks can
	 *  pick the right embedded player. Omitted for single-file captures. */
	partsMs?: number[];
	/** "Dana (57%), Alex (26%)" talk-share line, when known. */
	speakersLine?: string | null;
	/** "≈$0.04 (12 min audio, 18k tokens)" trust line, when known. */
	cost?: string | null;
	/** Extraction failed after a good transcription: the note is written with
	 *  the transcript anyway and this error, so nothing paid-for is ever lost. */
	extractionError?: string | null;
	/** Attendee links are qualified into this folder when set. */
	peopleFolder?: string | null;
	/** Extra frontmatter properties (source-specific, e.g. YouTube channel). */
	props?: { key: string; value: string }[];
	/** The heading the captured text sits under. A web page stores an article,
	 *  not speech, so it says "Article"; everything else keeps "Transcript". */
	transcriptHeading?: string;
	/** Put the captured text directly under the title, above the extraction. */
	leadWithText?: boolean;
	/** The post's own pictures, already saved into the vault, as embed lines.
	 *  They lead the note, because a post whose whole point is a picture reads
	 *  as a note about nothing until you reach it. */
	media?: string | null;
	/** No extraction ran because there was nothing to extract from, rather than
	 *  because no key is configured. Telling someone whose key is fine to go and
	 *  configure one sends them off to fix what is not broken. */
	nothingToExtract?: boolean;
	/** The file the note is being written to. When its name already carries the
	 *  title, the "# Title" line is left out: Obsidian shows the filename above
	 *  the note, and a heading repeating it is the same words twice. */
	filename?: string;
}): string {
	const fm = [
		"---",
		`date: ${opts.date}`,
		...(opts.recorded ? [`recorded: "${opts.recorded}"`] : []),
		...(opts.source ? [`source: "${opts.source}"`] : []),
		...(opts.props ?? []).map((p) => `${p.key}: "${String(p.value).replace(/"/g, "'")}"`),
		...(opts.speakers ? [`speakers: ${opts.speakers}`] : []),
		...(opts.attendees?.length ? ["attendees:", ...opts.attendees.map((a) => `  - "${personLink(a, opts.peopleFolder)}"`)] : []),
		...(opts.series ? [`series: ${opts.series}`] : []),
		...(opts.partsMs && opts.partsMs.length > 1 ? [`pa-parts: [${opts.partsMs.join(", ")}]`] : []),
		...(opts.cost ? [`cost: "${opts.cost}"`] : []),
		"tags:",
		"  - capture",
		...(opts.model && tagify(opts.model) ? [`  - ${tagify(opts.model)}`] : []),
		"---",
	].join("\n");
	// keep the title tight to the properties block (no blank line between the
	// closing --- and the # title), so the rendered note has no empty gap
	// between the Properties panel and the heading
	const titled = !titleShownByFilename(opts.title, opts.filename ?? "");
	const parts = [titled ? `${fm}\n# ${opts.title}` : fm];
	if (opts.speakersLine) parts.push(`**Speakers:** ${opts.speakersLine}`);
	// above the words and the extraction both: the picture IS the post, and a
	// note that files it below a summary of it has buried the thing captured
	if (opts.media?.trim()) parts.push(`## Media\n\n${opts.media.trim()}`);
	const heading = opts.transcriptHeading ?? "Transcript";
	// a failed extraction ALWAYS keeps the transcript, whatever the setting
	// after a good transcription it's the only copy of what was paid for
	//
	// the transcript is plain speaker lines under the "## Transcript" heading:
	// always visible and editable in place, and styled live by the editor.
	// (No callout wrapper, a callout collapses to raw source when edited.)
	const captured =
		(opts.includeTranscript || opts.extractionError) && opts.transcript.trim()
			? `## ${heading}\n\n${opts.transcript.trim()}`
			: null;
	// A post is short and IS the content, so its own words lead: the summary of
	// two sentences is worth less than the two sentences, and burying them under
	// the extraction meant scrolling to the bottom to read the thing captured.
	// An hour of speech is the other way round, and stays where it was.
	if (captured && opts.leadWithText) parts.push(captured);
	if (opts.body) parts.push(opts.body.trim());
	else if (opts.extractionError)
		parts.push(
			`> [!warning] Extraction failed: the ${heading.toLowerCase()} is saved below.\n> ${opts.extractionError.replace(/\s+/g, " ").trim()}\n> Run **Re-extract this capture** to try again.`
		);
	else if (!opts.nothingToExtract) parts.push("*No extraction ran (configure an Anthropic API key in Power Assistant settings).*");
	if (opts.carryOver) parts.push(`## Carried over\n\n${opts.carryOver}`);
	// Screens are not written here. They are found by scanning the video, which
	// happens after the note exists so a summary is readable a minute sooner, and
	// `withScreensSection` then splices them into exactly the position this would
	// have used: after the extraction, above Moments and the captured text.
	const moments = formatMoments(opts.moments ?? []);
	if (moments) parts.push(`## Moments\n\n${moments}`);
	if (captured && !opts.leadWithText) parts.push(captured);
	if (opts.embed) parts.push(opts.embed);
	const note = parts.join("\n\n");
	// With no title line, the first heading takes the title's place, so it takes
	// its spacing too: tight to the properties block, with no blank line for the
	// eye to fall into between the panel and the note.
	return (titled ? note : note.replace(`${fm}\n\n`, `${fm}\n`)) + "\n";
}

export interface YoutubeInfo {
	title: string;
	channel?: string;
	channelUrl?: string;
	views?: number;
	published?: string;
	subscribers?: string;
	duration?: string;
}
export interface YoutubeMeta extends YoutubeInfo {
	tracks: { baseUrl: string; languageCode?: string }[];
}

/** How long something is, in words: "19 sec", "43 min", "2 hr 3 min".
 *
 *  A property is read, not scrubbed through: "2:03:13" makes you count the
 *  colons to learn it is a two-hour podcast. Seconds are dropped once there are
 *  minutes to report, because nobody chooses what to watch on thirteen seconds.
 *  The transcript's own [m:ss] stamps are a different thing and stay a clock. */
export function humanDuration(sec: number): string {
	const total = Math.max(0, Math.round(sec));
	if (!total) return "";
	if (total < 60) return `${total} sec`;
	let h = Math.floor(total / 3600);
	let m = Math.round((total % 3600) / 60);
	if (m === 60) {
		h += 1;
		m = 0;
	}
	if (!h) return `${m} min`;
	return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Channel metadata from a YouTube watch-page HTML: title, channel, views,
 *  publish date, subscribers, and duration. All best-effort; the title falls
 *  back to a generic label. Independent of whether the page has captions. */
export function extractYoutubeInfo(html: string): YoutubeInfo {
	const jsonStr = (m: RegExpMatchArray | null): string | undefined => {
		if (!m) return undefined;
		try {
			return JSON.parse(`"${m[1]}"`) as string;
		} catch {
			return undefined;
		}
	};
	const info: YoutubeInfo = { title: "YouTube video" };
	const title = jsonStr(html.match(/"videoDetails":\{"videoId":"[^"]*","title":"((?:[^"\\]|\\.)*)"/));
	if (title) info.title = title;
	info.channel = jsonStr(html.match(/"author":"((?:[^"\\]|\\.)*)"/));
	// channel URL: prefer the @handle from the owner's canonical path, fall back
	// to the always-present channel id (both resolve to the channel page)
	const canon = jsonStr(html.match(/"canonicalBaseUrl":"((?:[^"\\]|\\.)*)"/));
	const chId = html.match(/"channelId":"(UC[\w-]+)"/);
	if (canon && /^\/(?:@|channel\/|user\/|c\/)/.test(canon)) info.channelUrl = "https://www.youtube.com" + canon;
	else if (chId) info.channelUrl = "https://www.youtube.com/channel/" + chId[1];
	const views = html.match(/"viewCount":"(\d+)"/);
	if (views) info.views = parseInt(views[1], 10);
	const pub = html.match(/"(?:publishDate|uploadDate)":"(\d{4}-\d{2}-\d{2})/);
	if (pub) info.published = pub[1];
	const subs = html.match(/([\d.,]+[KMB]?)\s+subscribers?\b/i);
	if (subs) info.subscribers = subs[1];
	const len = html.match(/"lengthSeconds":"(\d+)"/);
	if (len) info.duration = humanDuration(parseInt(len[1], 10));
	return info;
}

/** Title, caption tracks, and channel metadata from a watch-page HTML. Returns
 *  null when there are no captions to transcribe. */
export function extractYoutubeMeta(html: string): YoutubeMeta | null {
	const cm = html.match(/"captionTracks":(\[.+?\])/);
	if (!cm) return null;
	let tracks: { baseUrl: string; languageCode?: string }[];
	try {
		tracks = JSON.parse(cm[1]) as { baseUrl: string; languageCode?: string }[];
	} catch {
		return null;
	}
	return { ...extractYoutubeInfo(html), tracks };
}

export interface YoutubeFormat {
	url?: string;
	mimeType?: string;
	bitrate?: number;
	contentLength?: string;
}

/** Pick a downloadable audio-only stream to transcribe: the lowest-bitrate
 *  audio format that has a direct URL (speech needs no hi-fi, and smaller means
 *  faster and cheaper transcription). Skips signature-ciphered formats, which
 *  carry no direct url and would need deciphering. Null when none is usable. */
export function pickYoutubeAudio(formats: YoutubeFormat[] | undefined): { url: string; ext: string } | null {
	const audio = (formats ?? []).filter((f) => !!f.url && typeof f.mimeType === "string" && f.mimeType.startsWith("audio/"));
	if (!audio.length) return null;
	audio.sort((a, b) => (a.bitrate ?? Infinity) - (b.bitrate ?? Infinity));
	const f = audio[0];
	const mt = f.mimeType ?? "";
	const ext = mt.includes("webm") ? "webm" : mt.includes("mp4") || mt.includes("m4a") ? "m4a" : "webm";
	return { url: f.url!, ext };
}

/** The extra frontmatter properties for a captured YouTube note, in a stable
 *  order, from whatever channel metadata was found. */
/** The yt-dlp --print template that returns a video's metadata as one line of
 *  JSON. Asked for alongside the subtitles, because when YouTube has walled the
 *  page this is the only place any of it can come from. */
export const YTDLP_META_PRINT = "%(.{title,channel,channel_url,view_count,upload_date,duration,channel_follower_count})j";

/** yt-dlp's metadata JSON as the shape the note's properties are built from.
 *  Null for anything unparseable, so a bad line costs the properties and not
 *  the capture. */
export function parseYtDlpMeta(line: string): YoutubeInfo | null {
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!j || typeof j !== "object") return null;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
	const info: YoutubeInfo = { title: str(j.title) ?? "" };
	info.channel = str(j.channel);
	info.channelUrl = str(j.channel_url);
	info.views = num(j.view_count);
	// yt-dlp gives the date as 20050424; the notes carry ISO dates
	const d = str(j.upload_date);
	if (d && /^\d{8}$/.test(d)) info.published = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
	const secs = num(j.duration);
	if (secs != null) info.duration = humanDuration(secs);
	const subs = num(j.channel_follower_count);
	if (subs != null) info.subscribers = compactCount(subs);
	return info;
}

/** 6350000 → "6.35M": the way a channel's follower count reads on the page it
 *  came from, since that is what the scraped path puts in the same property. */
export function compactCount(n: number): string {
	if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
	if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}K`;
	return String(n);
}

/** Fill the gaps in what the page gave us from what yt-dlp did. The page is
 *  preferred wherever it answered: it is the source these properties were
 *  designed around, and yt-dlp only has to stand in when YouTube refused. */
export function mergeYoutubeInfo(page: YoutubeInfo | null, fallback: YoutubeInfo | null): YoutubeInfo | null {
	if (!page) return fallback;
	if (!fallback) return page;
	return {
		title: page.title || fallback.title,
		channel: page.channel ?? fallback.channel,
		channelUrl: page.channelUrl ?? fallback.channelUrl,
		views: page.views ?? fallback.views,
		published: page.published ?? fallback.published,
		subscribers: page.subscribers ?? fallback.subscribers,
		duration: page.duration ?? fallback.duration,
	};
}

export function youtubeProps(m: YoutubeInfo): { key: string; value: string }[] {
	const props: { key: string; value: string }[] = [];
	// the channel name as text, then the channel URL below it (Obsidian
	// auto-links a bare URL in a property, like the source row)
	if (m.channel) props.push({ key: "channel", value: m.channel });
	if (m.channelUrl) props.push({ key: "channel url", value: m.channelUrl });
	if (m.published) props.push({ key: "published", value: m.published });
	if (m.views != null) props.push({ key: "views", value: m.views.toLocaleString("en-US") });
	if (m.subscribers) props.push({ key: "subscribers", value: m.subscribers });
	if (m.duration) props.push({ key: "duration", value: m.duration });
	return props;
}

/** Decode a YouTube json3 timedtext payload into plain transcript text. */
export function parseTimedText(json: unknown): string {
	const events = (json as { events?: { segs?: { utf8?: string }[] }[] }).events ?? [];
	return events
		.map((e) => (e.segs ?? []).map((s) => s.utf8 ?? "").join(""))
		.join(" ")
		.replace(/\n/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** The 11-character video id from any YouTube URL shape, or null. */
/** Prepend https:// when a pasted URL has no scheme, so a copied
 *  "youtube.com/watch?v=…" (some copies drop the scheme) still works. */
export function ensureUrlScheme(raw: string): string {
	const s = raw.trim();
	if (!s) return s;
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s;
}

export function youtubeVideoId(url: string): string | null {
	const m =
		url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ??
		url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ??
		url.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
	return m ? m[1] : null;
}

/* ---------------- capture from a link ---------------- */

/** Whether two links are the same thing captured twice.
 *
 *  Not a string compare: the same post reaches the plugin under several links.
 *  A share sheet adds "?s=43&t=…", a copied address may keep "www." or drop the
 *  scheme, and X serves the same status from twitter.com. So the post or video
 *  id decides where there is one, and everything else falls back to the address
 *  with its query, fragment, and trailing slash dropped.
 *
 *  Used to tell a re-capture (refuse, the note is already there) from a
 *  filename collision between two different things (write it under -2). */
export function sameCaptureSource(a: string, b: string): boolean {
	const x = xStatusId(a);
	if (x) return x === xStatusId(b);
	const y = youtubeVideoId(a);
	if (y) return y === youtubeVideoId(b);
	const bare = (u: string) => {
		try {
			const p = new URL(ensureUrlScheme(u));
			return `${p.hostname.toLowerCase().replace(/^www\./, "")}${p.pathname.replace(/\/+$/, "")}`.toLowerCase();
		} catch {
			return u.trim().toLowerCase();
		}
	};
	const ba = bare(a);
	return !!ba && ba === bare(b);
}

/** Whether a filename is a sync client's "keep both" copy, e.g.
 *  "capture-2026-07-23-12-35-19.part1 (sync conflict 2026-07-23 1340 211f13).webm".
 *
 *  Such a file is a second version of something the vault already has, so a
 *  recording named this way must never be swept up and processed as if it were
 *  a recording of its own: that transcribes and extracts the same meeting twice
 *  and leaves two notes to reconcile by hand. Matched on the shape a sync client
 *  writes rather than on any one client's exact stamp, so Obsidian Sync,
 *  Power Connect, and Dropbox's own copies all count. */
export function isSyncConflictName(name: string): boolean {
	return /\((?:sync )?conflict(?:ed)?[^)]*\)/i.test(name) || /\(conflicted copy[^)]*\)/i.test(name);
}

/** A free name from a base one: "note.md", then "note-2.md", "note-3.md", …
 *  `taken` answers whether a name is in use, which keeps the vault out of here.
 *  Matches how a meeting note handles two meetings on one day. */
export function freeNoteName(base: string, taken: (name: string) => boolean): string {
	if (!taken(base)) return base;
	const stem = base.replace(/\.md$/i, "");
	let n = 2;
	while (taken(`${stem}-${n}.md`)) n++;
	return `${stem}-${n}.md`;
}

/** A site whose links go to yt-dlp rather than being read as an article. */
export interface MediaSite {
	id: string;
	label: string;
	/** Registrable hosts; any subdomain of one of these counts. */
	hosts: string[];
	/** Shows a logged-out visitor almost nothing, so a capture needs the
	 *  Cookies from browser setting. Marked in the settings list, because
	 *  "supported" and "will work for you" are different promises here. */
	login?: boolean;
}

/** The sites a pasted link is routed to yt-dlp for.
 *
 *  yt-dlp supports around 1750 sites and normalizes their metadata identically,
 *  so this list is not what makes a site work: it only decides routing and what
 *  the note calls the source. Anything not named here is read as a web page,
 *  and the dialog's Video option forces yt-dlp for a site the list misses. */
export const MEDIA_SITES: MediaSite[] = [
	{ id: "x", label: "X", hosts: ["x.com", "twitter.com"] },
	{ id: "tiktok", label: "TikTok", hosts: ["tiktok.com"] },
	{ id: "instagram", label: "Instagram", hosts: ["instagram.com"], login: true },
	{ id: "facebook", label: "Facebook", hosts: ["facebook.com", "fb.watch", "fb.com"], login: true },
	{ id: "reddit", label: "Reddit", hosts: ["reddit.com", "redd.it"] },
	{ id: "linkedin", label: "LinkedIn", hosts: ["linkedin.com", "lnkd.in"], login: true },
	{ id: "bluesky", label: "Bluesky", hosts: ["bsky.app"] },
	{ id: "vimeo", label: "Vimeo", hosts: ["vimeo.com"] },
	{ id: "twitch", label: "Twitch", hosts: ["twitch.tv"] },
	{ id: "rumble", label: "Rumble", hosts: ["rumble.com"] },
	{ id: "dailymotion", label: "Dailymotion", hosts: ["dailymotion.com", "dai.ly"] },
	{ id: "soundcloud", label: "SoundCloud", hosts: ["soundcloud.com"] },
];

/** A URL's host, lowercased and without "www.", or null when it will not parse. */
export function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return null;
	}
}

/** The known media site a URL belongs to, or null. Matched on the host rather
 *  than by substring so a lookalike domain cannot pass as the real one. */
export function mediaSiteFor(url: string): MediaSite | null {
	const host = hostOf(url);
	if (!host) return null;
	return MEDIA_SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith("." + h))) ?? null;
}

/** Which pipeline a pasted link belongs in. */
export type CaptureRoute = "youtube" | "media" | "web";

/** Where a pasted link goes when the dialog is left on Auto.
 *
 *  YouTube keeps its own path because its captions are free and transcribing its
 *  audio is not. A known media site goes to yt-dlp. Everything else is read as
 *  an article, which costs no transcription at all. A blog post that happens to
 *  embed a video reads as an article, which is nearly always what was wanted;
 *  the dialog can override either way. */
export function routeFor(url: string): CaptureRoute {
	const host = hostOf(url);
	if (host === "youtube.com" || host === "youtu.be" || (host ?? "").endsWith(".youtube.com")) return "youtube";
	if (mediaSiteFor(url)) return "media";
	return "web";
}

/** What a captured post keeps as frontmatter. Everything past the title is
 *  best-effort: a post may come from an account with no display name, and an
 *  older one may report no counts. */
export interface MediaInfo {
	title: string;
	site?: string;
	author?: string;
	handle?: string;
	authorUrl?: string;
	posted?: string;
	views?: number;
	likes?: number;
	/** How many replies a post drew. Records how much discussion it started,
	 *  which is worth knowing even though the replies themselves are behind a
	 *  login and never make it into the note. */
	replies?: number;
	duration?: string;
}

/** The status id in an X post URL, or null when it is not one. Covers the x.com
 *  and legacy twitter.com hosts, the mobile and www subdomains, the /i/web/
 *  share form, the older /statuses/ path, and the /photo/1 and /video/1
 *  suffixes that a click-through appends. */
export function xStatusId(url: string): string | null {
	const m = url.match(/^https?:\/\/(?:[\w-]+\.)*(?:twitter\.com|x\.com)\/(?:i\/web\/|[^/]+\/)?status(?:es)?\/(\d+)/i);
	return m ? m[1] : null;
}

/** Whether a URL is an X post worth handing to yt-dlp. */
export function isXUrl(url: string): boolean {
	return xStatusId(url) !== null;
}

/** What a post says once the link shorteners are taken out, which is the test
 *  for whether it says anything at all. X appends a t.co link to the text of
 *  every post carrying a photo or video, so a post that is all video arrives as
 *  a bare link: not empty, and not words either. Empty here means there is
 *  nothing to title a note with, nothing to summarize, and nothing to send a
 *  model, which answers a bare URL by saying it cannot summarize a URL.
 *
 *  Both spellings of that link have to go. The embed payload carries the real
 *  t.co URL; oEmbed renders the same link with its display text, `pic.x.com/…`,
 *  which has no scheme and would otherwise read as a word. */
export function postWords(text: string): string {
	return (text || "")
		.replace(/(?:https?:\/\/)?(?:t\.co|pic\.(?:x|twitter)\.com)\/\w+/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Whether there is anything here to write notes about, as opposed to a link
 *  and some punctuation. The guard exists because of what happens without it: a
 *  model asked to summarize a bare URL replies that it cannot summarize a URL,
 *  politely and at length, and that reply lands in the note under **Summary**
 *  where the summary should be. Nothing to extract from is not a failure worth
 *  reporting either, it just means the captured text is the whole note. */
export function hasWordsToExtract(text: string): boolean {
	return /[\p{L}\p{N}]/u.test((text || "").replace(/https?:\/\/\S+/g, " "));
}

/** Post text trimmed down to a note title: link-shortener trackers carry no
 *  meaning, newlines would break the filename, and a long post has to stop
 *  somewhere, so it is cut at a word boundary. Falls back when a post is all
 *  video and no words. */
export function postTitleFromText(text: string, fallback: string): string {
	let t = postWords(text);
	if (!t) return fallback;
	if (t.length > 90) {
		const cut = t.slice(0, 90);
		const sp = cut.lastIndexOf(" ");
		t = (sp > 40 ? cut.slice(0, sp) : cut).trim() + "...";
	}
	return t;
}

/** The parts of yt-dlp's --dump-json that a capture actually reads. yt-dlp
 *  normalizes these across every one of its extractors, which is what lets one
 *  parser serve every site instead of one parser per site. */
export interface MediaDump {
	title?: string;
	/** The post's own words. yt-dlp reports these even for a video post, which
	 *  is what lets a clip with no speech still become a note. */
	description?: string;
	uploader?: string;
	uploader_id?: string;
	uploader_url?: string;
	upload_date?: string;
	duration?: number;
	view_count?: number;
	like_count?: number;
	/** yt-dlp's name for the reply count, which the embed payload calls the
	 *  conversation count. Both mean the discussion a post drew, so a post
	 *  captured either way records it under the same property. */
	comment_count?: number;
	extractor_key?: string;
	/** The still yt-dlp reports for a post, on every extractor it has. It is what
	 *  a capture keeps when the post's own media is out of reach, so that a note
	 *  about something visual is never a note with no picture in it. */
	thumbnail?: string;
}

/** yt-dlp's --dump-json reduced to the metadata a note keeps, for any site.
 *  `siteLabel` names the source when the router already recognized it; yt-dlp's
 *  own extractor name is the fallback, so a site the list does not know still
 *  labels itself correctly. */
export function parseMediaInfo(j: MediaDump, siteLabel?: string | null): MediaInfo {
	const author = (j.uploader ?? "").trim();
	const handle = (j.uploader_id ?? "").trim().replace(/^@/, "");
	const raw = (j.title ?? "").trim();
	// yt-dlp's X extractor titles a post "Author - text"; the author gets its own
	// property here, so the title drops that prefix rather than saying it twice
	const text = author && raw.startsWith(author + " - ") ? raw.slice(author.length + 3) : raw;
	const info: MediaInfo = { title: postTitleFromText(text, handle ? `Post from @${handle}` : "Post") };
	const site = (siteLabel || j.extractor_key || "").trim();
	if (site) info.site = site;
	if (author) info.author = author;
	if (handle) info.handle = "@" + handle;
	// yt-dlp reports X's uploader_url on the legacy twitter.com host; the post
	// itself lives on x.com, so the stored link matches the source row
	const uurl = (j.uploader_url ?? "").trim().replace(/^https?:\/\/(?:www\.)?twitter\.com\//i, "https://x.com/");
	if (uurl) info.authorUrl = uurl;
	const d = (j.upload_date ?? "").match(/^(\d{4})(\d{2})(\d{2})$/);
	if (d) info.posted = `${d[1]}-${d[2]}-${d[3]}`;
	if (typeof j.view_count === "number") info.views = j.view_count;
	if (typeof j.like_count === "number") info.likes = j.like_count;
	if (typeof j.comment_count === "number") info.replies = j.comment_count;
	if (typeof j.duration === "number" && j.duration > 0) info.duration = humanDuration(j.duration);
	return info;
}

/* ---------------- re-reading a captured post's counts ---------------- */

/** The source URL of a capture whose counts are worth reading again, or null.
 *
 *  What a post says is settled the moment it is posted; how many people have
 *  seen it is not, so a note filed last week reports last week's number. Only a
 *  captured post or video has counts to re-read: a web page keeps none, and a
 *  recorded meeting's source is a file on disk rather than something to ask. */
export function refreshableSource(fm: Record<string, unknown> | null | undefined): string | null {
	if (!isCaptureNote(fm as { type?: unknown; tags?: unknown } | null)) return null;
	const src = typeof fm?.source === "string" ? fm.source.trim() : "";
	if (!/^https?:\/\//i.test(src)) return null;
	return routeFor(src) === "web" ? null : src;
}

/** One count that a re-read moved. */
export interface StatUpdate {
	key: string;
	/** What the note said before, or null when it had no such property. */
	from: string | null;
	to: string;
}

/** The count properties a fresh read would change, and what they were.
 *
 *  Only the three that move. Everything else a capture stores describes the post
 *  as it was written (its author, its date, its words) and re-reading must not
 *  disturb any of it. A count the fresh read knows nothing about is left alone
 *  rather than blanked: yt-dlp reports views and X's embed payload does not, so
 *  a refresh that fell back to the embed must not erase a number it merely could
 *  not see. */
export function statUpdates(current: Record<string, unknown> | null | undefined, fresh: MediaInfo): StatUpdate[] {
	const out: StatUpdate[] = [];
	for (const [key, n] of [
		["views", fresh.views],
		["likes", fresh.likes],
		["replies", fresh.replies],
	] as const) {
		if (typeof n !== "number") continue;
		const to = n.toLocaleString("en-US");
		const raw = current?.[key];
		const from = raw == null || raw === "" ? null : String(raw);
		if (from !== to) out.push({ key, from, to });
	}
	return out;
}

/** What moved, for the notice that says so: "views 8,352,500 to 8,361,004". */
export function statSummary(updates: StatUpdate[]): string {
	return updates.map((u) => `${u.key} ${u.from ?? "(none)"} to ${u.to}`).join(", ");
}

/** The extra frontmatter properties for a captured post, in a stable order.
 *  The handle and author URL sit next to the name, the way a YouTube capture
 *  stores its channel. */
export function mediaProps(m: MediaInfo): { key: string; value: string }[] {
	const props: { key: string; value: string }[] = [];
	if (m.site) props.push({ key: "site", value: m.site });
	if (m.author) props.push({ key: "author", value: m.author });
	if (m.handle) props.push({ key: "handle", value: m.handle });
	if (m.authorUrl) props.push({ key: "author url", value: m.authorUrl });
	if (m.posted) props.push({ key: "posted", value: m.posted });
	if (m.views != null) props.push({ key: "views", value: m.views.toLocaleString("en-US") });
	if (m.likes != null) props.push({ key: "likes", value: m.likes.toLocaleString("en-US") });
	if (m.replies != null) props.push({ key: "replies", value: m.replies.toLocaleString("en-US") });
	if (m.duration) props.push({ key: "duration", value: m.duration });
	return props;
}

/** How to invoke yt-dlp, in the order worth trying: an explicit setting first,
 *  then the PATH, then the module through Python. pip drops the launcher into a
 *  Scripts directory that is frequently not on PATH, so the module form is what
 *  actually resolves on a stock install where plain "yt-dlp" does not. */
export function ytDlpInvocations(configured: string): { cmd: string; pre: string[] }[] {
	const list: { cmd: string; pre: string[] }[] = [];
	const c = (configured || "").trim();
	if (c) list.push({ cmd: c, pre: [] });
	list.push({ cmd: "yt-dlp", pre: [] });
	list.push({ cmd: "python", pre: ["-m", "yt_dlp"] });
	list.push({ cmd: "python3", pre: ["-m", "yt_dlp"] });
	return list;
}

/** The browser yt-dlp borrows cookies from, or "" for none.
 *
 *  Instagram, Facebook, and LinkedIn serve almost nothing to a logged-out
 *  client, and yt-dlp's only real answer is to read an existing browser session.
 *  It stays off by default because it reaches into the browser's cookie store,
 *  which is not something a note-taking plugin should do unasked. */
export type CookieBrowser = "" | "chrome" | "chromium" | "edge" | "firefox" | "brave";

export const COOKIE_BROWSERS: CookieBrowser[] = ["", "chrome", "chromium", "edge", "firefox", "brave"];

/** The cookie argv: an exported cookies.txt if there is one, else the browser
 *  store, else nothing.
 *
 *  The file wins because it is the one that works where the browser store does
 *  not. Chrome and Edge on Windows encrypt their cookie databases in a way
 *  yt-dlp cannot read (and Firefox is not always installed), which leaves a
 *  file exported from the browser as the only way past YouTube's "sign in to
 *  confirm you're not a bot" wall on such a machine. */
export function cookieArgs(browser: CookieBrowser, file = ""): string[] {
	const f = file.trim();
	if (f) return ["--cookies", f];
	return browser ? ["--cookies-from-browser", browser] : [];
}

/** One cookie, in the shape Electron's session store hands them over. */
export interface SessionCookie {
	name: string;
	value: string;
	domain: string;
	path?: string;
	secure?: boolean;
	/** Seconds since the epoch. Absent means a session cookie. */
	expirationDate?: number;
	/** True when the cookie is for that exact host and no subdomain. */
	hostOnly?: boolean;
}

/** Cookies as the Netscape file yt-dlp reads.
 *
 *  The header line is not decoration: yt-dlp refuses a cookie file without it.
 *  Fields are tab-separated, domain, whether subdomains are included, path,
 *  secure, expiry, name, value, and a session cookie (no expiry) is written as
 *  0, which is how the format says "until the browser closes".
 *
 *  Sorted, so a file written twice from the same session compares equal and a
 *  device syncing one does not churn. */
export function netscapeCookieFile(cookies: SessionCookie[]): string {
	const rows = cookies
		.filter((c) => c.name && c.domain)
		.map((c) => {
			const domain = c.hostOnly ? c.domain.replace(/^\./, "") : c.domain.startsWith(".") ? c.domain : "." + c.domain;
			const sub = c.hostOnly ? "FALSE" : "TRUE";
			const expiry = Math.floor(c.expirationDate ?? 0);
			return [domain, sub, c.path || "/", c.secure ? "TRUE" : "FALSE", String(expiry), c.name, c.value].join("\t");
		})
		.sort();
	return ["# Netscape HTTP Cookie File", "# Written by Power Assistant. Do not edit.", ...rows, ""].join("\n");
}

/** Whether a signed-in YouTube session is actually present in a cookie set.
 *  The session cookies are the ones that carry the sign-in; the consent and
 *  preference cookies a logged-out visit leaves behind are not a sign-in and
 *  must not be reported as one. */
export function hasYoutubeLogin(cookies: SessionCookie[]): boolean {
	return cookies.some((c) => LOGIN_COOKIE.test(c.name) && !!c.value);
}

/** The cookies that carry a Google sign-in.
 *
 *  Wider than it first looks because one sign-in is not one cookie: the domain
 *  it lands on and the names it uses depend on which surface did the signing
 *  in, and a session paired from a television is not the same set as one typed
 *  into the website. Any one of these with a value means signed in. */
const LOGIN_COOKIE = /^(SID|HSID|SSID|APISID|SAPISID|LOGIN_INFO|__Secure-[13]PSID|__Secure-[13]PAPISID|__Secure-[13]PSIDCC|__Secure-YEC_SID)$/;

/** The domains a YouTube sign-in actually spreads itself across. Read from the
 *  session as a whole and filtered here rather than asked for by domain: the
 *  session's own filter matches on its own terms, and a query that quietly
 *  matches nothing is indistinguishable from not being signed in. */
export function isYoutubeCookieDomain(domain: string): boolean {
	const d = (domain || "").replace(/^\./, "").toLowerCase();
	return /(^|\.)(youtube\.com|youtube-nocookie\.com|google\.com|googleapis\.com|googleusercontent\.com)$/.test(d);
}

/**
 * A URL on its way to becoming an argument to another program, or a refusal.
 *
 * yt-dlp reads its argv the way every command-line program does: a word
 * beginning with a dash is an option, wherever it appears. yt-dlp's options
 * include ones that run commands, so a "URL" of `--exec=...` arriving in the
 * last position would not be fetched, it would be obeyed.
 *
 * Nothing reaches these builders that way today. Every entry point goes through
 * `ensureUrlScheme`, and a frontmatter `source` has to match http(s) before a
 * refresh will look at it. But that safety lives several calls above the one
 * line that starts a process, held up by two functions that have other jobs and
 * could reasonably be changed by someone who does not know this depends on
 * them. So it is asserted here instead, in the last place the string is still
 * an ordinary value: one scheme, one check, next to the argv it is going into.
 *
 * Throwing rather than repairing. Every real caller already satisfies this, so
 * anything that does not is a bug upstream, and quietly rewriting it into
 * something safe-looking would hide the bug rather than surface it.
 */
function urlArg(url: string): string {
	if (!/^https?:\/\//i.test(url)) throw new Error("Power Assistant only fetches http and https links.");
	return url;
}

/** The yt-dlp argv that reads a post's metadata without touching the media. */
export function ytDlpInfoArgs(url: string, cookies: CookieBrowser = "", cookieFile = ""): string[] {
	return ["--dump-json", "--no-playlist", "--no-warnings", ...cookieArgs(cookies, cookieFile), urlArg(url)];
}

/** The yt-dlp argv that writes a video's subtitles beside `outTemplate` and
 *  downloads no media at all.
 *
 *  The caption track is free and exact where the audio costs a transcription,
 *  so this is tried first. Uploaded subtitles are preferred over the automatic
 *  ones (yt-dlp writes both when asked, and the real ones are punctuated), and
 *  VTT is asked for because the transcript importer already parses it. */
export function ytDlpSubsArgs(url: string, outTemplate: string, cookies: CookieBrowser = "", cookieFile = ""): string[] {
	return [
		"--skip-download",
		"--write-subs",
		"--write-auto-subs",
		"--sub-langs",
		"en.*,en",
		"--sub-format",
		"vtt",
		"--no-playlist",
		"--no-warnings",
		"--no-progress",
		"-o",
		outTemplate,
		// the metadata in the same run: when YouTube has refused to describe
		// the video, this is the only place the note's name and properties can
		// come from.
		// --print implies a dry run, which would write no subtitles, so
		// --no-simulate turns that back off; --skip-download still holds the
		// media back.
		"--print",
		YTDLP_META_PRINT,
		"--no-simulate",
		...cookieArgs(cookies, cookieFile),
		urlArg(url),
	];
}

/** What YouTube said when it refused to describe a video, in words that name
 *  the cause and the way out. Empty when it did not refuse.
 *
 *  Worth its own function because the refusal arrives as a perfectly ordinary
 *  200 with an empty caption list, which the capture used to report as "this
 *  video has no captions to fetch", a diagnosis that sends you looking at the
 *  video instead of at the wall in front of it. */
export function youtubeBlockReason(status: string, reason = ""): string {
	const s = (status || "").toUpperCase();
	if (!s || s === "OK") return "";
	if (/bot/i.test(reason) || s === "LOGIN_REQUIRED")
		return "YouTube is asking this device to sign in (“" + (reason.trim() || "Sign in to confirm you're not a bot") + "”), so it will not say what captions this video has.";
	if (s === "AGE_VERIFICATION_REQUIRED") return "YouTube wants an age-verified sign-in for this video.";
	if (s === "UNPLAYABLE" || s === "ERROR") return "YouTube refused this video" + (reason.trim() ? `: ${reason.trim()}` : ".");
	return `YouTube answered "${s}"` + (reason.trim() ? `: ${reason.trim()}` : ".");
}

/** Append `next` to `text`, dropping the words at the front of it that are
 *  already the tail of what is there.
 *
 *  YouTube's automatic captions are a rolling two-line display: each cue
 *  repeats the line before it and adds one more, so pasting the cues together
 *  says everything two or three times over. Taking the LONGEST overlap is what
 *  collapses that. A speaker who really did repeat themselves loses the second
 *  saying, which is the rare case and the cheaper one: a transcript that reads
 *  three times over is unusable, and costs three times as much to extract. */
export function appendWithoutOverlap(text: string, next: string, maxWords = 60): string {
	if (!text) return next;
	if (!next) return text;
	const a = text.split(" ");
	const b = next.split(" ");
	const limit = Math.min(maxWords, a.length, b.length);
	for (let k = limit; k > 0; k--) {
		let same = true;
		for (let i = 0; i < k; i++)
			if (a[a.length - k + i].toLowerCase() !== b[i].toLowerCase()) {
				same = false;
				break;
			}
		if (same) return k === b.length ? text : `${text} ${b.slice(k).join(" ")}`;
	}
	return `${text} ${next}`;
}

/** Whether a caption track was written by YouTube's speech recognizer rather
 *  than by a person. Its giveaway is per-word timing markup inside the cues,
 *  which an uploaded track has no reason to carry. A human track is worth
 *  preferring: same words, real punctuation, no rolling repetition. */
export function looksAutoCaptioned(vtt: string): boolean {
	return /<\d\d:\d\d:\d\d\.\d\d\d>/.test(vtt);
}

/** Caption cues as one block of prose: the words, without the timings and
 *  without the rolling repetition automatic captions are made of. */
export function captionsToText(vtt: string): string {
	let out = "";
	for (const u of parseCues(vtt)) {
		// entities survive the cue parser, and ">>" is how an automatic track
		// marks a change of speaker, so both are turned back into characters
		const t = decodeXmlEntities(u.text).replace(/\s+/g, " ").trim();
		if (t) out = appendWithoutOverlap(out, t);
	}
	return out.trim();
}

/** The yt-dlp argv that pulls a post's audio down to `outTemplate`.
 *
 *  bestaudio takes the audio-only track when the host offers one. X serves those
 *  as HLS, which yt-dlp's own downloader stitches together without ffmpeg, so a
 *  capture costs roughly a tenth of the bytes of the muxed file and adds no
 *  dependency on a second binary. `best` is the fallback for a post that only
 *  offers a muxed progressive file; the caller size-checks whatever lands.
 *
 *  --print after_move:filepath reports the real path, since the extension is
 *  whatever the chosen format turns out to be, and --no-simulate is required
 *  because --print otherwise implies a dry run. */
export function ytDlpAudioArgs(url: string, outTemplate: string, cookies: CookieBrowser = "", cookieFile = ""): string[] {
	return ["-f", "bestaudio/best", "--no-playlist", "--no-warnings", "--no-progress", "-o", outTemplate, "--print", "after_move:filepath", "--no-simulate", ...cookieArgs(cookies, cookieFile), urlArg(url)];
}

/* ---------------- posts with no video ---------------- */

/** yt-dlp's ways of saying a link carries no media it can fetch.
 *
 *  This is not a failure. Most posts are words, and yt-dlp refusing one for
 *  having no video says nothing about whether it is worth capturing, so this
 *  routes rather than reports. */
export const NO_MEDIA_RE = /no video could be found|no video formats found|unsupported url|there is no video/i;

/* ---------------- a post's own context ---------------- */

/** The token X's embed script derives from a post id.
 *
 *  A 19-digit id is past what a double holds exactly, so this arithmetic loses
 *  precision. That is not a bug to fix: the endpoint recomputes the same lossy
 *  expression and compares, so matching it is the whole requirement. */
export function xSyndicationToken(id: string): string {
	return ((Number(id) / 1e6) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/** The endpoint behind X's embedded-post widget.
 *
 *  It answers a logged-out client the way oEmbed does, but carries what oEmbed
 *  drops: the exact timestamp, the counts, and above all the post this one
 *  quotes or replies to. That context is not a nicety. A quote-post's own words
 *  routinely mean nothing without it, and "Way more than a billion" filed on
 *  its own is a note about nothing. */
export function xSyndicationUrl(id: string): string {
	return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${xSyndicationToken(id)}&lang=en`;
}

/** A post as the embed payload carries it. Everything is optional: an older
 *  post reports no counts, and most posts quote and answer nothing. */
export interface TweetEmbedBase {
	text?: string;
	created_at?: string;
	user?: { name?: string; screen_name?: string };
	/** Where X names the t.co links it appended itself, one per photo or video.
	 *  Having them named is what separates them from a link the author typed:
	 *  these point back at the post and say nothing, that one is the point. */
	entities?: { media?: { url?: string }[] };
}

/** One address a post's video is served from. The two places X lists these
 *  spell the same two fields differently, so both spellings are read: a
 *  `mediaDetails` entry says `content_type` and `url`, the top-level `video`
 *  block says `type` and `src`. */
export interface TweetVariant {
	content_type?: string;
	type?: string;
	url?: string;
	src?: string;
	bitrate?: number;
}

/** One item of a post's media, as the embed payload describes it. */
export interface TweetMediaDetail {
	/** "photo", "video", or "animated_gif". */
	type?: string;
	/** The still: the picture itself for a photo, the poster frame otherwise. */
	media_url_https?: string;
	video_info?: { variants?: TweetVariant[] };
}

export interface TweetEmbed extends TweetEmbedBase {
	favorite_count?: number;
	conversation_count?: number;
	/** Present when the post carries video. A post with no words that has one is
	 *  a capture waiting on yt-dlp, not an empty post, and the two are worth
	 *  telling apart when explaining why nothing was captured. */
	video?: { durationMs?: number; poster?: string; variants?: TweetVariant[] };
	/** Every picture, GIF and video the post holds up, each saying which it is.
	 *  The only place that distinction is made: the block above says "video"
	 *  about a GIF too. */
	mediaDetails?: TweetMediaDetail[];
	/** The photos alone, for a payload that describes them nowhere else. */
	photos?: { url?: string }[];
	/** The post this one quotes. */
	quoted_tweet?: TweetEmbedBase;
	/** The post this one answers, when the capture target is itself a reply. */
	parent?: TweetEmbedBase;
}

/** One picture, GIF, or video hanging off a post.
 *
 *  `kind` is not decoration. It decides what happens when the file is too big
 *  to keep: a photo is saved whole or not at all, while a video has a poster
 *  frame to fall back to, which is a poorer record of the post but still a
 *  picture of it. */
export interface PostMedia {
	kind: "photo" | "gif" | "video";
	url: string;
	/** The still shown before a video plays. Absent on a photo, which is its own
	 *  still. */
	poster?: string;
}

/** The frame size named in an X media address, as a pixel count, or 0.
 *
 *  X puts the dimensions in the path ("…/vid/avc1/812x718/…"), which is the only
 *  thing separating the variants when the payload quotes no bitrates. */
export function variantPixels(url: string): number {
	const m = (url || "").match(/\/(\d{2,5})x(\d{2,5})\//);
	return m ? +m[1] * +m[2] : 0;
}

/** The best single file among a post's video variants, or null.
 *
 *  Highest bitrate wins, and the frame size in the address breaks the tie,
 *  because the top-level variant list quotes no bitrates at all and taking the
 *  first would store the smallest copy X offers.
 *
 *  HLS playlists are passed over however high they rank. A .m3u8 is a list of
 *  segment addresses rather than a video, so keeping one puts a text file in
 *  the vault that plays nothing the moment X stops serving what it names. */
export function bestVideoVariant(variants: TweetVariant[] | undefined): string | null {
	let best: { url: string; rank: [number, number] } | null = null;
	for (const v of variants ?? []) {
		const mime = (v.content_type ?? v.type ?? "").toLowerCase();
		const url = (v.url ?? v.src ?? "").trim();
		if (!url || !mime.includes("mp4")) continue;
		const rank: [number, number] = [typeof v.bitrate === "number" ? v.bitrate : 0, variantPixels(url)];
		if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { url, rank };
	}
	return best?.url ?? null;
}

/** Everything a post holds up to look at, in the order X lists it.
 *
 *  `mediaDetails` is read first because it is the only part of the payload that
 *  tells a GIF from a video and names photos beside them; the top-level blocks
 *  are the fallback for a payload carrying one without the other.
 *
 *  A GIF comes back as an MP4, because that is what X stores: uploading a GIF
 *  converts it to a silent looping video. It is still the whole point of the
 *  post, so it is kept as a file rather than reduced to a still of its first
 *  frame, which of an animation is a picture of almost nothing.
 *
 *  A video whose variants are all HLS falls back to its poster, on the same
 *  reasoning: a frame of it is worth more in a note than a link that will rot. */
export function tweetMedia(j: TweetEmbed): PostMedia[] {
	const out: PostMedia[] = [];
	for (const m of j.mediaDetails ?? []) {
		const still = (m.media_url_https ?? "").trim();
		if (m.type !== "video" && m.type !== "animated_gif") {
			if (still) out.push({ kind: "photo", url: still });
			continue;
		}
		const kind = m.type === "animated_gif" ? "gif" : "video";
		const url = bestVideoVariant(m.video_info?.variants);
		if (url) out.push(still ? { kind, url, poster: still } : { kind, url });
		else if (still) out.push({ kind: "photo", url: still });
	}
	if (out.length) return out;
	for (const p of j.photos ?? []) {
		const url = (p.url ?? "").trim();
		if (url) out.push({ kind: "photo", url });
	}
	const poster = (j.video?.poster ?? "").trim();
	const url = bestVideoVariant(j.video?.variants);
	if (url) out.push(poster ? { kind: "video", url, poster } : { kind: "video", url });
	else if (poster) out.push({ kind: "photo", url: poster });
	return out;
}

/** The filename a post's saved media lands under: the note's own name, an index
 *  when the post carries more than one, and the extension off the address.
 *  Mirrors `frameFileName`, so an attachments folder holding both reads as one
 *  set rather than two conventions. */
export function postMediaFileName(noteBase: string, url: string, index: number, total: number): string {
	const base = (noteBase || "post").replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || "post";
	const ext = ((url || "").split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i)?.[1] ?? "jpg").toLowerCase();
	return total > 1 ? `${base} ${index + 1}.${ext}` : `${base}.${ext}`;
}

/** A post's own words, with the links X appended for its own media removed.
 *  Empty when the post is media and nothing else, see `postWords`. A link the
 *  author actually typed is not in `entities.media` and survives. */
export function tweetOwnText(t: TweetEmbedBase | undefined): string {
	let s = t?.text ?? "";
	for (const m of t?.entities?.media ?? []) if (m.url) s = s.split(m.url).join("");
	s = s
		.replace(/[ \t]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.trim();
	return postWords(s) ? s : "";
}

/** A quoted or replied-to post as an attributed Markdown blockquote, or null
 *  when there is nothing there. The attribution matters as much as the words:
 *  a note has to say whose sentence it is quoting. */
export function quotedBlock(t: TweetEmbedBase | undefined, lead: string): string | null {
	const text = tweetOwnText(t);
	if (!text) return null;
	const name = (t?.user?.name ?? "").trim();
	const handle = (t?.user?.screen_name ?? "").trim();
	const who = name && handle ? `${name} (@${handle})` : name || (handle ? `@${handle}` : "");
	const body = text
		.split("\n")
		.map((l) => (l.trim() ? `> ${l}` : ">"))
		.join("\n");
	return `${lead}${who ? ` ${who}` : ""}:\n\n${body}`;
}

/** A post read from the embed payload: its words, the properties a note keeps,
 *  and whether there is video behind them. */
export interface TweetRead {
	/** Empty when the post is media and carries no words of its own. */
	text: string;
	info: MediaInfo;
	/** Only the embed payload knows this; oEmbed does not say. */
	hasVideo?: boolean;
	/** The pictures, GIFs and videos the post carries. Empty from oEmbed, which
	 *  describes none of them. */
	media?: PostMedia[];
}

/** A post's words plus the context that makes them mean something.
 *
 *  The parts read in the order the conversation happened: what was being
 *  answered, then the post itself, then whatever it holds up to look at. The
 *  title comes from the post's OWN words, never the context, so a note is filed
 *  under what its author said rather than under what they were quoting.
 *
 *  A post with no words at all still returns, with empty text: the payload named
 *  its author and counted its likes, so it was read, and reporting it unread
 *  would send the caller off to fetch x.com as a web page, which answers a
 *  logged-out reader with nothing. Null is for a payload that carries no post. */
export function parseTweetEmbed(j: TweetEmbed): TweetRead | null {
	const own = tweetOwnText(j);
	const parent = quotedBlock(j.parent, "In reply to");
	const quoted = quotedBlock(j.quoted_tweet, "Quoting");
	const media = tweetMedia(j);
	if (!own && !parent && !quoted && !(j.text ?? "").trim() && !j.user && !media.length) return null;
	const text = [parent, own, quoted].filter(Boolean).join("\n\n");
	const author = (j.user?.name ?? "").trim();
	const handle = (j.user?.screen_name ?? "").trim();
	const info: MediaInfo = { title: postTitleFromText(own || text, handle ? `Post from @${handle}` : "Post"), site: "X" };
	if (author) info.author = author;
	if (handle) {
		info.handle = `@${handle}`;
		info.authorUrl = `https://x.com/${handle}`;
	}
	const posted = (j.created_at ?? "").slice(0, 10);
	if (/^\d{4}-\d{2}-\d{2}$/.test(posted)) info.posted = posted;
	if (typeof j.favorite_count === "number") info.likes = j.favorite_count;
	if (typeof j.conversation_count === "number") info.replies = j.conversation_count;
	const read: TweetRead = { text, info };
	if (j.video) read.hasVideo = true;
	if (media.length) read.media = media;
	return read;
}

/** X's public oEmbed endpoint.
 *
 *  The documented, stable way to a post's text, kept as the fallback behind the
 *  embed payload above: that one is undocumented and can be withdrawn, and this
 *  one costs nothing to keep working. It carries the words and little else,
 *  which is why it is second now rather than first. hide_thread keeps a reply
 *  about itself rather than dragging in its parent.
 *
 *  The publish.twitter.com host this used to name now answers 301 to this one,
 *  which costs a redirect the fetcher is not promised to follow. */
export function xOembedUrl(url: string): string {
	return `https://publish.x.com/oembed?url=${encodeURIComponent(url)}&omit_script=1&dnt=1&hide_thread=1`;
}

export interface TweetOembed {
	html?: string;
	author_name?: string;
	author_url?: string;
}

/** "July 15, 2026" as an ISO date, the exact inverse of `longDate` further down,
 *  whose MONTHS this shares. oEmbed dates a post only in the anchor's own words,
 *  so this is the only date a text post can get. */
export function isoFromLongDate(s: string): string | undefined {
	const m = (s || "").trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
	if (!m) return undefined;
	const i = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
	if (i < 0) return undefined;
	return `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** A post's own words out of an oEmbed reply, for the posts yt-dlp refuses.
 *  The text is the blockquote's paragraph, where <br> carries the line breaks;
 *  the date survives only as the trailing anchor's label. Null when the reply
 *  carries no post.
 *
 *  This reply does not name which links X appended for the post's own media, so
 *  a paragraph that is nothing but links reads as wordless whichever kind they
 *  were, which is the right answer either way, since a note cannot be written
 *  about a bare link. */
export function parseTweetOembed(j: TweetOembed): TweetRead | null {
	const html = j.html ?? "";
	const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
	if (!p) return null;
	const raw = decodeXmlEntities(p[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
		.replace(/[ \t]+\n/g, "\n")
		.trim();
	if (!raw) return null;
	const text = postWords(raw) ? raw : "";
	const author = (j.author_name ?? "").trim();
	const handle = (j.author_url ?? "").match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i)?.[1] ?? html.match(/\(@([A-Za-z0-9_]+)\)/)?.[1] ?? "";
	const info: MediaInfo = { title: postTitleFromText(text, handle ? `Post from @${handle}` : "Post"), site: "X" };
	if (author) info.author = author;
	if (handle) {
		info.handle = "@" + handle;
		info.authorUrl = `https://x.com/${handle}`;
	}
	const posted = isoFromLongDate(html.match(/<a href="[^"]*status\/\d+[^"]*"[^>]*>([^<]+)<\/a>/i)?.[1] ?? "");
	if (posted) info.posted = posted;
	return { text, info };
}

/* ---------------- web page capture ---------------- */

/** What a captured web page keeps as frontmatter. */
export interface WebInfo {
	title: string;
	site?: string;
	author?: string;
	published?: string;
}

/** Open Graph and friends, read straight out of a page's HTML.
 *
 *  Readability reports a byline, site name, and published time on well-marked
 *  pages and misses on plenty of others, so this fills the gaps from the meta
 *  tags nearly every publisher emits. Regex rather than a DOM walk on purpose:
 *  it keeps this half of the pipeline pure and testable in the Node harness,
 *  where there is no document to parse into. */
export function parseWebMeta(html: string): WebInfo & { title: string } {
	const meta = (prop: string): string | undefined => {
		const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// content can sit on either side of the name, so both orders are tried
		const m =
			html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*\\scontent=["']([^"']*)["']`, "i")) ??
			html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*\\s(?:property|name)=["']${esc}["']`, "i"));
		const v = m ? decodeXmlEntities(m[1]).trim() : "";
		return v || undefined;
	};
	const out: WebInfo = { title: "" };
	out.title = meta("og:title") ?? meta("twitter:title") ?? decodeXmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
	out.site = meta("og:site_name") ?? meta("application-name");
	out.author = meta("author") ?? meta("article:author") ?? meta("twitter:creator");
	// an author tag is sometimes a profile URL rather than a name; a URL says
	// nothing useful in an author property, so it is dropped
	if (out.author && /^https?:\/\//i.test(out.author)) out.author = undefined;
	const pub = meta("article:published_time") ?? meta("og:article:published_time") ?? meta("article:modified_time") ?? meta("date") ?? meta("datePublished");
	const d = (pub ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
	if (d) out.published = d[1];
	return out;
}

/* ---------------- sharing a page outside the vault ---------------- */

/** A note is written for the vault it lives in. Sending one out means stripping
 *  everything that only means something in here.
 *
 *  Two of these are about privacy, not tidiness, and are the reason this runs
 *  before anything else: `%%comments%%` are the syntax Obsidian gives you for
 *  writing something only you will read (Power Editor's inline comments are
 *  stored that way too), and frontmatter is bookkeeping that can hold a cost, a
 *  source URL, or whatever else you happened to file there. Neither has any
 *  business leaving with the note. */
export function flattenForShare(md: string): string {
	let out = (md || "").replace(/\r\n/g, "\n");
	// frontmatter, only when it opens the note
	out = out.replace(/^---\n[\s\S]*?\n---\n?/, "");
	// private-by-definition, and multiline: an inline comment can wrap
	out = out.replace(/%%[\s\S]*?%%/g, "");
	// the plugin's own progress callouts, which are transient UI
	out = out.replace(/\n*> \[!pc-working\][^\n]*(?:\n>[^\n]*)*\n*/g, "\n");
	// an embed is a file the reader does not have
	out = out.replace(/!\[\[[^\]]*\]\]/g, "");
	// a wikilink cannot resolve outside the vault, so it becomes its own words:
	// the alias when there is one, else the target without its folder or heading
	out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => {
		if (alias) return alias;
		return target.split("#")[0].split("/").pop()?.trim() || target;
	});
	// A callout's [!type] marker is Obsidian's; the quote and its title survive.
	// The gap after the marker is [ \t]* and not \s*, which would cross the
	// newline on a titleless callout and hoist the line below it into the title.
	out = out.replace(/^> \[!\w+\][+-]?[ \t]*(.*)$/gm, (_m, title: string) => (title.trim() ? `> **${title.trim()}**` : ">"));
	// block ids are anchors for links that are no longer there
	out = out.replace(/[ \t]*\^[A-Za-z0-9-]+$/gm, "");
	// highlights have no plain-Markdown meaning; the words are the point
	out = out.replace(/==([^=\n]+)==/g, "$1");
	return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** A note that opens with a heading is telling you its title, and a captured one
 *  always does. Lift it out so a shared page carries one title rather than two:
 *  the filename above and the page's own headline immediately under it.
 *
 *  Pinned to the very start, because a heading anywhere else is a section of the
 *  piece rather than its name. */
export function splitLeadingTitle(md: string): { title: string; body: string } {
	const m = md.match(/^#\s+(.+?)[ \t]*$/m);
	if (!m || m.index !== 0) return { title: "", body: md };
	return { title: m[1].trim(), body: md.slice(m[0].length).trim() };
}

/** Split a typed recipient list. People paste addresses separated by whatever
 *  their last mail client used, so commas, semicolons, and newlines all count. */
export function parseRecipients(s: string): string[] {
	return [...new Set((s || "").split(/[,;\n]/).map((a) => a.trim()).filter(Boolean))];
}

/** Whether every recipient looks like an address, so a typo is caught before
 *  Graph is asked to send to it. Deliberately loose: mail addresses are far
 *  stranger than the usual regex admits, and the mail server is the real judge. */
export function invalidRecipients(list: string[]): string[] {
	return list.filter((a) => !/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(a));
}

/* ---------------- MSN ---------------- */

/** MSN builds its pages in the browser, so a fetch gets back a script shell with
 *  the headline nowhere in it: the reader finds no article and rightly says so.
 *  The text is served separately, keyed by the id sitting in the URL, which
 *  makes that id the whole way in.
 *
 *  Only `ar-` (article) is claimed here. `vi-` and `ss-` are a video and a
 *  slideshow, which are not this path's job. */
export function msnArticleRef(url: string): { id: string; locale: string } | null {
	const host = hostOf(url);
	if (!host || (host !== "msn.com" && !host.endsWith(".msn.com"))) return null;
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return null;
	}
	const id = path.match(/\/ar-([A-Za-z0-9]+)/)?.[1];
	if (!id) return null;
	// The first segment is the market the page was served for. Every market
	// returns the same article and the API rejects one it does not know, so a
	// path that opens with something else falls back rather than failing.
	const locale = path.match(/^\/([a-z]{2}-[a-z]{2})\//i)?.[1].toLowerCase() ?? "en-us";
	return { id, locale };
}

/** Where MSN keeps the article body for a ref. */
export function msnApiUrl(ref: { id: string; locale: string }): string {
	return `https://assets.msn.com/content/view/v2/Detail/${ref.locale}/${ref.id}`;
}

/** MSN's article JSON read down to what the page reader would have returned.
 *
 *  The body is ordinary semantic HTML, so Turndown takes it as-is; MSN's own
 *  `<img data-reference>` placeholders carry no src and Turndown drops them.
 *
 *  MSN aggregates other publishers, so the interesting names are theirs: the
 *  provider wrote the piece and its canonical URL outlives the MSN link, which
 *  is a tracking URL for a slot on a feed. */
export function parseMsnArticle(json: unknown): { title: string; html: string; info: WebInfo; canonical?: string } | null {
	const j = (json ?? {}) as {
		title?: unknown;
		body?: unknown;
		sourceHref?: unknown;
		publishedDateTime?: unknown;
		authors?: unknown;
		provider?: { name?: unknown };
		seo?: { canonicalUrl?: unknown };
	};
	const html = typeof j.body === "string" ? j.body : "";
	const title = typeof j.title === "string" ? j.title.trim() : "";
	if (!html.trim() || !title) return null;
	const info: WebInfo = { title };
	const site = typeof j.provider?.name === "string" ? j.provider.name.trim() : "";
	if (site) info.site = site;
	const authors = Array.isArray(j.authors) ? j.authors : [];
	const author = authors
		.map((a) => (typeof (a as { name?: unknown })?.name === "string" ? ((a as { name: string }).name ?? "").trim() : ""))
		.filter(Boolean)
		.join(", ");
	if (author) info.author = author;
	const published = typeof j.publishedDateTime === "string" ? j.publishedDateTime.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] : undefined;
	if (published) info.published = published;
	const canonical = [j.seo?.canonicalUrl, j.sourceHref].find((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u));
	return { title, html, info, canonical };
}

/** A readable site name from a URL, for a page whose HTML never said one. */
export function siteNameFromUrl(url: string): string {
	const host = hostOf(url) ?? "";
	return host.replace(/\.(com|org|net|io|co|dev|ai|news|blog)(\.[a-z]{2})?$/i, "") || host;
}

/** The extra frontmatter properties for a captured web page. */
export function webProps(m: WebInfo): { key: string; value: string }[] {
	const props: { key: string; value: string }[] = [];
	if (m.site) props.push({ key: "site", value: m.site });
	if (m.author) props.push({ key: "author", value: m.author });
	if (m.published) props.push({ key: "published", value: m.published });
	return props;
}

/** Titles compared the way a reader would: case, spacing, and punctuation are
 *  noise when deciding whether two strings name the same thing. */
function sameTitle(a: string, b: string): boolean {
	const norm = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^\p{L}\p{N} ]/gu, "")
			.replace(/\s+/g, " ")
			.trim();
	return !!a && norm(a) === norm(b);
}

/** Tidy the Markdown that Turndown produces from an article body.
 *
 *  Readability keeps the page's own headline, which would otherwise repeat
 *  immediately under the note's title, and converted HTML tends to arrive with
 *  runs of blank lines where the layout had spacing. */
export function cleanArticleMarkdown(md: string, title: string): string {
	let out = (md || "").replace(/\r\n/g, "\n").trim();
	// multiline so $ ends the line rather than the string, then pinned to index 0:
	// only a headline the article opens with is a duplicate of the note title, and
	// a matching heading further down is part of the piece
	const h = out.match(/^#{1,3}\s+(.+)$/m);
	if (h && h.index === 0 && sameTitle(h[1], title)) out = out.slice(h[0].length).trim();
	return out
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function decodeXmlEntities(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_: string, n: string) => String.fromCodePoint(+n))
		.replace(/&#x([0-9a-fA-F]+);/g, (_: string, n: string) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Decode YouTube's XML timedtext (what the Android player client serves) into
 *  plain transcript text: paragraph contents, tags stripped, entities decoded. */
export function parseTimedTextXml(xml: string): string {
	const parts: string[] = [];
	const re = /<p[^>]*>([\s\S]*?)<\/p>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml))) {
		const text = decodeXmlEntities(m[1].replace(/<[^>]+>/g, " "));
		if (text.trim()) parts.push(text);
	}
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/* ---------------- ask-your-vault: chunking, BM25 index, prompts ---------------- */

export interface Chunk {
	heading: string;
	text: string;
}

const MAX_CHUNK = 1600;

/** Split a note into heading-scoped chunks, hard-wrapping any section that
 *  outgrows MAX_CHUNK so one giant transcript can't dominate retrieval. */
export function chunkNote(content: string): Chunk[] {
	const body = content.replace(/^---\n[\s\S]*?\n---\n/, "");
	const out: Chunk[] = [];
	let heading = "";
	let buf: string[] = [];
	const flush = () => {
		const text = buf.join("\n").trim();
		buf = [];
		if (!text) return;
		for (let i = 0; i < text.length; i += MAX_CHUNK) out.push({ heading, text: text.slice(i, i + MAX_CHUNK) });
	};
	for (const line of body.split("\n")) {
		const h = line.match(/^#{1,6}\s+(.*)/);
		if (h) {
			flush();
			heading = h[1].trim();
		} else buf.push(line);
	}
	flush();
	return out;
}

const STOPWORDS = new Set(
	"a an and are as at be but by for from has have i in is it its of on or that the this to was we were what when where which who will with you your".split(" ")
);

export function tokenize(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

interface IndexedChunk {
	id: number;
	path: string;
	heading: string;
	text: string;
	len: number;
}

/** A small BM25 index over note chunks. Pure and incremental: addFile replaces
 *  a file's chunks, removeFile drops them, search scores against the postings. */
export class SearchIndex {
	private chunks = new Map<number, IndexedChunk>();
	private postings = new Map<string, Map<number, number>>();
	private byPath = new Map<string, number[]>();
	private nextId = 1;
	private totalLen = 0;

	addFile(path: string, chunks: Chunk[]) {
		this.removeFile(path);
		const ids: number[] = [];
		for (const c of chunks) {
			const tokens = tokenize(`${c.heading} ${c.text}`);
			if (!tokens.length) continue;
			const id = this.nextId++;
			this.chunks.set(id, { id, path, heading: c.heading, text: c.text, len: tokens.length });
			this.totalLen += tokens.length;
			for (const t of tokens) {
				let post = this.postings.get(t);
				if (!post) this.postings.set(t, (post = new Map<number, number>()));
				post.set(id, (post.get(id) ?? 0) + 1);
			}
			ids.push(id);
		}
		this.byPath.set(path, ids);
	}

	removeFile(path: string) {
		const ids = this.byPath.get(path);
		if (!ids) return;
		for (const id of ids) {
			const c = this.chunks.get(id);
			if (!c) continue;
			this.totalLen -= c.len;
			this.chunks.delete(id);
		}
		const gone = new Set(ids);
		for (const [term, post] of this.postings) {
			for (const id of gone) post.delete(id);
			if (!post.size) this.postings.delete(term);
		}
		this.byPath.delete(path);
	}

	get size() {
		return this.chunks.size;
	}

	search(terms: string[], k: number): { path: string; heading: string; text: string; score: number }[] {
		const N = this.chunks.size;
		if (!N) return [];
		const avgdl = this.totalLen / N;
		const k1 = 1.5;
		const b = 0.75;
		const scores = new Map<number, number>();
		for (const term of new Set(terms)) {
			const post = this.postings.get(term);
			if (!post) continue;
			const idf = Math.log(1 + (N - post.size + 0.5) / (post.size + 0.5));
			for (const [id, tf] of post) {
				const c = this.chunks.get(id)!;
				const s = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.len) / avgdl)));
				scores.set(id, (scores.get(id) ?? 0) + s);
			}
		}
		return [...scores.entries()]
			.sort((x, y) => y[1] - x[1])
			.slice(0, k)
			.map(([id, score]) => {
				const c = this.chunks.get(id)!;
				return { path: c.path, heading: c.heading, text: c.text, score };
			});
	}
}

/** Parse Claude's keyword-expansion reply: one term per line, tolerant of
 *  bullets and numbering; lowercased and deduped. */
export function parseSearchTerms(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/^[\s\-*\d.)]+/, "").trim().toLowerCase();
		if (line && line.length < 60 && !out.includes(line)) out.push(line);
	}
	return out.slice(0, 20);
}

/** The answering request: excerpts in, cited markdown out, honest when the
 *  excerpts don't contain the answer. */
export function buildAskPrompt(
	question: string,
	hits: { path: string; heading: string; text: string }[]
): { system: string; user: string } {
	const system =
		"You answer questions about the user's own notes. Use ONLY the provided excerpts, never outside knowledge. " +
		"Cite as you go: after each claim, add a wiki-link to its source like [[path]] (use the path exactly as given, without the .md extension). " +
		"If the excerpts do not contain the answer, say so plainly and suggest what to search instead. Concise Markdown.";
	const user =
		hits
			.map((h) => `--- ${h.path.replace(/\.md$/, "")}${h.heading ? ` › ${h.heading}` : ""}\n${h.text}`)
			.join("\n\n") + `\n\nQuestion: ${question}`;
	return { system, user };
}

/* ---------------- the sidebar assistant: grounded multi-turn chat ---------------- */

/** System prompt for the sidebar assistant: a running conversation over the
 *  user's own notes, grounded in excerpts retrieved fresh for each turn. */
export const ASSISTANT_SYSTEM =
	"You are the user's personal assistant inside their Obsidian vault. Answer from the conversation and the provided note excerpts; never invent vault content. " +
	"Cite sources as wiki-links like [[path]] (use the path exactly as given, without the .md extension). " +
	"If the excerpts do not contain the answer, say so plainly and suggest what to search instead. Concise Markdown.";

export interface ChatTurn {
	role: "user" | "assistant";
	content: string;
}

/** Messages for one assistant reply: capped plain history, then the new
 *  question with its retrieved context attached. Context rides on the turn
 *  that needed it (not the history), so every answer is grounded in excerpts
 *  fetched for its own question and the transcript stays cheap. */
export function buildAssistantMessages(
	history: ChatTurn[],
	question: string,
	hits: { path: string; heading: string; text: string }[]
): { role: "user" | "assistant"; content: string }[] {
	const past = history.slice(-12).map((t) => ({ role: t.role, content: t.content }));
	const ctx = hits.map((h) => `--- ${h.path.replace(/\.md$/, "")}${h.heading ? ` › ${h.heading}` : ""}\n${h.text}`).join("\n\n");
	const user = ctx
		? `Excerpts from the vault:\n\n${ctx}\n\nQuestion: ${question}`
		: `Question: ${question}\n\n(No matching notes were found in the vault index.)`;
	return [...past, { role: "user", content: user }];
}

/** Parse the summarizer's reply: a first line "TITLE: …" then the summary
 *  body. Falls back to a generic title when the model skipped the line. */
export function parseChatSummary(text: string): { title: string; summary: string } {
	const m = text.match(/^\s*TITLE:\s*(.+?)\s*$/m);
	const title = (m?.[1] ?? "").replace(/["#]/g, "").trim() || "Assistant chat";
	const summary = m ? text.slice(text.indexOf(m[0]) + m[0].length).trim() : text.trim();
	return { title, summary };
}

/** A saved chat note: the summary on top, the full conversation folded below.
 *  type capture-chat (and no capture tag) keeps it out of meeting-only
 *  surfaces: digests, person hubs, and the Meetings base ignore it. */
export function buildChatNote(opts: { title: string; date: string; time: string; summary: string; turns: ChatTurn[] }): string {
	const fm = ["---", "type: capture-chat", `date: ${opts.date}`, `time: "${opts.time}"`, "generated: true", "---"].join("\n");
	const convo = opts.turns
		.map((t) => `> **${t.role === "user" ? "You" : "Assistant"}:** ${t.content.replace(/\n/g, "\n> ")}`)
		.join("\n>\n");
	return `${fm}\n# ${opts.title}\n\n${opts.summary.trim()}\n\n> [!quote]- Conversation\n${convo}\n`;
}

/* ---------------- documents: OCR extraction, classification, filing ---------------- */

/** What Claude extracts from a scanned document's OCR text. */
export interface DocFields {
	docType: string;
	vendor: string;
	date: string;
	amount: number | null;
	currency: string;
	due: string;
	summary: string;
	tags: string[];
}

const DOC_TYPES = new Set(["receipt", "bill", "invoice", "statement", "contract", "letter", "other"]);

/** Prompt for classifying a document and extracting its key fields. The reply
 *  contract is strict JSON so parseDocExtraction can stay mechanical. */
export function buildDocExtractionPrompt(text: string): { system: string; user: string } {
	const system =
		"You classify a scanned document from its OCR text and extract key fields. Reply with ONLY a JSON object, no code fences, no prose: " +
		'{"docType":"receipt|bill|invoice|statement|contract|letter|other","vendor":"","date":"YYYY-MM-DD","amount":0,"currency":"USD","due":"YYYY-MM-DD","summary":"one sentence","tags":["topic"]}. ' +
		"Use empty strings (or null for amount) when a field is unknown; never guess an amount. date is the document's own date. due applies only to bills and invoices. tags are 2-4 lowercase topics.";
	return { system, user: text.slice(0, 12000) };
}

/** Parse the extraction reply into clean fields; null when it isn't JSON.
 *  Tolerates code fences and prose around the object, validates dates and
 *  whitelists the type, so garbage never reaches a note's frontmatter. */
export function parseDocExtraction(reply: string): DocFields | null {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const iso = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : "");
	const type = str(j.docType).toLowerCase();
	const amount = typeof j.amount === "number" && isFinite(j.amount) ? j.amount : null;
	return {
		docType: DOC_TYPES.has(type) ? type : "other",
		vendor: str(j.vendor),
		date: iso(j.date),
		amount,
		currency: str(j.currency).toUpperCase().slice(0, 4),
		due: iso(j.due),
		summary: str(j.summary),
		tags: Array.isArray(j.tags) ? j.tags.map((t) => str(t).toLowerCase()).filter(Boolean).slice(0, 6) : [],
	};
}

/** Everything-unknown fields, so a failed extraction still files the document
 *  under Other instead of silently doing nothing. */
export function emptyDocFields(): DocFields {
	return { docType: "other", vendor: "", date: "", amount: null, currency: "", due: "", summary: "", tags: [] };
}

/** Filed name like "2026-07-11 Costco 128.53"; falls back to the original
 *  basename when too little was extracted. Filesystem-safe. */
export function docNiceName(f: DocFields, fallbackBase: string): string {
	const bits = [f.date || null, f.vendor || null, f.amount != null ? String(f.amount) : null].filter(Boolean) as string[];
	const name = bits.length >= 2 ? bits.join(" ") : fallbackBase;
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim() || fallbackBase;
}

/** Filing folder: <base>/<Type plural>/<year>, Undated when no date. */
export function docTargetFolder(base: string, f: DocFields): string {
	const type = f.docType !== "other" ? f.docType[0].toUpperCase() + f.docType.slice(1) + "s" : "Other";
	const year = /^\d{4}/.test(f.date) ? f.date.slice(0, 4) : "Undated";
	return `${base}/${type}/${year}`;
}

/** A user-defined filing rule: conditions on an extracted document, and what to
 *  do when they all match (route to a folder, add tags, flag for review). */
export interface DocRule {
	vendor?: string;
	docType?: string;
	amountOver?: number;
	textContains?: string;
	folder?: string;
	tags?: string;
	flag?: boolean;
}

/** Whether a rule's conditions all match the document. A rule with no
 *  conditions never matches, so an empty row can't become an accidental
 *  catch-all. */
export function matchDocRule(r: DocRule, f: DocFields, text: string): boolean {
	if (!(r.vendor || r.docType || r.amountOver != null || r.textContains)) return false;
	if (r.vendor && !f.vendor.toLowerCase().includes(r.vendor.toLowerCase())) return false;
	if (r.docType && f.docType !== r.docType) return false;
	if (r.amountOver != null && !(f.amount != null && f.amount >= r.amountOver)) return false;
	if (r.textContains && !`${f.summary}\n${text}`.toLowerCase().includes(r.textContains.toLowerCase())) return false;
	return true;
}

/** A rule folder template with {year}, {type}, {vendor} filled in. */
function expandDocFolder(tpl: string, f: DocFields): string {
	const type = f.docType !== "other" ? f.docType[0].toUpperCase() + f.docType.slice(1) + "s" : "Other";
	const year = /^\d{4}/.test(f.date) ? f.date.slice(0, 4) : "Undated";
	return tpl
		.replace(/\{year\}/gi, year)
		.replace(/\{type\}/gi, type)
		.replace(/\{vendor\}/gi, f.vendor || "Unknown")
		.replace(/^\/+|\/+$/g, "")
		.trim();
}

/** Resolve where a document files and how it is tagged: the first matching rule
 *  wins (its folder overrides the default, its tags add to the extracted ones,
 *  its flag marks the note for review); no match keeps the default scheme. */
export function resolveDocFiling(rules: DocRule[], f: DocFields, text: string, base: string): { folder: string; tags: string[]; flag: boolean; explicitFolder: boolean } {
	for (const r of rules) {
		if (!matchDocRule(r, f, text)) continue;
		const explicitFolder = !!r.folder?.trim();
		const folder = explicitFolder ? expandDocFolder(r.folder!, f) : docTargetFolder(base, f);
		const ruleTags = (r.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
		return { folder, tags: [...new Set([...f.tags, ...ruleTags])], flag: !!r.flag, explicitFolder };
	}
	return { folder: docTargetFolder(base, f), tags: f.tags, flag: false, explicitFolder: false };
}

/** The document note: extracted fields as properties (queryable from Bases),
 *  a one-line summary, the embedded original, and the OCR text folded below
 *  so search and the assistant can find the document by its contents. */
export function buildDocNote(f: DocFields, opts: { filePath: string; ocrText: string; today: string; review?: boolean }): string {
	const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
	const fm = [
		"---",
		"type: capture-doc",
		`doc-type: ${f.docType}`,
		...(f.vendor ? [`vendor: ${q(f.vendor)}`] : []),
		`date: ${f.date || opts.today}`,
		...(f.amount != null ? [`amount: ${f.amount}`] : []),
		...(f.currency ? [`currency: ${f.currency}`] : []),
		...(f.due ? [`due: ${f.due}`] : []),
		...(opts.review ? ["review: true"] : []),
		`source: ${q(`[[${opts.filePath}]]`)}`,
		...(f.tags.length ? ["tags:", ...f.tags.map((t) => `  - ${t}`)] : []),
		"---",
	].join("\n");
	const title = [f.vendor || null, f.docType !== "other" ? f.docType : "document"].filter(Boolean).join(" ");
	const details = [
		f.amount != null ? `- **Amount:** ${f.currency ? f.currency + " " : ""}${f.amount}` : null,
		f.date ? `- **Date:** ${f.date}` : null,
		f.due ? `- **Due:** ${f.due}` : null,
	].filter(Boolean) as string[];
	const ocr = f.summary || opts.ocrText.trim() ? opts.ocrText.trim().slice(0, 4000) : "";
	const parts = [fm, `# ${title[0]?.toUpperCase() + title.slice(1)}`];
	if (f.summary) parts.push(f.summary);
	if (details.length) parts.push(details.join("\n"));
	parts.push(`![[${opts.filePath}]]`);
	if (ocr) parts.push(`> [!quote]- Document text\n${ocr.split("\n").map((l) => `> ${l}`).join("\n")}`);
	return parts.join("\n\n") + "\n";
}

/* ---------------- next-level capture: stamps, names, series, live ---------------- */

/** "[1:02]" / "1:02" / "[1:01:01]" → seconds; null when it isn't a stamp. */
export function parseStamp(s: string): number | null {
	const m = s.match(/^\[?(\d+):(\d{2})(?::(\d{2}))?\]?$/);
	if (!m) return null;
	return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The distinct speaker labels, in order of first appearance. */
export function speakerLetters(utts: Utterance[]): string[] {
	return [...new Set(utts.map((u) => u.speaker))];
}

/** Ask the model who Speaker A/B/… actually are, from self-introductions and
 *  addressing patterns. Strict JSON out; null for anyone it can't ground. */
export function buildSpeakerNamePrompt(transcript: string, speakers: string[]): { system: string; user: string } {
	const system =
		"You identify meeting participants from a diarized transcript. " +
		"Reply with ONLY a JSON object mapping each speaker label to a real name grounded in the transcript " +
		'(self-introductions, people addressing each other), or null when the transcript never reveals it. Example: {"A": "Dana", "B": null}. ' +
		"Never guess from topic knowledge; a name must be evidenced in the words.";
	const user = `Speaker labels: ${speakers.join(", ")}\n\nTranscript (may be truncated):\n"""\n${transcript.slice(0, 12000)}\n"""`;
	return { system, user };
}

/** Tolerant parse of the naming reply: first JSON object, only known labels,
 *  only plausible short names. */
export function parseSpeakerNames(reply: string, speakers: string[]): Record<string, string> {
	const m = reply.match(/\{[\s\S]*?\}/);
	if (!m) return {};
	try {
		const obj = JSON.parse(m[0]) as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const sp of speakers) {
			const v = obj[sp];
			if (typeof v === "string" && v.trim() && v.trim().length <= 40) out[sp] = v.trim();
		}
		return out;
	} catch {
		return {};
	}
}

/** Rewrite "**Label [1:02]:**" / "**Label:**" speaker labels to new names
 *  the general form behind both first-pass naming and retroactive renames.
 *  All renames happen in ONE pass, simultaneously: swapping two people
 *  ({Alex: "Dana", Dana: "Alex"}) must never collapse them into one. */
export function renameSpeakerLabels(text: string, mapping: Record<string, string>): string {
	const entries = Object.entries(mapping).filter(([from, to]) => to.trim() && from !== to.trim());
	if (!entries.length) return text;
	const byFrom = new Map(entries.map(([from, to]) => [from, to.trim()]));
	const alternation = entries
		.map(([from]) => escapeReg(from))
		.sort((a, b) => b.length - a.length) // longest first: "Speaker 1A" before "Speaker 1"
		.join("|");
	const out = text.replace(new RegExp(`\\*\\*(${alternation})(?= \\[|:)`, "g"), (_m, from: string) => `**${byFrom.get(from) ?? from}`);
	// crosstalk labels hold voices INSIDE the bold label, where the anchored
	// pass above cannot see them: rename each listed voice individually so
	// "Crosstalk (Speaker A + Speaker B)" follows A's new name too
	return out.replace(/\*\*Crosstalk \(([^\n]+?)\)(?= \[|:)/g, (m, inner: string) => {
		const voices = inner.split(" + ").map((v) => byFrom.get(v.trim()) ?? v.trim());
		return `**Crosstalk (${voices.join(" + ")})`;
	});
}

/** Rewrite "**Speaker A [1:02]:**" / "**Speaker A:**" labels to real names. */
export function applySpeakerNames(transcript: string, names: Record<string, string>): string {
	const mapping: Record<string, string> = {};
	for (const [sp, name] of Object.entries(names)) mapping[`Speaker ${sp}`] = name;
	return renameSpeakerLabels(transcript, mapping);
}

/** A learned transcript correction: replace a misheard word or name with the
 *  right one everywhere it appears. */
export interface Correction {
	from: string;
	to: string;
}

/** A whole-word (phrase-aware, punctuation-safe, Unicode-aware) matcher for a
 *  term, so "Shaker" hits "Shaker." and "Shaker rules" but never "Shakerville".
 *  Case-sensitive on purpose, so a rule for a name never rewrites a common word
 *  that only differs in case (e.g. an "IT" rule must not touch every "it"). */
function correctionRe(term: string): RegExp {
	// The leading boundary is a captured character rather than a lookbehind,
	// which older mobile WebViews reject. Group 1 is that character (empty at
	// the start of the string) and group 2 is the term, so callers must offset
	// by group 1 and re-emit it when replacing.
	return new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeReg(term)})(?![\\p{L}\\p{N}_])`, "gu");
}

/** The character ranges of every whole-word occurrence of `term` in `text`,
 *  so a caller can rewrite them in place (an open editor) instead of the whole
 *  document, which keeps scroll position and callout fold state. */
export function correctionRanges(text: string, term: string): { start: number; end: number }[] {
	const t = term.trim();
	if (!t) return [];
	const re = correctionRe(t);
	const out: { start: number; end: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const start = m.index + m[1].length; // skip the captured boundary char
		out.push({ start, end: start + m[2].length });
	}
	return out;
}

/** How many whole-word times `term` appears in `text`. */
export function countTerm(text: string, term: string): number {
	return correctionRanges(text, term).length;
}

/** A stable, theme-neutral color for a speaker name, so each speaker reads in
 *  their own color in the transcript block (like Otter). */
export const SPEAKER_PALETTE = ["#7c6cf5", "#e5534b", "#2da44e", "#bf8700", "#1f6feb", "#cf469b", "#8957e5", "#0aa2c0"];
const SPEAKER_COLORS = SPEAKER_PALETTE;
export function speakerColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
	return SPEAKER_COLORS[h % SPEAKER_COLORS.length];
}

/** The `> [!transcript]- Transcript` header of a transcript callout, parsed from
 *  one raw source line so the Live Preview layer can style it while keeping it
 *  editable. `hideTo` is the offset just past `> [!transcript]- `. */
export interface TranscriptHeaderLine {
	hideTo: number;
	title: string;
}
export function parseTranscriptHeaderLine(line: string): TranscriptHeaderLine | null {
	const m = /^(>\s?)(\[!transcript\][+-]?)(\s*)(.*)$/i.exec(line);
	if (!m) return null;
	return { hideTo: m[1].length + m[2].length + m[3].length, title: m[4] || "Transcript" };
}

/** A `> **Name [m:ss]:** text` speaker line, parsed from one raw source line.
 *  Offsets are relative to the start of the line: `prefixLen` covers the `> `
 *  blockquote marker; name/stamp spans locate the pieces to color and badge.
 *  The stamp is optional, since imported transcripts can read `> **Name:**`. */
export interface TranscriptSpeakerLine {
	prefixLen: number;
	name: string;
	nameFrom: number;
	nameTo: number;
	stampFrom?: number;
	stampTo?: number;
	/** For a "Crosstalk (Dana + Speaker B)" label: the voices inside it,
	 *  dominant first. Ordinary speaker lines leave this unset. */
	voices?: string[];
}
export function parseTranscriptSpeakerLine(line: string): TranscriptSpeakerLine | null {
	// the `> ` blockquote marker is optional: plain transcripts have none, while
	// legacy callout transcripts still carry it until they are migrated
	const withStamp = /^(>[ \t]?)?\*\*(.+?) (\[\d{1,2}:\d{2}(?::\d{2})?\]):\*\*/.exec(line);
	if (withStamp) {
		const prefixLen = (withStamp[1] ?? "").length;
		const nameFrom = prefixLen + 2; // skip the `**`
		const nameTo = nameFrom + withStamp[2].length;
		const stampFrom = nameTo + 1; // skip the space before the stamp
		const voices = parseCrosstalkLabel(withStamp[2]);
		return { prefixLen, name: withStamp[2], nameFrom, nameTo, stampFrom, stampTo: stampFrom + withStamp[3].length, ...(voices ? { voices } : {}) };
	}
	const noStamp = /^(>[ \t]?)?\*\*(.+?):\*\*/.exec(line);
	if (noStamp) {
		const prefixLen = (noStamp[1] ?? "").length;
		const nameFrom = prefixLen + 2;
		const voices = parseCrosstalkLabel(noStamp[2]);
		return { prefixLen, name: noStamp[2], nameFrom, nameTo: nameFrom + noStamp[2].length, ...(voices ? { voices } : {}) };
	}
	return null;
}

/** Convert a note's `> [!transcript]` callout back to plain speaker lines, so
 *  the transcript is always-visible, always-editable Markdown (no callout card
 *  to swap in and out of in Live Preview). A note with no transcript callout is
 *  returned unchanged. The `## Transcript` heading and the lines themselves are
 *  preserved exactly, only the callout wrapper and its `> ` quoting are removed. */
export function stripTranscriptCallout(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let changed = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^>\s?\[!transcript\]/i.test(lines[i])) {
			changed = true;
			// drop the callout title line, then unquote the contiguous `>` block
			for (i++; i < lines.length && lines[i].startsWith(">"); i++) out.push(lines[i].replace(/^>[ \t]?/, ""));
			i--; // the for-loop's i++ will step past the last consumed line
		} else {
			out.push(lines[i]);
		}
	}
	return changed ? out.join("\n") : md;
}

/** Apply saved corrections to a transcript: each rule replaces every whole-word
 *  occurrence of `from` with `to`. Longest `from` first, so a full name wins
 *  over a word it contains ("Deverakonda Rajasekhar" before "Rajasekhar").
 *  Empty and identity rules are skipped. */
export function applyCorrections(text: string, corrections: Correction[]): string {
	const rules = corrections
		.map((c) => ({ from: c.from.trim(), to: c.to }))
		.filter((c) => c.from && c.from !== c.to.trim())
		.sort((a, b) => b.from.length - a.from.length);
	let out = text;
	for (const { from, to } of rules) out = out.replace(correctionRe(from), (_m, pre: string) => pre + to);
	return out;
}

/** Seconds → clock time for the audio player: "8:05", "1:08:32". */
export function fmtClock(secs: number): string {
	if (!Number.isFinite(secs) || secs < 0) secs = 0;
	const s = Math.floor(secs % 60);
	const m = Math.floor((secs / 60) % 60);
	const h = Math.floor(secs / 3600);
	return (h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
}

/** Estimate the time of a word inside a turn by its position in the turn's
 *  text: the turn spans `start`→`next` seconds, and the word sits `offset` chars
 *  into `length` chars of spoken text. Approximate, we store one stamp per turn,
 *  not per word, but close enough to play from roughly the right place. */
export function interpolatedTime(start: number, next: number, offset: number, length: number): number {
	if (!(next > start) || length <= 0) return start;
	const frac = Math.min(1, Math.max(0, offset / length));
	return start + frac * (next - start);
}

/** Index of the turn playing at time `t`: the last turn whose start is at or
 *  before `t`. Times must be ascending. Returns -1 before the first turn. */
export function currentTurn(times: number[], t: number): number {
	let idx = -1;
	for (let i = 0; i < times.length; i++) {
		if (times[i] <= t) idx = i;
		else break;
	}
	return idx;
}

/** The distinct speaker labels of a rendered note's transcript, in order of
 *  appearance. Strictly scoped to the "## Transcript" section: bold text in
 *  the extracted body (including the "**Speakers:**" line) never counts, and
 *  a note saved without its transcript has nothing to rename. A crosstalk
 *  label contributes its individual voices, not the compound: those are the
 *  real speakers a rename dialog should offer. */
export function transcriptSpeakers(md: string): string[] {
	const at = md.indexOf("## Transcript");
	if (at < 0) return [];
	const scope = md.slice(at);
	const out: string[] = [];
	const add = (label: string) => {
		if (label && !out.includes(label)) out.push(label);
	};
	const re = /\*\*([^*\n[\]]+?)(?: \[\d+:\d{2}(?::\d{2})?\])?:\*\*/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(scope))) {
		const label = m[1].trim();
		const voices = parseCrosstalkLabel(label);
		if (voices) voices.forEach(add);
		else add(label);
	}
	return out;
}

/** Share of the talking per speaker, with a first-words preview for "who is
 *  this?" recognition. Uses real segment durations when every utterance has
 *  them; otherwise falls back to text length as the weight. */
export function talkShares(utts: Utterance[]): { speaker: string; share: number; first: string }[] {
	const timed = utts.length > 0 && utts.every((u) => u.start != null && u.end != null);
	const weight = (u: Utterance) => (timed ? Math.max(0, (u.end ?? 0) - (u.start ?? 0)) : Math.max(1, u.text.trim().length));
	const by = new Map<string, { w: number; first: string }>();
	for (const u of utts) {
		let e = by.get(u.speaker);
		if (!e) by.set(u.speaker, (e = { w: 0, first: u.text.trim().slice(0, 90) }));
		e.w += weight(u);
	}
	const total = [...by.values()].reduce((n, e) => n + e.w, 0) || 1;
	return [...by.entries()]
		.map(([speaker, e]) => ({ speaker, share: e.w / total, first: e.first }))
		.sort((a, b) => b.share - a.share);
}

/** "Dana (57%), Alex (26%), and 9 more under 1%", null when there's only
 *  one voice (a memo needs no share line). */
export function formatSpeakersLine(
	shares: { speaker: string; share: number }[],
	nameFor: (label: string) => string
): string | null {
	if (shares.length < 2) return null;
	const main = shares.filter((s) => s.share >= 0.01);
	const rest = shares.length - main.length;
	const bits = main.map((s) => `${nameFor(s.speaker)} (${Math.max(1, Math.round(s.share * 100))}%)`);
	return bits.join(", ") + (rest > 0 ? `, and ${rest} more under 1%` : "");
}

/** One turn's identity inside a note's transcript: the label as written, the
 *  stamp as written (e.g. "[1:02]"), and the turn's first spoken words to break
 *  ties when rapid back-and-forth lands two turns in the same second. Enough to
 *  find that ONE line again without a line number, which chunked Reading-view
 *  rendering never has. */
export interface TurnRef {
	name: string;
	stamp: string | null;
	textHint?: string;
}

/** The [from, to) line range of the "## Transcript" section, heading excluded
 *  the same walk the Live Preview styling does. */
function transcriptLineRange(lines: string[]): { from: number; to: number } | null {
	for (let i = 0; i < lines.length; i++) {
		if (!/^##\s+Transcript\s*$/.test(lines[i])) continue;
		let to = i + 1;
		while (to < lines.length && !/^#{1,6}\s/.test(lines[to])) to++;
		return { from: i + 1, to };
	}
	return null;
}

/** The spoken text of a parsed speaker line: everything past the `:** ` label. */
function turnText(line: string, sp: TranscriptSpeakerLine): string {
	const labelEnd = sp.stampTo ?? sp.nameTo;
	const after = /^:\*\*[ \t]?/.exec(line.slice(labelEnd));
	return line.slice(labelEnd + (after ? after[0].length : 0)).trim();
}

/** Read a note's transcript section back into utterances: the inverse of
 *  formatUtterances, for notes that already exist. Starts come from the stamps;
 *  each turn ends where the next stamped turn begins (the last one gets a short
 *  tail, the same guess word-clicks use); continuation lines fold into their
 *  turn. Unstamped lines yield unstamped utterances, and talk shares then fall
 *  back to text length exactly as they do for live captures. */
export function transcriptToUtterances(md: string): Utterance[] {
	const lines = md.split("\n");
	const range = transcriptLineRange(lines);
	if (!range) return [];
	const out: Utterance[] = [];
	for (let i = range.from; i < range.to; i++) {
		const sp = parseTranscriptSpeakerLine(lines[i]);
		if (sp) {
			const stamp = sp.stampFrom != null && sp.stampTo != null ? lines[i].slice(sp.stampFrom, sp.stampTo) : null;
			const secs = stamp ? parseStamp(stamp.replace(/[[\]]/g, "")) : null;
			// a crosstalk label round-trips: the first listed voice is the
			// dominant speaker (who talk shares should credit), the rest ride
			// along so re-rendering keeps the label
			const speaker = sp.voices ? sp.voices[0] : sp.name;
			out.push({
				speaker,
				text: turnText(lines[i], sp),
				...(secs != null ? { start: secs * 1000 } : {}),
				...(sp.voices ? { crosstalk: sp.voices.slice(1) } : {}),
			});
			continue;
		}
		const cont = lines[i].replace(/^>[ \t]?/, "").trim();
		const last = out[out.length - 1];
		if (last && cont && !/^!\[\[/.test(cont) && !/^\*\*Speakers:\*\*/.test(cont)) last.text = `${last.text} ${cont}`.trim();
	}
	for (let i = 0; i < out.length; i++) {
		if (out[i].start == null) continue;
		const next = out.slice(i + 1).find((u) => u.start != null);
		out[i].end = next && next.start! > out[i].start! ? next.start : out[i].start! + 8000;
	}
	return out;
}

/** Rewrite ONE turn's label to a different name, the per-line fix for a
 *  diarizer that glued two people under one voice, where renaming the label
 *  everywhere would just paint the wrong name onto both. The turn is matched by
 *  label + stamp, with the first words breaking a same-second tie; only that
 *  line's label changes. No match returns the text unchanged. */
export function reassignTranscriptTurn(md: string, ref: TurnRef, newName: string): { md: string; changed: boolean } {
	const to = newName.trim();
	if (!to || to === ref.name) return { md, changed: false };
	const lines = md.split("\n");
	const range = transcriptLineRange(lines);
	if (!range) return { md, changed: false };
	const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
	const hint = ref.textHint ? norm(ref.textHint).slice(0, 40) : "";
	const candidates: number[] = [];
	for (let i = range.from; i < range.to; i++) {
		const sp = parseTranscriptSpeakerLine(lines[i]);
		if (!sp || sp.name !== ref.name) continue;
		const stamp = sp.stampFrom != null && sp.stampTo != null ? lines[i].slice(sp.stampFrom, sp.stampTo) : null;
		if ((ref.stamp ?? null) !== stamp) continue;
		candidates.push(i);
	}
	let at: number | undefined = candidates[0];
	if (candidates.length > 1 && hint) {
		const scored = candidates.find((i) => {
			const t = norm(turnText(lines[i], parseTranscriptSpeakerLine(lines[i])!)).slice(0, 40);
			return t.startsWith(hint) || hint.startsWith(t);
		});
		if (scored != null) at = scored;
	}
	if (at == null) return { md, changed: false };
	const sp = parseTranscriptSpeakerLine(lines[at])!;
	lines[at] = lines[at].slice(0, sp.nameFrom) + to + lines[at].slice(sp.nameTo);
	return { md: lines.join("\n"), changed: true };
}

/** Recompute the "**Speakers:** …" line from the transcript as it reads NOW.
 *  After a turn moves to another speaker the shares shift, and a stale line
 *  would keep asserting the old split. A note without the line (or without a
 *  transcript) is returned unchanged; shares derive from the stamps, so they
 *  can drift a point from the provider-timed originals. */
export function rebuildSpeakersLine(md: string): string {
	if (!/^\*\*Speakers:\*\* /m.test(md)) return md;
	const utts = transcriptToUtterances(md);
	if (!utts.length) return md;
	const line = formatSpeakersLine(talkShares(utts), (l) => l);
	if (!line) return md;
	return md.replace(/^\*\*Speakers:\*\* .*$/m, `**Speakers:** ${line}`);
}

/** Up to `per` listenable clips per speaker, longest first so a "who is this?"
 *  clip is a sentence rather than an "mm-hmm", then re-sorted into meeting
 *  order. Times are global (multi-part offsets already applied); utterances
 *  without stamps yield nothing. */
export function pickSpeakerSamples(utts: Utterance[], per = 3): Record<string, { startMs: number; durMs: number }[]> {
	const by = new Map<string, { startMs: number; durMs: number }[]>();
	for (const u of utts) {
		if (u.start == null) continue;
		let arr = by.get(u.speaker);
		if (!arr) by.set(u.speaker, (arr = []));
		arr.push({ startMs: u.start, durMs: Math.max(0, (u.end ?? u.start + 4000) - u.start) });
	}
	const out: Record<string, { startMs: number; durMs: number }[]> = {};
	for (const [sp, arr] of by) {
		out[sp] = arr
			.sort((a, b) => b.durMs - a.durMs)
			.slice(0, per)
			.sort((a, b) => a.startMs - b.startMs);
	}
	return out;
}

/** Starter questions for the per-meeting chat: universal ones, "was I
 *  mentioned" when the user told us their name, and per-attendee commitments. */
export function meetingAskChips(attendees: string[], yourName: string): { label: string; question: string }[] {
	const out = [
		{ label: "What decisions were made?", question: "What decisions were made in this meeting?" },
		{ label: "Questions & answers", question: "What questions came up in this meeting, and what answers did they get?" },
	];
	const you = yourName.trim();
	if (you) out.push({ label: "Was I mentioned?", question: `Was ${you} mentioned in this meeting? Include the relevant [m:ss] stamps.` });
	for (const a of attendees.slice(0, 3)) {
		out.push({ label: `What did ${a} commit to?`, question: `What did ${a} commit to in this meeting?` });
	}
	return out;
}

/** The per-meeting chat request: the note rides in the FIRST user turn only;
 *  follow-ups stay lean and the model keeps the whole thread. */
export function buildMeetingChat(
	noteMd: string,
	turns: { role: "user" | "assistant"; content: string }[]
): { system: string; messages: { role: "user" | "assistant"; content: string }[] } {
	const system =
		"You answer questions about ONE meeting, whose full note (extracted sections plus transcript) is provided. " +
		"Use ONLY the note, say so plainly when it doesn't contain the answer. " +
		"When you reference a moment that carries a [m:ss] stamp in the note, include the stamp so it can be clicked. Concise Markdown.";
	const messages = turns.map((t, i) =>
		i === 0 && t.role === "user"
			? { role: t.role, content: `Meeting note:\n"""\n${noteMd.slice(0, 150000)}\n"""\n\nQuestion: ${t.content}` }
			: t
	);
	return { system, messages };
}

/** Unchecked '- [ ]' lines of a note, verbatim (for series carry-over). */
export function extractOpenTasks(md: string): string[] {
	return md
		.split("\n")
		.filter((l) => /^\s*[-*+]\s+\[ \]\s+\S/.test(l))
		.map((l) => l.trim());
}

/** Carried-over section body: open items referenced back to their meeting.
 *  Deliberately NOT checkboxes, the live task stays in the previous note, so
 *  todo dashboards never count the same task twice. */
export function buildCarryOver(tasks: string[], fromPath: string): string | null {
	if (!tasks.length) return null;
	const from = fromPath.replace(/\.md$/, "");
	return tasks.map((t) => `- ⏭ ${t.replace(/^[-*+]\s+\[ \]\s+/, "")} *(open from [[${from}]])*`).join("\n");
}

/** A recurring meeting's identity: the title with dates, counters, and
 *  recording stamps stripped. "" means the name carries no reusable series
 *  (e.g. raw capture-2026-07-10 recordings). */
export function seriesKey(basename: string): string {
	return basename
		.toLowerCase()
		.replace(/capture-[\d-]+/g, " ")
		.replace(/\d{4}-\d{2}-\d{2}/g, " ")
		.replace(/\d{8}/g, " ")
		.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/g, " ")
		.replace(/[0-9]+/g, " ")
		.replace(/[^a-z]+/g, " ")
		.trim()
		.replace(/\s+/g, "-");
}

/** Stitch rotated recording parts into one utterance stream, each part's
 *  segment times shifted by where that part began. Diarization labels restart
 *  per file and are NOT the same people across parts, so multi-part merges
 *  relabel to "1A", "2A", …; the naming dialog then maps each real person
 *  (attendees dedupe by name, so one person across parts is one attendee). */
export function mergeUtterances(parts: { utterances: Utterance[]; offsetMs: number }[]): Utterance[] {
	const out: Utterance[] = [];
	const multi = parts.length > 1;
	for (let i = 0; i < parts.length; i++) {
		for (const u of parts[i].utterances) {
			out.push({
				...u,
				speaker: multi ? `${i + 1}${u.speaker}` : u.speaker,
				start: (u.start ?? 0) + parts[i].offsetMs,
				// end shifts with start, or later parts read as zero-length turns
				// (talk shares) and the last part's end under-counts audio minutes
				end: u.end != null ? u.end + parts[i].offsetMs : undefined,
			});
		}
	}
	return out;
}

/** Which rotated part a stamp lands in, given each part's start offset.
 *  Returns the part index and the seconds into that part's own audio. */
export function partForStamp(offsetsMs: number[], secs: number): { index: number; secondsInPart: number } {
	let index = 0;
	for (let i = 0; i < offsetsMs.length; i++) {
		if (secs * 1000 >= offsetsMs[i]) index = i;
	}
	return { index, secondsInPart: Math.max(0, secs - (offsetsMs[index] ?? 0) / 1000) };
}

/* ---------------- frames grabbed out of a video capture ---------------- */

/** Every [m:ss] stamp on one line, with where it sits, so a click can be
 *  resolved to the moment it landed on. */
function lineStamps(text: string): { secs: number; from: number; to: number }[] {
	const re = /\[(\d+:\d{2}(?::\d{2})?)\]/g;
	const out: { secs: number; from: number; to: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		const secs = parseStamp(m[1]);
		if (secs != null) out.push({ secs, from: m.index, to: m.index + m[0].length });
	}
	return out;
}

/** The moment a cursor on this line is asking about, in seconds.
 *
 *  A stamp the cursor sits inside wins, then the nearest one on the line, so
 *  clicking anywhere in a transcript turn or a Moments bullet resolves the
 *  moment that line is about rather than demanding a hit on six characters.
 *  With no column the first stamp answers. Null when the line carries none. */
export function stampSecsOnLine(text: string, ch?: number): number | null {
	const hits = lineStamps(text);
	if (!hits.length) return null;
	if (ch == null) return hits[0].secs;
	const inside = hits.find((h) => ch >= h.from && ch <= h.to);
	if (inside) return inside.secs;
	const gap = (h: { from: number; to: number }) => (ch < h.from ? h.from - ch : ch - h.to);
	return hits.reduce((best, h) => (gap(h) < gap(best) ? h : best), hits[0]).secs;
}

/** The filename a grabbed frame lands under: the note's name plus the moment it
 *  came from, so frames from several meetings still read in one folder. A colon
 *  is not a filename character, so 1:02:03 becomes 1-02-03. */
export function frameFileName(noteBase: string, secs: number): string {
	const stamp = fmtTime(Math.max(0, Math.round(secs)) * 1000).replace(/:/g, "-");
	const base = (noteBase || "frame").replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
	return `${base || "frame"} ${stamp}.webp`;
}

/** How a grabbed frame is written into a note: its stamp first (clickable, so
 *  the frame doubles as a jump back to that moment), then the embed.
 *
 *  The stamp leading is not cosmetic. A line STARTING with an embed is how the
 *  note's trailing recording players are recognized when a re-extract rewrites
 *  the body, so a frame that led with `![[` would be read as the end of the
 *  extracted sections and everything below it would survive as the tail. */
export function frameEmbedLine(secs: number, link: string): string {
	return `**[${fmtTime(Math.max(0, Math.round(secs)) * 1000)}]** ![[${link}]]`;
}

/** One frame lifted out of a video capture: where it came from, where it landed
 *  in the vault, and what the image reader made of it (empty when unread). */
export interface Frame {
	ms: number;
	link: string;
	text: string;
}

/** One sampled instant of a video, and how different it looked from the last
 *  frame that was kept. `diff` is 0 to 100. */
export interface FrameSample {
	ms: number;
	diff: number;
}

/** Which sampled instants are worth keeping as screens.
 *
 *  A recorded meeting is mostly a still shared screen, so the frames worth
 *  keeping are the ones where that screen CHANGED: a slide advanced, a new page
 *  was opened, someone switched windows. Everything else is the same picture
 *  again. A sample therefore only survives if it differs from the last KEPT
 *  frame by more than `threshold` (the caller measures against that frame, not
 *  the previous sample, so a slow fade does not accumulate into a false hit).
 *
 *  When more survive than `max`, the biggest changes win rather than the first
 *  N: an hour of screen-sharing should yield the twelve most different screens,
 *  not the twelve from its opening minutes. Ties break on time so the result is
 *  deterministic, and the kept set is always returned in time order. */
export function pickSceneFrames(samples: FrameSample[], threshold: number, max: number): number[] {
	if (max <= 0) return [];
	const over = samples.filter((s) => s.diff > threshold);
	const ranked = [...over].sort((a, b) => (b.diff === a.diff ? a.ms - b.ms : b.diff - a.diff));
	return ranked
		.slice(0, max)
		.map((s) => s.ms)
		.sort((a, b) => a - b);
}

/** Fold the moments someone marked during the recording into the times to grab.
 *
 *  A mark is a person saying "this bit matters", which is better evidence than
 *  any pixel measurement: the screen may not have changed at all when the number
 *  everyone had been waiting for was finally read out. Marks are therefore added
 *  whether or not the scan found a change there, and they are not subject to the
 *  cap, which exists to stop an automatic measure running away.
 *
 *  A mark within `nearMs` of a frame already being kept is dropped rather than
 *  duplicated: the same screen twice, seconds apart, is not two screens. */
export function withMomentFrames(picked: number[], moments: Moment[], nearMs = 5000): number[] {
	const out = [...picked];
	for (const m of moments) {
		const ms = Math.max(0, Math.round(m.ms));
		if (out.some((p) => Math.abs(p - ms) <= nearMs)) continue;
		out.push(ms);
	}
	return out.sort((a, b) => a - b);
}

/** The "## Screens" body: every frame with its stamp, and the reader's text
 *  under it as a quote when there is any.
 *
 *  Each line leads with its stamp for the same reason a single grabbed frame
 *  does (a line starting with an embed reads as the note's trailing players),
 *  and the stamp makes every screen a jump back to the moment it came from. */
export function formatScreens(frames: Frame[]): string | null {
	if (!frames.length) return null;
	return frames
		.map((f) => {
			const line = frameEmbedLine(f.ms / 1000, f.link);
			const text = f.text.trim();
			return text
				? `${line}\n${text
						.split("\n")
						.map((l) => `> ${l}`)
						.join("\n")}`
				: line;
		})
		.join("\n\n");
}

/** How far a screen may sit from a stamped item and still be taken as showing
 *  what that item is about: fifteen seconds either way.
 *
 *  A shared screen is up for as long as it is being discussed, so the frame that
 *  illustrates a decision is rarely at the exact second the decision was voiced.
 *  But points come thick and fast in a real meeting, and a window wide enough to
 *  reach the screen behind the previous point will claim it: half a minute proved
 *  loose enough to caption a decision with the slide the last one was about. */
const ILLUSTRATE_WINDOW_MS = 15_000;

/** Place each frame under the stamped item it illustrates.
 *
 *  This is the layout a meeting recap wants: the point, then the screen that was
 *  up when it was made, rather than a gallery at the bottom that the reader has
 *  to match back to the words themselves. Items are stamped only when extraction
 *  was asked for stamps, so a note without them simply keeps every frame for the
 *  Screens section.
 *
 *  One frame per item, and one item per frame: the nearest pairing wins, so two
 *  bullets a few seconds apart cannot both claim the same screen and a single
 *  bullet cannot collect five. Whatever is left over is returned as `unused` for
 *  the caller to render as Screens, so no frame is ever silently dropped. */
export function illustrateBody(body: string, frames: Frame[], windowMs = ILLUSTRATE_WINDOW_MS): { body: string; unused: Frame[] } {
	if (!body.trim() || !frames.length) return { body, unused: [...frames] };
	const lines = body.split("\n");
	// candidate items: a bullet, a checklist line, or a paragraph, that carries a
	// stamp. Headings and table rows are not items, and a line that is already an
	// embed is a frame someone placed before.
	const items: { line: number; ms: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i];
		if (/^#{1,6}\s/.test(t) || /^\s*\|/.test(t) || /^\s*>/.test(t) || /!\[\[/.test(t)) continue;
		if (!t.trim()) continue;
		const secs = stampSecsOnLine(t);
		if (secs != null) items.push({ line: i, ms: secs * 1000 });
	}
	if (!items.length) return { body, unused: [...frames] };
	// every (frame, item) pairing inside the window, nearest first: a greedy pass
	// over that order gives each frame its best still-free item, which is what
	// "the screen for this point" means when several points share a minute
	const pairs: { frame: number; item: number; gap: number }[] = [];
	frames.forEach((f, fi) =>
		items.forEach((it, ii) => {
			const gap = Math.abs(it.ms - f.ms);
			if (gap <= windowMs) pairs.push({ frame: fi, item: ii, gap });
		})
	);
	pairs.sort((a, b) => (a.gap === b.gap ? a.frame - b.frame || a.item - b.item : a.gap - b.gap));
	const takenFrame = new Set<number>();
	const takenItem = new Set<number>();
	const placed = new Map<number, Frame>();
	for (const p of pairs) {
		if (takenFrame.has(p.frame) || takenItem.has(p.item)) continue;
		takenFrame.add(p.frame);
		takenItem.add(p.item);
		placed.set(items[p.item].line, frames[p.frame]);
	}
	if (!placed.size) return { body, unused: [...frames] };
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		out.push(lines[i]);
		const f = placed.get(i);
		if (!f) continue;
		// indented under a bullet so it reads as belonging to that item, and
		// stamp-first for the same reason every frame line is
		const indent = /^\s*[-*+]\s|^\s*\d+\.\s/.test(lines[i]) ? "\t" : "";
		out.push(`${indent}${frameEmbedLine(f.ms / 1000, f.link)}`);
		if (f.text.trim())
			out.push(
				...f.text
					.trim()
					.split("\n")
					.map((l) => `${indent}> ${l}`)
			);
	}
	return { body: out.join("\n"), unused: frames.filter((_, i) => !takenFrame.has(i)) };
}

/** Put a "## Screens" section into a note that already exists, replacing one
 *  that is already there.
 *
 *  Lands in the same place `assembleNote` would put it: after the extraction,
 *  before Moments, the captured text, and the trailing players. Re-running the
 *  scan therefore refreshes the section instead of stacking a second copy, and
 *  a note whose extraction has not been written yet still gets it in the right
 *  place. Returns the note unchanged when there are no frames and no section. */
export function withScreensSection(md: string, body: string | null): string {
	const lines = md.split("\n");
	const at = lines.findIndex((l) => /^## Screens\b/.test(l));
	if (at >= 0) {
		let end = at + 1;
		while (end < lines.length && !/^## /.test(lines[end]) && !/^!\[\[/.test(lines[end])) end++;
		const kept = [...lines.slice(0, at), ...(body ? [`## Screens`, "", body, ""] : []), ...lines.slice(end)];
		return kept.join("\n").replace(/\n{3,}/g, "\n\n");
	}
	if (!body) return md;
	// before Moments, the captured text, or the players at the end of the note,
	// whichever comes first; a note with none of those takes it at the bottom
	const before = lines.findIndex((l) => /^## (Moments|Screens)\b/.test(l) || new RegExp(`^## (${SOURCE_HEADINGS.join("|")})\\b`).test(l) || /^!\[\[/.test(l));
	const section = [`## Screens`, "", body];
	const out = before >= 0 ? [...lines.slice(0, before), ...section, "", ...lines.slice(before)] : [...lines, "", ...section, ""];
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** A timestamped bookmark dropped mid-recording ("mark that"). */
export interface Moment {
	ms: number;
	label: string;
}

export function formatMoments(moments: Moment[]): string | null {
	if (!moments.length) return null;
	return moments.map((m) => `- [${fmtTime(m.ms)}] ${m.label || "Mark"}`).join("\n");
}

/** The marks a finished note carries, read back out of its Moments section.
 *
 *  `pa-marks` only exists while a recording is being processed and is deleted
 *  afterwards, so the rendered section is the durable record: this is what lets a
 *  scan grab the moments of a meeting recorded long before screens existed. */
export function momentsFromNote(md: string): Moment[] {
	const section = sectionText(md, "Moments");
	if (!section) return [];
	const out: Moment[] = [];
	for (const line of section.split("\n")) {
		const m = /^\s*[-*+]\s*\[(\d+:\d{2}(?::\d{2})?)\]\s*(.*)$/.exec(line);
		if (!m) continue;
		const secs = parseStamp(m[1]);
		if (secs == null) continue;
		out.push({ ms: secs * 1000, label: m[2].trim() });
	}
	return out;
}

/* ---------------- extraction evals ---------------- */

/** One extraction section as found in a note body: how many items it carries
 *  (bullets, checklist lines, or table rows) and its raw size. */
export interface EvalSectionStat {
	items: number;
	chars: number;
	body: string;
}

/** The extraction sections of a body, keyed by their "## " label. Only the
 *  known extraction headings count, so Transcript, Moments, and any custom
 *  prose the user added by hand stay out of the comparison. */
export function evalSections(body: string): Map<string, EvalSectionStat> {
	const known = new Set<string>(EXTRACTIONS.map((e) => e.label));
	const out = new Map<string, EvalSectionStat>();
	const re = /^##[ \t]+(.+)$/gm;
	let m: RegExpExecArray | null;
	const hits: { label: string; at: number; end: number }[] = [];
	while ((m = re.exec(body))) hits.push({ label: m[1].trim(), at: m.index, end: m.index + m[0].length });
	for (let i = 0; i < hits.length; i++) {
		if (!known.has(hits[i].label)) continue;
		const chunk = body.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].at : body.length).trim();
		const lines = chunk.split("\n").map((l) => l.trim());
		const bullets = lines.filter((l) => /^-[ \t]/.test(l)).length;
		const tableRows = Math.max(0, lines.filter((l) => l.startsWith("|")).length - 2); // header + separator
		out.set(hits[i].label, { items: bullets + tableRows, chars: chunk.length, body: chunk });
	}
	return out;
}

/** Owners named in an Action items section, whether it is a task checklist
 *  (via taskOwner) or a | Task | Owner | Due | table (second cell). */
export function actionOwners(section: string): Set<string> {
	const out = new Set<string>();
	for (const line of section.split("\n").map((l) => l.trim())) {
		if (/^- \[.\]/.test(line)) {
			const o = taskOwner(line);
			if (o && o !== "Unassigned") out.add(o.toLowerCase());
		} else if (line.startsWith("|") && !/^\|[-\s|]+\|$/.test(line)) {
			const cells = line.split("|").map((c) => c.trim());
			const owner = cells[2];
			if (owner && owner !== "Owner" && owner !== "-") out.add(owner.toLowerCase());
		}
	}
	return out;
}

const jaccard = (a: Set<string>, b: Set<string>): number | null => {
	if (!a.size && !b.size) return null;
	let both = 0;
	for (const x of a) if (b.has(x)) both++;
	return both / (a.size + b.size - both);
};

export interface EvalScore {
	/** Per-label item counts, golden vs fresh, for every label either has. */
	sections: { label: string; goldenItems: number; freshItems: number }[];
	missing: string[];
	extra: string[];
	ownerOverlap: number | null;
	keywordOverlap: number | null;
	lengthRatio: number;
}

/** Mechanical comparison of a fresh extraction against a note's golden
 *  sections. Counts and overlaps, not judgment: the report shows the fresh
 *  text so the verdict stays with the person reading it. */
export function scoreExtraction(golden: string, fresh: string): EvalScore {
	const g = evalSections(golden);
	const f = evalSections(fresh);
	const labels = [...new Set([...g.keys(), ...f.keys()])];
	const sections = labels.map((label) => ({ label, goldenItems: g.get(label)?.items ?? 0, freshItems: f.get(label)?.items ?? 0 }));
	const missing = [...g.keys()].filter((l) => !f.has(l));
	const extra = [...f.keys()].filter((l) => !g.has(l));
	const owners = jaccard(actionOwners(g.get("Action items")?.body ?? ""), actionOwners(f.get("Action items")?.body ?? ""));
	const kw = (s: string | undefined) =>
		new Set(
			(s ?? "")
				.split(",")
				.map((x) => x.replace(/^[-\s]+/, "").trim().toLowerCase())
				.filter(Boolean)
		);
	const keywords = jaccard(kw(g.get("Keywords")?.body), kw(f.get("Keywords")?.body));
	const gChars = [...g.values()].reduce((n, s) => n + s.chars, 0);
	const fChars = [...f.values()].reduce((n, s) => n + s.chars, 0);
	return { sections, missing, extra, ownerOverlap: owners, keywordOverlap: keywords, lengthRatio: gChars ? fChars / gChars : 0 };
}

/** The eval report note: a summary table for the scan, then each fresh
 *  extraction in full for the read-through that actually decides. */
export function buildEvalReport(rows: { title: string; score: EvalScore; fresh: string }[], model: string, date: string): string {
	const pct = (v: number | null) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
	const lines = [
		"---",
		"type: capture-eval",
		`model: ${model}`,
		`date: ${date}`,
		"---",
		"",
		`# Extraction eval: ${model} (${date})`,
		"",
		"Counts and overlaps are mechanical; the fresh output under each note is what actually decides. Golden = the sections the note already carries.",
		"",
		"| Note | Sections | Items (golden → fresh) | Action owners | Keywords | Length |",
		"|---|---|---|---|---|---|",
	];
	for (const r of rows) {
		const goldenLabels = r.score.sections.length - r.score.extra.length;
		const shared = goldenLabels - r.score.missing.length;
		const gItems = r.score.sections.reduce((n, s) => n + s.goldenItems, 0);
		const fItems = r.score.sections.reduce((n, s) => n + s.freshItems, 0);
		const secCell = `${shared}/${goldenLabels}${r.score.extra.length ? ` (+${r.score.extra.length} extra)` : ""}`;
		lines.push(
			`| ${r.title} | ${secCell} | ${gItems} → ${fItems} | ${pct(r.score.ownerOverlap)} | ${pct(r.score.keywordOverlap)} | ${r.score.lengthRatio.toFixed(1)}x |`
		);
	}
	for (const r of rows) {
		lines.push("", `## ${r.title}`, "");
		if (r.score.missing.length) lines.push(`Missing sections: ${r.score.missing.join(", ")}.`);
		if (r.score.extra.length) lines.push(`Unrequested sections: ${r.score.extra.join(", ")}.`);
		lines.push("", `> [!quote]- Fresh extraction (${model})`, ...r.fresh.split("\n").map((l) => `> ${l}`));
	}
	return lines.join("\n") + "\n";
}

/* ---------------- deferred processing queue ---------------- */

/** A claim older than this is a processor that died mid-job; the item counts
 *  as pending again so the work is never stranded behind a crash. */
export const CLAIM_STALE_MS = 30 * 60_000;

/** How long a claimer waits for sync to surface a competing claim before
 *  starting the actual work. Short enough not to hurt, long enough for a
 *  same-LAN sync hop; a conflict that arrives later is still caught by the
 *  ownership re-check before results are written. */
export const CLAIM_SETTLE_MS = 4_000;

/** A queued note's place in the deferred-processing lifecycle, from its
 *  frontmatter. "stale" is a processing claim old enough to retake;
 *  "failed" items sit out of the sweep until a person retries by hand. */
export function pendingState(fm: Record<string, unknown> | null | undefined, now: number): "none" | "pending" | "claimed" | "stale" | "failed" {
	const status = typeof fm?.["pa-status"] === "string" ? fm["pa-status"] : "";
	if (status === "pending") return "pending";
	if (status === "failed") return "failed";
	if (status !== "processing") return "none";
	const at = Number(fm?.["pa-claimed-at"] ?? 0);
	return !Number.isFinite(at) || now - at > CLAIM_STALE_MS ? "stale" : "claimed";
}

/** The recordings a queued meeting note points at, with each part's start
 *  offset. Tolerant of hand-edited frontmatter: offsets pad with zeros and
 *  non-string entries drop, so a mangled list degrades rather than throws. */
export function pendingRecordings(fm: Record<string, unknown> | null | undefined): { paths: string[]; offsets: number[] } {
	const rawPaths = fm?.["pa-recordings"];
	const paths = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === "string" && !!p.trim()) : [];
	const rawOffsets = fm?.["pa-offsets"];
	const offsets = paths.map((_, i) => {
		const v = Array.isArray(rawOffsets) ? Number(rawOffsets[i]) : 0;
		return Number.isFinite(v) && v >= 0 ? v : 0;
	});
	return { paths, offsets };
}

/** Sync conflict copies can leave two notes queueing the SAME recording
 *  ("Standup.md" and "Standup (conflicted copy).md", both pending). Group
 *  queued notes by the set of recordings they claim and let exactly one per
 *  group through: the shortest path, ties broken lexicographically, which is
 *  the original name against every conflict-suffix convention in the wild.
 *  Losers are reported, not processed; the person resolves the conflict. */
export function dedupeQueuedNotes(items: { path: string; recordings: string[] }[]): { winners: Set<string>; losers: string[] } {
	const groups = new Map<string, { path: string; recordings: string[] }[]>();
	for (const it of items) {
		const key = [...it.recordings].sort().join("\n");
		const g = groups.get(key);
		if (g) g.push(it);
		else groups.set(key, [it]);
	}
	const winners = new Set<string>();
	const losers: string[] = [];
	for (const g of groups.values()) {
		g.sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
		winners.add(g[0].path);
		for (const rest of g.slice(1)) losers.push(rest.path);
	}
	return { winners, losers };
}

/** Marks parked in frontmatter as JSON while a recording waits for its
 *  processor. Anything unreadable is no marks, never a crash. */
export function parseMomentsJson(raw: unknown): Moment[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((m): m is { ms?: unknown; label?: unknown } => !!m && typeof m === "object")
			.map((m) => ({ ms: Number(m.ms) || 0, label: typeof m.label === "string" ? m.label : "" }));
	} catch {
		return [];
	}
}

/** The note's own record of the frames lifted out of its recording, read back
 *  from the `pa-screens` property.
 *
 *  The frames have to live somewhere the extraction cannot reach. Placed under a
 *  stamped bullet they sit INSIDE the extracted body, which a re-extract
 *  replaces wholesale, and the image files would survive in the vault with
 *  nothing pointing at them. Frontmatter is that somewhere, exactly as
 *  `pa-marks` is for moments, so both the Screens section and the illustrated
 *  bullets are derived views that can be rebuilt at any time. */
export function parseScreensJson(raw: unknown): Frame[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const arr = JSON.parse(raw) as unknown;
		if (!Array.isArray(arr)) return [];
		return arr
			.filter((f): f is { ms?: unknown; link?: unknown; text?: unknown } => !!f && typeof f === "object")
			.map((f) => ({ ms: Number(f.ms) || 0, link: typeof f.link === "string" ? f.link : "", text: typeof f.text === "string" ? f.text : "" }))
			.filter((f) => f.link)
			.sort((a, b) => a.ms - b.ms);
	} catch {
		return [];
	}
}

/** Meeting-type presets for the Process dialog: which sections to extract. */
export const TEMPLATES: { id: string; name: string; sections: ExtractionKey[] }[] = [
	{ id: "general", name: "General meeting", sections: ["summary", "actions", "decisions", "questions", "keywords"] },
	{ id: "oneonone", name: "1:1", sections: ["summary", "actions", "questions"] },
	{ id: "leadership", name: "Leadership", sections: ["summary", "decisions", "actions", "risks"] },
	{ id: "customer", name: "Customer call", sections: ["summary", "actions", "risks", "questions", "keywords"] },
	{ id: "video", name: "Video notes", sections: ["summary", "takeaways", "facts", "resources", "quotes", "questions", "keywords"] },
];

/** Float32 audio → 16 kHz signed 16-bit PCM for the realtime endpoint. Plain
 *  block averaging as the low-pass: crude, fine for speech. */
export function downsamplePCM16(input: Float32Array, fromRate: number, toRate = 16000): Int16Array {
	const clamp = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
	if (toRate >= fromRate) {
		const out = new Int16Array(input.length);
		for (let i = 0; i < input.length; i++) out[i] = clamp(input[i]);
		return out;
	}
	const ratio = fromRate / toRate;
	const n = Math.floor(input.length / ratio);
	const out = new Int16Array(n);
	for (let i = 0; i < n; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
		let sum = 0;
		for (let j = start; j < end; j++) sum += input[j];
		out[i] = clamp(sum / (end - start));
	}
	return out;
}

/* ---------------- transcript imports (Otter, Teams/Zoom) ---------------- */

/** "1:02:03.500" / "02:03,500" / "1:02" → milliseconds; null if not a clock. */
export function parseClock(s: string): number | null {
	const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/);
	if (!m) return null;
	const h = m[1] ? +m[1] : 0;
	const ms = m[4] ? +m[4].padEnd(3, "0") : 0;
	return ((h * 60 + +m[2]) * 60 + +m[3]) * 1000 + ms;
}

/** "Speaker 1" → "1" (so the naming flow treats it as anonymous); trims. */
function normalizeSpeakerLabel(name: string): string {
	const n = name.trim();
	const m = n.match(/^Speaker\s+(\S+)$/i);
	return m ? m[1] : n;
}

/** Is this label a diarization placeholder (A, B, 1, 1A, 12B) rather than a
 *  name? Single UPPERCASE letters and digit-prefixed forms only, short real
 *  names and initials (Jo, Ed, TJ) must never be swallowed as placeholders. */
/** True for a correction term that is really a per-recording diarization
 *  label ("Speaker A", "Speaker 1A"). Letters rotate with every recording, so
 *  a REMEMBERED rule like "Speaker A → Darwin" renames a different person in
 *  every future transcript; such terms may be applied once, never learned. */
export function isSpeakerLetterTerm(term: string): boolean {
	const m = /^Speaker\s+(.+)$/i.exec(term.trim());
	return !!m && isAnonymousLabel(m[1]);
}

export function isAnonymousLabel(label: string): boolean {
	return /^(?:\d{1,2}[A-Z]{1,2}|[A-Z]|\d{1,3})$/.test(label.trim());
}

/** Merge consecutive same-speaker cues into readable utterances. A crosstalk
 *  stretch never merges into a plain neighbor (and vice versa): folding a 2s
 *  overlap into a 30s paragraph would smear the crosstalk label over words
 *  one person clearly said alone. */
export function coalesceUtterances(utts: Utterance[]): Utterance[] {
	const sig = (u: Utterance) => (u.crosstalk ?? []).join("|");
	const out: Utterance[] = [];
	for (const u of utts) {
		const last = out[out.length - 1];
		if (last && last.speaker === u.speaker && sig(last) === sig(u)) {
			last.text = `${last.text} ${u.text}`.trim();
			if (u.end != null) last.end = u.end;
		} else out.push({ ...u });
	}
	return out;
}

/** WebVTT and SRT cues → utterances. Handles Teams <v Name> voice tags and
 *  "Name: text" prefixes (Zoom, Otter SRT); strips markup tags. */
export function parseCues(src: string): Utterance[] {
	const utts: Utterance[] = [];
	for (const block of src.replace(/\r/g, "").replace(/^\uFEFF/, "").split(/\n\s*\n+/)) {
		const lines = block.split("\n").filter((l) => l.trim().length);
		const ti = lines.findIndex((l) => l.includes("-->"));
		if (ti < 0) continue;
		const [startS, endS] = lines[ti].split("-->");
		const start = parseClock((startS ?? "").trim());
		if (start == null) continue;
		const end = parseClock((endS ?? "").trim().split(/\s+/)[0] ?? "");
		let text = lines
			.slice(ti + 1)
			.join(" ")
			.trim();
		let speaker = "";
		const v = text.match(/^<v\s+([^>]+)>/);
		if (v) {
			speaker = v[1].trim();
			text = text.replace(/<v\s+[^>]+>/g, "").replace(/<\/v>/g, "");
		} else {
			const p = text.match(/^([A-Z][\w .'-]{0,40}?):\s+(.*)$/s);
			if (p) {
				speaker = p[1];
				text = p[2];
			}
		}
		text = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		if (!text) continue;
		const u: Utterance = { speaker: normalizeSpeakerLabel(speaker), text, start };
		if (end != null) u.end = end;
		utts.push(u);
	}
	return utts;
}

/** Otter .txt export: "Name  0:05" header lines (two-plus spaces before the
 *  clock, at a paragraph boundary), each followed by a paragraph. Both
 *  conditions are required so prose that merely ENDS in a time ("let's
 *  reconvene at 3:00") is never mistaken for a new speaker. */
export function parseOtterTxt(src: string): Utterance[] {
	const utts: Utterance[] = [];
	let current: Utterance | null = null;
	let atBoundary = true;
	for (const raw of src.replace(/\r/g, "").replace(/^\uFEFF/, "").split("\n")) {
		const line = raw.trim();
		if (!line) {
			atBoundary = true;
			continue;
		}
		const head = atBoundary ? line.match(/^(.{1,60}?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?)$/) : null;
		atBoundary = false;
		if (head && parseClock(head[2]) != null) {
			if (current?.text.trim()) utts.push(current);
			current = { speaker: normalizeSpeakerLabel(head[1]), text: "", start: parseClock(head[2])! };
			continue;
		}
		if (current) current.text = `${current.text} ${line}`.trim();
	}
	if (current?.text.trim()) utts.push(current);
	return utts;
}

/** Sniff and parse a transcript file. Null = not a recognizable transcript
 *  (the caller can still import the raw text as an unlabeled transcript). */
export function parseTranscriptFile(filename: string, src: string): Utterance[] | null {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".vtt") || lower.endsWith(".srt") || /^WEBVTT/m.test(src) || /-->/.test(src)) {
		const cues = coalesceUtterances(parseCues(src));
		return cues.length ? cues : null;
	}
	const otter = coalesceUtterances(parseOtterTxt(src));
	return otter.length ? otter : null;
}

/* ---------------- re-extract: swap the AI body, keep everything else ---------------- */

/** The headings a capture's own words sit under: speech is a "Transcript", a
 *  post is a "Post", a web page an "Article". */
export const SOURCE_HEADINGS = ["Transcript", "Post", "Article"] as const;

/** Sections that are not the extraction and must outlive a re-extract. The
 *  source text is in here under every heading it can use, one of them leads
 *  the note on a post capture, and eating it would destroy the only copy of
 *  what was captured.
 *
 *  Screens are in here for the same reason: the frames cost a decode of the
 *  whole recording, the image files stay in the vault whatever the note says,
 *  and a re-extract that dropped the section would leave them orphaned with no
 *  way back to the moments they came from. */
const KEPT_SECTION = new RegExp(`^## (Carried over|Media|Moments|Screens|${SOURCE_HEADINGS.join("|")})\\b`);

/** Whether the note from line `k` on is nothing but embeds and blank lines.
 *
 *  This is what a bare `![[…]]` line is really being tested for: the recording
 *  players parked at the very bottom of a capture, which a re-extract must
 *  write above rather than over. An embed with real note still to come below it
 *  is a different thing entirely — a post's media, which leads the note it
 *  belongs to — and reading that one as the end of the body would write the new
 *  extraction above the picture and leave the old one below it, surviving as a
 *  duplicate. */
function isTrailingEmbedRun(lines: string[], k: number): boolean {
	for (let n = k; n < lines.length; n++) {
		const t = lines[n].trim();
		if (t && !/^!\[\[/.test(t)) return false;
	}
	return true;
}

/** Replace the extracted sections of an assembled note, preserving
 *  frontmatter, title, the Speakers line, Carried over, Moments, the
 *  captured text wherever it sits, and the audio embeds. */
export function replaceExtractedBody(md: string, newBody: string): string {
	const lines = md.split("\n");
	const { from, to } = extractedBodyRange(lines);
	const head = lines.slice(0, from).join("\n").replace(/\n+$/, "");
	const tail = lines.slice(to).join("\n").replace(/^\n+/, "");
	return head + "\n\n" + newBody.trim() + (tail ? "\n\n" + tail : "\n");
}

/** Read the extracted body back out, illustrate it with `frames`, and write it
 *  in place. The counterpart to doing this during assembly, for a note that
 *  already exists: an imported Teams transcript gets its screens beside its
 *  points the same way a freshly recorded meeting does.
 *
 *  Returns the frames that found no point, for the caller to render as Screens. */
export function illustrateNote(md: string, frames: Frame[], windowMs?: number): { md: string; unused: Frame[] } {
	if (!frames.length) return { md, unused: [] };
	const lines = md.split("\n");
	const { from, to } = extractedBodyRange(lines);
	const body = lines.slice(from, to).join("\n").trim();
	if (!body) return { md, unused: [...frames] };
	const r = illustrateBody(body, frames, windowMs);
	return { md: replaceExtractedBody(md, r.body), unused: r.unused };
}

/** Where a note's extracted body starts and ends, in lines: after the
 *  properties, title, Speakers line and any leading kept section, and up to the
 *  first kept section or trailing player. Shared so that reading the body and
 *  replacing it can never disagree about its boundaries. */
function extractedBodyRange(lines: string[]): { from: number; to: number } {
	let i = 0;
	if (lines[0]?.trim() === "---") {
		i = 1;
		while (i < lines.length && lines[i].trim() !== "---") i++;
		i++;
	}
	// the title line, when the note has one: a capture whose filename already
	// carries the title writes no heading, and its body starts straight after
	// the properties. (Scanning forward for a "# " instead would run off the end
	// of such a note and leave the whole thing untouched.)
	while (i < lines.length && !lines[i].trim()) i++;
	if (/^# /.test(lines[i] ?? "")) i++;
	let j = i;
	while (j < lines.length && !lines[j].trim()) j++;
	if (/^\*\*Speakers:\*\* /.test(lines[j] ?? "")) i = j + 1;
	// a post leads with its own words, so the body being replaced starts after
	// them; without this the extraction would be written above the post and the
	// old extraction, sitting below it, would survive as a duplicate
	for (;;) {
		let lead = i;
		while (lead < lines.length && !lines[lead].trim()) lead++;
		if (!KEPT_SECTION.test(lines[lead] ?? "")) break;
		// a Media section's body IS embeds, so an embed cannot also be the start of
		// the trailing players while one is being scanned: the picture belongs to
		// the heading above it. Without this, a post whose whole content is a
		// picture has its re-extracted summary written between the two.
		const embedsAreBody = /^## Media\b/.test(lines[lead]);
		let k = lead + 1;
		while (k < lines.length && !/^## /.test(lines[k]) && !(!embedsAreBody && /^!\[\[/.test(lines[k]) && isTrailingEmbedRun(lines, k))) k++;
		i = k;
	}
	let end = lines.length;
	for (let k = i; k < lines.length; k++) {
		if (KEPT_SECTION.test(lines[k]) || (/^!\[\[/.test(lines[k]) && isTrailingEmbedRun(lines, k))) {
			end = k;
			break;
		}
	}
	return { from: i, to: end };
}

/** Everything a note embeds EXCEPT what sits under "## Media", in document
 *  order.
 *
 *  A recording and a post's own pictures are both `![[…]]` lines, and only the
 *  first kind is what the sticky player, the frame grab, and the stamp seeks
 *  are about. A GIF captured from a post is not a recording of anything: giving
 *  it a transport bar hides the picture behind a scrubber that plays silence,
 *  which is exactly what happened the first time a capture kept one. */
export function recordingEmbeds(md: string): string[] {
	const out: string[] = [];
	let inMedia = false;
	for (const line of (md || "").split("\n")) {
		if (/^## /.test(line)) inMedia = /^## Media\b/.test(line);
		if (inMedia) continue;
		for (const m of line.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.push(m[1]);
	}
	return out;
}

/** An embed as the note writes it: what it points at, and the size written
 *  after the pipe, which is empty when none was. */
export interface EmbedRef {
	link: string;
	/** The raw text after the pipe: "400", "400x300", or "". */
	size: string;
}

/** The post's own pictures with the size each was left at: what
 *  `recordingEmbeds` leaves out. Together the two cover every embed in the note,
 *  and nothing belongs to both. */
export function postMediaRefs(md: string): EmbedRef[] {
	const out: EmbedRef[] = [];
	let inMedia = false;
	for (const line of (md || "").split("\n")) {
		if (/^## /.test(line)) inMedia = /^## Media\b/.test(line);
		if (!inMedia) continue;
		for (const m of line.matchAll(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) out.push({ link: m[1], size: (m[2] ?? "").trim() });
	}
	return out;
}

/** Just the links, for the callers that only need to know what is post media. */
export function postMediaEmbeds(md: string): string[] {
	return postMediaRefs(md).map((r) => r.link);
}

/** The size written after an embed's pipe, in Obsidian's own notation: "400" is
 *  a width, "400x300" is both. Null for an empty or unparseable alias, which is
 *  most of them: the pipe usually carries display text, not a size.
 *
 *  Sharing the notation is the point. A width dragged onto a captured video is
 *  written the same way Obsidian writes one dragged onto an image, so the note
 *  means the same thing to both and stays an ordinary note. */
export function parseEmbedSize(alias: string): { width: number; height?: number } | null {
	const m = (alias || "").trim().match(/^(\d{1,5})(?:\s*x\s*(\d{1,5}))?$/i);
	if (!m) return null;
	const width = +m[1];
	if (!width) return null;
	const height = m[2] ? +m[2] : 0;
	return height ? { width, height } : { width };
}

/** Write a width onto a post's media embed, or take one off with a width of 0.
 *
 *  Only the Media section is touched, and only the embed pointing at `link`, so
 *  a note whose transcript quotes the same filename is left alone. Rewrites
 *  within the line and never adds or removes one, which is what lets the caller
 *  apply it through the editor as a single-line replacement and keep the note's
 *  scroll position. */
export function withEmbedSize(md: string, link: string, width: number): string {
	let inMedia = false;
	return (md || "")
		.split("\n")
		.map((line) => {
			if (/^## /.test(line)) inMedia = /^## Media\b/.test(line);
			if (!inMedia) return line;
			return line.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (whole, target: string, alias?: string) => {
				if (target !== link) return whole;
				if (width > 0) return `![[${target}|${Math.round(width)}]]`;
				// a size of zero clears it, and any other alias (display text) is
				// left where it was: it was never ours to drop
				const keep = parseEmbedSize(alias ?? "") ? "" : (alias ?? "");
				return keep ? `![[${target}|${keep}]]` : `![[${target}]]`;
			});
		})
		.join("\n");
}

/** Whether a rendered embed is the one a `![[…]]` link names.
 *
 *  Obsidian puts the link's own text in the embed's `src`, and that text is
 *  whatever was written: the full vault path a capture writes, or the bare
 *  filename someone shortened it to afterwards. Both have to answer, and a
 *  suffix match alone would not do it, since "a.mp4" is a suffix of
 *  "extra.mp4"; the boundary is the separator. */
export function embedSrcMatches(link: string, src: string): boolean {
	if (!link || !src) return false;
	if (link === src) return true;
	return link.endsWith("/" + src) || src.endsWith("/" + link);
}

/** The "## Heading" section body of a note, or "". */
export function sectionText(md: string, heading: string): string {
	const m = md.match(new RegExp(`## ${escapeReg(heading)}\\n+([\\s\\S]*?)(?=\\n## |$)`));
	return m ? m[1].trim() : "";
}

/** A capture's own words, under whichever heading it stored them: the foldable
 *  callout wrapper older notes used and its "> " prefixes go, the words stay.
 *  Empty when the note kept none. Shared by re-extract and the evals, so a post
 *  or an article can be re-extracted like a meeting. */
export function captureSourceText(md: string): string {
	for (const h of SOURCE_HEADINGS) {
		const sec = sectionText(md, h);
		if (sec)
			return sec
				.split("\n")
				.filter((l) => !/^>\s*\[!/.test(l))
				.map((l) => l.replace(/^>\s?/, ""))
				.join("\n")
				.trim();
	}
	return "";
}

/** The real items in a note's "## Heading" list: what a person page or a digest
 *  should quote from a Decisions or Questions section.
 *
 *  A frame placed beside a point, and the reader's text quoted under it, are part
 *  of that point rather than items of their own; without excluding them a person
 *  page lists "![[frame.webp]]" among the meeting's decisions. Table rows and the
 *  *None identified.* placeholder are not items either. */
export function sectionListItems(md: string, heading: string): string[] {
	return sectionText(md, heading)
		.split("\n")
		.filter((l) => !FRAME_LINE.test(l) && !/^\s*>/.test(l))
		.map((l) => l.replace(/^\s*[-*+]\s+/, "").trim())
		.filter((l) => l && !l.startsWith("*None") && !l.startsWith("|"));
}

/** Completed '- [x]' lines with their ✅ done dates. */
export function extractDoneTasks(md: string): { text: string; doneDate: string | null }[] {
	return md
		.split("\n")
		.filter((l) => /^\s*[-*+]\s+\[x\]\s+\S/i.test(l))
		.map((l) => ({ text: l.trim(), doneDate: l.match(/✅\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? null }));
}

/** First [[wiki-link]] in a task line = its owner; "Unassigned" otherwise. */
export function taskOwner(line: string): string {
	const m = line.match(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/);
	return m ? (m[2] || m[1].slice(m[1].lastIndexOf("/") + 1)).trim() || "Unassigned" : "Unassigned";
}

/* ---------------- person report + weekly digest ---------------- */

export interface PersonData {
	name: string;
	/** Newest first. */
	meetings: { title: string; path: string; date: string }[];
	openTasks: { text: string; fromPath: string; date: string }[];
	doneCount: number;
	decisions: { text: string; fromPath: string; date: string }[];
	questions: { text: string; fromPath: string; date: string }[];
}

const noteLink = (path: string, title?: string) => `[[${path.replace(/\.md$/, "")}${title ? `|${title}` : ""}]]`;
const stripTask = (line: string) => line.replace(/^[-*+]\s+\[[ x]\]\s+/i, "");

/** The person hub: commitments, decisions, and meetings for one attendee.
 *  Open items reference their meeting (never duplicate checkboxes), so todo
 *  dashboards keep a single source of truth. */
export function buildPersonReport(d: PersonData, agenda: string | null, generatedOn: string): string {
	const fm = [
		"---",
		"type: capture-person",
		`person: "[[${d.name}]]"`,
		`date: ${generatedOn}`,
		"generated: true",
		"tags:",
		"  - capture",
		"---",
	].join("\n");
	const parts = [fm, `# ${d.name}`];
	parts.push(
		`**${d.meetings.length}** meeting(s) · **${d.openTasks.length}** open commitment(s) · **${d.doneCount}** completed`
	);
	if (agenda) parts.push(`## Suggested 1:1 agenda\n\n${agenda.trim()}`);
	parts.push(
		`## Open commitments\n\n` +
			(d.openTasks.length
				? d.openTasks.map((t) => `- ⏭ ${stripTask(t.text)} *(from ${noteLink(t.fromPath)}, ${t.date})*`).join("\n")
				: "*Nothing open.*")
	);
	if (d.decisions.length) {
		parts.push(
			`## Decisions involving ${d.name}\n\n` +
				d.decisions.slice(0, 10).map((x) => `- ${x.text} *(${noteLink(x.fromPath)}, ${x.date})*`).join("\n")
		);
	}
	if (d.questions.length) {
		parts.push(
			`## Open questions from their meetings\n\n` + d.questions.slice(0, 8).map((x) => `- ${x.text} *(${noteLink(x.fromPath)})*`).join("\n")
		);
	}
	parts.push(`## Meetings\n\n` + (d.meetings.slice(0, 15).map((m) => `- ${noteLink(m.path, m.title)} · ${m.date}`).join("\n") || "*None yet.*"));
	return parts.join("\n\n") + "\n";
}

export interface DigestData {
	from: string;
	to: string;
	meetings: { title: string; path: string; date: string; series?: string | null }[];
	decisions: { text: string; fromPath: string }[];
	newTasks: { owner: string; text: string; fromPath: string; done: boolean }[];
	completed: { owner: string; text: string; fromPath: string }[];
	stale: { owner: string; text: string; fromPath: string; date: string; ageDays: number }[];
	questions: { text: string; fromPath: string }[];
}

/** Alert red from the suite palette, for aging cells. */
const AGE_SPAN = (days: number) =>
	days > 14
		? `<span class="ptb" style="background:#E81123;color:#FFFFFF">${days}d</span>`
		: `<span class="ptb" style="background:#FFB900">${days}d</span>`;

/** The Monday-morning note: what happened, who owes what, what's going stale.
 *  Tables are plain Markdown with Power Tables spans (colors + column sums). */
export function buildWeeklyDigest(d: DigestData, summary: string | null, generatedOn: string): string {
	const fm = [
		"---",
		"type: capture-digest",
		`date: ${generatedOn}`,
		`range: ${d.from} to ${d.to}`,
		"generated: true",
		"tags:",
		"  - capture",
		"---",
	].join("\n");
	const parts = [fm, `# Meetings digest · ${d.from} to ${d.to}`];
	if (summary) parts.push(summary.trim());
	parts.push(
		`## Meetings (${d.meetings.length})\n\n` +
			(d.meetings.map((m) => `- ${noteLink(m.path, m.title)} · ${m.date}${m.series ? ` · ${m.series}` : ""}`).join("\n") ||
				"*No meetings captured this week.*")
	);
	if (d.decisions.length) parts.push(`## Decisions\n\n` + d.decisions.map((x) => `- ${x.text} *(${noteLink(x.fromPath)})*`).join("\n"));
	{
		const owners = new Map<string, { open: number; done: number }>();
		for (const t of d.newTasks) {
			const o = owners.get(t.owner) ?? { open: 0, done: 0 };
			if (t.done) o.done++;
			else o.open++;
			owners.set(t.owner, o);
		}
		for (const t of d.completed) {
			const o = owners.get(t.owner) ?? { open: 0, done: 0 };
			o.done++;
			owners.set(t.owner, o);
		}
		if (owners.size) {
			const rows = [...owners.entries()].sort((a, b) => b[1].open - a[1].open);
			parts.push(
				`## Commitments by owner\n\n` +
					"| Owner | Open | Done |\n| --- | --- | --- |\n" +
					rows.map(([o, c]) => `| ${o === "Unassigned" ? o : `[[${o}]]`} | ${c.open} | ${c.done} |`).join("\n") +
					`\n| **Total** | <span class="ptb" data-calc="sum:col">${rows.reduce((n, r) => n + r[1].open, 0)}</span> | <span class="ptb" data-calc="sum:col">${rows.reduce((n, r) => n + r[1].done, 0)}</span> |`
			);
		}
	}
	if (d.stale.length) {
		parts.push(
			`## Going stale (open longer than a week)\n\n` +
				"| Age | Owner | Commitment | Meeting |\n| --- | --- | --- | --- |\n" +
				d.stale
					.sort((a, b) => b.ageDays - a.ageDays)
					.slice(0, 20)
					.map((t) => `| ${AGE_SPAN(t.ageDays)} | ${t.owner === "Unassigned" ? t.owner : `[[${t.owner}]]`} | ${stripTask(t.text).replace(/\|/g, "\\|")} | ${noteLink(t.fromPath)} |`)
					.join("\n")
		);
	}
	if (d.questions.length) parts.push(`## Still open\n\n` + d.questions.slice(0, 12).map((x) => `- ${x.text} *(${noteLink(x.fromPath)})*`).join("\n"));
	return parts.join("\n\n") + "\n";
}

/* ---------------- semantic search: embeddings + hybrid fusion ---------------- */

/** Cosine similarity of two equal-length vectors; 0 when either is empty or a
 *  zero vector (so a missing embedding never ranks). */
export function cosine(a: number[], b: number[]): number {
	if (!a.length || a.length !== b.length) return 0;
	let dot = 0,
		na = 0,
		nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/* ---------------- voiceprints (speaker identity across recordings) ---------------- */

/** A speaker embedding out of the transcription server: an L2-normalized voice
 *  vector plus how many seconds of that speaker's speech it was averaged over.
 *  Short samples make weak prints, so the caller gates enrollment and matching
 *  on `seconds` rather than trusting a two-word "No." to define a voice. */
export interface SpeakerEmbedding {
	vector: number[];
	seconds: number;
}

/** A person's voiceprint: one or more centroids, because a voice sounds
 *  different on a headset, a conference mic, and a phone call, and folding them
 *  into one average would blur them into a print that matches none of them well.
 *  Each centroid is an L2-normalized mean; `samples` counts the enrollments in
 *  it, so a centroid built from many turns outweighs a one-off when they merge. */
export interface Voiceprint {
	person: string;
	centroids: { vector: number[]; samples: number }[];
	/** Milliseconds, passed in by the caller so this layer stays pure. */
	updated: number;
}
export type VoiceprintLibrary = Voiceprint[];

/** Unit-length copy of a vector. The zero vector is returned unchanged: there is
 *  nothing to normalize, and callers already read it as "no embedding". */
export function l2normalize(v: number[]): number[] {
	let n = 0;
	for (const x of v) n += x * x;
	n = Math.sqrt(n);
	return n > 0 ? v.map((x) => x / n) : v.slice();
}

/** Weighted average of a centroid and an incoming unit vector, re-normalized so
 *  every stored centroid stays unit-length and directly cosine-comparable. */
function mergeCentroid(c: { vector: number[]; samples: number }, v: number[], vSamples: number): { vector: number[]; samples: number } {
	const total = c.samples + vSamples;
	const mixed = c.vector.map((x, i) => (x * c.samples + v[i] * vSamples) / total);
	return { vector: l2normalize(mixed), samples: total };
}

/** Merge the two most-similar centroids until within budget. In place, so the
 *  callers that already hold a private copy (enroll, rename) stay pure. */
function capCentroids(centroids: { vector: number[]; samples: number }[], maxCentroids: number): void {
	while (centroids.length > maxCentroids) {
		let ai = 0;
		let bi = 1;
		let sim = -1;
		for (let i = 0; i < centroids.length; i++)
			for (let j = i + 1; j < centroids.length; j++) {
				const s = cosine(centroids[i].vector, centroids[j].vector);
				if (s > sim) {
					sim = s;
					ai = i;
					bi = j;
				}
			}
		centroids[ai] = mergeCentroid(centroids[ai], centroids[bi].vector, centroids[bi].samples);
		centroids.splice(bi, 1);
	}
}

/** Fold a speaker embedding into a person's voiceprint. Close to an existing
 *  centroid (cosine >= mergeAt) it merges in as a running, sample-weighted
 *  average; otherwise it starts a new centroid, so a headset voice and a phone
 *  voice can coexist under one name. Past maxCentroids the two nearest centroids
 *  merge to make room. Pure: returns a new library and never mutates the input,
 *  so the caller owns when to persist. `mergeAt`/`maxCentroids` default to
 *  placeholders to be calibrated against real recordings, never guessed here. */
export function enrollVoiceprint(
	lib: VoiceprintLibrary,
	person: string,
	vector: number[],
	now: number,
	opts: { mergeAt?: number; maxCentroids?: number } = {}
): VoiceprintLibrary {
	const mergeAt = opts.mergeAt ?? 0.75;
	const maxCentroids = opts.maxCentroids ?? 6;
	if (!vector.length || !person.trim()) return lib;
	const v = l2normalize(vector);
	const next: VoiceprintLibrary = lib.map((p) => ({
		person: p.person,
		centroids: p.centroids.map((c) => ({ vector: c.vector.slice(), samples: c.samples })),
		updated: p.updated,
	}));
	let entry = next.find((p) => p.person === person);
	if (!entry) {
		entry = { person, centroids: [], updated: now };
		next.push(entry);
	}
	entry.updated = now;
	let best = -1;
	let bestSim = -1;
	for (let i = 0; i < entry.centroids.length; i++) {
		const s = cosine(v, entry.centroids[i].vector);
		if (s > bestSim) {
			bestSim = s;
			best = i;
		}
	}
	if (best >= 0 && bestSim >= mergeAt) entry.centroids[best] = mergeCentroid(entry.centroids[best], v, 1);
	else entry.centroids.push({ vector: v, samples: 1 });
	capCentroids(entry.centroids, maxCentroids);
	return next;
}

/** The best matching person for an embedding: the highest cosine across every
 *  centroid of every voiceprint. Returns null below `threshold`, or when a
 *  DIFFERENT person's best score is within `margin` of the winner. An ambiguous
 *  match is worse than none here: the payoff is a confident one-click "This is
 *  Sanjit", and a coin-flip suggestion trains the user to distrust all of them.
 *  Thresholds are placeholders until calibrated against real recordings. */
export function matchVoiceprint(
	lib: VoiceprintLibrary,
	vector: number[],
	opts: { threshold?: number; margin?: number } = {}
): { person: string; score: number } | null {
	const threshold = opts.threshold ?? 0.6;
	const margin = opts.margin ?? 0.05;
	if (!vector.length) return null;
	const v = l2normalize(vector);
	const scored = lib
		.map((p) => ({ person: p.person, score: p.centroids.reduce((m, c) => Math.max(m, cosine(v, c.vector)), 0) }))
		.sort((a, b) => b.score - a.score);
	const top = scored[0];
	if (!top || top.score < threshold) return null;
	if (scored[1] && top.score - scored[1].score < margin) return null;
	return top;
}

/** Drop a person's voiceprint entirely: the "forget this voice" action, which
 *  must actually delete for the privacy promise to hold. */
export function forgetVoiceprint(lib: VoiceprintLibrary, person: string): VoiceprintLibrary {
	return lib.filter((p) => p.person !== person);
}

/** Rename a voiceprint, folding into the target when a print for that name
 *  already exists: the "these two labels are the same person" merge, and the fix
 *  for a mistyped name. Centroids combine and re-cap. A no-op when `from` is
 *  absent or the names match. Pure: never mutates the input. */
export function renameVoiceprint(lib: VoiceprintLibrary, from: string, to: string, now: number, opts: { maxCentroids?: number } = {}): VoiceprintLibrary {
	const maxCentroids = opts.maxCentroids ?? 6;
	if (!from.trim() || !to.trim() || from === to) return lib;
	const source = lib.find((p) => p.person === from);
	if (!source) return lib;
	const clone = (c: { vector: number[]; samples: number }) => ({ vector: c.vector.slice(), samples: c.samples });
	const rest = lib.filter((p) => p.person !== from && p.person !== to);
	const target = lib.find((p) => p.person === to);
	const centroids = (target ? target.centroids.map(clone) : []).concat(source.centroids.map(clone));
	capCentroids(centroids, maxCentroids);
	return rest.concat({ person: to, centroids, updated: now });
}

/** Whether an embedding is worth enrolling or matching. A print built from a
 *  couple of seconds of speech is noise, so the capture path gates on this
 *  before it ever calls enroll or match. `minSeconds` is a placeholder to be
 *  calibrated, like the thresholds. */
export function usableEmbedding(emb: SpeakerEmbedding | undefined, minSeconds = 4): boolean {
	return !!emb && emb.vector.length > 0 && emb.seconds >= minSeconds;
}

/** Load a voiceprint library from whatever a synced JSON file holds, dropping
 *  anything malformed rather than trusting it. The file rides vault sync, so a
 *  partial write or a hand-edited copy must degrade to a smaller-but-valid
 *  library, never a crash on load. A centroid whose vector has a non-number
 *  hole is dropped whole: a half-read vector cannot be compared safely. */
export function parseVoiceprintLibrary(raw: unknown): VoiceprintLibrary {
	if (!Array.isArray(raw)) return [];
	const out: VoiceprintLibrary = [];
	for (const p of raw) {
		if (!p || typeof p !== "object") continue;
		const rec = p as { person?: unknown; centroids?: unknown; updated?: unknown };
		const person = typeof rec.person === "string" ? rec.person.trim() : "";
		if (!person) continue;
		const centroids: { vector: number[]; samples: number }[] = [];
		for (const c of Array.isArray(rec.centroids) ? rec.centroids : []) {
			const src = (c as { vector?: unknown; samples?: unknown }) ?? {};
			if (!Array.isArray(src.vector)) continue;
			const vector = src.vector.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
			if (!vector.length || vector.length !== src.vector.length) continue; // a hole makes the vector untrustworthy
			const samples = typeof src.samples === "number" && Number.isFinite(src.samples) && src.samples > 0 ? Math.floor(src.samples) : 1;
			centroids.push({ vector, samples });
		}
		if (!centroids.length) continue;
		const updated = typeof rec.updated === "number" && Number.isFinite(rec.updated) ? rec.updated : 0;
		out.push({ person, centroids, updated });
	}
	return out;
}

/** A per-person overview for the management screen: how many centroids and
 *  samples back each voice, most recently updated first. */
export function summarizeVoiceprints(lib: VoiceprintLibrary): { person: string; centroids: number; samples: number; updated: number }[] {
	return lib
		.map((p) => ({
			person: p.person,
			centroids: p.centroids.length,
			samples: p.centroids.reduce((n, c) => n + c.samples, 0),
			updated: p.updated,
		}))
		.sort((a, b) => b.updated - a.updated || a.person.localeCompare(b.person));
}

/** One diarized turn's voice: its letter, when it happened (ms within the
 *  recording), how many seconds of speech back the vector, and the vector
 *  itself. The per-turn grain is the point: a per-speaker mean can only
 *  describe a cluster, a per-turn vector can catch a cluster that is
 *  secretly two people. */
export interface TurnEmbedding {
	speaker: string;
	start: number;
	end: number;
	seconds: number;
	vector: number[];
}

/** One transcribed part of a rotated recording, with everything the voice
 *  layer needs to fold the parts into a single speaker space. */
export interface DiarizedPart {
	/** Fine-grained utterances (parseWhisperX's `fine`), letters scoped to this part. */
	utts: Utterance[];
	/** Per-letter mean voice vectors for this part, when the server sent them. */
	embeddings?: Record<string, SpeakerEmbedding>;
	/** Per-turn voice vectors for this part, times in ms within the part. */
	turnEmbeddings?: TurnEmbedding[];
	/** Where this part begins in the full recording, ms. */
	offsetMs: number;
}

function nextFreeLetter(used: Set<string>): string | null {
	for (let i = 0; i < 26; i++) {
		const l = String.fromCharCode(65 + i);
		if (!used.has(l)) return l;
	}
	return null;
}

/** Merge a rotated recording's parts into ONE speaker space by voice.
 *  Diarization letters are per-part seats: part 2's "A" need not be part 1's
 *  "A", which is why the old merge kept them apart as "1A"/"2A" and made the
 *  user name the same person once per part. With voice vectors the parts can
 *  be aligned instead: a later part's letter joins the earlier letter whose
 *  accumulated voice it matches (cosine >= alignAt), each side pairing at
 *  most once per part because diarization already declared a part's letters
 *  to be different people. A letter with no vector cannot be aligned, so the
 *  first part keeps it and later parts fall back to the old prefix scheme
 *  rather than silently sharing a letter between two unknown voices.
 *  `alignAt` is a placeholder to calibrate like the match thresholds; within
 *  one recording the channel is constant, so it sits above `threshold`. */
export function mergeDiarizedParts(
	parts: DiarizedPart[],
	opts: { alignAt?: number } = {}
): { utts: Utterance[]; embeddings: Record<string, SpeakerEmbedding>; turnEmbeddings: TurnEmbedding[] } {
	const alignAt = opts.alignAt ?? 0.7;
	const globals: { letter: string; sum: number[]; seconds: number }[] = [];
	const used = new Set<string>();
	const utts: Utterance[] = [];
	const turnEmbeddings: TurnEmbedding[] = [];
	for (let pi = 0; pi < parts.length; pi++) {
		const part = parts[pi];
		const embs = part.embeddings ?? {};
		const map = new Map<string, string>();
		const pairs: { local: string; gi: number; sim: number }[] = [];
		for (const [local, emb] of Object.entries(embs)) {
			if (!emb.vector?.length) continue;
			for (let gi = 0; gi < globals.length; gi++) {
				const sim = cosine(emb.vector, globals[gi].sum);
				if (sim >= alignAt) pairs.push({ local, gi, sim });
			}
		}
		pairs.sort((a, b) => b.sim - a.sim);
		const taken = new Set<number>();
		for (const p of pairs) {
			if (map.has(p.local) || taken.has(p.gi)) continue;
			map.set(p.local, globals[p.gi].letter);
			taken.add(p.gi);
			const emb = embs[p.local];
			const g = globals[p.gi];
			const secs = Math.max(0.1, emb.seconds || 0);
			for (let i = 0; i < g.sum.length && i < emb.vector.length; i++) g.sum[i] += emb.vector[i] * secs;
			g.seconds += secs;
		}
		for (const [local, emb] of Object.entries(embs)) {
			if (map.has(local) || !emb.vector?.length) continue;
			const letter = (pi === 0 && !used.has(local) ? local : null) ?? nextFreeLetter(used) ?? `${pi + 1}${local}`;
			used.add(letter);
			const secs = Math.max(0.1, emb.seconds || 0);
			globals.push({ letter, sum: emb.vector.map((x) => x * secs), seconds: secs });
			map.set(local, letter);
		}
		const rewrite = (sp: string): string => {
			const hit = map.get(sp);
			if (hit) return hit;
			const fb = pi === 0 ? sp : `${pi + 1}${sp}`;
			used.add(fb);
			map.set(sp, fb);
			return fb;
		};
		for (const u of part.utts) {
			// the dominant voice maps first so crosstalk letters never claim
			// its fallback seat; crosstalk letters are part-scoped like any
			// other and follow the same mapping
			const speaker = rewrite(u.speaker);
			utts.push({
				...u,
				speaker,
				start: (u.start ?? 0) + part.offsetMs,
				end: u.end != null ? u.end + part.offsetMs : undefined,
				...(u.crosstalk?.length ? { crosstalk: u.crosstalk.map(rewrite) } : {}),
			});
		}
		for (const t of part.turnEmbeddings ?? []) {
			turnEmbeddings.push({ ...t, speaker: rewrite(t.speaker), start: t.start + part.offsetMs, end: t.end + part.offsetMs });
		}
	}
	const embeddings: Record<string, SpeakerEmbedding> = {};
	for (const g of globals) {
		if (g.seconds <= 0) continue;
		const mean = l2normalize(g.sum);
		if (mean.some((x) => x !== 0)) embeddings[g.letter] = { vector: mean, seconds: Math.round(g.seconds * 100) / 100 };
	}
	return { utts, embeddings, turnEmbeddings };
}

/** What a cluster review found: possibly-relabeled utterances, a per-letter
 *  name suggestion where the voices were confident, the splits it performed,
 *  and post-review per-letter mean vectors for enrollment. */
export interface ClusterReview {
	utts: Utterance[];
	/** Letter -> who this cluster's voice says it is (the spark suggestion). */
	guesses: Record<string, { person: string; seconds: number; score: number }>;
	/** Clusters the voices disagreed about, and where the minority turns went. */
	splits: { from: string; to: string; person: string; turns: number; seconds: number }[];
	/** Post-review per-letter mean vectors, so naming a letter can enroll it. */
	letterEmbeddings: Record<string, SpeakerEmbedding>;
}

/** Audit diarization clusters against the voiceprint library, turn by turn.
 *
 *  The classic failure in a long many-person meeting is a merged cluster: a
 *  "Speaker 2" that is secretly two or three people, which a per-cluster mean
 *  (or any naming built on it) can only ever get wrong. So every substantial
 *  turn is matched on its own evidence; when a letter's matched turns
 *  disagree, the minority voice's turns move to the letter that voice
 *  already dominates, or to a fresh letter. The bar to move turns is
 *  deliberately higher than the bar to suggest a name (splitMinSeconds
 *  across splitMinTurns): a split rewrites the transcript's attribution,
 *  a suggestion is one click to ignore.
 *
 *  Names are still never asserted here: `guesses` feeds the same one-click
 *  suggestion rail as the text guesses, and a letter whose voices stay
 *  ambiguous simply stays a letter. All thresholds are placeholders to
 *  calibrate against real recordings, like the match thresholds. */
export function reviewSpeakerClusters(
	utts: Utterance[],
	turnEmbeddings: TurnEmbedding[],
	lib: VoiceprintLibrary,
	opts: {
		threshold?: number;
		margin?: number;
		matchMinSeconds?: number;
		splitMinSeconds?: number;
		splitMinTurns?: number;
		guessMinSeconds?: number;
		guessMinShare?: number;
	} = {}
): ClusterReview {
	const matchMin = opts.matchMinSeconds ?? 3;
	const splitMinSeconds = opts.splitMinSeconds ?? 8;
	const splitMinTurns = opts.splitMinTurns ?? 2;
	const guessMinSeconds = opts.guessMinSeconds ?? 6;
	const guessMinShare = opts.guessMinShare ?? 0.6;

	const matched = new Map<TurnEmbedding, { person: string; score: number }>();
	if (lib.length) {
		for (const t of turnEmbeddings) {
			if (!isAnonymousLabel(t.speaker) || t.seconds < matchMin) continue;
			const m = matchVoiceprint(lib, t.vector, opts);
			if (m) matched.set(t, m);
		}
	}

	type Tally = Map<string, { seconds: number; turns: TurnEmbedding[]; score: number }>;
	const tally = (moves?: Map<TurnEmbedding, string>): Map<string, Tally> => {
		const by = new Map<string, Tally>();
		for (const [t, m] of matched) {
			const letter = moves?.get(t) ?? t.speaker;
			let per = by.get(letter);
			if (!per) by.set(letter, (per = new Map<string, { seconds: number; turns: TurnEmbedding[]; score: number }>()));
			let e = per.get(m.person);
			if (!e) per.set(m.person, (e = { seconds: 0, turns: [], score: 0 }));
			e.seconds += t.seconds;
			e.score += m.score * t.seconds;
			e.turns.push(t);
		}
		return by;
	};
	const dominantOf = (per: Tally): string => {
		let who = "";
		let secs = -1;
		for (const [person, e] of per)
			if (e.seconds > secs) {
				secs = e.seconds;
				who = person;
			}
		return who;
	};

	const first = tally();
	const dominants = new Map<string, string>();
	for (const [letter, per] of first) dominants.set(letter, dominantOf(per));

	const used = new Set<string>(utts.map((u) => u.speaker));
	// crosstalk-only voices hold letters too; a split must not mint one of
	// those for a different person
	for (const u of utts) for (const l of u.crosstalk ?? []) used.add(l);
	for (const t of turnEmbeddings) used.add(t.speaker);
	const moves = new Map<TurnEmbedding, string>();
	const splits: ClusterReview["splits"] = [];
	for (const [letter, per] of first) {
		const dom = dominants.get(letter) ?? "";
		for (const [person, e] of per) {
			if (person === dom) continue;
			if (e.seconds < splitMinSeconds || e.turns.length < splitMinTurns) continue;
			let to = "";
			for (const [l2, d2] of dominants)
				if (l2 !== letter && d2 === person) {
					to = l2;
					break;
				}
			if (!to) {
				const fresh = nextFreeLetter(used);
				if (!fresh) continue; // out of letters: leave the cluster alone
				to = fresh;
				used.add(to);
				dominants.set(to, person);
			}
			for (const t of e.turns) moves.set(t, to);
			splits.push({ from: letter, to, person, turns: e.turns.length, seconds: Math.round(e.seconds * 100) / 100 });
		}
	}

	// carry the moves onto the utterances by time overlap: an utterance that
	// mostly sits inside a moved turn moves with it
	let outUtts = utts;
	if (moves.size) {
		const moveList = [...moves].map(([t, to]) => ({ t, to }));
		outUtts = utts.map((u) => {
			if (u.start == null) return u;
			const us = u.start;
			const ue = u.end ?? u.start;
			const dur = Math.max(1, ue - us);
			for (const { t, to } of moveList) {
				if (t.speaker !== u.speaker) continue;
				const ov = Math.min(ue, t.end) - Math.max(us, t.start);
				if (ov >= dur * 0.5) {
					// a crosstalk turn keeps its set of active voices: the old
					// dominant stays audible in the overlap even though the
					// words now belong to `to`
					const others = u.crosstalk ? [...new Set([u.speaker, ...u.crosstalk])].filter((l) => l !== to) : undefined;
					return { ...u, speaker: to, ...(others ? { crosstalk: others } : {}) };
				}
			}
			return u;
		});
	}

	const finalTally = tally(moves);
	const guesses: ClusterReview["guesses"] = {};
	for (const [letter, per] of finalTally) {
		let total = 0;
		for (const e of per.values()) total += e.seconds;
		const dom = dominantOf(per);
		const e = dom ? per.get(dom) : undefined;
		if (!e || e.seconds < guessMinSeconds || e.seconds < total * guessMinShare) continue;
		guesses[letter] = { person: dom, seconds: Math.round(e.seconds * 100) / 100, score: e.score / e.seconds };
	}

	const sums = new Map<string, { sum: number[]; seconds: number }>();
	for (const t of turnEmbeddings) {
		const letter = moves.get(t) ?? t.speaker;
		if (!isAnonymousLabel(letter) || !t.vector.length || t.seconds <= 0) continue;
		let s = sums.get(letter);
		if (!s) sums.set(letter, (s = { sum: t.vector.map(() => 0), seconds: 0 }));
		for (let i = 0; i < s.sum.length && i < t.vector.length; i++) s.sum[i] += t.vector[i] * t.seconds;
		s.seconds += t.seconds;
	}
	const letterEmbeddings: Record<string, SpeakerEmbedding> = {};
	for (const [letter, s] of sums) {
		if (s.seconds <= 0) continue;
		const mean = l2normalize(s.sum);
		if (mean.some((x) => x !== 0)) letterEmbeddings[letter] = { vector: mean, seconds: Math.round(s.seconds * 100) / 100 };
	}
	return { utts: outUtts, guesses, splits, letterEmbeddings };
}

/** How many voices to let the diarizer look for, from the meeting's invite.
 *  Only a MAX: a ceiling from the attendee list reins in the clusterer's
 *  habit of inventing extra speakers in a big meeting. Never a min: a
 *  meeting where two of ten invitees did the talking is normal, and a floor
 *  would force one real voice apart into phantom speakers. Rooms on the
 *  invite ("Dallas Conference") only loosen the ceiling, which is safe.
 *  Null when the list is too small to constrain anything. */
export function expectedSpeakerBounds(attendees: string[] | undefined | null): { maxSpeakers: number } | null {
	const n = (attendees ?? []).map((a) => String(a ?? "").trim()).filter((a) => a && !/^Speaker /.test(a)).length;
	return n >= 2 ? { maxSpeakers: Math.min(26, n) } : null;
}

/** Pull the vectors out of an OpenAI-shaped embeddings response
 *  ({ data: [{ embedding: [...] }] }); [] when the shape is unexpected. */
/** A duration a person can read at a glance: seconds under a minute, then
 *  minutes, then hours and minutes. Rounded, never precise-looking, because an
 *  estimate that reads like a measurement invites the wrong kind of trust. */
export function fmtDuration(ms: number): string {
	if (!isFinite(ms) || ms < 0) return "";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

/** The line a long job shows while it runs: how far along, and how much longer.
 *
 *  The estimate comes from the rate actually observed so far rather than any
 *  guess baked in ahead of time, which is the only way it survives a machine
 *  that is faster or slower than whoever wrote the code assumed. It stays quiet
 *  until enough work has finished to mean anything: a remaining-time figure
 *  extrapolated from one item out of six thousand is noise dressed as fact. */
export function progressLine(label: string, done: number, total: number, elapsedMs: number): string {
	if (total <= 0) return label;
	const pct = Math.min(100, Math.round((done / total) * 100));
	const head = `${label} ${done}/${total} (${pct}%)`;
	if (done < 3 || done >= total || elapsedMs <= 0) return head;
	const remaining = (elapsedMs / done) * (total - done);
	const eta = fmtDuration(remaining);
	return eta ? `${head} · about ${eta} left` : head;
}

/** Interface names that belong to tunnels and virtual switches rather than the
 *  network the user's other devices are actually on. */
const VIRTUAL_IFACE = /(nordlynx|tailscale|wireguard|zerotier|vethernet|hyper-?v|virtualbox|vmware|wsl|docker|tap-|tun\d|openvpn|proton|mullvad|expressvpn|surfshark|cloudflare|warp|bluetooth|loopback)/i;

/** This machine's address on the network its siblings can reach.
 *
 *  Picking the first private IPv4 is wrong on any machine with a VPN: a tunnel
 *  hands out a 10.x address that answers locally but is unreachable from the
 *  phone on the sofa, and that address then syncs to the whole fleet as a dead
 *  endpoint. So interfaces are scored: a tunnel or virtual switch is pushed to
 *  the back by name, and 192.168 (overwhelmingly a real LAN) is preferred over
 *  10.x (legitimate, but also what most VPNs issue).
 *
 *  Returns "localhost" when nothing qualifies, which still works on this
 *  device and is honest about not serving others. */
export function pickLanAddress(ifaces: Record<string, { family: string; internal: boolean; address: string }[] | undefined>): string {
	const scored: { address: string; score: number }[] = [];
	for (const [name, list] of Object.entries(ifaces ?? {})) {
		for (const i of list ?? []) {
			if (i.family !== "IPv4" || i.internal) continue;
			if (!/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue;
			let score = i.address.startsWith("192.168.") ? 30 : /^172\./.test(i.address) ? 20 : 10;
			if (VIRTUAL_IFACE.test(name)) score -= 100;
			scored.push({ address: i.address, score });
		}
	}
	scored.sort((a, b) => b.score - a.score);
	return scored[0]?.address ?? "localhost";
}

export function parseEmbeddingResponse(json: unknown): number[][] {
	const data = (json as { data?: { embedding?: number[] }[] })?.data;
	if (!Array.isArray(data)) return [];
	return data.map((d) => (Array.isArray(d?.embedding) ? d.embedding : []));
}

/** Reciprocal-rank fusion of several ranked hit lists into one, deduped by path
 *  (a note ranked by both keyword and meaning rises). The first list wins the
 *  representative hit, so keyword chunk text is preferred over a note excerpt. */
export function fuseHits(lists: { path: string; heading: string; text: string }[][], k: number, rrfK = 60): { path: string; heading: string; text: string }[] {
	const score = new Map<string, number>();
	const rep = new Map<string, { path: string; heading: string; text: string }>();
	for (const list of lists)
		list.forEach((h, i) => {
			score.set(h.path, (score.get(h.path) ?? 0) + 1 / (rrfK + i));
			if (!rep.has(h.path)) rep.set(h.path, h);
		});
	return [...score.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, k)
		.map(([p]) => rep.get(p)!);
}

/* ---------------- finances: rollups over processed documents ---------------- */

export interface FinanceDoc {
	title: string;
	path: string;
	vendor: string;
	docType: string;
	amount: number;
	currency: string;
	date: string;
	due: string;
}

/** Group numbers with thousands separators; whole numbers stay decimal-free. */
function money(n: number): string {
	const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
	return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const withCur = (n: number, cur: string) => `${cur ? cur + " " : ""}${money(n)}`;

/** A finances overview from processed documents: per-currency totals, upcoming
 *  and overdue bills, and spending grouped by vendor and by month. Amounts are
 *  kept per-currency so nothing sums across currencies. type capture-finance,
 *  generated, so meeting-only surfaces ignore it. */
export function buildFinancesRollup(docs: FinanceDoc[], today: string): string {
	const fm = ["---", "type: capture-finance", `date: ${today}`, "generated: true", "---"].join("\n");
	const parts = [`${fm}\n# Finances · as of ${today}`];
	const withAmt = docs.filter((x) => x.amount > 0);

	// per-currency totals
	const byCur = new Map<string, { total: number; n: number }>();
	for (const x of withAmt) {
		const c = byCur.get(x.currency) ?? { total: 0, n: 0 };
		c.total += x.amount;
		c.n++;
		byCur.set(x.currency, c);
	}
	parts.push(
		`## Totals\n\n` +
			([...byCur.entries()].sort((a, b) => b[1].total - a[1].total).map(([cur, c]) => `- **${cur || "Unknown"}:** ${money(c.total)} across ${c.n} document${c.n === 1 ? "" : "s"}`).join("\n") ||
				"*No documents with amounts yet.*")
	);

	// upcoming and overdue bills (anything with a due date)
	const bills = docs.filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.due)).sort((a, b) => (a.due < b.due ? -1 : 1));
	if (bills.length)
		parts.push(
			`## Upcoming & overdue bills\n\n` +
				"| Due | Vendor | Amount |\n| --- | --- | --- |\n" +
				bills.map((x) => `| ${x.due < today ? "🔴 " : ""}${x.due} | ${noteLink(x.path, x.vendor || x.title)} | ${x.amount > 0 ? withCur(x.amount, x.currency) : "-"} |`).join("\n")
		);

	// by vendor, then by month, keyed per-currency so each total is valid
	const group = (keyOf: (x: FinanceDoc) => string, heading: string, label: string, sortDesc = true) => {
		const g = new Map<string, { key: string; cur: string; total: number; n: number }>();
		for (const x of withAmt) {
			const k = `${keyOf(x)}\u0000${x.currency}`;
			const e = g.get(k) ?? { key: keyOf(x), cur: x.currency, total: 0, n: 0 };
			e.total += x.amount;
			e.n++;
			g.set(k, e);
		}
		if (!g.size) return;
		const rows = [...g.values()].sort((a, b) => (sortDesc ? b.total - a.total : a.key < b.key ? 1 : -1));
		parts.push(
			`## ${heading}\n\n` +
				`| ${label} | Documents | Amount |\n| --- | --- | --- |\n` +
				rows.map((r) => `| ${r.key || "Unknown"} | ${r.n} | ${withCur(r.total, r.cur)} |`).join("\n")
		);
	};
	group((x) => x.vendor, "By vendor", "Vendor", true);
	group((x) => (/^\d{4}-\d{2}/.test(x.date) ? x.date.slice(0, 7) : "Undated"), "By month", "Month", false);

	return parts.join("\n\n") + "\n";
}

/* ---------------- drafting from context ---------------- */

export type DraftKind = "followup" | "status" | "recap" | "thanks" | "custom";

/** The draft types the writer offers. `desc` describes the piece to Claude;
 *  custom has none and rides on the user's own instruction. */
export const DRAFT_KINDS: { id: DraftKind; label: string; desc: string }[] = [
	{ id: "followup", label: "Follow-up email", desc: "a concise follow-up email to the attendees: a brief thanks, the decisions that were made, and a clear list of who owes what by when" },
	{ id: "status", label: "Status update", desc: "a short status update for a manager or stakeholder: what was decided, current progress, any risks or blockers, and the next steps" },
	{ id: "recap", label: "Chat recap", desc: "a skimmable chat recap message: a one-line summary, then tight bullets for decisions, action items, and open questions" },
	{ id: "thanks", label: "Thank-you note", desc: "a brief, warm thank-you note to the attendees that references something specific from the discussion" },
	{ id: "custom", label: "Custom instruction", desc: "" },
];

/** Distill a capture note into a compact drafting context: title, date,
 *  attendees, and the extracted sections (summary, decisions, action items,
 *  questions), with the transcript and embeds excluded. */
export function buildDraftContext(md: string): string {
	const m = parseCaptureForExport(md);
	const lines: string[] = [`Title: ${m.title}`];
	if (m.dateLine) lines.push(`Date: ${m.dateLine}`);
	if (m.attendees.length) lines.push(`Attendees: ${m.attendees.join(", ")}`);
	for (const s of m.sections) {
		if (s.kind === "tasks" && s.tasks.length)
			lines.push(`\n${s.heading}:\n` + s.tasks.map((t) => `- ${t.task}${t.owner ? ` (owner: ${t.owner})` : ""}${t.deadline ? ` (due ${t.deadline})` : ""}`).join("\n"));
		else {
			const body = [...s.paragraphs, ...s.bullets.map((b) => `- ${b}`)].join("\n").trim();
			if (body) lines.push(`\n${s.heading}:\n${body}`);
		}
	}
	return lines.join("\n").trim();
}

/** System + user messages for a draft. `kindDesc` is the DRAFT_KINDS desc (empty
 *  for custom, where the instruction carries the ask). Grounded strictly in the
 *  provided context so the writer never invents facts. */
export function buildDraftPrompt(kindDesc: string, context: string, opts: { tone?: string; instruction?: string; yourName?: string }): { system: string; user: string } {
	const tone = opts.tone && opts.tone.toLowerCase() !== "neutral" ? ` Write in a ${opts.tone.toLowerCase()} tone.` : "";
	const signoff = opts.yourName?.trim() ? ` Sign off as ${opts.yourName.trim()}.` : "";
	const system =
		`You are the user's writing assistant. Draft ${kindDesc || "the message the user describes"} based ONLY on the provided context; ` +
		`never invent facts, names, numbers, or commitments that are not present.${tone}${signoff} ` +
		`Make it ready to send: no bracketed placeholders unless information is genuinely missing, no meta commentary or preamble, just the message itself in Markdown.`;
	const user =
		`Context:\n"""\n${context}\n"""` + (opts.instruction?.trim() ? `\n\nAdditional instructions: ${opts.instruction.trim()}` : "") + `\n\nWrite it now.`;
	return { system, user };
}

/* ---------------- the morning briefing ---------------- */

/** The due date on a task line ("📅 YYYY-MM-DD"), or "" when undated. */
export function taskDueDate(line: string): string {
	return line.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
}

export interface BriefingData {
	date: string;
	meetings: { time: string; title: string; path: string | null; join: string | null; attendees?: string[]; agenda?: string; location?: string }[];
	commitments: { task: string; owner: string; due: string; fromPath: string; overdue: boolean }[];
	dueDocs: { title: string; amount: string; due: string; path: string; overdue: boolean }[];
	questions: { text: string; fromPath: string }[];
}

/** The start-of-day note: today's meetings, commitments coming due (overdue
 *  first), documents due soon, and open questions worth remembering. Generated
 *  and refreshable; type capture-briefing so meeting-only surfaces ignore it. */
export function buildMorningBriefing(d: BriefingData, longDateStr: string): string {
	const fm = ["---", "type: capture-briefing", `date: ${d.date}`, "generated: true", "---"].join("\n");
	const parts = [`${fm}\n# Good morning · ${longDateStr}`];

	const meetingBlock = (m: BriefingData["meetings"][number]) => {
		const head = `- ${m.time ? `**${m.time}** · ` : ""}${m.path ? noteLink(m.path, m.title) : m.title}${m.join ? ` · [join](${m.join})` : ""}`;
		const body: string[] = [];
		if (m.location) body.push(`> **Where:** ${m.location}`);
		if (m.attendees?.length) body.push(`> **Attendees:** ${m.attendees.join(", ")}`);
		if (m.agenda?.trim()) {
			body.push(`> **Agenda:**`);
			for (const line of m.agenda.trim().split("\n")) body.push(`> ${line}`);
		}
		if (!body.length) return head;
		// the foldable callout is indented two spaces so it belongs to the list item
		return head + "\n" + ["> [!info]- Details", ...body].map((l) => `  ${l}`).join("\n");
	};
	parts.push(`## Today's meetings (${d.meetings.length})\n\n` + (d.meetings.length ? d.meetings.map(meetingBlock).join("\n\n") : "*Nothing scheduled.*"));

	if (d.commitments.length) {
		const line = (c: BriefingData["commitments"][number]) =>
			`- ${c.overdue ? "🔴 " : ""}${c.task}${c.owner && c.owner !== "Unassigned" ? `, [[${c.owner}]]` : ""} · due ${c.due} *(${noteLink(c.fromPath)})*`;
		const over = d.commitments.filter((c) => c.overdue);
		const soon = d.commitments.filter((c) => !c.overdue);
		const blocks = [`## Commitments`];
		if (over.length) blocks.push(`**Overdue (${over.length})**\n\n` + over.map(line).join("\n"));
		if (soon.length) blocks.push(`**Coming due (${soon.length})**\n\n` + soon.map(line).join("\n"));
		parts.push(blocks.join("\n\n"));
	}

	if (d.dueDocs.length)
		parts.push(
			`## Bills & documents due\n\n` +
				d.dueDocs
					.map((x) => `- ${x.overdue ? "🔴 " : ""}${noteLink(x.path, x.title)}${x.amount ? ` · ${x.amount}` : ""} · due ${x.due}`)
					.join("\n")
		);

	if (d.questions.length)
		parts.push(`## Open questions\n\n` + d.questions.slice(0, 8).map((x) => `- ${x.text} *(${noteLink(x.fromPath)})*`).join("\n"));

	if (!d.meetings.length && !d.commitments.length && !d.dueDocs.length && !d.questions.length)
		parts.push("*A clear day: nothing scheduled, nothing due. Enjoy it.*");

	return parts.join("\n\n") + "\n";
}

/* ---------------- live copilot ---------------- */

export interface LiveTurn {
	ms: number;
	text: string;
}

/** The last `sinceMs` worth of finished turns, tail-capped for the prompt. */
export function recentTurnsText(turns: LiveTurn[], nowMs: number, windowMs: number, capChars = 12000): string {
	const text = turns
		.filter((t) => nowMs - t.ms < windowMs)
		.map((t) => t.text)
		.join("\n");
	return text.length > capChars ? text.slice(-capChars) : text;
}

export function buildCatchUpPrompt(text: string, minutes: number): { system: string; user: string } {
	return {
		system:
			"You summarize the last few minutes of a live meeting for someone who zoned out. Three to five short bullets, most recent development last, no preamble.",
		user: `The last ~${minutes} minutes of the conversation:\n"""\n${text}\n"""`,
	};
}

export function buildLiveActionsPrompt(text: string): { system: string; user: string } {
	return {
		system:
			"You spot NEW commitments in live meeting speech. Reply with one commitment per line as 'Task, owner if stated'; reply exactly NONE when there are none. Never invent owners.",
		user: `Recent speech:\n"""\n${text}\n"""`,
	};
}

/** One-item-per-line reply → clean list (bullets stripped, NONE dropped). */
export function parseLineList(reply: string, cap = 10): string[] {
	const out: string[] = [];
	for (const raw of reply.split("\n")) {
		const line = raw.replace(/^[\s\-*\d.)]+/, "").trim();
		if (!line || /^none\.?$/i.test(line)) continue;
		if (!out.includes(line)) out.push(line);
	}
	return out.slice(0, cap);
}

/* ---------------- ask filters + cost ---------------- */

export interface HitMeta {
	date?: string;
	attendees?: string[];
}

/** Keep hits whose note metadata satisfies the date/attendee filters. Notes
 *  without metadata only survive when no filter needs it. */
export function filterHitsByMeta<T extends { path: string }>(
	hits: T[],
	metaFor: (path: string) => HitMeta | null,
	f: { after?: string | null; attendee?: string | null }
): T[] {
	if (!f.after && !f.attendee) return hits;
	return hits.filter((h) => {
		const m = metaFor(h.path);
		if (f.after && !(m?.date && m.date >= f.after)) return false;
		if (f.attendee && !m?.attendees?.includes(f.attendee)) return false;
		return true;
	});
}

/** Rough per-model rates (USD per million tokens in/out) plus per-hour audio
 *  rates, order-of-magnitude trust, not accounting; every figure is prefixed ≈.
 *  Keep these current with published pricing: Haiku 4.5 $1/$5, Sonnet $3/$15,
 *  Opus 4.x $5/$25 (NOT the old Opus 3 $15/$75). */
const TOKEN_RATES: [string, number, number][] = [
	["haiku", 1, 5],
	["sonnet", 3, 15],
	["opus", 5, 25],
];

/** Per-hour transcription rates: AssemblyAI Universal ~$0.20, Deepgram Nova
 *  ~$0.26, cloud Whisper ~$0.06 (self-hosted is free but we cannot tell).
 *  WhisperX is your own machine and meters at $0. */
const AUDIO_RATES: Record<string, number> = { assemblyai: 0.2, deepgram: 0.26, whisper: 0.06, whisperx: 0 };

/** Estimated USD for a Claude call from its token counts. Unknown models cost 0
 *  (we would rather under-report than invent a rate). */
export function llmCostUsd(model: string, tokensIn: number, tokensOut: number): number {
	const rate = TOKEN_RATES.find(([k]) => model.toLowerCase().includes(k));
	return rate ? (tokensIn / 1e6) * rate[1] + (tokensOut / 1e6) * rate[2] : 0;
}

/** The settings an AI call needs to know where to go. A subset of the plugin
 *  settings so tests can hand in a plain object. */
export interface LlmSettings {
	llmProvider: string;
	llmEndpoint: string;
	llmKey: string;
	llmModel: string;
	anthropicKey: string;
	anthropicModel: string;
}

/** Where an AI call goes for the configured provider. `baseURL: null` means
 *  Anthropic's own cloud. The custom path is any server speaking the Anthropic
 *  Messages API (Ollama 0.14+, LM Studio, llama.cpp); most ignore the key, so
 *  a placeholder goes out when none is set, the SDK requires one. A custom
 *  provider with no endpoint falls back to the cloud rather than erroring,
 *  so a half-finished settings change never strands a capture mid-pipeline. */
export function resolveLlmTarget(s: LlmSettings): { baseURL: string | null; apiKey: string; model: string } {
	const endpoint = s.llmEndpoint.trim().replace(/\/+$/, "");
	if (s.llmProvider === "custom" && endpoint)
		return { baseURL: endpoint, apiKey: s.llmKey.trim() || "local", model: s.llmModel.trim() };
	return { baseURL: null, apiKey: s.anthropicKey, model: s.anthropicModel };
}

/** True when an AI model is configured at all: the Anthropic key, or a custom
 *  endpoint with a model name. Every AI-written surface gates on this; without
 *  it captures still transcribe, they just skip the extracted sections. */
export function llmConfigured(s: LlmSettings): boolean {
	return s.llmProvider === "custom" ? !!(s.llmEndpoint.trim() && s.llmModel.trim()) : !!s.anthropicKey;
}

/** Estimated USD for a stretch of transcription from its provider and minutes. */
export function transcriptionCostUsd(provider: string | null, audioMinutes: number): number {
	if (!provider || audioMinutes <= 0) return 0;
	return (audioMinutes / 60) * (AUDIO_RATES[provider] ?? 0);
}

/** A Deepgram pre-recorded response, only the fields we read. */
export interface DeepgramResponse {
	results?: {
		channels?: { alternatives?: { transcript?: string }[] }[];
		utterances?: { start?: number; end?: number; transcript?: string; speaker?: number }[];
	};
}

/** Map a diarized Deepgram response to the shared Utterance shape: its integer
 *  speaker becomes a letter (0 -> A) like AssemblyAI, and seconds become the ms
 *  the rest of the pipeline expects. */
/** A WhisperX server response, only the fields we read. Segment times are
 *  seconds; speakers arrive as "SPEAKER_00"-style ids (or missing where
 *  diarization could not tell). */
export interface WhisperXResponse {
	/** `speakers` lists EVERY voice the diarizer heard at once during the
	 *  segment (dominant first), present only when there were two or more:
	 *  crosstalk. `speaker` stays the single dominant voice the words were
	 *  attributed to. */
	segments?: { start?: number; end?: number; text?: string; speaker?: string; speakers?: string[] }[];
	/** Per-speaker mean voice embedding, keyed by the server's own speaker id
	 *  ("SPEAKER_00"). Present only when the recording was diarized and the
	 *  client asked for embeddings. parseWhisperX re-keys these to the A/B/C
	 *  letters it assigns, so they line up with what the user names. */
	embeddings?: Record<string, SpeakerEmbedding>;
	/** Per-turn voice vectors (one per diarized turn long enough to trust),
	 *  so a cluster can be audited turn by turn instead of only as a mean.
	 *  Times are seconds within this recording; parseWhisperX re-keys the
	 *  speaker to its letter and converts times to ms. */
	segment_embeddings?: { speaker?: string; start?: number; end?: number; seconds?: number; vector?: number[] }[];
}

/** WhisperX diarized segments → the same utterance shape the cloud diarizers
 *  produce, so naming, talk shares, and audio-jump work identically. Speaker
 *  ids map to letters in order of first appearance (SPEAKER_03 heard first is
 *  still "A"); a segment with no speaker continues whoever was last talking.
 *  Sentence-level segments coalesce into turns. If NOTHING carries a speaker,
 *  the whole file is undiarized: text only, like plain Whisper. A segment the
 *  server flagged as crosstalk (its `speakers` list) carries the other active
 *  voices on `crosstalk`, letters included, so the transcript can label the
 *  overlap honestly instead of crediting one name. */
export function parseWhisperX(json: WhisperXResponse): {
	text: string;
	utts: Utterance[] | null;
	embeddings?: Record<string, SpeakerEmbedding>;
	/** Per-turn voice vectors re-keyed to letters, ms times. */
	turnEmbeddings?: TurnEmbedding[];
	/** The utterances BEFORE coalescing: turn-sized pieces the cluster review
	 *  can relabel individually. `utts` merges neighbors and would weld a
	 *  misfiled sentence to its neighbor, beyond any later fix. */
	fine?: Utterance[];
} {
	const segs = (json.segments ?? []).filter((sg) => (sg.text ?? "").trim());
	const anySpeaker = segs.some((sg) => typeof sg.speaker === "string" && sg.speaker);
	const text = segs.map((sg) => (sg.text ?? "").trim()).join(" ").trim();
	if (!anySpeaker) return { text, utts: null };
	const letters = new Map<string, string>();
	const letterFor = (id: string): string => {
		if (!letters.has(id)) letters.set(id, String.fromCharCode(65 + Math.min(25, letters.size)));
		return letters.get(id)!;
	};
	// a leading unlabeled segment continues the first person who IS labeled,
	// rather than minting a phantom speaker for it
	let last = segs.find((sg) => typeof sg.speaker === "string" && sg.speaker)?.speaker ?? "";
	const utts: Utterance[] = segs.map((sg) => {
		const id = typeof sg.speaker === "string" && sg.speaker ? sg.speaker : last;
		last = id;
		const speaker = letterFor(id);
		// a crosstalk voice gets a letter even if it never dominates a segment
		// of its own (the interjector case), that letter can appear inside
		// Crosstalk labels, be named, and keep its server-side voice embedding
		const others = (Array.isArray(sg.speakers) ? sg.speakers : [])
			.filter((s): s is string => typeof s === "string" && !!s)
			.map(letterFor)
			.filter((l, i, arr) => l !== speaker && arr.indexOf(l) === i);
		return {
			speaker,
			text: (sg.text ?? "").trim(),
			start: Math.round((sg.start ?? 0) * 1000),
			end: Math.round((sg.end ?? 0) * 1000),
			...(others.length ? { crosstalk: others } : {}),
		};
	});
	const merged = coalesceUtterances(utts);
	// re-key the server's per-speaker embeddings to the SAME letters, so naming a
	// letter enrolls the right voice; a server id with no letter (never spoke a
	// kept segment) is dropped
	let embeddings: Record<string, SpeakerEmbedding> | undefined;
	if (json.embeddings) {
		const out: Record<string, SpeakerEmbedding> = {};
		for (const [serverId, emb] of Object.entries(json.embeddings)) {
			const letter = letters.get(serverId);
			if (letter && Array.isArray(emb?.vector) && emb.vector.length) out[letter] = { vector: emb.vector, seconds: Number(emb.seconds) || 0 };
		}
		if (Object.keys(out).length) embeddings = out;
	}
	// per-turn vectors ride along under the same letters; a turn whose server
	// id never spoke a kept segment has no letter and is dropped with it
	let turnEmbeddings: TurnEmbedding[] | undefined;
	if (Array.isArray(json.segment_embeddings)) {
		const turns: TurnEmbedding[] = [];
		for (const t of json.segment_embeddings) {
			const letter = typeof t?.speaker === "string" ? letters.get(t.speaker) : undefined;
			if (!letter || !Array.isArray(t.vector) || !t.vector.length) continue;
			turns.push({
				speaker: letter,
				start: Math.round((t.start ?? 0) * 1000),
				end: Math.round((t.end ?? 0) * 1000),
				seconds: Number(t.seconds) || 0,
				vector: t.vector.filter((x): x is number => typeof x === "number" && Number.isFinite(x)),
			});
		}
		if (turns.length) turnEmbeddings = turns;
	}
	return merged.length ? { text, utts: merged, embeddings, turnEmbeddings, fine: utts } : { text, utts: null, embeddings, turnEmbeddings };
}

export function parseDeepgram(json: DeepgramResponse): { text: string; utts: Utterance[] | null } {
	const utts: Utterance[] = (json.results?.utterances ?? [])
		.map((u) => ({
			speaker: String.fromCharCode(65 + Math.max(0, Math.min(25, u.speaker ?? 0))),
			text: (u.transcript ?? "").trim(),
			start: Math.round((u.start ?? 0) * 1000),
			end: Math.round((u.end ?? 0) * 1000),
		}))
		.filter((u) => u.text);
	const text = (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim() || utts.map((u) => u.text).join(" ");
	return utts.length ? { text, utts } : { text, utts: null };
}

export function estimateCost(
	model: string,
	tokensIn: number,
	tokensOut: number,
	audioMinutes: number,
	provider: "assemblyai" | "whisper" | "deepgram" | "whisperx" | null
): string | null {
	const usd = llmCostUsd(model, tokensIn, tokensOut) + transcriptionCostUsd(provider, audioMinutes);
	const tokens = tokensIn + tokensOut;
	if (usd <= 0 && tokens <= 0) return null;
	const bits = [audioMinutes > 0 ? `${Math.round(audioMinutes)} min audio` : "", tokens > 0 ? `${(tokens / 1000).toFixed(1)}k tokens` : ""]
		.filter(Boolean)
		.join(", ");
	// a $0 line is real (a local model metering its tokens), so it must not
	// round UP to $0.01 and invent a bill that was never sent
	return `≈$${usd <= 0 ? "0.00" : usd < 0.01 ? "0.01" : usd.toFixed(2)}${bits ? ` (${bits})` : ""}`;
}

/* ---------------- ongoing usage ledger ---------------- */

/** One logged AI action. LLM events carry tokens (minutes 0); transcription
 *  events carry minutes (tokens 0). `usd` is this action's estimated cost, so a
 *  summary never has to re-derive rates. */
export interface UsageEvent {
	ts: number; // epoch ms
	feature: string; // meeting | chat | ask | ocr | names | agenda | summary | transcribe
	model: string; // Claude model id, or "<provider>/<model>" for transcription
	tokIn: number;
	tokOut: number;
	minutes: number;
	usd: number;
}

/** Append an event and keep only the most recent `cap`, so the ledger can't grow
 *  without bound in a long-lived vault. Pure: returns a new array. */
export function pushUsageEvent(ledger: UsageEvent[], event: UsageEvent, cap = 5000): UsageEvent[] {
	const next = ledger.concat(event);
	return next.length > cap ? next.slice(next.length - cap) : next;
}

export interface UsageSummary {
	llmUsd: number;
	audioUsd: number;
	totalUsd: number;
	tokIn: number;
	tokOut: number;
	minutes: number;
	calls: number;
	byModel: { model: string; tokIn: number; tokOut: number; usd: number; calls: number }[];
	byFeature: { feature: string; usd: number; calls: number; tokIn: number; tokOut: number; minutes: number }[];
	byDay: { day: string; llmUsd: number; audioUsd: number; usd: number }[];
}

/** Roll a ledger up into totals and by-model / by-feature / by-day breakdowns.
 *  `since` (epoch ms, default 0) windows the events; `today` (a YYYY-MM-DD... or
 *  full ISO string) fixes the local day only so the by-day keys are stable in
 *  tests. Pure and side-effect free. */
export function summarizeUsage(events: UsageEvent[], since = 0): UsageSummary {
	const inWindow = events.filter((e) => e.ts >= since);
	const models = new Map<string, { model: string; tokIn: number; tokOut: number; usd: number; calls: number }>();
	const features = new Map<string, { feature: string; usd: number; calls: number; tokIn: number; tokOut: number; minutes: number }>();
	const days = new Map<string, { day: string; llmUsd: number; audioUsd: number; usd: number }>();
	let llmUsd = 0,
		audioUsd = 0,
		tokIn = 0,
		tokOut = 0,
		minutes = 0;
	for (const e of inWindow) {
		const isAudio = e.minutes > 0;
		if (isAudio) audioUsd += e.usd;
		else llmUsd += e.usd;
		tokIn += e.tokIn;
		tokOut += e.tokOut;
		minutes += e.minutes;
		const m = models.get(e.model) ?? { model: e.model, tokIn: 0, tokOut: 0, usd: 0, calls: 0 };
		m.tokIn += e.tokIn;
		m.tokOut += e.tokOut;
		m.usd += e.usd;
		m.calls += 1;
		models.set(e.model, m);
		const f = features.get(e.feature) ?? { feature: e.feature, usd: 0, calls: 0, tokIn: 0, tokOut: 0, minutes: 0 };
		f.usd += e.usd;
		f.calls += 1;
		f.tokIn += e.tokIn;
		f.tokOut += e.tokOut;
		f.minutes += e.minutes;
		features.set(e.feature, f);
		const day = dayKey(e.ts);
		const d = days.get(day) ?? { day, llmUsd: 0, audioUsd: 0, usd: 0 };
		if (isAudio) d.audioUsd += e.usd;
		else d.llmUsd += e.usd;
		d.usd += e.usd;
		days.set(day, d);
	}
	return {
		llmUsd,
		audioUsd,
		totalUsd: llmUsd + audioUsd,
		tokIn,
		tokOut,
		minutes,
		calls: inWindow.length,
		byModel: [...models.values()].sort((a, b) => b.usd - a.usd),
		byFeature: [...features.values()].sort((a, b) => b.usd - a.usd),
		byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
	};
}

/** Local-day key (YYYY-MM-DD) for a timestamp, so by-day buckets match the
 *  user's calendar rather than UTC. */
export function dayKey(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------- reliability: retry, backoff, size preflight ---------------- */

/** API errors often arrive as "400 {json}" with the useful text buried inside;
 *  surface that human message, else return the original. */
export function humanizeError(msg: string): string {
	const brace = msg.indexOf("{");
	if (brace >= 0) {
		try {
			const j = JSON.parse(msg.slice(brace)) as { message?: string; error?: { message?: string; error?: { message?: string } } };
			const inner = j?.error?.message ?? j?.message ?? j?.error?.error?.message;
			if (typeof inner === "string" && inner.trim()) return inner.trim();
		} catch {
			/* not JSON after all */
		}
	}
	return msg.trim();
}

/** A setup hint for well-known Microsoft sign-in error codes, so the fix is in
 *  the notice instead of buried in an AADSTS trace. Null when unrecognized. */
export function graphSetupHint(text: string): string | null {
	if (/AADSTS50059|AADSTS50194/.test(text))
		return "Your Azure app is registered for one organization only, so 'common' cannot be used: paste the Directory (tenant) ID from the app's Overview page into the Tenant field.";
	if (/AADSTS700016/.test(text))
		return "The Application (client) ID was not found in this tenant: check both the ID and the Tenant field against the app's Overview page.";
	if (/AADSTS7000218/.test(text)) return "Turn on 'Allow public client flows' under the app's Authentication settings.";
	if (/AADSTS65001|consent/i.test(text) && /AADSTS/.test(text))
		return "The app is missing consent: grant the delegated Calendars.Read permission (or have an admin grant consent) under API permissions.";
	return null;
}

/** Plain exponential backoff (1s, 2s, 4s…), capped and deterministic. */
export function retryDelayMs(attempt: number, baseMs = 1000, capMs = 15000): number {
	return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUS.has(status);
}

/** Best-effort: pull an HTTP status off an SDK error (`.status`) or a
 *  requestUrl error message ("…status 429…"), then decide if it's worth a
 *  retry. Unknown-shape errors are treated as non-retryable. */
export function isRetryableError(e: unknown): boolean {
	const err = e as { status?: unknown; message?: unknown } | null;
	let status: number | null = typeof err?.status === "number" ? err.status : null;
	if (status == null) {
		const m = String(err?.message ?? "").match(/status[":\s]+(\d{3})/i);
		status = m ? Number(m[1]) : null;
	}
	return status != null && isRetryableStatus(status);
}

/** Groq/OpenAI cap the /audio/transcriptions upload at 25 MB. Warn before a
 *  cryptic 413; self-hosted/LAN endpoints have their own limits, so skip. The
 *  private-range checks are anchored to the URL's HOST, not a substring match,
 *  so a cloud endpoint that merely contains "10.2" isn't mistaken for LAN. */
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
export function whisperSizeWarning(bytes: number, endpoint: string): string | null {
	if (bytes <= WHISPER_MAX_BYTES) return null;
	const host = (endpoint.match(/^\w+:\/\/([^/:?#]+)/)?.[1] ?? endpoint).toLowerCase();
	const isLan =
		host === "localhost" ||
		/\.local$/.test(host) ||
		/^127\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		host === "0.0.0.0";
	if (isLan) return null;
	const mb = Math.round(bytes / 1048576);
	return `this file is ~${mb} MB, over the 25 MB Whisper upload limit. Switch the provider to AssemblyAI in settings, or record with part rotation on so long meetings split automatically.`;
}

/* ---------------- copy summary + ISO week + series templates ---------------- */

/** A capture note distilled for pasting into Teams or email: title, the
 *  Speakers line, and the extracted sections, frontmatter, Screens, Moments,
 *  the transcript, and audio embeds stripped; wiki-links flattened to plain text
 *  (they mean nothing in an email).
 *
 *  Screens are cut for the same reason the embeds are: a vault wiki-link to a
 *  .webp is meaningless outside the vault, and flattening it leaves the reader a
 *  filename where a picture was. Screens sit above Moments, so cutting from
 *  whichever comes first takes all three. */
export function formatSummaryForClipboard(md: string): string {
	let body = md.replace(/^---\n[\s\S]*?\n---\n/, "");
	// Media leads the note rather than trailing it, so it is cut on its own and
	// not by the cut-to-the-end below, which would take the whole note with it
	body = body.replace(/(^|\n)## Media\n[\s\S]*?(?=\n## |$)/, "$1");
	body = body.replace(/\n## (Screens|Moments|Transcript)\b[\s\S]*$/m, "\n");
	body = body.replace(/^!\[\[[^\]]*\]\]\s*$/gm, "");
	body = body.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m: string, a: string, b?: string) => (b || a).trim());
	return body.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/* ---------------- folders ---------------- */

/** Normalize a user-entered folder path: trimmed, with leading and trailing
 *  slashes removed. */
export function cleanFolderPath(v: string): string {
	return v.trim().replace(/^\/+|\/+$/g, "");
}

/** A destination folder with {{site}} filled in, so "Social/{{site}}" files X
 *  and TikTok captures apart without a settings tab for each. An unknown or
 *  empty site collapses the token and the separator it would have left behind,
 *  rather than creating a folder with an empty name. */
export function renderFolder(pattern: string, site: string): string {
	const safe = (site || "").replace(/[\\/:*?"<>|]/g, "-").trim();
	return cleanFolderPath(
		(pattern || "")
			.replace(/\{\{site\}\}/g, safe)
			.replace(/\/{2,}/g, "/")
			.replace(/\s{2,}/g, " ")
	);
}

/** Where recordings are written: the dedicated audio folder when it is set,
 *  otherwise the capture (watch) folder. An empty audio folder therefore
 *  yields exactly the capture folder, keeping the old paths unchanged. */
export function resolveRecordingFolder(audioFolder: string, captureFolder: string): string {
	return cleanFolderPath(audioFolder) || captureFolder;
}

/* ---------------- redaction (share/export privacy) ---------------- */

export interface RedactionConfig {
	emails?: boolean;
	phones?: boolean;
	ssns?: boolean;
	cards?: boolean;
	/** Custom terms/names to mask (whole-word, case-insensitive, [[link]]-aware). */
	terms?: string[];
}

/** True when the config would actually mask something. */
export function redactionActive(cfg: RedactionConfig): boolean {
	return !!(cfg.emails || cfg.phones || cfg.ssns || cfg.cards || cfg.terms?.some((t) => t.trim()));
}

/** Mask sensitive text for sharing/export. Runs on note markdown or plain
 *  summary text; each term also matches its `[[wiki-link]]` form so a redacted
 *  name never leaks through a link. Never mutates the source note, callers
 *  apply this only to clipboard/exported output. */
export function redact(text: string, cfg: RedactionConfig): string {
	let out = text;
	if (cfg.emails) out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]");
	if (cfg.ssns) out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[ssn]");
	if (cfg.cards) out = out.replace(/\b\d(?:[ -]?\d){12,15}\b/g, (m) => (m.replace(/\D/g, "").length >= 13 ? "[card]" : m));
	if (cfg.phones) out = out.replace(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]");
	for (const raw of cfg.terms ?? []) {
		const term = raw.trim();
		if (!term) continue;
		out = out.replace(new RegExp(`(?:\\[\\[)?\\b${escapeReg(term)}\\b(?:\\]\\])?`, "gi"), "[redacted]");
	}
	return out;
}

/* ---------------- custom meeting templates ---------------- */

export interface MeetingTemplate {
	id: string;
	name: string;
	sections: ExtractionKey[];
}

/** Built-in templates plus the user's own (settings), for the Process/Re-extract
 *  pickers. Custom templates are keyed "c:<name>" and only keep real section
 *  keys, so a stale saved key can never crash the dropdown. */
export function allTemplates(custom: { name: string; sections: string[] }[] | undefined): MeetingTemplate[] {
	const valid = new Set<string>(EXTRACTIONS.map((e) => e.key));
	const customValid = (custom ?? [])
		.filter((c) => c.name.trim())
		.map((c) => ({ id: `c:${c.name.trim()}`, name: c.name.trim(), sections: c.sections.filter((s) => valid.has(s)) as ExtractionKey[] }));
	return [...TEMPLATES, ...customValid];
}

/* ---------------- what day it is, where the user is ---------------- */

/** The calendar day a moment fell on, as YYYY-MM-DD, read off the local clock.
 *
 *  Not `toISOString().slice(0, 10)`, which is the day in UTC. West of Greenwich
 *  that is already tomorrow for the last hours of every evening, so a note taken
 *  at nine at night was filed under tomorrow's date: named for a day that had
 *  not started, sorted ahead of the morning that preceded it, and outside a
 *  "this week" window that had not reached it yet. A vault records a person's
 *  days, and a person's day ends when they say it does.
 *
 *  A timestamp being compared against something else in UTC is a different
 *  question and keeps `toISOString`: this is for the days people name. */
export function dayOf(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Today, where the user is. */
export function today(): string {
	return dayOf(new Date());
}

/** The local day `days` before today (negative counts forward), as YYYY-MM-DD.
 *
 *  Stepped along the calendar rather than by subtracting milliseconds, because
 *  a day is not always 86,400,000 of them: on the two mornings a year the clocks
 *  move, "seven days ago" computed by arithmetic lands an hour off and can name
 *  the wrong date. Asking the calendar to count days gets the days right. */
export function daysAgo(days: number, from = new Date()): string {
	const d = new Date(from.getTime());
	d.setDate(d.getDate() - Math.round(days));
	return dayOf(d);
}

/** The local time as HH-MM-SS, for a filename whose day comes from `dayOf`. */
export function clockOf(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** ISO-8601 week key ("2026-W28") for a YYYY-MM-DD date; the auto-digest uses
 *  it to fire once per week. */
export function isoWeek(dateStr: string): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	const day = date.getUTCDay() || 7; // Mon=1 … Sun=7
	date.setUTCDate(date.getUTCDate() + 4 - day); // the week's Thursday dates the year
	const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
	return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* ---------------- Word (.docx) export model ---------------- */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-07-01" → "Wednesday, July 1, 2026"; passes anything unparseable through. */
export function longDate(dateStr: string): string {
	const [y, m, d] = String(dateStr).split("-").map(Number);
	if (!y || !m || !d || m > 12 || d > 31) return String(dateStr);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return `${WEEKDAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** One action item split into the recap's Owner / Task / Deadline columns.
 *  Handles both the task-line grammar and a "| Task | Owner | Due |" row. */
export function parseActionRow(line: string): { owner: string; task: string; deadline: string } {
	if (/^\s*\|/.test(line)) {
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		const clean = (s: string) => (s ?? "").replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, a: string, b?: string) => (b || a.slice(a.lastIndexOf("/") + 1)).trim()).trim();
		return { task: clean(cells[0] ?? ""), owner: clean(cells[1] === "TBD" ? "" : cells[1] ?? ""), deadline: cells[2] === "TBD" ? "" : clean(cells[2] ?? "") };
	}
	const owner = taskOwner(line);
	const deadline = line.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
	const task = line
		.replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
		.replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "")
		.replace(/[📅⏳🛫✅]️?\s*\d{4}-\d{2}-\d{2}/gu, "") // any dated Tasks token (u flag keeps emoji pairs intact)
		.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]|\u{FE0F}/gu, "") // stray emoji/priority marks
		.replace(/\s{2,}/g, " ")
		.trim();
	return { owner: owner === "Unassigned" ? "" : owner, task, deadline };
}

export type ExportSectionKind = "text" | "bullets" | "tasks";
/** A screen carried into the recap: which file to embed, the moment it came
 *  from, and whatever the image reader found in it. The builder embeds the
 *  picture; the caller resolves `link` to bytes, since only it can read the
 *  vault. */
export interface ExportImage {
	link: string;
	stamp: string;
	caption: string;
}
export interface ExportSection {
	heading: string;
	kind: ExportSectionKind;
	paragraphs: string[];
	bullets: string[];
	tasks: { owner: string; task: string; deadline: string }[];
	/** Screens found in this section, in the order they appeared. A frame placed
	 *  beside a point stays with that point's section rather than being hoisted
	 *  into a gallery, which is the whole reason it was put there. */
	images: ExportImage[];
}
export interface ExportModel {
	title: string;
	attendees: string[];
	dateLine: string;
	sections: ExportSection[];
}

/** Section headings never carried into a recap document. */
/** Moments is a list of stamps into a recording nobody outside the meeting has,
 *  and the transcript is what a recap exists instead of. Screens are NOT skipped:
 *  they are lifted out as pictures the builder embeds. */
const EXPORT_SKIP = new Set(["transcript", "moments"]);

/** A frame line as written into a note: the stamp, the embed, and the reader's
 *  text quoted on the lines below it. */
const FRAME_LINE = /^[ \t]*\*\*\[(\d+:\d{2}(?::\d{2})?)\]\*\*[ \t]*!\[\[([^\]|]+)(?:\|[^\]]*)?\]\][ \t]*$/;

/** The screens written into one section's markdown, with the quoted text that
 *  belongs to each. */
function exportImagesIn(raw: string): ExportImage[] {
	const lines = raw.split("\n");
	const out: ExportImage[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = FRAME_LINE.exec(lines[i]);
		if (!m) continue;
		// the caption is the run of quoted lines directly under the frame
		const caption: string[] = [];
		for (let k = i + 1; k < lines.length; k++) {
			const q = /^[ \t]*>[ \t]?(.*)$/.exec(lines[k]);
			if (!q) break;
			caption.push(q[1].trim());
		}
		out.push({ link: m[2], stamp: m[1], caption: caption.join(" ").trim() });
	}
	return out;
}

/** Remove the frame lines, and the captions under them, from a section's
 *  markdown: the pictures are carried as images, so leaving the text behind
 *  would print the same thing twice, once as a wiki-link. */
function stripFrameLines(raw: string): string {
	const lines = raw.split("\n");
	const keep: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!FRAME_LINE.test(lines[i])) {
			keep.push(lines[i]);
			continue;
		}
		while (i + 1 < lines.length && /^[ \t]*>/.test(lines[i + 1])) i++;
	}
	return keep.join("\n");
}

/** Turn a capture note into a structured recap model for the .docx builder:
 *  title, attendees, long date, and ordered sections classified as prose,
 *  bullets, or an Owner/Task/Deadline action table. Pure and fully tested;
 *  the docx mapping (docx-export.ts) stays a thin projection of this. */
// unwrap a wiki-link to its display text: the alias when present, else the
// target's basename ("[[People/Jane|Jane]]" and "[[Jane]]" both read "Jane")
const UNLINK = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const unlink = (s: string) => s.replace(UNLINK, (_m, a: string, b?: string) => (b || a.slice(a.lastIndexOf("/") + 1)).trim());
const isBul = (l: string) => /^[-*+]\s+/.test(l);

export function parseCaptureForExport(md: string, fallbackTitle = ""): ExportModel {
	md = md.replace(/\r\n/g, "\n"); // CRLF-safe frontmatter and headings
	const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n/);
	const fm = fmMatch ? fmMatch[1] : "";
	let body = fmMatch ? md.slice(fmMatch[0].length) : md;
	// Cut the transcript (and everything after it) BEFORE splitting: transcript
	// text is free-form and may itself contain a "## " line, which would
	// otherwise spawn a phantom section and leak transcript into a document
	// whose entire purpose is to exclude it.
	const tcut = body.search(/^## +Transcript\b/im);
	if (tcut >= 0) body = body.slice(0, tcut);

	const dateRaw = fm.match(/^date:\s*(.+)$/m)?.[1]?.trim() ?? "";
	// attendee list items are QUOTED ("[[Name]]" or, when redacted, "[redacted]");
	// the quotes distinguish them from unquoted list values like tags.
	const attendees = [...fm.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => personName(m[1]));
	// a capture whose filename already carries the title writes no heading, so
	// the caller's fallback (the note's own name) titles the document
	const title = body.match(/^#\s+(.+)$/m)?.[1].trim() || fallbackTitle.trim() || "Meeting Recap";

	const sections: ExportSection[] = [];
	const parts = body.split(/^## +/m);
	for (let i = 1; i < parts.length; i++) {
		const nl = parts[i].indexOf("\n");
		const heading = (nl < 0 ? parts[i] : parts[i].slice(0, nl)).trim();
		if (EXPORT_SKIP.has(heading.toLowerCase())) continue;
		const raw = nl < 0 ? "" : parts[i].slice(nl + 1);
		// Screens come out first, so the frame lines and their quoted captions
		// never reach the prose. They carry the stamp they were written with, and
		// the caller turns each link into bytes; a section that is nothing BUT
		// screens still counts, which is how the Screens section itself survives.
		const images = exportImagesIn(raw);
		const content = stripFrameLines(raw)
			.replace(/^!\[\[[^\]]*\]\]\s*$/gm, "")
			.trim();
		if ((!content || /^\*None/.test(content)) && !images.length) continue;
		if (!content || /^\*None/.test(content)) {
			sections.push({ heading, kind: "text", paragraphs: [], bullets: [], tasks: [], images });
			continue;
		}
		const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);

		if (/action item/i.test(heading)) {
			const taskish = lines.filter((l) => /^[-*+]\s+\[[ xX]\]/.test(l) || (/^\|/.test(l) && !/^\|\s*-+/.test(l) && !/\bTask\b/i.test(l)));
			const tasks = taskish.map(parseActionRow).filter((r) => r.task);
			if (tasks.length) {
				sections.push({ heading, kind: "tasks", paragraphs: [], bullets: [], tasks, images });
				continue;
			}
			// no real task rows, fall through and render whatever content exists
		}
		const bulletLines = lines.filter(isBul);
		if (bulletLines.length) {
			// keep BOTH any lead-in/interleaved prose (as paragraphs) and the
			// bullets, so no line is ever silently dropped from the export
			const bullets = bulletLines.map((l) => unlink(l.replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, "")).trim());
			const lead = lines.filter((l) => !isBul(l)).map((l) => unlink(l).trim()).filter(Boolean);
			sections.push({ heading, kind: "bullets", paragraphs: lead, bullets, tasks: [], images });
		} else {
			const paras = unlink(content).split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
			sections.push({ heading, kind: "text", paragraphs: paras, bullets: [], tasks: [], images });
		}
	}
	return { title, attendees, dateLine: longDate(dateRaw), sections };
}

/** A stored per-series section list → the extraction toggles for a run. */
export function extractionsFromKeys(keys: string[]): Record<ExtractionKey, boolean> {
	const out = {} as Record<ExtractionKey, boolean>;
	for (const e of EXTRACTIONS) out[e.key] = keys.includes(e.key);
	return out;
}

/** The chosen (true) extraction keys, in canonical order, what a per-series
 *  default remembers. */
export function chosenKeys(chosen: Partial<Record<ExtractionKey, boolean>>): ExtractionKey[] {
	return EXTRACTIONS.map((e) => e.key).filter((k) => chosen[k]);
}

/** Encode fields + one file as multipart/form-data for OpenAI-compatible
 *  transcription endpoints; requestUrl needs the raw bytes and boundary. */
export function buildMultipart(
	fields: Record<string, string>,
	fileField: string,
	filename: string,
	mime: string,
	file: ArrayBuffer,
	boundary = "----powerassistant" + Date.now().toString(36)
): { contentType: string; body: ArrayBuffer } {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (const [k, v] of Object.entries(fields)) {
		chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
	}
	chunks.push(
		enc.encode(
			`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
		)
	);
	chunks.push(new Uint8Array(file));
	chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const body = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		body.set(c, at);
		at += c.byteLength;
	}
	return { contentType: `multipart/form-data; boundary=${boundary}`, body: body.buffer };
}

/**
 * Merge our settings over what is on disk RIGHT NOW, for a save.
 *
 * data.json is synced. Other devices write it, and a device that has been idle
 * still holds whatever it read when its plugin loaded, so writing that whole
 * object back reverts every change made anywhere else since. A phone that only
 * opened a note can blank an API key typed on a laptop an hour earlier: keys are
 * entered once and never touched, so nothing rewrites them afterwards and a
 * single revert loses them for good.
 *
 * A save may only carry the keys we changed. `baseline` is the state we last
 * read from or wrote to disk, so anything differing from it is ours: those
 * overwrite. Every untouched key takes the disk's value. A key absent from disk
 * was written by a version that did not know it, and keeps ours rather than
 * resetting to a default.
 */
export function mergeForSave<T extends object>(ours: T, baseline: T, disk: Partial<T> | null): T {
	const out = { ...ours };
	if (!disk) return out;
	for (const k of Object.keys(ours) as (keyof T)[]) {
		if (!(k in disk)) continue; // disk has never heard of this key; ours stands
		const o = ours[k];
		const b = baseline[k];
		const d = disk[k];
		if (isRecord(o) && isRecord(b) && isRecord(d)) {
			out[k] = mergeEntries(o, b, d) as T[keyof T];
			continue;
		}
		const changedByUs = JSON.stringify(o) !== JSON.stringify(b);
		if (!changedByUs) out[k] = d as T[keyof T];
	}
	return out;
}

/** A per-item map, as opposed to a value that means something whole. Arrays are
 *  values here: a list's order and membership are the thing itself. */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The same three-way rule, entry by entry.
 *
 * A key holding one value per item (per folder, per field, per speaker) is a
 * whole vault's worth of settings behind a single name, and merging it whole
 * meant changing ONE of them published all of them. Every item another device
 * configured since this one last read was erased by a device that had never
 * seen it.
 *
 * Start from the disk, so anything another device set survives; drop only what
 * we deliberately removed (present in the baseline, gone from ours); then lay
 * our own changed entries over the top. Two devices editing the SAME item still
 * settles last-writer-wins, but that is one item losing a race rather than
 * everything losing it.
 */
function mergeEntries(
	ours: Record<string, unknown>,
	baseline: Record<string, unknown>,
	disk: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(disk)) {
		const removedByUs = k in baseline && !(k in ours);
		if (!removedByUs) out[k] = disk[k];
	}
	for (const k of Object.keys(ours)) {
		const changedByUs = JSON.stringify(ours[k]) !== JSON.stringify(baseline[k]);
		if (changedByUs || !(k in disk)) out[k] = ours[k];
	}
	return out;
}

/* ---------- last-edited stamp ----------
 * The wording of the "Edited 3 minutes ago" line Power Assistant draws under a
 * note's title when Power Editor is not installed to draw it. Kept identical to
 * Power Editor's own, so a vault that gains or loses that plugin reads the same
 * either way. */

const EDIT_MIN = 60_000;
const EDIT_HOUR = 60 * EDIT_MIN;
const EDIT_DAY = 24 * EDIT_HOUR;

/** "Edited 3 minutes ago". Coarse on purpose: the point is a glanceable sense
 *  of age, not a stopwatch. Anything older than a month reads as a date,
 *  because "37 days ago" is harder to place than "Jun 18". Clock skew (a file
 *  stamped in the future by a sync) reads as "just now" rather than as a
 *  negative. */
export function relativeEdited(then: number, now: number): string {
	const d = now - then;
	if (!Number.isFinite(then) || then <= 0) return "";
	if (d < 45 * 1000) return "just now";
	if (d < 90 * 1000) return "a minute ago";
	if (d < EDIT_HOUR) return `${Math.round(d / EDIT_MIN)} minutes ago`;
	if (d < 2 * EDIT_HOUR) return "an hour ago";
	if (d < EDIT_DAY) return `${Math.round(d / EDIT_HOUR)} hours ago`;
	if (d < 2 * EDIT_DAY) return "yesterday";
	if (d < 30 * EDIT_DAY) return `${Math.round(d / EDIT_DAY)} days ago`;
	return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** The full stamp for the tooltip and for the click-to-expand form. */
export function absoluteEdited(then: number): string {
	if (!Number.isFinite(then) || then <= 0) return "";
	return new Date(then).toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** When the note was last edited. Frontmatter wins over the file's own mtime:
 *  a synced vault can have mtime rewritten by the sync client on download, so a
 *  note edited on another device would otherwise claim to be edited the moment
 *  it arrived here. A hand-maintained `updated:` is the truth when it exists.
 *  Returns 0 when there is nothing to show. */
export function editedAt(fm: Record<string, unknown> | undefined, mtime: number): number {
	for (const key of ["updated", "modified", "last-edited"]) {
		const v = fm?.[key];
		if (typeof v === "string" || typeof v === "number") {
			const t = new Date(v).getTime();
			if (Number.isFinite(t) && t > 0) return t;
		}
	}
	return Number.isFinite(mtime) && mtime > 0 ? mtime : 0;
}
