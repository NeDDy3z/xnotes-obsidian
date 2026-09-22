import type {
	ImageItem,
	Page,
	PageStyle,
	Rgba,
	ShapeItem,
	StrokeItem,
	TableItem,
	TextItem,
} from "./types.ts";

const POINTS_TO_PX = 150 / 72; // xnotes authors text at a fixed 150 DPI
const DEFAULT_SPACING = 64;
const PATTERN_THICKNESS = 1.5;
const DOT_RADIUS = 2;
const DEFAULT_PATTERN_COLOR: Rgba = [150, 150, 150, 64];

function rgbaCss(c: Rgba | null | undefined, fallback = "#000"): string {
	if (!c) return fallback;
	const [r, g, b, a] = c;
	return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${(a ?? 255) / 255})`;
}

// Render one page onto the canvas. `scale` is the backing-store multiplier
// (device pixel ratio times a quality factor); page units map 1:1 to CSS px.
export async function renderPage(
	canvas: HTMLCanvasElement,
	page: Page,
	style: PageStyle | undefined,
	assetUrls: Map<string, string>,
	scale: number,
): Promise<void> {
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2D canvas context unavailable");

	canvas.width = Math.max(1, Math.round(page.width * scale));
	canvas.height = Math.max(1, Math.round(page.height * scale));
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	ctx.clearRect(0, 0, page.width, page.height);

	drawBackground(ctx, page, style);

	for (const item of page.items) {
		switch (item.kind) {
			case "stroke":
				drawStroke(ctx, item);
				break;
			case "shape":
				drawShape(ctx, item);
				break;
			case "table":
				drawTable(ctx, item);
				break;
			case "text":
				drawText(ctx, item);
				break;
			case "image":
				await drawImage(ctx, item, assetUrls);
				break;
		}
	}
}

function drawBackground(ctx: CanvasRenderingContext2D, page: Page, style?: PageStyle): void {
	ctx.save();
	ctx.fillStyle = style ? rgbaCss(style.page_color, "#fff") : "#fff";
	ctx.fillRect(0, 0, page.width, page.height);

	const pattern = style?.pattern ?? "none";
	const spacing = style?.spacing && style.spacing > 0 ? style.spacing : DEFAULT_SPACING;
	if (!style || pattern === "none" || pattern === "blank") {
		ctx.restore();
		return;
	}

	const color = style.pattern_color ?? DEFAULT_PATTERN_COLOR;
	ctx.strokeStyle = rgbaCss(color);
	ctx.fillStyle = rgbaCss(color);
	ctx.lineWidth = PATTERN_THICKNESS;

	if (pattern === "grid" || pattern === "lines") {
		ctx.beginPath();
		for (let y = spacing; y < page.height; y += spacing) {
			ctx.moveTo(0, y);
			ctx.lineTo(page.width, y);
		}
		if (pattern === "grid") {
			for (let x = spacing; x < page.width; x += spacing) {
				ctx.moveTo(x, 0);
				ctx.lineTo(x, page.height);
			}
		}
		ctx.stroke();
	} else if (pattern === "dots") {
		for (let y = spacing; y < page.height; y += spacing) {
			for (let x = spacing; x < page.width; x += spacing) {
				ctx.beginPath();
				ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}
	ctx.restore();
}

// --- Strokes -------------------------------------------------------------

// Normalized logistic ease with exact endpoints (matches StrokeEngine.logisticEase, k=8).
function logisticEase(x: number, k = 8): number {
	const lo = 1 / (1 + Math.exp(k / 2));
	const hi = 1 / (1 + Math.exp(-k / 2));
	const raw = 1 / (1 + Math.exp(-k * (x - 0.5)));
	return (raw - lo) / (hi - lo);
}

function halfWidths(item: StrokeItem): number[] {
	const cfg = item.config;
	const m = cfg.pressure_min_factor ?? 0.35;
	const ds = cfg.direction_strength ?? 0;
	const pts = item.samples;
	const out = new Array<number>(pts.length);
	for (let i = 0; i < pts.length; i++) {
		const pEff = cfg.pressure_enabled ? logisticEase(clamp01(pts[i][2] ?? 0)) : 1;
		const wBase = cfg.base_width * (m + (1 - m) * pEff);
		let direction = 1;
		if (ds !== 0) {
			const [tx, ty] = unitTangent(pts, i);
			void tx;
			direction = Math.max(1 + ds * ty, 0.1);
		}
		out[i] = (wBase * direction) / 2;
	}
	return out;
}

function unitTangent(pts: number[][], i: number): [number, number] {
	const a = pts[Math.max(0, i - 1)];
	const b = pts[Math.min(pts.length - 1, i + 1)];
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy) || 1;
	return [dx / len, dy / len];
}

function drawStroke(ctx: CanvasRenderingContext2D, item: StrokeItem): void {
	const pts = item.samples;
	if (!pts || pts.length === 0) return;

	const cfg = item.config;
	const tool = item.tool;

	if (tool === "dashed") {
		drawDashedStroke(ctx, item);
		return;
	}

	const highlighter = tool === "highlighter";
	const color: Rgba = [...cfg.rgba] as Rgba;
	if (highlighter) {
		color[3] = Math.round(255 * (cfg.highlighter_alpha ?? 0.35));
	}

	ctx.save();
	if (highlighter) ctx.globalCompositeOperation = "multiply";
	ctx.fillStyle = rgbaCss(color);

	// Swept disk ribbon: a disc at every sample plus a quad between consecutive
	// samples, filled once with nonzero winding so overlaps union instead of
	// compounding. This yields round caps and joins for free.
	const radii = halfWidths(item);

	if (pts.length === 1) {
		ctx.beginPath();
		ctx.arc(pts[0][0], pts[0][1], radii[0], 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
		return;
	}

	ctx.beginPath();
	for (let i = 0; i < pts.length; i++) {
		ctx.moveTo(pts[i][0] + radii[i], pts[i][1]);
		ctx.arc(pts[i][0], pts[i][1], radii[i], 0, Math.PI * 2);
	}
	for (let i = 1; i < pts.length; i++) {
		addRibbonQuad(ctx, pts[i - 1], radii[i - 1], pts[i], radii[i]);
	}
	ctx.fill("nonzero");
	ctx.restore();
}

function addRibbonQuad(
	ctx: CanvasRenderingContext2D,
	a: number[],
	ra: number,
	b: number[],
	rb: number,
): void {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy);
	if (len === 0) return;
	const nx = -dy / len;
	const ny = dx / len;
	ctx.moveTo(a[0] + nx * ra, a[1] + ny * ra);
	ctx.lineTo(b[0] + nx * rb, b[1] + ny * rb);
	ctx.lineTo(b[0] - nx * rb, b[1] - ny * rb);
	ctx.lineTo(a[0] - nx * ra, a[1] - ny * ra);
	ctx.closePath();
}

function drawDashedStroke(ctx: CanvasRenderingContext2D, item: StrokeItem): void {
	const pts = item.samples;
	const cfg = item.config;
	ctx.save();
	ctx.strokeStyle = rgbaCss(cfg.rgba);
	ctx.lineWidth = cfg.base_width;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	const on = cfg.dash_length ?? cfg.base_width * 3;
	const gap = cfg.dash_gap ?? cfg.base_width * 2;
	ctx.setLineDash([on, gap]);
	ctx.beginPath();
	ctx.moveTo(pts[0][0], pts[0][1]);
	for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
	ctx.stroke();
	ctx.restore();
}

// --- Shapes --------------------------------------------------------------

function drawShape(ctx: CanvasRenderingContext2D, item: ShapeItem): void {
	const [x0, y0] = item.start;
	const [x1, y1] = item.end;
	ctx.save();
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.lineWidth = item.stroke_width || 1;
	ctx.strokeStyle = rgbaCss(item.stroke_rgba);
	if (item.dash_length) ctx.setLineDash([item.dash_length, item.dash_gap ?? item.dash_length]);
	const fill = item.fill_rgba ? rgbaCss(item.fill_rgba) : null;

	const x = Math.min(x0, x1);
	const y = Math.min(y0, y1);
	const w = Math.abs(x1 - x0);
	const h = Math.abs(y1 - y0);

	switch (item.shape) {
		case "rectangle":
			if (fill) {
				ctx.fillStyle = fill;
				ctx.fillRect(x, y, w, h);
			}
			if (item.stroke_rgba) ctx.strokeRect(x, y, w, h);
			break;
		case "ellipse":
		case "circle":
			ctx.beginPath();
			ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
			if (fill) {
				ctx.fillStyle = fill;
				ctx.fill();
			}
			if (item.stroke_rgba) ctx.stroke();
			break;
		case "triangle":
			polygon(ctx, [[x + w / 2, y], [x, y + h], [x + w, y + h]], fill, !!item.stroke_rgba, true);
			break;
		case "polygon":
			polygon(ctx, item.points ?? [], fill, !!item.stroke_rgba, true);
			break;
		case "polyline":
		case "curve":
			polygon(ctx, item.points ?? [], null, !!item.stroke_rgba, false);
			break;
		case "line":
			line(ctx, x0, y0, x1, y1);
			break;
		case "arrow":
			line(ctx, x0, y0, x1, y1);
			arrowHead(ctx, x0, y0, x1, y1, item.stroke_width || 1);
			break;
		case "axes":
			// "axes" is not in the reference source; drawn as a best-guess
			// origin-at-bottom-left coordinate cross with arrow tips.
			drawAxes(ctx, x0, y0, x1, y1, item.stroke_width || 1);
			break;
		default:
			if (item.stroke_rgba) ctx.strokeRect(x, y, w, h);
			break;
	}
	ctx.restore();
}

function polygon(
	ctx: CanvasRenderingContext2D,
	pts: number[][],
	fill: string | null,
	stroke: boolean,
	close: boolean,
): void {
	if (pts.length < 2) return;
	ctx.beginPath();
	ctx.moveTo(pts[0][0], pts[0][1]);
	for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
	if (close) ctx.closePath();
	if (fill) {
		ctx.fillStyle = fill;
		ctx.fill();
	}
	if (stroke) ctx.stroke();
}

function line(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.stroke();
}

// Open chevron arrow head, matching ShapeItem.arrowHead geometry.
function arrowHead(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	width: number,
): void {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const len = Math.hypot(dx, dy) || 1;
	const dirX = dx / len;
	const dirY = dy / len;
	const perpX = -dirY;
	const perpY = dirX;
	const headLen = Math.max(12, width * 3.5);
	const tipX = x1 + dirX * width * 0.5;
	const tipY = y1 + dirY * width * 0.5;
	const baseX = tipX - dirX * headLen;
	const baseY = tipY - dirY * headLen;
	const half = headLen * 0.5;
	ctx.beginPath();
	ctx.moveTo(baseX + perpX * half, baseY + perpY * half);
	ctx.lineTo(tipX, tipY);
	ctx.lineTo(baseX - perpX * half, baseY - perpY * half);
	ctx.stroke();
}

function drawAxes(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	width: number,
): void {
	const left = Math.min(x0, x1);
	const right = Math.max(x0, x1);
	const top = Math.min(y0, y1);
	const bottom = Math.max(y0, y1);
	line(ctx, left, bottom, right, bottom);
	arrowHead(ctx, left, bottom, right, bottom, width);
	line(ctx, left, bottom, left, top);
	arrowHead(ctx, left, bottom, left, top, width);
}

// --- Tables (inferred: not present in the reference source) --------------

function drawTable(ctx: CanvasRenderingContext2D, item: TableItem): void {
	const [x, y, w, h] = item.rect;
	ctx.save();
	ctx.strokeStyle = rgbaCss(item.stroke_rgba);
	ctx.lineWidth = item.stroke_width || 1;
	ctx.strokeRect(x, y, w, h);

	ctx.beginPath();
	let cx = 0;
	for (let i = 0; i < item.cols.length - 1; i++) {
		cx += item.cols[i];
		ctx.moveTo(x + cx * w, y);
		ctx.lineTo(x + cx * w, y + h);
	}
	let cy = 0;
	for (let i = 0; i < item.rows.length - 1; i++) {
		cy += item.rows[i];
		ctx.moveTo(x, y + cy * h);
		ctx.lineTo(x + w, y + cy * h);
	}
	ctx.stroke();
	ctx.restore();
}

// --- Text ----------------------------------------------------------------

const FONT_FACES: Record<string, string> = {
	mono: "monospace",
	sans: "sans-serif",
	serif: "serif",
	hand: "cursive",
};

function drawText(ctx: CanvasRenderingContext2D, item: TextItem): void {
	ctx.save();
	ctx.fillStyle = rgbaCss(item.rgba);
	ctx.textBaseline = "top";
	const px = item.point_size * POINTS_TO_PX;
	ctx.font = `${px}px ${FONT_FACES[item.font_face ?? "mono"] ?? "monospace"}`;
	wrapText(ctx, item.text, item.pos[0], item.pos[1], item.width, px * 1.2);
	ctx.restore();
}

function wrapText(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	maxWidth: number,
	lineHeight: number,
): void {
	for (const paragraph of text.split("\n")) {
		if (paragraph === "") {
			y += lineHeight;
			continue;
		}
		let lineStr = "";
		for (const word of paragraph.split(/(\s+)/)) {
			const test = lineStr + word;
			if (maxWidth > 0 && ctx.measureText(test).width > maxWidth && lineStr !== "") {
				ctx.fillText(lineStr, x, y);
				y += lineHeight;
				lineStr = word.replace(/^\s+/, "");
			} else {
				lineStr = test;
			}
		}
		if (lineStr) ctx.fillText(lineStr, x, y);
		y += lineHeight;
	}
}

// --- Images --------------------------------------------------------------

async function drawImage(
	ctx: CanvasRenderingContext2D,
	item: ImageItem,
	assetUrls: Map<string, string>,
): Promise<void> {
	const url = assetUrls.get(item.asset) ?? assetUrls.get(item.asset.replace(/\\/g, "/"));
	if (!url) return;
	const img = await loadImage(url);
	const [x, y, w, h] = item.rect;
	const degrees = (item.orientation ?? 0) + (item.angle ?? 0) * (180 / Math.PI);
	ctx.save();
	if (degrees) {
		ctx.translate(x + w / 2, y + h / 2);
		ctx.rotate((degrees * Math.PI) / 180);
		ctx.drawImage(img, -w / 2, -h / 2, w, h);
	} else {
		ctx.drawImage(img, x, y, w, h);
	}
	ctx.restore();
}

const imageCache = new Map<string, HTMLImageElement>();

function loadImage(url: string): Promise<HTMLImageElement> {
	const cached = imageCache.get(url);
	if (cached?.complete) return Promise.resolve(cached);
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			imageCache.set(url, img);
			resolve(img);
		};
		img.onerror = () => reject(new Error("image failed to load"));
		img.src = url;
	});
}

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}
