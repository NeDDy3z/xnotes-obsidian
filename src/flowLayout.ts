import {
	DEFAULT_STYLE,
	headingStyle,
	normalizedWidths,
	plainText,
	type CharStyle,
	type FlowTable,
	type ListKind,
	type Paragraph,
	type TableBorders,
	type TextFlow,
} from "./flow.ts";
import type { MathPlacement, MathSetter } from "./math.ts";
import { cssFont, PT_TO_PX, rgbaCss, type FontSpec, type LineMetrics, type TextMeasurer } from "./text.ts";
import type { Rgba } from "./types.ts";

// Port of the app's FlowLayout and FlowPainter: greedy word wrap per paragraph,
// paginated into each page's content rect, then painted under the page's ink.

const INDENT_STEP_PX = 48;
const MARKER_GUTTER_PX = 40;
const MARKER_GAP = 10;
const MIN_LINE_WIDTH = 20;
const MIN_CONTENT_HEIGHT = 16;
const HEADER_ALPHA = 64;
const BAND_ALPHA = 26;
const EPS = 0.01;
const CODE_PAD = 6;
const CHIP_PAD = 3;
const DEFAULT_TINT: Rgba = [90, 140, 255, 255];
const CODE_BG: Rgba = [128, 128, 128, 42];
const CHIP_BG: Rgba = [128, 128, 128, 56];
const LINK_COLOR: Rgba = [90, 156, 255, 255];
const MATH_BG: Rgba = [88, 140, 216, 44];
const MATH_ERROR_BG: Rgba = [214, 74, 68, 52];
const MATH_ERROR_RULE: Rgba = [214, 74, 68, 190];

type MathShow = "formula" | "source" | "error";

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

interface Seg {
	text: string;
	x: number;
	font: FontSpec;
	style: CharStyle;
	math: boolean;
}

interface Deco {
	x0: number;
	x1: number;
	style: CharStyle;
	math: MathShow | null; // a formula showing its source, chipped so it never reads as prose
}

interface Marker {
	kind: ListKind;
	checked: boolean;
	rect: Box;
	text: string | null;
	textX: number;
	font: FontSpec;
}

interface PlacedLine {
	top: number;
	baseline: number;
	bottom: number;
	segs: Seg[];
	decos: Deco[];
	marker: Marker | null;
	codeLine: boolean;
	codeLeft: number;
	codeRight: number;
}

interface RowFrag {
	row: number;
	top: number;
	bottom: number;
}

interface TableFrag {
	colXs: number[];
	rows: RowFrag[];
	lineColor: Rgba | null; // null takes the paper's rule grey
	lineWidth: number;
	borders: TableBorders;
	headerFill: Rgba | null;
	bandFill: Rgba | null;
}

export interface PageFlow {
	lines: PlacedLine[];
	tables: TableFrag[];
}

interface ParaShape {
	text: string;
	adv: number[];
	runEnds: number[];
	runMetrics: LineMetrics[];
	runFonts: FontSpec[];
	emptyMetrics: LineMetrics;
	atom: boolean[]; // characters continuing a drawn formula: never a break
	mathShow: (MathShow | null)[];
}

interface BrokenLine {
	startChar: number;
	endChar: number;
	width: number;
	ascent: number;
	descent: number;
	spaceCount: number;
	hardBroken: boolean;
}

const height = (bl: BrokenLine) => bl.ascent + bl.descent;

// Code and maths resolve to the mono face: a formula only shows its font when its LaTeX does.
function resolveFont(flow: TextFlow, para: Paragraph, style: CharStyle): FontSpec {
	return {
		sizePt: style.sizePt ?? flow.defaultSizePt,
		face: para.codeLang !== null || style.code || style.math ? flow.monoFace : (style.face ?? flow.defaultFace),
		bold: style.bold,
		italic: style.italic,
	};
}

export function layoutFlow(
	flow: TextFlow,
	pages: { width: number; height: number }[],
	dpi: number,
	measurer: TextMeasurer,
	math: MathSetter,
): PageFlow[] {
	return new FlowLayout(flow, measurer, math).layout(pages, dpi);
}

class FlowLayout {
	private readonly shapes = new Map<Paragraph, [ParaShape | null, ParaShape | null]>();

