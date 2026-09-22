import esbuild from "esbuild";

function bundleOptions({ minify = false, sourcemap = false } = {}) {
	return {
		entryPoints: ["src/main.ts"],
		bundle: true,
		outfile: "main.js",
		format: "cjs",
		target: "es2020",
		platform: "browser",
		mainFields: ["browser", "module", "main"],
		conditions: ["browser", "import", "default"],
		external: ["obsidian", "electron"],
		minify,
		sourcemap,
		logLevel: "info",
	};
}

const prod = process.argv[2] === "production";
const ctx = await esbuild.context(bundleOptions({ minify: prod, sourcemap: prod ? false : "inline" }));
if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
	console.log("built main.js");
} else {
	await ctx.watch();
	console.log("watching");
}
