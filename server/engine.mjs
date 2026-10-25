// Engine: active parameters, continuous analysis, prediction logging & scoring, learning epochs.
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, all, get, run, tx, log, now, getSetting, setSetting } from "./db.mjs";
import { company, trackedIds, STATE } from "./companies.mjs";
import { feedSymbol, dailySeries, adjustedDaily, dailyVariance, ticksOn, syncDaily, tradingToday, sessionOpen, nseBhavcopy, applyOfficial } from "./market.mjs";
import { sentimentAt } from "./llm.mjs";
const require = createRequire(import.meta.url);
export const Q = require("../web/model.js");

// ── parameters ───────────────────────────────────────────────────────────
export function activeParams() { return getSetting("params") || Q.DEFAULT_PARAMS; }
export function paramsVersion() { return get("SELECT MAX(id) AS v FROM params_history WHERE active=1")?.v || 0; }
Q.setParams(activeParams());
if (!get("SELECT 1 AS x FROM params_history LIMIT 1")) run("INSERT INTO params_history(ts, params, metrics, note, active) VALUES(?,?,?,?,1)", now(), JSON.stringify(Q.getParams()), fs.readFileSync(path.join(ROOT, "data", "backtest.json"), "utf8"), "Initial calibrated model (walk-forward backtest, 2,083 predictions)");
export function activateParams(p, note, metrics) {
  const full = Q.setParams(p); setSetting("params", full);
  tx(() => { run("UPDATE params_history SET active=0"); run("INSERT INTO params_history(ts, params, metrics, note, active) VALUES(?,?,?,?,1)", now(), JSON.stringify(full), JSON.stringify(metrics || null), note || "", ); });
  log("params", `Activated parameter set: ${note || "(no note)"}`); return full;
}

// ── worker pool: threads start when there is work and stop after 2 idle minutes (keeps memory low) ─────
const NW = Math.max(2, Math.min(6, os.cpus().length - 4)), pending = new Map(), workers = new Array(NW).fill(null), busy = new Array(NW).fill(0), idleT = new Array(NW).fill(null); let seq = 0, rr = 0;
function worker(i) {
  if (!workers[i]) { const w = new Worker(new URL("./worker.mjs", import.meta.url)); w.on("message", m => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); busy[i]--; armIdle(i); m.ok ? p.res(m.out) : p.rej(new Error(m.error)); }); w.on("error", e => { log("worker", e.message); workers[i] = null; }); workers[i] = w; }
  clearTimeout(idleT[i]); return workers[i];
}
function armIdle(i) { clearTimeout(idleT[i]); if (!busy[i]) idleT[i] = setTimeout(() => { if (!busy[i] && workers[i]) { workers[i].terminate(); workers[i] = null; } }, 120000); }
export const job = (task, payload, wi) => new Promise((res, rej) => { const i = wi ?? (rr++ % NW), id = ++seq; pending.set(id, { res, rej }); busy[i]++; worker(i).postMessage({ id, task, payload }); });

// ── per-stock model and learned calibration ──────────────────────────────
export function calibFor(cid) {
  const P = Q.getParams(); if (!P.learn.enabled || tuningOff(cid)) return {};
  const m = get("SELECT spec FROM stock_models WHERE cid=? AND accepted=1", cid), r = get("SELECT * FROM calib WHERE cid=? AND accepted=1", cid);
  return { ...(m ? { spec: JSON.parse(m.spec) } : {}), ...(r ? { kappaAdj: r.kappa_adj, muAdj: r.mu_adj } : {}) };
}
// dividend yield paid out of the price (capped: a trailing yield can include payouts made before a demerger)
export const divYield = c => Math.min(0.10, Math.max(0, (c.dy || 0) / 100));

// ── continuous analysis ──────────────────────────────────────────────────
const lastRun = {};
export function analyseLive(id, { H = 52, paths = 6000, trigger = "manual", minGapMs = 0 } = {}) {
  const key = id + "|" + H; if (minGapMs && lastRun[key] && Date.now() - lastRun[key] < minGapMs) return null;
  const c = company(id); if (!c) return null;
  const P = Q.getParams(), sent = P.drift.sentiment.on ? sentimentAt(c.id, c.wd[c.wd.length - 1]) : null;
  const A = Q.analyse(c, { H, paths, sentiment: sent, q: divYield(c), ...calibFor(c.id) }); if (!A) return null;
  lastRun[key] = Date.now();
  const row = { cid: c.id, ts: now(), px: A.px, H, median: A.mc.median, p05: A.mc.p05, p25: A.mc.p25, p75: A.mc.p75, p95: A.mc.p95, pUp: A.mc.pUp, mu: A.dr.mu, vol: A.vol, score: A.score ?? null, trigger };
  run("INSERT INTO analyses(cid,ts,px,H,median,p05,p25,p75,p95,pUp,mu,vol,score,trigger) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", ...Object.values(row));
  return { ...row, kappaAdj: A.kAdj, muAdj: A.muAdj, live: c.live || null };
}

