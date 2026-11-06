// Portfolio risk and everything around it: simulation of the whole portfolio (logged and scored daily), what-if, trade
// plans, benchmarks, dividends, results dates, charges and tax, your alert rules, the decision journal, the daily brief
// and the no-forecast baseline. The trial's two forecast arms (ladder, ladder_base) are never touched here.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { execFile } from "node:child_process";
import { ROOT, all, get, run, tx, log, now, getSetting, setSetting } from "./db.mjs";
import { STATE, company, orderCid, trackedIds } from "./companies.mjs";
import { feedSymbol, saPath, syncDaily, tradingToday, getJSON, sessionOpen } from "./market.mjs";
import { job, Q, dailyOf, scoreNaive } from "./engine.mjs";
import { notify } from "./health.mjs";
import { BSTATE } from "./bonds.mjs";
import * as PM from "./portmath.mjs";

export const HZ = [5, 21, 63];
const BENCH = { IN: { id: "BM:NIFTY", mk: "IN", tk: "NIFTYBEES", path: "a/nse-niftybees", label: "Nifty 50 (NIFTYBEES ETF, dividends included)" }, US: { id: "BM:SPY", mk: "US", tk: "SPY", path: "e/spy", label: "S&P 500 (SPY ETF, dividends included)" } };
const co = id => STATE.base[id] || company(id, { live: false }), mkOfC = c => c.mk === "TW" ? "US" : c.mk;
const costs = () => { const s = getSetting("costs", null); return s ? { ...PM.COST_DEFAULTS, ...s, tax: { ...PM.COST_DEFAULTS.tax, ...(s.tax || {}) } } : PM.COST_DEFAULTS; };
export const getCosts = costs; export function setCosts(c) { setSetting("costs", { ...c, asOf: new Date().toISOString().slice(0, 10), edited: true }); return costs(); }

