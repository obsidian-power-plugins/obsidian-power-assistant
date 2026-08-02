#!/usr/bin/env node
// Power Assistant MCP server: exposes an Obsidian vault to Claude Desktop and
// Claude Code over stdio. It reads the vault's markdown directly (the source of
// truth), so it works whether or not Obsidian is running. Read-only.
//
//   power-assistant-mcp <vault-path>      (or set POWER_ASSISTANT_VAULT)
//
// Tools: search_notes, read_note, list_recent_notes, finances_summary.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const VAULT = resolve(process.argv[2] || process.env.POWER_ASSISTANT_VAULT || "");
if (!VAULT || !safeIsDir(VAULT)) {
	console.error("Power Assistant MCP: pass the vault path as an argument or set POWER_ASSISTANT_VAULT to a folder.");
	process.exit(1);
}

function safeIsDir(p) {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/* ---------------- a small, self-refreshing note index ---------------- */

const SKIP_DIRS = new Set([".obsidian", ".trash", ".git", "node_modules"]);
/** path -> { mtime, title, text } */
const cache = new Map();

/** Walk the vault for markdown files, re-reading only what changed since the
 *  last call so a long-lived server stays current without rescanning content. */
function refresh() {
	const seen = new Set();
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith(".") && e.isDirectory()) continue;
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
				continue;
			}
			if (!e.name.toLowerCase().endsWith(".md")) continue;
			const abs = join(dir, e.name);
			const rel = abs.slice(VAULT.length + 1).split(sep).join("/");
			seen.add(rel);
			let st;
			try {
				st = statSync(abs);
			} catch {
				continue;
			}
			const hit = cache.get(rel);
			if (hit && hit.mtime === st.mtimeMs) continue;
			try {
				const text = readFileSync(abs, "utf8");
				cache.set(rel, { mtime: st.mtimeMs, title: e.name.replace(/\.md$/i, ""), text });
			} catch {
				/* unreadable; skip */
			}
		}
	};
	walk(VAULT);
	for (const rel of [...cache.keys()]) if (!seen.has(rel)) cache.delete(rel);
}

const tokenize = (s) =>
	(s.toLowerCase().match(/[a-z0-9]{2,}/g) || []).filter((t, i, a) => a.indexOf(t) === i);

/** Frontmatter as a flat key->string map (simple scalar lines only). */
function frontmatter(text) {
	const m = text.match(/^---\n([\s\S]*?)\n---/);
	const out = {};
	if (!m) return out;
	for (const line of m[1].split("\n")) {
		const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (km) out[km[1]] = km[2].replace(/^["']|["']$/g, "").trim();
	}
	return out;
}

const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n?/, "");

/** A readable excerpt around the first query term, else the opening. */
function excerpt(text, terms, len = 320) {
	const b = body(text);
	const low = b.toLowerCase();
	let at = -1;
	for (const t of terms) {
		const i = low.indexOf(t);
		if (i >= 0 && (at < 0 || i < at)) at = i;
	}
	const start = at < 0 ? 0 : Math.max(0, at - 80);
	return (start > 0 ? "…" : "") + b.slice(start, start + len).replace(/\s+/g, " ").trim() + "…";
}

function search(query, limit) {
	const terms = tokenize(query);
	if (!terms.length) return [];
	const scored = [];
	for (const [path, doc] of cache) {
		const titleL = doc.title.toLowerCase();
		const textL = doc.text.toLowerCase();
		let score = 0;
		for (const t of terms) {
			if (titleL.includes(t)) score += 5;
			let idx = textL.indexOf(t),
				c = 0;
			while (idx >= 0 && c < 20) {
				score += 1;
				c++;
				idx = textL.indexOf(t, idx + t.length);
			}
		}
		if (score > 0) scored.push({ path, title: doc.title, score, excerpt: excerpt(doc.text, terms) });
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/* ---------------- MCP server ---------------- */

const TOOLS = [
	{
		name: "search_notes",
		description: "Search the Obsidian vault's notes by keyword. Returns the best-matching notes with their path and a short excerpt; follow up with read_note for full content.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string", description: "What to search for" }, limit: { type: "number", description: "Max results (default 8)" } },
			required: ["query"],
		},
	},
	{
		name: "read_note",
		description: "Read the full Markdown of one note by its vault-relative path (as returned by search_notes).",
		inputSchema: { type: "object", properties: { path: { type: "string", description: "Vault-relative note path, e.g. Meetings/2026-07-14 Sync.md" } }, required: ["path"] },
	},
	{
		name: "list_recent_notes",
		description: "List the most recently modified notes in the vault.",
		inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max results (default 15)" } } },
	},
	{
		name: "finances_summary",
		description: "Summarize processed financial documents (bills, receipts, invoices): totals per currency and upcoming or overdue bills.",
		inputSchema: { type: "object", properties: {} },
	},
];

