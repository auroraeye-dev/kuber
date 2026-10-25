// Checks every bond-maths function against textbook values, published data or simulated data with known answers.
// Run: node scripts/bondtest.mjs   (exit code 1 on any failure). Part of the self-test.
import * as B from "../server/bondmath.mjs";
let fails = 0, n = 0;
const ok = (name, cond, detail = "") => { n++; if (!cond) { fails++; console.log(`FAIL  ${name} ${detail}`); } };
const near = (name, a, b, tol) => ok(name, Math.abs(a - b) <= tol, `got ${a}, expected ${b} ± ${tol}`);

// normal distribution (reference values from standard tables)
near("erf(1)", B.erf(1), 0.8427007929, 2e-7);
near("Φ(1.96)", B.normCdf(1.96), 0.9750021, 2e-7);
near("Φ(−1)", B.normCdf(-1), 0.1586553, 2e-7);
near("χ²(1) tail at 3.841", B.chi2p1(3.841459), 0.05, 1e-5);

// bond pricing: par bond, zero-coupon bond, and a discount bond (5% coupon, 10 years, 6% yield, semi-annual)
near("par bond = 100", B.bondPrice(5, 5, 10), 100, 1e-9);
near("zero-coupon 10y at 5%", B.bondPrice(0, 5, 10), 100 / 1.025 ** 20, 1e-9);
near("5% 10y at 6%", B.bondPrice(5, 6, 10), 92.5613, 1e-4);
const R = B.bondRisk(5, 5, 10), P0 = B.bondPrice(5, 5, 10), up = B.bondPrice(5, 5.01, 10), dn = B.bondPrice(5, 4.99, 10);
near("Macaulay duration 5% 10y par", R.macaulay, 7.9894, 1e-3);
near("modified = numerical", R.modified, -(up - dn) / (2 * P0 * 0.0001), 1e-4);
near("convexity = numerical", R.convexity, (up + dn - 2 * P0) / (P0 * 1e-8), 0.05);
near("DV01 per 100", R.dv01, (dn - up) / 2, 1e-5);
const S = B.shock(5, 5, 10, 100); near("+100bp: duration+convexity within 0.05% of exact", S.approxPct, S.exactPct, 0.05);
const CR = B.carryRoll(() => 5, 10); near("flat curve: no roll-down", CR.rollBp, 0, 1e-9); near("flat curve: 1-year return = coupon", CR.totalPct, 5, 1e-9);

// Nelson–Siegel–Svensson: CCIL's published India curve for 22 Oct 2026 vs the traded 10-year benchmark YTM (7.4553%)
const ccil = { b0: 8.385, b1: -2.9681, b2: -19.758, b3: 20.0, t1: 2.3088, t2: 2.0934 };
near("CCIL NSS 10y", B.nss(10, ccil), 7.4495, 5e-4);
ok("CCIL NSS 10y within 2 bp of traded benchmark", Math.abs(B.nss(10, ccil) - 7.4553) < 0.02);
near("NSS short end → β0+β1", B.nss(1e-9, ccil), ccil.b0 + ccil.b1, 1e-6);
// fit recovers a known curve
const truth = { b0: 5.1, b1: -1.2, b2: -0.8, b3: 1.5, t1: 1.7, t2: 9 }, mats = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30], ys = mats.map(m => B.nss(m, truth));
const F = B.fitNSS(mats, ys); ok("NSS fit reproduces a known curve (< 0.5 bp)", F && F.maxErrBp < 0.5, JSON.stringify(F));

// linear algebra
const E = B.eigSym([[2, 1], [1, 2]]); near("eigen 1", E.values[0], 3, 1e-10); near("eigen 2", E.values[1], 1, 1e-10);
const E3 = B.eigSym([[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 2]]); { const v = E3.vectors[0], Av = [4 * v[0] + v[1] + 0.5 * v[2], v[0] + 3 * v[1] + 0.2 * v[2], 0.5 * v[0] + 0.2 * v[1] + 2 * v[2]]; near("A·v = λ·v", Math.hypot(...Av.map((x, i) => x - E3.values[0] * v[i])), 0, 1e-9); }
const x = B.solve([[2, 1], [1, 3]], [3, 5]); near("solve x", x[0], 0.8, 1e-12); near("solve y", x[1], 1.4, 1e-12);