// ── holdings ─────────────────────────────────────────────────────────────
function series(c) { const D = dailyOf(c); return { id: c.id, nm: c.nm, tk: c.tk, dates: D.rows.map(r => r.date), adj: D.adj, close: D.rows.map(r => r.close) }; }
export function holdings() {
  const pos = {}; for (const o of all("SELECT sym, mk, side, qty FROM orders WHERE status='executed'")) { const mk = o.mk || "IN", k = mk + "|" + o.sym; pos[k] = (pos[k] || 0) + (o.side === "Buy" ? o.qty : -o.qty); }
  const books = {};
  for (const [k, q] of Object.entries(pos)) { if (q <= 1e-9) continue; const [mk, sym] = k.split("|"), c = co(orderCid(mk, sym)); if (!c) continue; const S = series(c), last = S.close[S.close.length - 1]; if (!(last > 0)) continue; (books[mk] ||= []).push({ cid: c.id, sym, nm: c.nm, tk: c.tk, q, close: last, date: S.dates[S.dates.length - 1], value: q * last, S }); }
  for (const list of Object.values(books)) { const t = list.reduce((a, h) => a + h.value, 0); list.forEach(h => { h.w = h.value / t; }); list.sort((a, b) => b.w - a.w); }
  return books;
}
const hashOf = list => crypto.createHash("sha1").update(list.map(h => `${h.cid}:${h.q}`).sort().join("|")).digest("hex").slice(0, 16);
function driftFor(list) {
  const mu = list.map(h => { const r = get("SELECT mu, q FROM ladder_runs WHERE cid=? ORDER BY made DESC LIMIT 1", h.cid); return r ? r.mu + (r.q || 0) : null; }), have = mu.filter(x => x != null), avg = have.length ? have.reduce((a, b) => a + b, 0) / have.length : 0.08;
  return { mu: mu.map(x => x ?? avg), borrowed: list.filter((_, i) => mu[i] == null).map(h => h.cid) };
}
const tradingDays = (a, b) => { let n = 0, t = Date.parse(a + "T12:00:00Z"); const e = Date.parse(b + "T12:00:00Z"); while ((t += 864e5) <= e) { const w = new Date(t).getUTCDay(); if (w && w !== 6) n++; } return n; };
function eventsFor(list, made) {
  const eff = {}, ev = list.map(h => { const past = all("SELECT date FROM company_events WHERE cid=? AND kind='results' AND date<=?", h.cid, made).map(r => r.date), E = PM.resultsEffect(h.S, past); eff[h.cid] = { n: E.n, multiple: E.multiple, shrunk: E.shrunk, typicalMove: E.typicalMove, normalDaily: E.normalDaily };
    const next = all("SELECT date, expected FROM company_events WHERE cid=? AND kind='results' AND date>? ORDER BY date LIMIT 1", h.cid, made)[0]; if (next) { eff[h.cid].next = next.date; eff[h.cid].expected = !!next.expected; }
    if (!next || !(E.extraVar > 0)) return null; const day = tradingDays(made, next.date); return day >= 1 && day <= Math.max(...HZ) ? [{ day, extraVar: E.extraVar }] : null; });
  return { ev, eff };
}
function factorsFor(mk) {
  const f = {}, b = BENCH[mk]; if (b) { const D = dailyOf({ ...b, dd: null }); if (D.rows.length > 100) f.bench = { label: b.label, dates: D.rows.map(r => r.date), adj: D.adj }; }
  const ser = mk === "US" ? [["UST:10Y", "US 10-year Treasury yield"]] : [["MKT:IN10Y", "India 10-year yield"], ["MKT:IN30Y", "India 30-year yield"]];
  for (const [s, label] of ser) { const r = all("SELECT date, y FROM bond_daily WHERE series=? ORDER BY date", s); if (r.length >= 250) { f.yield = { label, dates: r.map(x => x.date), vals: r.map(x => x.y) }; break; } }
  return f;
}
// ── run the simulation for a book; log it once per close so it gets scored ──
export async function runBook(mk, list, { logIt = true } = {}) {
  const made = list[0].date, { mu, borrowed } = driftFor(list), { ev, eff } = eventsFor(list, made), stocks = list.map(h => ({ id: h.cid, nm: h.nm, dates: h.S.dates, adj: h.S.adj }));
  const R = await job("portfolio", { stocks, w: list.map(h => h.w), mu, events: ev, H: HZ, factors: factorsFor(mk), backtest: true }); if (!R) return null;
  const data = { ...R, made, mk, holdings: list.map(h => ({ cid: h.cid, nm: h.nm, tk: h.tk, w: h.w, sym: h.sym })), drift: mu, borrowed, results: eff };
  run("INSERT INTO port_view(book,made,hash,data,at) VALUES(?,?,?,?,?) ON CONFLICT(book) DO UPDATE SET made=excluded.made, hash=excluded.hash, data=excluded.data, at=excluded.at", mk, made, hashOf(list), JSON.stringify(data), now());
  if (logIt && !get("SELECT 1 AS x FROM port_runs WHERE book=? AND made=?", mk, made)) tx(() => {
    run("INSERT INTO port_runs(book,made,weights,result,created) VALUES(?,?,?,?,?)", mk, made, JSON.stringify(list.map(h => ({ cid: h.cid, w: h.w }))), JSON.stringify({ stats: { annVol: R.stats.annVol, effectiveN: R.stats.effectiveN } }), now());
    const put = (arm, S) => { for (const h of HZ) { const r = S.horizons[h]; run("INSERT OR IGNORE INTO port_sims(book,made,arm,h,p05,p25,p50,p75,p95,pUp) VALUES(?,?,?,?,?,?,?,?,?,?)", mk, made, arm, h, r.p05, r.p25, r.p50, r.p75, r.p95, r.pUp); } };
    put("model", R.base); put("naive", R.naive); put("results", R.withEvents || R.base);
  });
  return data;
}
export function scorePortfolio() {
  let n = 0;
  for (const run0 of all("SELECT DISTINCT r.book, r.made, r.weights FROM port_runs r JOIN port_sims s ON s.book=r.book AND s.made=r.made WHERE s.scored IS NULL")) {
    const W = JSON.parse(run0.weights).map(x => { const c = co(x.cid); return c ? { ...x, D: dailyOf(c) } : null; }).filter(Boolean); if (!W.length) continue;
    const cal = W.reduce((a, x) => x.D.rows.length > a.D.rows.length ? x : a, W[0]).D.rows.map(r => r.date), j = cal.indexOf(run0.made); if (j < 0) continue;
    for (const s of all("SELECT * FROM port_sims WHERE book=? AND made=? AND scored IS NULL AND h<=?", run0.book, run0.made, cal.length - 1 - j)) {
      const dEnd = cal[j + s.h]; let tot = 0, wsum = 0;
      for (const x of W) { const dates = x.D.rows.map(r => r.date), a = dates.indexOf(run0.made), b = dates.indexOf(dEnd); if (a < 0 || b < 0) continue; tot += x.w * (x.D.adj[b] / x.D.adj[a] - 1); wsum += x.w; }
      if (wsum < 0.6) continue; const y = tot / wsum;
      run("UPDATE port_sims SET actual=?, actual_date=?, scored=?, in50=?, in90=?, qscore=? WHERE book=? AND made=? AND arm=? AND h=?", y, dEnd, now(), +(y >= s.p25 && y <= s.p75), +(y >= s.p05 && y <= s.p95), Q.quantileScore([[0.05, s.p05], [0.25, s.p25], [0.5, s.p50], [0.75, s.p75], [0.95, s.p95]], y), s.book, s.made, s.arm, s.h); n++;
    }
  }
  if (n) log("portfolio", `Scored ${n} portfolio forecasts against what happened`);
  return n;
}
export function portfolioRecord() {
  const out = {}; for (const r of all("SELECT book, arm, h, COUNT(*) n, SUM(scored IS NOT NULL) s, AVG(in90) i90, AVG(in50) i50, AVG(qscore) q FROM port_sims GROUP BY book, arm, h")) ((out[r.book] ||= {})[r.arm] ||= {})[r.h] = { made: r.n, scored: r.s, in90: r.i90, in50: r.i50, q: r.q };
  return out;
}
export async function refreshPortfolio(reason = "scheduled", { force = false } = {}) {
  const books = holdings();
  for (const [mk, list] of Object.entries(books)) { const v = get("SELECT made, hash FROM port_view WHERE book=?", mk), need = force || !v || v.made !== list[0].date || v.hash !== hashOf(list) || !get("SELECT 1 AS x FROM port_runs WHERE book=? AND made=?", mk, list[0].date); if (need) { const t0 = Date.now(); await runBook(mk, list); log("portfolio", `${mk} portfolio simulated (${reason}) in ${((Date.now() - t0) / 1000).toFixed(1)} s, from the ${list[0].date} close`); } }
  for (const mk of ["IN", "US", "KR"]) if (!books[mk]) run("DELETE FROM port_view WHERE book=?", mk);
  return scorePortfolio();
}

