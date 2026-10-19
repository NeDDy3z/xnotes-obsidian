import { zlibSync } from "fflate";

// Written into every exported PDF, so a later export knows which files it may overwrite.
export const PDF_PRODUCER = "xNotes Viewer";

// One page: its size in PDF points and its raster as opaque RGB.
export interface PdfPage {
	width: number;
	height: number;
	pixelsWide: number;
	pixelsHigh: number;
	rgb: Uint8Array;
}

// Flatten an RGBA raster onto white, as the PDF image carries no alpha.
export function rgbaToRgb(rgba: Uint8ClampedArray): Uint8Array {
	const rgb = new Uint8Array((rgba.length / 4) * 3);
	for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
		const a = rgba[i + 3] / 255;
		rgb[j] = rgba[i] * a + 255 * (1 - a);
		rgb[j + 1] = rgba[i + 1] * a + 255 * (1 - a);
		rgb[j + 2] = rgba[i + 2] * a + 255 * (1 - a);
	}
	return rgb;
}

// A minimal PDF 1.4: one full-bleed, Flate-compressed image per page.
export function buildPdf(pages: PdfPage[]): Uint8Array {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const push = (b: Uint8Array) => {
		chunks.push(b);
		length += b.length;
	};
	const text = (s: string) => push(enc.encode(s));
	const object = (id: number, body: string, stream?: Uint8Array) => {
		offsets[id] = length;
		if (stream) {
			text(`${id} 0 obj\n<< ${body} /Length ${stream.length} >>\nstream\n`);
			push(stream);
			text("\nendstream\nendobj\n");
		} else {
			text(`${id} 0 obj\n${body}\nendobj\n`);
		}
	};
	const num = (n: number) => String(Math.round(n * 100) / 100);

	// 1 catalog, 2 info (near the head, where the export check reads it), 3 page tree, then page,
	// contents and image per page.
	const pageId = (i: number) => 4 + i * 3;
	text("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
	object(1, "<< /Type /Catalog /Pages 3 0 R >>");
	object(2, `<< /Producer (${PDF_PRODUCER}) >>`);
	const kids = pages.map((_, i) => `${pageId(i)} 0 R`).join(" ");
	object(3, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	pages.forEach((p, i) => {
		const id = pageId(i);
		const w = num(p.width);
		const h = num(p.height);
		object(
			id,
			`<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${id + 1} 0 R /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> >>`,
		);
		object(id + 1, "", enc.encode(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`));
		object(
			id + 2,
			`/Type /XObject /Subtype /Image /Width ${p.pixelsWide} /Height ${p.pixelsHigh} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
			zlibSync(p.rgb, { level: 6 }),
		);
	});

	const xref = length;
	const count = pageId(pages.length);
	let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
	for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
	text(`${table}trailer\n<< /Size ${count} /Root 1 0 R /Info 2 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

	const out = new Uint8Array(length);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}
