import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

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
	supported: { "regexp-lookbehind-assertions": false },
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