// ── what-if and trade plans ──────────────────────────────────────────────
function resolveStock(mk, sym) { const c = co(orderCid(mk, String(sym || "").toUpperCase())); if (!c) throw new Error(`KUBER has no data for ${sym}. Add it in the Finder first.`); const S = series(c); if (S.dates.length < 60) throw new Error(`${sym} has only ${S.dates.length} days of prices`); return { c, S }; }
export async function whatIfTrade({ mk = "IN", sym, side = "Buy", qty, price }) {
  const books = holdings(), list = (books[mk] || []).slice(), { c, S } = resolveStock(mk, sym), last = S.close[S.close.length - 1], px = +price > 0 ? +price : last, n = +qty; if (!(n > 0)) throw new Error("Enter a quantity");
  let row = list.find(h => h.cid === c.id); const extra = !row; if (extra) row = { cid: c.id, sym, nm: c.nm, tk: c.tk, q: 0, close: last, date: S.dates[S.dates.length - 1], value: 0, S };
  const q1 = side === "Buy" ? row.q + n : row.q - n; if (q1 < -1e-9) throw new Error(`You hold ${row.q} ${sym}; you can't sell ${n}`);
  const all2 = extra ? [...list, row] : list; if (!all2.length) throw new Error("No holdings yet"); const tot0 = all2.reduce((a, h) => a + h.q * h.close, 0), tot1 = all2.reduce((a, h) => a + (h === row ? q1 : h.q) * h.close, 0); if (!(tot1 > 0)) throw new Error("That would leave no holdings to simulate");
  const { mu, borrowed } = driftFor(all2), before = all2.map(h => tot0 ? h.q * h.close / tot0 : 0), after = all2.map(h => (h === row ? q1 : h.q) * h.close / tot1);
  const R = await job("whatif", { stocks: all2.map(h => ({ id: h.cid, nm: h.nm, dates: h.S.dates, adj: h.S.adj })), before: tot0 ? before : after, after, mu, H: HZ }); if (!R) throw new Error("Not enough price history");
  const cfg = costs(), value = n * px, fee = PM.charges(side, value, mk, cfg);
  return { ...R, holdings: all2.map((h, i) => ({ cid: h.cid, nm: h.nm, tk: h.tk, before: before[i], after: after[i] })), trade: { nm: c.nm, tk: c.tk, side, qty: n, px, value, fee }, totals: { before: tot0, after: tot1 }, borrowed, cur: c.cur, wasEmpty: !tot0 };
}
export async function tradePlan({ mk = "IN", sym, amount, days = 63, stopPct = null, targetPct = null, tranches = 1, every = 5 }) {
  const { c, S } = resolveStock(mk, sym), r = get("SELECT mu FROM ladder_runs WHERE cid=? ORDER BY made DESC LIMIT 1", c.id), amt = +amount; if (!(amt > 0)) throw new Error("Enter an amount");
  const plan = { amount: amt, days: Math.min(252, Math.max(5, +days || 63)), mu: r?.mu ?? 0.08, stopPct: stopPct === "" || stopPct == null ? null : +stopPct, targetPct: targetPct === "" || targetPct == null ? null : +targetPct, tranches: Math.max(1, Math.min(12, +tranches || 1)), every: Math.max(1, +every || 5), mk: mkOfC(c), cfg: costs() };
  const out = await job("tradeplan", { stock: { id: c.id, nm: c.nm, dates: S.dates, adj: S.adj }, plan }); if (!out) throw new Error("Not enough price history");
  return { ...out, nm: c.nm, tk: c.tk, cur: c.cur, muUsed: plan.mu, driftBorrowed: !r, plan: { ...plan, cfg: undefined } };
}

