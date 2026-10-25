// Bond-market mathematics for KUBER. Pure functions only (no I/O), checked by scripts/bondtest.mjs.
// Yields are in percent (4.25 = 4.25%), changes in basis points (1 bp = 0.01 percentage point), maturities in years.

// ── basics ───────────────────────────────────────────────────────────────
export const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
export const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
// error function, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)
export function erf(x) { const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)); }
export const normCdf = x => 0.5 * (1 + erf(x / Math.SQRT2));
// chi-square(1) upper tail
export const chi2p1 = x => x <= 0 ? 1 : 1 - erf(Math.sqrt(x / 2));
export function quantile(sorted, p) { if (!sorted.length) return NaN; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }
// share of the history at or below x (0..1)
export function percentileRank(values, x) { const v = values.filter(Number.isFinite); return v.length ? v.filter(y => y <= x).length / v.length : NaN; }
export function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ── linear algebra ───────────────────────────────────────────────────────
export function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k;
    [M[i], M[p]] = [M[p], M[i]]; if (Math.abs(M[i][i]) < 1e-14) return null;
    for (let k = i + 1; k < n; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  }
  const x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
  return x;
}
// symmetric eigen-decomposition (cyclic Jacobi). Returns values (descending) and unit vectors (columns as arrays).
export function eigSym(S) {
  const n = S.length, A = S.map(r => [...r]), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  const idx = [...Array(n).keys()].sort((a, b) => A[b][b] - A[a][a]);
  return { values: idx.map(i => A[i][i]), vectors: idx.map(i => V.map(r => r[i])) };
}

// ── Nelson–Siegel–Svensson curve ─────────────────────────────────────────
// y(m) = β0 + β1·g(m/τ1) + β2·[g(m/τ1) − e^(−m/τ1)] + β3·[g(m/τ2) − e^(−m/τ2)],  g(x) = (1 − e^(−x))/x
// This is the form CCIL publishes its daily India zero-coupon curve in (checked: its 22 Oct 2026 parameters give
// 7.4495% at 10 years vs 7.4553% traded YTM for the 10-year benchmark).
const g = x => x < 1e-8 ? 1 - x / 2 : (1 - Math.exp(-x)) / x;
const nssRow = (m, t1, t2) => { const x1 = m / t1, x2 = m / t2, g1 = g(x1), g2 = g(x2); return [1, g1, g1 - Math.exp(-x1), g2 - Math.exp(-x2)]; };
export function nss(m, p) { const r = nssRow(m, p.t1, p.t2 || p.t1); return p.b0 * r[0] + p.b1 * r[1] + p.b2 * r[2] + (p.b3 || 0) * r[3]; }
// least-squares fit: grid over τ1, τ2 (log-spaced) with the β's solved exactly for each pair; also the 3-factor
// Nelson–Siegel (β3 = 0). The Svensson fit is kept only if it lowers the error clearly (≥ 15%), to avoid over-fitting.
export function fitNSS(mats, ys) {
  const n = mats.length; if (n < 5) return null;
  const grid = Array.from({ length: 36 }, (_, i) => 0.15 * Math.pow(30 / 0.15, i / 35));
  const fitFor = (t1, t2, k) => {
    const X = mats.map(m => nssRow(m, t1, t2).slice(0, k)), XtX = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? 1e-10 : 0))), Xty = Array.from({ length: k }, (_, i) => X.reduce((s, r, q) => s + r[i] * ys[q], 0));
    const b = solve(XtX, Xty); if (!b) return null; const sse = X.reduce((s, r, q) => s + (r.reduce((a, x, i) => a + x * b[i], 0) - ys[q]) ** 2, 0); return { b, sse };
  };
  let ns = null; for (const t1 of grid) { const f = fitFor(t1, t1, 3); if (f && (!ns || f.sse < ns.sse)) ns = { ...f, t1, t2: t1 }; }
  let sv = null; if (n >= 7) for (const t1 of grid) for (const t2 of grid) { if (t2 < t1 * 1.5) continue; const f = fitFor(t1, t2, 4); if (f && Math.abs(f.b[3]) < 50 && (!sv || f.sse < sv.sse)) sv = { ...f, t1, t2 }; }
  const best = sv && sv.sse < ns.sse * 0.85 ? sv : ns, b = best.b;
  const p = { b0: b[0], b1: b[1], b2: b[2], b3: b[3] || 0, t1: best.t1, t2: best.t2, kind: best === sv ? "Svensson" : "Nelson–Siegel" };
  p.rmseBp = Math.sqrt(best.sse / n) * 100; p.maxErrBp = Math.max(...mats.map((m, i) => Math.abs(nss(m, p) - ys[i]))) * 100;
  return p;
}

