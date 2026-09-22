# xNotes Viewer for Obsidian

Read `.xnote` handwritten notes from the [xnotes Android app](https://github.com/shardulvs/xnotes-android) inside your vault, on desktop and mobile. Read-only: it opens and renders, it never writes.

An `.xnote` is a ZIP holding a `manifest.json` of vector pages (strokes, shapes, tables, text, images) and an `assets/` folder. The plugin registers a viewer for the extension and draws each page to a canvas, with fit-to-width and pinch-to-zoom.

## Install

Settings, Community plugins, Browse, search for "xNotes Viewer", install and enable. By hand: download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/xnotes-viewer/`, then reload and enable.

## Development

`npm install`, then `npm run dev` to watch or `npm run build` to type-check and produce a minified `main.js`. Source: `parser.ts` unzips and reads the manifest, `strokeEngine.ts` and `renderer.ts` draw pages, `view.ts` is the Obsidian file view.

Releases are cut by pushing a tag that matches the version in `manifest.json`. GitHub Actions builds, signs with a build provenance attestation and publishes, so anyone can verify the shipped bundle:

```
gh attestation verify main.js -R NeDDy3z/xnotes-obsidian
```

Requires Obsidian 1.13.0 or later (declarative settings API).

## License

Apache-2.0. The built `main.js` bundles [fflate](https://github.com/101arrowz/fflate) (MIT) for unzipping.