// ── data: benchmarks, dividends, results dates (each at most once in ~20 hours, one failure never blocks the rest) ──
const due = (k, hours = 20) => { const t = getSetting(k); return !t || Date.now() - Date.parse(t) > hours * 3600e3; };
async function syncBenchmarks() { for (const b of Object.values(BENCH)) { try { await syncDaily(b, "5Y"); } catch (e) { log("portfolio", `benchmark ${b.tk}: ${e.message}`); } } }
const parseAmt = s => { const m = /([\d,]*\.?\d+)/.exec(String(s ?? "")); return m ? +m[1].replace(/,/g, "") : NaN; };
async function syncDividends() {
  const seen = new Map(); for (const id of trackedIds()) { const c = co(id); if (c) seen.set(id, c); }
  for (const o of all("SELECT DISTINCT sym, mk FROM orders WHERE status='executed'")) { const id = orderCid(o.mk || "IN", o.sym); if (seen.has(id)) continue; const c = co(id); seen.set(id, c || { id, mk: o.mk || "IN", tk: o.sym }); }
  let n = 0; const missing = [];
  for (const c of seen.values()) { try { const j = await getJSON(`https://stockanalysis.com/api/symbol/${saPath(c)}/dividend`), H = j?.data?.history || []; tx(() => { for (const r of H) { const amt = parseAmt(r.amt); if (r.dt && amt > 0) n += run("INSERT OR IGNORE INTO dividends(sym,ex_date,amount,cur,pay_date,src) VALUES(?,?,?,?,?,?)", feedSymbol(c), r.dt, amt, String(r.amt).replace(/[\d.,\s]/g, ""), /^\d{4}-/.test(r.pay || "") ? r.pay : null, "stockanalysis.com").changes; } }); } catch (e) { missing.push(c.tk || c.id); } }
  setSetting("dividends.missing", missing); log("portfolio", `Dividends: ${n} new records for ${seen.size} stocks${missing.length ? `; no data for ${missing.join(", ")}` : ""}`);
}
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", CK = path.join(ROOT, "data", "cache", "nse.ck");
const curl = args => new Promise((res, rej) => execFile("curl", ["-s", "-m", "20", "-A", UA, ...args, "-w", "\n%{http_code}"], { maxBuffer: 20e6 }, (e, o) => { if (e) return rej(e); const i = o.lastIndexOf("\n"); res({ status: +o.slice(i + 1), body: o.slice(0, i) }); }));
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" }, dmy = s => { const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s || ""); return m && MON[m[2]] ? `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, "0")}` : null; };
async function syncResults() {
  let nIn = 0, nUs = 0, bad = 0; fs.mkdirSync(path.dirname(CK), { recursive: true }); const list = trackedIds().map(co).filter(Boolean);
  if (list.some(c => c.mk === "IN")) await curl(["-c", CK, "https://www.nseindia.com/"]).catch(() => null);
  for (const c of list) {
    const mk = mkOfC(c);
    try {
      if (mk === "IN") {
        const r = await curl(["-b", CK, "-H", "Accept: application/json", "-H", "Referer: https://www.nseindia.com/", `https://www.nseindia.com/api/corporate-board-meetings?index=equities&symbol=${encodeURIComponent(c.tk)}`]); if (r.status !== 200) { bad++; continue; }
        tx(() => { for (const m of JSON.parse(r.body)) { const d = dmy(m.bm_date); if (d && /result/i.test(m.bm_purpose || "")) nIn += run("INSERT OR IGNORE INTO company_events(cid,date,kind,note,expected,src) VALUES(?,?,?,?,?,?)", c.id, d, "results", String(m.bm_purpose).slice(0, 120), 0, "NSE board meetings").changes; } });
      } else if (mk === "US") {
        const a = await getJSON(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(c.tk)}/earnings-date`).catch(() => null), s = await getJSON(`https://api.nasdaq.com/api/company/${encodeURIComponent(c.tk)}/earnings-surprise`).catch(() => null), when = /:\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/.exec(a?.data?.announcement || "");
        tx(() => {
          if (when && MON[when[1]]) { const d = `${when[3]}-${MON[when[1]]}-${when[2].padStart(2, "0")}`; run("DELETE FROM company_events WHERE cid=? AND kind='results' AND expected=1 AND date>=?", c.id, new Date().toISOString().slice(0, 10)); nUs += run("INSERT OR IGNORE INTO company_events(cid,date,kind,note,expected,src) VALUES(?,?,?,?,?,?)", c.id, d, "results", String(a.data.reportText || "").slice(0, 160), 1, "Nasdaq (expected date)").changes; }
          for (const x of s?.data?.earningsSurpriseTable?.rows || []) { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(x.dateReported || ""); if (m) nUs += run("INSERT OR IGNORE INTO company_events(cid,date,kind,note,expected,src) VALUES(?,?,?,?,?,?)", c.id, `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`, "results", `Quarter ${x.fiscalQtrEnd || ""}`, 0, "Nasdaq").changes; }
        });
      }
    } catch (e) { bad++; }
  }
  log("portfolio", `Results dates: ${nIn} NSE and ${nUs} US new${bad ? `; ${bad} stocks had no answer` : ""}`);
}
// the no-forecast baseline, one per outlook; re-made if an outlook was re-anchored to a corrected close
export function makeNaive() {
  let n = 0;
  for (const r of all("SELECT cid, made, p0 FROM ladder_runs")) {
    const have = get("SELECT p0 FROM ladder_naive WHERE cid=? AND made=? LIMIT 1", r.cid, r.made); if (have && Math.abs(have.p0 / r.p0 - 1) < 1e-9) continue;
    const c = co(r.cid); if (!c) continue; const D = dailyOf(c), j = D.rows.findIndex(x => x.date === r.made); if (j < 121) continue;
    const L = PM.naiveLadder(D.adj.slice(0, j + 1), r.p0, { N: 90, seed: Math.abs([...r.cid, ...r.made].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) | 0, 7)) }); if (!L) continue;
    tx(() => { run("DELETE FROM ladder_naive WHERE cid=? AND made=?", r.cid, r.made); for (const x of L) run("INSERT INTO ladder_naive(cid,made,h,p0,p05,p25,p50,p75,p95,pUp) VALUES(?,?,?,?,?,?,?,?,?,?)", r.cid, r.made, x.h, r.p0, x.p05, x.p25, x.p50, x.p75, x.p95, x.pUp); }); n++;
  }
  const s = scoreNaive(); if (n) log("portfolio", `No-forecast baseline made for ${n} outlooks; ${s} days scored`);
  return n;
}
export function naiveCompare() {
  const rows = all("SELECT b.cid, b.made, b.h, b.qscore qb, t.qscore qt, n.qscore qn, b.in90 ib, n.in90 inn, b.in50 hb, n.in50 hn FROM ladder_base b JOIN ladder_naive n ON n.cid=b.cid AND n.made=b.made AND n.h=b.h JOIN ladder t ON t.cid=b.cid AND t.made=b.made AND t.h=b.h WHERE b.scored IS NOT NULL AND n.scored IS NOT NULL AND t.scored IS NOT NULL ORDER BY b.made, b.h");
  const sum = x => { if (!x.length) return { n: 0 }; const m = k => Q.mean(x.map(r => r[k])), byDay = {}; for (const r of x) (byDay[r.made] ||= []).push(r.qn - r.qb); const d = Object.values(byDay).map(a => Q.mean(a)), dm = Q.dmTest(d, 2); return { n: x.length, days: d.length, qb: m("qb"), qt: m("qt"), qn: m("qn"), in90b: m("ib"), in90n: m("inn"), in50b: m("hb"), in50n: m("hn"), gain: 1 - m("qb") / m("qn"), dmT: dm.t, verdict: d.length < 40 ? "too early" : dm.t > 2 ? "model beats no-forecast" : dm.t < -2 ? "no-forecast beats the model" : "no clear difference" }; };
  const perStock = {}; for (const r of rows) (perStock[r.cid] ||= []).push(r);
  return { all: sum(rows), stocks: Object.fromEntries(Object.entries(perStock).map(([k, v]) => [k, sum(v)])) };
}
let researching = false;
export async function runResearch(force) {
  if (researching || (!force && !due("research.tails.at", 6 * 24))) return null; researching = true;
  try { const stocks = trackedIds().map(co).filter(Boolean).map(c => { const S = series(c); return { id: c.id, adj: S.adj }; }).filter(s => s.adj.length >= 563), t0 = Date.now(), out = await job("research", { stocks }); setSetting("research.tails", { ...out, at: now(), secs: (Date.now() - t0) / 1000 }); setSetting("research.tails.at", now()); log("portfolio", `Model research: ${out.forecasts} past forecasts compared in ${((Date.now() - t0) / 1000).toFixed(0)} s`); return out; } finally { researching = false; }
}
let cycling = false;
export async function portfolioCycle(reason) {
  if (cycling) return; cycling = true;
  try {
    const step = async (k, f) => { try { await f(); } catch (e) { log("portfolio", `${k}: ${e.message}`); } };
    if (due("portfolio.bench.at", 6)) await step("benchmarks", async () => { await syncBenchmarks(); setSetting("portfolio.bench.at", now()); });
    if (due("portfolio.div.at")) await step("dividends", async () => { await syncDividends(); setSetting("portfolio.div.at", now()); });
    if (due("portfolio.events.at")) await step("results dates", async () => { await syncResults(); setSetting("portfolio.events.at", now()); });
    await step("naive baseline", async () => makeNaive());
    await step("portfolio simulation", () => refreshPortfolio(reason));
    await step("research", () => runResearch(false));
  } finally { cycling = false; }
}

