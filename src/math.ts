import { finishRenderMath, loadMathJax, renderMath } from "obsidian";
import type { Rgba } from "./types.ts";

// The room one formula needs, in page px, straddling the text baseline.
export interface MathBox {
	width: number;
	ascent: number;
	descent: number;
}

// A formula to mount over the page canvas: left edge at x, sitting on baseline.
export interface MathPlacement {
	latex: string;
	display: boolean;
	x: number;
	baseline: number;
	sizePx: number;
	color: Rgba;
}

// Geometry per 1px of font size, measured once off-screen. dx and base place the
// wrapper so its formula lands with its left edge and baseline where asked.
interface Metrics extends MathBox {
	dx: number;
	base: number;
}

const MEASURE_PX = 100;

// Display form is asked for in LaTeX's own terms, as the app does, so the formula
// stays inline (no block margins) and the measurement matches what is mounted.
function source(latex: string, display: boolean): string {
	return display ? `\\displaystyle ${latex}` : latex;
}

function key(latex: string, display: boolean): string {
	return `${display ? "D" : "I"}${latex}`;
}

// Typesets LaTeX through Obsidian's MathJax. Layout needs sizes synchronously, so
// every formula is measured up front by prepare(); until then nothing is ready and
// maths shows as its source.
export class MathSetter {
	private metrics = new Map<string, Metrics | null>();
	private loaded = false;

	ready(): boolean {
		return this.loaded;
	}

	async prepare(formulas: { latex: string; display: boolean }[], doc: Document): Promise<void> {
		const todo = formulas.filter((f) => f.latex.trim() && !this.metrics.has(key(f.latex, f.display)));
		if (!this.loaded) {
			try {
				await loadMathJax();
				this.loaded = true;
			} catch {
				return;
			}
		}
		if (todo.length === 0) return;
		const host = doc.body.createDiv({ cls: "xnote-math-measure" });
		host.setCssStyles({ fontSize: `${MEASURE_PX}px` });
		const probes: [string, HTMLElement, HTMLElement, HTMLElement][] = [];
		for (const f of todo) {
			const k = key(f.latex, f.display);
			if (probes.some((p) => p[0] === k)) continue;
			const wrap = host.createDiv({ cls: "xnote-math" });
			const strut = wrap.createSpan({ cls: "xnote-math-strut" });
			let el: HTMLElement;
			try {
				el = renderMath(source(f.latex, f.display), false);
			} catch {
				this.metrics.set(k, null);
				wrap.remove();
				continue;
			}
			wrap.appendChild(el);
			probes.push([k, wrap, strut, el]);
		}
		await finishRenderMath();
		for (const [k, wrap, strut, el] of probes) {
			// MathJax renders LaTeX it cannot parse as a red error box: treat that as refused.
			if (el.querySelector("mjx-merror")) {
				this.metrics.set(k, null);
				continue;
			}
			const box = (el.querySelector("mjx-math") ?? el).getBoundingClientRect();
			const w = wrap.getBoundingClientRect();
			const baseline = strut.getBoundingClientRect().bottom;
			this.metrics.set(k, {
				width: box.width / MEASURE_PX,
				ascent: (baseline - box.top) / MEASURE_PX,
				descent: (box.bottom - baseline) / MEASURE_PX,
				dx: (box.left - w.left) / MEASURE_PX,
				base: (baseline - w.top) / MEASURE_PX,
			});
		}
		host.remove();
	}

	// The formula's size at sizePx, or null when it is not measured or will not set.
	measure(latex: string, sizePx: number, display: boolean): MathBox | null {
		const m = this.metrics.get(key(latex, display));
		if (!m) return null;
		return { width: m.width * sizePx, ascent: m.ascent * sizePx, descent: m.descent * sizePx };
	}

	mount(layer: HTMLElement, p: MathPlacement): void {
		const m = this.metrics.get(key(p.latex, p.display));
		if (!m) return;
		const wrap = layer.createDiv({ cls: "xnote-math" });
		wrap.createSpan({ cls: "xnote-math-strut" });
		wrap.appendChild(renderMath(source(p.latex, p.display), false));
		wrap.setCssStyles({
			left: `${p.x - m.dx * p.sizePx}px`,
			top: `${p.baseline - m.base * p.sizePx}px`,
			fontSize: `${p.sizePx}px`,
			color: `rgba(${p.color[0]}, ${p.color[1]}, ${p.color[2]}, ${(p.color[3] ?? 255) / 255})`,
		});
	}
}
