import type { StrokeItem } from "./types.ts";

// Faithful port of the app's StrokeEngine. Turns raw samples into a smoothed
// centerline plus a per-point half-width (brush-disc radius). The arc-length EMA,
// the logistic pressure curve and the calligraphy / taper / speed shaping are what
// make ink match the app, so this is deliberately not simplified.

const ALPHA = 0.5;
const MIN_TANGENT_LEN = 1e-6;
const MIN_STEP = 1e-9;
const MIN_DIRECTION = 0.1;
const PRESSURE_CURVE_K = 8.0;
const REFERENCE_SPACING = 1.5;
const SMOOTH_LEN = (REFERENCE_SPACING * (1 - ALPHA)) / ALPHA; // 1.5
const HEAD_LEN = 8.0;
const OPEN_LEN = 8.0;
const CLOSE_LEN = 8.0;
const DOT_DIR_Y = 1.5;
const SPEED_LO = 0.0;
const SPEED_HI = 0.6;
const SPEED_WINDOW_MS = 40.0;
const MIN_DT = 1.0;
const TAPER_MIN_LEN = 8.0;
const CAP_HOLD_SAMPLES = 4;
const TAPER_TAIL = 0.01;
const TAPER_CURVE_K = 2 * Math.log((1 - TAPER_TAIL) / TAPER_TAIL);

export interface StrokeGeometry {
	centerline: Float32Array; // interleaved x,y, one point per input sample
	halfWidths: Float32Array; // brush radius per point
	leftRail: Float32Array; // outer edge, interleaved x,y (neon outline; may be empty)
	rightRail: Float32Array;
}

interface BuildConfig {
	baseWidth: number;
	pressureEnabled: boolean;
	m: number; // pressureMinFactor
	ds: number; // directionStrength
	speedStrength: number;
	taperEnabled: boolean;
	taperMinFactor: number;
	speedScale: number;
	smooth: boolean; // false for straight-line strokes
	holdEnds: boolean; // pen + highlighter
	finished: boolean; // always true when loading from a file
	smoothScale: number;
}

// --- math primitives ---

function logisticEase(x: number, k: number): number {
	if (k <= 0) return x;
	const lo = 1 / (1 + Math.exp(k * 0.5));
	const hi = 1 / (1 + Math.exp(-k * 0.5));
	const raw = 1 / (1 + Math.exp(-k * (x - 0.5)));
	return (raw - lo) / (hi - lo);
}

function smoothstep(lo: number, hi: number, x: number): number {
	if (hi <= lo) return x >= hi ? 1 : 0;
	const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
	return t * t * (3 - 2 * t);
}

function halfWidth(
	baseWidth: number,
	pressureEnabled: boolean,
	m: number,
	ds: number,
	pressure: number,
	ty: number,
): number {
	const pEff = pressureEnabled ? logisticEase(pressure, PRESSURE_CURVE_K) : 1;
	const wBase = baseWidth * (m + (1 - m) * pEff);
	const direction = Math.max(1 + ds * ty, MIN_DIRECTION);
	return (wBase * direction) / 2;
}

function emaStep(prevOut: number, prevIn: number, curIn: number, d: number, lambda: number): number {
	if (lambda <= 0) return curIn;
	if (d <= MIN_STEP) return prevOut; // pen did not move
	const decay = Math.exp(-d / lambda);
	const slope = ((curIn - prevIn) * lambda * (1 - decay)) / d;
	return decay * prevOut + curIn - decay * prevIn - slope;
}

function emaByArc(values: Float64Array, steps: Float64Array, lambda: number): Float64Array {
	const n = values.length;
	const out = new Float64Array(n);
	if (n === 0) return out;
	if (lambda <= 0) {
		out.set(values);
		return out;
	}
	out[0] = values[0];
	for (let i = 1; i < n; i++) out[i] = emaStep(out[i - 1], values[i - 1], values[i], steps[i], lambda);
	return out;
}

function holdEndPressure(p: Float64Array): void {
	const n = p.length;
	const w = Math.min(CAP_HOLD_SAMPLES, (n - 1) >> 1);
	if (w < 1) return;
	const headFloor = p[w];
	for (let i = 0; i < w; i++) if (p[i] < headFloor) p[i] = headFloor;
	const tailFloor = p[n - 1 - w];
	for (let i = n - w; i < n; i++) if (p[i] < tailFloor) p[i] = tailFloor;
}

function speedFactorAt(
	times: Float64Array,
	cum: Float64Array,
	n: number,
	i: number,
	cursor: Int32Array,
	speedStrength: number,
	speedScale: number,
): number {
	const t0 = times[0],
		tN = times[n - 1];
	const half = SPEED_WINDOW_MS;
	let a = times[i] - half,
		b = times[i] + half;
	if (a < t0) {
		b += t0 - a;
		a = t0;
	}
	if (b > tN) {
		a -= b - tN;
		b = tN;
		if (a < t0) a = t0;
	}
	let lo = cursor[0],
		hi = cursor[1];
	while (lo < i && times[lo] < a) lo++;
	while (hi < n - 1 && times[hi + 1] <= b) hi++;
	cursor[0] = lo;
	cursor[1] = hi;
	let l = lo,
		h = hi;
	if (h <= l) {
		if (h < n - 1) h++;
		else l--;
	}
	const dist = (cum[h] - cum[l]) * speedScale;
	const dt = Math.max(times[h] - times[l], MIN_DT);
	return 1 - speedStrength * smoothstep(SPEED_LO, SPEED_HI, dist / dt);
}

