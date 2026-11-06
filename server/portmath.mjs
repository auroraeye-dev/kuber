// Portfolio mathematics for KUBER: joint simulation, risk contributions, what-if, stress windows, trade plans, charges,
// tax lots, benchmark returns, results-day risk, naive baseline and model research. Pure functions, no I/O; checked by
// scripts/porttest.mjs against known answers.
import * as B from "./bondmath.mjs";

const { mean, sd, quantile, rng } = B;
const sorted = a => Float64Array.from(a).sort();
const q0 = (s, p) => s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] : NaN;

// ── joint shocks ─────────────────────────────────────────────────────────
// Each stock gets its own GARCH(1,1) on daily log returns. Its standardised residuals are then drawn BY DATE across all
// stocks (filtered historical simulation), so correlation and shared crash days stay exactly as they happened; signs are
// kept, so asymmetry stays too. A stock listed later has no residual on older dates: there it is filled from the
// other stocks' average residual that day plus its own noise, with the correlation it has shown since listing.
function retSeries(s, dates) {
  const idx = new Map(s.dates.map((d, i) => [d, i]));
  return dates.map((d, t) => { if (!t) return null; const i = idx.get(d), k = idx.get(dates[t - 1]); return i != null && k != null && s.adj[i] > 0 && s.adj[k] > 0 ? Math.log(s.adj[i] / s.adj[k]) : null; });
}
export function buildModel(stocks, { win = 756, asOf = null, seed = 11 } = {}) {
  const cut = s => { if (!asOf) return s; let n = s.dates.length; while (n > 0 && s.dates[n - 1] > asOf) n--; return { ...s, dates: s.dates.slice(0, n), adj: s.adj.slice(0, n) }; };
  const list = stocks.map(cut), longest = list.reduce((a, s) => s.dates.length > a.dates.length ? s : a, list[0]);
  const dates = longest.dates.slice(-(win + 1)); if (dates.length < 30) return null;
  const R = list.map(s => retSeries(s, dates)), T = dates.length, N = list.length, u = rng(seed);
  const G = [], Zc = R.map(() => new Array(T).fill(null));
  R.forEach((r, i) => {
    const pos = [], x = []; r.forEach((v, t) => { if (v != null) { pos.push(t); x.push(v); } });
    let g; if (x.length >= 120) g = B.garch(x); else { const m = x.length ? mean(x) : 0, s = x.length > 2 ? sd(x) : 0.02, v = s * s; g = { alpha: 0, beta: 0, omega: v, hNext: v, vbar: v, persist: 0, z: x.map(a => (a - m) / (s || 1)), short: true }; }
    G.push(g); pos.forEach((t, k) => { Zc[i][t] = g.z[k]; });
  });
  // market factor per date: average of the residuals that exist; correlation of each stock with it on its own dates
  const mkt = new Array(T).fill(null); for (let t = 1; t < T; t++) { const v = Zc.map(c => c[t]).filter(x => x != null); if (v.length) mkt[t] = mean(v); }
  const mv = mkt.filter(x => x != null), ms = sd(mv) || 1, rho = Zc.map(c => { const a = [], b = []; c.forEach((z, t) => { if (z != null && mkt[t] != null) { a.push(z); b.push(mkt[t] / ms); } }); if (a.length < 20) return 0.3; const ma = mean(a), mb = mean(b), cov = a.reduce((s, x, k) => s + (x - ma) * (b[k] - mb), 0) / (a.length - 1); return Math.max(-0.95, Math.min(0.95, cov / ((sd(a) || 1) * (sd(b) || 1)))); });
  const Z = []; let filled = 0;
  for (let t = 1; t < T; t++) {
    if (mkt[t] == null) continue; const row = new Float64Array(N);
    for (let i = 0; i < N; i++) { const z = Zc[i][t]; if (z != null) row[i] = z; else { const own = G[i].z.length ? G[i].z[Math.floor(u() * G[i].z.length)] : 0; row[i] = rho[i] * mkt[t] / ms + Math.sqrt(1 - rho[i] * rho[i]) * own; filled++; } }
    Z.push(row);
  }
  // plain joint returns for the naive arm (last 252 usable dates, demeaned per stock, missing = filled residual × that stock's sd)
  const sdv = R.map(r => { const x = r.filter(v => v != null); return x.length > 2 ? sd(x) : 0.02; });
  const naive = Z.slice(-252).map(row => Float64Array.from(row, (z, i) => z * sdv[i]));
  return { ids: list.map(s => s.id), Z, G, rho, sdv, naive, days: Z.length, from: dates[1], to: dates[T - 1], filledShare: filled / Math.max(1, Z.length * N), hist: R.map(r => r.filter(v => v != null).length) };
}