// ── automatic forecasts on every completed weekly close (out-of-sample record) ──
// logged at every completed daily close: 1-week forecasts give fast feedback, 4 and 13 weeks the longer view
export const AUTO_H = [1, 4, 13];
export function makeAutoPreds(only) {
  let n = 0;
  for (const id of only || trackedIds()) {
    const c = company(id, { live: false }); if (!c || c.wk.length < 40) continue;
    const idx = c.wk.length - 1, d0 = c.wd[idx];
    for (const H of AUTO_H) {
      const pid = `auto|${id}|${d0}|${H}`; if (get("SELECT 1 AS x FROM preds WHERE id=?", pid)) continue;
      const A = Q.analyse(c, { idx, H, paths: 4000, light: true, q: divYield(c), ...calibFor(id) }); if (!A) continue;
      const target = new Date(Date.parse(d0) + H * 7 * 864e5).toISOString().slice(0, 10);
      run("INSERT INTO preds(id,cid,kind,made,H,target,p0,median,p05,p25,p75,p95,pUp,kappa,params_ver) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", pid, id, "auto", d0, H, target, A.px, A.mc.median, A.mc.p05, A.mc.p25, A.mc.p75, A.mc.p95, A.mc.pUp, A.kappa, paramsVersion()); n++;
    }
  }
  if (n) log("predict", `Logged ${n} new automatic forecasts`);
  return n;
}
// approximate PIT from stored quantiles (piecewise linear in log price)
function pitFrom(r, y) {
  const qs = [[0.05, r.p05], [0.25, r.p25], [0.5, r.median], [0.75, r.p75], [0.95, r.p95]].map(([p, v]) => [p, Math.log(v)]), x = Math.log(y);
  if (x <= qs[0][1]) return 0.05 * Math.exp(-(qs[0][1] - x) / Math.max(1e-6, qs[1][1] - qs[0][1]));
  if (x >= qs[4][1]) return 1 - 0.05 * Math.exp(-(x - qs[4][1]) / Math.max(1e-6, qs[4][1] - qs[3][1]));
  for (let i = 1; i < qs.length; i++) if (x <= qs[i][1]) { const [p0, a] = qs[i - 1], [p1, b] = qs[i]; return p0 + (p1 - p0) * (x - a) / (b - a || 1); }
  return 0.5;
}
// Outcome for a forecast made on `made` at price p0, from completed DAILY closes: the exchange close on the target
// date (or the last trading day before it). If a demerger-type corporate action happened in between, or the forecast
// was on a total-return basis, the value of one original share from the adjusted series.
const dailyCache = new Map();
// completed closes only: a row for a day still trading (or within 15 min of its close) is never used for scoring
function dailyFor(c) { const sym = feedSymbol(c); if (!dailyCache.has(sym)) { let rows = dailySeries(sym); const mk = c.mk === "TW" ? "US" : c.mk; if (rows.length && rows[rows.length - 1].date === tradingToday(mk)) rows = rows.slice(0, -1); dailyCache.set(sym, { rows, adj: adjustedDaily(rows).out }); } return dailyCache.get(sym); }
// The provider's daily history can lag its own quote after the close. The final quote is the official close:
// if they disagree, the stored close (and its adjusted value, proportionally) is corrected and logged.
export function confirmClose(c0) {
  // NSE: the final quote is the LAST TRADE, not the official close (a 30-minute VWAP); NSE closes come from the
  // official bhavcopy instead (officialCloses). US and KRX: the final quote is the closing auction price.
  if (c0.mk === "IN") return null;
  // only after the session: a thinly traded stock's quote can look "not open" mid-session (no trade for 45+ minutes)
  const mk = c0.mk === "TW" ? "US" : c0.mk;
  const sym = feedSymbol(c0), L = STATE.live[sym]; if (!L || L.open || sessionOpen(mk) || !L.day || !(L.price > 0)) return null;
  const r = get("SELECT close, adj FROM daily WHERE sym=? AND date=?", sym, L.day); if (!r || Math.abs(L.price / r.close - 1) < 1e-6) return null;
  run("UPDATE daily SET close=?, adj=CASE WHEN adj IS NULL THEN NULL ELSE adj * ? END WHERE sym=? AND date=?", L.price, L.price / r.close, sym, L.day);
  log("data", `${c0.id} ${L.day}: stored close ${r.close} corrected to the final quote ${L.price}`); dailyCache.delete(sym); return { from: r.close, to: L.price };
}
// self-healing: anything scored against the last 5 days is re-scored from the current (corrected) closes
export function rescoreRecent(days = 5) {
  const cut = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10); let n = 0;
  for (const T of ["ladder", "ladder_base"]) n += run(`UPDATE ${T} SET scored=NULL, actual=NULL, actual_date=NULL, in50=NULL, in90=NULL, qscore=NULL WHERE actual_date >= ?`, cut).changes;
  n += run("UPDATE preds SET scored=NULL, actual=NULL, actual_date=NULL WHERE kind='auto' AND actual_date >= ?", cut).changes;
  dailyCache.clear(); return n;
}
function actualOn(c, target, made, p0, basis) {
  const { rows, adj } = dailyFor(c); if (!rows.length) return null;
  if (rows[rows.length - 1].date < target) return null;                   // data hasn't reached the target date yet
  let i = rows.length - 1; while (i >= 0 && rows[i].date > target) i--; if (i < 0 || rows[i].date <= made) return null;
  if ((Date.parse(target) - Date.parse(rows[i].date)) / 864e5 > 6) return null;
  const action = (c.corpActions || []).find(a => a.date > made && a.date <= rows[i].date);
  if ((action || basis === "total") && p0) { let j = i; while (j >= 0 && rows[j].date > made) j--; if (j >= 0) return { actual: p0 * adj[i] / adj[j], date: rows[i].date, note: action ? `value per original share: corporate action on ${action.date}` : "value per original share, dividends included" }; }
  return { actual: rows[i].close, date: rows[i].date };
}
const closed = c => c.live ? { ...c, live: null, wd: c.wd.slice(0, -1), wk: c.wk.slice(0, -1), wkRaw: c.wkRaw?.slice(0, -1), wkVar: c.wkVar?.slice(0, -1) } : c;
// score matured automatic forecasts and your simulations
export function scoreMatured() {
  let n = 0; const cache = {}; const C = id => (cache[id] ??= company(id, { live: false })); dailyCache.clear();
  const settle = (r, a) => { const pit = pitFrom(r, a.actual); return { pit, in50: +(a.actual >= r.p25 && a.actual <= r.p75), in90: +(a.actual >= r.p05 && a.actual <= r.p95), dirHit: +((r.pUp >= 0.5) === (a.actual >= r.p0)), err: r.median / a.actual - 1, logErr: Math.log(a.actual / r.median), iscore: Q.intervalScore(r.p05, r.p95, a.actual) / r.p0 }; };
  for (const r of all("SELECT * FROM preds WHERE scored IS NULL")) {
    const c = C(r.cid); if (!c) continue; const a = actualOn(c, r.target, r.made, r.p0); if (!a) continue;
    const s = settle(r, a); run("UPDATE preds SET actual=?, actual_date=?, scored=?, pit=?, in50=?, in90=?, dirHit=?, err=?, logErr=?, iscore=? WHERE id=?", a.actual, a.date, now(), s.pit, s.in50, s.in90, s.dirHit, s.err, s.logErr, s.iscore, r.id); n++;
  }
  for (const row of all("SELECT * FROM sims WHERE status='pending'")) {
    const s0 = JSON.parse(row.data), c = C(s0.cid); if (!c) continue;
    const a = actualOn(c, s0.end, s0.buyUsed, s0.buyPx, s0.basis); if (!a) continue;
    const r = { p0: s0.buyPx, median: s0.median, p05: s0.p05, p25: s0.p25, p75: s0.p75, p95: s0.p95, pUp: s0.pUp, H: s0.H }, s = settle(r, a);
    const done = { ...s0, status: "scored", actual: a.actual, actualDate: a.date, actualNote: a.note || null, ...s, in50: !!s.in50, in90: !!s.in90, dirHit: !!s.dirHit, pnlActual: s0.shares * (a.actual - s0.buyPx), scoredAt: now() };
    tx(() => {
      run("UPDATE sims SET status='scored', data=? WHERE id=?", JSON.stringify(done), row.id);
      run("INSERT OR REPLACE INTO preds(id,cid,kind,made,H,target,p0,median,p05,p25,p75,p95,pUp,kappa,params_ver,actual,actual_date,scored,pit,in50,in90,dirHit,err,logErr,iscore) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        "user|" + row.id, s0.cid, "user", s0.buyUsed, s0.H, s0.end, s0.buyPx, s0.median, s0.p05, s0.p25, s0.p75, s0.p95, s0.pUp, s0.kappa ?? null, paramsVersion(), a.actual, a.date, now(), s.pit, s.in50, s.in90, s.dirHit, s.err, s.logErr, s.iscore);
    });
    log("simulation", `Scored your simulation on ${s0.name}: forecast ${s0.median.toFixed(2)} vs actual ${a.actual.toFixed(2)} (${(s.err * 100).toFixed(1)}%)`); n++;
  }
  return n;
}
// ── learning epochs ──────────────────────────────────────────────────────
let learning = null;
export function learn(ids) { if (!learning) learning = runLearn(ids).finally(() => { learning = null; }); return learning; }
async function runLearn(ids) {
  const list = (ids || trackedIds()).map(id => company(id, { live: false })).filter(c => c && c.wk.length > 20);
  const preds = {}; for (const r of all("SELECT * FROM preds WHERE scored IS NOT NULL")) (preds[r.cid] ||= []).push(r);
  const runId = now(), params = Q.getParams(), chunks = Array.from({ length: NW }, () => []);
  list.sort((a, b) => b.wk.length - a.wk.length).forEach((c, i) => chunks[i % NW].push(c));
  const res = (await Promise.all(chunks.map((cs, wi) => cs.length ? job("learn", { companies: cs, preds, params }, wi) : []))).flat();
  tx(() => {
    for (const r of res) {
      const S = r.model;
      if (S) {
        run("INSERT INTO stock_models(cid,spec,accepted,metrics,updated) VALUES(?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET spec=excluded.spec, accepted=excluded.accepted, metrics=excluded.metrics, updated=excluded.updated",
          r.cid, JSON.stringify(S.spec), S.accepted ? 1 : 0, JSON.stringify({ ...S, spec: undefined, trail: S.trail }), now());
        run("INSERT INTO stock_model_log(run,cid,spec,accepted,sel_score,base_sel,hold_score,base_hold,dm_t,n_sel,n_hold,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", runId, r.cid, JSON.stringify(S.candidate || S.spec), S.accepted ? 1 : 0, S.selScore ?? null, S.baseSel ?? null, S.holdScore ?? null, S.baseHold ?? null, S.dm?.t ?? null, S.nSel ?? 0, S.nHold ?? 0, S.note);
      }
      for (const e of r.epochs) run("INSERT INTO learn_log(ts,run,cid,epoch,n_train,n_valid,kappa_adj,mu_adj,base_score,new_score,accepted,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", now(), runId, r.cid, e.epoch, e.nTrain, e.nValid, e.kr, e.mu, e.base, e.adj, e.accepted ? 1 : 0, "");
      const prev = get("SELECT epochs FROM calib WHERE cid=?", r.cid);
      run("INSERT INTO calib(cid,kappa_adj,mu_adj,n,epochs,accepted,metrics,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET kappa_adj=excluded.kappa_adj, mu_adj=excluded.mu_adj, n=excluded.n, epochs=excluded.epochs, accepted=excluded.accepted, metrics=excluded.metrics, updated=excluded.updated",
        r.cid, r.kappaAdj ?? 1, r.muAdj ?? 0, r.n, (prev?.epochs || 0) + r.epochs.length, r.accepted ? 1 : 0, JSON.stringify({ note: r.note, meanGain: r.meanGain, coverage: r.coverage, nLive: r.nLive, fitted: r.fitted, epochs: r.epochs }), now());
    }
  });
  await learnLadder(list.map(c => c.id), chunks.length);
  setSetting("learn.last", runId);
  log("learn", `Learning run: ${res.filter(r => r.model?.accepted).length}/${res.length} stocks use their own model; ${res.filter(r => r.accepted).length}/${res.length} keep a calibration adjustment`);
  return res;
}
export async function validate(candidate) {
  const list = Object.keys(STATE.base).map(id => company(id, { live: false }));
  return job("validate", { companies: list, active: Q.getParams(), candidate });
}
export function trackRecord() {
  const rows = all("SELECT * FROM preds WHERE scored IS NOT NULL"), sum = rs => rs.length ? { n: rs.length, in50: Q.mean(rs.map(r => r.in50)), in90: Q.mean(rs.map(r => r.in90)), dir: Q.mean(rs.map(r => r.dirHit)), medErr: rs.map(r => Math.abs(r.err)).sort((a, b) => a - b)[Math.floor(rs.length / 2)], iscore: Q.mean(rs.map(r => r.iscore)) } : null;
  const by = {}; for (const r of rows) (by[r.cid] ||= []).push(r);
  const byH = {}; for (const r of rows) (byH[r.H] ||= []).push(r);
  return { byH: Object.fromEntries(Object.entries(byH).map(([k, v]) => [k, sum(v)])), all: sum(rows), auto: sum(rows.filter(r => r.kind === "auto")), user: sum(rows.filter(r => r.kind === "user")), byCompany: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, sum(v)])), pending: get("SELECT COUNT(*) AS n FROM preds WHERE scored IS NULL").n, recent: all("SELECT * FROM preds WHERE scored IS NOT NULL ORDER BY scored DESC LIMIT 40") };
}

