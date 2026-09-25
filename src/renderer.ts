import { buildStrokeGeometry, type StrokeGeometry } from "./strokeEngine.ts";
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

const PT_TO_PX = 150 / 72; // xnotes authors text at a fixed 150 DPI

function rgbaCss(c: Rgba | null | undefined, fallback = "#000"): string {
	if (!c) return fallback;
	const a = (c[3] ?? 255) / 255;
	return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
}

function cssOpaque(c: Rgba): string {
	return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

function fontFamily(face?: string): string {
	switch (face) {
		case "sans":
			return "ui-sans-serif, system-ui, sans-serif";
		case "serif":
			return "ui-serif, Georgia, serif";
		case "hand":
			return "'Segoe Script', 'Comic Sans MS', cursive";
		case "mono":
		default:
			return "ui-monospace, monospace";
	}
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

	drawBackground(ctx, page, page.style ?? style);

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
	const paper = style?.page_color ?? [255, 255, 255, 255];
	ctx.fillStyle = rgbaCss(paper);
	ctx.fillRect(0, 0, page.width, page.height);

	const pattern = style?.pattern ?? "none";
	if (pattern === "none" || pattern === "blank") return;
	const color = style?.pattern_color ?? [150, 150, 150, 64];
	const spacing = Math.min(200, Math.max(16, style?.spacing ?? 64));
	ctx.save();
	if (pattern === "lines") {
		ctx.strokeStyle = rgbaCss(color);
		ctx.lineWidth = 1.5;
		for (let y = spacing; y < page.height; y += spacing) {
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(page.width, y);
			ctx.stroke();
		}
	} else if (pattern === "grid") {
		ctx.strokeStyle = rgbaCss(color);
		ctx.lineWidth = 1.5;
		for (let x = spacing; x < page.width; x += spacing) {
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, page.height);
			ctx.stroke();
		}
		for (let y = spacing; y < page.height; y += spacing) {
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(page.width, y);
			ctx.stroke();
		}
	} else if (pattern === "dots") {
		ctx.fillStyle = rgbaCss(color);
		for (let x = spacing; x < page.width; x += spacing) {
			for (let y = spacing; y < page.height; y += spacing) {
				ctx.beginPath();
				ctx.arc(x, y, 2.0, 0, Math.PI * 2);
				ctx.fill();
			}
		}
	}
	ctx.restore();
}

// ── strokes ────────────────────────────────────────────────────────────────

// The ribbon is a brush disc swept down the centerline: a filled disc at every
// point, plus the quad bridging each consecutive pair. Each convex piece is
// filled SEPARATELY (not merged into one path) so overlaps never cancel under the
// winding rule, which gives round caps and joins for free with no holes.
function fillDiskRibbon(ctx: CanvasRenderingContext2D, geom: StrokeGeometry, fill: string): void {
	const c = geom.centerline;
	const hwv = geom.halfWidths;
	const n = hwv.length;
	ctx.fillStyle = fill;
	for (let i = 0; i < n; i++) {
		const h = hwv[i];
		if (h <= 0) continue;
		ctx.beginPath();
		ctx.arc(c[2 * i], c[2 * i + 1], h, 0, Math.PI * 2);
		ctx.fill();
	}
	for (let i = 0; i < n - 1; i++) {
		const ax = c[2 * i],
			ay = c[2 * i + 1],
			bx = c[2 * (i + 1)],
			by = c[2 * (i + 1) + 1];
		let dx = bx - ax,
			dy = by - ay;
		const len = Math.hypot(dx, dy);
		if (len < 1e-9) continue;
		dx /= len;
		dy /= len;
		const nx = -dy,
			ny = dx;
		const ha = hwv[i],
			hb = hwv[i + 1];
		ctx.beginPath();
		ctx.moveTo(ax + nx * ha, ay + ny * ha);
		ctx.lineTo(bx + nx * hb, by + ny * hb);
		ctx.lineTo(bx - nx * hb, by - ny * hb);
		ctx.lineTo(ax - nx * ha, ay - ny * ha);
		ctx.closePath();
		ctx.fill();
	}
}

