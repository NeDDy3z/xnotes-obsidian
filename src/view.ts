import { finishRenderMath, FileView, loadPdfJs, Notice, WorkspaceLeaf, type TFile } from "obsidian";
import { flowMath, isEmptyFlow } from "./flow.ts";
import { layoutFlow, type PageFlow } from "./flowLayout.ts";
import { MathSetter, rasterizeMathLayer } from "./math.ts";
import { parseXNote } from "./parser.ts";
import { buildPdf, PDF_PRODUCER, rgbaToRgb, type PdfPage } from "./pdf.ts";
import { renderPage, type PdfSource } from "./renderer.ts";
import { TextMeasurer } from "./text.ts";
import type { Page, XNoteDocument } from "./types.ts";
import type XNotesPlugin from "./main.ts";

export const VIEW_TYPE_XNOTE = "xnote-view";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;
const SOURCE_PDF = "assets/source.pdf";
const DEFAULT_DPI = 150;
// Backing-store limits every platform honours (iOS caps a canvas at 16.7M pixels); a large
// .xcanvas renders at a lower resolution rather than blank.
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 16_777_216;
// Resolution of an exported PDF page.
const EXPORT_DPI = 300;

interface PdfDocument extends PdfSource {
	destroy(): Promise<void>;
}

interface PdfJs {
	getDocument(params: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

export class XNoteView extends FileView {
	private readonly plugin: XNotesPlugin;
	private doc: XNoteDocument | null = null;
	private assetUrls = new Map<string, string>();
	private pdf: PdfDocument | null = null;
	private readonly math = new MathSetter();
	private flowPages: PageFlow[] | null = null;
	private pagesEl!: HTMLElement;
	private zoomLabel!: HTMLElement;
	private zoom = 1;
	private fit = true;
	// Bumped on every load and unload, so a render still running for an older file stops.
	private loadToken = 0;
	// Settles once the current file is drawn.
	private rendered: Promise<void> = Promise.resolve();
	private exporting = false;

	constructor(leaf: WorkspaceLeaf, plugin: XNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_XNOTE;
	}

	getIcon(): string {
		return "pen-tool";
	}

	getDisplayText(): string {
		return this.file?.basename ?? "xNote";
	}

	protected async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("xnote-view");

		const bar = this.contentEl.createDiv({ cls: "xnote-toolbar" });
		const mkBtn = (label: string, title: string, onClick: () => void) => {
			const b = bar.createEl("button", { text: label, cls: "xnote-btn" });
			b.setAttribute("aria-label", title);
			b.onclick = onClick;
			return b;
		};
		mkBtn("Fit", "Fit page width", () => {
			this.fit = true;
			this.applyZoom();
		});
		mkBtn("-", "Zoom out", () => this.setZoom(this.zoom / ZOOM_STEP));
		this.zoomLabel = bar.createSpan({ cls: "xnote-zoom-label", text: "100%" });
		mkBtn("+", "Zoom in", () => this.setZoom(this.zoom * ZOOM_STEP));
		mkBtn("PDF", "Export as PDF next to this file", () => void this.exportPdf());

		this.pagesEl = this.contentEl.createDiv({ cls: "xnote-pages" });

		this.registerDomEvent(window, "resize", () => {
			if (this.fit) this.applyZoom();
		});
		this.setupGestures();
	}

	// Pinch-to-zoom: trackpad pinch / ctrl+wheel on desktop, two-finger pinch on touch.
	private setupGestures(): void {
		this.registerDomEvent(
			this.pagesEl,
			"wheel",
			(e: WheelEvent) => {
				if (!e.ctrlKey) return; // plain wheel scrolls; pinch/ctrl zooms
				e.preventDefault();
				this.zoomAt(this.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
			},
			{ passive: false },
		);

		let startDist = 0;
		let startZoom = 1;
		const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
		const mid = (t: TouchList): [number, number] => [
			(t[0].clientX + t[1].clientX) / 2,
			(t[0].clientY + t[1].clientY) / 2,
		];

		this.registerDomEvent(this.pagesEl, "touchstart", (e: TouchEvent) => {
			if (e.touches.length === 2) {
				startDist = dist(e.touches);
				startZoom = this.zoom;
			}
		});
		this.registerDomEvent(
			this.pagesEl,
			"touchmove",
			(e: TouchEvent) => {
				if (e.touches.length !== 2 || startDist === 0) return;
				e.preventDefault();
				const [mx, my] = mid(e.touches);
				this.zoomAt((startZoom * dist(e.touches)) / startDist, mx, my);
			},
			{ passive: false },
		);
		this.registerDomEvent(this.pagesEl, "touchend", (e: TouchEvent) => {
			if (e.touches.length < 2) startDist = 0;
		});
	}

	// Zoom to `z` while keeping the content point under (clientX, clientY) fixed.
	private zoomAt(z: number, clientX: number, clientY: number): void {
		const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
		const rect = this.pagesEl.getBoundingClientRect();
		const offX = clientX - rect.left;
		const offY = clientY - rect.top;
		const contentX = this.pagesEl.scrollLeft + offX;
		const contentY = this.pagesEl.scrollTop + offY;
		const ratio = target / this.zoom;

		this.fit = false;
		this.zoom = target;
		this.applyZoom();

		this.pagesEl.scrollLeft = contentX * ratio - offX;
		this.pagesEl.scrollTop = contentY * ratio - offY;
	}

	async onLoadFile(file: TFile): Promise<void> {
		const token = ++this.loadToken;
		this.revokeAssets();
		this.pagesEl.empty();
		this.doc = null;
		this.flowPages = null;

		let data: ArrayBuffer;
		try {
			data = await this.app.vault.readBinary(file);
		} catch (e) {
			this.showError(`Could not read file: ${(e as Error).message}`);
			return;
		}
		if (token !== this.loadToken) return;

		try {
			this.doc = parseXNote(data);
		} catch (e) {
			this.showError((e as Error).message);
			return;
		}

		for (const [name, blob] of this.doc.assets) {
			this.assetUrls.set(name, URL.createObjectURL(blob));
		}

		// Drawn without holding up the load: the leaf ignores every file opened while a load is pending.
		this.pagesEl.createDiv({ cls: "xnote-loading", text: "Loading…" });
		this.rendered = this.renderDocument(token).catch((e: unknown) => {
			if (token === this.loadToken) this.showError((e as Error).message);
		});
	}

	private async renderDocument(token: number): Promise<void> {
		const pdfBlob = this.doc?.assets.get(SOURCE_PDF);
		if (this.doc?.manifest.has_pdf && pdfBlob) {
			try {
				const pdfjs = (await loadPdfJs()) as PdfJs;
				const pdf = await pdfjs.getDocument({ data: new Uint8Array(await pdfBlob.arrayBuffer()) }).promise;
				if (token !== this.loadToken) {
					void pdf.destroy();
					return;
				}
				this.pdf = pdf;
			} catch (e) {
				new Notice(`xNote: could not load the source PDF: ${(e as Error).message}`);
			}
		}

		await this.layoutText();
		if (token !== this.loadToken) return;
		await this.renderAll(token);
	}

	// Typeset every formula, then lay the flowing text across the pages against those sizes.
	private async layoutText(): Promise<void> {
		this.flowPages = null;
		if (!this.doc) return;
		const { manifest, flow } = this.doc;
		const formulas = flow ? flowMath(flow) : [];
		for (const page of manifest.pages) {
			for (const item of page.items) {
				if (item.kind === "text" && item.math && item.text) formulas.push({ latex: item.text, display: true });
			}
		}
		if (formulas.length > 0) {
			try {
				await this.math.prepare(formulas, this.contentEl.doc);
			} catch (e) {
				new Notice(`xNote: could not typeset maths: ${(e as Error).message}`);
			}
		}
		if (flow && !isEmptyFlow(flow)) {
			this.flowPages = layoutFlow(flow, manifest.pages, manifest.dpi ?? DEFAULT_DPI, new TextMeasurer(), this.math);
		}
	}

	async onUnloadFile(): Promise<void> {
		this.loadToken++;
		this.revokeAssets();
		this.pagesEl.empty();
		this.doc = null;
	}

	protected async onClose(): Promise<void> {
		this.revokeAssets();
	}

	private async renderAll(token: number): Promise<void> {
		if (!this.doc) return;
		this.pagesEl.empty();
		const { manifest } = this.doc;

		this.fit = true;
		const scale = this.effectiveScale();
		let mounted = 0;

		for (let i = 0; i < manifest.pages.length; i++) {
			if (token !== this.loadToken) return;
			const page = manifest.pages[i];
			const wrap = this.pagesEl.createDiv({ cls: "xnote-page" });
			const canvas = wrap.createEl("canvas");
			canvas.dataset.baseWidth = String(page.width);
			canvas.dataset.baseHeight = String(page.height);
			const layer = wrap.createDiv({ cls: "xnote-math-layer" });
			layer.setCssStyles({ width: `${page.width}px`, height: `${page.height}px` });
			try {
				const formulas = await renderPage(
					canvas,
					page,
					manifest.style,
					this.assetUrls,
					capScale(page, scale),
					this.pdf,
					this.pageText(i),
					this.math,
				);
				if (token !== this.loadToken) return;
				for (const f of formulas) this.math.mount(layer, f);
				mounted += formulas.length;
			} catch (e) {
				wrap.setText(`Failed to render page ${i + 1}: ${(e as Error).message}`);
			}
		}
		// Only with MathJax loaded: without it Obsidian's finishRenderMath throws in a timer and
		// its promise never settles, for this call and every later one.
		if (mounted > 0 && this.math.ready()) await finishRenderMath();
		if (token !== this.loadToken) return;
		this.applyZoom();
	}

	private pageText(i: number) {
		const flowPage = this.flowPages?.[i];
		return this.doc?.flow && flowPage ? { flow: this.doc.flow, page: flowPage } : null;
	}

	// Write every page as a PDF beside the note, e.g. Lecture.xnote -> Lecture.pdf. A PDF of that
	// name that this plugin did not export is never overwritten; the next free name is taken instead.
	private async exportPdf(): Promise<void> {
		const file = this.file;
		if (!file || this.exporting) return;
		this.exporting = true;
		const token = this.loadToken;
		const progress = new Notice("xNote: exporting PDF…", 0);
		try {
			await this.rendered;
			if (token !== this.loadToken || !this.doc) return;
			const { manifest } = this.doc;
			const dpi = manifest.dpi ?? DEFAULT_DPI;
			const wraps = this.pagesEl.querySelectorAll(".xnote-page");
			const pages: PdfPage[] = [];
			let mathDropped = false;
			for (let i = 0; i < manifest.pages.length; i++) {
				const page = manifest.pages[i];
				let rgba: Uint8ClampedArray;
				let canvas = await this.exportCanvas(i, dpi, wraps[i]?.querySelector<HTMLElement>(".xnote-math-layer") ?? null);
				try {
					rgba = canvasPixels(canvas);
				} catch {
					// Drawing the formulas tainted the canvas on this platform: export the page without them.
					mathDropped = true;
					canvas = await this.exportCanvas(i, dpi, null);
					rgba = canvasPixels(canvas);
				}
				if (token !== this.loadToken) return;
				pages.push({
					width: (page.width * 72) / dpi,
					height: (page.height * 72) / dpi,
					pixelsWide: canvas.width,
					pixelsHigh: canvas.height,
					rgb: rgbaToRgb(rgba),
				});
			}
			const bytes = buildPdf(pages);
			const path = await this.writePdf(file, bytes);
			new Notice(`xNote: exported ${path}${mathDropped ? " (formulas could not be included)" : ""}`);
		} catch (e) {
			new Notice(`xNote: PDF export failed: ${(e as Error).message}`);
		} finally {
			progress.hide();
			this.exporting = false;
		}
	}

	// One page drawn at export resolution, with the formulas mounted on screen laid over it.
	private async exportCanvas(i: number, dpi: number, layer: HTMLElement | null): Promise<HTMLCanvasElement> {
		if (!this.doc) throw new Error("No document loaded.");
		const page = this.doc.manifest.pages[i];
		const canvas = createEl("canvas");
		await renderPage(
			canvas,
			page,
			this.doc.manifest.style,
			this.assetUrls,
			capScale(page, EXPORT_DPI / dpi),
			this.pdf,
			this.pageText(i),
			this.math,
		);
		const math = layer ? await rasterizeMathLayer(layer, page.width, page.height) : null;
		const ctx = canvas.getContext("2d");
		if (math && ctx) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.drawImage(math, 0, 0, canvas.width, canvas.height);
		}
		return canvas;
	}

	private async writePdf(file: TFile, bytes: Uint8Array): Promise<string> {
		const stem = file.path.slice(0, file.path.length - file.extension.length - 1);
		const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		for (let n = 0; ; n++) {
			const path = n === 0 ? `${stem}.pdf` : `${stem} ${n}.pdf`;
			const existing = this.app.vault.getFileByPath(path);
			if (!existing) {
				await this.app.vault.createBinary(path, data);
				return path;
			}
			if (isOwnExport(await this.app.vault.readBinary(existing))) {
				await this.app.vault.modifyBinary(existing, data);
				return path;
			}
		}
	}

	private effectiveScale(): number {
		const dpr = window.devicePixelRatio || 1;
		return dpr * Math.max(1, this.plugin.settings.renderScale);
	}

	private setZoom(z: number): void {
		this.fit = false;
		this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
		this.applyZoom();
	}

	// Zoom is applied purely via CSS width so re-rendering is not needed on zoom.
	private applyZoom(): void {
		if (this.fit) {
			const first = this.pagesEl.querySelector("canvas");
			const avail = this.pagesEl.clientWidth - 24;
			if (first && avail > 0) {
				const base = Number(first.dataset.baseWidth) || first.width;
				this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / base));
			}
		}
		this.pagesEl.querySelectorAll("canvas").forEach((canvas) => {
			const base = Number(canvas.dataset.baseWidth) || canvas.width;
			canvas.setCssStyles({ width: `${base * this.zoom}px`, height: "auto" });
		});
		this.pagesEl.querySelectorAll<HTMLElement>(".xnote-math-layer").forEach((layer) => {
			layer.setCssStyles({ transform: `scale(${this.zoom})` });
		});
		this.zoomLabel.setText(`${Math.round(this.zoom * 100)}%`);
	}

	private showError(msg: string): void {
		this.pagesEl.empty();
		this.pagesEl.createDiv({ cls: "xnote-error", text: msg });
		new Notice(`xNote: ${msg}`);
	}

	private revokeAssets(): void {
		for (const url of this.assetUrls.values()) URL.revokeObjectURL(url);
		this.assetUrls.clear();
		void this.pdf?.destroy();
		this.pdf = null;
	}
}

// Shrink `scale` until the page's backing store fits every platform's canvas limits.
function capScale(page: Page, scale: number): number {
	return Math.min(
		scale,
		MAX_CANVAS_SIDE / Math.max(page.width, page.height),
		Math.sqrt(MAX_CANVAS_AREA / (page.width * page.height)),
	);
}

function canvasPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2D canvas context unavailable");
	return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

// Whether a PDF was written by this plugin's export, which names itself in the Info dictionary.
function isOwnExport(data: ArrayBuffer): boolean {
	const head = new Uint8Array(data, 0, Math.min(data.byteLength, 1024));
	return new TextDecoder("latin1").decode(head).includes(`/Producer (${PDF_PRODUCER})`);
}