// One bootstrap date per simulated day. mu = total-return drift per year. events[i] = [{ day, extraVar }]: a known results
// date adds one extra shock on that day. Returns distribution of the portfolio's buy-and-hold return.
export function simulate(model, w, mu, { H = [5, 21, 63], paths = 4000, seed = 7, events = null, contribAt = 21 } = {}) {
  const N = w.length, maxH = Math.max(...H), u = rng(seed), Z = model.Z, nZ = Z.length, G = model.G;
  const at = Object.fromEntries(H.map(h => [h, new Float64Array(paths)])), dd = new Float64Array(paths), kC = H.includes(contribAt) ? contribAt : H[H.length - 1], X = Array.from({ length: N }, () => new Float64Array(paths));
  const md = mu.map(m => m / 252), h = new Float64Array(N), c = new Float64Array(N), sumW = w.reduce((a, b) => a + b, 0) || 1;
  for (let p = 0; p < paths; p++) {
    for (let i = 0; i < N; i++) { h[i] = G[i].hNext; c[i] = 0; } let peak = 1, worst = 0;
    for (let t = 1; t <= maxH; t++) {
      const row = Z[Math.floor(u() * nZ)]; let V = 0;
      for (let i = 0; i < N; i++) {
        const hi = h[i]; let e = Math.sqrt(hi) * row[i];
        h[i] = G[i].omega + G[i].alpha * e * e + G[i].beta * hi;
        if (events?.[i]) for (const ev of events[i]) if (ev.day === t) { const zs = G[i].z; e += Math.sqrt(ev.extraVar) * (zs.length ? zs[Math.floor(u() * zs.length)] : 0); }
        c[i] += md[i] - hi / 2 + e; V += w[i] * Math.exp(c[i]);
      }
      V /= sumW; if (V > peak) peak = V; const dn = V / peak - 1; if (dn < worst) worst = dn;
      if (at[t]) at[t][p] = V - 1;
      if (t === kC) for (let i = 0; i < N; i++) X[i][p] = (w[i] / sumW) * (Math.exp(c[i]) - 1);
    }
    dd[p] = worst;
  }
  return summarise(at, dd, X, kC, H, paths);
}
function summarise(at, dd, X, kC, H, paths) {
  const out = { horizons: {} };
  for (const h of H) {
    const s = sorted(at[h]), n = s.length, tail = Math.max(1, Math.floor(n * 0.05)); let cv = 0; for (let i = 0; i < tail; i++) cv += s[i];
    const lossOver = x => { let c = 0; for (const v of s) { if (v <= -x) c++; else break; } return c / n; };
    let up = 0; for (const v of s) if (v > 0) up++;
    out.horizons[h] = { p01: q0(s, 0.01), p05: q0(s, 0.05), p25: q0(s, 0.25), p50: q0(s, 0.5), p75: q0(s, 0.75), p95: q0(s, 0.95), mean: mean(s), sd: sd(s), pUp: up / n, cvar95: cv / tail, loss5: lossOver(0.05), loss10: lossOver(0.10), loss20: lossOver(0.20) };
  }
  if (dd) { const s = sorted(dd); out.drawdown = { days: Math.max(...H), median: q0(s, 0.5), p05: q0(s, 0.05) }; }
  if (X) {
    const tot = at[kC], m = mean(tot); let vr = 0; for (const v of tot) vr += (v - m) ** 2;
    const order = Array.from(tot.keys()).sort((a, b) => tot[a] - tot[b]), tail = order.slice(0, Math.max(1, Math.floor(paths * 0.05))), tailMean = tail.reduce((s, k) => s + tot[k], 0) / tail.length;
    out.contrib = X.map(x => { const mx = mean(x); let cov = 0; for (let p = 0; p < paths; p++) cov += (x[p] - mx) * (tot[p] - m); return { var: vr ? cov / vr : 0, tail: tailMean ? tail.reduce((s, k) => s + x[k], 0) / tail.length / tailMean : 0, sd: sd(x) }; });
  }
  return out;
}
// naive arm: the same stocks and weights, plain joint bootstrap of the last year's daily returns: no volatility model
export function simulateNaive(model, w, mu, { H = [5, 21, 63], paths = 4000, seed = 13 } = {}) {
  const N = w.length, u = rng(seed), rows = model.naive, nR = rows.length, sumW = w.reduce((a, b) => a + b, 0) || 1, maxH = Math.max(...H), at = Object.fromEntries(H.map(h => [h, new Float64Array(paths)])), md = mu.map(m => m / 252), c = new Float64Array(N);
  for (let p = 0; p < paths; p++) { c.fill(0); for (let t = 1; t <= maxH; t++) { const r = rows[Math.floor(u() * nR)]; let V = 0; for (let i = 0; i < N; i++) { c[i] += md[i] - model.sdv[i] ** 2 / 2 + r[i]; V += w[i] * Math.exp(c[i]); } if (at[t]) at[t][p] = V / sumW - 1; } }
  return summarise(at, null, null, null, H, paths);
}

