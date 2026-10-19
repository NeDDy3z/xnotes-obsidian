import type { Item, Manifest, Page, PageStyle, Point, Rgba } from "./types.ts";

// The .xcanvas manifest (format "xcanvas", version 1): one flat item list on an unbounded plane,
// serialized exactly like an .xnote page's items, plus the background ruling.
export interface CanvasManifest {
	format: "xcanvas";
	version: number;
	writer?: number;
	created?: string;
	dpi?: number;
	background?: {
		pattern?: string;
		pattern_color?: Rgba;
		spacing?: number;
		paper_color?: Rgba; // absent means the theme paper
	};
	items?: Item[];
}

// Blank space kept around the ink, in content px.
const MARGIN = 96;
// The page an empty canvas opens as.
const EMPTY_SIZE: Point = [1200, 800];

type Bounds = [number, number, number, number]; // minX, minY, maxX, maxY

// Lay a canvas out as a single page cropped to its content. The crop origin is snapped to the
// ruling spacing so the grid lines fall where they do in the app.
export function canvasToManifest(canvas: CanvasManifest): Manifest {
	const bg = canvas.background ?? {};
	const style: PageStyle = {
		pattern: bg.pattern ?? "grid",
		pattern_color: bg.pattern_color,
		spacing: bg.spacing,
		page_color: bg.paper_color,
	};
	const items = Array.isArray(canvas.items) ? canvas.items : [];
	const b = contentBounds(items);

	let page: Page;
	if (!b) {
		page = { width: EMPTY_SIZE[0], height: EMPTY_SIZE[1], pdf_page: null, items: [] };
	} else {
		const snap = Math.min(200, Math.max(16, bg.spacing ?? 64));
		const ox = Math.floor((b[0] - MARGIN) / snap) * snap;
		const oy = Math.floor((b[1] - MARGIN) / snap) * snap;
		page = {
			width: Math.ceil(b[2] + MARGIN - ox),
			height: Math.ceil(b[3] + MARGIN - oy),
			pdf_page: null,
			items: items.map((it) => translateItem(it, -ox, -oy)),
		};
	}

	return {
		format: canvas.format,
		version: canvas.version,
		writer: canvas.writer,
		created: canvas.created,
		dpi: canvas.dpi,
		style,
		pages: [page],
	};
}

function contentBounds(items: Item[]): Bounds | null {
	let b: Bounds | null = null;
	const add = (x: number, y: number, pad: number) => {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return;
		if (!b) b = [x - pad, y - pad, x + pad, y + pad];
		else {
			b[0] = Math.min(b[0], x - pad);
			b[1] = Math.min(b[1], y - pad);
			b[2] = Math.max(b[2], x + pad);
			b[3] = Math.max(b[3], y + pad);
		}
	};
	for (const it of items) {
		switch (it.kind) {
			case "stroke":
				for (const s of it.samples ?? []) add(s[0], s[1], it.config?.base_width ?? 0);
				break;
			case "shape":
				add(it.start[0], it.start[1], it.stroke_width);
				add(it.end[0], it.end[1], it.stroke_width);
				for (const p of it.points ?? []) if (p.length >= 2) add(p[0], p[1], it.stroke_width);
				break;
			case "image": {
				// Rotation keeps the image inside the circle through its corners.
				const [x, y, w, h] = it.rect;
				const r = it.angle ? Math.hypot(w, h) / 2 : 0;
				add(x + w / 2 - (r || w / 2), y + h / 2 - (r || h / 2), 0);
				add(x + w / 2 + (r || w / 2), y + h / 2 + (r || h / 2), 0);
				break;
			}
			case "table": {
				const [x, y, w, h] = it.rect;
				add(x, y, it.stroke_width);
				add(x + w, y + h, it.stroke_width);
				break;
			}
			case "text":
				add(it.pos[0], it.pos[1], 0);
				add(it.pos[0] + it.width, it.pos[1] + (it.height ?? it.point_size), 0);
				break;
		}
	}
	return b;
}

function translateItem(it: Item, dx: number, dy: number): Item {
	const pt = (p: Point): Point => [p[0] + dx, p[1] + dy];
	switch (it.kind) {
		case "stroke":
			return { ...it, samples: it.samples.map((s) => [s[0] + dx, s[1] + dy, ...s.slice(2)]) };
		case "shape":
			return {
				...it,
				start: pt(it.start),
				end: pt(it.end),
				// An empty point is a run break and stays empty.
				points: it.points?.map((p) => (p.length >= 2 ? [p[0] + dx, p[1] + dy, ...p.slice(2)] : p)),
			};
		case "image":
		case "table":
			return { ...it, rect: [it.rect[0] + dx, it.rect[1] + dy, it.rect[2], it.rect[3]] };
		case "text":
			return { ...it, pos: pt(it.pos) };
		default:
			// Kinds the renderer skips (glyphs, newer ones) pass through untouched.
			return it;
	}
}
