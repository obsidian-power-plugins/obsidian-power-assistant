// esbuild bundles these as text (see esbuild.config.mjs); tsc needs to agree.
declare module "*.py" {
	const text: string;
	export default text;
}
declare module "*.ps1" {
	const text: string;
	export default text;
}
declare module "*.sh" {
	const text: string;
	export default text;
}
declare module "*.txt" {
	const text: string;
	export default text;
}
