// Heavy maths runs here, off the web server's thread: backtests, parameter validation, per-stock learning.
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Q = require("../web/model.js");

// ── stage 2 helpers: band factor κ and drift correction μ on top of a stock's model ──
// rescale a stored forecast to a new κ ratio and drift shift (exact for log-symmetric scaling)
function adjust(r, kr, mu) {
  const m = r.median, sh = Math.exp(mu * r.H / 52), f = q => m * Math.pow(q / m, kr) * sh;
  return { ...r, median: m * sh, p05: f(r.p05), p25: f(r.p25), p75: f(r.p75), p95: f(r.p95) };
}
const QS = r => Q.quantileScore([[0.05, r.p05], [0.25, r.p25], [0.5, r.median], [0.75, r.p75], [0.95, r.p95]], r.actual) / r.p0;
const cover = rows => rows.filter(r => r.actual >= r.p05 && r.actual <= r.p95).length / rows.length;
function fit(train, grid, n0, cap = 0.15) {
  // drift bias: annualised mean log error, shrunk toward 0 by n/(n+n0)
  const b = Q.mean(train.map(r => Math.log(r.actual / r.median) * 52 / r.H)), mu = Math.max(-cap, Math.min(cap, b * train.length / (train.length + n0)));
  let best = { kr: 1, s: Infinity };
  for (const kr of grid) { const s = Q.mean(train.map(r => QS(adjust(r, kr, mu)))); if (s < best.s) best = { kr, s }; }
  return { kr: best.kr, mu };
}

// ── stage 1: choose this stock's model specification ──
// Candidates come from the standard toolkit in the reference texts: GARCH(1,1) vs EWMA (RiskMetrics) vs constant
// volatility; bootstrapped residuals (filtered historical simulation) vs Student-t vs Gaussian shocks; 2, 3 or 5 years
// of history; drift from CAPM, the risk-free rate (martingale), momentum, valuation or Ornstein–Uhlenbeck mean reversion.
const DIMS = [
  ["vol", ["garch", "ewma", "const", "rv"]],
  ["shock", ["fhs", "t", "gaussian"]],
  ["window", [104, 156, 260]],
  ["drift", [["capm"], ["rf"], ["capm", "momentum"], ["capm", "valuation"], ["capm", "meanrev"]]]
];
const STEP = 3, HS = [4, 13, 26], PATHS = 600;
const key = s => JSON.stringify([s.vol, s.shock, s.window, s.drift]);
const describe = s => `${{ garch: "GARCH(1,1)", ewma: "EWMA", const: "constant", rv: "realised (HAR)" }[s.vol]} volatility · ${{ fhs: "bootstrapped", t: "Student-t", gaussian: "Gaussian" }[s.shock]} shocks · ${Math.round(s.window / 52)}-yr window · drift: ${s.drift.join(" + ")}`;