// ── risk snapshot from history ───────────────────────────────────────────
export function riskStats(stocks, w, { days = 252 } = {}) {
  const sumW = w.reduce((a, b) => a + b, 0) || 1, wn = w.map(x => x / sumW), longest = stocks.reduce((a, s) => s.dates.length > a.dates.length ? s : a, stocks[0]);
  const common = longest.dates.filter(d => stocks.every(s => s._set?.has(d) ?? s.dates.includes(d))).slice(-(days + 1));
  const R = stocks.map(s => { const m = new Map(s.dates.map((d, i) => [d, s.adj[i]])), a = []; for (let t = 1; t < common.length; t++) a.push(Math.log(m.get(common[t]) / m.get(common[t - 1]))); return a; });
  const cov = (a, b) => { const x = mean(a), y = mean(b); return a.reduce((s, v, k) => s + (v - x) * (b[k] - y), 0) / (a.length - 1); };
  const n = stocks.length, sds = R.map(r => r.length > 2 ? Math.sqrt(cov(r, r)) : NaN), corr = R.map((a, i) => R.map((b, j) => i === j ? 1 : a.length > 2 ? cov(a, b) / (sds[i] * sds[j]) : null));
  const port = R[0] ? R[0].map((_, t) => R.reduce((s, r, i) => s + wn[i] * r[t], 0)) : [], pv = port.length > 2 ? Math.sqrt(cov(port, port)) : NaN, indep = Math.sqrt(wn.reduce((s, x, i) => s + (x * sds[i]) ** 2, 0)), wsum = wn.reduce((s, x, i) => s + x * sds[i], 0);
  let rs = 0, cnt = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (corr[i][j] != null) { rs += corr[i][j]; cnt++; }
  const so = port.slice().sort((a, b) => a - b); let peak = 0, cum = 0, mdd = 0; for (const x of port) { cum += x; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); }
  return { days: port.length, from: common[0], to: common[common.length - 1], annVol: pv * Math.sqrt(252), annVolIfIndependent: indep * Math.sqrt(252), diversification: wsum / pv, avgCorr: cnt ? rs / cnt : null, effectiveN: 1 / wn.reduce((s, x) => s + x * x, 0), top: Math.max(...wn), topTwo: wn.slice().sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0), worstDay: so[0], day5pct: so.length ? so[Math.floor(so.length * 0.05)] : null, maxDrawdown: Math.expm1(mdd), corr, stockVol: sds.map(s => s * Math.sqrt(252)) };
}

// ── walk-forward test: today's weights at past dates, refit on data up to that date, compared with what then happened ──
export function backtestPortfolio(stocks, w, { step = 21, win = 500, minHist = 250, H = [5, 21, 63], paths = 1200, mu = 0.08, minCover = 0.5 } = {}) {
  const longest = stocks.reduce((a, s) => s.dates.length > a.dates.length ? s : a, stocks[0]), cal = longest.dates, rows = [], maxH = Math.max(...H), maps = stocks.map(s => new Map(s.dates.map((d, i) => [d, s.adj[i]]))), total = w.reduce((a, b) => a + b, 0) || 1;
  for (let t = minHist; t + maxH < cal.length; t += step) {
    const asOf = cal[t], live = stocks.map((s, i) => s.dates.filter(d => d <= asOf).length >= 60 && maps[i].has(asOf) ? i : -1).filter(i => i >= 0), cover = live.reduce((s, i) => s + w[i], 0) / total; if (cover < minCover) continue;
    const sub = live.map(i => stocks[i]), wS = live.map(i => w[i]), M = buildModel(sub, { win, asOf, seed: t }); if (!M) continue;
    const muS = wS.map(() => mu), A = simulate(M, wS, muS, { H, paths, seed: t + 1, contribAt: H[0] }), Bn = simulateNaive(M, wS, muS, { H, paths, seed: t + 2 }), sumS = wS.reduce((a, b) => a + b, 0);
    for (const h of H) { const dEnd = cal[t + h], act = live.reduce((s, i) => { const a0 = maps[i].get(asOf), a1 = maps[i].get(dEnd); return s + (w[i] / sumS) * (a1 != null ? a1 / a0 - 1 : 0); }, 0); rows.push({ t, h, act, A: A.horizons[h], B: Bn.horizons[h], cover }); }
  }
  const iscore = (r, a) => (r.p95 - r.p05) + 20 * Math.max(0, r.p05 - a) + 20 * Math.max(0, a - r.p95);
  const res = {};
  for (const h of H) {
    const x = rows.filter(r => r.h === h); if (x.length < 8) { res[h] = { n: x.length }; continue; }
    const cov = (k, lo, hi) => x.filter(r => r.act >= r[k][lo] && r.act <= r[k][hi]).length / x.length, d = x.map(r => iscore(r.B, r.act) - iscore(r.A, r.act));
    const n = x.length, hit = x.filter(r => r.act >= r.A.p05 && r.act <= r.A.p95).length, ph = hit / n, lr = -2 * (hit * Math.log(0.9) + (n - hit) * Math.log(0.1) - (hit ? hit * Math.log(ph) : 0) - (n - hit ? (n - hit) * Math.log(1 - ph) : 0)), lag = Math.max(0, Math.round(h / step) - 1), m = mean(d), g = k => { let s = 0; for (let i = k; i < n; i++) s += (d[i] - m) * (d[i - k] - m); return s / n; }; let v = g(0); for (let k = 1; k <= lag; k++) v += 2 * (1 - k / (lag + 1)) * g(k);
    res[h] = { n, in90: ph, in50: cov("A", "p25", "p75"), naiveIn90: cov("B", "p05", "p95"), naiveIn50: cov("B", "p25", "p75"), kupiecP: B.chi2p1(lr), dmT: m / Math.sqrt(Math.max(v, 1e-18) / n), score: mean(x.map(r => iscore(r.A, r.act))), naiveScore: mean(x.map(r => iscore(r.B, r.act))) };
  }
  return { avgCover: rows.length ? mean(rows.map(r => r.cover)) : null, windows: new Set(rows.map(r => r.t)).size, from: rows.length ? cal[rows[0].t] : null, to: rows.length ? cal[rows[rows.length - 1].t] : null, horizons: res };
}

