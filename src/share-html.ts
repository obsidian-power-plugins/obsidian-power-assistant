import { marked } from "marked";

/* Markdown to email-ready HTML.
 *
 * Kept apart from pipeline.ts so the Markdown parser is imported in one place,
 * and away from main.ts so it stays testable in the Node harness: no document,
 * no Obsidian, just a string in and a string out.
 *
 * Obsidian's own MarkdownRenderer was the obvious alternative and is the wrong
 * tool here. It runs every registered post-processor, so a note rendered while
 * the rest of the Power family is installed comes back carrying their toolbars,
 * their embeds, and their class names, none of which mean anything in a mail
 * client, and all of which would have to be stripped back out again. */

/** Styles live inline on the elements themselves. Mail clients disagree about
 *  everything, but the one thing they agree on is honoring a style attribute;
 *  a <style> block is stripped outright by several of them, Outlook included. */
const STYLES: Record<string, string> = {
	h1: "font-size:22px;line-height:1.3;margin:24px 0 8px;font-weight:600",
	h2: "font-size:18px;line-height:1.3;margin:22px 0 8px;font-weight:600",
	h3: "font-size:16px;line-height:1.3;margin:18px 0 6px;font-weight:600",
	h4: "font-size:15px;margin:16px 0 6px;font-weight:600",
	p: "margin:0 0 12px",
	ul: "margin:0 0 12px;padding-left:22px",
	ol: "margin:0 0 12px;padding-left:22px",
	li: "margin:0 0 4px",
	blockquote: "margin:0 0 12px;padding:2px 0 2px 14px;border-left:3px solid #d0d0d8;color:#555",
	pre: "margin:0 0 12px;padding:10px;background:#f5f5f7;border-radius:6px;overflow-x:auto;font-size:13px",
	code: "font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px",
	table: "border-collapse:collapse;margin:0 0 12px;width:100%",
	th: "border:1px solid #ddd;padding:6px 10px;background:#f5f5f7;text-align:left;font-weight:600",
	td: "border:1px solid #ddd;padding:6px 10px",
	hr: "border:0;border-top:1px solid #e0e0e6;margin:20px 0",
	a: "color:#4b3fd6",
};

/** Put the style attributes on, without touching a tag that already carries one
 *  or a <code> nested inside a <pre> (which is already styled by its parent). */
function inlineStyles(html: string): string {
	return html.replace(/<(h1|h2|h3|h4|p|ul|ol|li|blockquote|pre|code|table|th|td|hr|a)(\s[^>]*)?>/g, (m: string, tag: string, attrs: string | undefined = "") => {
		if (/\sstyle=/i.test(attrs)) return m;
		return `<${tag}${attrs} style="${STYLES[tag]}">`;
	});
}

/** Escape for HTML text, for the parts built by hand rather than by Markdown. */
export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A shared page as an email body: an optional note from the sender, the page
 *  itself, and a line saying where it came from.
 *
 *  `intro` is the sender's own words, so it is treated as Markdown like the rest
 *  and set apart from the page under the heading. */
export function shareEmailHtml(o: { title: string; markdown: string; intro?: string; source?: string }): string {
	const body = inlineStyles(marked.parse(o.markdown, { async: false, gfm: true, breaks: false }));
	const intro = o.intro?.trim() ? inlineStyles(marked.parse(o.intro, { async: false, gfm: true, breaks: true })) : "";
	const source = o.source?.trim()
		? `<p style="${STYLES.p};font-size:12px;color:#777">Source: <a href="${escapeHtml(o.source)}" style="${STYLES.a}">${escapeHtml(o.source)}</a></p>`
		: "";
	return [
		`<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:680px">`,
		`<h1 style="${STYLES.h1};margin-top:0">${escapeHtml(o.title)}</h1>`,
		intro,
		intro ? `<hr style="${STYLES.hr}">` : "",
		body,
		source ? `<hr style="${STYLES.hr}">` : "",
		source,
		`</div>`,
	]
		.filter(Boolean)
		.join("\n");
}
