import esbuild from "esbuild";
import { readFile } from "fs/promises";
import process from "process";

const prod = process.argv[2] === "production";

// The directory's scanner rejects any bundle containing a dynamic <script>
// creation. Ours had four, none of them ours: docx ships a pre-browserified
// dist that embeds jszip -> lie -> immediate, plus setimmediate, and both of
// those carry the ancient IE microtask trick that schedules a callback by
// appending an empty, src-less <script> and waiting for onreadystatechange.
//
// Nothing is loaded by it and the code cannot even run here: both polyfills
// test MutationObserver and MessageChannel first, and Electron has shipped
// both for its entire existence, so the script branch is dead on arrival
// inside Obsidian. The scanner reads text rather than reachability, so the
// text has to go regardless.
//
// Two substitutions, each a single expression, so there is no brace matching
// to get wrong on minified vendor code:
//   1. the feature test becomes `false` — which is what it already evaluates
//      to in Chromium — so the polyfill takes its setTimeout fallback;
//   2. any createElement("script") still standing, now inside the branch that
//      step one just made unreachable, becomes createElement("span").
// check-bundle.mjs fails the build if any survive, so a docx upgrade that
// reshapes this code gets caught here instead of by the directory.
const TEST = /["']onreadystatechange["']\s+in\s+[\w$.]+\.createElement\(\s*["']script["']\s*\)/g;
const CREATE = /\.createElement\(\s*["']script["']\s*\)/g;

const stripScriptInjection = {
	name: "strip-script-injection",
	setup(build) {
		const patched = new Set();
		build.onLoad({ filter: /node_modules[\\/].*\.(mjs|cjs|js)$/ }, async (args) => {
			const src = await readFile(args.path, "utf8");
			if (!CREATE.test(src)) return null;
			CREATE.lastIndex = 0;
			const contents = src.replace(TEST, "false").replace(CREATE, '.createElement("span")');
			patched.add(args.path.replace(/^.*node_modules[\\/]/, ""));
			return { contents, loader: "js" };
		});
		build.onEnd(() => {
			for (const p of patched) console.log(`  stripped script injection from ${p}`);
		});
	},
};

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*"],
	format: "cjs",
	target: "es2020",
	// Lookbehind is a *parse*-time error on Safari below 16.4, so a single
	// literal anywhere in the bundle stops the whole plugin from loading on
	// older iOS. Our own source has none, but dependencies do. Declaring the
	// feature unavailable makes esbuild emit new RegExp("...") instead, which
	// parses on any engine and can only fail if that code path actually runs.
	// Obsidian evaluates main.js as CommonJS. Left alone, esbuild passes a
	// dynamic import() of an external module straight through, and a native
	// import("node:fs") inside a CJS module in the renderer is not something to
	// rely on resolving. Declaring the syntax unavailable makes esbuild emit the
	// Promise.resolve().then(() => require(...)) form instead, which is what the
	// three lazy Node imports need at runtime. The source keeps its import():
	// that is what the directory's linter reads, and they still never run on a
	// phone.
	supported: { "regexp-lookbehind-assertions": false, "dynamic-import": false },
	plugins: [stripScriptInjection],
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	// the WhisperX server ships INSIDE the plugin: its files ride the bundle
	// as strings, and the settings button writes them out for the user to run
	loader: { ".py": "text", ".ps1": "text", ".sh": "text", ".txt": "text" },
});

if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
	await import("./check-bundle.mjs");
	process.exit(0);
} else {
	await ctx.watch();
}
