/* Pure transaction logic: turning an order email or a bill into structured
 * orders and line items. Everything here is deterministic and covered by
 * tests.ts; main.ts supplies the mail, AI, and vault glue.
 *
 * The hard part is not the extraction, it is trusting it. Real order mail from
 * Amazon, Home Depot, and Microsoft each breaks a different naive assumption:
 * one message can carry several orders, responsive templates render the same
 * line item twice (once for desktop, once for mobile), recommendation blocks
 * look exactly like purchases, and prices arrive split across table cells. So
 * the module normalizes the body defensively, then checks the AI's arithmetic
 * against the vendor's own totals and flags anything that does not add up
 * rather than quietly writing a wrong number into a note. */

/* ---------------- types ---------------- */

/** One purchased line on an order. `amount` is the line total (unit price times
 *  quantity), because that is what vendors actually print. */
export interface TxnItem {
	name: string;
	sku: string;
	quantity: number;
	amount: number | null;
	category: string;
}

/** One order, bill, or invoice. A single email can produce several of these. */
export interface TxnOrder {
	orderId: string;
	vendor: string;
	date: string;
	currency: string;
	subtotal: number | null;
	tax: number | null;
	shipping: number | null;
	discount: number | null;
	total: number | null;
	due: string;
	docType: string;
	scope: string;
	payment: string;
	account: string;
	items: TxnItem[];
}

/** The verdict on one order's arithmetic. `ok` false means the note should be
 *  written with review: true rather than trusted. */
export interface TxnRecon {
	ok: boolean;
	itemSum: number;
	expected: number | null;
	delta: number;
	reasons: string[];
}

export const TXN_DOC_TYPES = new Set(["order", "bill", "invoice", "receipt", "statement", "refund", "other"]);

/** The default category taxonomy. Kept deliberately small and concrete: a long
 *  list makes the model waffle between near-synonyms, and every extra category
 *  is one more way for two similar purchases to land in different buckets. */
export const TXN_CATEGORIES = [
	"groceries",
	"dining",
	"household",
	"pets",
	"health",
	"personal-care",
	"clothing",
	"electronics",
	"software",
	"home-improvement",
	"garden",
	"auto",
	"fuel",
	"utilities",
	"telecom",
	"insurance",
	"entertainment",
	"subscriptions",
	"travel",
	"office",
	"gifts",
	"other",
] as const;

/* ---------------- body normalization ---------------- */

/** Invisible characters that email templates use for preheader padding, bidi
 *  isolation, and soft wrapping. Amazon wraps order numbers in RTL embedding
 *  marks and pads subjects with zero-width joiners, so these have to go before
 *  anything tries to read a value. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\u034F/g;

/** Headings that introduce "things you did not buy". Everything from the first
 *  one to the end of the body is dropped: in every template seen so far these
 *  blocks sit below the order summary, and their product tiles are otherwise
 *  indistinguishable from real line items. */
const RECOMMENDATION_MARKERS = [
	"you might also like",
	"you may also like",
	"customers who bought",
	"customers also bought",
	"recommended for you",
	"inspired by your",
	"related products",
	"top picks for you",
	"frequently bought together",
	"more items to explore",
];

/** Strip a marked-up email body down to the text a reader would actually see,
 *  preserving enough table structure that "label | value" pairs survive.
 *  Cell boundaries become pipes and row boundaries become newlines, because
 *  order details are almost always laid out as tables and losing that structure
 *  turns "Qty: 2 | $39.96" into an unparseable run of numbers. */
export function normalizeEmailHtml(html: string): string {
	let s = html.replace(/\r\n?/g, "\n");
	// script, style, head, and Outlook conditional comments carry no visible text
	s = s.replace(/<!--[\s\S]*?-->/g, " ");
	s = s.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
	// structure first, while the tags are still there
	s = s.replace(/<\/t[dh]>/gi, " | ");
	s = s.replace(/<\/(tr|p|div|li|h[1-6]|table)>/gi, "\n");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<[^>]+>/g, " ");
	s = decodeEntities(s);
	s = s.replace(INVISIBLE, "");
	// collapse the scaffolding: runs of empty cells, then whitespace
	s = s.replace(/[ \t]+/g, " ");
	s = s.replace(/(?:\|\s*){2,}/g, "| ");
	s = s
		.split("\n")
		.map((l) => l.replace(/^\s*\|\s*/, "").replace(/\s*\|\s*$/, "").trim())
		.filter((l) => l && l !== "|")
		.join("\n");
	s = mergeSplitPrices(s);
	return cutRecommendations(s).trim();
}

/** Decode the entity subset that actually shows up in order mail. A full entity
 *  table is not worth carrying for a handful of cases. */
export function decodeEntities(s: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		ndash: "-",
		mdash: "-",
		rsquo: "'",
		lsquo: "'",
		ldquo: '"',
		rdquo: '"',
		hellip: "...",
		copy: "(c)",
		reg: "(r)",
		trade: "(tm)",
		cent: "c",
		pound: "£",
		euro: "€",
	};
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_: string, h: string) => safeCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_: string, d: string) => safeCodePoint(parseInt(d, 10)))
		.replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
	if (!isFinite(n) || n < 0 || n > 0x10ffff) return "";
	try {
		return String.fromCodePoint(n);
	} catch {
		return "";
	}
}

/** Rejoin prices that a responsive table split into separate cells. Amazon
 *  renders $90.99 as three cells ("$", "90", "99") so the cents can be
 *  superscripted; flattened naively that reads as two unrelated numbers. Only
 *  a currency mark followed by dollars and exactly two cent digits is joined,
 *  which is narrow enough not to touch "Qty: 2 | $39.96". */
export function mergeSplitPrices(s: string): string {
	const cur = "[$\\u00a3\\u20ac]";
	return s
		.replace(new RegExp(`(${cur})\\s*\\|\\s*(\\d{1,3}(?:,\\d{3})*)\\s*\\|\\s*(\\d{2})\\b`, "g"), "$1$2.$3")
		.replace(new RegExp(`(${cur})\\s+(\\d{1,3}(?:,\\d{3})*)\\s+(\\d{2})\\b`, "g"), "$1$2.$3");
}

/** Drop everything from the first "you might also like" style heading onward.
 *  Guarded by an offset so a marker in a preheader cannot truncate the whole
 *  body before the order details are even reached. */
