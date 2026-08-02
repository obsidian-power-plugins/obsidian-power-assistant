// The .docx projection of a capture note. Pure mapping from the tested
// ExportModel (pipeline.ts) onto the dolanmiu `docx` object model.
//
// Formatting is matched cell-for-cell to the AI-notetaker recap Steve's HR
// manager shared (which the same library produced): Arial throughout on a
// #262626 body; a 22pt bold navy title, a 12pt bold blue participant line, a
// 10pt italic gray date; 14pt bold navy headings each underlined with a thin
// blue rule; ▸ triangle bullets; and an Owner/Task/Deadline table with a navy
// header (white text) and light-gray gridlines. 1-inch margins, no footer.
import {
	AlignmentType,
	BorderStyle,
	Document,
	HeadingLevel,
	ImageRun,
	LevelFormat,
	Paragraph,
	ShadingType,
	Table,
	TableCell,
	TableLayoutType,
	TableRow,
	TextRun,
	VerticalAlign,
	WidthType,
} from "docx";
import type { ExportImage, ExportModel, ExportSection } from "./pipeline";

// Aptos is the Microsoft 365 default body font; it's what the reference recap
// resolves its theme font to. Word shows it in the font box as "Aptos (Body)".
const FONT = "Aptos";
const NAVY = "1F3864"; // title, headings, table header fill
const BLUE = "2E5C8A"; // participant line, heading underline rule
const GRAY = "595959"; // date line
const BODY = "262626"; // body text
const GRID = "BFBFBF"; // table cell borders
const WHITE = "FFFFFF";
const BULLETS = "recap-bullets";

// sizes are half-points (22 = 11pt); spacing is twentieths of a point (twips).
function run(text: string, o: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}): TextRun {
	return new TextRun({ text, font: FONT, size: o.size ?? 22, bold: o.bold, italics: o.italics, color: o.color ?? BODY });
}

function heading(text: string): Paragraph {
	// a real Heading 1 (outline level 0) so Word shows collapse/expand controls;
	// direct run + border props override the style to keep the exact look
	return new Paragraph({
		heading: HeadingLevel.HEADING_1,
		outlineLevel: 0, // explicit, so Word reliably shows the collapse/expand control
		spacing: { before: 340, after: 160 },
		border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 4, color: BLUE } },
		children: [run(text, { bold: true, size: 28, color: NAVY })],
	});
}

const bodyPara = (text: string) => new Paragraph({ spacing: { after: 120 }, children: [run(text)] });
const bullet = (text: string) =>
	new Paragraph({ numbering: { reference: BULLETS, level: 0 }, spacing: { after: 80 }, children: [run(text)] });

function taskCell(text: string, width: number, header: boolean): TableCell {
	return new TableCell({
		width: { size: width, type: WidthType.DXA },
		shading: { type: ShadingType.CLEAR, color: "auto", fill: header ? NAVY : WHITE },
		verticalAlign: VerticalAlign.CENTER,
		margins: { top: header ? 100 : 90, bottom: header ? 100 : 90, left: 140, right: 140 },
		children: [new Paragraph({ children: [run(text || (header ? "" : "—"), header ? { bold: true, size: 20, color: WHITE } : { size: 22 })] })],
	});
}