// ── stress: the worst real windows for today's weights, and sensitivity to a factor ──
export function worstWindows(stocks, w, { lens = [1, 5, 21], minCover = 0.5 } = {}) {
  const longest = stocks.reduce((a, s) => s.dates.length > a.dates.length ? s : a, stocks[0]), cal = longest.dates, maps = stocks.map(s => new Map(s.dates.map((d, i) => [d, s.adj[i]]))), total = w.reduce((a, b) => a + b, 0) || 1, out = [];
  for (const len of lens) {
    let best = null;
    for (let t = len; t < cal.length; t++) {
      let ret = 0, cov = 0; const parts = [];
      for (let i = 0; i < stocks.length; i++) { const a0 = maps[i].get(cal[t - len]), a1 = maps[i].get(cal[t]); if (a0 > 0 && a1 > 0) { cov += w[i]; parts.push([i, a1 / a0 - 1]); } }
      if (cov / total < minCover) continue; for (const [i, r] of parts) ret += w[i] / cov * r;
      if (!best || ret < best.ret) best = { len, from: cal[t - len], to: cal[t], ret, cover: cov / total, parts };
    }
    if (best) out.push({ ...best, parts: best.parts.map(([i, r]) => ({ id: stocks[i].id, ret: r, share: w[i] / (best.cover * total) })) });
  }
  return out;
}
export function factorBeta(stocks, w, fDates, fVals, { days = 504, asChange = false } = {}) {
  const fm = new Map(fDates.map((d, i) => [d, fVals[i]])), total = w.reduce((a, b) => a + b, 0) || 1, longest = stocks.reduce((a, s) => s.dates.length > a.dates.length ? s : a, stocks[0]), maps = stocks.map(s => new Map(s.dates.map((d, i) => [d, s.adj[i]]))), y = [], x = [];
  for (let t = 1; t < longest.dates.length; t++) {
    const d0 = longest.dates[t - 1], d1 = longest.dates[t], f0 = fm.get(d0), f1 = fm.get(d1); if (f0 == null || f1 == null) continue;
    let r = 0, cov = 0; for (let i = 0; i < stocks.length; i++) { const a0 = maps[i].get(d0), a1 = maps[i].get(d1); if (a0 > 0 && a1 > 0) { r += w[i] * Math.log(a1 / a0); cov += w[i]; } } if (cov / total < 0.6) continue;
    y.push(r / cov); x.push(asChange ? (f1 - f0) : Math.log(f1 / f0));
  }
  return B.olsNW(y.slice(-days), x.slice(-days), 5);
}

// ── results-day risk ─────────────────────────────────────────────────────
// How much bigger is the two-day move around a results date than two ordinary days? Shrunk toward 1 with 4 pseudo-events,
// because a stock has few results in the stored history.
export function resultsEffect(s, resultDates) {
  const idx = new Map(s.dates.map((d, i) => [d, i])), r = []; for (let i = 1; i < s.dates.length; i++) r.push(Math.log(s.adj[i] / s.adj[i - 1]));
  const ev = new Set(), wins = [];
  for (const d of resultDates) { let i = idx.get(d); if (i == null) { i = s.dates.findIndex(x => x >= d); if (i < 0) continue; } if (i < 1 || i >= s.dates.length - 1) continue; ev.add(i - 1); ev.add(i); wins.push(r[i - 1] + r[i]); }
  const normal = r.filter((_, i) => !ev.has(i)); if (normal.length < 60 || !wins.length) return { n: wins.length, multiple: 1, shrunk: 1, typicalMove: null, normalDaily: normal.length ? sd(normal) : null };
  const v = mean(normal.map(x => x * x)), mw = mean(wins.map(x => x * x)), multiple = mw / (2 * v), shrunk = (wins.length * multiple + 4) / (wins.length + 4);
  return { n: wins.length, multiple, shrunk, typicalMove: Math.sqrt(mw), normalDaily: Math.sqrt(v), extraVar: Math.max(0, shrunk - 1) * 2 * v };
}