	constructor(
		private readonly flow: TextFlow,
		private readonly measurer: TextMeasurer,
		private readonly math: MathSetter,
	) {}

	// `bold` forces bold on every run (a table's header row).
	private shapeOf(para: Paragraph, bold = false): ParaShape {
		const cached = this.shapes.get(para) ?? [null, null];
		const hit = cached[bold ? 1 : 0];
		if (hit) return hit;
		const flow = this.flow;
		const text = plainText(para);
		const adv = new Array<number>(text.length).fill(0);
		const atom = new Array<boolean>(text.length).fill(false);
		const mathShow: (MathShow | null)[] = [];
		const runEnds: number[] = [];
		const runMetrics: LineMetrics[] = [];
		const runFonts: FontSpec[] = [];
		let offset = 0;
		for (const run of para.runs) {
			const font = resolveFont(flow, para, bold ? { ...run.style, bold: true } : run.style);
			// A formula is one box on the line: its whole advance rides on the first character.
			let box = null;
			let show: MathShow | null = null;
			if (run.style.math) {
				if (!this.math.ready() || !run.text) show = "source";
				else {
					box = this.math.measure(run.text, font.sizePt * PT_TO_PX, run.style.mathDisplay);
					show = box ? "formula" : "error";
				}
			}
			mathShow.push(show);
			if (box) {
				adv[offset] = box.width;
				for (let k = offset + 1; k < offset + run.text.length; k++) atom[k] = true;
				// A formula asks for at least the room the same text would in the prose face.
				const prose = resolveFont(flow, para, { ...run.style, bold: bold || run.style.bold, math: false, code: false });
				const asText = this.measurer.metrics(prose);
				runMetrics.push({
					ascent: Math.max(box.ascent, asText.ascent),
					descent: Math.max(box.descent, asText.descent),
				});
			} else {
				const a = this.measurer.advances(run.text, font);
				for (let k = 0; k < a.length; k++) adv[offset + k] = a[k];
				runMetrics.push(this.measurer.metrics(font));
			}
			offset += run.text.length;
			runEnds.push(offset);
			runFonts.push(font);
		}
		// An empty heading still stands as tall as the text it is waiting for.
		const emptyStyle = para.headingLevel > 0 ? headingStyle(para.headingLevel, flow.defaultSizePt) : DEFAULT_STYLE;
		const emptyFont = resolveFont(flow, para, bold ? { ...emptyStyle, bold: true } : emptyStyle);
		const shape: ParaShape = {
			text,
			adv,
			runEnds,
			runMetrics,
			runFonts,
			emptyMetrics: this.measurer.metrics(emptyFont),
			atom,
			mathShow,
		};
		cached[bold ? 1 : 0] = shape;
		this.shapes.set(para, cached);
		return shape;
	}

	private breakLines(para: Paragraph, availWidth: number, fromChar = 0, bold = false): BrokenLine[] {
		return breakShape(this.shapeOf(para, bold), Math.max(availWidth, MIN_LINE_WIDTH), fromChar);
	}

	layout(pageBoxes: { width: number; height: number }[], dpi: number): PageFlow[] {
		if (pageBoxes.length === 0) return [];
		const rects = pageBoxes.map((b) => contentRectOf(b, this.flow, dpi));
		const pages: PageFlow[] = pageBoxes.map(() => ({ lines: [], tables: [] }));
		const rectAt = (p: number) => rects[Math.min(p, rects.length - 1)];
		const cur = { page: 0, y: rects[0].top };
		let ordinal = 0;
		for (const block of this.flow.blocks) {
			if (block.kind === "table") {
				this.layoutTable(block.table, rects, cur, pages);
				ordinal = 0;
				continue;
			}
			const para = block.para;
			ordinal = para.list === "ordered" ? ordinal + 1 : 0;
			const indentPx = para.indent * INDENT_STEP_PX + (para.list !== "none" ? MARKER_GUTTER_PX : 0);
			let rect = rectAt(cur.page);
			let avail = Math.max(rect.right - rect.left - indentPx, MIN_LINE_WIDTH);
			let lines = this.breakLines(para, avail);
			let first = true;
			for (let li = 0; li < lines.length; ) {
				const bl = lines[li];
				if (cur.y + height(bl) > rect.bottom + EPS && cur.y > rect.top + EPS) {
					cur.page++;
					rect = rectAt(cur.page);
					cur.y = rect.top;
					const widthNow = Math.max(rect.right - rect.left - indentPx, MIN_LINE_WIDTH);
					if (widthNow !== avail) {
						avail = widthNow;
						lines = this.breakLines(para, avail, bl.startChar);
						li = 0;
						continue;
					}
				}
				pages[cur.page]?.lines.push(
					this.placeLine(para, this.shapeOf(para), bl, rect, indentPx, avail, cur.y, {
						last: li === lines.length - 1,
						first: first && bl.startChar === 0,
						ordinal,
					}),
				);
				cur.y += height(bl);
				first = false;
				li++;
			}
		}
		return pages;
	}

