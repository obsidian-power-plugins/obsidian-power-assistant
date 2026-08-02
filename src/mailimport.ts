/* Turning a curated mail folder into a knowledge corpus: collapse a
 * back-and-forth into one exchange, filter out what is not worth keeping, and
 * write each surviving conversation as a note.
 *
 * Everything here is pure and deterministic; main.ts supplies the mail, the AI
 * call, and the vault.
 *
 * The shape of the problem: a work folder is mostly threads and notifications.
 * Importing every message would store the same quoted history a dozen times and
 * bury the useful mail under automated noise. So the pipeline is a funnel, and
 * every cheap stage runs before an expensive one:
 *
 *   folder scope -> thread collapse -> focused -> sender rules -> AI (optional)
 *
 * Nothing is ever silently dropped: every rejection carries a reason, and the
 * import writes them into a report so a bad rule is visible rather than
 * mysterious. */

/** One message as it arrives from the mail plugin. */
export interface ImportMail {
	id: string;
	from: string;
	to?: string;
	subject: string;
	/** ISO timestamp. */
	date: string;
	webLink?: string;
	text: string;
	/** Graph's conversation id; the thread this message belongs to. */
	conversationId: string;
	/** Outlook's own focused/other verdict, already personalized to the mailbox. */
	focused: boolean;
}

/** A collapsed exchange: the newest message of a thread, plus what the rest of
 *  the thread contributed. */
export interface Thread {
	/** The conversation id, and the note's stable identity. */
	id: string;
	/** The newest message; its body already carries the quoted history. */
	latest: ImportMail;
	/** How many messages the folder held for this conversation. */
	count: number;
	/** Every distinct sender in the thread, in first-seen order. */
	participants: string[];
	/** ISO dates of the oldest and newest messages. */
	first: string;
	last: string;
	/** True when any message in the thread was focused. */
	focused: boolean;
}

/** A rejected thread and why, so the report can explain itself. */
export interface Rejection {
	id: string;
	subject: string;
	from: string;
	reason: string;
}

/* ---------------- index coverage ---------------- */

/** The folders Ask should index, with the mail-import folder guaranteed to be
 *  among them.
 *
 *  Mail is imported precisely so it can be asked about, so a corpus that sits
 *  outside the indexed set answers nothing and gives no hint why. It is only
 *  appended when no configured folder already covers it: adding a child of an
 *  indexed folder would index the same notes twice. */
export function coverIndexFolders(configured: readonly string[], mailFolder: string): string[] {
	const out = configured.filter((f) => f.length && f !== ".");
	const m = (mailFolder || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
	if (!m) return out;
	const covered = out.some((f) => f === "/" || m === f || m.startsWith(f + "/"));
	return covered ? out : [...out, m];
}

/* ---------------- thread collapsing ---------------- */

const ms = (iso: string): number => {
	const t = Date.parse(iso);
	return isFinite(t) ? t : 0;
};

/** The display name of a sender, or its address. */
export function senderLabel(from: string): string {
	const m = /^\s*"?([^"<]+?)"?\s*</.exec(from);
	if (m) return m[1].trim();
	return from.trim();
}

/** The bare address, lowercased, for rule matching and grouping. */
export function senderAddress(from: string): string {
	const m = /<([^>]+)>/.exec(from);
	return (m ? m[1] : from).trim().toLowerCase();
}

/** The domain of a sender address. */
export function senderDomain(from: string): string {
	const addr = senderAddress(from);
	const at = addr.lastIndexOf("@");
	return at < 0 ? "" : addr.slice(at + 1);
}

/** Collapse messages into one entry per conversation, keeping the newest.
 *
 *  The newest message is the one worth storing: its body already contains the
 *  quoted history, so one note holds the whole exchange instead of a dozen
 *  notes repeating it. Messages with no conversation id stand alone, keyed by
 *  their own id, so a stray message is never merged with an unrelated one. */
