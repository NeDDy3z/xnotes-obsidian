import type { TextFlow } from "./flow.ts";
import { paintFlowPage, type PageFlow } from "./flowLayout.ts";
import type { MathPlacement, MathSetter } from "./math.ts";
import { buildStrokeGeometry, type StrokeGeometry } from "./strokeEngine.ts";
import { fontFamily, PT_TO_PX, rgbaCss } from "./text.ts";
import type {
	FillItem,
	ImageItem,
	Page,
	PageStyle,
	Rgba,
	Room,
	ShapeItem,
	StrokeItem,
	TableItem,
	TextItem,
} from "./types.ts";

function cssOpaque(c: Rgba): string {
	return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

// The slice of pdf.js used to paint a note's source PDF under its pages.
export interface PdfSource {
	getPage(pageNumber: number): Promise<{
		rotate: number;
		getViewport(params: { scale: number; rotation?: number }): { width: number; height: number };
		render(params: { canvasContext: OffscreenCanvasRenderingContext2D; viewport: unknown }): {
			promise: Promise<void>;
		};
	}>;
}

// The flowing text laid out for this page.
export interface PageText {
	flow: TextFlow;
	page: PageFlow;
}

// Render one page onto the canvas. `scale` is the backing-store multiplier
// (device pixel ratio times a quality factor); page units map 1:1 to CSS px.
// Formulas are returned rather than drawn, for the caller to mount over the canvas.
export async function renderPage(
	canvas: HTMLCanvasElement,
	page: Page,
	style: PageStyle | undefined,
	writer: number,
	assetUrls: Map<string, string>,
	scale: number,
	pdf: PdfSource | null,
	text: PageText | null,
	math: MathSetter,
): Promise<MathPlacement[]> {
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2D canvas context unavailable");

	canvas.width = Math.max(1, Math.round(page.width * scale));
	canvas.height = Math.max(1, Math.round(page.height * scale));
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	ctx.clearRect(0, 0, page.width, page.height);

	const pageStyle = resolvePageStyle(style, page.style, writer);
	if (pdf && page.pdf_page != null) {
		drawPaper(ctx, page, pageStyle);
		drawRulingInRooms(ctx, page, pageStyle);
		await drawPdfPage(ctx, pdf, page);
	} else {
		drawBackground(ctx, page, pageStyle);
	}

	const formulas: MathPlacement[] = [];
	if (text) paintFlowPage(ctx, text.page, text.flow, pageStyle.page_color ?? [255, 255, 255, 255], page.style?.text_color, formulas);

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
				drawText(ctx, item, math, formulas);
				break;
			case "image":
				await drawImage(ctx, item, assetUrls);
				break;
			case "fill":
				drawFill(ctx, item);
				break;
		}
	}
	return formulas;
}

const BUILT_IN_PATTERNS = ["lines", "dots", "grid"];
// Writers from this versionCode on keep template settings per template rather than lending them to pages showing another one.
const OWN_TEMPLATE_SETTINGS_SINCE = 67;

// A page takes the note's spacing and pattern colour only while it shows the note's own template.
export function resolvePageStyle(note: PageStyle | undefined, page: PageStyle | undefined, writer: number): PageStyle {
	const noteKey = note?.pattern ?? note?.template ?? "none";
	const key = page?.pattern ?? page?.template ?? noteKey;
	if (key === noteKey) return { ...note, ...page };
	const own: PageStyle = { page_color: note?.page_color, ...page };
	if (writer >= OWN_TEMPLATE_SETTINGS_SINCE || key === "none") return own;
	// Older notes let a page borrow the colour always, and the spacing between built-in rulings.
	own.pattern_color ??= note?.pattern_color;
	const noteHasTemplate = note?.pattern != null || note?.template != null;
	if (!noteHasTemplate || (BUILT_IN_PATTERNS.includes(key) && BUILT_IN_PATTERNS.includes(noteKey))) own.spacing ??= note?.spacing;
	return own;
}

function drawPaper(ctx: CanvasRenderingContext2D, page: Page, style?: PageStyle): void {
	ctx.fillStyle = rgbaCss(style?.page_color ?? [255, 255, 255, 255]);
	ctx.fillRect(0, 0, page.width, page.height);
}