	// Rows stack down the page and move whole to the next one when they do not fit;
	// only a row taller than a whole page splits, each cell continuing line by line.
	private layoutTable(table: FlowTable, rects: Box[], cur: { page: number; y: number }, pages: PageFlow[]): void {
		const style = table.style;
		const pad = style.paddingPt * PT_TO_PX;
		const lineW = style.lineWidthPt * PT_TO_PX;
		const cols = table.widths.length || 1;
		const widths = table.widths.length === cols ? normalizedWidths(table.widths) : new Array(cols).fill(1 / cols);
		const tint = style.tint ?? DEFAULT_TINT;
		const rectAt = (p: number) => rects[Math.min(p, rects.length - 1)];
		let rect = rectAt(cur.page);
		let colXs = colEdges(rect, widths, table.width);
		const rowsHere: RowFrag[] = [];

		const flush = () => {
			if (rowsHere.length === 0) return;
			pages[cur.page]?.tables.push({
				colXs,
				rows: rowsHere.splice(0),
				lineColor: style.lineColor,
				lineWidth: lineW,
				borders: style.borders,
				headerFill: style.headerRow ? withAlpha(tint, HEADER_ALPHA) : null,
				bandFill: style.banded ? withAlpha(tint, BAND_ALPHA) : null,
			});
		};
		const newPage = () => {
			flush();
			cur.page++;
			rect = rectAt(cur.page);
			cur.y = rect.top;
			colXs = colEdges(rect, widths, table.width);
		};
		const innerW = (c: number) => Math.max(colXs[c + 1] - colXs[c] - 2 * pad, MIN_LINE_WIDTH);

		interface CellLine {
			para: Paragraph;
			index: number;
			bl: BrokenLine;
			first: boolean;
			last: boolean;
		}
		const cellLines = (row: number, col: number, bold: boolean, fromPara: number, fromChar: number): CellLine[] => {
			const out: CellLine[] = [];
			const paras = table.cells[row][col];
			for (let p = Math.max(fromPara, 0); p < paras.length; p++) {
				const broken = this.breakLines(paras[p], innerW(col), p === fromPara ? fromChar : 0, bold);
				broken.forEach((bl, k) =>
					out.push({ para: paras[p], index: p, bl, first: k === 0 && bl.startChar === 0, last: k === broken.length - 1 }),
				);
			}
			return out;
		};
		const place = (line: CellLine, col: number, y: number, bold: boolean) => {
			const box: Box = { left: colXs[col] + pad, top: y, right: colXs[col] + pad + innerW(col), bottom: y + height(line.bl) };
			pages[cur.page]?.lines.push(
				this.placeLine(line.para, this.shapeOf(line.para, bold), line.bl, box, 0, innerW(col), y, {
					last: line.last,
					first: line.first,
					ordinal: 0,
				}),
			);
		};

		// Half the rule above and below keeps the border off the neighbouring lines.
		cur.y += lineW / 2;
		for (let row = 0; row < table.cells.length; row++) {
			const bold = style.headerRow && row === 0;
			const minH = (table.minHeightsPt[row] ?? 0) * PT_TO_PX;
			const contents = () => Array.from({ length: cols }, (_, c) => cellLines(row, c, bold, -1, 0));
			const heightOf = (content: CellLine[][]) =>
				Math.max(minH, Math.max(...content.map((cell) => cell.reduce((s, l) => s + height(l.bl), 0))) + 2 * pad);
			let content = contents();
			let rowH = heightOf(content);
			if (cur.y + rowH > rect.bottom + EPS && cur.y > rect.top + lineW + EPS) {
				const oldW = rect.right - rect.left;
				newPage();
				if (rect.right - rect.left !== oldW) {
					content = contents();
					rowH = heightOf(content);
				}
			}
			if (cur.y + rowH <= rect.bottom + EPS) {
				for (let c = 0; c < cols; c++) {
					let y = cur.y + pad;
					for (const line of content[c]) {
						place(line, c, y, bold);
						y += height(line.bl);
					}
				}
				rowsHere.push({ row, top: cur.y, bottom: cur.y + rowH });
				cur.y += rowH;
				continue;
			}
			// Taller than a whole page: split it, every cell continuing where it stopped.
			const next = new Array<number>(cols).fill(0);
			for (;;) {
				let used = 0;
				for (let c = 0; c < cols; c++) {
					let y = cur.y + pad;
					const lines = content[c];
					while (next[c] < lines.length) {
						const h = height(lines[next[c]].bl);
						if (y + h > rect.bottom - pad + EPS && y > cur.y + pad + EPS) break;
						place(lines[next[c]], c, y, bold);
						y += h;
						next[c]++;
					}
					used = Math.max(used, y - cur.y + pad);
				}
				if (next.every((n, c) => n >= content[c].length)) {
					const bottom = cur.y + Math.max(used, Math.min(minH, rect.bottom - cur.y));
					rowsHere.push({ row, top: cur.y, bottom });
					cur.y = bottom;
					break;
				}
				rowsHere.push({ row, top: cur.y, bottom: rect.bottom });
				const oldW = rect.right - rect.left;
				newPage();
				if (rect.right - rect.left !== oldW) {
					content = content.map((lines, c) => {
						const rest = lines[next[c]];
						return rest ? cellLines(row, c, bold, rest.index, rest.bl.startChar) : [];
					});
					next.fill(0);
				}
			}
		}
		flush();
		cur.y += lineW / 2;
	}