// ── naive baseline for the Trial page: random walk, plain bootstrap of the last year's daily returns, no drift, no model ──
export function naiveLadder(adj, px, { N = 90, paths = 2000, seed = 3 } = {}) {
  const r = []; for (let i = Math.max(1, adj.length - 252); i < adj.length; i++) r.push(Math.log(adj[i] / adj[i - 1])); if (r.length < 120) return null;
  const m = mean(r), u = rng(seed), at = Array.from({ length: N }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p++) { let c = 0; for (let t = 0; t < N; t++) { c += r[Math.floor(u() * r.length)] - m; at[t][p] = c; } }
  return at.map((a, t) => { const s = a.slice().sort(); let up = 0; for (const x of s) if (x > 0) up++; const f = x => px * Math.exp(q0(s, x)); return { h: t + 1, p05: f(0.05), p25: f(0.25), p50: f(0.5), p75: f(0.75), p95: f(0.95), pUp: up / paths }; });
}

// ── charges ──────────────────────────────────────────────────────────────
// Defaults are editable estimates (System page); an actual figure entered on the order always wins.
export const COST_DEFAULTS = { asOf: "2026-11-06", IN: { brokeragePct: 0.1, brokerageMax: 20, brokerageMin: 5, sttPct: 0.1, stampBuyPct: 0.015, exchangePct: 0.00297, sebiPct: 0.0001, gstPct: 18, dpSell: 20 }, US: { brokeragePct: 0, brokerageMax: 0, brokerageMin: 0, sttPct: 0, stampBuyPct: 0, exchangePct: 0, sebiPct: 0, gstPct: 0, dpSell: 0 }, KR: { brokeragePct: 0, brokerageMax: 0, brokerageMin: 0, sttPct: 0, stampBuyPct: 0, exchangePct: 0, sebiPct: 0, gstPct: 0, dpSell: 0 }, tax: { stcgPct: 20, ltcgPct: 12.5, ltcgExempt: 125000, ltDays: 365 } };
export function charges(side, value, mk = "IN", cfg = COST_DEFAULTS, kind = "Delivery") {
  const c = cfg[mk] || COST_DEFAULTS[mk] || COST_DEFAULTS.US, p = x => value * (x || 0) / 100; if (!(value > 0) || kind === "Corporate action") return { total: 0, stt: 0, deductible: 0 };
  const brok = c.brokerageMax || c.brokeragePct ? Math.max(c.brokerageMin || 0, Math.min(c.brokerageMax || Infinity, p(c.brokeragePct))) : 0, stt = p(c.sttPct), stamp = side === "Buy" ? p(c.stampBuyPct) : 0, ex = p(c.exchangePct), sebi = p(c.sebiPct), dp = side === "Sell" ? c.dpSell || 0 : 0, gst = (brok + ex + sebi + dp) * (c.gstPct || 0) / 100, total = brok + stt + stamp + ex + sebi + dp + gst;
  return { total, stt, brokerage: brok, stamp, exchange: ex, sebi, dp, gst, deductible: total - stt };     // STT is not deductible from capital gains
}