// ── rooms ───────────────────────────────────────────────────────────────────

const ROOM_EPS = 1e-6;

interface Band {
	from: number;
	to: number;
	shift: number;
}

// The rooms on one axis in order, as the app loads them: whole, apart, and leaving the page some size of its own.
function roomsOn(page: Page, sideways: boolean): Room[] {
	const length = sideways ? page.width : page.height;
	const out: Room[] = [];
	let total = 0,
		end = -Infinity;
	const rooms = (page.rooms ?? [])
		.filter((r) => (r.sideways ?? false) === sideways && Number.isFinite(r.at) && Number.isFinite(r.size) && r.size > 0)
		.sort((a, b) => a.at - b.at);
	for (const r of rooms) {
		if (r.at <= end || total + r.size >= length) continue;
		out.push(r);
		total += r.size;
		end = r.at + r.size;
	}
	return out;
}

// The page before any room opened, cut along one axis into the stretches between rooms, each with how far it moved.
function roomBands(rooms: Room[], length: number): Band[] {
	const out: Band[] = [];
	let from = 0,
		shift = 0;
	for (const r of rooms) {
		const cut = r.at - shift;
		if (cut - from > ROOM_EPS && cut > 0) out.push({ from: Math.max(from, 0), to: Math.min(cut, length), shift });
		from = Math.max(from, cut);
		shift += r.size;
	}
	if (length - from > ROOM_EPS) out.push({ from: Math.max(from, 0), to: length, shift });
	return out.filter((b) => b.to - b.from > ROOM_EPS);
}

// Room is paper: on a PDF page it shows the page's ruling, which the PDF covers everywhere else.
function drawRulingInRooms(ctx: CanvasRenderingContext2D, page: Page, style: PageStyle): void {
	const rooms = [...roomsOn(page, false), ...roomsOn(page, true)];
	if (rooms.length === 0) return;
	ctx.save();
	ctx.beginPath();
	for (const r of rooms) {
		if (r.sideways) ctx.rect(r.at, 0, r.size, page.height);
		else ctx.rect(0, r.at, page.width, r.size);
	}
	ctx.clip();
	drawBackground(ctx, page, style);
	ctx.restore();
}

// The PDF page covers the note page as it was before any room, laid in bands round the room inserted since.
async function drawPdfPage(ctx: CanvasRenderingContext2D, pdf: PdfSource, page: Page): Promise<void> {
	const pdfPage = await pdf.getPage((page.pdf_page ?? 0) + 1);
	// A turned page turns its PDF with it, on top of the PDF's own rotation.
	const rotation = (pdfPage.rotate + 90 * (page.pdf_turn ?? 0)) % 360;
	const xs = roomsOn(page, true),
		ys = roomsOn(page, false);
	const sw = page.width - xs.reduce((a, r) => a + r.size, 0);
	const sh = page.height - ys.reduce((a, r) => a + r.size, 0);
	const natural = pdfPage.getViewport({ scale: 1, rotation });
	const viewport = pdfPage.getViewport({ scale: (ctx.canvas.width * (sw / page.width)) / natural.width, rotation });
	const raster = new OffscreenCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
	const rctx = raster.getContext("2d");
	if (!rctx) return;
	await pdfPage.render({ canvasContext: rctx, viewport }).promise;
	for (const by of roomBands(ys, sh)) {
		for (const bx of roomBands(xs, sw)) {
			ctx.save();
			ctx.beginPath();
			ctx.rect(bx.from + bx.shift, by.from + by.shift, bx.to - bx.from, by.to - by.from);
			ctx.clip();
			ctx.drawImage(raster, bx.shift, by.shift, sw, sh);
			ctx.restore();
		}
	}
}

