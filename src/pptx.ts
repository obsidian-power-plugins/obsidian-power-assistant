/* Pure logic for reading a PowerPoint deck. A .pptx is a ZIP of XML: slide text
 * lives in <a:t> runs inside ppt/slides/slideN.xml, speaker notes in
 * ppt/notesSlides/, and pictures in ppt/media/ (wired to a slide by its .rels).
 * Once the caller has unzipped the entries, everything here is string work with
 * no Obsidian imports, so it is all covered by tests.ts. */

export type OcrMode = "none" | "large" | "all";

export interface DeckImage {
	/** Where the picture landed in the vault, for an embed link. */
	link: string;
	/** What the image reader found, or empty when it wasn't read. */
	text: string;
}

export interface DeckSlide {
	/** 1-based slide number, in presentation order. */
	n: number;
	title: string;
	lines: string[];
	notes: string;
	images: DeckImage[];
}

/** XML entities back to text. `&amp;` goes last so `&amp;lt;` stays literal. */
function decode(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
		.replace(/&amp;/g, "&");
}

/** ppt/slides/slideN.xml entry names in slide order (2 sorts before 10). */
export function slideOrder(names: string[]): string[] {
	return names
		.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
		.sort((a, b) => slideNumber(a) - slideNumber(b));
}

/** The N in .../slideN.xml, or 0 when the name has none. */
export function slideNumber(name: string): number {
	return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

/** Each <a:p> paragraph as one line, its <a:t> runs joined. Empty ones drop. */
export function slideParagraphs(xml: string): string[] {
	const out: string[] = [];
	for (const p of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
		const text = (p.match(/<a:t>[\s\S]*?<\/a:t>/g) ?? []).map((r) => decode(r.replace(/<\/?a:t>/g, ""))).join("");
		if (text.trim()) out.push(text.trim());
	}
	return out;
}

/** A slide's title and its remaining lines. The title comes from the shape
 *  carrying a title placeholder; a deck without one promotes its first line. */
export function slideText(xml: string): { title: string; lines: string[] } {
	const all = slideParagraphs(xml);
	const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];
	const titleShape = shapes.find((sp) => /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(sp));
	const title = titleShape ? slideParagraphs(titleShape)[0] ?? "" : "";
	if (!title) return { title: all[0] ?? "", lines: all.slice(1) };
	const i = all.indexOf(title);
	return { title, lines: i >= 0 ? [...all.slice(0, i), ...all.slice(i + 1)] : all };
}

/** Speaker notes for a slide. The slide-number placeholder renders as a bare
 *  number, which is noise rather than notes, so it goes. */
export function notesText(xml: string): string {
	return slideParagraphs(xml)
		.filter((p) => !/^\d+$/.test(p))
		.join("\n")
		.trim();
}

/** PowerPoint measures everything in English Metric Units. */
const EMU_PER_INCH = 914400;

export interface SlidePicture {
	/** Zip entry, e.g. "ppt/media/image3.png". */
	entry: string;
	/** Smallest side as DRAWN on the slide, in inches. */
	inches: number;
}

/** A slide's relationship ids mapped to their targets, normalized to zip entry
 *  names. Attribute order varies, so each is read on its own. */
export function relTargets(relsXml: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
		const id = tag.match(/\bId="([^"]+)"/)?.[1];
		const target = tag.match(/\bTarget="([^"]+)"/)?.[1];
		if (id && target) out[id] = target.replace(/^\.\.\//, "ppt/").replace(/^\//, "");
	}
	return out;
}

/** The pictures placed on a slide and how big each is actually DRAWN. Source
 *  pixels say nothing about the job a picture does: a deck's bullet icons ship
 *  as 256x256 PNGs and render at a third of an inch, so only the drawn extent
 *  separates a chart from decoration. A picture placed more than once keeps its
 *  largest placement. */
export function slidePictures(slideXml: string, relsXml: string): SlidePicture[] {
	const rels = relTargets(relsXml);
	const best = new Map<string, number>();
	for (const pic of slideXml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) ?? []) {
		const id = pic.match(/<a:blip\b[^>]*\br:embed="([^"]+)"/)?.[1];
		const entry = id ? rels[id] : undefined;
		if (!entry || !/\/media\//.test(entry)) continue;
		const ext = pic.match(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
		const inches = ext ? Math.min(Number(ext[1]), Number(ext[2])) / EMU_PER_INCH : 0;
		best.set(entry, Math.max(best.get(entry) ?? 0, inches));
	}
	return [...best].map(([entry, inches]) => ({ entry, inches }));
}

/** What a picture earns: dropped entirely, embedded, or embedded and read.
 *  Below the bar is decoration, and decoration is noise in the note as well as
 *  a wasted call, so it goes. "all" spares nothing, for the rare deck where the
 *  small marks matter. A picture with no drawn extent counts as decoration. */
export function pictureAction(inches: number, mode: OcrMode, minInches: number): "skip" | "embed" | "read" {
	if (mode === "all") return "read";
	if (inches < minInches) return "skip";
	return mode === "none" ? "embed" : "read";
}

/** The note that indexes a deck: a section per slide with its text, each
 *  picture embedded with whatever the reader found under it, and the notes. */
export function buildDeckNote(d: { name: string; source: string; date: string; slides: DeckSlide[] }): string {
	const out: string[] = ["---", "type: capture", "capture: powerpoint", `source: "[[${d.source}]]"`];
	out.push(`slides: ${d.slides.length}`, `created: ${d.date}`, "---", "", `# ${d.name}`, "");
	out.push(`[[${d.source}|Open the original deck]] · ${d.slides.length} slide${d.slides.length === 1 ? "" : "s"} · captured ${d.date}`);
	for (const s of d.slides) {
		out.push("", `## ${s.n}. ${s.title || "(untitled slide)"}`);
		if (s.lines.length) out.push("", ...s.lines);
		for (const img of s.images) {
			out.push("", `![[${img.link}]]`);
			if (img.text.trim()) out.push("", ...img.text.trim().split("\n").map((l) => `> ${l}`));
		}
		if (s.notes.trim()) out.push("", `**Notes:** ${s.notes.trim().split("\n").join(" ")}`);
	}
	out.push("");
	return out.join("\n");
}