const text = (t) => ({ content: [{ type: "text", text: t }] });

function callTool(name, args) {
	refresh();
	if (name === "search_notes") {
		const hits = search(String(args?.query ?? ""), Math.max(1, Math.min(25, args?.limit ?? 8)));
		if (!hits.length) return text("No matching notes.");
		return text(hits.map((h) => `## ${h.title}\npath: ${h.path}\n${h.excerpt}`).join("\n\n"));
	}
	if (name === "read_note") {
		const rel = String(args?.path ?? "").replace(/\\/g, "/");
		const abs = resolve(VAULT, rel);
		if (!abs.startsWith(VAULT + sep)) return text("Path is outside the vault.");
		try {
			return text(readFileSync(abs, "utf8"));
		} catch {
			return text(`Could not read ${rel}. Use search_notes to find the correct path.`);
		}
	}
	if (name === "list_recent_notes") {
		const limit = Math.max(1, Math.min(50, args?.limit ?? 15));
		const rows = [...cache.entries()].sort((a, b) => b[1].mtime - a[1].mtime).slice(0, limit);
		return text(rows.map(([path, d]) => `- ${d.title} — ${path}`).join("\n") || "No notes.");
	}
	if (name === "finances_summary") {
		const byCur = new Map();
		const bills = [];
		const today = new Date().toISOString().slice(0, 10);
		for (const [path, d] of cache) {
			const fm = frontmatter(d.text);
			if (fm.type !== "capture-doc") continue;
			const amount = parseFloat(String(fm.amount ?? "")) || 0;
			const cur = fm.currency || "";
			if (amount > 0) {
				const c = byCur.get(cur) ?? { total: 0, n: 0 };
				c.total += amount;
				c.n++;
				byCur.set(cur, c);
			}
			if (/^\d{4}-\d{2}-\d{2}$/.test(fm.due || "")) bills.push({ due: fm.due, vendor: fm.vendor || d.title, amount, cur, path });
		}
		if (!byCur.size && !bills.length) return text("No processed financial documents found.");
		const totals = [...byCur.entries()].map(([cur, c]) => `- ${cur || "Unknown"}: ${c.total.toLocaleString()} across ${c.n} document(s)`).join("\n");
		const due = bills
			.sort((a, b) => (a.due < b.due ? -1 : 1))
			.map((b) => `- ${b.due < today ? "OVERDUE " : ""}${b.due} · ${b.vendor} · ${b.cur} ${b.amount.toLocaleString()} (${b.path})`)
			.join("\n");
		return text(`# Finances\n\n## Totals\n${totals || "(none)"}\n\n## Bills with a due date\n${due || "(none)"}`);
	}
	return text(`Unknown tool: ${name}`);
}

const server = new Server({ name: "power-assistant", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
	try {
		return callTool(req.params.name, req.params.arguments ?? {});
	} catch (e) {
		return { content: [{ type: "text", text: "Error: " + (e?.message ?? String(e)) }], isError: true };
	}
});

refresh();
await server.connect(new StdioServerTransport());
console.error(`Power Assistant MCP: serving ${cache.size} notes from ${VAULT}`);