	private placeLine(
		para: Paragraph,
		shape: ParaShape,
		bl: BrokenLine,
		rect: Box,
		indentPx: number,
		avail: number,
		y: number,
		at: { last: boolean; first: boolean; ordinal: number },
	): PlacedLine {
		const n = bl.endChar - bl.startChar;
		// A display equation alone on its line sits centred unless the user chose an alignment.
		const centreDisplay = para.align === "left" && loneDisplayMath(para, shape, bl);
		const justify = para.align === "justify" && !at.last && !bl.hardBroken && bl.spaceCount > 0;
		const extraPerSpace = justify ? Math.max((avail - bl.width) / bl.spaceCount, 0) : 0;
		const alignOffset =
			centreDisplay || para.align === "center"
				? Math.max((avail - bl.width) / 2, 0)
				: para.align === "right"
					? Math.max(avail - bl.width, 0)
					: 0;
		const xs = new Array<number>(n + 1);
		xs[0] = rect.left + indentPx + alignOffset;
		let stretched = 0;
		for (let k = 0; k < n; k++) {
			const ci = bl.startChar + k;
			let a = shape.adv[ci];
			if (extraPerSpace > 0 && shape.text[ci] === " " && stretched < bl.spaceCount) {
				a += extraPerSpace;
				stretched++;
			}
			xs[k + 1] = xs[k] + a;
		}
		const segs: Seg[] = [];
		const decos: Deco[] = [];
		let runStart = 0;
		para.runs.forEach((run, r) => {
			const runEnd = shape.runEnds[r];
			const from = Math.max(bl.startChar, runStart);
			const to = Math.min(bl.endChar, runEnd);
			runStart = runEnd;
			if (to <= from) return;
			const font = shape.runFonts[r];
			const style = run.style;
			const x = (i: number) => xs[i - bl.startChar];
			if (style.underline || style.strike || style.highlight || style.code) {
				decos.push({ x0: x(from), x1: x(to), style, math: null });
			}
			// A formula is one segment whatever is inside it.
			const show = shape.mathShow[r];
			if (show === "formula") {
				segs.push({ text: shape.text.substring(from, to), x: x(from), font, style, math: true });
				return;
			}
			if (show) decos.push({ x0: x(from), x1: x(to), style, math: show });
			// Words draw one run-fragment at a time; spaces are gaps the xs already carry.
			for (let s = from; s < to; ) {
				if (shape.text[s] === " ") {
					s++;
					continue;
				}
				let e = s;
				while (e < to && shape.text[e] !== " ") e++;
				segs.push({ text: shape.text.substring(s, e), x: x(s), font, style, math: false });
				s = e;
			}
		});
		let marker: Marker | null = null;
		if (at.first && para.list !== "none") {
			const gutterLeft = rect.left + para.indent * INDENT_STEP_PX;
			const gutter: Box = { left: gutterLeft, top: y, right: gutterLeft + MARKER_GUTTER_PX, bottom: y + height(bl) };
			const font: FontSpec = { sizePt: this.flow.defaultSizePt, face: this.flow.defaultFace, bold: false, italic: false };
			if (para.list === "ordered") {
				const label = `${at.ordinal}.`;
				const labelW = this.measurer.advances(label, font).reduce((a, b) => a + b, 0);
				marker = { kind: para.list, checked: para.checked, rect: gutter, text: label, textX: gutter.right - MARKER_GAP - labelW, font };
			} else {
				marker = { kind: para.list, checked: para.checked, rect: gutter, text: null, textX: 0, font };
			}
		}
		return {
			top: y,
			baseline: y + bl.ascent,
			bottom: y + height(bl),
			segs,
			decos,
			marker,
			codeLine: para.codeLang !== null,
			codeLeft: rect.left + indentPx,
			codeRight: rect.right,
		};
	}
}