function actionTable(tasks: { owner: string; task: string; deadline: string }[]): Table {
	const W = [2700, 4860, 1800]; // Owner / Task / Deadline, in DXA (sums to 9360 = 6.5")
	const b = { style: BorderStyle.SINGLE, size: 2, color: GRID };
	const borders = { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
	const header = new TableRow({
		tableHeader: true,
		children: [taskCell("Owner", W[0], true), taskCell("Task", W[1], true), taskCell("Deadline", W[2], true)],
	});
	const rows = tasks.map(
		(t) => new TableRow({ children: [taskCell(t.owner, W[0], false), taskCell(t.task, W[1], false), taskCell(t.deadline, W[2], false)] })
	);
	return new Table({ width: { size: 9360, type: WidthType.DXA }, columnWidths: W, layout: TableLayoutType.FIXED, borders, rows: [header, ...rows] });
}

/** The widest a screen may be drawn, in points: the 6.5" text column. A frame
 *  taller than it is wide (a portrait window) is bounded by height instead, so
 *  one screen never takes most of a page. */
const IMG_MAX_W = 468;
const IMG_MAX_H = 320;

/** A screen as a picture, with its stamp and whatever the reader found beneath
 *  it in small italic gray, the way a figure caption reads.
 *
 *  A resolved image is one the caller could read; anything it could not (a frame
 *  deleted from the vault since) degrades to the caption line alone, so the recap
 *  still says a screen was there rather than silently losing it. */
function screenBlocks(img: ExportImage, resolved: ResolvedImage | undefined): Paragraph[] {
	const out: Paragraph[] = [];
	if (resolved) {
		const scale = Math.min(1, IMG_MAX_W / resolved.width, IMG_MAX_H / resolved.height);
		out.push(
			new Paragraph({
				spacing: { before: 120, after: 40 },
				children: [
					new ImageRun({
						type: resolved.type,
						data: resolved.data,
						transformation: { width: Math.round(resolved.width * scale), height: Math.round(resolved.height * scale) },
					}),
				],
			})
		);
	}
	const label = [img.stamp ? `[${img.stamp}]` : "", img.caption].filter(Boolean).join(" ");
	if (label) out.push(new Paragraph({ spacing: { after: 160 }, children: [run(label, { italics: true, size: 18, color: GRAY })] }));
	return out;
}

function sectionBlocks(s: ExportSection, images: Map<string, ResolvedImage>): (Paragraph | Table)[] {
	const out: (Paragraph | Table)[] = [heading(s.heading)];
	if (s.kind === "tasks" && s.tasks.length) {
		out.push(actionTable(s.tasks));
	} else {
		// lead-in prose first, then bullets — nothing is dropped
		out.push(...s.paragraphs.map(bodyPara));
		out.push(...s.bullets.map(bullet));
	}
	// screens last within their section: the words say what happened, the picture
	// shows it, and a figure under the text is how a reader expects to meet one
	for (const img of s.images) out.push(...screenBlocks(img, images.get(img.link)));
	return out;
}

/** A screen the caller managed to read out of the vault. `width`/`height` are the
 *  picture's own pixels, which only the caller can measure.
 *
 *  PNG only, deliberately: screens are saved as webp, which is the right choice
 *  in a vault and the wrong one in a .docx, since Word did not read webp until
 *  recently and the document format's own image types do not include it. The
 *  caller re-encodes, which it can do for free because it had to decode the
 *  picture anyway to learn its size. */
export interface ResolvedImage {
	data: Uint8Array;
	width: number;
	height: number;
	type: "png";
}

/** The whole recap document: title block, then each section.
 *
 *  `images` maps a screen's vault path to its bytes. It is passed in rather than
 *  read here because this module is a pure projection of the export model and has
 *  no idea what a vault is; an absent entry simply renders without its picture. */
export function buildMeetingDoc(model: ExportModel, images: Map<string, ResolvedImage> = new Map()): Document {
	const children: (Paragraph | Table)[] = [
		new Paragraph({ spacing: { after: 40 }, children: [run(model.title, { bold: true, size: 44, color: NAVY })] }),
	];
	if (model.attendees.length) {
		children.push(new Paragraph({ spacing: { after: 60 }, children: [run(model.attendees.join(" · "), { bold: true, size: 24, color: BLUE })] }));
	}
	if (model.dateLine) {
		children.push(new Paragraph({ spacing: { after: 260 }, children: [run(model.dateLine, { italics: true, size: 20, color: GRAY })] }));
	}
	for (const s of model.sections) children.push(...sectionBlocks(s, images));

	return new Document({
		creator: "Power Assistant",
		title: model.title,
		styles: { default: { document: { run: { font: FONT, size: 22, color: BODY } } } },
		numbering: {
			config: [
				{
					reference: BULLETS,
					levels: [
						{
							level: 0,
							format: LevelFormat.BULLET,
							text: "▸",
							alignment: AlignmentType.LEFT,
							style: { paragraph: { indent: { left: 380, hanging: 270 } } },
						},
					],
				},
			],
		},
		sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
	});
}
