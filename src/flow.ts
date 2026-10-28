import type { Rgba } from "./types.ts";

// The note's flowing rich text (flow.xml): paragraphs and tables laid across every page
// inside the margins. Port of the app's TextFlow model and FlowXml reader.

export type ParaAlign = "left" | "center" | "right" | "justify";
export type ListKind = "none" | "bullet" | "ordered" | "check";
export type TableBorders = "all" | "outer" | "horizontal" | "none";

export interface CharStyle {
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strike: boolean;
	code: boolean;
	color: Rgba | null;
	highlight: Rgba | null;
	sizePt: number | null;
	face: string | null;
	link: string | null;
	math: boolean; // the run's text is LaTeX
	mathDisplay: boolean;
}

export interface Run {
	text: string;
	style: CharStyle;
}

export interface Paragraph {
	runs: Run[];
	align: ParaAlign;
	indent: number;
	list: ListKind;
	checked: boolean;
	codeLang: string | null; // non-null marks a code line
	headingLevel: number;
	rule: boolean; // an empty line drawn as a hairline
	breakBefore: boolean; // starts the next page
	breakToPage: number | null; // with breakBefore, the earliest page it starts on
	listStart: number | null; // the number an ordered item restarts its list at
}

export interface TableStyle {
	paddingPt: number;
	lineColor: Rgba | null;
	lineWidthPt: number;
	borders: TableBorders;
	headerRow: boolean;
	banded: boolean;
	tint: Rgba | null;
}

export interface FlowTable {
	widths: number[]; // column fractions summing to 1
	minHeightsPt: number[]; // per row, 0 = as tall as the text
	style: TableStyle;
	width: number; // fraction of the text column
	cells: Paragraph[][][]; // rows of cells of paragraphs, every row full
}

export type FlowBlock = { kind: "para"; para: Paragraph } | { kind: "table"; table: FlowTable };

export interface FlowMargins {
	leftMm: number;
	topMm: number;
	rightMm: number;
	bottomMm: number;
}

export interface TextFlow {
	blocks: FlowBlock[];
	margins: FlowMargins;
	defaultFace: string;
	defaultSizePt: number;
	defaultColor: Rgba | null; // null follows the paper
	monoFace: string;
}

export const DEFAULT_SIZE_PT = 12;
const DEFAULT_MARGIN_MM = 20;
const MAX_INDENT = 6;
const MAX_HEADING = 6;
const INDENT_MM_PER_LEVEL = 10;
const MAX_REPEAT = 64;
const MIN_FRACTION = 0.02;
const MIN_TABLE_WIDTH = 0.1;
// Legacy files wrote this built-in near-white as the default colour; it reads back as auto.
const LEGACY_DEFAULT_COLOR: Rgba = [236, 236, 236, 255];
const HEADING_SCALE = [2.0, 1.75, 1.55, 1.4, 1.25, 1.1];

export const DEFAULT_STYLE: CharStyle = {
	bold: false,
	italic: false,
	underline: false,
	strike: false,
	code: false,
	color: null,
	highlight: null,
	sizePt: null,
	face: null,
	link: null,
	math: false,
	mathDisplay: false,
};

export function headingStyle(level: number, baseSizePt: number): CharStyle {
	const i = Math.min(Math.max(level - 1, 0), HEADING_SCALE.length - 1);
	return { ...DEFAULT_STYLE, bold: true, sizePt: baseSizePt * HEADING_SCALE[i] };
}

export function plainText(para: Paragraph): string {
	return para.runs.map((r) => r.text).join("");
}

export function isEmptyFlow(flow: TextFlow): boolean {
	if (flow.blocks.length === 0) return true;
	if (flow.blocks.length > 1) return false;
	const b = flow.blocks[0];
	if (b.kind !== "para") return false;
	const p = b.para;
	return (
		plainText(p).length === 0 &&
		p.align === "left" &&
		p.indent === 0 &&
		p.list === "none" &&
		!p.checked &&
		p.codeLang === null &&
		p.headingLevel === 0
	);
}

// Every math run in the flow, for typesetting ahead of layout.
export function flowMath(flow: TextFlow): { latex: string; display: boolean }[] {
	const out: { latex: string; display: boolean }[] = [];
	const visit = (p: Paragraph) => {
		for (const r of p.runs) if (r.style.math && r.text) out.push({ latex: r.text, display: r.style.mathDisplay });
	};
	for (const b of flow.blocks) {
		if (b.kind === "para") visit(b.para);
		else for (const row of b.table.cells) for (const cell of row) cell.forEach(visit);
	}
	return out;
}