// Greedy word wrap: breaks sit after space runs, spaces hang past the edge, and a word
// wider than the line hard-breaks per character. fromChar re-breaks a remainder.
function breakShape(shape: ParaShape, availWidth: number, fromChar: number): BrokenLine[] {
	const text = shape.text;
	const len = text.length;
	const start0 = Math.min(Math.max(fromChar, 0), len);
	if (start0 >= len) return [lineOf(shape, start0, len, 0, 0)];
	const out: BrokenLine[] = [];
	let i = start0;
	while (i < len) {
		let w = 0;
		let wAtLastContent = 0;
		let spacesBeforeLastContent = 0;
		let spacesSeen = 0;
		let lastBreak = -1;
		let lastBreakWidth = 0;
		let lastBreakSpaces = 0;
		let j = i;
		let emitted = false;
		while (j < len) {
			const a = shape.adv[j];
			// A space inside a drawn formula is LaTeX, not a gap: the box goes whole.
			if (text[j] === " " && !shape.atom[j]) {
				spacesSeen++;
				w += a;
				j++;
				continue;
			}
			if (j > i && text[j - 1] === " " && !shape.atom[j]) {
				lastBreak = j;
				lastBreakWidth = wAtLastContent;
				lastBreakSpaces = spacesBeforeLastContent;
			}
			if (w + a > availWidth && j > i && !shape.atom[j]) {
				if (lastBreak > i) {
					out.push(lineOf(shape, i, lastBreak, lastBreakWidth, lastBreakSpaces));
					i = lastBreak;
				} else {
					out.push(lineOf(shape, i, j, w, spacesSeen, true));
					i = j;
				}
				emitted = true;
				break;
			}
			w += a;
			wAtLastContent = w;
			spacesBeforeLastContent = spacesSeen;
			j++;
		}
		if (!emitted) {
			out.push(lineOf(shape, i, len, wAtLastContent, spacesBeforeLastContent));
			i = len;
		}
	}
	return out;
}

function lineOf(shape: ParaShape, start: number, end: number, width: number, spaceCount: number, hardBroken = false): BrokenLine {
	let ascent = 0;
	let descent = 0;
	if (start < end) {
		let runStart = 0;
		shape.runEnds.forEach((runEnd, r) => {
			if (runEnd > start && runStart < end) {
				ascent = Math.max(ascent, shape.runMetrics[r].ascent);
				descent = Math.max(descent, shape.runMetrics[r].descent);
			}
			runStart = runEnd;
		});
	}
	if (ascent === 0 && descent === 0) {
		ascent = shape.emptyMetrics.ascent;
		descent = shape.emptyMetrics.descent;
	}
	return { startChar: start, endChar: end, width, ascent, descent, spaceCount, hardBroken };
}