function speedFactors(
	times: Float64Array,
	steps: Float64Array,
	speedStrength: number,
	speedScale: number,
): Float64Array | null {
	const n = times.length;
	if (speedStrength <= 0 || n < 2) return null;
	const t0 = times[0],
		tN = times[n - 1];
	if (tN - t0 <= 0) return null;
	const cum = new Float64Array(n);
	for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + steps[i];
	const out = new Float64Array(n).fill(1);
	const cursor = new Int32Array(2);
	for (let i = 0; i < n; i++) out[i] = speedFactorAt(times, cum, n, i, cursor, speedStrength, speedScale);
	return out;
}

function taperFactors(cum: Float64Array, taperMinFactor: number, smoothScale: number): Float64Array {
	const n = cum.length;
	const out = new Float64Array(n).fill(1);
	if (n < 2) return out;
	const total = cum[n - 1];
	if (total < TAPER_MIN_LEN * Math.max(smoothScale, 0)) return out;
	for (let i = 0; i < n; i++) {
		const edge = (total - cum[i]) / total;
		out[i] = taperMinFactor + (1 - taperMinFactor) * logisticEase(edge, TAPER_CURVE_K);
	}
	return out;
}

function headDirection(
	sx: Float64Array,
	sy: Float64Array,
	cum: Float64Array,
	headLen: number,
	finished: boolean,
): [number, number] {
	let k = -1;
	for (let i = 0; i < cum.length; i++)
		if (cum[i] >= headLen) {
			k = i;
			break;
		}
	if (k < 0) return [finished ? DOT_DIR_Y : -1, cum.length - 1];
	const dx = sx[k] - sx[0],
		dy = sy[k] - sy[0];
	const len = Math.hypot(dx, dy);
	return [len < MIN_TANGENT_LEN ? -1 : dy / len, k];
}

function nibStep(d: number, target: number, step: number, openLen: number, closeLen: number): number {
	const rate = target > d ? openLen : closeLen;
	const limit = rate > 0 ? (step * 2) / rate : Number.MAX_VALUE;
	const delta = Math.min(limit, Math.max(-limit, target - d));
	return d + delta;
}

function nibDirection(
	ty: Float64Array,
	steps: Float64Array,
	openLen: number,
	closeLen: number,
	seed: number,
	holdUntil: number,
): Float64Array {
	const out = new Float64Array(ty.length);
	let d = seed;
	for (let i = 0; i < ty.length; i++) {
		if (i <= holdUntil) {
			out[i] = seed;
			continue;
		}
		d = nibStep(d, ty[i], i === 0 ? 0 : steps[i], openLen, closeLen);
		out[i] = d;
	}
	return out;
}

function capTail(dir: Float64Array, cum: Float64Array, window: number): void {
	const n = dir.length;
	const start = cum[n - 1] - window;
	let i = 1;
	while (i < n - 1 && cum[i] < start) i++;
	let ceiling = dir[i - 1];
	const span = cum[i] - cum[i - 1];
	if (start > cum[i - 1] && span > MIN_STEP)
		ceiling += ((dir[i] - dir[i - 1]) * (start - cum[i - 1])) / span;
	for (let j = i; j < n; j++) {
		if (dir[j] > ceiling) dir[j] = ceiling;
		else ceiling = dir[j];
	}
}

// --- the build ---