// ── bond pricing (fixed coupon, semi-annual by default; yields compounded at the coupon frequency) ──
// price per 100 face for a bond with whole coupon periods remaining
export function bondPrice(coupon, y, years, freq = 2) {
  const n = Math.round(years * freq), c = coupon / freq, r = y / 100 / freq;
  if (Math.abs(r) < 1e-12) return c * n + 100;
  return c * (1 - Math.pow(1 + r, -n)) / r + 100 * Math.pow(1 + r, -n);
}
// Macaulay / modified duration and convexity (closed-form sums over cash flows)
export function bondRisk(coupon, y, years, freq = 2) {
  const n = Math.round(years * freq), c = coupon / freq, r = y / 100 / freq; let P = 0, D = 0, C = 0;
  for (let k = 1; k <= n; k++) { const cf = c + (k === n ? 100 : 0), df = Math.pow(1 + r, -k); P += cf * df; D += (k / freq) * cf * df; C += cf * df * k * (k + 1) / (freq * freq); }
  const mac = D / P, mod = mac / (1 + r), conv = C / (P * (1 + r) ** 2);
  return { price: P, macaulay: mac, modified: mod, convexity: conv, dv01: mod * P / 10000 };
}
// price change for a parallel shift (bp): exact repricing vs the duration+convexity approximation
export function shock(coupon, y, years, bp, freq = 2) {
  const R = bondRisk(coupon, y, years, freq), exact = bondPrice(coupon, y + bp / 100, years, freq) / R.price - 1, dy = bp / 10000;
  return { bp, exactPct: exact * 100, approxPct: (-R.modified * dy + 0.5 * R.convexity * dy * dy) * 100 };
}
// one-year carry and roll-down of a par bond if the curve doesn't move: buy at par at y(T), hold a year, sell at y(T−1)
export function carryRoll(curve, T) {
  const yT = curve(T), yR = curve(T - 1), coupon = yT, sell = bondPrice(coupon, yR, T - 1), total = (coupon + sell - 100);
  const R = bondRisk(coupon, yR, T - 1);
  return { yT, yRolled: yR, rollBp: (yT - yR) * 100, incomePct: coupon, priceGainPct: sell - 100, totalPct: total, breakevenBp: R.modified ? total / R.modified * 100 : NaN, durationAfter: R.modified };
}

// ── regression with Newey–West (HAC) standard errors ─────────────────────
export function olsNW(y, x, lag = 5) {
  const n = y.length; if (n < 30) return null;
  const mx = mean(x), my = mean(y); let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  if (sxx <= 0) return null;
  const b = sxy / sxx, a = my - b * mx, e = y.map((v, i) => v - a - b * x[i]), u = x.map((v, i) => (v - mx) * e[i]);
  let S = u.reduce((s, v) => s + v * v, 0); for (let k = 1; k <= lag; k++) { let c = 0; for (let i = k; i < n; i++) c += u[i] * u[i - k]; S += 2 * (1 - k / (lag + 1)) * c; }
  const se = Math.sqrt(Math.max(S, 0)) / sxx, sst = y.reduce((s, v) => s + (v - my) ** 2, 0), sse = e.reduce((s, v) => s + v * v, 0);
  return { n, alpha: a, beta: b, se, t: b / se, p: 2 * (1 - normCdf(Math.abs(b / se))), r2: sst ? 1 - sse / sst : 0, corr: sxy / Math.sqrt(sxx * sst) };
}