// The config rgba with the tool alpha scale applied: highlighter uses its
// highlighter_alpha, every other tool is opaque.
function renderColor(stroke: StrokeItem): Rgba {
	const cfg = stroke.config;
	const factor = stroke.tool === "highlighter" ? (cfg.highlighter_alpha ?? 0.5) : 1;
	const a = Math.max(0, Math.min(255, Math.round((cfg.rgba[3] ?? 255) * factor)));
	return [cfg.rgba[0], cfg.rgba[1], cfg.rgba[2], a];
}

// Fill the opaque stroke into a full-canvas layer, then composite it once at the
// ink alpha (or a blend), so self-overlaps and round caps do not compound.
function compositeLayer(
	ctx: CanvasRenderingContext2D,
	geom: StrokeGeometry,
	fill: string,
	alpha: number,
	op: GlobalCompositeOperation,
	blur: number,
): void {
	if (alpha <= 0) return;
	// Detached offscreen buffer: createEl would append it to the document, so use createElement.
	// eslint-disable-next-line obsidianmd/prefer-create-el
	const layer = ctx.canvas.ownerDocument.createElement("canvas");
	layer.width = ctx.canvas.width;
	layer.height = ctx.canvas.height;
	const lctx = layer.getContext("2d");
	if (!lctx) return;
	lctx.setTransform(ctx.getTransform());
	if (blur > 0) lctx.filter = `blur(${blur}px)`;
	fillDiskRibbon(lctx, geom, fill);
	ctx.save();
	ctx.globalAlpha = alpha;
	ctx.globalCompositeOperation = op;
	const t = ctx.getTransform();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.drawImage(layer, 0, 0);
	ctx.setTransform(t);
	ctx.restore();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeItem): void {
	const geom = buildStrokeGeometry(stroke);
	if (geom.halfWidths.length === 0) return;
	const color = renderColor(stroke);

	if (stroke.tool === "dashed") {
		drawDashed(ctx, stroke, geom, color);
		return;
	}
	if (stroke.config.neon && stroke.tool !== "highlighter") {
		drawNeon(ctx, stroke, geom, color);
		return;
	}

	if ((color[3] ?? 255) >= 255) {
		fillDiskRibbon(ctx, geom, cssOpaque(color)); // opaque ink
		return;
	}
	const op: GlobalCompositeOperation =
		stroke.tool === "highlighter"
			? stroke.config.highlighter_inverse
				? "screen"
				: "multiply"
			: "source-over";
	compositeLayer(ctx, geom, cssOpaque(color), (color[3] ?? 255) / 255, op, 0);
}

function drawDashed(
	ctx: CanvasRenderingContext2D,
	stroke: StrokeItem,
	geom: StrokeGeometry,
	color: Rgba,
): void {
	const n = geom.halfWidths.length;
	if (n < 2) {
		fillDiskRibbon(ctx, geom, rgbaCss(color)); // a tap is a dot
		return;
	}
	const cfg = stroke.config;
	ctx.save();
	ctx.strokeStyle = rgbaCss(color);
	ctx.lineWidth = cfg.base_width;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.setLineDash([cfg.dash_length ?? 10, cfg.dash_gap ?? 8]);
	ctx.beginPath();
	ctx.moveTo(geom.centerline[0], geom.centerline[1]);
	for (let i = 1; i < n; i++) ctx.lineTo(geom.centerline[2 * i], geom.centerline[2 * i + 1]);
	ctx.stroke();
	ctx.restore();
}

// Neon: wide faint bloom, tighter bright bloom, lit tube body, solid white core.
function drawNeon(
	ctx: CanvasRenderingContext2D,
	stroke: StrokeItem,
	geom: StrokeGeometry,
	color: Rgba,
): void {
	const cfg = stroke.config;
	const strength = Math.max(0, Math.min(1, cfg.neon_strength ?? 0.6));
	const bw = cfg.base_width;
	const wideR = Math.max(bw * (1.8 + 5.0 * strength), 6.0);
	const tightR = Math.max(bw * (0.7 + 1.8 * strength), 2.5);
	const body: Rgba = [color[0], color[1], color[2], 255];
	const bodyCss = cssOpaque(body);
	compositeLayer(ctx, geom, bodyCss, 0.42 * strength, "source-over", wideR);
	compositeLayer(ctx, geom, bodyCss, 0.85 * strength, "source-over", tightR);
	const lift = (v: number) => Math.round(v + (255 - v) * 0.1);
	fillDiskRibbon(ctx, geom, `rgb(${lift(body[0])}, ${lift(body[1])}, ${lift(body[2])})`);
	const core: StrokeGeometry = {
		centerline: geom.centerline,
		halfWidths: geom.halfWidths.map((h) => h * 0.3),
		leftRail: geom.leftRail,
		rightRail: geom.rightRail,
	};
	fillDiskRibbon(ctx, core, "rgb(255, 255, 255)");
}

