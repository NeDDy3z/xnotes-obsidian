# xNotes Viewer for Obsidian

Read-only viewer for `.xnote` handwritten notes from the [xnotes Android app](https://github.com/shardulvs/xnotes-android).

`.xnote` files are ZIPs with a `manifest.json` of vector pages (strokes, shapes, tables, text, images) plus an `assets/` folder. The plugin registers a viewer for the `.xnote` extension and renders each page to a canvas, with fit-to-width and zoom.

## Install (manual)

1. `npm install && npm run build`
2. Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/xnotes-viewer/`.
3. Enable "xNotes Viewer" in community plugin settings.

## Development

- `npm run dev` - build and watch.
- `npm run build` - type-check and build a minified `main.js`.

## License

Apache-2.0