// ── end of each trading day, per stock ───────────────────────────────────
// 1 official daily bar (with open/high/low)  2 realised volatility from KUBER's own intraday samples and from the
// day's range, next to the model's forecast  3 new forecasts on the completed close  4 score what matured  5 learn
const SESSION = { IN: ["Asia/Kolkata", 555, 930], US: ["America/New_York", 570, 960], TW: ["America/New_York", 570, 960], KR: ["Asia/Seoul", 540, 930] };
function sessionBounds(mk, date) {   // unix seconds of session open/close on a local date
  const [tz, a, b] = SESSION[mk] || SESSION.US, guess = Date.parse(date + "T12:00:00Z");
  const off = (() => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess; })();
  const mid = Date.parse(date + "T00:00:00Z") - off; return [(mid + a * 60e3) / 1000, (mid + b * 60e3) / 1000];
}
export function realisedDay(c, date) {
  const sym = feedSymbol(c), [t0, t1] = sessionBounds(c.mk, date), ticks = ticksOn(sym, t0 - 60, t1 + 900);
  // 5-minute sampling (last sample in each bucket) to limit microstructure noise
  const b = new Map(); for (const t of ticks) b.set(Math.floor((t.ts - t0) / 300), t.price);
  const keys = [...b.keys()].sort((x, y) => x - y); let rv5 = 0, n5 = 0;
  for (let k = 1; k < keys.length; k++) if (keys[k] === keys[k - 1] + 1) { rv5 += Math.log(b.get(keys[k]) / b.get(keys[k - 1])) ** 2; n5++; }
  const rows = dailySeries(sym), i = rows.findIndex(r => r.date === date); let rs = null, on = null, close = null;
  if (i > 0) { const two = rows.slice(i - 1, i + 1), out = adjustedDaily(two).out, v = dailyVariance(two, out).v[1]; close = rows[i].close; const r = rows[i]; if (r.open > 0 && r.high > 0 && r.low > 0) { rs = Math.log(r.high / r.close) * Math.log(r.high / r.open) + Math.log(r.low / r.close) * Math.log(r.low / r.open); on = v - Math.max(0, rs); } }
  const cc = company(c.id, { live: false }), A = cc && Q.analyse(cc, { H: 1, paths: 500, light: true, ...calibFor(c.id) });
  run("INSERT INTO rv(sym,date,n_ticks,n_5m,rv_5m,rs_range,overnight,close,model_vol,first_ts,last_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sym,date) DO UPDATE SET n_ticks=excluded.n_ticks, n_5m=excluded.n_5m, rv_5m=excluded.rv_5m, rs_range=excluded.rs_range, overnight=excluded.overnight, close=excluded.close, model_vol=excluded.model_vol, first_ts=excluded.first_ts, last_ts=excluded.last_ts",
    sym, date, ticks.length, n5, n5 ? rv5 : null, rs, on, close, A ? A.G.vH(1) : null, ticks[0]?.ts ?? null, ticks[ticks.length - 1]?.ts ?? null);
  return { ticks: ticks.length, n5, rv5 };
}
export async function endOfDay(id, reason = "close") {
  const c0 = STATE.base[id] || company(id); if (!c0) return null; const sym = feedSymbol(c0);
  if (reason !== "catch-up") try { await syncDaily(c0, "1M"); } catch (e) { log("feed", `${id}: end-of-day sync failed: ${e.message}`); }
  confirmClose(c0);
  dailyCache.delete(sym);
  const last = get("SELECT MAX(date) AS d FROM daily WHERE sym=?", sym)?.d; if (!last || get("SELECT 1 AS x FROM eod WHERE sym=? AND date=?", sym, last)) return null;
  const R = realisedDay(c0, last), nP = makeAutoPreds([id]), nL = makeLadder([id]), nS = scoreMatured() + scoreLadder(); trialGuard();
  run("INSERT OR REPLACE INTO eod(sym,date,done) VALUES(?,?,?)", sym, last, now());
  log("eod", `${id} ${last} (${reason}): ${R.ticks} live samples stored, ${R.n5} five-minute returns, ${nP} forecasts logged, ${nS} scored`);
  return { date: last, ...R, nP, nS };
}
// keep 4 years (setting "retention.years") of intraday samples, analyses and logs; daily prices and forecasts are kept forever
export function prune() {
  const yrs = getSetting("retention.years", 4), cut = Date.now() - yrs * 365.25 * 864e5, iso = new Date(cut).toISOString();
  const a = run("DELETE FROM ticks WHERE ts < ?", Math.floor(cut / 1000)).changes, b = run("DELETE FROM analyses WHERE ts < ?", iso).changes, d = run("DELETE FROM events WHERE ts < ?", iso).changes, e = run("DELETE FROM dq WHERE date < ?", iso.slice(0, 10)).changes;
  if (a + b + d + e) log("retention", `Removed data older than ${yrs} years: ${a} samples, ${b} analyses, ${d} log lines, ${e} quality rows`);
}