// ── images ────────────────────────────────────────────────────────────────

async function drawImage(
	ctx: CanvasRenderingContext2D,
	item: ImageItem,
	assetUrls: Map<string, string>,
): Promise<void> {
	const url = assetUrls.get(item.asset) ?? assetUrls.get(item.asset.replace(/\\/g, "/"));
	if (!url) return;
	const img = await loadImage(url);
	const [x, y, w, h] = item.rect;
	ctx.save();
	// Rotate `angle` (radians) then apply the EXIF orientation, both about the rect center.
	ctx.translate(x + w / 2, y + h / 2);
	if (item.angle) ctx.rotate(item.angle);
	applyOrientation(ctx, item.orientation ?? 0);
	try {
		ctx.drawImage(img, -w / 2, -h / 2, w, h);
	} catch {
		// ignore undecodable image
	}
	ctx.restore();
}

function applyOrientation(ctx: CanvasRenderingContext2D, o: number): void {
	switch (o) {
		case 2:
			ctx.scale(-1, 1);
			break;
		case 3:
			ctx.rotate(Math.PI);
			break;
		case 4:
			ctx.scale(1, -1);
			break;
		case 5:
			ctx.rotate(Math.PI / 2);
			ctx.scale(1, -1);
			break;
		case 6:
			ctx.rotate(Math.PI / 2);
			break;
		case 7:
			ctx.rotate(-Math.PI / 2);
			ctx.scale(1, -1);
			break;
		case 8:
			ctx.rotate(-Math.PI / 2);
			break;
	}
}

// ── shapes ──────────────────────────────────────────────────────────────────

function drawShape(ctx: CanvasRenderingContext2D, item: ShapeItem): void {
	ctx.save();
	ctx.strokeStyle = rgbaCss(item.stroke_rgba);
	ctx.lineWidth = item.stroke_width;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	if (item.dashed) ctx.setLineDash([item.dash_length ?? 10, item.dash_gap ?? 8]);
	if (item.neon && item.stroke_rgba) {
		ctx.shadowColor = rgbaCss([item.stroke_rgba[0], item.stroke_rgba[1], item.stroke_rgba[2], 255]);
		ctx.shadowBlur = Math.max(6, item.stroke_width * (1.8 + 5 * (item.neon_strength ?? 0.5)));
	}

	const [sx, sy] = item.start;
	const [ex, ey] = item.end;
	const x = Math.min(sx, ex),
		y = Math.min(sy, ey);
	const w = Math.abs(ex - sx),
		h = Math.abs(ey - sy);
	const fill = item.fill_rgba;

	const path = new Path2D();
	const solid = new Path2D();
	switch (item.shape) {
		case "line":
			path.moveTo(sx, sy);
			path.lineTo(ex, ey);
			break;
		case "arrow":
			path.moveTo(sx, sy);
			path.lineTo(ex, ey);
			drawArrowHead(solid, sx, sy, ex, ey, item.stroke_width);
			break;
		case "rectangle":
			path.rect(x, y, w, h);
			break;
		case "ellipse":
		case "circle":
			path.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
			break;
		case "triangle":
			path.moveTo(x + w / 2, y);
			path.lineTo(x + w, y + h);
			path.lineTo(x, y + h);
			path.closePath();
			break;
		case "polygon":
		case "polyline":
		case "curve":
			if (item.points && item.points.length) {
				path.moveTo(item.points[0][0], item.points[0][1]);
				for (let i = 1; i < item.points.length; i++) path.lineTo(item.points[i][0], item.points[i][1]);
				if (item.shape === "polygon") path.closePath();
			}
			break;
		case "spline":
			drawSpline(path, item);
			break;
		case "axes":
			if (item.angle) {
				const cx = x + w / 2,
					cy = y + h / 2;
				ctx.translate(cx, cy);
				ctx.rotate(item.angle);
				ctx.translate(-cx, -cy);
			}
			drawAxes(path, x, y, w, h, item.stroke_width);
			break;
		case "numberline":
			drawNumberLine(path, sx, sy, ex, ey, item.stroke_width);
			break;
		default:
			path.rect(x, y, w, h);
	}

	const closed = ["rectangle", "ellipse", "circle", "triangle", "polygon"].includes(item.shape);
	if (fill && closed) {
		ctx.fillStyle = rgbaCss(fill);
		ctx.fill(path);
	}
	ctx.stroke(path);
	ctx.setLineDash([]);
	ctx.stroke(solid);
	ctx.restore();
}

