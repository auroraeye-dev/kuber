// Bond-market analysis: turns the stored official and live data into KUBER's bond page. Runs in a worker thread
// (several seconds of work: curve fits, principal components, GARCH with a 30-year walk-forward test, stock links).
// Every number is either an official figure or computed here from official figures; methods are named on the page.
import * as M from "./bondmath.mjs";

const UST = [["1M", 1 / 12], ["2M", 2 / 12], ["3M", 0.25], ["4M", 1 / 3], ["6M", 0.5], ["1Y", 1], ["2Y", 2], ["3Y", 3], ["5Y", 5], ["7Y", 7], ["10Y", 10], ["20Y", 20], ["30Y", 30]];
const PCA_T = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"];
const r2 = x => Number.isFinite(x) ? Math.round(x * 100) / 100 : null, r4 = x => Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null, r1 = x => Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
// value of an aligned series at index i, or at the nearest earlier index that has one
const at = (a, i) => { for (let k = Math.min(i, a.length - 1); k >= 0; k--) if (a[k] != null) return [a[k], k]; return [null, -1]; };
const lastIdx = a => { for (let k = a.length - 1; k >= 0; k--) if (a[k] != null) return k; return -1; };
const weekly = (dates, vals, from) => { const out = []; let lastWk = null; for (let i = 0; i < dates.length; i++) { if (dates[i] < from || vals[i] == null) continue; const wk = dates[i].slice(0, 8) + String(Math.floor((+dates[i].slice(8) - 1) / 7)); if (wk !== lastWk || i === dates.length - 1) out.push([dates[i], r4(vals[i])]); else out[out.length - 1] = [dates[i], r4(vals[i])]; lastWk = wk; } return out; };
const thin = (pairs, from) => { const d = pairs.filter(p => p[0] >= from); return weekly(d.map(p => p[0]), d.map(p => p[1]), from); };
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

function stats(vals, i, { pctFrom = 0, zWin = 252 } = {}) {
  const [v] = at(vals, i), hist = vals.slice(pctFrom, i + 1).filter(x => x != null), w = vals.slice(Math.max(0, i - zWin), i + 1).filter(x => x != null);
  const ago = n => { const [p] = at(vals, i - n); return v != null && p != null ? (v - p) * 100 : null; };
  return { y: r4(v), d1: r1(ago(1)), d5: r1(ago(5)), d21: r1(ago(21)), d252: r1(ago(252)), pct: r2(M.percentileRank(hist, v)), z: r2(w.length > 30 ? (v - M.mean(w)) / M.sd(w) : null), n: hist.length };
}
// daily changes (bp) of an aligned series over the last `win` observations where both days exist
function changes(vals, end, win) { const d = []; for (let i = Math.max(1, end - win + 1); i <= end; i++) if (vals[i] != null && vals[i - 1] != null) d.push((vals[i] - vals[i - 1]) * 100); return d; }
function volBlock(name, series, end, { label, win = 2520, H = [5, 21], backtest = true } = {}) {
  const d = changes(series, end, win); if (d.length < 500) return { name, label, building: true, have: d.length, need: 500 };
  const G = M.garch(d), [y] = at(series, end), sd20 = M.sd(d.slice(-20)), sd60 = M.sd(d.slice(-60));
  const ranges = Object.fromEntries(H.map(h => { const R = M.fhsRange(G, h, 6000, 11 + h); return [h, { p05: r4(y + R.p05 / 100), p25: r4(y + R.p25 / 100), p50: r4(y + R.p50 / 100), p75: r4(y + R.p75 / 100), p95: r4(y + R.p95 / 100), sdBp: r1(R.sdBp) }]; }));
  let bt = null; if (backtest) { const full = series.filter(x => x != null); bt = M.backtestRange(full, { H: 21, step: 21, win: 1000, paths: 1000 }); if (bt) for (const k of ["in90", "in50", "benchIn90", "kupiecP", "score", "benchScore", "dmT"]) bt[k] = r4(bt[k]); }
  return { name, label, y: r4(y), dailyBp: { now: r2(Math.sqrt(G.hNext)), long: r2(Math.sqrt(G.vbar)), d20: r2(sd20), d60: r2(sd60) }, annualBp: { now: r1(Math.sqrt(G.hNext * 252)), long: r1(Math.sqrt(G.vbar * 252)) }, garch: { alpha: r4(G.alpha), beta: r4(G.beta), persist: r4(G.persist), halfLifeDays: r1(G.halfLifeDays), n: d.length }, ranges, backtest: bt };
}
function riskTable(rows) {
  return rows.filter(r => Number.isFinite(r.y)).map(({ label, y, T, freq = 2 }) => { const R = M.bondRisk(y, y, T, freq); return { label, y: r4(y), T, modified: r2(R.modified), convexity: r1(R.convexity), dv01: r4(R.dv01), shocks: [-100, -50, -25, 25, 50, 100].map(bp => ({ bp, pct: r2(M.shock(y, y, T, bp, freq).exactPct) })) }; });
}
// stock sensitivity to the 10-year yield: daily % return on daily change (bp), Newey–West errors, two windows
function rateBetas(stocks, yDates, yVals, label) {
  const ymap = new Map(yDates.map((d, i) => [d, yVals[i]]));
  return stocks.map(s => {
    const r = [], x = [];
    for (let i = 1; i < s.dates.length; i++) { const y0 = ymap.get(s.dates[i - 1]), y1 = ymap.get(s.dates[i]); if (y0 == null || y1 == null || !(s.adj[i] > 0) || !(s.adj[i - 1] > 0)) continue; r.push(Math.log(s.adj[i] / s.adj[i - 1]) * 100); x.push((y1 - y0) * 100); }
    const n = r.length; if (n < 120) return { id: s.id, nm: s.nm, mk: s.mk, n, building: true };
    const A = M.olsNW(r.slice(-504), x.slice(-504), 5), B = n >= 700 ? M.olsNW(r.slice(-1008, -504), x.slice(-1008, -504), 5) : null;
    return { id: s.id, nm: s.nm, mk: s.mk, n: A.n, per10: r2(A.beta * 10), se10: r2(A.se * 10), t: r2(A.t), p: r4(A.p), r2: r4(A.r2), corr: r2(A.corr), prev10: B ? r2(B.beta * 10) : null, prevT: B ? r2(B.t) : null, sdBp: r2(M.sd(x.slice(-504))), yLabel: label };
  }).sort((a, b) => (b.building ? -1 : Math.abs(b.t || 0)) - (a.building ? -1 : Math.abs(a.t || 0)));
}