// ── volatility of yield changes: GARCH(1,1) by maximum likelihood (grid), filtered historical simulation ──
export function garch(d) {
  const m = mean(d), e = d.map(x => x - m), vbar = e.reduce((s, x) => s + x * x, 0) / e.length; let best = { ll: -Infinity };
  for (let a = 0.01; a <= 0.25 + 1e-9; a += 0.01) for (let b = 0.6; b <= 0.985 + 1e-9; b += 0.005) {
    if (a + b >= 0.998) continue; const w = vbar * (1 - a - b); let h = vbar, ll = 0;
    for (const x of e) { ll += -0.5 * (Math.log(2 * Math.PI * h) + x * x / h); h = w + a * x * x + b * h; }
    if (ll > best.ll) best = { ll, a, b, w };
  }
  let h = vbar; const z = []; for (const x of e) { z.push(x / Math.sqrt(h)); h = best.w + best.a * x * x + best.b * h; }
  const zm = mean(z), zs = sd(z) || 1;
  return { alpha: best.a, beta: best.b, omega: best.w, persist: best.a + best.b, vbar, hNext: h, mean: m, z: z.map(v => (v - zm) / zs), ll: best.ll, halfLifeDays: Math.log(0.5) / Math.log(best.a + best.b) };
}
// H-day yield-change distribution (bp): GARCH paths driven by the model's own standardised residuals (no normality
// assumption). The mean of daily changes is NOT carried forward (a drift in yields is not forecastable from its past).
export function fhsRange(G, H, paths = 4000, seed = 7) {
  const u = rng(seed), out = new Float64Array(paths), Z = G.z, n = Z.length;
  for (let p = 0; p < paths; p++) { let h = G.hNext, s = 0; for (let k = 0; k < H; k++) { const e = Z[Math.floor(u() * n)] * Math.sqrt(h); s += e; h = G.omega + G.alpha * e * e + G.beta * h; } out[p] = s; }
  const v = [...out].sort((a, b) => a - b); return { p05: quantile(v, 0.05), p25: quantile(v, 0.25), p50: quantile(v, 0.5), p75: quantile(v, 0.75), p95: quantile(v, 0.95), sdBp: sd(v) };
}
// walk-forward test of the H-day ranges on a daily yield series: refit every `step` days on the previous `win` days,
// compare with what happened. Benchmark: the same window's plain historical H-day changes. Kupiec test on 90% coverage.
export function backtestRange(y, { H = 21, step = 21, win = 1000, paths = 1500 } = {}) {
  const rows = [];
  for (let t = win + 1; t + H < y.length; t += step) {
    const d = []; for (let i = t - win; i < t; i++) d.push((y[i] - y[i - 1]) * 100);
    const G = garch(d), R = fhsRange(G, H, paths, t), act = (y[t - 1 + H] - y[t - 1]) * 100;
    const hist = []; for (let i = t - win + H; i < t; i++) hist.push((y[i] - y[i - H]) * 100); hist.sort((a, b) => a - b);
    const B = { p05: quantile(hist, 0.05), p95: quantile(hist, 0.95), p25: quantile(hist, 0.25), p75: quantile(hist, 0.75) };
    const isc = (lo, hi) => (hi - lo) + 20 * Math.max(0, lo - act) + 20 * Math.max(0, act - hi);
    rows.push({ in90: act >= R.p05 && act <= R.p95, in50: act >= R.p25 && act <= R.p75, bIn90: act >= B.p05 && act <= B.p95, s: isc(R.p05, R.p95), sb: isc(B.p05, B.p95) });
  }
  if (rows.length < 20) return null;
  const n = rows.length, x = rows.filter(r => r.in90).length, p = 0.9, ph = x / n;
  const lr = -2 * (x * Math.log(p) + (n - x) * Math.log(1 - p) - (x ? x * Math.log(ph) : 0) - (n - x ? (n - x) * Math.log(1 - ph) : 0));
  const dd = rows.map(r => r.sb - r.s), dm = mean(dd) / (sd(dd) / Math.sqrt(n));
  return { n, H, in90: ph, in50: rows.filter(r => r.in50).length / n, benchIn90: rows.filter(r => r.bIn90).length / n, kupiecP: chi2p1(lr), score: mean(rows.map(r => r.s)), benchScore: mean(rows.map(r => r.sb)), dmT: dm };
}

// ── data cleaning ──
// a bar that jumps more than 5 bp away from its neighbours while they agree within 3 bp is a bad print, not a move
// (seen 22 Oct 2026: US 2-year 4.722% at 19:31 New York between 4.645% and 4.658%)
// Generic: pts = [[t, v]]; for prices pass log-prices with relative thresholds (e.g. jump 0.01 = 1%, agree 0.004).
export function isolatedSpikes(pts, k = 3, jump = 0.05, agree = 0.03) {
  const bad = new Set();
  for (let i = 0; i < pts.length; i++) {
    const nb = []; for (let j = Math.max(0, i - k); j <= Math.min(pts.length - 1, i + k); j++) if (j !== i) nb.push(pts[j][1]);
    if (nb.length < 3) continue; nb.sort((a, b) => a - b); const med = nb[Math.floor(nb.length / 2)];   // at the ends: one-sided neighbours
    if (Math.abs(pts[i][1] - med) > jump && nb[nb.length - 1] - nb[0] < agree) bad.add(i);
  }
  return bad;
}
// the same series without its isolated spikes (raw data stays stored; every reader gets the cleaned series)
export function withoutSpikes(rows, val, { k = 3, jump = 0.05, agree = 0.03 } = {}) { const bad = isolatedSpikes(rows.map(r => [0, val(r)]), k, jump, agree); return bad.size ? rows.filter((_, i) => !bad.has(i)) : rows; }

// ── principal components of daily curve changes ──────────────────────────
export function pca(rows) {
  const k = rows[0].length, n = rows.length, mu = Array.from({ length: k }, (_, j) => mean(rows.map(r => r[j])));
  const S = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => rows.reduce((s, r) => s + (r[i] - mu[i]) * (r[j] - mu[j]), 0) / (n - 1)));
  const E = eigSym(S), tot = E.values.reduce((s, v) => s + Math.max(v, 0), 0);
  // sign convention: level loads positively on average; slope positive at the long end
  const vec = E.vectors.map((v, i) => { const flip = i === 0 ? mean(v) < 0 : v[k - 1] < v[0]; return flip ? v.map(x => -x) : v; });
  return { n, share: E.values.map(v => Math.max(v, 0) / tot), sdBp: E.values.map(v => Math.sqrt(Math.max(v, 0))), loadings: vec, mean: mu };
}

// ── recession probability: the New York Fed's published probit on the 10-year minus 3-month spread ──
// P(recession in 12 months) = Φ(−0.5333 − 0.6330 × spread), spread = monthly average, percentage points, 3-month on a
// bond-equivalent basis (Estrella & Mishkin; Estrella & Trubin 2006). KUBER also reads the NY Fed's own series to check.
export const recessionProb = spread => normCdf(-0.5333 - 0.6330 * spread);