export function collapseThreads(mail: readonly ImportMail[]): Thread[] {
	const groups = new Map<string, ImportMail[]>();
	for (const m of mail) {
		const key = m.conversationId || `msg:${m.id}`;
		const arr = groups.get(key) ?? [];
		arr.push(m);
		groups.set(key, arr);
	}
	const out: Thread[] = [];
	for (const [id, msgs] of groups) {
		const sorted = [...msgs].sort((a, b) => ms(a.date) - ms(b.date));
		const latest = sorted[sorted.length - 1];
		const participants: string[] = [];
		for (const m of sorted) {
			const who = senderLabel(m.from);
			if (who && !participants.includes(who)) participants.push(who);
		}
		out.push({
			id,
			latest,
			count: sorted.length,
			participants,
			first: sorted[0].date.slice(0, 10),
			last: latest.date.slice(0, 10),
			focused: sorted.some((m) => m.focused),
		});
	}
	// newest exchange first, which is the order a person would want to review
	return out.sort((a, b) => ms(b.latest.date) - ms(a.latest.date));
}

/* ---------------- sender rules ---------------- */

/** A user rule over senders. `block` drops the match; otherwise it is an
 *  allow, which keeps the match regardless of other signals. */
export interface SenderRule {
	/** Matched against display name, address, and domain. */
	match: string;
	block?: boolean;
	enabled?: boolean;
}

/** Whether a rule applies to a sender. Empty rules never match, so a blank row
 *  in settings cannot become a catch-all. */
export function matchSender(rule: SenderRule, from: string): boolean {
	if (rule.enabled === false) return false;
	const needle = (rule.match ?? "").toLowerCase().trim();
	if (!needle) return false;
	return from.toLowerCase().includes(needle) || senderAddress(from).includes(needle) || senderDomain(from).includes(needle);
}

/* ---------------- the funnel ---------------- */

export interface FilterOptions {
	/** Keep only threads Outlook classified as focused. */
	focusedOnly: boolean;
	rules: readonly SenderRule[];
	/** Ids already imported, so a re-run only considers what is new or changed. */
	known?: ReadonlySet<string>;
	/** Drop a thread whose newest message is shorter than this, in characters.
	 *  Catches "thanks!" and read receipts. 0 disables. */
	minChars?: number;
}

export interface FilterResult {
	keep: Thread[];
	rejected: Rejection[];
}

/** Apply the deterministic layers, cheapest first, and record why anything was
 *  dropped. An allow rule wins outright: the user naming a sender is a stronger
 *  signal than any classifier. */
export function filterThreads(threads: readonly Thread[], opts: FilterOptions): FilterResult {
	const keep: Thread[] = [];
	const rejected: Rejection[] = [];
	const reject = (t: Thread, reason: string) => rejected.push({ id: t.id, subject: t.latest.subject, from: t.latest.from, reason });

	for (const t of threads) {
		const from = t.latest.from;
		const blocked = opts.rules.find((r) => r.block !== false && r.block && matchSender(r, from));
		const allowed = opts.rules.find((r) => !r.block && matchSender(r, from));

		if (blocked) {
			reject(t, `sender rule "${blocked.match}"`);
			continue;
		}
		if (allowed) {
			keep.push(t);
			continue;
		}
		if (opts.focusedOnly && !t.focused) {
			reject(t, "Outlook classified it as Other, not Focused");
			continue;
		}
		const min = opts.minChars ?? 0;
		if (min > 0 && (t.latest.text ?? "").trim().length < min) {
			reject(t, `almost no content (under ${min} characters)`);
			continue;
		}
		keep.push(t);
	}
	return { keep, rejected };
}

/* ---------------- sender report ---------------- */

export interface SenderStat {
	address: string;
	label: string;
	threads: number;
	messages: number;
	focusedShare: number;
}

/** Who is filling this folder, biggest first. The point is to let a person
 *  decide in bulk rather than guess a block list up front: a sender with 400
 *  threads and no focused mail is obvious noise once you can see it. */