// ─────────────────────────────── United States ───────────────────────────────
function analyseUS(P) {
  const U = P.us, D = U.dates, L = lastIdx(U.nom["10Y"]); if (L < 300) return { building: true };
  const asOf = D[L], tenors = UST.map(([t, m]) => ({ t, m, ...stats(U.nom[t], L, { pctFrom: Math.max(0, L - 2520) }) })).filter(r => r.y != null);
  const curves = [[0, "latest"], [5, "1 week ago"], [21, "1 month ago"], [252, "1 year ago"]].map(([k, name]) => ({ name, date: D[Math.max(0, L - k)], pts: UST.map(([t, m]) => [m, r4(at(U.nom[t], L - k)[0])]).filter(p => p[1] != null) }));
  // spreads (bp), full history since 1990
  const sp = (a, b, k = 1) => D.map((_, i) => U.nom[a][i] != null && U.nom[b][i] != null ? (U.nom[a][i] - U.nom[b][i]) * 100 * k : null);
  const fly = D.map((_, i) => ["2Y", "5Y", "10Y"].every(t => U.nom[t][i] != null) ? (2 * U.nom["5Y"][i] - U.nom["2Y"][i] - U.nom["10Y"][i]) * 100 : null);
  const spreadDefs = [["3m10y", "10-year minus 3-month", sp("10Y", "3M")], ["2s10s", "10-year minus 2-year", sp("10Y", "2Y")], ["5s30s", "30-year minus 5-year", sp("30Y", "5Y")], ["fly", "Butterfly 2·5y − 2y − 10y", fly]];
  const spreads = spreadDefs.map(([k, name, s]) => {
    const [v] = at(s, L), hist = s.slice(0, L + 1).filter(x => x != null), w = s.slice(Math.max(0, L - 1260), L + 1).filter(x => x != null);
    let run = 0; for (let i = L; i >= 0 && s[i] != null && s[i] < 0; i--) run++;
    let lastNeg = null; for (let i = L; i >= 0; i--) if (s[i] != null && s[i] < 0) { lastNeg = D[i]; break; }
    return { k, name, bp: r1(v), d21: r1(v - at(s, L - 21)[0]), d252: r1(v - at(s, L - 252)[0]), pct: r2(M.percentileRank(hist, v)), z5y: r2((v - M.mean(w)) / M.sd(w)), invertedDays: k === "fly" ? null : run, lastInverted: k === "fly" ? null : lastNeg, hist: weekly(D, s.map(x => x == null ? null : x / 100), addDays(asOf, -3652)).map(([d, y]) => [d, r1(y * 100)]) };
  });
  // Nelson–Siegel(-Svensson) fit of today's par curve, a month and a year ago: level, slope, curvature
  const pts = UST.map(([t, m]) => [m, U.nom[t][L]]).filter(p => p[1] != null), fit = M.fitNSS(pts.map(p => p[0]), pts.map(p => p[1]));
  // level, slope, curvature by their standard model-free measures (Diebold & Li 2006): average of 3m/2y/10y, 10y − 3m, 2·2y − 3m − 10y
  const fac = i => { const g = t => at(U.nom[t], i)[0]; return { level: (g("3M") + g("2Y") + g("10Y")) / 3, slope: (g("10Y") - g("3M")) * 100, curvature: (2 * g("2Y") - g("3M") - g("10Y")) * 100 }; };
  const F0 = fac(L), F21 = fac(L - 21), F252 = fac(L - 252);
  const factors = { level: r4(F0.level), slopeBp: r1(F0.slope), curvatureBp: r1(F0.curvature), d21: { levelBp: r1((F0.level - F21.level) * 100), slopeBp: r1(F0.slope - F21.slope), curvatureBp: r1(F0.curvature - F21.curvature) }, d252: { levelBp: r1((F0.level - F252.level) * 100), slopeBp: r1(F0.slope - F252.slope), curvatureBp: r1(F0.curvature - F252.curvature) } };
  // principal components of daily changes over the last 3 years (10 tenors present on both days)
  const rows = [], rowDates = []; for (let i = Math.max(1, L - 756); i <= L; i++) { const r = PCA_T.map(t => U.nom[t][i] != null && U.nom[t][i - 1] != null ? (U.nom[t][i] - U.nom[t][i - 1]) * 100 : null); if (r.every(x => x != null)) { rows.push(r); rowDates.push(D[i]); } }
  const pc = rows.length > 200 ? M.pca(rows) : null;
  // a move decomposed on the components: each component's contribution to the 10-year's change (bp; all components
  // together add up to the actual change), and the day's size in standard deviations of that component
  const i10 = PCA_T.indexOf("10Y"), proj = (from, to) => { const r = PCA_T.map(t => (at(U.nom[t], to)[0] - at(U.nom[t], from)[0]) * 100), sc = pc.loadings.map(v => v.reduce((s, x, j) => s + x * r[j], 0)); return { contrib10: sc.slice(0, 3).map((x, k) => r1(x * pc.loadings[k][i10])), other10: r1(sc.slice(3).reduce((s, x, k) => s + x * pc.loadings[k + 3][i10], 0)), actual10: r1(r[i10]), sigmas: sc.slice(0, 3).map((x, k) => r2(x / (pc.sdBp[k] * Math.sqrt(to - from)))) }; };
  const pcaOut = pc && { n: pc.n, from: rowDates[0], to: rowDates[rowDates.length - 1], tenors: PCA_T, share: pc.share.slice(0, 4).map(r4), sdBp: pc.sdBp.slice(0, 3).map(r2), loadings: pc.loadings.slice(0, 3).map(v => v.map(r4)), lastDay: proj(L - 1, L), lastMonth: proj(L - 21, L) };
  // real yields (TIPS) and breakeven inflation (nominal − real), since 2003
  const realStart = U.real["10Y"].findIndex(x => x != null);
  const real = ["5Y", "10Y", "20Y", "30Y"].filter(t => U.real[t]).map(t => { const be = D.map((_, i) => U.real[t][i] != null && U.nom[t][i] != null ? U.nom[t][i] - U.real[t][i] : null); const R = stats(U.real[t], L, { pctFrom: realStart }), B = stats(be, L, { pctFrom: realStart }); return { t, real: R, breakeven: B, beHist: t === "10Y" ? weekly(D, be, addDays(asOf, -3652)) : null, realHist: t === "10Y" ? weekly(D, U.real[t], addDays(asOf, -3652)) : null }; }).filter(r => r.real.y != null);
  // what moved the 10-year: (a) real yield + breakeven inflation (exact: nominal = real + breakeven); (b) expected short
  // rates + term premium (ACM's identity on its own fitted 10-year zero-coupon yield)
  const dec = k => { const n0 = at(U.nom["10Y"], L)[0], n1 = at(U.nom["10Y"], L - k)[0], q0 = at(U.real["10Y"], L)[0], q1 = at(U.real["10Y"], L - k)[0]; return n0 != null && q0 != null && n1 != null && q1 != null ? { days: k, from: D[L - k], nominalBp: r1((n0 - n1) * 100), realBp: r1((q0 - q1) * 100), breakevenBp: r1(((n0 - q0) - (n1 - q1)) * 100) } : null; };
  const acmDec = k => { const a = U.acm, n = a.y10.length; if (n <= k) return null; return { days: k, from: a.y10[n - 1 - k][0], to: a.y10[n - 1][0], yBp: r1((a.y10[n - 1][1] - a.y10[n - 1 - k][1]) * 100), expectedBp: r1((a.rny10[n - 1][1] - a.rny10[n - 1 - k][1]) * 100), termPremiumBp: r1((a.tp10[n - 1][1] - a.tp10[n - 1 - k][1]) * 100) }; };
  const decomposition = { realBreakeven: [21, 63, 252].map(dec).filter(Boolean), expectationsPremium: [21, 63, 252].map(acmDec).filter(Boolean) };
  // policy rates
  const lastOf = a => a.length ? a[a.length - 1] : null, effr = lastOf(U.effr), lo = lastOf(U.ffLo), hi = lastOf(U.ffHi), sofr = lastOf(U.sofr);
  const y2 = at(U.nom["2Y"], L)[0], y3m = at(U.nom["3M"], L)[0];
  const policy = effr && { effr: effr[1], effrDate: effr[0], rangeLo: lo?.[1], rangeHi: hi?.[1], sofr: sofr?.[1], sofrDate: sofr?.[0], twoMinusEffrBp: r1((y2 - effr[1]) * 100), threeMMinusEffrBp: r1((y3m - effr[1]) * 100), effrHist: thin(U.effr, addDays(asOf, -3652)) };
  // ACM term premium (NY Fed): the part of the 10-year yield that is compensation for risk, not expected short rates
  const tp = U.acm.tp10, tpLast = lastOf(tp), tpVals = tp.map(p => p[1]);
  const acm = tpLast && { date: tpLast[0], tp10: r4(tpLast[1]), rny10: r4(lastOf(U.acm.rny10)?.[1]), y10: r4(lastOf(U.acm.y10)?.[1]), tp2: r4(lastOf(U.acm.tp2)?.[1]), tp5: r4(lastOf(U.acm.tp5)?.[1]), d21: r1((tpLast[1] - tp[Math.max(0, tp.length - 22)][1]) * 100), d252: r1((tpLast[1] - tp[Math.max(0, tp.length - 253)][1]) * 100), pct: r2(M.percentileRank(tpVals.slice(tp.findIndex(p => p[0] >= "1990-01-01")), tpLast[1])), hist: thin(tp, addDays(asOf, -3652 * 2)), rnyHist: thin(U.acm.rny10, addDays(asOf, -3652 * 2)) };
  // recession probability: the NY Fed's latest published value and KUBER's month-to-date estimate with the same formula
  const prob = U.rec.prob, spr = U.rec.spread, nber = U.rec.nber, lastProb = lastOf(prob), lastSpr = lastOf(spr);
  const month = asOf.slice(0, 7), mtd = []; for (let i = L; i >= 0 && D[i].startsWith(month); i--) if (U.nom["10Y"][i] != null && U.nom["3M"][i] != null) mtd.push(U.nom["10Y"][i] - U.nom["3M"][i]);
  const prevMonth = new Date(Date.parse(month + "-01T00:00:00Z") - 864e5).toISOString().slice(0, 7), pm = []; for (let i = L; i >= 0 && D[i] >= prevMonth + "-01"; i--) if (D[i].startsWith(prevMonth) && U.nom["10Y"][i] != null && U.nom["3M"][i] != null) pm.push(U.nom["10Y"][i] - U.nom["3M"][i]);
  const nyPrev = spr.find(p => p[0] === prevMonth + "-01");
  const recession = lastProb && { official: { prob: r4(lastProb[1]), forMonth: lastProb[0], basedOnSpread: lastSpr ? r4(lastSpr[1]) : null, spreadMonth: lastSpr?.[0] }, mtd: mtd.length ? { spread: r4(M.mean(mtd)), days: mtd.length, prob: r4(M.recessionProb(M.mean(mtd))), forMonth: addDays(month + "-01", 366).slice(0, 7) + "-01" } : null, consistency: nyPrev && pm.length ? { month: prevMonth, nyFed: r4(nyPrev[1]), kuber: r4(M.mean(pm)), diffBp: r1((M.mean(pm) - nyPrev[1]) * 100) } : null, hist: prob.filter(p => p[0] >= "1990-01-01").map(p => [p[0], r4(p[1])]), nber: nber.filter(p => p[0] >= "1990-01-01" && p[1] === 1).map(p => p[0]) };
  // volatility and 1-week / 1-month ranges for the 10- and 2-year yields, each tested walk-forward since 1990
  const vol = [volBlock("10Y", U.nom["10Y"], L, { label: "10-year Treasury" }), volBlock("2Y", U.nom["2Y"], L, { label: "2-year Treasury" })];
  // duration, convexity and repricing for par bonds at today's yields; one-year carry and roll-down on the fitted curve
  const risk = riskTable([["2-year", "2Y", 2], ["5-year", "5Y", 5], ["10-year", "10Y", 10], ["30-year", "30Y", 30]].map(([label, t, T]) => ({ label, y: at(U.nom[t], L)[0], T })));
  const curveFn = fit ? m => M.nss(m, fit) : null;
  const carry = curveFn ? [2, 5, 10, 30].map(T => { const c = M.carryRoll(curveFn, T); return { T, yT: r4(c.yT), rollBp: r1(c.rollBp), incomePct: r2(c.incomePct), pricePct: r2(c.priceGainPct), totalPct: r2(c.totalPct), breakevenBp: r1(c.breakevenBp) }; }) : null;
  // live: last quotes and today's intraday path of the 10- and 2-year
  const live = Object.fromEntries(Object.entries(P.live || {}).filter(([k]) => k.startsWith("US")).map(([k, v]) => [k, v]));
  const offClose = at(U.nom["10Y"], L)[0];
  return { asOf, tenors, curves, spreads, factors, decomposition, fit: fit && Object.fromEntries(Object.entries(fit).map(([k, v]) => [k, typeof v === "number" ? r4(v) : v])),
    pca: pcaOut, real, policy, acm, recession, vol, risk, carry, live, liveVsClose: live.US10Y ? r1((live.US10Y.y - offClose) * 100) : null,
    hist10: weekly(D, U.nom["10Y"], addDays(asOf, -3652 * 3.6)), hist2: weekly(D, U.nom["2Y"], addDays(asOf, -3652 * 3.6)), hist3m: weekly(D, U.nom["3M"], addDays(asOf, -3652 * 3.6)),
    rateBetas: rateBetas(P.stocks.filter(s => s.mk === "US"), D.filter((_, i) => U.nom["10Y"][i] != null), U.nom["10Y"].filter(x => x != null), "US 10-year (Treasury, official)") };
}