function selectSpec(c, P) {
  const MIN_GAIN = P.learn.minGain ?? 0.01, DM_CRIT = P.learn.dmCrit ?? 1.645, HOLD = P.learn.holdout ?? 0.3;
  const n = c.wk.length, i0min = 60, base = Q.specOf({ drift: Object.keys(P.drift).filter(k => P.drift[k]?.on && k !== "sentiment") });
  if (!base.drift.length) base.drift = ["capm"];
  if (P.learn.selectModels === false) return { spec: base, accepted: false, base, describe: describe(base), note: "per-stock model selection is switched off on the Algorithms page", tested: 0 };
  const cut = i0min + Math.floor((1 - HOLD) * (n - i0min)), cache = new Map(), memo = new Map(), points = [];
  for (const H of HS) for (let i = i0min; i + H < n; i += STEP) points.push([i, H]);
  const sel = points.filter(([i, H]) => i + H <= cut), hold = points.filter(([i]) => i >= cut);
  if (sel.length < 40 || hold.length < 15) return { spec: base, accepted: false, base, describe: describe(base), note: `only ${n} weeks of price history: too short to test alternatives, so the standard model is used`, nSel: sel.length, nHold: hold.length, tested: 0 };
  const rowsFor = spec => { const k = key(spec); if (!memo.has(k)) { const m = new Map(); for (const [i, H] of points) { const e = Q.evaluate(c, i, i + H, { paths: PATHS, spec, cache }); if (e) m.set(i + "|" + H, e); } memo.set(k, m); } return memo.get(k); };
  const score = (spec, pts) => { const m = rowsFor(spec), v = pts.map(([i, H]) => m.get(i + "|" + H)).filter(Boolean); return v.length ? Q.mean(v.map(r => r.qscore)) : Infinity; };
  // coordinate search on the selection period only (outcomes known before the hold-out starts)
  let cur = { ...base }, curS = score(cur, sel); const trail = [];
  for (const [dim, opts] of DIMS) {
    let best = cur, bestS = curS;
    for (const o of opts) { const s = { ...cur, [dim]: o }, v = score(s, sel); trail.push({ dim, opt: o, s: v }); if (v < bestS * (1 - MIN_GAIN) && v < bestS) { best = s; bestS = v; } }
    cur = best; curS = bestS;
  }
  const baseSel = score(base, sel);
  // hold-out test: paired Diebold–Mariano on per-forecast loss differences, Newey–West lag covering the overlap
  const mb = rowsFor(base), mc = rowsFor(cur), pairs = hold.map(([i, H]) => [mb.get(i + "|" + H), mc.get(i + "|" + H)]).filter(([a, b]) => a && b).sort((x, y) => x[0].d0.localeCompare(y[0].d0));
  const d = pairs.map(([a, b]) => a.qscore - b.qscore), dm = Q.dmTest(d, Math.ceil(Math.max(...HS) / STEP));
  const covB = Q.mean(pairs.map(([a]) => a.in90 ? 1 : 0)), covC = Q.mean(pairs.map(([, b]) => b.in90 ? 1 : 0));
  const same = key(cur) === key(base), holdB = Q.mean(pairs.map(([a]) => a.qscore)), holdC = Q.mean(pairs.map(([, b]) => b.qscore));
  const accepted = !same && dm.t > DM_CRIT && Math.abs(covC - 0.9) <= Math.abs(covB - 0.9) + 0.05;
  const note = same ? "no alternative beat the standard model on the selection period"
    : accepted ? `beat the standard model on ${pairs.length} unseen hold-out forecasts (score ${(100 * (1 - holdC / holdB)).toFixed(1)}% better, Diebold–Mariano t = ${dm.t.toFixed(2)})`
    : `best alternative did not hold up on unseen data (Diebold–Mariano t = ${dm.t.toFixed(2)}, needs > ${DM_CRIT}); standard model kept`;
  return { spec: accepted ? cur : base, candidate: cur, base, accepted, note, describe: describe(accepted ? cur : base), candDescribe: describe(cur),
    selScore: curS, baseSel, holdScore: holdC, baseHold: holdB, dm, covBase: covB, covCand: covC, nSel: sel.length, nHold: pairs.length, tested: memo.size, holdFrom: c.wd[cut], trail,
    rows: [...(accepted ? mc : mb).values()] };
}