// ── capital gains by financial year (first in, first out, as Indian tax law requires for shares) ──
const fyOf = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`; };
export function taxReport(orders, cfg = COST_DEFAULTS, mkOnly = "IN") {
  const T = cfg.tax || COST_DEFAULTS.tax, lots = {}, sales = [], ex = orders.filter(o => o.status === "executed" && (o.mk || "IN") === mkOnly).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.side === "Buy" ? -1 : 1));
  const fee = o => o.fees != null ? { total: o.fees, deductible: o.fees } : charges(o.side, o.qty * o.price, o.mk || "IN", cfg, o.kind);
  for (const o of ex) {
    const L = lots[o.sym] ||= [], F = fee(o);
    if (o.side === "Buy") { L.push({ date: o.date, qty: o.qty, price: o.price, fee: F.deductible / o.qty, ca: o.kind === "Corporate action" }); continue; }
    let left = o.qty; const sellFee = F.deductible / o.qty;
    while (left > 1e-9 && L.length) {
      const lot = L[0], q = Math.min(left, lot.qty); lot.qty -= q; left -= q; if (lot.qty <= 1e-9) L.shift();
      if (o.kind === "Corporate action") continue;    // a demerger's cost transfer is not a sale
      const days = (Date.parse(o.date) - Date.parse(lot.date)) / 864e5, gain = q * (o.price - lot.price) - q * lot.fee - q * sellFee;
      sales.push({ fy: fyOf(o.date), sym: o.sym, sold: o.date, bought: lot.date, qty: q, buy: lot.price, sell: o.price, gain, long: days > T.ltDays, days: Math.round(days), corpLot: !!lot.ca });
    }
    if (left > 1e-9 && o.kind !== "Corporate action") sales.push({ fy: fyOf(o.date), sym: o.sym, sold: o.date, bought: null, qty: left, buy: null, sell: o.price, gain: null, long: false, unmatched: true });
  }
  const years = {};
  for (const s of sales) { const Y = years[s.fy] ||= { fy: s.fy, st: 0, lt: 0, rows: [], unmatched: 0, corpLots: 0 }; Y.rows.push(s); if (s.gain == null) { Y.unmatched++; continue; } if (s.long) Y.lt += s.gain; else Y.st += s.gain; if (s.corpLot) Y.corpLots++; }
  for (const Y of Object.values(years)) {
    // set-off within the year: short-term losses against any gains; long-term losses against long-term gains only
    let st = Y.st, lt = Y.lt; if (st < 0 && lt > 0) { const u = Math.min(-st, lt); st += u; lt -= u; }
    const ltTaxable = Math.max(0, lt - T.ltcgExempt); Y.stTaxable = Math.max(0, st); Y.ltTaxable = ltTaxable; Y.tax = Y.stTaxable * T.stcgPct / 100 + ltTaxable * T.ltcgPct / 100; Y.lossCarry = Math.min(0, st) + Math.min(0, lt); Y.exemptionLeft = Math.max(0, T.ltcgExempt - Math.max(0, lt));
  }
  // open lots: unrealised gains by holding period at given prices are computed by the caller
  return { years: Object.values(years).sort((a, b) => b.fy.localeCompare(a.fy)), open: Object.fromEntries(Object.entries(lots).filter(([, L]) => L.length).map(([s, L]) => [s, L.map(l => ({ date: l.date, qty: l.qty, price: l.price, ca: l.ca }))])) };
}

// ── returns ──────────────────────────────────────────────────────────────
export function xirr(flows) {
  if (flows.length < 2 || !flows.some(f => f[1] > 0) || !flows.some(f => f[1] < 0)) return null;
  const s = flows.slice().sort((a, b) => a[0].localeCompare(b[0])), t0 = Date.parse(s[0][0]), yrs = s.map(f => (Date.parse(f[0]) - t0) / (365.25 * 864e5));
  const npv = r => s.reduce((a, f, i) => a + f[1] / Math.pow(1 + r, yrs[i]), 0); let lo = -0.99, hi = 10, fl = npv(lo), fh = npv(hi); if (!(fl * fh < 0)) return null;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2, fm = npv(m); if (Math.abs(fm) < 1e-7) return m; if (fl * fm < 0) { hi = m; fh = fm; } else { lo = m; fl = fm; } } return (lo + hi) / 2;
}
// the same money on the same dates in a benchmark: every buy buys it, every sell sells it, at that day's adjusted close
export function benchmarkCompare(flows, dates, adj, endValueDate) {
  if (!flows.length || dates.length < 2) return null; const at = d => { let lo = 0, hi = dates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? adj[k] : adj[0]; };
  let units = 0; for (const [d, v] of flows) units -= v / at(d); const end = endValueDate || dates[dates.length - 1], value = units * at(end);
  return { value, xirr: xirr([...flows, [end, value]]), units };
}

// ── trade plan simulator ─────────────────────────────────────────────
// One stock, daily GARCH paths with its own residuals (signs kept). Compares a lump-sum hold, the same with stop/target
// exits (at the close that crosses them), and staged buying, all on the same random paths, after charges and estimated tax.
export function tradePlan(model, i, { amount, price, days = 63, mu = 0.08, stopPct = null, targetPct = null, tranches = 1, every = 5, mk = "IN", cfg = COST_DEFAULTS, paths = 5000, seed = 21 }) {
  const G = model.G[i], u = rng(seed), md = mu / 252, Z = G.z, nZ = Z.length, T = cfg.tax || COST_DEFAULTS.tax, longTerm = days * 365 / 252 > T.ltDays;
  const taxRate = (mk === "IN" ? (longTerm ? T.ltcgPct : T.stcgPct) : 0) / 100, afterTax = g => g > 0 ? g * (1 - taxRate) : g;
  const net = (spent, proceeds) => { const fees = charges("Buy", spent, mk, cfg).total + charges("Sell", proceeds, mk, cfg).total; return afterTax(proceeds - spent - fees); };
  const res = { hold: new Float64Array(paths), rule: new Float64Array(paths), staged: new Float64Array(paths) }; let stops = 0, targets = 0, heldDays = 0;
  const stop = stopPct != null ? 1 - stopPct / 100 : null, target = targetPct != null ? 1 + targetPct / 100 : null;
  for (let p = 0; p < paths; p++) {
    let h = G.hNext, lnS = 0, exited = false, exitV = 0, exitDay = days, units = 0, spentS = 0, feesS = 0; const lot = amount / Math.max(1, tranches);
    for (let t = 0; t <= days; t++) {
      if (t > 0) { const e = Math.sqrt(h) * Z[Math.floor(u() * nZ)]; lnS += md - h / 2 + e; h = G.omega + G.alpha * e * e + G.beta * h; }
      const S = Math.exp(lnS);
      if (tranches > 1 && t % every === 0 && t / every < tranches) { units += lot / S; spentS += lot; feesS += charges("Buy", lot, mk, cfg).total; }
      if (t > 0 && !exited && ((stop != null && S <= stop) || (target != null && S >= target))) { exited = true; exitV = amount * S; exitDay = t; if (stop != null && S <= stop) stops++; else targets++; }
    }
    const end = Math.exp(lnS), vH = amount * end;
    res.hold[p] = net(amount, vH); res.rule[p] = net(amount, exited ? exitV : vH); heldDays += exitDay;
    const pS = (tranches > 1 ? units : amount / 1) * end; res.staged[p] = tranches > 1 ? afterTax(pS - spentS - feesS - charges("Sell", pS, mk, cfg).total) : res.hold[p];
  }
  const sum = a => { const s = sorted(a); let loss = 0; for (const v of s) if (v < 0) loss++; return { mean: mean(s), p05: q0(s, 0.05), p25: q0(s, 0.25), p50: q0(s, 0.5), p75: q0(s, 0.75), p95: q0(s, 0.95), pLoss: loss / paths }; };
  return { days, amount, taxRate, longTerm, hold: sum(res.hold), rule: stopPct != null || targetPct != null ? { ...sum(res.rule), stopHit: stops / paths, targetHit: targets / paths, avgDays: heldDays / paths } : null, staged: tranches > 1 ? sum(res.staged) : null, charges: charges("Buy", amount, mk, cfg).total + charges("Sell", amount, mk, cfg).total };
}

// ── research: do these change the forecast ranges for the better? Tested on past data, never applied to the live trial ──
function fitGrid(e, gjr) {
  const vbar = e.reduce((s, x) => s + x * x, 0) / e.length; let best = { ll: -Infinity };
  for (let a = gjr ? 0.0 : 0.02; a <= 0.2; a += 0.02) for (let g = 0; g <= (gjr ? 0.24 : 0); g += 0.06) for (let b = 0.7; b <= 0.98; b += 0.02) {
    const per = a + g / 2 + b; if (per >= 0.995) continue; const w = vbar * (1 - per); let h = vbar, ll = 0;
    for (const x of e) { ll += -0.5 * (Math.log(h) + x * x / h); h = w + (a + (x < 0 ? g : 0)) * x * x + b * h; } if (ll > best.ll) best = { ll, a, g, b, w };
  }
  let h = vbar; const z = []; for (const x of e) { z.push(x / Math.sqrt(h)); h = best.w + (best.a + (x < 0 ? best.g : 0)) * x * x + best.b * h; }
  return { ...best, hNext: h, z };
}
function fan(F, H, paths, seed, flip) {
  const u = rng(seed), out = new Float64Array(paths), n = F.z.length;
  for (let p = 0; p < paths; p++) { let h = F.hNext, c = 0; for (let t = 0; t < H; t++) { let z = F.z[Math.floor(u() * n)]; if (flip && u() < 0.5) z = -z; const e = Math.sqrt(h) * z; c += e; h = F.w + (F.a + (e < 0 ? F.g : 0)) * e * e + F.b * h; } out[p] = c; }
  const s = out.sort(); return { p05: q0(s, 0.05), p25: q0(s, 0.25), p50: q0(s, 0.5), p75: q0(s, 0.75), p95: q0(s, 0.95) };
}
const qs = (r, y) => { let s = 0; for (const [t, k] of [[0.05, "p05"], [0.25, "p25"], [0.5, "p50"], [0.75, "p75"], [0.95, "p95"]]) s += 2 * ((y < r[k] ? 1 : 0) - t) * (r[k] - y); return s; };
export function researchTails(stocks, { H = [5, 21], step = 21, win = 500, paths = 500 } = {}) {
  const V = ["standard", "keepSign", "gjr", "widened"], rows = [];
  for (const s of stocks) {
    const r = []; for (let i = 1; i < s.adj.length; i++) r.push(Math.log(s.adj[i] / s.adj[i - 1])); if (r.length < win + 63) continue; const hist = Object.fromEntries(H.map(h => [h, []]));
    for (let t = win; t + Math.max(...H) <= r.length; t += step) {
      const e0 = r.slice(t - win, t), m = mean(e0), e = e0.map(x => x - m), F = fitGrid(e, false), Fg = fitGrid(e, true);
      for (const h of H) {
        const act = r.slice(t, t + h).reduce((a, b) => a + b, 0) - m * h, std = fan(F, h, paths, t + h, true), keep = fan(F, h, paths, t + h + 1, false), gjr = fan(Fg, h, paths, t + h + 2, false);
        // widened: the standard range scaled by what the stock's own last 24 forecasts needed to reach 90% coverage (conformal)
        const past = hist[h].slice(-24); let k = 1; if (past.length >= 12) { const a = past.slice().sort((x, y) => x - y); k = Math.max(0.5, Math.min(3, a[Math.min(a.length - 1, Math.ceil(0.9 * a.length))])); }
        const wide = { p05: std.p50 + (std.p05 - std.p50) * k, p25: std.p50 + (std.p25 - std.p50) * k, p50: std.p50, p75: std.p50 + (std.p75 - std.p50) * k, p95: std.p50 + (std.p95 - std.p50) * k };
        const half = (std.p95 - std.p05) / 2 || 1e-9; hist[h].push(Math.abs(act - std.p50) / half);
        rows.push({ id: s.id, t, h, act, f: { standard: std, keepSign: keep, gjr, widened: wide } });
      }
    }
  }
  const out = { stocks: new Set(rows.map(r => r.id)).size, forecasts: rows.length, horizons: {} };
  for (const h of H) {
    const x = rows.filter(r => r.h === h); if (!x.length) continue; const cell = {};
    const clusters = [...new Set(x.map(r => r.t))].sort((a, b) => a - b);
    for (const v of V) {
      const d = clusters.map(t => { const g = x.filter(r => r.t === t); return mean(g.map(r => qs(r.f.standard, r.act) - qs(r.f[v], r.act))); }), m = mean(d), s = sd(d);
      cell[v] = { in90: x.filter(r => r.act >= r.f[v].p05 && r.act <= r.f[v].p95).length / x.length, in50: x.filter(r => r.act >= r.f[v].p25 && r.act <= r.f[v].p75).length / x.length, downMiss: x.filter(r => r.act < r.f[v].p05).length / x.length, upMiss: x.filter(r => r.act > r.f[v].p95).length / x.length, score: mean(x.map(r => qs(r.f[v], r.act))), gainT: v === "standard" || !s ? 0 : m / (s / Math.sqrt(d.length)) };
    }
    out.horizons[h] = { n: x.length, dates: clusters.length, variants: cell };
  }
  return out;
}

// ── everything the Risk page needs for one book (runs in a worker thread) ──
export function analysePortfolio(P) {
  const { stocks, w, mu, events = null, H = [5, 21, 63], factors = {}, backtest = false } = P, M = buildModel(stocks, { win: 756 }); if (!M) return null;
  const base = simulate(M, w, mu, { H, paths: 6000, seed: 7 }), withEvents = events && events.some(Boolean) ? simulate(M, w, mu, { H, paths: 6000, seed: 7, events }) : null, naive = simulateNaive(M, w, mu.map(() => 0), { H, paths: 6000, seed: 13 });
  const beta = {}; if (factors.bench?.dates?.length) { const b = factorBeta(stocks, w, factors.bench.dates, factors.bench.adj); if (b) beta.market = { label: factors.bench.label, beta: b.beta, se: b.se, t: b.t, r2: b.r2, n: b.n }; } if (factors.yield?.dates?.length) { const b = factorBeta(stocks, w, factors.yield.dates, factors.yield.vals, { asChange: true }); if (b) beta.yield = { label: factors.yield.label, per10bp: b.beta * 0.1, se10bp: b.se * 0.1, t: b.t, r2: b.r2, n: b.n }; }
  return { model: { days: M.days, from: M.from, to: M.to, filledShare: M.filledShare, hist: M.hist, shortHistory: stocks.map((s, i) => M.hist[i] < 250 ? s.id : null).filter(Boolean), vols: M.G.map(g => Math.sqrt(g.hNext * 252)) }, base, withEvents, naive, stats: riskStats(stocks, w), worst: worstWindows(stocks, w), beta, backtest: backtest ? backtestPortfolio(stocks, w) : null };
}
// what-if: the same random draws before and after a trade, so the difference is the trade and not sampling noise
export function whatIf(P) {
  const { stocks, before, after, mu, H = [5, 21, 63] } = P, M = buildModel(stocks, { win: 756 }); if (!M) return null;
  const side = w => { const S = simulate(M, w, mu, { H, paths: 6000, seed: 7 }), keep = stocks.map((_, i) => w[i] > 0); return { sim: S.horizons, drawdown: S.drawdown, contrib: S.contrib, stats: riskStats(stocks.filter((_, i) => keep[i]), w.filter((_, i) => keep[i])) }; };
  return { before: side(before), after: side(after), ids: stocks.map(s => s.id) };
}