// Arrowhead length and tick half-length for the axes and the number line, scaled to `extent`.
function markSizes(extent: number, strokeWidth: number): [number, number] {
	const head = Math.max(5, Math.min(strokeWidth * 1.7, extent * 0.08));
	const tick = Math.max(strokeWidth * 0.8, Math.min(head * 0.45, extent * 0.025));
	return [head, tick];
}

// X-Y coordinate axes: full-width and full-height lines through the box centre, an
// open arrowhead on +x (right) and +y (top), and four ticks per half-axis.
function drawAxes(path: Path2D, x: number, y: number, w: number, h: number, strokeWidth: number): void {
	const left = x,
		right = x + w,
		top = y,
		bottom = y + h;
	const cx = x + w / 2,
		cy = y + h / 2;
	const [head, tick] = markSizes(Math.min(w, h), strokeWidth);

	path.moveTo(left, cy);
	path.lineTo(right, cy);
	path.moveTo(cx, bottom);
	path.lineTo(cx, top);

	path.moveTo(right - head, cy - head * 0.5);
	path.lineTo(right, cy);
	path.lineTo(right - head, cy + head * 0.5);
	path.moveTo(cx - head * 0.5, top + head);
	path.lineTo(cx, top);
	path.lineTo(cx + head * 0.5, top + head);

	const n = 4;
	for (let i = 1; i <= n; i++) {
		const f = i / (n + 1);
		const xr = cx + (right - cx) * f,
			xl = cx - (cx - left) * f;
		path.moveTo(xr, cy - tick);
		path.lineTo(xr, cy + tick);
		path.moveTo(xl, cy - tick);
		path.lineTo(xl, cy + tick);
		const yt = cy - (cy - top) * f,
			yb = cy + (bottom - cy) * f;
		path.moveTo(cx - tick, yt);
		path.lineTo(cx + tick, yt);
		path.moveTo(cx - tick, yb);
		path.lineTo(cx + tick, yb);
	}
}

// A number line from start to end: the axis, an arrowhead at end and nine evenly spaced ticks.
function drawNumberLine(path: Path2D, sx: number, sy: number, ex: number, ey: number, strokeWidth: number): void {
	const len = Math.hypot(ex - sx, ey - sy);
	if (len < 1e-9) return;
	const dx = (ex - sx) / len,
		dy = (ey - sy) / len;
	const px = -dy,
		py = dx;
	const [head, tick] = markSizes(len, strokeWidth);
	const bx = ex - dx * head,
		by = ey - dy * head;
	path.moveTo(sx, sy);
	path.lineTo(ex, ey);
	path.moveTo(bx + px * head * 0.5, by + py * head * 0.5);
	path.lineTo(ex, ey);
	path.lineTo(bx - px * head * 0.5, by - py * head * 0.5);
	const n = 10;
	for (let i = 1; i < n; i++) {
		const ax = sx + dx * ((len * i) / n),
			ay = sy + dy * ((len * i) / n);
		path.moveTo(ax + px * tick, ay + py * tick);
		path.lineTo(ax - px * tick, ay - py * tick);
	}
}

// Open ">" chevron sized from the stroke width, its tip just past the shaft end.
function drawArrowHead(path: Path2D, sx: number, sy: number, ex: number, ey: number, strokeWidth: number): void {
	const len = Math.hypot(ex - sx, ey - sy);
	if (len < 1e-9) return;
	const dx = (ex - sx) / len,
		dy = (ey - sy) / len;
	const headLen = Math.max(12, strokeWidth * 3.5);
	const tx = ex + dx * strokeWidth * 0.5,
		ty = ey + dy * strokeWidth * 0.5;
	const bx = tx - dx * headLen,
		by = ty - dy * headLen;
	const px = -dy * headLen * 0.5,
		py = dx * headLen * 0.5;
	path.moveTo(bx + px, by + py);
	path.lineTo(tx, ty);
	path.lineTo(bx - px, by - py);
}