function learnCompany(c, preds, P) {
  Q.setParams(P);
  const L = P.learn, S = selectSpec(c, P);
  const rows = (S.rows || []).map(e => ({ src: "backtest", d1: e.d1, H: e.H, p0: e.p0, actual: e.actual, median: e.median, p05: e.p05, p25: e.p25, p75: e.p75, p95: e.p95 }));
  if (!S.rows) for (const H of [4, 13, 26]) for (let i = 60; i + H < c.wk.length; i += 4) { const e = Q.evaluate(c, i, i + H, { paths: PATHS, spec: S.spec }); if (e) rows.push({ src: "backtest", d1: e.d1, H, p0: e.p0, actual: e.actual, median: e.median, p05: e.p05, p25: e.p25, p75: e.p75, p95: e.p95 }); }
  delete S.rows;
  for (const p of preds) rows.push({ src: p.kind, d1: p.actual_date, H: p.H, p0: p.p0, actual: p.actual, median: p.median, p05: p.p05, p25: p.p25, p75: p.p75, p95: p.p95 });
  rows.sort((a, b) => a.d1.localeCompare(b.d1));
  if (rows.length < L.minScored * 3) return { cid: c.id, model: S, n: rows.length, epochs: [], accepted: false, note: "not enough scored forecasts yet" };
  const K = 5, cut = i => Math.floor(rows.length * i / K), epochs = [];
  for (let f = 2; f < K; f++) {                 // expanding-window walk-forward: train on the past, validate on the next block
    const train = rows.slice(0, cut(f)), valid = rows.slice(cut(f), cut(f + 1));
    const { kr, mu } = fit(train, L.kappaGrid, L.shrinkN0, L.muCap ?? 0.15);
    const base = Q.mean(valid.map(QS)), adj = Q.mean(valid.map(r => QS(adjust(r, kr, mu))));
    epochs.push({ epoch: f - 1, nTrain: train.length, nValid: valid.length, kr, mu, base, adj, covBase: cover(valid), covAdj: cover(valid.map(r => adjust(r, kr, mu))), accepted: adj < base * (1 - L.acceptMargin) });
  }
  const wins = epochs.filter(e => e.accepted).length, meanGain = Q.mean(epochs.map(e => (e.base - e.adj) / e.base));
  const final = fit(rows, L.kappaGrid, L.shrinkN0, L.muCap ?? 0.15);
  const accepted = wins > epochs.length / 2 && meanGain > 0;   // must win a majority of out-of-sample epochs
  return { cid: c.id, model: S, n: rows.length, nLive: preds.length, epochs, accepted, kappaAdj: accepted ? final.kr : 1, muAdj: accepted ? final.mu : 0, fitted: final, meanGain, coverage: cover(rows), note: accepted ? `adjustment beat the stock's model in ${wins}/${epochs.length} out-of-sample epochs` : `no adjustment (won ${wins}/${epochs.length} epochs)` };
}