export function cutRecommendations(s: string): string {
	const low = s.toLowerCase();
	let cut = -1;
	for (const m of RECOMMENDATION_MARKERS) {
		const i = low.indexOf(m);
		if (i > 200 && (cut < 0 || i < cut)) cut = i;
	}
	return cut < 0 ? s : s.slice(0, cut);
}

/** Everything above, plus a hard cap, so an enormous marketing mail cannot push
 *  the real content out of the model's context. Order details lead in every
 *  template seen, so truncating the tail is safe. */
export function emailToExtractionText(html: string, limit = 12000): string {
	const t = normalizeEmailHtml(html);
	return t.length > limit ? t.slice(0, limit) : t;
}

/* ---------------- prompt ---------------- */

/** Prompt for pulling orders and line items out of a normalized email body.
 *  The reply contract is strict JSON so the parser can stay mechanical. The
 *  three warnings in the system prompt are not hypothetical: each one
 *  corresponds to a real failure seen in sample mail. */
export function buildTxnExtractionPrompt(text: string, ctx: { from?: string; subject?: string; date?: string } = {}): { system: string; user: string } {
	const system =
		"You extract purchases from a receipt, order confirmation, bill, or invoice. Reply with ONLY a JSON object, no code fences, no prose:\n" +
		'{"orders":[{"orderId":"","vendor":"","date":"YYYY-MM-DD","currency":"USD","docType":"order|bill|invoice|receipt|statement|refund|other","scope":"personal|business","subtotal":0,"tax":0,"shipping":0,"discount":0,"total":0,"due":"YYYY-MM-DD","payment":"","account":"","items":[{"name":"","sku":"","quantity":1,"amount":0,"category":""}]}]}\n' +
		"Rules:\n" +
		"1. ONE message can contain SEVERAL orders, each with its own order number and total. Emit one entry per order number, never merge them.\n" +
		"2. List each purchased item EXACTLY ONCE. These emails often render the same item twice, once in a desktop table and once in a stacked mobile layout. Two blocks with the same product and price are the same purchase, not two purchases.\n" +
		"3. Include ONLY items actually bought. Ignore suggestions, recommendations, related products, and advertising.\n" +
		"4. item.amount is the LINE TOTAL for that row as printed (unit price times quantity), not the unit price.\n" +
		"5. discount is a positive number. subtotal excludes tax and shipping; total includes them.\n" +
		"6. Never invent or compute a number that is not printed. Use null when it is absent.\n" +
		"7. due applies to bills and invoices only. account is a utility or billing account number when shown.\n" +
		"8. payment is the masked instrument as printed, for example \"Visa **1891\".\n" +
		'9. scope is "business" when the recipient, billing address, or products are clearly a company purchase, otherwise "personal".\n' +
		`10. category is one of: ${TXN_CATEGORIES.join(", ")}. Choose per item from the product itself.`;
	const head = [ctx.from ? `From: ${ctx.from}` : null, ctx.subject ? `Subject: ${ctx.subject}` : null, ctx.date ? `Received: ${ctx.date}` : null]
		.filter(Boolean)
		.join("\n");
	return { system, user: head ? `${head}\n\n---\n\n${text}` : text };
}

/* ---------------- parsing ---------------- */

const str = (v: unknown): string => (typeof v === "string" ? v.replace(INVISIBLE, "").trim() : "");
const iso = (v: unknown): string => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : "");

/** A finite number from a number or a printed string like "$1,077.09". Returns
 *  null for anything else, so "never guess an amount" survives the parse. */
export function money(v: unknown): number | null {
	if (typeof v === "number") return isFinite(v) ? round2(v) : null;
	const s = str(v).replace(/[$£€,\s]/g, "");
	if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
	const n = parseFloat(s);
	return isFinite(n) ? round2(n) : null;
}

/** Cents-accurate rounding. Float sums of money drift, and a 0.00000001 drift
 *  is enough to fail an equality check that should have passed. */