export function senderStats(threads: readonly Thread[]): SenderStat[] {
	const g = new Map<string, { label: string; threads: number; messages: number; focused: number }>();
	for (const t of threads) {
		const addr = senderAddress(t.latest.from) || "(unknown)";
		const e = g.get(addr) ?? { label: senderLabel(t.latest.from) || addr, threads: 0, messages: 0, focused: 0 };
		e.threads++;
		e.messages += t.count;
		if (t.focused) e.focused++;
		g.set(addr, e);
	}
	return [...g.entries()]
		.map(([address, e]) => ({
			address,
			label: e.label,
			threads: e.threads,
			messages: e.messages,
			focusedShare: e.threads ? Math.round((e.focused / e.threads) * 100) : 0,
		}))
		.sort((a, b) => b.threads - a.threads);
}

/** The sender report as a note: a table to read, and ready-made block lines to
 *  paste into settings. */
export function buildSenderReport(stats: readonly SenderStat[], folder: string, today: string): string {
	const fm = ["---", "type: capture-mail-senders", `date: ${today}`, "generated: true", "---"].join("\n");
	const rows = stats
		.slice(0, 100)
		.map((s) => `| ${s.label} | \`${s.address}\` | ${s.threads} | ${s.messages} | ${s.focusedShare}% |`)
		.join("\n");
	const noisy = stats.filter((s) => s.threads >= 5 && s.focusedShare === 0).slice(0, 20);
	const parts = [
		`${fm}\n# Who fills ${folder}`,
		`${stats.length} sender${stats.length === 1 ? "" : "s"}, newest scan ${today}. Threads is what an import would create; Focused is Outlook's own relevance verdict.`,
		`| Sender | Address | Threads | Messages | Focused |\n| --- | --- | --- | --- | --- |\n${rows}`,
	];
	if (noisy.length)
		parts.push(
			`## Never focused, and frequent\n\nOutlook has never marked these focused. Add any you agree with as block rules:\n\n` +
				noisy.map((s) => `- \`${s.address}\`, ${s.threads} threads`).join("\n")
		);
	return parts.join("\n\n") + "\n";
}

/* ---------------- AI relevance pass ---------------- */

/** Ask the model which exchanges are worth keeping as reference material.
 *
 *  Batched on purpose: one call per hundred threads instead of one per thread
 *  is the difference between thirty calls and three thousand. Threads are
 *  numbered so the reply maps back positionally without the model echoing
 *  anything. */
export function buildRelevancePrompt(threads: readonly Thread[], context: string): { system: string; user: string } {
	const system =
		"You decide which email exchanges are worth keeping as long-term reference material for someone's work knowledge base. " +
		"Reply with ONLY a JSON object mapping each number to true (keep) or false (drop), for example {\"1\":true,\"2\":false}. " +
		"KEEP: decisions, requirements, commitments, explanations, troubleshooting, plans, anything someone might later ask a question about. " +
		"DROP: automated notifications, build and ticket status mail, calendar churn, newsletters, marketing, out-of-office replies, and pure pleasantries with no content. " +
		"When genuinely unsure, keep it: a wrongly kept email costs a little space, a wrongly dropped one is lost.";
	const lines = threads.map((t, i) => {
		const preview = (t.latest.text ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
		return `${i + 1}. From: ${senderLabel(t.latest.from)} <${senderAddress(t.latest.from)}> | Subject: ${t.latest.subject || "(none)"} | ${t.count} message(s)\n   ${preview}`;
	});
	return { system, user: `${context ? context + "\n\n" : ""}${lines.join("\n")}` };
}

/** Positional keep/drop verdicts. Anything missing or unparseable defaults to
 *  keep, so a bad reply can never quietly delete someone's mail. */
export function parseRelevance(reply: string, count: number): boolean[] {
	const out = new Array<boolean>(count).fill(true);
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) return out;
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return out;
	}
	for (const [k, v] of Object.entries(j)) {
		const i = parseInt(k, 10) - 1;
		if (i >= 0 && i < count) out[i] = v !== false && v !== "false" && v !== 0;
	}
	return out;
}

/* ---------------- notes ---------------- */

const yq = (s: string): string => `"${s.replace(/"/g, "'")}"`;

/** Filesystem-safe, collapsed, trimmed. */
export function safeName(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
}

/** A reply prefix chain ("RE: FW: RE:") says nothing; the subject beneath it
 *  is the thread's real name. */