// ── 90-day ladder learning, per stock ──
// 1 replay: every 2 weeks over the stock's history, forecast all 90 trading days using only data up to that date
// 2 horizon factors κ for 1–5, 6–20, 21–60, 61–90 days, walk-forward epochs on later replays (+ live ladder rows)
// 3 factor weights on the simplex (CAPM, valuation, momentum, sample mean, mean reversion, risk-free), chosen on the
//   past and kept only if out-of-sample errors beat CAPM-only (Diebold–Mariano, Newey–West)
const FACT = ["capm", "valuation", "momentum", "sample", "meanrev", "rf"];
function simplex(k, step) { const out = []; const rec = (i, left, cur) => { if (i === k - 1) { out.push([...cur, left]); return; } for (let v = 0; v <= left + 1e-9; v += step) rec(i + 1, +(left - v).toFixed(6), [...cur, +v.toFixed(6)]); }; rec(0, 1, []); return out; }
const GRID = simplex(FACT.length, 0.1);
function ladderLearn(c, live, P, spec, q) {
  Q.setParams(P);
  const n = c.dd.length, idxOf = new Map(c.dd.map((d, i) => [d, i])), runs = [], rows = [];
  for (let i = 60; i < c.wk.length; i += 2) {
    const j = idxOf.get(c.wd[i]); if (j == null || j < 250 || j + 1 >= n) continue;
    const A = Q.analyse(c, { idx: i, H: 13, paths: 200, light: true, spec, allSignals: true }); if (!A) continue;
    const sig = Object.fromEntries(A.sig.map(s => [s.id, s.mu])), L = Q.ladder(c, { j, mu: A.dr.mu, paths: 1200 }); if (!L) continue;   // replay on total-return basis (q = 0)
    const run = { d0: c.dd[j], j, sig, vol: L.annVol }; runs.push(run);
    for (const r of L.rows) { if (j + r.h >= n) break; rows.push({ d0: run.d0, h: r.h, b: Q.bucketOf(r.h), p0: L.px, actual: c.dA[j + r.h] * L.px / c.dA[j], median: r.p50, p05: r.p05, p25: r.p25, p75: r.p75, p95: r.p95 }); }
  }
  for (const r of live) rows.push({ d0: r.made, h: r.h, b: Q.bucketOf(r.h), p0: r.p0, actual: r.actual, median: r.p50, p05: r.p05, p25: r.p25, p75: r.p75, p95: r.p95, live: 1 });
  rows.sort((a, b) => a.d0.localeCompare(b.d0));
  if (runs.length < 30) return { cid: c.id, n: rows.length, runs: runs.length, note: `only ${runs.length} replay dates: not enough history yet`, kappa: [1, 1, 1, 1], kappaOk: [0, 0, 0, 0], weights: null };
  // (2) horizon factors per bucket
  const kap = [1, 1, 1, 1], kapOk = [0, 0, 0, 0], bucketInfo = [];
  for (let b = 0; b < 4; b++) {
    const R = rows.filter(r => r.b === b), dates = [...new Set(R.map(r => r.d0))], K = 5, cut = k => dates[Math.floor(dates.length * k / K)] || "9999", epochs = [];
    const score = (rs, kr) => Q.mean(rs.map(r => QS(adjust({ ...r, H: r.h / 5 }, kr, 0))));
    for (let f = 2; f < K; f++) {
      const tr = R.filter(r => r.d0 < cut(f) && dateAdd(r.d0, r.h) < cut(f)), va = R.filter(r => r.d0 >= cut(f) && r.d0 < cut(f + 1)); if (tr.length < 50 || va.length < 20) continue;
      let best = 1, bs = Infinity; for (const kr of P.learn.kappaGrid) { const s = score(tr, kr); if (s < bs) { bs = s; best = kr; } }
      const base = score(va, 1), adj = score(va, best); epochs.push({ kr: best, base, adj, win: adj < base });
    }
    let fin = 1, fs = Infinity; for (const kr of P.learn.kappaGrid) { const s = score(R, kr); if (s < fs) { fs = s; fin = kr; } }
    const wins = epochs.filter(e => e.win).length, ok = epochs.length >= 2 && wins > epochs.length / 2 && Q.mean(epochs.map(e => e.base - e.adj)) > 0;
    kap[b] = ok ? fin : 1; kapOk[b] = ok ? 1 : 0;
    bucketInfo.push({ b, n: R.length, cov90: cover(R), cov90adj: cover(R.map(r => adjust({ ...r, H: r.h / 5 }, kap[b], 0))), epochs: epochs.length, wins, kr: fin });
  }
  // (3) factor weights: realised annualised log return over 20 and 60 trading days vs Σ wᵢ μᵢ − σ²/2
  const obs = []; for (const run of runs) for (const h of [20, 60]) { if (run.j + h >= n) continue; obs.push({ d0: run.d0, h, y: Math.log(c.dA[run.j + h] / c.dA[run.j]) * 252 / h, s: FACT.map(k => run.sig[k] ?? run.sig.capm), v2: run.vol * run.vol / 2 }); }
  const err = (o, w) => { let m = 0; for (let i = 0; i < w.length; i++) m += w[i] * o.s[i]; return (o.y - (m - o.v2)) ** 2; };
  const fitW = os => { let best = null, bs = Infinity; for (const w of GRID) { let s = 0; for (const o of os) s += err(o, w); if (s < bs) { bs = s; best = w; } } return best; };
  // weights are shrunk halfway toward CAPM-only before testing (guards against fitting one long trend); the
  // shrunk weights are what is validated and what is used
  const shrink = w => w.map((x, i) => +(0.5 * x + 0.5 * (FACT[i] === "capm" ? 1 : 0)).toFixed(3));
  const capmW = FACT.map(k => k === "capm" ? 1 : 0), dates = [...new Set(obs.map(o => o.d0))], K = 5, cut = k => dates[Math.floor(dates.length * k / K)] || "9999", diffs = [], wEpochs = [];
  for (let f = 2; f < K; f++) {
    const tr = obs.filter(o => o.d0 < cut(f) && dateAdd(o.d0, o.h) < cut(f)), va = obs.filter(o => o.d0 >= cut(f) && o.d0 < cut(f + 1)); if (tr.length < 30 || va.length < 10) continue;
    const w = shrink(fitW(tr)); va.forEach(o => diffs.push({ d0: o.d0, d: err(o, capmW) - err(o, w) }));
    wEpochs.push({ w, base: Q.mean(va.map(o => err(o, capmW))), adj: Q.mean(va.map(o => err(o, w))) });
  }
  diffs.sort((a, b) => a.d0.localeCompare(b.d0));
  const dm = Q.dmTest(diffs.map(x => x.d), 6), wWins = wEpochs.filter(e => e.adj < e.base).length, wFinal = obs.length >= 40 ? shrink(fitW(obs)) : capmW;
  const wOk = wEpochs.length >= 2 && wWins > wEpochs.length / 2 && dm.t > (P.learn.dmCrit ?? 1.645) && JSON.stringify(wFinal) !== JSON.stringify(capmW);
  const weights = Object.fromEntries(FACT.map((k, i) => [k, wFinal[i]]).filter(([, v]) => v > 0));
  return { cid: c.id, n: rows.length, nLive: live.length, runs: runs.length, from: runs[0]?.d0, kappa: kap, kappaOk: kapOk, buckets: bucketInfo,
    weights: wOk ? weights : null, weightsTried: weights, weightsDm: dm, weightsEpochs: wEpochs.map(e => ({ base: e.base, adj: e.adj })),
    note: `${runs.length} replayed outlooks since ${runs[0]?.d0}; band factors kept for ${kapOk.reduce((a, x) => a + x, 0)}/4 horizon ranges; factor weights ${wOk ? "kept" : "not better than CAPM out of sample"} (DM t ${dm.t.toFixed(2)})` };
}
const dateAdd = (d, tradingDays) => new Date(Date.parse(d) + Math.round(tradingDays * 7 / 5) * 864e5).toISOString().slice(0, 10);