const SPLINE_SAMPLES = 16;

// Uniform Catmull-Rom through the control points: the stored ones, or both ends and their midpoint.
function drawSpline(path: Path2D, item: ShapeItem): void {
	const [sx, sy] = item.start;
	const [ex, ey] = item.end;
	const c: number[][] = item.points?.length
		? item.points
		: [
				[sx, sy],
				[(sx + ex) / 2, (sy + ey) / 2],
				[ex, ey],
			];
	path.moveTo(c[0][0], c[0][1]);
	if (c.length < 3) {
		for (let i = 1; i < c.length; i++) path.lineTo(c[i][0], c[i][1]);
		return;
	}
	for (let i = 0; i < c.length - 1; i++) {
		const p0 = c[Math.max(i - 1, 0)],
			p1 = c[i],
			p2 = c[i + 1],
			p3 = c[Math.min(i + 2, c.length - 1)];
		for (let s = 1; s <= SPLINE_SAMPLES; s++) {
			const t = s / SPLINE_SAMPLES,
				t2 = t * t,
				t3 = t2 * t;
			const f = (a: number, b: number, cc: number, d: number) =>
				0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
			path.lineTo(f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]));
		}
	}
}

// ── text boxes ────────────────────────────────────────────────────────────

function drawText(ctx: CanvasRenderingContext2D, item: TextItem): void {
	const px = item.point_size * PT_TO_PX;
	ctx.save();
	ctx.fillStyle = rgbaCss(item.rgba);
	const weight = item.bold ? "700" : "400";
	const slant = item.italic ? "italic" : "normal";
	ctx.font = `${slant} ${weight} ${px}px ${fontFamily(item.font_face)}`;
	ctx.textBaseline = "top";
	const lineHeight = px * 1.35;
	const align = item.align ?? "left";
	const ruleWidth = Math.max(1, px * 0.06);

	const lines: string[] = [];
	for (const rawLine of item.text.split("\n")) {
		for (const line of wrapLine(ctx, rawLine, item.width)) lines.push(line);
	}

	let y = item.pos[1];
	for (const line of lines) {
		const w = ctx.measureText(line).width;
		let x = item.pos[0];
		if (align === "center") x = item.pos[0] + (item.width - w) / 2;
		else if (align === "right") x = item.pos[0] + (item.width - w);
		ctx.fillText(line, x, y);
		if (item.underline) ctx.fillRect(x, y + px * 1.05, w, ruleWidth);
		if (item.strike) ctx.fillRect(x, y + px * 0.6, w, ruleWidth);
		y += lineHeight;
	}
	ctx.restore();
}

function wrapLine(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
	if (text.length === 0) return [""];
	const words = text.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const test = current + word;
		if (maxWidth > 0 && ctx.measureText(test).width > maxWidth && current.length > 0) {
			lines.push(current.trimEnd());
			current = word.trimStart();
		} else {
			current = test;
		}
	}
	if (current.length > 0) lines.push(current);
	return lines.length ? lines : [""];
}

// ── tables ──────────────────────────────────────────────────────────────────

function drawTable(ctx: CanvasRenderingContext2D, item: TableItem): void {
	const [x, y, w, h] = item.rect;
	ctx.save();
	ctx.strokeStyle = rgbaCss(item.stroke_rgba);
	ctx.lineWidth = item.stroke_width || 1;
	ctx.strokeRect(x, y, w, h);
	let cx = x;
	for (let i = 0; i < item.cols.length - 1; i++) {
		cx += item.cols[i] * w;
		ctx.beginPath();
		ctx.moveTo(cx, y);
		ctx.lineTo(cx, y + h);
		ctx.stroke();
	}
	let cy = y;
	for (let i = 0; i < item.rows.length - 1; i++) {
		cy += item.rows[i] * h;
		ctx.beginPath();
		ctx.moveTo(x, cy);
		ctx.lineTo(x + w, cy);
		ctx.stroke();
	}
	ctx.restore();
}

// ── image loading ─────────────────────────────────────────────────────────

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
