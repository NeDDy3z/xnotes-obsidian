import { FileView, Notice, WorkspaceLeaf, type TFile } from "obsidian";
import { parseXNote } from "./parser.ts";
import { renderPage } from "./renderer.ts";
import type { XNoteDocument } from "./types.ts";
import type XNotesPlugin from "./main.ts";

export const VIEW_TYPE_XNOTE = "xnote-view";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 1.25;

export class XNoteView extends FileView {
	private readonly plugin: XNotesPlugin;
	private doc: XNoteDocument | null = null;
	private assetUrls = new Map<string, string>();
	private pagesEl!: HTMLElement;
	private zoomLabel!: HTMLElement;
	private zoom = 1;
	private fit = true;

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
		this.revokeAssets();
		this.pagesEl.empty();
		this.doc = null;

		let data: ArrayBuffer;
		try {
			data = await this.app.vault.readBinary(file);
		} catch (e) {
			this.showError(`Could not read file: ${(e as Error).message}`);
			return;
		}

		try {
			this.doc = parseXNote(data);
		} catch (e) {
			this.showError((e as Error).message);
			return;
		}

		for (const [name, blob] of this.doc.assets) {
			this.assetUrls.set(name, URL.createObjectURL(blob));
		}

		await this.renderAll();
	}

	async onUnloadFile(): Promise<void> {
		this.revokeAssets();
		this.pagesEl.empty();
		this.doc = null;
	}

	protected async onClose(): Promise<void> {
		this.revokeAssets();
	}

	private async renderAll(): Promise<void> {
		if (!this.doc) return;
		this.pagesEl.empty();
		const { manifest } = this.doc;

		this.fit = true;
		const scale = this.effectiveScale();

		for (let i = 0; i < manifest.pages.length; i++) {
			const page = manifest.pages[i];
			const wrap = this.pagesEl.createDiv({ cls: "xnote-page" });
			const canvas = wrap.createEl("canvas");
			canvas.dataset.baseWidth = String(page.width);
			canvas.dataset.baseHeight = String(page.height);
			try {
				await renderPage(canvas, page, manifest.style, this.assetUrls, scale);
			} catch (e) {
				wrap.setText(`Failed to render page ${i + 1}: ${(e as Error).message}`);
			}
		}
		this.applyZoom();
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
			const first = this.pagesEl.querySelector("canvas") as HTMLCanvasElement | null;
			const avail = this.pagesEl.clientWidth - 24;
			if (first && avail > 0) {
				const base = Number(first.dataset.baseWidth) || first.width;
				this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, avail / base));
			}
		}
		const canvases = this.pagesEl.querySelectorAll("canvas");
		canvases.forEach((c) => {
			const canvas = c as HTMLCanvasElement;
			const base = Number(canvas.dataset.baseWidth) || canvas.width;
			canvas.style.width = `${base * this.zoom}px`;
			canvas.style.height = "auto";
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
	}
}
