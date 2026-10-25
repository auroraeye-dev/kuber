// Walk-forward backtest of the standard model on the stored (adjusted) price history → data/backtest.json
// Every forecast uses only data available on its as-of date. Run: node scripts/run_backtest.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, getSetting } from "../server/db.mjs";
import { loadBase, company, STATE } from "../server/companies.mjs";
const Q = createRequire(import.meta.url)("../web/model.js");

loadBase();
const P = getSetting("params") || Q.DEFAULT_PARAMS; Q.setParams(P);
const list = Object.keys(STATE.base).map(id => company(id)).map(c => c.live ? { ...c, wd: c.wd.slice(0, -1), wk: c.wk.slice(0, -1), wkRaw: c.wkRaw?.slice(0, -1) } : c);
const HS = [4, 13, 26, 52], STEP = 6, PATHS = 1500, t0 = Date.now();

const rows = Q.backtest(list, { paths: PATHS, step: STEP, horizons: HS }).rows;
const sum = rs => Q.summarise(rs);
const byH = Object.fromEntries(HS.map(H => [H, sum(rows.filter(r => r.H === H))]));
const byStock = Object.fromEntries(list.map(c => [c.id, sum(rows.filter(r => r.id === c.id))]).filter(([, v]) => v));
const pitHist = Array(10).fill(0); for (const r of rows) pitHist[Math.min(9, Math.floor(r.pit * 10))]++;
const baseUp = Q.mean(rows.map(r => (r.actual > r.p0 ? 1 : 0)));
const climatologyBrier = Q.mean(rows.map(r => (baseUp - (r.actual > r.p0 ? 1 : 0)) ** 2));

// drift-signal variants (same dates, same random numbers)
const variant = drift => { Q.setParams({ ...P, drift: Object.fromEntries(Object.entries(P.drift).map(([k, v]) => [k, typeof v === "object" ? { ...v, on: drift.includes(k) } : v])) }); const s = Q.backtest(list, { paths: 800, step: STEP * 2, horizons: [13, 26, 52] }).sum; Q.setParams(P); return { brier: +s.brier.toFixed(4), dir: +s.dir.toFixed(3), in90: +s.in90.toFixed(3), qscore: +s.qscore.toFixed(4) }; };
const variants = { capm: variant(["capm"]), full: variant(["capm", "valuation", "momentum", "sample"]), noval: variant(["capm", "momentum", "sample"]), nomom: variant(["capm", "valuation", "sample"]) };

// does the 0–100 profile score rank future returns? cross-sectional Spearman IC, every 8 weeks
function rank(a) { const o = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = Array(a.length); o.forEach(([, i], k) => r[i] = k); return r; }
function spearman(a, b) { const ra = rank(a), rb = rank(b), n = a.length, ma = Q.mean(ra), mb = Q.mean(rb); let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { s += (ra[i] - ma) * (rb[i] - mb); sa += (ra[i] - ma) ** 2; sb += (rb[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); }
const scoreIC = {};
for (const H of [13, 26]) {
  const dates = [...new Set(list.flatMap(c => c.wd))].sort(), ics = [], spread = [];
  for (let k = 80; k < dates.length; k += 8) {
    const d = dates[k], pts = [];
    for (const c of list) { const i = Q.idxAtOrBefore(c, d); if (i < 60 || i + H >= c.wk.length || c.wd[i] !== d) continue; const A = Q.analyse(c, { idx: i, H, paths: 600 }); if (A?.score != null) pts.push([A.score, c.wk[i + H] / c.wk[i] - 1]); }
    if (pts.length < 8) continue;
    ics.push(spearman(pts.map(p => p[0]), pts.map(p => p[1])));
    const s = pts.slice().sort((a, b) => b[0] - a[0]), q = Math.max(2, Math.floor(s.length / 4));
    spread.push([Q.mean(s.slice(0, q).map(p => p[1])), Q.mean(s.slice(-q).map(p => p[1]))]);
  }
  const ic = Q.mean(ics), sd = Q.sd(ics);
  scoreIC[H] = { ic, icT: ic / (sd / Math.sqrt(ics.length)), periods: ics.length, top: Q.mean(spread.map(x => x[0])), bottom: Q.mean(spread.map(x => x[1])), topMinusBottom: Q.mean(spread.map(x => x[0] - x[1])) };
}

const out = { run: new Date().toISOString().slice(0, 10), basis: "adjusted for dividends and splits; demerger days excluded", n: rows.length, all: sum(rows), climatologyBrier, baseUp, byH, byStock, pitHist, variants, kappa: Q.P.vol.kappaKnots, scoreIC };
fs.writeFileSync(path.join(ROOT, "data", "backtest.json"), JSON.stringify(out));
console.log(JSON.stringify({ n: out.n, all: out.all, byH: Object.fromEntries(Object.entries(byH).map(([h, s]) => [h, { n: s.n, in50: +s.in50.toFixed(3), in90: +s.in90.toFixed(3), dir: +s.dir.toFixed(3), qs: +s.qscore.toFixed(4) }])), variants, scoreIC, pitHist, secs: (Date.now() - t0) / 1000 }, null, 1));
