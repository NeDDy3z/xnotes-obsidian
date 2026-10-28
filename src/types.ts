import type { TextFlow } from "./flow.ts";

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
	shape: string; // "line", "arrow", "rectangle", "ellipse", "triangle", "polygon", "axes", "numberline", "spline", "function", ...
	start: Point;
	end: Point;
	stroke_rgba: Rgba | null;
	stroke_width: number;
	fill_rgba: Rgba | null;
	points?: number[][]; // absolute px vertices for polygon / polyline / curve / function (an empty point breaks the run), control points for spline
	neon?: boolean;
	neon_strength?: number;
	dashed?: boolean;
	dash_length?: number;
	dash_gap?: number;
	angle?: number; // radians, clockwise, about the box center; axes only
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
	math?: boolean; // text is LaTeX, drawn as a formula
}

// A dropped colour's area: an SVG path in the unit box, stretched over rect.
export interface FillItem {
	kind: "fill";
	rect: [number, number, number, number]; // x, y, w, h
	path?: string;
	fill_rgba: Rgba | null;
	flip?: string; // "x", "y" or "xy", mirrored in the box
	angle?: number; // radians, clockwise, about the box center
}

export type Item = StrokeItem | ShapeItem | ImageItem | TableItem | TextItem | FillItem;

export interface Page {
	width: number;
	height: number;
	pdf_page: number | null;
	pdf_turn?: number; // clockwise quarter turns of the PDF page
	items: Item[];
	style?: PageStyle; // per-field override; missing fields inherit from the document style
}

export interface PageStyle {
	page_color?: Rgba;
	pattern?: string; // "grid", "lines", "dots", "none"
	template?: string; // any other template, which only the app draws
	spacing?: number;
	pattern_color?: Rgba; // defaults to grey 50% (150,150,150,128)
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

// Parsed document: manifest, decoded image assets keyed by their in-zip path, and the flowing text.
export interface XNoteDocument {
	manifest: Manifest;
	assets: Map<string, Blob>;
	flow: TextFlow | null;
}