// ── 90-trading-day outlook ───────────────────────────────────────────────
const tuningOff = cid => (getSetting("tuning.off", {}) || {})[cid];
export function ladderCalib(cid) { if (tuningOff(cid)) return { kappa: [1, 1, 1, 1], weights: null, off: true }; const r = get("SELECT * FROM ladder_calib WHERE cid=?", cid); return r ? { kappa: JSON.parse(r.kappa), weights: r.weights ? JSON.parse(r.weights) : null } : { kappa: [1, 1, 1, 1], weights: null }; }
export function makeLadder(only) {
  let n = 0;
  for (const id of only || trackedIds()) {
    const c = company(id, { live: false, daily: true }); if (!c || !c.dA || c.wk.length < 60) continue;
    const made = c.dd[c.dd.length - 1]; if (get("SELECT 1 AS x FROM ladder_runs WHERE cid=? AND made=?", id, made)) continue;
    const LC = ladderCalib(id), cf = calibFor(id), q = divYield(c);
    const A = Q.analyse(c, { H: 13, paths: 300, light: true, allSignals: true, q, spec: cf.spec, ...(LC.weights ? { weights: LC.weights } : {}) }); if (!A) continue;
    const mu = A.dr.mu + (LC.weights ? 0 : cf.muAdj || 0) - q, L = Q.ladder(c, { mu, paths: 4000, kappa: LC.kappa }); if (!L) continue;
    // control arm: the standard model (no per-stock spec, weights, band factors or drift correction), same seed
    const A0 = Q.analyse(c, { H: 13, paths: 300, light: true, q }), L0 = A0 && Q.ladder(c, { mu: A0.dr.mu - q, paths: 4000 });
    tx(() => {
      run("INSERT INTO ladder_runs(cid,made,p0,mu,q,vol,signals,weights,kappa,spec,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, made, L.px, mu, q, L.annVol, JSON.stringify(Object.fromEntries(A.sig.map(x => [x.id, x.mu]))), JSON.stringify(LC.weights), JSON.stringify(LC.kappa), JSON.stringify(cf.spec || null), now());
      for (const r of L.rows) run("INSERT OR IGNORE INTO ladder(cid,made,h,p0,p05,p25,p50,p75,p95,pUp) VALUES(?,?,?,?,?,?,?,?,?,?)", id, made, r.h, L.px, r.p05, r.p25, r.p50, r.p75, r.p95, r.pUp);
      if (L0) for (const r of L0.rows) run("INSERT OR IGNORE INTO ladder_base(cid,made,h,p0,p05,p25,p50,p75,p95,pUp) VALUES(?,?,?,?,?,?,?,?,?,?)", id, made, r.h, L0.px, r.p05, r.p25, r.p50, r.p75, r.p95, r.pUp);
    }); n++;
  }
  if (n) log("ladder", `Logged 90-day outlooks for ${n} stock${n > 1 ? "s" : ""}`);
  return n;
}
// score every outlook day whose date has arrived: the close h trading days after the run
export function scoreLadder() { dailyCache.clear(); return scoreTable("ladder") + scoreTable("ladder_base"); }
function scoreTable(T) {
  let n = 0;
  const open = all(`SELECT DISTINCT cid, made FROM ${T} WHERE scored IS NULL`);
  const byC = {}; for (const r of open) (byC[r.cid] ||= []).push(r.made);
  for (const cid of Object.keys(byC)) {
    const c = company(cid, { live: false }); if (!c) continue; const { rows, adj } = dailyFor(c);
    tx(() => { for (const made of byC[cid]) {
      const j = rows.findIndex(r => r.date === made); if (j < 0) continue;
      for (const L of all(`SELECT * FROM ${T} WHERE cid=? AND made=? AND scored IS NULL AND h <= ?`, cid, made, rows.length - 1 - j)) {
        const k = j + L.h, act = (c.corpActions || []).some(a => a.date > made && a.date <= rows[k].date), y = act ? L.p0 * adj[k] / adj[j] : rows[k].close;
        run(`UPDATE ${T} SET actual=?, actual_date=?, scored=?, in50=?, in90=?, qscore=? WHERE cid=? AND made=? AND h=?`, y, rows[k].date, now(), +(y >= L.p25 && y <= L.p75), +(y >= L.p05 && y <= L.p95),
          Q.quantileScore([[0.05, L.p05], [0.25, L.p25], [0.5, L.p50], [0.75, L.p75], [0.95, L.p95]], y) / L.p0, cid, made, L.h); n++;
      }
    } });
  }
  if (n && T === "ladder") log("ladder", `Scored ${n} outlook days against actual closes`);
  return n;
}
// ── the trial: tuned vs standard on the same days, per stock ─────────────
// paired loss differences (standard − tuned quantile score) on outlook days scored for both; Diebold–Mariano with a
// Newey–West lag of 10 for the overlap. If, after 200+ paired days, the standard model is significantly better
// (t < −2), that stock's tuning is switched off automatically and logged; it can be re-enabled on the Trial page.
export function trialCompare(cid) {
  const rows = all("SELECT t.made, t.h, t.qscore AS qt, b.qscore AS qb, t.in90 AS it, b.in90 AS ib, t.in50 AS ht, b.in50 AS hb FROM ladder t JOIN ladder_base b ON b.cid=t.cid AND b.made=t.made AND b.h=t.h WHERE t.cid=? AND t.scored IS NOT NULL AND b.scored IS NOT NULL ORDER BY t.made, t.h", cid);
  if (!rows.length) return { n: 0 };
  const d = rows.map(r => r.qb - r.qt), dm = Q.dmTest(d, 10), m = k => Q.mean(rows.map(r => r[k]));
  const byB = Q.LB.map(([a, b]) => { const rs = rows.filter(r => r.h >= a && r.h <= b); return { range: `${a}–${b}`, n: rs.length, in90t: rs.length ? Q.mean(rs.map(r => r.it)) : null, in90b: rs.length ? Q.mean(rs.map(r => r.ib)) : null, qt: rs.length ? Q.mean(rs.map(r => r.qt)) : null, qb: rs.length ? Q.mean(rs.map(r => r.qb)) : null }; });
  return { n: rows.length, days: new Set(rows.map(r => r.made)).size, qt: m("qt"), qb: m("qb"), in90t: m("it"), in90b: m("ib"), in50t: m("ht"), in50b: m("hb"), gain: 1 - m("qt") / m("qb"), dm, byBucket: byB,
    verdict: rows.length < 200 ? "too early" : dm.t > 2 ? "tuned is better" : dm.t < -2 ? "standard is better" : "no clear difference" };
}
export function trialGuard() {
  const off = getSetting("tuning.off", {}) || {}; let changed = 0;
  for (const cid of trackedIds()) { if (off[cid]) continue; const T = trialCompare(cid); if (T.n >= 200 && T.dm.t < -2) { off[cid] = { at: now(), reason: `live: standard model better on ${T.n} paired outlook days (Diebold–Mariano t ${T.dm.t.toFixed(2)})` }; changed++; log("trial", `${cid}: tuning switched off; ${off[cid].reason}`); } }
  if (changed) setSetting("tuning.off", off);
  return changed;
}
export async function learnLadder(ids, nChunks = NW) {
  const list = ids.map(id => company(id, { live: false, daily: true })).filter(c => c && c.dA), live = {};
  for (const r of all("SELECT * FROM ladder WHERE scored IS NOT NULL")) (live[r.cid] ||= []).push(r);
  const specs = Object.fromEntries(list.map(c => [c.id, calibFor(c.id).spec || null])), chunks = Array.from({ length: nChunks }, () => []);
  list.forEach((c, i) => chunks[i % nChunks].push(c));
  const res = (await Promise.all(chunks.map((cs, wi) => cs.length ? job("ladder", { companies: cs, live, params: Q.getParams(), specs }, wi) : []))).flat();
  tx(() => { for (const r of res) run("INSERT INTO ladder_calib(cid,kappa,weights,metrics,updated) VALUES(?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET kappa=excluded.kappa, weights=excluded.weights, metrics=excluded.metrics, updated=excluded.updated", r.cid, JSON.stringify(r.kappa), r.weights ? JSON.stringify(r.weights) : null, JSON.stringify(r), now()); });
  log("ladder", `Outlook learning: ${res.filter(r => r.kappaOk?.some(Boolean)).length}/${res.length} stocks keep horizon band factors, ${res.filter(r => r.weights).length}/${res.length} keep factor weights`);
  return res;
}
export function ladderView(cid) {
  const last = get("SELECT * FROM ladder_runs WHERE cid=? ORDER BY made DESC LIMIT 1", cid), cal = get("SELECT * FROM ladder_calib WHERE cid=?", cid);
  const rec = all("SELECT h, in50, in90, qscore FROM ladder WHERE cid=? AND scored IS NOT NULL", cid), B = Q.LB.map(([a, b]) => { const rs = rec.filter(r => r.h >= a && r.h <= b); return { range: `${a}–${b}`, n: rs.length, in90: rs.length ? Q.mean(rs.map(r => r.in90)) : null, in50: rs.length ? Q.mean(rs.map(r => r.in50)) : null }; });
  return { run: last ? { ...last, signals: JSON.parse(last.signals), weights: JSON.parse(last.weights), kappa: JSON.parse(last.kappa) } : null, rows: last ? all("SELECT * FROM ladder WHERE cid=? AND made=? ORDER BY h", cid, last.made) : [],
    calib: cal ? { ...JSON.parse(cal.metrics), updated: cal.updated } : null, record: B, runs: get("SELECT COUNT(*) AS n FROM ladder_runs WHERE cid=?", cid).n, scored: rec.length,
    pending: get("SELECT COUNT(*) AS n FROM ladder WHERE cid=? AND scored IS NULL", cid).n };
}

// ── official NSE closes ──────────────────────────────────────────────────
// For each of the last NSE trading days without official closes, download NSE's bhavcopy (published each evening),
// store the official prices for every tracked NSE stock and apply them. If a close moved by more than 0.1%, that
// day's forecasts and outlooks were anchored to a provisional price: they are re-logged and everything re-scored.
const bhavTried = {};
export async function officialCloses() {
  const ids = trackedIds().map(id => company(id, { live: false })).filter(c => c && c.mk === "IN"); if (!ids.length) return 0;
  // every recent day on which any tracked NSE stock lacks its official close (a stock added to the wishlist today needs
  // the past days too: 23 Oct 2026, two stocks added that morning had none because those days were already done for the others)
  const syms = ids.map(c => feedSymbol(c)), since = new Date(Date.now() - 12 * 864e5).toISOString().slice(0, 10);
  const dates = all(`SELECT DISTINCT d.date FROM daily d WHERE d.sym IN (${syms.map(() => "?").join(",")}) AND d.date >= ? AND NOT EXISTS (SELECT 1 FROM official_close o WHERE o.sym = d.sym AND o.date = d.date) ORDER BY d.date DESC`, ...syms, since).map(r => r.date).filter(d => d !== tradingToday("IN") && !(Date.now() - (bhavTried[d] || 0) < 6 * 3600e3)).slice(0, 10);
  dates.forEach(d => { bhavTried[d] = Date.now(); });   // a day a stock can't get (holiday file, suspended stock) is retried after 6 hours, not every run
  let changed = 0;
  for (const date of dates) {
    const bc = await nseBhavcopy(date); if (!bc) continue;
    for (const c of ids) {
      const o = bc[c.tk]; if (!o || !(o.close > 0)) continue; const sym = feedSymbol(c), before = get("SELECT close FROM daily WHERE sym=? AND date=?", sym, date)?.close;
      run("INSERT INTO official_close(sym,date,open,high,low,close,last,source,fetched) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(sym,date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, last=excluded.last, fetched=excluded.fetched", sym, date, o.open, o.high, o.low, o.close, o.last, "NSE bhavcopy", now());
      applyOfficial(sym); dailyCache.delete(sym);
      run("INSERT INTO verify(cid,src_date,src_close,feed_close,diff,ok,checked) VALUES(?,?,?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET src_date=excluded.src_date, src_close=excluded.src_close, feed_close=excluded.feed_close, diff=excluded.diff, ok=excluded.ok, checked=excluded.checked", c.id, date, o.close, before ?? o.close, before ? before / o.close - 1 : 0, before && Math.abs(before / o.close - 1) > 0.01 ? 0 : 1, now() + " via NSE bhavcopy");
      if (before && Math.abs(o.close / before - 1) > 0.001) {
        changed++; log("data", `${c.id} ${date}: official NSE close ${o.close} (stored ${before}, last trade ${o.last}); forecasts from that close re-logged`);
        tx(() => { for (const T of ["ladder", "ladder_base"]) run(`DELETE FROM ${T} WHERE cid=? AND made=?`, c.id, date); run("DELETE FROM ladder_runs WHERE cid=? AND made=?", c.id, date); run("DELETE FROM preds WHERE kind='auto' AND cid=? AND made=?", c.id, date); });
      }
    }
    log("data", `NSE official closes for ${date} applied to ${ids.length} stocks`);
  }
  if (changed) { rescoreRecent(); makeAutoPreds(ids.map(c => c.id)); makeLadder(ids.map(c => c.id)); scoreMatured(); scoreLadder(); }
  return changed;
}
// Forecasts and outlooks must start from the stored (final, official) close. If the close changed after they were
// logged (provider history settled, official NSE close arrived), re-log them from the right price.
export function reanchor() {
  let n = 0;
  for (const id of trackedIds()) {
    const c = company(id, { live: false }); if (!c) continue; const sym = feedSymbol(c), last = get("SELECT date, close FROM daily WHERE sym=? AND date < COALESCE(?, '9999') ORDER BY date DESC LIMIT 1", sym, tradingToday(c.mk === "TW" ? "US" : c.mk)); if (!last) continue;
    const r = get("SELECT p0 FROM ladder_runs WHERE cid=? AND made=?", id, last.date), p = get("SELECT p0 FROM preds WHERE cid=? AND made=? AND kind='auto' LIMIT 1", id, last.date);
    if ((r && Math.abs(r.p0 / last.close - 1) > 0.001) || (p && Math.abs(p.p0 / last.close - 1) > 0.001)) {
      tx(() => { for (const T of ["ladder", "ladder_base"]) run(`DELETE FROM ${T} WHERE cid=? AND made=?`, id, last.date); run("DELETE FROM ladder_runs WHERE cid=? AND made=?", id, last.date); run("DELETE FROM preds WHERE kind='auto' AND cid=? AND made=?", id, last.date); });
      makeAutoPreds([id]); makeLadder([id]); n++; log("data", `${id} ${last.date}: forecasts re-logged from the final close ${last.close} (were anchored at ${(r || p).p0})`);
    }
  }
  return n;
}
