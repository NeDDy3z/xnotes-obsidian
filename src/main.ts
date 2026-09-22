import { Plugin, PluginSettingTab, type App, type SettingDefinitionItem } from "obsidian";
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Render quality",
				desc: "Extra resolution multiplier on top of your display scaling. Higher is crisper but uses more memory. Reopen a note to apply.",
				control: {
					type: "slider",
					key: "renderScale",
					min: 1,
					max: 3,
					step: 1,
					defaultValue: DEFAULT_SETTINGS.renderScale,
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key === "renderScale") return this.plugin.settings.renderScale;
		return undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "renderScale") this.plugin.settings.renderScale = Number(value);
		await this.plugin.saveSettings();
	}
}