function loneDisplayMath(para: Paragraph, shape: ParaShape, bl: BrokenLine): boolean {
	let found = false;
	let at = 0;
	for (let i = 0; i < para.runs.length; i++) {
		const run = para.runs[i];
		const end = at + run.text.length;
		if (end > bl.startChar && at < bl.endChar) {
			if (run.style.mathDisplay && shape.mathShow[i] === "formula") found = true;
			else if (shape.text.substring(Math.max(at, bl.startChar), Math.min(end, bl.endChar)).trim()) return false;
		}
		at = end;
	}
	return found;
}

function colEdges(rect: Box, widths: number[], frac: number): number[] {
	const tableW = (rect.right - rect.left) * frac;
	const xs = [rect.left];
	let acc = 0;
	for (const w of widths) {
		acc += w;
		xs.push(rect.left + tableW * acc);
	}
	xs[widths.length] = rect.left + tableW;
	return xs;
}

function contentRectOf(page: { width: number; height: number }, flow: TextFlow, dpi: number): Box {
	const mm = (v: number) => (v / 25.4) * dpi;
	const m = flow.margins;
	let left = mm(m.leftMm);
	let w = page.width - left - mm(m.rightMm);
	if (w < MIN_LINE_WIDTH) {
		w = Math.min(MIN_LINE_WIDTH, page.width);
		left = Math.max((page.width - w) / 2, 0);
	}
	let top = mm(m.topMm);
	let h = page.height - top - mm(m.bottomMm);
	if (h < MIN_CONTENT_HEIGHT) {
		h = Math.min(MIN_CONTENT_HEIGHT, page.height);
		top = Math.max((page.height - h) / 2, 0);
	}
	return { left, top, right: left + w, bottom: top + h };
}

function withAlpha(c: Rgba, a: number): Rgba {
	return [c[0], c[1], c[2], a];
}

// ── painting ─────────────────────────────────────────────────────────────

// The app follows its theme for auto colours; here they follow the paper instead.
function isDark(paper: Rgba): boolean {
	return (0.299 * paper[0] + 0.587 * paper[1] + 0.114 * paper[2]) / 255 < 0.5;
}

// Paint one page of the laid-out flow. Formulas are handed back in `math` to be
// mounted over the canvas rather than drawn into it.
export function paintFlowPage(
	ctx: CanvasRenderingContext2D,
	page: PageFlow,
	flow: TextFlow,
	paper: Rgba,
	math: MathPlacement[],
): void {
	const dark = isDark(paper);
	const ink: Rgba = flow.defaultColor ?? (dark ? [236, 236, 236, 255] : [28, 28, 28, 255]);
	const rule: Rgba = dark ? [140, 140, 140, 255] : [100, 100, 100, 255];
	const fill = (x: number, y: number, w: number, h: number, c: Rgba) => {
		ctx.fillStyle = rgbaCss(c);
		ctx.fillRect(x, y, w, h);
	};
	const inkOf = (s: CharStyle): Rgba => s.color ?? (s.link ? LINK_COLOR : ink);

	ctx.save();
	for (const t of page.tables) paintTable(t, t.lineColor ?? rule, fill);
	paintCodeChips(page.lines, fill);
	ctx.textBaseline = "alphabetic";
	for (const line of page.lines) {
		for (const d of line.decos) {
			if (d.style.highlight) fill(d.x0, line.top, d.x1 - d.x0, line.bottom - line.top, d.style.highlight);
			if (d.style.code && !line.codeLine) fill(d.x0 - CHIP_PAD, line.top, d.x1 - d.x0 + 2 * CHIP_PAD, line.bottom - line.top, CHIP_BG);
			if (d.math) {
				fill(d.x0 - CHIP_PAD, line.top, d.x1 - d.x0 + 2 * CHIP_PAD, line.bottom - line.top, d.math === "error" ? MATH_ERROR_BG : MATH_BG);
			}
		}
		if (line.marker) paintMarker(ctx, line, line.marker, ink);
		for (const seg of line.segs) {
			const color = inkOf(seg.style);
			if (seg.math) {
				const sizePx = seg.font.sizePt * PT_TO_PX;
				math.push({ latex: seg.text, display: seg.style.mathDisplay, x: seg.x, baseline: line.baseline, sizePx, color });
				continue;
			}
			ctx.font = cssFont(seg.font);
			ctx.fillStyle = rgbaCss(color);
			ctx.fillText(seg.text, seg.x, line.baseline);
		}
		const ascent = line.baseline - line.top;
		const descent = line.bottom - line.baseline;
		const thickness = Math.max((line.bottom - line.top) / 14, 1);
		for (const d of line.decos) {
			const color = inkOf(d.style);
			if (d.style.underline || d.style.link) fill(d.x0, line.baseline + descent * 0.35, d.x1 - d.x0, thickness, color);
			if (d.style.strike) fill(d.x0, line.baseline - ascent * 0.3, d.x1 - d.x0, thickness, color);
			if (d.math === "error") {
				fill(d.x0 - CHIP_PAD, line.bottom - thickness, d.x1 - d.x0 + 2 * CHIP_PAD, thickness, MATH_ERROR_RULE);
			}
		}
	}
	ctx.restore();
}