// simulated data with known answers
const u = B.rng(42), gauss = () => { let a = 0; while (!a) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); };
{ const xs = [], yv = []; for (let i = 0; i < 4000; i++) { const xi = gauss(); xs.push(xi); yv.push(0.5 + 2 * xi + gauss()); } const r = B.olsNW(yv, xs, 5); near("OLS slope", r.beta, 2, 0.05); near("HAC s.e. ≈ iid s.e. on iid data", r.se, 1 / Math.sqrt(4000), 0.004); }
{ const a = 0.08, b = 0.9, w = 0.02, d = []; let h = w / (1 - a - b); for (let i = 0; i < 20000; i++) { const e = Math.sqrt(h) * gauss(); d.push(e); h = w + a * e * e + b * h; } const G = B.garch(d); near("GARCH α recovered", G.alpha, a, 0.03); near("GARCH β recovered", G.beta, b, 0.04);
  const iid = Array.from({ length: 5000 }, () => gauss() * 5); const G2 = B.garch(iid), R2 = B.fhsRange(G2, 21, 6000); near("21-day spread of iid 5 bp/day ≈ 5·√21", R2.sdBp, 5 * Math.sqrt(21), 1.5); }
{ const k = 6, rows = []; for (let i = 0; i < 3000; i++) { const f = gauss() * 5; rows.push(Array.from({ length: k }, () => f + gauss() * 0.5)); } const P = B.pca(rows); ok("PCA: one common factor explains > 95%", P.share[0] > 0.95, P.share[0]); }
{ const y = [4]; let h = 0.0004; for (let i = 0; i < 4000; i++) { const e = Math.sqrt(h) * gauss(); y.push(y[i] + e); h = 0.000008 + 0.06 * e * e + 0.92 * h; } const T = B.backtestRange(y, { H: 21, step: 21, win: 1000, paths: 1000 }); ok("range backtest on simulated GARCH: 90% range covers 80–98%", T && T.in90 > 0.8 && T.in90 < 0.98, JSON.stringify(T)); }

// data cleaning: a one-minute bad print is removed, a genuine jump that persists is kept
{ const spike = [[1, 4.642], [2, 4.642], [3, 4.648], [4, 4.645], [5, 4.645], [6, 4.722], [7, 4.658], [8, 4.656], [9, 4.656], [10, 4.652]], step = [[1, 4.6], [2, 4.6], [3, 4.61], [4, 4.6], [5, 4.7], [6, 4.71], [7, 4.7], [8, 4.71], [9, 4.7]];
  ok("isolated spike removed", [...B.isolatedSpikes(spike)].join() === "5"); ok("genuine jump kept", B.isolatedSpikes(step).size === 0); }
// the same rule on stock prices (log-price, 1% / 0.4%): a one-sample bad print is dropped, a real 2% move that holds is kept
{ const px = [100, 100.1, 100.05, 100.1, 103.5, 100.08, 100.12, 100.1, 100.15].map((p, i) => ({ ts: i, price: p })), mv = [100, 100.1, 100.05, 102.1, 102.2, 102.15, 102.1, 102.2].map((p, i) => ({ ts: i, price: p }));
  ok("stock bad print dropped", B.withoutSpikes(px, r => Math.log(r.price), { jump: 0.01, agree: 0.004 }).length === px.length - 1); ok("stock real move kept", B.withoutSpikes(mv, r => Math.log(r.price), { jump: 0.01, agree: 0.004 }).length === mv.length); }

// NY Fed recession model at published readings: spread +1.70 → about 5% (reported 5.2%, Feb 2018); −1.70 → about 71% (reported 70.85%, May 2023)
near("recession probability at +1.70", B.recessionProb(1.70), 0.054, 0.004);
near("recession probability at −1.70", B.recessionProb(-1.70), 0.706, 0.004);

console.log(`bond maths tests: ${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