// ── reading ───────────────────────────────────────────────────────────────

interface Styles {
	chars: Map<string, CharStyle>;
	paras: Map<string, [ParaAlign, number, boolean]>;
	tableWidths: Map<string, number>;
	colWidths: Map<string, number>;
	rowHeights: Map<string, number>;
}

// Parse flow.xml; malformed XML reads as no flow.
export function parseFlowXml(xml: string): TextFlow | null {
	const dom = new DOMParser().parseFromString(xml, "application/xml");
	const root = dom.documentElement;
	if (!root || root.getElementsByTagName("parsererror").length > 0) return null;

	const legacy = parseHex(attr(root, "default-color"));
	const flow: TextFlow = {
		blocks: [],
		margins: {
			leftMm: attrNum(root, "margin-left-mm", DEFAULT_MARGIN_MM),
			topMm: attrNum(root, "margin-top-mm", DEFAULT_MARGIN_MM),
			rightMm: attrNum(root, "margin-right-mm", DEFAULT_MARGIN_MM),
			bottomMm: attrNum(root, "margin-bottom-mm", DEFAULT_MARGIN_MM),
		},
		defaultFace: faceFromId(attr(root, "default-face") ?? "sans"),
		defaultSizePt: attrNum(root, "default-size-pt", DEFAULT_SIZE_PT),
		defaultColor: legacy && !sameRgb(legacy, LEGACY_DEFAULT_COLOR) ? legacy : null,
		monoFace: faceFromId(attr(root, "mono-face") ?? "mono"),
	};

	const styles: Styles = {
		chars: new Map(),
		paras: new Map(),
		tableWidths: new Map(),
		colWidths: new Map(),
		rowHeights: new Map(),
	};
	for (const el of descendants(root, "style")) {
		const name = attr(el, "name");
		if (!name) continue;
		const first = (local: string) => descendants(el, local)[0];
		switch (attr(el, "family")) {
			case "text": {
				const p = first("text-properties");
				if (p) styles.chars.set(name, parseCharStyle(p));
				break;
			}
			case "paragraph": {
				const p = first("paragraph-properties");
				if (p) styles.paras.set(name, parseParaProps(p));
				break;
			}
			case "table": {
				const w = parsePercent(attr(first("table-properties"), "rel-width"));
				if (w != null) styles.tableWidths.set(name, w);
				break;
			}
			case "table-column": {
				const w = Number(attr(first("table-column-properties"), "rel-column-width")?.replace(/\*$/, ""));
				if (Number.isFinite(w)) styles.colWidths.set(name, w);
				break;
			}
			case "table-row": {
				const h = parseLengthPt(attr(first("table-row-properties"), "min-row-height"));
				if (h != null) styles.rowHeights.set(name, h);
				break;
			}
		}
	}

	const body = descendants(root, "body")[0] ?? root;
	readBlocks(body, styles, flow.blocks);
	return flow;
}

function readBlocks(parent: Element, styles: Styles, out: FlowBlock[]): void {
	for (const child of Array.from(parent.children)) {
		switch (child.localName) {
			case "p":
				out.push({ kind: "para", para: parseParagraph(child, styles) });
				readBlocks(child, styles, out);
				break;
			case "table": {
				const table = readTable(child, styles);
				if (table) out.push({ kind: "table", table });
				break;
			}
			default:
				readBlocks(child, styles, out);
		}
	}
}