export function round2(n: number): number {
	return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Parse the extraction reply into clean orders; null when it is not JSON.
 *  Tolerates code fences and prose around the object, mirroring the document
 *  extractor, so a chatty model does not cost a whole message. */
export function parseTxnExtraction(reply: string): TxnOrder[] | null {
	const start = reply.indexOf("{");
	const end = reply.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	const raw = Array.isArray(j.orders) ? j.orders : null;
	if (!raw) return null;
	return raw.map((o) => cleanOrder(o as Record<string, unknown>)).filter((o) => o.items.length > 0 || o.total != null || o.orderId);
}

function cleanOrder(o: Record<string, unknown>): TxnOrder {
	const type = str(o.docType).toLowerCase();
	const scope = str(o.scope).toLowerCase();
	const items = (Array.isArray(o.items) ? o.items : []).map((i) => cleanItem(i as Record<string, unknown>)).filter((i) => i.name);
	return {
		orderId: str(o.orderId),
		vendor: str(o.vendor),
		date: iso(o.date),
		currency: str(o.currency).toUpperCase().slice(0, 4) || "USD",
		subtotal: money(o.subtotal),
		tax: money(o.tax),
		shipping: money(o.shipping),
		discount: money(o.discount),
		total: money(o.total),
		due: iso(o.due),
		docType: TXN_DOC_TYPES.has(type) ? type : "other",
		scope: scope === "business" ? "business" : "personal",
		payment: str(o.payment),
		account: str(o.account),
		items,
	};
}

function cleanItem(i: Record<string, unknown>): TxnItem {
	const q = typeof i.quantity === "number" ? i.quantity : parseInt(str(i.quantity), 10);
	const cat = str(i.category).toLowerCase();
	return {
		name: str(i.name),
		sku: str(i.sku),
		quantity: isFinite(q) && q > 0 ? Math.floor(q) : 1,
		amount: money(i.amount),
		category: (TXN_CATEGORIES as readonly string[]).includes(cat) ? cat : "other",
	};
}

/* ---------------- reconciliation ---------------- */

/** Cents of slack allowed before an order is called out. Vendors round unit
 *  prices per line, so a multi-line order can legitimately drift a cent or two. */
const TOLERANCE = 0.02;

/** Check the extracted line items against the vendor's own printed totals.
 *
 *  This is the safety net that makes the numbers trustworthy. Preferred oracle
 *  is subtotal, which by definition is the sum of the lines; total is only used
 *  when no subtotal was printed, and then only as an upper bound, since tax and
 *  shipping legitimately sit between the two. */
export function reconcileOrder(o: TxnOrder): TxnRecon {
	const reasons: string[] = [];
	const priced = o.items.filter((i) => i.amount != null);
	const itemSum = round2(priced.reduce((a, i) => a + (i.amount ?? 0), 0));

	if (!o.items.length) {
		// a bill or a statement is a single amount with no lines; that is fine
		const bare = o.docType === "bill" || o.docType === "statement" || o.docType === "invoice";
		if (!bare) reasons.push("no line items were extracted");
		return { ok: bare && o.total != null, itemSum: 0, expected: o.total, delta: 0, reasons };
	}
	if (priced.length < o.items.length) reasons.push(`${o.items.length - priced.length} of ${o.items.length} items have no amount`);

	if (o.subtotal != null) {
		const delta = round2(itemSum - o.subtotal);
		if (Math.abs(delta) <= TOLERANCE) return { ok: reasons.length === 0, itemSum, expected: o.subtotal, delta, reasons };
		// the signature of a responsive template counted twice
		if (Math.abs(round2(itemSum - o.subtotal * 2)) <= TOLERANCE || Math.abs(round2(itemSum / 2 - o.subtotal)) <= TOLERANCE)
			reasons.push("line items sum to twice the subtotal, which usually means a duplicated mobile layout was counted");
		else reasons.push(`line items sum to ${itemSum} but the subtotal is ${o.subtotal} (off by ${delta})`);
		return { ok: false, itemSum, expected: o.subtotal, delta, reasons };
	}

	if (o.total != null) {
		const delta = round2(itemSum - o.total);
		if (delta > TOLERANCE) {
			reasons.push(`line items sum to ${itemSum}, more than the order total of ${o.total}`);
			return { ok: false, itemSum, expected: o.total, delta, reasons };
		}
		return { ok: reasons.length === 0, itemSum, expected: o.total, delta, reasons };
	}

	reasons.push("no subtotal or total to check the line items against");
	return { ok: false, itemSum, expected: null, delta: 0, reasons };
}

/** Drop exact duplicate lines (same name, sku, quantity, and amount). Used only
 *  as a repair when reconciliation has already failed, never speculatively:
 *  buying the same thing on two lines of one order is legal, so arithmetic gets
 *  to decide whether the duplicate is real or a rendering artifact. */
export function dedupeItems(items: TxnItem[]): TxnItem[] {
	const seen = new Set<string>();
	const out: TxnItem[] = [];
	for (const i of items) {
		const key = `${i.name.toLowerCase()}|${i.sku.toLowerCase()}|${i.quantity}|${i.amount ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(i);
	}
	return out;
}

/** Reconcile, and if it fails only because the same line was counted twice,
 *  repair it and reconcile again. Returns the order actually worth writing
 *  along with its verdict and whether a repair was applied. */
export function settleOrder(o: TxnOrder): { order: TxnOrder; recon: TxnRecon; repaired: boolean } {
	const first = reconcileOrder(o);
	if (first.ok) return { order: o, recon: first, repaired: false };
	const deduped = dedupeItems(o.items);
	if (deduped.length === o.items.length) return { order: o, recon: first, repaired: false };
	const candidate = { ...o, items: deduped };
	const second = reconcileOrder(candidate);
	if (!second.ok) return { order: o, recon: first, repaired: false };
	return {
		order: candidate,
		recon: { ...second, reasons: [`removed ${o.items.length - deduped.length} duplicate line item(s) to match the printed subtotal`] },
		repaired: true,
	};
}

/** Tax, shipping, and discount spread across the line items in proportion to
 *  their value, so per-category totals add up to what was actually charged.
 *  Without this every category reports low, because the extras sit on the order
 *  and never reach a line. Returns cents-exact shares: the largest line absorbs
 *  the rounding remainder so the parts always sum to the whole. */
export function allocateExtras(o: TxnOrder): number[] {
	const priced = o.items.map((i) => i.amount ?? 0);
	const base = round2(priced.reduce((a, n) => a + n, 0));
	const extras = round2((o.tax ?? 0) + (o.shipping ?? 0) - (o.discount ?? 0));
	if (!o.items.length) return [];
	if (base <= 0 || extras === 0) return o.items.map(() => 0);
	const shares = priced.map((n) => round2((n / base) * extras));
	const drift = round2(extras - shares.reduce((a, n) => a + n, 0));
	if (drift !== 0) {
		let big = 0;
		for (let k = 1; k < priced.length; k++) if (priced[k] > priced[big]) big = k;
		shares[big] = round2(shares[big] + drift);
	}
	return shares;
}

/* ---------------- redaction ---------------- */

/** Secrets that ride along in order mail and invoices and must never reach a
 *  note. These files sync, so a license key or a bank routing number written
 *  into frontmatter leaves the machine.
 *
 *  Deliberately narrow. Order numbers are digits and dashes too (Amazon's
 *  111-8099753-6573041, CoServ's account 9001780050) and those are wanted, so
 *  nothing is redacted on shape alone unless the shape is unambiguous. */
export function redactSecrets(s: string): string {
	return (
		s
			// software license keys: five groups of five, as Microsoft prints them
			.replace(/\b[A-Z0-9]{5}(?:-[A-Z0-9]{5}){4}\b/g, "[redacted key]")
			// bank details, only when the label says so
			.replace(/\b(routing|swift|iban)\b([^\n]{0,20}?)\b[A-Z0-9]{8,17}\b/gi, "$1$2[redacted]")
			.replace(/\b(account\s*(?:number|no\.?|#)?)\s*[:#]?\s*(\d{11,})\b/gi, "$1 [redacted]")
			// a bare card-length digit run keeps only its last four
			.replace(/\b\d{13,19}\b/g, (m) => `**${m.slice(-4)}`)
	);
}

/* ---------------- note building ---------------- */

export interface TxnNoteOpts {
	/** Vault path of the saved original (an .eml, a PDF), embedded when present. */
	sourcePath?: string;
	/** Deep link back to the message in Outlook or Gmail. */
	sourceUrl?: string;
	today: string;
	/** Verdict from settleOrder; drives review: true and the warning callout. */
	recon?: TxnRecon;
	repaired?: boolean;
}

const yq = (s: string): string => `"${s.replace(/"/g, "'")}"`;

/** Filesystem-safe, collapsed, and trimmed. Mirrors docNiceName's character
 *  class so document and transaction notes name themselves the same way. */
export function txnSafe(s: string): string {
	return s.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
}

/** "2026-07-18 The Home Depot WN65276696". Date first so a folder sorts
 *  chronologically; order id last so the name is unique and greppable. */
export function txnOrderName(o: TxnOrder, today = ""): string {
	const d = o.date || today;
	return txnSafe([d, o.vendor || "Unknown", o.orderId].filter(Boolean).join(" ")) || "order";
}

/** "2026-07-18 The Home Depot 40 lbs. Pool Salt (WN65276696-1)". The trailing
 *  order-id-and-line suffix is the stable identity: reprocessing the same order
 *  finds the same note instead of writing a second one. */
export function txnItemName(o: TxnOrder, item: TxnItem, index: number, today = ""): string {
	const d = o.date || today;
	// redact BEFORE truncating: a filename is the one place a secret cannot be
	// fixed by editing the note, and truncation alone can leave a usable prefix
	const clean = redactSecrets(item.name);
	const short = clean.length > 48 ? clean.slice(0, 48).trim() : clean;
	const id = o.orderId ? `(${o.orderId}-${index + 1})` : `(${index + 1})`;
	return txnSafe([d, o.vendor || "Unknown", short, id].filter(Boolean).join(" ")) || `item-${index + 1}`;
}

/** <base>/Orders/<year> and <base>/Items/<year>. Year folders keep a decade of
 *  buying from turning into one unopenable directory. */
export function txnFolder(base: string, o: TxnOrder, kind: "order" | "item", today = ""): string {
	const d = o.date || today;
	const year = /^\d{4}/.test(d) ? d.slice(0, 4) : "Undated";
	return `${base.replace(/^\/+|\/+$/g, "")}/${kind === "order" ? "Orders" : "Items"}/${year}`;
}

/** The order note: totals as properties, its line items linked, and any
 *  reconciliation warning stated in the open rather than buried. */
export function buildOrderNote(o: TxnOrder, opts: TxnNoteOpts): string {
	const date = o.date || opts.today;
	const flagged = !!opts.recon && !opts.recon.ok;
	const num = (k: string, v: number | null) => (v == null ? [] : [`${k}: ${v}`]);
	const fm = [
		"---",
		"type: capture-txn-order",
		...(o.orderId ? [`order-id: ${yq(o.orderId)}`] : []),
		...(o.vendor ? [`vendor: ${yq(o.vendor)}`] : []),
		`date: ${date}`,
		`doc-type: ${o.docType}`,
		`scope: ${o.scope}`,
		`currency: ${o.currency}`,
		...num("subtotal", o.subtotal),
		...num("tax", o.tax),
		...num("shipping", o.shipping),
		...num("discount", o.discount),
		// `amount` carries the order total under the same name capture-doc uses,
		// so one Bases column sums documents and orders together
		...num("amount", o.total),
		...(o.due ? [`due: ${o.due}`] : []),
		...(o.payment ? [`payment: ${yq(redactSecrets(o.payment))}`] : []),
		...(o.account ? [`account: ${yq(o.account)}`] : []),
		`items: ${o.items.length}`,
		...(flagged ? ["review: true"] : []),
		...(opts.repaired ? ["repaired: true"] : []),
		...(opts.sourcePath ? [`source: ${yq(`[[${opts.sourcePath}]]`)}`] : []),
		...(opts.sourceUrl ? [`source-url: ${yq(opts.sourceUrl)}`] : []),
		"---",
	].join("\n");

	const title = `${o.vendor || "Order"}${o.orderId ? ` ${o.orderId}` : ""}`;
	const parts = [fm, `# ${title}`];

	if (flagged && opts.recon)
		parts.push(
			[
				"> [!warning] Check this order",
				"> The extracted lines do not match the printed totals, so the amounts below are not trusted yet.",
				...opts.recon.reasons.map((r) => `> - ${r}`),
			].join("\n")
		);
	if (opts.repaired)
		parts.push("> [!note] Repaired\n> A duplicated line item was removed because the printed subtotal proved it was rendered twice, not bought twice.");

	if (o.items.length)
		parts.push(
			[
				"| Item | Qty | Amount | Category |",
				"| --- | --- | --- | --- |",
				...o.items.map((i, n) => `| [[${txnItemName(o, i, n, opts.today)}\\|${redactSecrets(i.name)}]] | ${i.quantity} | ${i.amount ?? "-"} | ${i.category} |`),
			].join("\n")
		);

	const totals = [
		o.subtotal != null ? `- **Subtotal:** ${o.subtotal}` : null,
		o.discount ? `- **Discounts:** -${o.discount}` : null,
		o.shipping != null ? `- **Shipping:** ${o.shipping}` : null,
		o.tax != null ? `- **Tax:** ${o.tax}` : null,
		o.total != null ? `- **Total:** ${o.currency} ${o.total}` : null,
		o.due ? `- **Due:** ${o.due}` : null,
	].filter(Boolean) as string[];
	if (totals.length) parts.push(totals.join("\n"));
	if (opts.sourcePath) parts.push(`![[${opts.sourcePath}]]`);
	return parts.join("\n\n") + "\n";
}

/** One line item as its own note, which is what makes category analytics work:
 *  a mixed order becomes one row per category instead of one row for the lot.
 *
 *  `amount` is the printed line total and `effective` adds this line's share of
 *  tax, shipping, and discount. Sum `amount` by category to see list prices;
 *  sum `effective` to see money actually spent. Both are plain numbers so
 *  Bases can total them. */
export function buildItemNote(o: TxnOrder, item: TxnItem, index: number, allocated: number, opts: TxnNoteOpts): string {
	const date = o.date || opts.today;
	const eff = item.amount == null ? null : round2(item.amount + allocated);
	const fm = [
		"---",
		"type: capture-txn-item",
		...(o.orderId ? [`order-id: ${yq(o.orderId)}`] : []),
		`parent-order: ${yq(`[[${txnOrderName(o, opts.today)}]]`)}`,
		...(o.vendor ? [`vendor: ${yq(o.vendor)}`] : []),
		`date: ${date}`,
		`scope: ${o.scope}`,
		`category: ${item.category}`,
		`item: ${yq(redactSecrets(item.name))}`,
		...(item.sku ? [`sku: ${yq(item.sku)}`] : []),
		`quantity: ${item.quantity}`,
		`currency: ${o.currency}`,
		...(item.amount == null ? [] : [`amount: ${item.amount}`]),
		...(allocated ? [`allocated: ${allocated}`] : []),
		...(eff == null ? [] : [`effective: ${eff}`]),
		...(opts.recon && !opts.recon.ok ? ["review: true"] : []),
		"---",
	].join("\n");
	const detail = [
		`- **Order:** [[${txnOrderName(o, opts.today)}]]`,
		item.amount != null ? `- **Line total:** ${o.currency} ${item.amount}` : null,
		allocated ? `- **Share of tax, shipping, and discounts:** ${allocated}` : null,
		eff != null ? `- **Effective cost:** ${o.currency} ${eff}` : null,
		item.sku ? `- **SKU:** ${item.sku}` : null,
	].filter(Boolean) as string[];
	return [fm, `# ${redactSecrets(item.name)}`, detail.join("\n")].join("\n\n") + "\n";
}

/* ---------------- write planning ---------------- */

export interface TxnWrite {
	kind: "order" | "item";
	name: string;
	folder: string;
	body: string;
	/** True when a note with this identity already exists and is being replaced
	 *  rather than added; the caller can then skip or overwrite. */
	update: boolean;
}

/** Everything one extracted order should write, with each note already marked
 *  as an insert or an update.
 *
 *  Identity is the order id, which is why the shipping and delivery mails that
 *  follow a confirmation update the same notes instead of adding a second copy
 *  of the same purchase. An order with no id at all cannot be deduplicated, so
 *  it is always an insert and the caller should expect the odd repeat. */
export function planOrderWrites(o: TxnOrder, base: string, opts: TxnNoteOpts, knownOrderIds: ReadonlySet<string> = new Set()): TxnWrite[] {
	const update = !!o.orderId && knownOrderIds.has(o.orderId);
	const shares = allocateExtras(o);
	const out: TxnWrite[] = [
		{
			kind: "order",
			name: txnOrderName(o, opts.today),
			folder: txnFolder(base, o, "order", opts.today),
			body: buildOrderNote(o, opts),
			update,
		},
	];
	o.items.forEach((item, n) =>
		out.push({
			kind: "item",
			name: txnItemName(o, item, n, opts.today),
			folder: txnFolder(base, o, "item", opts.today),
			body: buildItemNote(o, item, n, shares[n] ?? 0, opts),
			update,
		})
	);
	return out;
}

/* ---------------- reading a saved message ---------------- */

/** What a .eml file yields. Enough to run the same pipeline over a message
 *  saved to disk as over one fetched from Graph, which is what makes the
 *  extractor testable against real mail without a mailbox. */
export interface ParsedEmail {
	from: string;
	subject: string;
	date: string;
	html: string;
	text: string;
}

/** Undo the =XX escaping of quoted-printable, including soft line breaks. Order
 *  mail is almost always quoted-printable, and reading it raw turns every "="
 *  in a URL into gibberish and splits values across lines. */
export function decodeQuotedPrintable(s: string): string {
	return s
		.replace(/=(?:\r\n|\n|\r)/g, "")
		.replace(/=([0-9A-Fa-f]{2})/g, (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Decode base64 to a byte-per-character string in whichever runtime this is:
 *  Buffer under node for the tests, atob inside Obsidian. Charset is applied
 *  afterwards by decodeCharset, so this must not guess at text encoding. */
function fromBase64(s: string): string {
	const clean = s.replace(/\s+/g, "");
	try {
		// typeof guards rather than a global object: this has to run both under
		// node for the tests and inside Obsidian, and neither name is declared in
		// the other environment
		if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64").toString("latin1");
		if (typeof atob !== "undefined") return atob(clean);
	} catch {
		/* fall through to empty */
	}
	return "";
}

/** Reinterpret a byte-per-character string according to the part's charset.
 *
 *  Quoted-printable and base64 both yield one character per byte, so a UTF-8
 *  apostrophe arrives as the three characters "â€™" rather than "'". Without
 *  this step every smart quote, dash, and currency symbol in an order email
 *  turns to mojibake, and Amazon's invisible bidi marks survive stripping
 *  because they are no longer the characters they claim to be.
 *
 *  An unlabelled part is treated as UTF-8, which is what modern senders use,
 *  but the decode is thrown away if it produced replacement characters: that
 *  means the bytes were not UTF-8 after all and the original is the better
 *  guess. */
export function decodeCharset(s: string, charset: string): string {
	const cs = charset.toLowerCase();
	const declared = /utf-?8/.test(cs);
	if (!declared && cs && !/us-ascii|ascii/.test(cs)) return s;
	if (!/[-ÿ]/.test(s)) return s;
	try {
		const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
		const out = new TextDecoder("utf-8").decode(bytes);
		if (!declared && out.includes("�")) return s;
		return out;
	} catch {
		return s;
	}
}

/** RFC 2047 encoded-word headers ("=?utf-8?Q?...?="), as used for any subject
 *  with a non-ASCII character in it. */
export function decodeHeaderWords(s: string): string {
	return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs: string, enc: string, body: string) =>
		decodeCharset(enc.toUpperCase() === "B" ? fromBase64(body) : decodeQuotedPrintable(body.replace(/_/g, " ")), cs)
	);
}

/** Split a raw message into headers and body, unfolding continuation lines so
 *  a wrapped Content-Type still reads as one value. */
function splitMessage(raw: string): { headers: Record<string, string>; body: string } {
	const norm = raw.replace(/\r\n?/g, "\n");
	const gap = norm.indexOf("\n\n");
	const head = gap < 0 ? norm : norm.slice(0, gap);
	const body = gap < 0 ? "" : norm.slice(gap + 2);
	const headers: Record<string, string> = {};
	for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
		const c = line.indexOf(":");
		if (c < 0) continue;
		const k = line.slice(0, c).trim().toLowerCase();
		// first wins: trace headers repeat and the topmost is the latest hop
		if (!(k in headers)) headers[k] = line.slice(c + 1).trim();
	}
	return { headers, body };
}

/** Decode one MIME part: transfer encoding first, then charset. Both steps are
 *  needed and the order matters, since the transfer encoding is what produces
 *  the raw bytes the charset describes. */
function decodePart(headers: Record<string, string>, body: string): string {
	const enc = (headers["content-transfer-encoding"] ?? "").toLowerCase();
	const charset = /charset="?([^";\s]+)"?/i.exec(headers["content-type"] ?? "")?.[1] ?? "";
	const raw = enc.includes("quoted-printable") ? decodeQuotedPrintable(body) : enc.includes("base64") ? fromBase64(body) : body;
	return decodeCharset(raw, charset);
}

