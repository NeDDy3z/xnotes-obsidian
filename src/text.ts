import type { Rgba } from "./types.ts";

export const PT_TO_PX = 150 / 72; // xnotes authors text at a fixed 150 DPI

export interface FontSpec {
	sizePt: number;
	face: string;
	bold: boolean;
	italic: boolean;
}

export interface LineMetrics {
	ascent: number;
	descent: number;
}

export function rgbaCss(c: Rgba | null | undefined, fallback = "#000"): string {
	if (!c) return fallback;
	const a = (c[3] ?? 255) / 255;
	return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
}

// The generic faces map to system stacks; any other id is a named family the app
// bundles or imports, used when installed here and otherwise its closest generic.
export function fontFamily(face?: string): string {
	switch (face) {
		case "sans":
			return "ui-sans-serif, system-ui, sans-serif";
		case "serif":
			return "ui-serif, Georgia, serif";
		case "hand":
			return "'Segoe Script', 'Comic Sans MS', cursive";
		case undefined:
		case "":
		case "mono":
			return "ui-monospace, monospace";
		default: {
			const generic = /mono|code/i.test(face) ? "ui-monospace, monospace" : "ui-sans-serif, system-ui, sans-serif";
			return `"${face.replace(/"/g, "")}", ${generic}`;
		}
	}
}

export function cssFont(f: FontSpec): string {
	return `${f.italic ? "italic" : "normal"} ${f.bold ? "700" : "400"} ${f.sizePt * PT_TO_PX}px ${fontFamily(f.face)}`;
}

// Font metrics and per-character advances in page px, from an offscreen canvas.
export class TextMeasurer {
	private readonly ctx: OffscreenCanvasRenderingContext2D | null = new OffscreenCanvas(1, 1).getContext("2d");
	private readonly lineCache = new Map<string, LineMetrics>();
	private readonly charCache = new Map<string, Map<string, number>>();

	metrics(f: FontSpec): LineMetrics {
		const font = cssFont(f);
		let m = this.lineCache.get(font);
		if (!m) {
			const px = f.sizePt * PT_TO_PX;
			m = { ascent: px * 0.93, descent: px * 0.24 };
			if (this.ctx) {
				this.ctx.font = font;
				const t = this.ctx.measureText("Mg");
				if (t.fontBoundingBoxAscent > 0) m = { ascent: t.fontBoundingBoxAscent, descent: t.fontBoundingBoxDescent };
			}
			this.lineCache.set(font, m);
		}
		return m;
	}

	// One advance per UTF-16 unit; a surrogate pair carries its width on the first unit.
	advances(text: string, f: FontSpec): number[] {
		const font = cssFont(f);
		let widths = this.charCache.get(font);
		if (!widths) {
			widths = new Map();
			this.charCache.set(font, widths);
		}
		const out = new Array<number>(text.length).fill(0);
		if (this.ctx) this.ctx.font = font;
		for (let i = 0; i < text.length; ) {
			const ch = String.fromCodePoint(text.codePointAt(i) ?? 32);
			let w = widths.get(ch);
			if (w === undefined) {
				w = this.ctx ? this.ctx.measureText(ch).width : f.sizePt * PT_TO_PX * 0.55;
				widths.set(ch, w);
			}
			out[i] = w;
			i += ch.length;
		}
		return out;
	}
}