export function cleanSubject(subject: string): string {
	let s = (subject || "").trim();
	for (let i = 0; i < 10; i++) {
		const next = s.replace(/^\s*(re|fw|fwd|aw|sv|vs)\s*(\[\d+\])?\s*:\s*/i, "");
		if (next === s) break;
		s = next;
	}
	return s.trim();
}

/** "2026-07-15 Contract redlines". Dated by the newest message so the folder
 *  sorts chronologically. */
export function threadNoteName(t: Thread): string {
	const subject = cleanSubject(t.latest.subject) || "(no subject)";
	const name = safeName(`${t.last} ${subject}`);
	return name.length > 110 ? name.slice(0, 110).trim() : name;
}

/** One exchange as a note. The body is the newest message, whose quoted history
 *  carries the rest of the thread, so the whole conversation lives in one place
 *  and nothing is stored twice. */
export function buildThreadNote(t: Thread, opts: { folder: string; today: string }): string {
	const fm = [
		"---",
		"type: capture-mail",
		`conversation-id: ${yq(t.id)}`,
		`subject: ${yq(cleanSubject(t.latest.subject) || "(no subject)")}`,
		`from: ${yq(senderLabel(t.latest.from))}`,
		`from-address: ${yq(senderAddress(t.latest.from))}`,
		...(t.latest.to ? [`to: ${yq(t.latest.to)}`] : []),
		`date: ${t.last}`,
		...(t.first !== t.last ? [`first-message: ${t.first}`] : []),
		`messages: ${t.count}`,
		...(t.participants.length ? ["participants:", ...t.participants.map((p) => `  - ${yq(p)}`)] : []),
		`mail-folder: ${yq(opts.folder)}`,
		`imported: ${opts.today}`,
		...(t.latest.webLink ? [`source-url: ${yq(t.latest.webLink)}`] : []),
		"---",
	].join("\n");
	const title = cleanSubject(t.latest.subject) || "(no subject)";
	const meta =
		t.count > 1
			? `*${t.count} messages, ${t.first} to ${t.last}, between ${t.participants.join(", ")}.*`
			: `*From ${senderLabel(t.latest.from)}, ${t.last}.*`;
	const body = (t.latest.text ?? "").trim() || "*(no body)*";
	return [fm, `# ${title}`, meta, body].join("\n\n") + "\n";
}

/** The import report: what landed, what did not, and why. Written every run so
 *  a filter that is too aggressive shows up as a list rather than as silence. */
export function buildImportReport(
	kept: readonly Thread[],
	rejected: readonly Rejection[],
	opts: { folder: string; today: string; scanned: number; collapsed: number }
): string {
	const fm = ["---", "type: capture-mail-report", `date: ${opts.today}`, "generated: true", "---"].join("\n");
	const parts = [
		`${fm}\n# Mail import · ${opts.folder} · ${opts.today}`,
		[
			`- **Messages scanned:** ${opts.scanned}`,
			`- **Conversations after collapsing:** ${opts.collapsed}`,
			`- **Imported:** ${kept.length}`,
			`- **Skipped:** ${rejected.length}`,
		].join("\n"),
	];
	if (rejected.length) {
		const byReason = new Map<string, Rejection[]>();
		for (const r of rejected) {
			const arr = byReason.get(r.reason) ?? [];
			arr.push(r);
			byReason.set(r.reason, arr);
		}
		const blocks = [...byReason.entries()]
			.sort((a, b) => b[1].length - a[1].length)
			.map(([reason, rs]) => {
				const rows = rs
					.slice(0, 40)
					.map((r) => `| ${safeName(cleanSubject(r.subject)) || "(no subject)"} | ${senderLabel(r.from)} |`)
					.join("\n");
				const more = rs.length > 40 ? `\n\n*…and ${rs.length - 40} more.*` : "";
				return `### ${reason} (${rs.length})\n\n| Subject | From |\n| --- | --- |\n${rows}${more}`;
			});
		parts.push(`## Skipped\n\nNothing here was saved. If something should have been, adjust the rules and run the import again.\n\n${blocks.join("\n\n")}`);
	}
	return parts.join("\n\n") + "\n";
}
