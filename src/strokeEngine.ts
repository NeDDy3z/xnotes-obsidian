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
const NIB_RATE_WIDTH = 6.0;
const REVERSAL_FROM_DEG = 120.0;
const REVERSAL_FULL_DEG = 160.0;
const REVERSAL_WAIT = 0.5;
const REVERSAL_MIN_WAIT = 3.0;
const REVERSAL_FROM_COS = Math.cos((REVERSAL_FROM_DEG * Math.PI) / 180);
const DOT_DIR_Y = 1.5;
const SPEED_HI = 0.6;
const SPEED_WINDOW_MS = 25.0;
const SPEED_FLOOR = 0.1;
const DEFAULT_SPEED_SMOOTHING = 0.25;
const SPEED_BLUR_REACH = 3.0;
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
	speedTop: number;
	speedSmoothing: number; // in pen widths
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

// Raw travel per moving ms in a window around each sample, as a width factor, blurred along `path`.
function speedFactorsOver(
	times: Float64Array,
	steps: Float64Array,
	path: Float64Array,
	strength: number,
	top: number,
	sigma: number,
	speedScale: number,
): Float64Array {
	const n = steps.length;
	const out = new Float64Array(n).fill(1);
	if (strength <= 0 || n < 2) return out;
	// A step crossed slower than the floor counts as the pen holding still.
	const floor = speedScale > 0 ? (SPEED_FLOOR * top) / speedScale : 0;
	const tau = new Float64Array(n);
	const cum = new Float64Array(n);
	for (let i = 1; i < n; i++) {
		const dt = Math.max(times[i] - times[i - 1], 0);
		tau[i] = tau[i - 1] + (floor > 0 ? Math.min(dt, steps[i] / floor) : dt);
		cum[i] = cum[i - 1] + steps[i];
	}
	const f = new Float64Array(n);
	const window = new Int32Array(2);
	for (let i = 0; i < n; i++) {
		const v = windowSpeed(tau, cum, n, i, window);
		f[i] = 1 - strength * smoothstep(0, top, v * speedScale);
	}
	const blur = new Int32Array(1);
	for (let i = 0; i < n; i++) out[i] = blurAt(f, path, n, i, sigma, blur);
	return out;
}

function windowSpeed(tau: Float64Array, cum: Float64Array, n: number, i: number, cursor: Int32Array): number {
	const total = tau[n - 1];
	if (total <= 0) return 0;
	let a = tau[i] - SPEED_WINDOW_MS;
	let b = tau[i] + SPEED_WINDOW_MS;
	if (a < 0) {
		b -= a;
		a = 0;
	}
	if (b > total) {
		a = Math.max(a - (b - total), 0);
		b = total;
	}
	if (b <= a) return 0;
	return (arcAt(tau, cum, n, b, cursor, 1) - arcAt(tau, cum, n, a, cursor, 0)) / (b - a);
}

function arcAt(tau: Float64Array, cum: Float64Array, n: number, x: number, cursor: Int32Array, end: number): number {
	let k = cursor[end];
	while (k < n - 1 && tau[k] < x) k++;
	cursor[end] = k;
	if (k === 0 || tau[k] < x) return cum[k];
	const t0 = tau[k - 1];
	const span = tau[k] - t0;
	return span > 0 ? cum[k - 1] + ((cum[k] - cum[k - 1]) * (x - t0)) / span : cum[k];
}

// A triweight bell of `sigma`, each sample weighted by the arc around it.
function blurAt(f: Float64Array, path: Float64Array, n: number, i: number, sigma: number, cursor: Int32Array): number {
	if (sigma <= 0) return f[i];
	const reach = SPEED_BLUR_REACH * sigma;
	const at = path[i];
	let lo = cursor[0];
	while (lo < i && path[lo] < at - reach) lo++;
	cursor[0] = lo;
	let num = 0,
		den = 0;
	for (let j = lo; j < n; j++) {
		const d = path[j] - at;
		if (d > reach) break;
		const own = (j > 0 ? path[j] - path[j - 1] : 0) + (j < n - 1 ? path[j + 1] - path[j] : 0);
		const u = d / reach;
		const q = 1 - u * u;
		const w = q * q * q * own;
		num += w * f[j];
		den += w;
	}
	return den > 0 ? num / den : f[i];
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
	rx: Float64Array,
	ry: Float64Array,
	rcum: Float64Array,
	ty: Float64Array,
	steps: Float64Array,
	openLen: number,
	closeLen: number,
	wait: number,
	seed: number,
	holdUntil: number,
): Float64Array {
	const n = ty.length;
	const out = new Float64Array(n);
	const scratch = new Float64Array(6);
	let d = seed;
	for (let i = 0; i < n; i++) {
		if (i <= holdUntil) {
			out[i] = seed;
			continue;
		}
		d = nibStep(d, ty[i], i === 0 ? 0 : steps[i], openLen, closeLen);
		// A thin run turning back into a thick one starts thick at the turn.
		if (reversalAt(rx, ry, rcum, n, i, wait, scratch) && scratch[5] > d) d += scratch[4] * (scratch[5] - d);
		out[i] = d;
	}
	return out;
}