/** Walk a message, collecting the best text/html and text/plain payloads.
 *  Recurses through multipart containers, which is how a message with both an
 *  alternative body and an attachment is laid out. */
function collectParts(raw: string, out: { html: string; text: string }): void {
	const { headers, body } = splitMessage(raw);
	const ctype = (headers["content-type"] ?? "text/plain").toLowerCase();
	const boundary = /boundary="?([^";\n]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
	if (ctype.startsWith("multipart/") && boundary) {
		const marker = `--${boundary}`;
		const chunks = body.split(marker);
		// first chunk is the preamble, last is the closing "--"; both are noise
		for (const chunk of chunks.slice(1)) {
			if (chunk.startsWith("--")) break;
			collectParts(chunk.replace(/^\n/, ""), out);
		}
		return;
	}
	const disposition = (headers["content-disposition"] ?? "").toLowerCase();
	if (disposition.startsWith("attachment")) return;
	const payload = decodePart(headers, body);
	if (ctype.startsWith("text/html")) {
		if (payload.length > out.html.length) out.html = payload;
	} else if (ctype.startsWith("text/plain")) {
		if (payload.length > out.text.length) out.text = payload;
	}
}

/** Parse a saved .eml into the fields the transaction pipeline needs. */
export function parseEmailFile(raw: string): ParsedEmail {
	const { headers } = splitMessage(raw);
	const out = { html: "", text: "" };
	collectParts(raw, out);
	return {
		from: decodeHeaderWords(headers["from"] ?? ""),
		subject: decodeHeaderWords(headers["subject"] ?? ""),
		date: headers["date"] ?? "",
		html: out.html,
		text: out.text,
	};
}

