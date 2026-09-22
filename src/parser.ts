import { unzipSync } from "fflate";
import type { Manifest, XNoteDocument } from "./types.ts";

const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

function mimeFor(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_MIME[ext] ?? "application/octet-stream";
}

// Parse a raw .xnote (ZIP) file into its manifest and decoded image assets.
export function parseXNote(data: ArrayBuffer): XNoteDocument {
	const files = unzipSync(new Uint8Array(data));

	const manifestBytes = files["manifest.json"];
	if (!manifestBytes) {
		throw new Error("Not a valid .xnote file: manifest.json is missing.");
	}

	let manifest: Manifest;
	try {
		manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
	} catch (e) {
		throw new Error(`Could not parse manifest.json: ${(e as Error).message}`);
	}

	if (!Array.isArray(manifest.pages)) {
		throw new Error("Not a valid .xnote file: manifest has no pages array.");
	}

	const assets = new Map<string, Blob>();
	for (const [name, bytes] of Object.entries(files)) {
		if (name === "manifest.json" || name.endsWith("/")) continue;
		// Copy into a fresh buffer so the Blob owns its bytes independently.
		assets.set(name, new Blob([bytes.slice()], { type: mimeFor(name) }));
	}

	return { manifest, assets };
}