function buildGeometry(samples: number[][], cfg: BuildConfig): StrokeGeometry {
	const n = samples.length;
	const empty = new Float32Array(0);
	if (n === 0) return { centerline: empty, halfWidths: empty, leftRail: empty, rightRail: empty };

	const {
		baseWidth,
		pressureEnabled,
		m,
		ds,
		speedStrength,
		taperEnabled,
		taperMinFactor,
		speedScale,
		smooth,
		holdEnds,
		finished,
		smoothScale,
	} = cfg;

	const rawX = new Float64Array(n),
		rawY = new Float64Array(n),
		rawP = new Float64Array(n);
	let timed = false;
	const rawT = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const s = samples[i];
		rawX[i] = s[0] ?? 0;
		rawY[i] = s[1] ?? 0;
		rawP[i] = s.length > 2 ? (s[2] ?? 1) : 1; // absent pressure = full
		const t = s.length > 3 ? (s[3] ?? 0) : 0;
		rawT[i] = t;
		if (t !== 0) timed = true;
	}

	const steps = new Float64Array(n);
	for (let i = 1; i < n; i++) steps[i] = Math.hypot(rawX[i] - rawX[i - 1], rawY[i] - rawY[i - 1]);
	const smoothLen = SMOOTH_LEN * Math.max(smoothScale, 0);

	const sx = smooth ? emaByArc(rawX, steps, smoothLen) : rawX;
	const sy = smooth ? emaByArc(rawY, steps, smoothLen) : rawY;
	const sp = emaByArc(rawP, steps, smoothLen);
	if (holdEnds && pressureEnabled) holdEndPressure(sp);

	const hw = (i: number, ty: number) => halfWidth(baseWidth, pressureEnabled, m, ds, sp[i], ty);

	if (n === 1) {
		const h = hw(0, finished && ds > 0 ? DOT_DIR_Y : 0);
		return {
			centerline: Float32Array.of(sx[0], sy[0]),
			halfWidths: Float32Array.of(h),
			leftRail: empty,
			rightRail: empty,
		};
	}

	// per-point unit tangent (finite differences)
	let lastTx = 1,
		lastTy = 0;
	const tx = new Float64Array(n),
		ty = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let dx: number, dy: number;
		if (i === 0) {
			dx = sx[1] - sx[0];
			dy = sy[1] - sy[0];
		} else if (i === n - 1) {
			dx = sx[i] - sx[i - 1];
			dy = sy[i] - sy[i - 1];
		} else {
			dx = sx[i + 1] - sx[i - 1];
			dy = sy[i + 1] - sy[i - 1];
		}
		const len = Math.hypot(dx, dy);
		if (len < MIN_TANGENT_LEN) {
			tx[i] = lastTx;
			ty[i] = lastTy;
		} else {
			tx[i] = dx / len;
			ty[i] = dy / len;
			lastTx = tx[i];
			lastTy = ty[i];
		}
	}

	const needArc = ds > 0 || taperEnabled;
	const dirSteps = new Float64Array(needArc ? n : 0);
	const cum = new Float64Array(dirSteps.length);
	if (needArc)
		for (let i = 1; i < n; i++) {
			dirSteps[i] = Math.hypot(sx[i] - sx[i - 1], sy[i] - sy[i - 1]);
			cum[i] = cum[i - 1] + dirSteps[i];
		}

	const sf = speedStrength > 0 && timed ? speedFactors(rawT, steps, speedStrength, speedScale) : null;
	const tf = taperEnabled ? taperFactors(cum, taperMinFactor, smoothScale) : null;

	let dirY: Float64Array | null = null;
	if (ds > 0) {
		const window = HEAD_LEN * Math.max(smoothScale, 0);
		const [head, holdUntil] = headDirection(sx, sy, cum, window, finished);
		dirY = nibDirection(
			ty,
			dirSteps,
			OPEN_LEN * Math.max(smoothScale, 0),
			CLOSE_LEN * Math.max(smoothScale, 0),
			head,
			holdUntil,
		);
		if (finished) capTail(dirY, cum, window);
	}

	const centerline = new Float32Array(2 * n);
	const halfWidths = new Float32Array(n);
	const leftRail = new Float32Array(2 * n);
	const rightRail = new Float32Array(2 * n);
	for (let i = 0; i < n; i++) {
		const dir = dirY ? Math.min(DOT_DIR_Y, Math.max(-1, dirY[i])) : ty[i];
		let h = hw(i, dir);
		if (sf) h *= sf[i];
		if (tf) h *= tf[i];
		halfWidths[i] = h;
		centerline[2 * i] = sx[i];
		centerline[2 * i + 1] = sy[i];
		const nx = -ty[i],
			ny = tx[i];
		leftRail[2 * i] = sx[i] - nx * h;
		leftRail[2 * i + 1] = sy[i] - ny * h;
		rightRail[2 * i] = sx[i] + nx * h;
		rightRail[2 * i + 1] = sy[i] + ny * h;
	}
	return { centerline, halfWidths, leftRail, rightRail };
}

// Adapter: build a stroke's geometry from its parsed config. holdEnds and the
// tool-specific fields are the only per-tool logic.
export function buildStrokeGeometry(stroke: StrokeItem): StrokeGeometry {
	const c = stroke.config;
	const cfg: BuildConfig = {
		baseWidth: c.base_width,
		pressureEnabled: c.pressure_enabled,
		m: c.pressure_min_factor,
		ds: c.direction_strength,
		speedStrength: c.speed_strength ?? (stroke.tool === "speed" ? 0.8 : 0),
		taperEnabled: c.taper_enabled ?? stroke.tool === "taper",
		taperMinFactor: c.taper_min_factor ?? 0.3,
		speedScale: stroke.speed_scale ?? 1,
		smooth: !stroke.straight,
		holdEnds: stroke.tool === "pen" || stroke.tool === "highlighter",
		finished: true, // loaded strokes are always finished
		smoothScale: stroke.smooth_scale || 1,
	};
	return buildGeometry(stroke.samples, cfg);
}