/* ---------------- analytics ---------------- */

/** ISO-8601 week key, "2026-W29". Weeks belong to the year containing their
 *  Thursday, which is why late-December and early-January spending can land in
 *  a week labeled with the neighbouring year; that is correct, not a bug. */
export function isoWeekKey(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return "";
	const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
	if (isNaN(d.getTime())) return "";
	const day = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - day);
	const year = d.getUTCFullYear();
	const jan1 = Date.UTC(year, 0, 1);
	const week = Math.ceil(((d.getTime() - jan1) / 86400000 + 1) / 7);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/** One line item as the rollup sees it. */
export interface SpendItem {
	path: string;
	vendor: string;
	date: string;
	category: string;
	scope: string;
	currency: string;
	effective: number;
	review?: boolean;
}

const fmtMoney = (n: number): string => (n < 0 ? "-" : "") + Math.abs(round2(n)).toFixed(2);

/** Total a set of items by some key, biggest first. */
function totalBy(items: readonly SpendItem[], key: (i: SpendItem) => string): { key: string; total: number; n: number }[] {
	const g = new Map<string, { key: string; total: number; n: number }>();
	for (const i of items) {
		const k = key(i);
		if (!k) continue;
		const e = g.get(k) ?? { key: k, total: 0, n: 0 };
		e.total = round2(e.total + i.effective);
		e.n++;
		g.set(k, e);
	}
	return [...g.values()].sort((a, b) => b.total - a.total);
}

