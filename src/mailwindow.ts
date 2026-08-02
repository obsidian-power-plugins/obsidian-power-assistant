/* The rolling mail window: a time-bounded, local-only search index over recent
 * email bodies, so Ask can answer questions about mail without turning every
 * message into a synced note.
 *
 * Everything here is pure and deterministic; main.ts owns the SearchIndex, the
 * network pull from Power Desk, and persistence. The window is derived data
 * it can be rebuilt from the mailbox at any time, so it lives in the plugin's
 * own folder and never syncs.
 *
 * Two things shape the design. Email is bulky and mostly noise, so a message is
 * reduced to a heading (its subject) and a capped stretch of stripped text
 * before it ever reaches the index. And the window rolls: on every refresh,
 * anything past the horizon is dropped, so cost tracks the horizon, not the
 * total history of the mailbox. */

/** One message as the window holds it. `text` is already stripped of markup by
 *  the time it arrives; the window never stores HTML. */
export interface MailDoc {
	id: string;
	from: string;
	subject: string;
	/** ISO date (YYYY-MM-DD) or full ISO timestamp; only the date part is used. */
	date: string;
	/** Deep link back to the message in Outlook, for citations. */
	webLink?: string;
	text: string;
}

/** Light metadata kept per indexed message, so a hit can be labeled and linked
 *  without re-fetching the body. */
export interface MailMeta {
	from: string;
	subject: string;
	date: string;
	webLink?: string;
}

/** The synthetic note path a mail hit reports, so it slots into the same hit
 *  shape as a real note without ever being a file. The id rides along so the
 *  window can map a hit back to its metadata. */
export function mailHitPath(id: string): string {
	return `email:${id}`;
}

/** Recover the message id from a synthetic mail path, or null if it is a real
 *  note path. Lets the Ask layer tell mail hits from note hits. */
export function mailIdFromPath(path: string): string | null {
	return path.startsWith("email:") ? path.slice("email:".length) : null;
}

/** The date part of an ISO date or timestamp; "" when unparseable. */
export function isoDate(s: string): string {
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim());
	return m ? m[1] : "";
}

/** The horizon date: `days` before `today`, as YYYY-MM-DD. Anything strictly
 *  older than this is outside the window. */
export function windowCutoff(today: string, days: number): string {
	const base = isoDate(today);
	if (!base) return "";
	const d = new Date(base + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() - Math.max(0, Math.floor(days)));
	return d.toISOString().slice(0, 10);
}

/** Whether a message is inside the window as of `today`. A message with no
 *  usable date is treated as outside: the window is about recency, and an
 *  undateable message cannot be placed on the horizon. */
export function inWindow(dateStr: string, today: string, days: number): boolean {
	const d = isoDate(dateStr);
	if (!d) return false;
	const cutoff = windowCutoff(today, days);
	return !!cutoff && d >= cutoff;
}

/** The chunk of a message that gets indexed: subject as the heading, and a
 *  capped, whitespace-collapsed stretch of body text. Email tails are quoted
 *  threads and signatures, so the head is where the answer lives; capping keeps
 *  one long newsletter from dominating the index.
 *
 *  Returns null when there is nothing worth indexing (no subject and no text),
 *  so the caller can skip it entirely. */
export function chunkMailForIndex(doc: MailDoc, cap = 4000): { heading: string; text: string } | null {
	const subject = collapse(doc.subject);
	const body = collapse(doc.text);
	if (!subject && !body) return null;
	// the sender is worth indexing too, so "what did Dana send" can match
	const head = [subject, senderName(doc.from)].filter(Boolean).join(", ");
	return { heading: head || "(no subject)", text: body.slice(0, cap) };
}

/** Collapse runs of whitespace to single spaces and trim. */
function collapse(s: string): string {
	return (s || "").replace(/\s+/g, " ").trim();
}

/** A display name out of a From header, falling back to the address. */
export function senderName(from: string): string {
	const m = /^\s*"?([^"<]+?)"?\s*</.exec(from);
	if (m) return m[1].trim();
	const at = from.indexOf("@");
	return at > 0 ? from.slice(0, at).replace(/[<>]/g, "").trim() : from.trim();
}

/** Partition a batch of freshly fetched messages against what the window
 *  already holds and the horizon: which ids to add, and which to drop.
 *
 *  Adds are in-window messages not already indexed. Drops are indexed ids now
 *  past the horizon. Messages already indexed and still in-window are left
 *  untouched, so a refresh only pays for what actually changed. */
export function planWindowUpdate(
	incoming: readonly MailDoc[],
	indexed: ReadonlySet<string>,
	indexedDates: ReadonlyMap<string, string>,
	today: string,
	days: number
): { add: MailDoc[]; drop: string[] } {
	const add: MailDoc[] = [];
	for (const m of incoming) {
		if (indexed.has(m.id)) continue;
		if (!inWindow(m.date, today, days)) continue;
		add.push(m);
	}
	const drop: string[] = [];
	for (const [id, date] of indexedDates) {
		if (!inWindow(date, today, days)) drop.push(id);
	}
	return { add, drop };
}

/** Turn the model's `[[email:<id>]]` citations into readable Markdown links.
 *
 *  The retrieval layer hands mail excerpts a synthetic `email:<id>` path so the
 *  model cites them the same way it cites notes; a raw wiki-link to that path
 *  would be dead, so every one is rewritten to a link back to the message in
 *  Outlook (or a plain bracketed label when the message carries no web link).
 *  An id the window no longer knows collapses to a neutral "an email", never a
 *  broken link. */
export function linkifyMailCitations(answer: string, meta: (id: string) => MailMeta | null): string {
	return answer.replace(/\[\[email:([^\]|]+?)(?:\|[^\]]*)?\]\]/g, (_whole, id: string) => {
		const m = meta(id);
		if (!m) return "an email";
		const label = `Email: ${collapse(m.subject) || senderName(m.from) || "message"}`.slice(0, 80);
		return m.webLink ? `[${label}](${m.webLink})` : `(${label})`;
	});
}

/** A one-line summary of the window's state for the settings page. */
export function mailWindowStats(count: number, days: number, oldest: string | null): string {
	if (!count) return "No mail indexed yet.";
	const span = oldest ? ` back to ${oldest}` : "";
	return `${count} message${count === 1 ? "" : "s"} searchable${span} (last ${days} days).`;
}
