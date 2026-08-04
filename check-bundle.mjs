// Refuse to ship a bundle that a stale JavaScript engine cannot even parse.
//
// Lookbehind is a *parse*-time syntax error on Safari below 16.4, which means
// one regex literal anywhere in main.js stops the whole plugin from loading on
// older iOS. Not the feature that uses it: all of it.
//
// This exists because that shipped. The source was clean and the directory
// linter was happy, but the linter only reads src/, and Obsidian loads the
// bundle. @anthropic-ai/sdk contributed a lookbehind literal of its own, so a
// plugin whose own code had none still could not start.
//
// esbuild.config.mjs now declares the feature unavailable, which makes esbuild
// emit new RegExp("...") instead. A string is parsed lazily, so an old engine
// only trips if that code path actually runs. This check proves the setting is
// still doing its job: re-transforming the finished bundle with the same
// setting must find nothing left to convert. If someone drops the setting, or
// a future dependency slips a literal through some path esbuild does not
// cover, the delta goes positive and the build stops here.
//
// Run by esbuild.config.mjs after a production build; also fine on its own.
import esbuild from "esbuild";
import { readFileSync } from "fs";
import process from "process";

const bundle = readFileSync("main.js", "utf8");
const ctors = (s) => (s.match(/new RegExp\(/g) ?? []).length;

const rebuilt = await esbuild.transform(bundle, {
	loader: "js",
	format: "cjs",
	target: "es2020",
	supported: { "regexp-lookbehind-assertions": false },
});

const converted = ctors(rebuilt.code) - ctors(bundle);

if (converted > 0) {
	console.error(
		`\n  main.js still contains ${converted} lookbehind regex ` +
			`literal${converted === 1 ? "" : "s"}.\n` +
			"  The plugin will not load at all on Safari below 16.4.\n" +
			'  Check that esbuild.config.mjs still sets supported: { "regexp-lookbehind-assertions": false }.\n',
	);
	process.exit(1);
}

// The directory rejects a bundle that creates <script> elements at runtime,
// and it counts them in main.js rather than in src/. Our own code has never
// had one; the four that failed the first submission came from the setImmediate
// polyfills buried in docx's pre-browserified dist. esbuild.config.mjs rewrites
// them at load time, and this proves the rewrite still reaches every one of
// them: a docx upgrade that reshapes that code shows up here as a build
// failure, not as a rejected submission.
const injections = (bundle.match(/\.createElement\(\s*["'`]script["'`]\s*\)/g) ?? []).length;

if (injections > 0) {
	console.error(
		`\n  main.js creates ${injections} <script> element${injections === 1 ? "" : "s"} dynamically.\n` +
			"  The community directory rejects the submission over this.\n" +
			"  The stripUnsafeVendorPatterns plugin in esbuild.config.mjs no longer matches;\n" +
			"  check whether a dependency changed shape.\n",
	);
	process.exit(1);
}
console.log("  bundle check: no dynamic script creation");

// Same idea for compiling a string into a function. The directory reports it as
// dynamic code execution, which it lists under "prevents full static analysis":
// worth keeping at zero so the scan has nothing to say about us, even though
// the only source of it was a polyfill nothing calls with a string.
const compiles = (bundle.match(/new Function\s*\(/g) ?? []).length + (bundle.match(/(?<![\w.$])eval\s*\(/g) ?? []).length;

if (compiles > 0) {
	console.error(
		`\n  main.js has ${compiles} dynamic code execution site${compiles === 1 ? "" : "s"} (eval / new Function).\n` +
			"  The directory reports these, and they block full static analysis of the plugin.\n" +
			"  Check which dependency introduced one, and whether it can be rewritten the way\n" +
			"  the setimmediate shim is in esbuild.config.mjs.\n",
	);
	process.exit(1);
}
console.log("  bundle check: no dynamic code execution");

// Lookbehind inside a string reaches RegExp at runtime, so it throws only when
// that code path runs. Worth seeing, not worth blocking on: some of these are
// feature-detected by the library that owns them.
const strings = (bundle.match(/\(\?<[=!]/g) ?? []).length;
if (strings > 0) {
	console.log(`  bundle check: no lookbehind literals; ${strings} in strings (runtime only)`);
} else {
	console.log("  bundle check: no lookbehind");
}