/** The spending rollup: this week, month, and year at the top, then category,
 *  month, week, and vendor breakdowns.
 *
 *  Personal and business spend are separated rather than summed, because a
 *  household budget and a reimbursable company purchase are different questions
 *  and adding them answers neither. Amounts are `effective`, so each line
 *  carries its share of tax and shipping and the categories add up to what was
 *  actually charged. */
export function buildSpendRollup(items: readonly SpendItem[], today: string, scope = "personal"): string {
	const mine = items.filter((i) => i.scope === scope && isFinite(i.effective));
	const fm = ["---", "type: capture-spend", `date: ${today}`, `scope: ${scope}`, "generated: true", "---"].join("\n");
	const parts = [`${fm}\n# Spending (${scope}) · as of ${today}`];
	if (!mine.length) return `${parts[0]}\n\n*No ${scope} line items captured yet.*\n`;

	const month = today.slice(0, 7);
	const year = today.slice(0, 4);
	const week = isoWeekKey(today);
	const sum = (xs: readonly SpendItem[]) => round2(xs.reduce((a, i) => a + i.effective, 0));
	const thisWeek = mine.filter((i) => isoWeekKey(i.date) === week);
	const thisMonth = mine.filter((i) => i.date.slice(0, 7) === month);
	const thisYear = mine.filter((i) => i.date.slice(0, 4) === year);
	parts.push(
		[
			"## Now",
			"",
			`- **This week (${week}):** ${fmtMoney(sum(thisWeek))} across ${thisWeek.length} item${thisWeek.length === 1 ? "" : "s"}`,
			`- **This month (${month}):** ${fmtMoney(sum(thisMonth))} across ${thisMonth.length} item${thisMonth.length === 1 ? "" : "s"}`,
			`- **This year (${year}):** ${fmtMoney(sum(thisYear))} across ${thisYear.length} item${thisYear.length === 1 ? "" : "s"}`,
		].join("\n")
	);

	const table = (heading: string, label: string, rows: { key: string; total: number; n: number }[], chrono = false) => {
		if (!rows.length) return;
		const ordered = chrono ? [...rows].sort((a, b) => (a.key < b.key ? 1 : -1)) : rows;
		parts.push(
			`## ${heading}\n\n| ${label} | Items | Amount |\n| --- | --- | --- |\n` +
				ordered.map((r) => `| ${r.key} | ${r.n} | ${fmtMoney(r.total)} |`).join("\n")
		);
	};
	table(`Categories this month (${month})`, "Category", totalBy(thisMonth, (i) => i.category));
	table(`Categories this year (${year})`, "Category", totalBy(thisYear, (i) => i.category));
	table("By month", "Month", totalBy(mine, (i) => i.date.slice(0, 7)).slice(0, 24), true);
	table("By week", "Week", totalBy(mine, (i) => isoWeekKey(i.date)).slice(0, 12), true);
	table("By year", "Year", totalBy(mine, (i) => i.date.slice(0, 4)), true);
	table("Top vendors", "Vendor", totalBy(mine, (i) => i.vendor).slice(0, 15));

	const flagged = items.filter((i) => i.review);
	if (flagged.length)
		parts.push(
			`## Needs review\n\nThese did not match their order's printed totals, so they are not counted reliably above.\n\n` +
				flagged.slice(0, 30).map((i) => `- [[${i.path}\\|${i.vendor} ${i.date}]], ${fmtMoney(i.effective)}`).join("\n")
		);
	return parts.join("\n\n") + "\n";
}