// ── true profit: dividends, charges, tax and the benchmark ───────────────
export function ledger() {
  const out = {}, orders = all("SELECT * FROM orders"), cfg = costs(), books = holdings(), today = new Date().toISOString().slice(0, 10);
  for (const mk of new Set(orders.filter(o => o.status === "executed").map(o => o.mk || "IN"))) {
    const ex = orders.filter(o => o.status === "executed" && (o.mk || "IN") === mk).sort((a, b) => a.date.localeCompare(b.date)), flows = [], tradeFlows = []; let fees = 0, estimated = 0, actual = 0;
    for (const o of ex) { if (o.kind === "Corporate action") continue; const f = o.fees != null ? o.fees : PM.charges(o.side, o.qty * o.price, mk, cfg, o.kind).total; fees += f; if (o.fees != null) actual++; else estimated++; const v = o.side === "Buy" ? -(o.qty * o.price + f) : o.qty * o.price - f; flows.push([o.date, v]); tradeFlows.push([o.date, v]); }
    // dividends: shares held before each ex-date × the dividend per share (before tax deducted at source)
    const list = books[mk] || [], perStock = {}; let divTotal = 0;
    for (const sym of new Set(ex.map(o => o.sym))) {
      const c = co(orderCid(mk, sym)), fs0 = c ? feedSymbol(c) : mk === "IN" ? sym + ".NS" : sym;
      for (const d of all("SELECT * FROM dividends WHERE sym=? ORDER BY ex_date", fs0)) { const q = ex.filter(o => o.sym === sym && o.date < d.ex_date).reduce((a, o) => a + (o.side === "Buy" ? o.qty : -o.qty), 0); if (q > 1e-9) { const v = q * d.amount; (perStock[sym] ||= { total: 0, rows: [] }).total += v; perStock[sym].rows.push({ ex: d.ex_date, per: d.amount, qty: q, value: v, pay: d.pay_date }); divTotal += v; const when = d.pay_date && d.pay_date <= today ? d.pay_date : d.ex_date; if (when <= (list[0]?.date || today)) flows.push([when, v]); } }
    }
    const value = list.reduce((a, h) => a + h.q * h.close, 0), end = list[0]?.date || today;    // the last close: the same day the benchmark is valued
    const b = BENCH[mk]; let bench = null; if (b) { const D = dailyOf(b); if (D.rows.length > 100) { const C = PM.benchmarkCompare(tradeFlows, D.rows.map(r => r.date), D.adj, D.rows[D.rows.length - 1].date); if (C) bench = { label: b.label, value: C.value, xirr: C.xirr, asOf: D.rows[D.rows.length - 1].date, since: tradeFlows[0]?.[0] }; } }
    const tax = PM.taxReport(ex, cfg, mk), open = { st: 0, lt: 0 }; for (const [sym, lots] of Object.entries(tax.open)) { const h = list.find(x => x.sym === sym); if (!h) continue; for (const l of lots) { const g = l.qty * (h.close - l.price); if ((Date.parse(today) - Date.parse(l.date)) / 864e5 > cfg.tax.ltDays) open.lt += g; else open.st += g; } }
    out[mk] = { value, fees, feesEstimatedCount: estimated, feesActualCount: actual, dividends: divTotal, dividendsByStock: perStock, xirr: value > 0 || flows.length ? PM.xirr([...flows, [end, value]]) : null, bench, dividendsMissing: getSetting("dividends.missing", []), tax: { years: tax.years.map(y => ({ ...y })), unrealised: open }, taxConfig: cfg.tax, valueDate: end, cur: mk === "IN" ? "₹" : mk === "US" ? "$" : "₩" };
  }
  return out;
}