function readTable(el: Element, styles: Styles): FlowTable | null {
	const widths: number[] = [];
	const rows: Paragraph[][][] = [];
	const heights: number[] = [];
	const repeats = (e: Element, name: string) =>
		Math.min(Math.max(parseInt(attr(e, name) ?? "1", 10) || 1, 1), MAX_REPEAT);
	const collect = (parent: Element) => {
		for (const child of Array.from(parent.children)) {
			switch (child.localName) {
				case "table-column": {
					const w = styles.colWidths.get(attr(child, "style-name") ?? "") ?? 0;
					for (let i = repeats(child, "number-columns-repeated"); i > 0; i--) widths.push(w);
					break;
				}
				case "table-row": {
					const cells: Paragraph[][] = [];
					for (const cell of Array.from(child.children)) {
						if (cell.localName !== "table-cell" && cell.localName !== "covered-table-cell") continue;
						const paras = descendants(cell, "p").map((p) => parseParagraph(p, styles));
						if (paras.length === 0) paras.push(emptyParagraph());
						for (let i = repeats(cell, "number-columns-repeated"); i > 0; i--) cells.push(paras);
					}
					const h = styles.rowHeights.get(attr(child, "style-name") ?? "") ?? 0;
					for (let i = repeats(child, "number-rows-repeated"); i > 0; i--) {
						rows.push(cells);
						heights.push(h);
					}
					break;
				}
				default:
					collect(child);
			}
		}
	};
	collect(el);
	if (rows.length === 0) return null;
	const cols = Math.max(widths.length, ...rows.map((r) => r.length), 1);
	const headerAttr = attr(el, "header");
	const style: TableStyle = {
		paddingPt: clamp(numOr(attr(el, "padding-pt"), 4), 0, 24),
		lineColor: parseHex(attr(el, "line-color")),
		lineWidthPt: clamp(numOr(attr(el, "line-width-pt"), 0.75), 0.25, 6),
		borders: (["all", "outer", "horizontal", "none"] as const).find((b) => b === attr(el, "borders")) ?? "all",
		headerRow: headerAttr != null ? headerAttr === "true" : descendants(el, "table-header-rows").length > 0,
		banded: attr(el, "banded") === "true",
		tint: parseHex(attr(el, "tint")),
	};
	const width = styles.tableWidths.get(attr(el, "style-name") ?? "") ?? 1;
	return {
		widths:
			widths.length === cols && widths.every((w) => w > 0)
				? normalizedWidths(widths)
				: Array.from({ length: cols }, () => 1 / cols),
		minHeightsPt: heights,
		style,
		width: Number.isFinite(width) ? clamp(width, MIN_TABLE_WIDTH, 1) : 1,
		cells: rows.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? [emptyParagraph()])),
	};
}

// Column fractions scaled to sum to 1 with none below the minimum share.
export function normalizedWidths(widths: number[]): number[] {
	if (widths.length === 0) return widths;
	const floor = Math.min(MIN_FRACTION, 1 / widths.length);
	let w = widths.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
	const total = w.reduce((a, b) => a + b, 0);
	w = total <= 0 ? widths.map(() => 1 / widths.length) : w.map((v) => v / total);
	for (let k = 0; k < widths.length; k++) {
		const low = w.map((v) => v < floor);
		if (!low.some(Boolean)) break;
		const spare = 1 - floor * low.filter(Boolean).length;
		const rest = w.filter((_, i) => !low[i]).reduce((a, b) => a + b, 0);
		w = w.map((v, i) => (low[i] ? floor : (v * spare) / rest));
	}
	return w;
}

function emptyParagraph(): Paragraph {
	return {
		runs: [],
		align: "left",
		indent: 0,
		list: "none",
		checked: false,
		codeLang: null,
		headingLevel: 0,
		rule: false,
		breakBefore: false,
		breakToPage: null,
		listStart: null,
	};
}

function parseCharStyle(p: Element): CharStyle {
	const ruled = (v: string | null) => v != null && v !== "none";
	const size = parseFloat(attr(p, "font-size")?.replace(/pt$/, "") ?? "");
	return {
		bold: attr(p, "font-weight") === "bold",
		italic: attr(p, "font-style") === "italic",
		underline: ruled(attr(p, "text-underline-style")),
		strike: ruled(attr(p, "text-line-through-style")),
		code: attr(p, "code") === "true",
		math: attr(p, "math") === "true",
		mathDisplay: attr(p, "math-display") === "true",
		color: parseHex(attr(p, "color")),
		highlight: parseHex(attr(p, "background-color")),
		sizePt: Number.isFinite(size) ? size : null,
		face: attr(p, "font-name") || null,
		link: attr(p, "link") || null,
	};
}