// ─────────────────────────────── India ───────────────────────────────
function analyseIN(P, US) {
  const I = P.in, out = { days: I.nss.length };
  const last = a => a.length ? a[a.length - 1] : null;
  const p = last(I.nss), p1 = I.nss.length > 1 ? I.nss[I.nss.length - 2] : null, p0 = I.nss[0];
  const MATS = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 40];
  if (p) { out.asOf = p.date; out.nss = p; out.zero = MATS.map(m => ({ m, y: r4(M.nss(m, p)), d1: p1 ? r1((M.nss(m, p) - M.nss(m, p1)) * 100) : null, dFirst: p0 && I.nss.length > 2 ? r1((M.nss(m, p) - M.nss(m, p0)) * 100) : null })); out.firstDate = p0.date; out.prevDate = p1?.date || null;
    out.curves = [p, p1, I.nss.length > 21 ? I.nss[I.nss.length - 22] : null].filter(Boolean).map((q, k) => ({ name: ["latest", "previous day", "1 month ago"][k], date: q.date, pts: MATS.map(m => [m, r4(M.nss(m, q))]) })); }
  // securities (CCIL tenor-wise YTMs) with day change per bucket
  const dates = [...new Set(I.sec.map(r => r.date))].sort(), dL = last(dates), dP = dates.length > 1 ? dates[dates.length - 2] : null;
  const ORDER = ["91D", "182D", "364D", "1Y-2Y", "4Y-5Y", "9Y-10Y", "13Y-15Y", "28Y-30Y", "SDL 5Y", "SDL 10Y", "SDL 15Y"], rank = b => { const i = ORDER.indexOf(b); return i < 0 ? 99 : i; };
  out.securities = I.sec.filter(r => r.date === dL).sort((a, b) => rank(a.bucket) - rank(b.bucket)).map(r => { const prev = dP && I.sec.find(x => x.date === dP && x.bucket === r.bucket); return { ...r, d1: prev ? r1((r.ytm - prev.ytm) * 100) : null, prevSecurity: prev && prev.security !== r.security ? prev.security : null }; });
  const sec = b => out.securities.find(r => r.bucket === b)?.ytm ?? null, z = m => p ? M.nss(m, p) : null;
  const repo = last(I.repo), sdf = last(I.sdf), msf = last(I.msf);
  out.policy = repo && { repo: repo[1], sdf: sdf?.[1], msf: msf?.[1], date: repo[0], hist: I.repo.map(r => [r[0], r[1]]) };
  const us10 = US?.tenors?.find(t => t.t === "10Y")?.y, in10 = sec("9Y-10Y");
  out.spreads = [
    ["10y − 91-day T-bill", in10 != null && sec("91D") != null ? (in10 - sec("91D")) * 100 : null],
    ["10y − 2y (zero curve)", p ? (z(10) - z(2)) * 100 : null],
    ["30y − 10y (zero curve)", p ? (z(30) - z(10)) * 100 : null],
    ["10y − repo rate", in10 != null && repo ? (in10 - repo[1]) * 100 : null],
    ["91-day T-bill − repo rate", sec("91D") != null && repo ? (sec("91D") - repo[1]) * 100 : null],
    ["State (SDL) 10y − G-sec 10y", sec("SDL 10Y") != null && in10 != null ? (sec("SDL 10Y") - in10) * 100 : null],
    ["India 10y − US 10y", in10 != null && us10 != null ? (in10 - us10) * 100 : null]
  ].map(([name, bp]) => ({ name, bp: r1(bp) }));
  // live 10- and 30-year
  out.live = Object.fromEntries(Object.entries(P.live || {}).filter(([k]) => k.startsWith("IN")));
  if (out.live.IN10Y && in10 != null) out.liveVsCCIL = r1((out.live.IN10Y.y - in10) * 100);
  if (out.live.IN10Y && P.live?.US10Y) out.liveSpreadUS = r1((out.live.IN10Y.y - P.live.US10Y.y) * 100);
  // history available for statistics: the 10-year builds up daily (official CCIL + recorded closes); the 30-year has
  // market closes since 2011, so long-history statistics use it until the 10-year has two years of its own
  const ten = new Map(I.mkt10); for (const [d, y] of I.ccil10) ten.set(d, y);   // official CCIL value wins on the same day
  const tenPairs = [...ten.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1), use10 = tenPairs.length >= 500;
  const longPairs = use10 ? tenPairs : I.mkt30, longName = use10 ? "India 10-year" : "India 30-year (proxy: the only free long history)";
  out.history = { tenYearDays: tenPairs.length, thirtyYearDays: I.mkt30.length, from30: I.mkt30[0]?.[0] || null, using: longName, tenNeeded: 500 };
  const lv = longPairs.map(p => p[1]);
  out.vol = [volBlock(use10 ? "IN10Y" : "IN30Y", lv, lv.length - 1, { label: longName })];
  out.hist30 = thin(I.mkt30, "2011-01-01"); out.hist10 = tenPairs.map(([d, y]) => [d, r4(y)]);
  out.risk = riskTable([["5-year G-sec", sec("4Y-5Y"), 5], ["10-year G-sec", in10, 10], ["30-year G-sec", sec("28Y-30Y"), 30]].map(([label, y, T]) => ({ label, y, T })));
  out.carry = p ? [5, 10, 30].map(T => { const c = M.carryRoll(m => M.nss(m, p), T); return { T, yT: r4(c.yT), rollBp: r1(c.rollBp), incomePct: r2(c.incomePct), pricePct: r2(c.priceGainPct), totalPct: r2(c.totalPct), breakevenBp: r1(c.breakevenBp) }; }) : null;
  out.rateBetas = rateBetas(P.stocks.filter(s => s.mk === "IN"), longPairs.map(p => p[0]), lv, longName);
  return out;
}

export function analyse(P) {
  const t0 = Date.now(), US = analyseUS(P), IN = analyseIN(P, US);
  return { US: { ...US, secs: (Date.now() - t0) / 1000 }, IN: { ...IN, secs: (Date.now() - t0) / 1000 } };
}