// ── your alert rules ─────────────────────────────────────────────────────
export const RULE_KINDS = { price_above: "price rises above", price_below: "price falls below", move: "moves more than this % in a day", range: "leaves its 1-week 90% range", results: "results within this many days", weight: "position above this % of the portfolio", port_loss: "portfolio falls more than this % in a day", yield_above: "yield rises above", yield_below: "yield falls below" };
export function saveRule(r) { if (!RULE_KINDS[r.kind]) throw new Error("Unknown rule"); const needsVal = r.kind !== "range"; if (needsVal && (r.value === null || r.value === undefined || r.value === "" || !Number.isFinite(+r.value))) throw new Error("Enter a value"); if (!r.target) throw new Error("Choose what this rule watches"); const id = r.id || crypto.randomBytes(6).toString("hex"); run("INSERT INTO alert_rules(id,kind,target,value,note,active,created) VALUES(?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,target=excluded.target,value=excluded.value,note=excluded.note,active=1,fired_at=NULL,fired_msg=NULL", id, r.kind, r.target || null, needsVal ? +r.value : null, r.note || "", now()); return id; }
const REPEATS = new Set(["move", "range", "results", "weight", "port_loss"]);    // once a day; level rules fire once until re-armed
const fire = (r, msg) => { run("UPDATE alert_rules SET fired_at=?, fired_msg=?, active=? WHERE id=?", now(), msg, REPEATS.has(r.kind) ? 1 : 0, r.id); log("rule", msg); notify("KUBER alert", msg); };
export function checkRules() {
  const rules = all("SELECT * FROM alert_rules WHERE active=1"); if (!rules.length) return; const today = new Date().toISOString().slice(0, 10), liveOf = c => { const L = STATE.live[feedSymbol(c)]; return L?.open && L.price > 0 ? L : null; }, firedToday = r => r.fired_at?.slice(0, 10) === today;
  for (const r of rules) {
    try {
      if (firedToday(r) && REPEATS.has(r.kind)) continue; const c = r.target && !/^(US|IN)\d+Y$/.test(r.target) && r.kind !== "port_loss" ? co(r.target) : null, L = c ? liveOf(c) : null, label = c?.nm || r.target;
      if (r.kind === "price_above" && L && L.price >= r.value) fire(r, `${label} is at ${L.price}, above your ${r.value}`);
      else if (r.kind === "price_below" && L && L.price <= r.value) fire(r, `${label} is at ${L.price}, below your ${r.value}`);
      else if (r.kind === "move" && L && Math.abs(L.chg) >= r.value) fire(r, `${label} has moved ${L.chg.toFixed(1)}% today`);
      else if (r.kind === "range" && L) { const p = get("SELECT p05, p95, made FROM preds WHERE kind='auto' AND H=1 AND cid=? ORDER BY made DESC LIMIT 1", c.id); if (p && (L.price < p.p05 || L.price > p.p95)) fire(r, `${label} at ${L.price} is outside its 1-week 90% range (${p.p05.toFixed(2)}–${p.p95.toFixed(2)})`); }
      else if (r.kind === "results" && c) { const e = get("SELECT date FROM company_events WHERE cid=? AND kind='results' AND date>=? ORDER BY date LIMIT 1", c.id, today); if (e && (Date.parse(e.date) - Date.parse(today)) / 864e5 <= r.value) fire(r, `${label} reports results on ${e.date}`); }
      else if (r.kind === "weight") { for (const list of Object.values(holdings())) { const h = list.find(x => x.cid === r.target); if (h && h.w * 100 >= r.value) fire(r, `${label} is ${(h.w * 100).toFixed(1)}% of your portfolio, above your ${r.value}% limit`); } }
      else if (r.kind === "port_loss") { const list = holdings()[r.target || "IN"] || []; let ret = 0, covered = 0; for (const h of list) { const Lq = liveOf(co(h.cid)); if (Lq && Number.isFinite(Lq.chg)) { ret += h.w * Lq.chg; covered += h.w; } } if (covered > 0.6 && ret <= -Math.abs(r.value)) fire(r, `Your ${r.target === "US" ? "US" : "India"} portfolio is down ${Math.abs(ret).toFixed(1)}% today`); }
      else if (r.kind === "yield_above" || r.kind === "yield_below") { const q = BSTATE.live[r.target]; if (q && Date.now() / 1000 - q.t < 3600 && (r.kind === "yield_above" ? q.y >= r.value : q.y <= r.value)) fire(r, `${r.target} yield is ${q.y.toFixed(3)}%, ${r.kind === "yield_above" ? "above" : "below"} your ${r.value}%`); }
    } catch (e) { log("rule", `rule ${r.id}: ${e.message}`); }
  }
}

