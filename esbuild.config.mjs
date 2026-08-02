import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "node:*"],
	format: "cjs",
	target: "es2020",
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
	process.exit(0);
} else {
	await ctx.watch();
}
