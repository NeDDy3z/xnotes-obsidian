import { Plugin, PluginSettingTab, Setting, type App } from "obsidian";
import { VIEW_TYPE_XNOTE, XNoteView } from "./view.ts";

interface XNotesSettings {
	// Extra resolution multiplier on top of the device pixel ratio, for crisper strokes.
	renderScale: number;
}

const DEFAULT_SETTINGS: XNotesSettings = {
	renderScale: 1,
};

export default class XNotesPlugin extends Plugin {
	settings: XNotesSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<XNotesSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };

		this.registerView(VIEW_TYPE_XNOTE, (leaf) => new XNoteView(leaf, this));

		// Register each extension separately so a clash on one does not drop the other.
		for (const ext of ["xnote", "xnotes"]) {
			try {
				this.registerExtensions([ext], VIEW_TYPE_XNOTE);
			} catch {
				// Another plugin already claimed this extension; skip it.
			}
		}

		this.addSettingTab(new XNotesSettingTab(this.app, this));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class XNotesSettingTab extends PluginSettingTab {
	private readonly plugin: XNotesPlugin;

	constructor(app: App, plugin: XNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.containerEl.empty();

		new Setting(this.containerEl)
			.setName("Render quality")
			.setDesc("Extra resolution multiplier on top of your display scaling. Higher is crisper but uses more memory. Reopen a note to apply.")
			.addSlider((s) =>
				s
					.setLimits(1, 3, 1)
					.setValue(this.plugin.settings.renderScale)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.renderScale = v;
						await this.plugin.saveSettings();
					}),
			);
	}
}