// ── decision journal ─────────────────────────────────────────────────────
export function journalOrder(o, reason, review) {
  if (get("SELECT 1 AS x FROM journal WHERE order_id=?", o.id)) { if (reason || review) run("UPDATE journal SET reason=COALESCE(NULLIF(?,''),reason), review_date=COALESCE(NULLIF(?,''),review_date) WHERE order_id=?", reason || "", review || "", o.id); return; }
  const mk = o.mk || "IN", cid = orderCid(mk, o.sym), run0 = get("SELECT made, p0, vol, mu FROM ladder_runs WHERE cid=? ORDER BY made DESC LIMIT 1", cid), row = h => run0 ? get("SELECT p05, p50, p95, pUp FROM ladder WHERE cid=? AND made=? AND h=?", cid, run0.made, h) : null, y = { US10Y: BSTATE.live.US10Y?.y ?? null, IN10Y: BSTATE.live.IN10Y?.y ?? null };
  const snap = { px: o.price, run: run0 ? { made: run0.made, p0: run0.p0, vol: run0.vol, mu: run0.mu, m1: row(21), m3: row(63) } : null, yields: y }, d = new Date(Date.parse(o.date + "T00:00:00Z") + 90 * 864e5).toISOString().slice(0, 10);
  run("INSERT INTO journal(id,order_id,cid,sym,mk,side,date,reason,review_date,snapshot,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)", crypto.randomBytes(6).toString("hex"), o.id, cid, o.sym, mk, o.side, o.date, reason || "", review || d, JSON.stringify(snap), now());
}
export function journalList() {
  return all("SELECT * FROM journal ORDER BY date DESC, created DESC LIMIT 300").map(j => { const c = co(j.cid), snap = JSON.parse(j.snapshot || "{}"); let last = null, lastDate = null; if (c) { const D = dailyOf(c); if (D.rows.length) { last = D.rows[D.rows.length - 1].close; lastDate = D.rows[D.rows.length - 1].date; } } const L = c ? STATE.live[feedSymbol(c)] : null; return { ...j, snapshot: snap, nm: c?.nm || j.sym, cur: c?.cur || (j.mk === "IN" ? "₹" : "$"), now: L?.open && L.price > 0 ? L.price : last, nowDate: lastDate }; });
}
export function journalReview(id, { verdict, reason, review_date }) { run("UPDATE journal SET verdict=COALESCE(?,verdict), reason=COALESCE(?,reason), review_date=COALESCE(?,review_date), reviewed=CASE WHEN ? IS NOT NULL THEN ? ELSE reviewed END WHERE id=?", verdict ?? null, reason ?? null, review_date ?? null, verdict ?? null, now(), id); }