function drawBackground(ctx: CanvasRenderingContext2D, page: Page, style?: PageStyle): void {
	drawPaper(ctx, page, style);

	const pattern = style?.pattern ?? "none";
	if (pattern === "none" || pattern === "blank") return;
	const color = style?.pattern_color ?? [150, 150, 150, 128];
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

// The ribbon is a brush disc swept down the centerline: one nonzero path of capsules, the
// tangent hulls of each consecutive pair of discs, all wound the same way so overlaps union
// into solid ink with round caps and joins and no holes at sharp turns.
function fillDiskRibbon(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, geom: StrokeGeometry, fill: string): void {
	const c = geom.centerline;
	const r = geom.halfWidths;
	const n = r.length;
	ctx.fillStyle = fill;
	ctx.beginPath();
	if (n === 1) addDisc(ctx, c[0], c[1], r[0]);
	for (let i = 0; i < n - 1; i++) addCapsule(ctx, c[2 * i], c[2 * i + 1], r[i], c[2 * i + 2], c[2 * i + 3], r[i + 1]);
	ctx.fill();
}

type PathTarget = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function addDisc(ctx: PathTarget, x: number, y: number, r: number): void {
	if (r <= 0) return;
	ctx.moveTo(x + r, y);
	ctx.arc(x, y, r, 0, Math.PI * 2);
}

function addCapsule(ctx: PathTarget, x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): void {
	const dx = x1 - x0,
		dy = y1 - y0;
	const d = Math.hypot(dx, dy);
	// One disc holds the other, so their hull is the larger disc.
	if (d <= Math.abs(r1 - r0) + 1e-9) {
		if (r0 >= r1) addDisc(ctx, x0, y0, r0);
		else addDisc(ctx, x1, y1, r1);
		return;
	}
	const ux = dx / d,
		uy = dy / d;
	const s = (r0 - r1) / d;
	const k = Math.sqrt(1 - s * s);
	const lx = ux * s + uy * k,
		ly = uy * s - ux * k;
	const rx = ux * s - uy * k,
		ry = uy * s + ux * k;
	const front = Math.PI - 2 * Math.asin(s);
	ctx.moveTo(x0 + r0 * lx, y0 + r0 * ly);
	ctx.lineTo(x1 + r1 * lx, y1 + r1 * ly);
	if (r1 > 0) ctx.arc(x1, y1, r1, Math.atan2(ly, lx), Math.atan2(ly, lx) + front);
	ctx.lineTo(x0 + r0 * rx, y0 + r0 * ry);
	if (r0 > 0) ctx.arc(x0, y0, r0, Math.atan2(ry, rx), Math.atan2(ry, rx) + 2 * Math.PI - front);
	ctx.closePath();
}

// What a stroke saved without a colour has always loaded as.
const LEGACY_INK: Rgba = [0, 230, 118, 255];

// The config rgba with the tool alpha scale applied: highlighter uses its
// highlighter_alpha, every other tool is opaque.
function renderColor(stroke: StrokeItem): Rgba {
	const cfg = stroke.config;
	const rgba = cfg.rgba ?? LEGACY_INK;
	const factor = stroke.tool === "highlighter" ? (cfg.highlighter_alpha ?? 0.5) : 1;
	const a = Math.max(0, Math.min(255, Math.round((rgba[3] ?? 255) * factor)));
	return [rgba[0], rgba[1], rgba[2], a];
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
	const layer = new OffscreenCanvas(ctx.canvas.width, ctx.canvas.height);
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

// Ink Insert space cut shows only on the near side of each cut edge.
function drawStroke(ctx: CanvasRenderingContext2D, stroke: StrokeItem): void {
	const cuts = (stroke.cuts ?? []).filter((c) => c.length >= 4 && Math.hypot(c[2], c[3]) > 1e-9);
	if (cuts.length === 0) return drawInk(ctx, stroke);
	const shown = clipToCuts(cuts);
	if (shown.length < 3) return;
	ctx.save();
	ctx.beginPath();
	ctx.moveTo(shown[0][0], shown[0][1]);
	for (let i = 1; i < shown.length; i++) ctx.lineTo(shown[i][0], shown[i][1]);
	ctx.closePath();
	ctx.clip();
	drawInk(ctx, stroke);
	ctx.restore();
}

// A rect far past any page, cut down to the side of every edge that shows (Sutherland-Hodgman).
function clipToCuts(cuts: number[][]): number[][] {
	const far = 1e6;
	let poly = [
		[-far, -far],
		[far, -far],
		[far, far],
		[-far, far],
	];
	for (const [x, y, rawNx, rawNy] of cuts) {
		const len = Math.hypot(rawNx, rawNy);
		const nx = rawNx / len,
			ny = rawNy / len;
		const past = (p: number[]) => (p[0] - x) * nx + (p[1] - y) * ny;
		const out: number[][] = [];
		for (let i = 0; i < poly.length; i++) {
			const a = poly[i],
				b = poly[(i + 1) % poly.length];
			const da = past(a),
				db = past(b);
			if (da <= 0) out.push(a);
			if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
				const t = da / (da - db);
				out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			}
		}
		poly = out;
		if (poly.length === 0) break;
	}
	return poly;
}

function drawInk(ctx: CanvasRenderingContext2D, stroke: StrokeItem): void {
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
	const [x, y, w, h] = item.rect;
	if (w <= 0 || h <= 0) return;
	const img = await loadImage(url);
	const part = imagePart(item.part);
	const o = (((item.orientation ?? 0) % 360) + 360) % 360;
	const turned = o === 90 || o === 270;
	const uw = turned ? h : w,
		uh = turned ? w : h;
	ctx.save();
	// Turn by `angle`, mirror by `flip`, then the quarter-turn `orientation`, all about the rect center.
	ctx.translate(x + w / 2, y + h / 2);
	if (item.angle) ctx.rotate(item.angle);
	if (part) {
		ctx.beginPath();
		ctx.rect(-w / 2, -h / 2, w, h);
		ctx.clip();
	}
	ctx.scale(item.flip?.includes("x") ? -1 : 1, item.flip?.includes("y") ? -1 : 1);
	if (o) ctx.rotate((o * Math.PI) / 180);
	try {
		if (!part) {
			ctx.drawImage(img, -uw / 2, -uh / 2, uw, uh);
		} else {
			// The whole picture laid where its part fills the box, the clip showing only the part.
			const [pl, pt, pr, pb] = part;
			const fw = uw / (pr - pl),
				fh = uh / (pb - pt);
			const cx = (0.5 - (pl + pr) / 2) * fw,
				cy = (0.5 - (pt + pb) / 2) * fh;
			ctx.drawImage(img, cx - fw / 2, cy - fh / 2, fw, fh);
		}
	} catch {
		// ignore undecodable image
	}
	ctx.restore();
}

// The slice of a picture Insert space left, as left, top, right, bottom fractions; null for all or none of it.
function imagePart(part: ImageItem["part"]): [number, number, number, number] | null {
	if (!part || part.length < 4) return null;
	const clamp = (v: number) => Math.min(1, Math.max(0, v));
	const l = clamp(part[0]),
		t = clamp(part[1]),
		r = clamp(part[0] + part[2]),
		b = clamp(part[1] + part[3]);
	if (r - l <= 1e-9 || b - t <= 1e-9) return null;
	if (l <= 1e-4 && t <= 1e-4 && r >= 1 - 1e-4 && b >= 1 - 1e-4) return null;
	return [l, t, r, b];
}

// ── shapes ──────────────────────────────────────────────────────────────────

function drawFill(ctx: CanvasRenderingContext2D, item: FillItem): void {
	const [x, y, w, h] = item.rect;
	if (!item.path || !item.fill_rgba || w <= 0 || h <= 0) return;
	ctx.save();
	ctx.translate(x + w / 2, y + h / 2);
	ctx.rotate(item.angle ?? 0);
	ctx.scale(item.flip?.includes("x") ? -1 : 1, item.flip?.includes("y") ? -1 : 1);
	ctx.translate(-w / 2, -h / 2);
	ctx.scale(w, h);
	ctx.fillStyle = rgbaCss(item.fill_rgba);
	ctx.fill(new Path2D(item.path), "evenodd");
	ctx.restore();
}

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
		case "function":
			for (const run of pointRuns(item.points ?? [])) {
				path.moveTo(run[0][0], run[0][1]);
				for (let i = 1; i < run.length; i++) path.lineTo(run[i][0], run[i][1]);
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

// Split a vertex list at its break markers (empty points, written at a plotted function's poles)
// into runs of two or more points.
function pointRuns(points: number[][]): number[][][] {
	const runs: number[][][] = [];
	let run: number[][] = [];
	for (const p of points) {
		if (p.length >= 2) {
			run.push(p);
			continue;
		}
		if (run.length >= 2) runs.push(run);
		run = [];
	}
	if (run.length >= 2) runs.push(run);
	return runs;
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

function drawText(ctx: CanvasRenderingContext2D, item: TextItem, math: MathSetter, formulas: MathPlacement[]): void {
	const px = item.point_size * PT_TO_PX;
	// A formula box sets its LaTeX with its top at pos; one that will not set shows as text.
	const box = item.math && item.text ? math.measure(item.text, px, true) : null;
	if (box) {
		formulas.push({ latex: item.text, display: true, x: item.pos[0], baseline: item.pos[1] + box.ascent, sizePx: px, color: item.rgba });
		return;
	}
	ctx.save();
	ctx.fillStyle = rgbaCss(item.rgba);
	// A link to a stored document draws a paperclip before its text.
	const inset = item.link?.startsWith("xnotes-doc:") ? item.point_size * 1.3 : 0;
	if (inset > 0) drawPaperclip(ctx, item);
	const left = item.pos[0] + inset,
		width = item.width - inset;
	const weight = item.bold ? "700" : "400";
	const slant = item.italic ? "italic" : "normal";
	ctx.font = `${slant} ${weight} ${px}px ${fontFamily(item.font_face)}`;
	ctx.textBaseline = "top";
	const lineHeight = px * 1.35;
	const align = item.align ?? "left";
	const ruleWidth = Math.max(1, px * 0.06);

	const lines: string[] = [];
	for (const rawLine of item.text.split("\n")) {
		for (const line of wrapLine(ctx, rawLine, width)) lines.push(line);
	}

	let y = item.pos[1];
	for (const line of lines) {
		const w = ctx.measureText(line).width;
		let x = left;
		if (align === "center") x = left + (width - w) / 2;
		else if (align === "right") x = left + (width - w);
		ctx.fillText(line, x, y);
		if (item.underline) ctx.fillRect(x, y + px * 1.05, w, ruleWidth);
		if (item.strike) ctx.fillRect(x, y + px * 0.6, w, ruleWidth);
		y += lineHeight;
	}
	ctx.restore();
}

// The toolbar's Insert paperclip (Feather), flattened on its 24-unit grid.
const PAPERCLIP = [
	21.44, 11.05, 12.25, 20.24, 11.79, 20.65, 11.31, 21.01, 10.26, 21.56, 9.15, 21.89, 8.01, 22.0, 6.86, 21.89, 5.75, 21.56,
	4.7, 21.01, 4.22, 20.65, 3.76, 20.24, 3.35, 19.78, 2.99, 19.3, 2.44, 18.25, 2.11, 17.14, 2.0, 16.0, 2.11, 14.85, 2.44,
	13.74, 2.99, 12.69, 3.35, 12.21, 3.76, 11.75, 12.95, 2.56, 13.58, 2.05, 14.27, 1.68, 15.02, 1.46, 15.78, 1.39, 16.54,
	1.46, 17.29, 1.68, 17.98, 2.05, 18.61, 2.56, 19.12, 3.19, 19.49, 3.88, 19.71, 4.63, 19.78, 5.39, 19.71, 6.15, 19.49,
	6.9, 19.12, 7.59, 18.61, 8.22, 9.41, 17.41, 9.1, 17.67, 8.75, 17.85, 8.38, 17.96, 7.99, 18.0, 7.61, 17.96, 7.24, 17.85,
	6.89, 17.67, 6.58, 17.41, 6.32, 17.1, 6.14, 16.75, 6.03, 16.38, 5.99, 16.0, 6.03, 15.61, 6.14, 15.24, 6.32, 14.89, 6.58,
	14.58, 15.07, 6.1,
];

function drawPaperclip(ctx: CanvasRenderingContext2D, item: TextItem): void {
	const k = item.point_size / 24;
	const x = item.pos[0],
		top = item.pos[1] + item.point_size * 0.15;
	ctx.save();
	ctx.strokeStyle = rgbaCss(item.rgba);
	ctx.lineWidth = 2 * k;
	ctx.beginPath();
	for (let i = 0; i < PAPERCLIP.length; i += 2) ctx.lineTo(x + PAPERCLIP[i] * k, top + PAPERCLIP[i + 1] * k);
	ctx.stroke();
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