function parseParaProps(p: Element): [ParaAlign, number, boolean] {
	const a = attr(p, "text-align");
	const align: ParaAlign =
		a === "center" ? "center" : a === "right" || a === "end" ? "right" : a === "justify" ? "justify" : "left";
	let indent = parseInt(attr(p, "indent") ?? "", 10);
	if (!Number.isFinite(indent)) {
		const mm = parseFloat(attr(p, "margin-left")?.replace(/mm$/, "") ?? "");
		indent = Number.isFinite(mm) ? Math.trunc(mm / INDENT_MM_PER_LEVEL) : 0;
	}
	return [align, clamp(indent, 0, MAX_INDENT), attr(p, "break-before") === "page"];
}

function parseParagraph(p: Element, styles: Styles): Paragraph {
	const [align, indent, breakBefore] = styles.paras.get(attr(p, "style-name") ?? "") ?? ["left", 0, false];
	const list = (["bullet", "ordered", "check"] as const).find((k) => k === attr(p, "list")) ?? "none";
	const heading = parseInt(attr(p, "heading") ?? "", 10);
	const para: Paragraph = {
		runs: [],
		align,
		indent,
		list,
		checked: attr(p, "checked") === "true",
		codeLang: attr(p, "code-lang"),
		headingLevel: Number.isFinite(heading) ? clamp(heading, 0, MAX_HEADING) : 0,
		rule: attr(p, "rule") === "true",
		breakBefore,
		breakToPage: breakBefore ? nonNegativeInt(attr(p, "break-page")) : null,
		listStart:
			list === "ordered" && p.parentElement?.localName === "list-item" ? nonNegativeInt(attr(p.parentElement, "start-value")) : null,
	};
	collectRuns(p, DEFAULT_STYLE, styles.chars, para.runs);
	return para;
}

function collectRuns(node: Element, style: CharStyle, chars: Map<string, CharStyle>, out: Run[]): void {
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
			appendText(out, child.nodeValue ?? "", style);
		} else if (child instanceof Element) {
			switch (child.localName) {
				case "span": {
					const own = chars.get(attr(child, "style-name") ?? "");
					// A link wraps its spans as text:a; n-notes before 0.9.6 kept it in the span style instead.
					collectRuns(child, own && style.link ? { ...own, link: style.link } : (own ?? style), chars, out);
					break;
				}
				case "a":
					collectRuns(child, { ...style, link: attr(child, "href")?.trim() || null }, chars, out);
					break;
				case "s":
					appendText(out, " ".repeat(parseInt(attr(child, "c") ?? "1", 10) || 1), style);
					break;
				case "tab":
					appendText(out, "\t", style);
					break;
				default:
					collectRuns(child, style, chars, out);
			}
		}
	}
}

function nonNegativeInt(v: string | null): number | null {
	const n = parseInt(v ?? "", 10);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

function appendText(out: Run[], text: string, style: CharStyle): void {
	if (!text) return;
	const last = out[out.length - 1];
	if (last && last.style === style) last.text += text;
	else out.push({ text, style });
}

// ── forgiving DOM helpers (match by local name, any namespace) ───────────────

function descendants(parent: Element, local: string): Element[] {
	return Array.from(parent.getElementsByTagName("*")).filter((e) => e.localName === local);
}

function attr(el: Element | undefined, local: string): string | null {
	if (!el) return null;
	for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
	return null;
}

function attrNum(el: Element, local: string, fallback: number): number {
	return numOr(attr(el, local), fallback);
}

function numOr(s: string | null, fallback: number): number {
	const v = s == null ? NaN : Number(s);
	return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(Math.max(v, lo), hi);
}

function faceFromId(id: string): string {
	return id || "mono";
}

function sameRgb(a: Rgba, b: Rgba): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function parseHex(s: string | null): Rgba | null {
	if (!s || !/^#[0-9a-fA-F]{6}$/.test(s)) return null;
	const v = parseInt(s.slice(1), 16);
	return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, 255];
}

function parsePercent(s: string | null): number | null {
	const v = parseFloat(s?.trim().replace(/%$/, "") ?? "");
	return Number.isFinite(v) ? v / 100 : null;
}

function parseLengthPt(s: string | null): number | null {
	const m = s?.match(/^(-?[\d.]+)([a-z]*)$/);
	if (!m) return null;
	const v = parseFloat(m[1]);
	switch (m[2]) {
		case "pt":
		case "":
			return v;
		case "mm":
			return (v * 72) / 25.4;
		case "cm":
			return (v * 72) / 2.54;
		case "in":
			return v * 72;
		case "px":
			return v * 0.75;
		default:
			return null;
	}
}