type Fill = (x: number, y: number, w: number, h: number, c: Rgba) => void;

// One background per contiguous code block, so abutting lines leave no seams.
function paintCodeChips(lines: PlacedLine[], fill: Fill): void {
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].codeLine) continue;
		const top = lines[i].top;
		let left = lines[i].codeLeft;
		let right = lines[i].codeRight;
		while (i + 1 < lines.length && lines[i + 1].codeLine) {
			i++;
			left = Math.min(left, lines[i].codeLeft);
			right = Math.max(right, lines[i].codeRight);
		}
		fill(left - CODE_PAD, top, right - left + 2 * CODE_PAD, lines[i].bottom - top, CODE_BG);
	}
}

// Header and banded fills, then rules as rects centred on the grid edges; verticals
// stop short of the horizontals so a translucent rule never doubles at a crossing.
function paintTable(t: TableFrag, lineColor: Rgba, fill: Fill): void {
	const left = t.colXs[0];
	const right = t.colXs[t.colXs.length - 1];
	const header = t.headerFill !== null;
	for (const row of t.rows) {
		const body = row.row - (header ? 1 : 0);
		const f = header && row.row === 0 ? t.headerFill : body >= 0 && body % 2 === 1 ? t.bandFill : null;
		if (f) fill(left, row.top, right - left, row.bottom - row.top, f);
	}
	if (t.borders === "none") return;
	const w = t.lineWidth;
	const half = w / 2;
	const h = (y: number) => fill(left - half, y - half, right - left + w, w, lineColor);
	const v = (x: number) => {
		let y = t.rows[0].top + half;
		for (const row of t.rows) {
			const end = row.bottom - half;
			if (end > y) fill(x - half, y, w, end - y, lineColor);
			y = row.bottom + half;
		}
	};
	h(t.rows[0].top);
	if (t.borders === "outer") {
		h(t.rows[t.rows.length - 1].bottom);
		v(left);
		v(right);
	} else if (t.borders === "horizontal") {
		for (const row of t.rows) h(row.bottom);
	} else {
		for (const row of t.rows) h(row.bottom);
		for (const x of t.colXs) v(x);
	}
}

function paintMarker(ctx: CanvasRenderingContext2D, line: PlacedLine, m: Marker, color: Rgba): void {
	const ascent = line.baseline - line.top;
	ctx.fillStyle = rgbaCss(color);
	if (m.kind === "bullet") {
		const r = Math.min(Math.max(ascent * 0.16, 2), 6);
		ctx.beginPath();
		ctx.arc(m.rect.right - MARKER_GAP - r, line.baseline - ascent * 0.32, r, 0, Math.PI * 2);
		ctx.fill();
	} else if (m.kind === "ordered" && m.text) {
		ctx.font = cssFont(m.font);
		ctx.fillText(m.text, m.textX, line.baseline);
	} else if (m.kind === "check") {
		const side = Math.min(Math.max(ascent * 0.85, 8), 26);
		const x = m.rect.right - MARKER_GAP - side;
		const y = line.baseline - side;
		ctx.strokeStyle = rgbaCss(color);
		ctx.lineWidth = Math.max(side / 9, 1.2);
		ctx.strokeRect(x, y, side, side);
		if (m.checked) ctx.fillRect(x + side * 0.25, y + side * 0.25, side * 0.5, side * 0.5);
	}
}