// Whether raw sample i is the sharpest point of a turn past REVERSAL_FROM_DEG whose new stroke heads back for `wait`.
// Leaves the jump's share in scratch[4] and its target in scratch[5].
function reversalAt(
	rx: Float64Array,
	ry: Float64Array,
	rcum: Float64Array,
	n: number,
	i: number,
	wait: number,
	scratch: Float64Array,
): boolean {
	if (i < 1 || i + 1 >= n || wait <= 0 || rcum[n - 1] <= rcum[i + 1] + wait) return false;
	const c = turnCos(rx, ry, rcum, n, i, wait, scratch);
	if (c > REVERSAL_FROM_COS) return false;
	const inX = rx[i] - scratch[0],
		inY = ry[i] - scratch[1];
	const outX = scratch[2] - rx[i],
		outY = scratch[3] - ry[i];
	if (c > turnCos(rx, ry, rcum, n, i - 1, wait, scratch) || c >= turnCos(rx, ry, rcum, n, i + 1, wait, scratch)) return false;
	for (let k = i + 1; k < n && rcum[k] <= rcum[i] + wait; k++) {
		if ((rx[k] - rx[k - 1]) * inX + (ry[k] - ry[k - 1]) * inY > 0) return false;
	}
	const deg = (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
	scratch[4] = smoothstep(REVERSAL_FROM_DEG, REVERSAL_FULL_DEG, deg);
	scratch[5] = Math.min(1, Math.max(-1, outY / Math.hypot(outX, outY)));
	return scratch[4] > 0;
}

// Cosine of the turn at j between the chords `wait` long either side of it, 1 where either is missing.
function turnCos(
	rx: Float64Array,
	ry: Float64Array,
	rcum: Float64Array,
	n: number,
	j: number,
	wait: number,
	scratch: Float64Array,
): number {
	if (j <= 0 || j >= n - 1 || rcum[j] - wait < 0 || rcum[j] + wait > rcum[n - 1]) return 1;
	pointAt(rx, ry, rcum, n, rcum[j] - wait, scratch, 0);
	pointAt(rx, ry, rcum, n, rcum[j] + wait, scratch, 2);
	const ix = rx[j] - scratch[0],
		iy = ry[j] - scratch[1];
	const ox = scratch[2] - rx[j],
		oy = scratch[3] - ry[j];
	const li = Math.hypot(ix, iy),
		lo = Math.hypot(ox, oy);
	if (li < MIN_TANGENT_LEN || lo < MIN_TANGENT_LEN) return 1;
	return (ix * ox + iy * oy) / (li * lo);
}

function pointAt(x: Float64Array, y: Float64Array, cum: Float64Array, n: number, s: number, out: Float64Array, at: number): void {
	let lo = 0,
		hi = n - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (cum[mid] < s) lo = mid + 1;
		else hi = mid;
	}
	if (lo === 0) {
		out[at] = x[0];
		out[at + 1] = y[0];
		return;
	}
	const span = cum[lo] - cum[lo - 1];
	const f = span > 0 ? (s - cum[lo - 1]) / span : 1;
	out[at] = x[lo - 1] + (x[lo] - x[lo - 1]) * f;
	out[at + 1] = y[lo - 1] + (y[lo] - y[lo - 1]) * f;
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
		speedTop,
		speedSmoothing,
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
	let kept = true;
	const rawT = new Float64Array(n);
	const rawW = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const s = samples[i];
		rawX[i] = s[0] ?? 0;
		rawY[i] = s[1] ?? 0;
		rawP[i] = s.length > 2 ? (s[2] ?? 1) : 1; // absent pressure = full
		const t = s.length > 3 ? (s[3] ?? 0) : 0;
		rawT[i] = t;
		if (t !== 0) timed = true;
		rawW[i] = s.length > 4 ? (s[4] ?? 0) : 0;
		if (!(rawW[i] > 0)) kept = false;
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

	// The speed pen's kept widths, else the ones its timing gives, blurred along the smoothed path.
	const speedOn = speedStrength > 0 && (kept || timed);
	const needArc = ds > 0 || taperEnabled || (speedOn && !kept);
	const dirSteps = new Float64Array(needArc ? n : 0);
	const cum = new Float64Array(dirSteps.length);
	if (needArc)
		for (let i = 1; i < n; i++) {
			dirSteps[i] = Math.hypot(sx[i] - sx[i - 1], sy[i] - sy[i - 1]);
			cum[i] = cum[i - 1] + dirSteps[i];
		}

	const sf = !speedOn
		? null
		: kept
			? rawW
			: speedFactorsOver(rawT, steps, cum, speedStrength, speedTop, speedSmoothing * baseWidth, speedScale);
	const tf = taperEnabled ? taperFactors(cum, taperMinFactor, smoothScale) : null;

	let dirY: Float64Array | null = null;
	if (ds > 0) {
		const window = HEAD_LEN * Math.max(smoothScale, 0);
		const [head, holdUntil] = headDirection(sx, sy, cum, window, finished);
		const rcum = new Float64Array(n);
		for (let i = 1; i < n; i++) rcum[i] = rcum[i - 1] + steps[i];
		// A nib wider than NIB_RATE_WIDTH takes proportionally longer to open and close.
		const zoom = Math.max(smoothScale, 0);
		dirY = nibDirection(
			rawX,
			rawY,
			rcum,
			ty,
			dirSteps,
			Math.max(OPEN_LEN * zoom, (OPEN_LEN / NIB_RATE_WIDTH) * baseWidth),
			Math.max(CLOSE_LEN * zoom, (CLOSE_LEN / NIB_RATE_WIDTH) * baseWidth),
			Math.max(REVERSAL_MIN_WAIT * zoom, REVERSAL_WAIT * baseWidth),
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
		speedTop: c.speed_top ?? SPEED_HI,
		speedSmoothing: c.speed_smoothing ?? DEFAULT_SPEED_SMOOTHING,
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
