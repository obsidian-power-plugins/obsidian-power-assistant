/** gifenc ships no types. Declared only as far as the GIF export uses it: a
 *  writer, a palette builder, and the step that maps pixels onto a palette. */
declare module "gifenc" {
	export type Palette = number[][];

	export interface GifWriter {
		writeFrame(
			index: Uint8Array,
			width: number,
			height: number,
			opts?: { palette?: Palette; delay?: number; transparent?: boolean; repeat?: number }
		): void;
		finish(): void;
		bytes(): Uint8Array;
	}

	export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifWriter;

	/** A palette of at most `maxColors` for the RGBA pixels given. */
	export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: string; oneBitAlpha?: boolean; clearAlpha?: boolean }): Palette;

	/** The pixels as indexes into `palette`. */
	export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: string): Uint8Array;
}