// ── the daily brief ──────────────────────────────────────────────────────
export function brief() {
  const today = new Date().toISOString().slice(0, 10), ids = trackedIds(), stocks = ids.map(co).filter(Boolean).map(c => { const L = STATE.live[feedSymbol(c)], D = dailyOf(c), n = D.rows.length, prev = n > 1 ? D.rows[n - 1].close : null, live = !!(L?.open && L.price > 0), px = live ? L.price : prev, chg = live && Number.isFinite(L.chg) ? L.chg : n > 1 ? (D.rows[n - 1].close / D.rows[n - 2].close - 1) * 100 : null, p = get("SELECT p05, p95, made, target FROM preds WHERE kind='auto' AND H=1 AND cid=? ORDER BY made DESC LIMIT 1", c.id); return { id: c.id, nm: c.nm, tk: c.tk, cur: c.cur, mk: mkOfC(c), px, chg, live, range: p && px ? (px < p.p05 ? "below" : px > p.p95 ? "above" : null) : null, p05: p?.p05, p95: p?.p95, source: L?.provider }; });
  const scored = all("SELECT cid, H, in90, in50, dirHit, median, p05, p95, actual, actual_date FROM preds WHERE kind='auto' AND scored IS NOT NULL AND scored >= ?", new Date(Date.now() - 36 * 3600e3).toISOString());
  const results = all("SELECT e.cid, e.date, e.expected, e.src FROM company_events e WHERE e.kind='results' AND e.date>=? AND e.date<=? ORDER BY e.date", today, new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)).filter(e => ids.includes(e.cid)).map(e => ({ ...e, nm: co(e.cid)?.nm || e.cid }));
  const syms = new Map(ids.map(co).filter(Boolean).map(c => [feedSymbol(c), c])), divs = all("SELECT sym, ex_date, amount, cur, pay_date FROM dividends WHERE ex_date>=? ORDER BY ex_date LIMIT 40", today).filter(d => syms.has(d.sym)).map(d => ({ ...d, nm: syms.get(d.sym).nm }));
  const y = s => { const q = BSTATE.live[s]; return q ? { y: q.y, chg: q.chg, t: q.t } : null; };
  return { at: now(), stocks, scoredRecent: { n: scored.length, in90: scored.length ? scored.filter(r => r.in90).length / scored.length : null, in50: scored.length ? scored.filter(r => r.in50).length / scored.length : null }, results, dividends: divs, yields: { US10Y: y("US10Y"), US2Y: y("US2Y"), IN10Y: y("IN10Y"), IN30Y: y("IN30Y") }, rules: all("SELECT * FROM alert_rules ORDER BY active DESC, created DESC"), ruleKinds: RULE_KINDS, journalDue: all("SELECT id, sym, side, date, review_date, reason FROM journal WHERE reviewed IS NULL AND review_date<=? ORDER BY review_date LIMIT 20", today), selftest: getSetting("selftest.last"), backup: getSetting("backup.last")?.at || null, cloud: getSetting("cloud")?.lastSync || null, maint: getSetting("maint.last"), feedBackup: null };
}
