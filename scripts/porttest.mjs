// Checks the portfolio maths against known answers: simulated data with known volatility and correlation, hand-worked
// tax lots and charges, known returns. Run: node scripts/porttest.mjs (exit code 1 on any failure). Part of the self-test.
import * as P from "../server/portmath.mjs";
import { rng } from "../server/bondmath.mjs";
let fails = 0, n = 0;
const ok = (name, cond, detail = "") => { n++; if (!cond) { fails++; console.log(`FAIL  ${name} ${detail}`); } };
const near = (name, a, b, tol) => ok(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b} ± ${tol}`);
const u = rng(5), gauss = () => { let a = 0; while (!a) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); };
const dates = k => { const out = []; let t = Date.parse("2020-01-01"); while (out.length < k) { t += 864e5; const w = new Date(t).getUTCDay(); if (w && w !== 6) out.push(new Date(t).toISOString().slice(0, 10)); } return out; };
// two stocks, 1.5% and 2.5% a day, correlation 0.5, no GARCH effects
const D = dates(1500), mk = (s, r) => { let p = 100; const adj = [p]; for (const x of r) { p *= Math.exp(x); adj.push(p); } return { id: s, dates: D.slice(0, adj.length), adj }; };
const r1 = [], r2 = []; for (let i = 0; i < 1499; i++) { const c = gauss(), a = gauss(), b = gauss(); r1.push(0.015 * (Math.SQRT1_2 * c + Math.SQRT1_2 * a)); r2.push(0.025 * (Math.SQRT1_2 * c + Math.SQRT1_2 * b)); }
const A = mk("A", r1), Bs = mk("B", r2), M = P.buildModel([A, Bs], { win: 1200 });
const R = P.riskStats([A, Bs], [0.5, 0.5], { days: 1000 }), expDaily = Math.sqrt(0.25 * 0.015 ** 2 + 0.25 * 0.025 ** 2 + 2 * 0.25 * 0.5 * 0.015 * 0.025);
near("average correlation found", R.avgCorr, 0.5, 0.07);
near("portfolio volatility matches theory", R.annVol, expDaily * Math.sqrt(252), 0.03);
ok("portfolio vol is above the independent case", R.annVol > R.annVolIfIndependent);
near("effective holdings for 50/50", R.effectiveN, 2, 1e-9);
const S = P.simulate(M, [0.5, 0.5], [0, 0], { H: [21], paths: 8000, seed: 3 }), h21 = S.horizons[21];
near("simulated 21-day spread matches theory", h21.sd, expDaily * Math.sqrt(21), 0.012);
near("risk contributions add to 100%", S.contrib.reduce((a, c) => a + c.var, 0), 1, 0.02);
ok("the more volatile stock contributes more risk", S.contrib[1].var > S.contrib[0].var);
ok("CVaR is below the 5% point", h21.cvar95 < h21.p05);
const one = P.simulate(M, [1, 0], [0, 0], { H: [21], paths: 4000, seed: 3 }); ok("a stock with no weight contributes nothing", Math.abs(one.contrib[1].var) < 1e-9);
const up = P.simulate(M, [0.5, 0.5], [0.3, 0.3], { H: [21], paths: 8000, seed: 3 }).horizons[21]; near("drift moves the centre by about μ·t", up.mean - h21.mean, 0.3 * 21 / 252, 0.012);
// correlation survives when a stock has short history: B listed late, its older dates are filled
const late = { id: "L", dates: Bs.dates.slice(1000), adj: Bs.adj.slice(1000) }, M2 = P.buildModel([A, late], { win: 1200 }); ok("short-history stock keeps a positive correlation on filled dates", M2.rho[1] > 0.3 && M2.filledShare > 0.1, JSON.stringify([M2.rho, M2.filledShare]));
const row = M2.Z.slice(0, 900), cz = (() => { const a = row.map(r => r[0]), b = row.map(r => r[1]), ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length; let c = 0, va = 0, vb = 0; for (let i = 0; i < a.length; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); })(); ok("filled residuals correlate like real ones", cz > 0.25, cz);
// asymmetric crash days stay asymmetric: signs are kept
const cr = []; for (let i = 0; i < 1499; i++) cr.push(i % 100 === 50 ? -0.12 : 0.012 * gauss()); const Mc = P.buildModel([mk("C", cr)], { win: 1400 }), Sc = P.simulate(Mc, [1], [0], { H: [5], paths: 8000, seed: 2 }).horizons[5]; ok("left tail is longer than the right when history crashes", -Sc.p01 > Sc.p95 + 0.01 || -(Sc.p05 - Sc.p50) > (Sc.p95 - Sc.p50), JSON.stringify(Sc));
// walk-forward coverage on data the model fits
const T = P.backtestPortfolio([A, Bs], [0.5, 0.5], { step: 42, win: 400, H: [21], paths: 600 }); ok("walk-forward 90% range covers 80–98% on well-behaved data", T.horizons[21].in90 > 0.8 && T.horizons[21].in90 < 0.98, JSON.stringify(T.horizons[21]));
// stress window finds a planted crash
const cr2 = r1.slice(); for (let i = 700; i < 705; i++) cr2[i] = -0.05; const W = P.worstWindows([mk("X", cr2), Bs], [0.8, 0.2], { lens: [5] })[0]; ok("worst 5-day window is the planted crash", W.from >= D[698] && W.to <= D[708] && W.ret < -0.12, JSON.stringify(W));
near("stress window: stock shares × returns add up to the portfolio's return", W.parts.reduce((t, p) => t + p.share * p.ret, 0), W.ret, 1e-9);
// factor beta recovered
{ const f = r1.map(x => x), y = r1.map((x, i) => 1.5 * x + 0.004 * gauss()); const out = P.factorBeta([mk("Y", y)], [1], D.slice(0, 1500), mk("F", f).adj, { days: 1200 }); near("beta to a factor", out.beta, 1.5, 0.05); }
// results-day effect: bigger moves on planted dates, shrunk toward 1 with few events
{ const rr = []; for (let i = 0; i < 1499; i++) rr.push(0.01 * gauss()); const days = []; for (let i = 100; i < 1400; i += 65) { rr[i] = 0.06 * gauss(); days.push(D[i + 1]); } const E = P.resultsEffect(mk("E", rr), days); ok("results days show a larger move multiple", E.multiple > 4 && E.shrunk > 2 && E.shrunk <= E.multiple, JSON.stringify(E)); const E1 = P.resultsEffect(mk("E", rr), [days[0]]); ok("one event is shrunk hard toward 1", E1.shrunk < E1.multiple || E1.multiple < 1); }
// events widen the range but keep the centre
{ const base = P.simulate(M, [1, 0], [0, 0], { H: [21], paths: 8000, seed: 9 }).horizons[21], ev = P.simulate(M, [1, 0], [0, 0], { H: [21], paths: 8000, seed: 9, events: [[{ day: 5, extraVar: 0.05 * 0.05 }], null] }).horizons[21]; ok("a results date inside the window widens the range", ev.sd > base.sd * 1.1, `${ev.sd} vs ${base.sd}`); }
// naive baseline: centre at today's price, coverage near target on iid data
{ const px = A.adj[1000], L = P.naiveLadder(A.adj.slice(0, 1001), px, { N: 21, paths: 3000 }); near("naive baseline is centred on today's price", L[20].p50 / px, 1, 0.02); ok("naive ranges widen with time", L[20].p95 - L[20].p05 > L[0].p95 - L[0].p05); }
// charges: ₹1,00,000 delivery buy on the default schedule
{ const c = P.charges("Buy", 100000, "IN"); near("brokerage capped at ₹20", c.brokerage, 20, 1e-9); near("STT 0.1%", c.stt, 100, 1e-9); near("stamp duty 0.015% on buys", c.stamp, 15, 1e-9); near("GST on brokerage, exchange and SEBI", c.gst, (20 + 2.97 + 0.1) * 0.18, 1e-6); const s = P.charges("Sell", 100000, "IN"); near("no stamp duty on sells", s.stamp, 0, 1e-9); near("DP charge on sells", s.dp, 20, 1e-9); near("small trade: 0.1% brokerage", P.charges("Buy", 10000, "IN").brokerage, 10, 1e-9); near("minimum brokerage ₹5", P.charges("Buy", 1000, "IN").brokerage, 5, 1e-9); near("a corporate action has no charges", P.charges("Buy", 100000, "IN", P.COST_DEFAULTS, "Corporate action").total, 0, 1e-9); ok("STT is not deductible", s.deductible === s.total - s.stt); }
// tax: FIFO lots, short and long term, set-off, exemption (actual fees 0 to keep the arithmetic exact)
{ const o = (date, side, qty, price, kind = "Delivery") => ({ date, sym: "Z", mk: "IN", side, qty, price, status: "executed", kind, fees: 0 });
  const R1 = P.taxReport([o("2024-01-10", "Buy", 10, 100), o("2025-06-01", "Buy", 10, 200), o("2025-08-01", "Sell", 15, 300)]), Y = R1.years[0];
  near("FIFO: oldest lot is long-term", Y.lt, 10 * 200, 1e-9); near("FIFO: next 5 from the newer lot are short-term", Y.st, 5 * 100, 1e-9); ok("financial year label", Y.fy === "2025-26", Y.fy); near("exemption applied", Y.ltTaxable, 0, 1e-9); near("tax: 20% on short-term only", Y.tax, 100, 1e-9); near("exemption left", Y.exemptionLeft, 125000 - 2000, 1e-9); ok("open lot remains", R1.open.Z[0].qty === 5);
  const R2 = P.taxReport([o("2024-01-10", "Buy", 1000, 100), o("2025-06-01", "Sell", 1000, 300)]).years[0]; near("LTCG above ₹1.25 lakh at 12.5%", R2.tax, (200000 - 125000) * 0.125, 1e-9);
  const R3 = P.taxReport([o("2024-01-10", "Buy", 100, 100), o("2025-06-01", "Sell", 100, 2100), o("2025-06-01", "Buy", 100, 500), o("2025-07-01", "Sell", 100, 400)]).years[0]; near("short-term loss sets off long-term gain", R3.ltTaxable, 200000 - 10000 - 125000, 1e-9);
  const R4 = P.taxReport([o("2025-01-10", "Buy", 10, 100), o("2025-06-01", "Sell", 10, 50, "Corporate action")]); ok("a corporate action is not a taxable sale", !R4.years.length); ok("March belongs to the earlier financial year", P.taxReport([o("2025-01-10", "Buy", 1, 1), o("2026-03-20", "Sell", 1, 2)]).years[0].fy === "2025-26"); }
// returns
near("XIRR: 10% in one year", P.xirr([["2024-01-01", -100], ["2024-12-31", 110]]), 0.1, 0.002);
ok("XIRR needs both signs", P.xirr([["2024-01-01", -100], ["2024-12-31", -10]]) === null);
{ const ds = ["2024-01-01", "2024-07-01", "2025-01-01"], B1 = P.benchmarkCompare([["2024-01-01", -100]], ds, [100, 105, 120], "2025-01-01"); near("benchmark: same money, same date", B1.value, 120, 1e-9); near("benchmark return", B1.xirr, 0.2, 0.002); const B2 = P.benchmarkCompare([["2024-01-01", -100], ["2024-07-01", 52.5]], ds, [100, 105, 120], "2025-01-01"); near("a sale sells benchmark units too", B2.value, 60, 1e-6); }
// trade plan: stop loss caps the typical loss but not the expected return; the same paths are used
{ const pl = P.tradePlan(M, 0, { amount: 100000, days: 63, mu: 0.08, stopPct: 8, targetPct: 15, tranches: 3, every: 10, paths: 3000 }); ok("stop-loss strategy has exits recorded", pl.rule.stopHit > 0.05 && pl.rule.targetHit > 0.05, JSON.stringify(pl.rule)); ok("rule's worst 5% is less bad than holding", pl.rule.p05 > pl.hold.p05); near("rule's expected result stays near holding's (no free lunch)", pl.rule.mean, pl.hold.mean, 3000); ok("staged buying exists and has charges in it", pl.staged && pl.staged.mean < pl.hold.mean + 3000); ok("costs are subtracted", pl.charges > 0); }
// research: a stock with crash days favours keeping signs; report shape
{ const Rr = P.researchTails([mk("C", cr)], { H: [5], step: 63, win: 400, paths: 300 }); ok("research reports all variants", ["standard", "keepSign", "gjr", "widened"].every(k => Rr.horizons[5].variants[k])); }
console.log(`portfolio maths tests: ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