parentPort.on("message", async ({ id, task, payload }) => {
  try {
    let out;
    if (task === "backtest") { Q.setParams(payload.params); out = Q.backtest(payload.companies, { paths: payload.paths || 800, step: payload.step || 8, horizons: payload.horizons, adj: payload.adj }); out.rows = out.rows.map(r => ({ id: r.id, H: r.H, d1: r.d1, in50: r.in50, in90: r.in90, dirHit: r.dirHit, err: r.err, pit: r.pit, iscore: r.iscore, qscore: r.qscore })); }
    else if (task === "validate") {
      const run = p => { Q.setParams(p); return Q.backtest(payload.companies, { paths: 700, step: 8 }).sum; };
      const active = run(payload.active), cand = run(payload.candidate);
      const better = cand.iscore < active.iscore && Math.abs(cand.in90 - 0.9) <= Math.abs(active.in90 - 0.9) + 0.02;
      out = { active, candidate: cand, better };
    }
    else if (task === "learn") out = payload.companies.map(c => learnCompany(c, payload.preds[c.id] || [], payload.params));
    else if (task === "ladder") out = payload.companies.map(c => ladderLearn(c, payload.live[c.id] || [], payload.params, payload.specs[c.id] || null));
    else if (task === "bonds") out = (await import("./bondanalysis.mjs")).analyse(payload);
    parentPort.postMessage({ id, ok: true, out });
  } catch (e) { parentPort.postMessage({ id, ok: false, error: String(e && e.stack || e) }); }
});