/** The transactions base: one file, several single-axis views.
 *
 *  Bases groups on one property at a time, so a category-by-month pivot is not
 *  expressible; each axis gets its own view instead and Power Chart covers the
 *  visual cross-section. Every money column is summarized on `effective` rather
 *  than `amount`, so the totals include tax and shipping. */
export function buildTxnBase(powerBases: boolean): string {
	const table = powerBases ? "powerbases-table" : "table";
	const itemOrder = ["file.name", "note.vendor", "note.date", "note.category", "note.quantity", "note.amount", "note.effective"];
	const view = (name: string, groupBy: string | null, extra: string[] = []) =>
		[
			`  - type: ${table}`,
			`    name: ${name}`,
			"    filters:",
			"      and:",
			'        - note.type == "capture-txn-item"',
			...extra,
			"    order:",
			...itemOrder.map((o) => `      - ${o}`),
			...(groupBy ? ["    groupBy:", `      property: ${groupBy}`] : []),
			"    summaries:",
			"      note.effective: Sum",
			"      note.amount: Sum",
		].join("\n");
	return [
		"formulas:",
		'  month: \'note.date.format("YYYY-MM")\'',
		'  year: \'note.date.format("YYYY")\'',
		"views:",
		view("By category", "note.category"),
		view("By month", "formula.month"),
		view("By vendor", "note.vendor"),
		view("Needs review", null, ["        - note.review == true"]),
		[
			`  - type: ${table}`,
			"    name: Orders",
			"    filters:",
			"      and:",
			'        - note.type == "capture-txn-order"',
			"    order:",
			"      - file.name",
			"      - note.vendor",
			"      - note.date",
			"      - note.items",
			"      - note.amount",
			"      - note.due",
			"    summaries:",
			"      note.amount: Sum",
		].join("\n"),
		...(powerBases
			? [
					[
						"  - type: powerbases-chart",
						"    name: Category chart",
						"    filters:",
						"      and:",
						'        - note.type == "capture-txn-item"',
						"    groupBy: note.category",
						"    measure: sum",
						"    measureProp: note.effective",
						"    chart: bar",
					].join("\n"),
				]
			: []),
		"",
	].join("\n");
}

/* ---------------- CSV backfill ---------------- */

/** Split CSV text into rows of fields, honoring quoted fields that contain
 *  commas, newlines, and doubled quotes. Amazon's export has product names with
 *  commas in almost every row, so a naive split destroys the file. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const s = text.replace(/\r\n?/g, "\n");
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quoted) {
			if (c === '"') {
				if (s[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"') quoted = true;
		else if (c === ",") {
			row.push(field);
			field = "";
		} else if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.some((f) => f.trim()));
}

/** Column lookup that survives Amazon renaming "Order ID" to "order id" or
 *  adding punctuation, which it has done between export versions. */
function columnIndex(header: string[], ...names: string[]): number {
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const wanted = names.map(norm);
	for (let i = 0; i < header.length; i++) if (wanted.includes(norm(header[i]))) return i;
	return -1;
}

/** "2026-07-10T00:25:50Z" or "2026-07-10" or "7/10/2026" to an ISO date. */
export function csvDate(v: string): string {
	const s = v.trim();
	const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
	const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
	if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
	return "";
}

/** Amazon's "Request My Data" retail export into orders and line items.
 *
 *  The file is already line-item grained, one row per product per shipment, so
 *  rows are grouped by order id and each becomes an item. This is the sanctioned
 *  route to order history: no scraping, no stored credentials, and it carries
 *  the per-item detail a card statement never will.
 *
 *  Totals are derived by summing the rows rather than read from a header, so
 *  they are self-consistent by construction. Returns and refunds live in a
 *  separate file in the same export and are not covered here. */
export function parseAmazonOrderCsv(text: string): TxnOrder[] {
	const rows = parseCsv(text);
	if (rows.length < 2) return [];
	const h = rows[0];
	const cOrder = columnIndex(h, "Order ID", "OrderID");
	const cDate = columnIndex(h, "Order Date", "OrderDate");
	const cName = columnIndex(h, "Product Name", "Title");
	const cAsin = columnIndex(h, "ASIN", "ASIN/ISBN");
	const cQty = columnIndex(h, "Quantity");
	const cUnit = columnIndex(h, "Unit Price", "Purchase Price Per Unit");
	const cSub = columnIndex(h, "Shipment Item Subtotal", "Item Subtotal");
	const cTax = columnIndex(h, "Shipment Item Subtotal Tax", "Item Subtotal Tax");
	const cShip = columnIndex(h, "Shipping Charge");
	const cDisc = columnIndex(h, "Total Discounts");
	const cCur = columnIndex(h, "Currency");
	const cPay = columnIndex(h, "Payment Instrument Type");
	if (cOrder < 0 || cName < 0) return [];

	const at = (r: string[], i: number): string => (i >= 0 && i < r.length ? r[i].trim() : "");
	const byOrder = new Map<string, TxnOrder>();
	for (const r of rows.slice(1)) {
		const id = at(r, cOrder);
		const name = at(r, cName);
		if (!id || !name) continue;
		const qtyRaw = parseInt(at(r, cQty), 10);
		const qty = isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
		const unit = money(at(r, cUnit));
		const sub = money(at(r, cSub));
		// the printed line subtotal is authoritative; unit price times quantity
		// is the fallback for older exports that omit it
		const amount = sub != null ? sub : unit != null ? round2(unit * qty) : null;

		let o = byOrder.get(id);
		if (!o) {
			o = {
				orderId: id,
				vendor: "Amazon",
				date: csvDate(at(r, cDate)),
				currency: at(r, cCur).toUpperCase() || "USD",
				subtotal: 0,
				tax: 0,
				shipping: 0,
				discount: 0,
				total: null,
				due: "",
				docType: "order",
				scope: "personal",
				payment: at(r, cPay),
				account: "",
				items: [],
			};
			byOrder.set(id, o);
		}
		o.items.push({ name, sku: at(r, cAsin), quantity: qty, amount, category: "other" });
		o.subtotal = round2((o.subtotal ?? 0) + (amount ?? 0));
		o.tax = round2((o.tax ?? 0) + (money(at(r, cTax)) ?? 0));
		o.shipping = round2((o.shipping ?? 0) + (money(at(r, cShip)) ?? 0));
		o.discount = round2((o.discount ?? 0) + Math.abs(money(at(r, cDisc)) ?? 0));
	}
	for (const o of byOrder.values()) o.total = round2((o.subtotal ?? 0) + (o.tax ?? 0) + (o.shipping ?? 0) - (o.discount ?? 0));
	return [...byOrder.values()];
}

