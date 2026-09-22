// Types mirroring the xnote manifest.json schema (format "xnote", version 1).

export type Rgba = [number, number, number, number];
export type Point = [number, number];

export interface StrokeConfig {
	base_width: number;
	pressure_enabled: boolean;
	pressure_min_factor: number;
	direction_strength: number;
	rgba: Rgba;
	speed_strength?: number;
	taper_enabled?: boolean;
	taper_min_factor?: number;
	neon?: boolean;
	neon_strength?: number;
	dash_length?: number;
	dash_gap?: number;
	highlighter_alpha?: number;
	highlighter_inverse?: boolean;
}

export interface StrokeItem {
	kind: "stroke";
	tool: string; // "pen", "dashed", "calligraphy", "speed", "taper", "highlighter"
	config: StrokeConfig;
	samples: number[][]; // [x, y, p] or [x, y, p, t]
	smooth_scale?: number;
	straight?: boolean;
	speed_scale?: number;
}

export interface ShapeItem {
	kind: "shape";
	shape: string; // "line", "arrow", "rectangle", "ellipse", "triangle", "polygon", "axes", ...
	start: Point;
	end: Point;
	stroke_rgba: Rgba | null;
	stroke_width: number;
	fill_rgba: Rgba | null;
	points?: number[][]; // absolute px vertices for polygon / polyline / curve
	neon?: boolean;
	neon_strength?: number;
	dashed?: boolean;
	dash_length?: number;
	dash_gap?: number;
}

export interface ImageItem {
	kind: "image";
	asset: string; // path inside the zip, e.g. "assets/image-000.png"
	rect: [number, number, number, number]; // x, y, w, h
	src_w: number;
	src_h: number;
	angle: number; // radians, clockwise, about the rect center
	orientation?: number; // extra quarter-turn in degrees (0/90/180/270)
}

export interface TableItem {
	kind: "table";
	rect: [number, number, number, number]; // x, y, w, h
	cols: number[]; // fractions of width, sum ~= 1
	rows: number[]; // fractions of height, sum ~= 1
	stroke_rgba: Rgba | null;
	stroke_width: number;
}

export type TextAlign = "left" | "center" | "right";

export interface TextItem {
	kind: "text";
	pos: Point; // top-left
	width: number; // word-wrap box width
	text: string;
	rgba: Rgba;
	point_size: number;
	height?: number;
	font_face?: string; // "mono" (default) | "sans" | "serif" | "hand"
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	align?: TextAlign;
}

export type Item = StrokeItem | ShapeItem | ImageItem | TableItem | TextItem;

export interface Page {
	width: number;
	height: number;
	pdf_page: number | null;
	items: Item[];
	style?: PageStyle; // per-page override of the document style
}

export interface PageStyle {
	page_color: Rgba;
	pattern: string; // "grid", "lines", "dots", "none", ...
	spacing: number;
	pattern_color?: Rgba; // defaults to grey 25% (150,150,150,64)
}

export interface Manifest {
	format: string;
	version: number;
	writer?: number;
	created?: string;
	dpi?: number;
	has_pdf?: boolean;
	bookmarks?: unknown[];
	style?: PageStyle;
	pages: Page[];
}

// Parsed document: manifest plus decoded image assets keyed by their in-zip path.
export interface XNoteDocument {
	manifest: Manifest;
	assets: Map<string, Blob>;
}