/* ---------------- categorizing a backlog ---------------- */

/** Ask the model to sort product names into the taxonomy. Used for CSV backfill,
 *  which carries no category of its own, and for anything that landed in
 *  "other". Names are numbered so the reply can be matched positionally without
 *  depending on the model echoing them back verbatim. */
export function buildCategorizePrompt(names: readonly string[]): { system: string; user: string } {
	return {
		system:
			"You assign a spending category to each numbered product. Reply with ONLY a JSON object mapping each number to a category, " +
			'for example {"1":"groceries","2":"pets"}. ' +
			`Every value must be one of: ${TXN_CATEGORIES.join(", ")}. Use "other" only when nothing else fits.`,
		user: names.map((n, i) => `${i + 1}. ${n}`).join("\n"),
	};
}

/** Positional categories from the reply, aligned to the names that were sent.
 *  Anything missing or outside the taxonomy comes back as "other", so the
 *  result is always the same length as the input. */
export function parseCategorized(reply: string, count: number): string[] {
	const out = new Array<string>(count).fill("other");
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
		const cat = String(v ?? "").toLowerCase().trim();
		if (i >= 0 && i < count && (TXN_CATEGORIES as readonly string[]).includes(cat)) out[i] = cat;
	}
	return out;
}

/* ---------------- mail rules ---------------- */

/** The bits of a message a rule can see. Deliberately header-only: bodies cost
 *  a network round trip each, so rules decide from what a list already carries
 *  and only a match earns a fetch. */
export interface TxnMail {
	id: string;
	from: string;
	subject: string;
	date: string;
	hasAttachments?: boolean;
}

/** A user-defined mail rule: conditions on an incoming message, and what to do
 *  with the transactions extracted from it. */
export interface TxnRule {
	name?: string;
	from?: string;
	subject?: string;
	hasAttachment?: boolean;
	vendor?: string;
	scope?: string;
	folder?: string;
	enabled?: boolean;
}

/** The domain a message actually came from. CoServ's bills are sent by
 *  smarthub.coop and Home Depot's by order.homedepot.com, so a rule written
 *  against the brand's website domain would never fire. Always match what the
 *  envelope says. */
export function senderDomain(from: string): string {
	const m = /<([^>]+)>/.exec(from);
	const addr = (m ? m[1] : from).trim();
	const at = addr.lastIndexOf("@");
	return at < 0 ? "" : addr.slice(at + 1).toLowerCase().trim();
}

/** The bare address, display name stripped. */
export function senderAddress(from: string): string {
	const m = /<([^>]+)>/.exec(from);
	return (m ? m[1] : from).trim().toLowerCase();
}

/** Whether a rule's conditions all match. A rule with no conditions never
 *  matches, so an empty row in settings cannot quietly become a catch-all that
 *  sends every message in the mailbox to the AI. */
export function matchTxnRule(r: TxnRule, m: TxnMail): boolean {
	if (r.enabled === false) return false;
	if (!r.from && !r.subject && r.hasAttachment == null) return false;
	if (r.from) {
		const needle = r.from.toLowerCase().trim();
		// display name, address, and domain are all fair game, so "coserv"
		// matches CoServ <coserv@smarthub.coop> and "smarthub.coop" does too
		if (!m.from.toLowerCase().includes(needle) && !senderDomain(m.from).includes(needle)) return false;
	}
	if (r.subject && !m.subject.toLowerCase().includes(r.subject.toLowerCase().trim())) return false;
	if (r.hasAttachment != null && !!m.hasAttachments !== r.hasAttachment) return false;
	return true;
}

/** The first matching rule, or null. First match wins so the order in settings
 *  is the priority order, exactly like the document filing rules. */
export function resolveTxnRule(rules: readonly TxnRule[], m: TxnMail): TxnRule | null {
	for (const r of rules) if (matchTxnRule(r, m)) return r;
	return null;
}

/** A starter rule set covering the senders seen in real mail. Shipped so the
 *  feature does something useful before anyone opens settings; every field is
 *  editable and the list is only a default, never re-applied over user edits. */
export const DEFAULT_TXN_RULES: TxnRule[] = [
	{ name: "Amazon orders", from: "amazon.com", subject: "ordered:", enabled: true },
	{ name: "Amazon shipments", from: "amazon.com", subject: "shipped:", enabled: true },
	{ name: "Home Depot", from: "order.homedepot.com", enabled: true },
	{ name: "Microsoft", from: "microsoft-noreply@microsoft.com", subject: "order", enabled: true },
	{ name: "CoServ (electric)", from: "smarthub.coop", vendor: "CoServ", enabled: true },
];

/** Message ids already handled, newest last, capped so the list cannot grow
 *  without bound. Returning a new array keeps the caller's settings object
 *  replaceable rather than mutated in place. */
export function rememberProcessed(seen: readonly string[], id: string, cap = 2000): string[] {
	if (!id) return [...seen];
	const out = seen.filter((s) => s !== id);
	out.push(id);
	return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Messages worth spending a body fetch and an AI call on: rule matches that
 *  have not already been processed. */
export function selectTxnMail(mail: readonly TxnMail[], rules: readonly TxnRule[], seen: readonly string[]): { mail: TxnMail; rule: TxnRule }[] {
	const done = new Set(seen);
	const out: { mail: TxnMail; rule: TxnRule }[] = [];
	for (const m of mail) {
		if (done.has(m.id)) continue;
		const rule = resolveTxnRule(rules, m);
		if (rule) out.push({ mail: m, rule });
	}
	return out;
}

/** A rule's overrides folded onto what the model extracted. The model reads the
 *  document; the rule encodes what the user knows about the sender, so the rule
 *  wins on the fields it sets and stays out of the way on the rest. */
export function applyTxnRule(o: TxnOrder, r: TxnRule | null): TxnOrder {
	if (!r) return o;
	return {
		...o,
		vendor: r.vendor?.trim() || o.vendor,
		scope: r.scope === "business" || r.scope === "personal" ? r.scope : o.scope,
	};
}
