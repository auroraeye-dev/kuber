// KUBER local server — http://127.0.0.1:8777  (only listens on this Mac)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { ROOT, all, get, run, tx, log, now, getSetting, setSetting } from "./db.mjs";
import { STATE, loadBase, company, trackedIds, runVerification, heldIds, orderCid } from "./companies.mjs";
import { feedSymbol, syncDaily, quote, ticksToday, saPath, dailySeries, adjustedDaily } from "./market.mjs";
import { Q, activeParams, activateParams, analyseLive, makeAutoPreds, scoreMatured, learn, validate, trackRecord, calibFor, paramsVersion, job, divYield, endOfDay, prune, makeLadder, scoreLadder, ladderView, trialCompare, trialGuard, confirmClose, rescoreRecent, realisedDay, officialCloses, reanchor } from "./engine.mjs";
import * as CLOUD from "./cloud.mjs";
import * as BACKUP from "./backup.mjs";
import * as CATALOG from "./catalog.mjs";
import * as ARCHIVE from "./archive.mjs";
import * as HEALTH from "./health.mjs";
import * as LLM from "./llm.mjs";
import * as BONDS from "./bonds.mjs";

const PORT = +(process.env.KUBER_PORT || 8777);
loadBase(); importNews();

// ── PIN lock ─────────────────────────────────────────────────────────────
// The PIN is stored as a salted scrypt hash. A session cookie (HttpOnly, SameSite=Strict) unlocks the API;
// requests from other websites or other host names are refused outright.
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, "hex"), 32).toString("hex");
function setPin(pin) { const salt = crypto.randomBytes(16).toString("hex"); setSetting("auth.pin", { salt, hash: hashPin(pin, salt), digits: String(pin).length, set: now() }); }
if (!getSetting("auth.pin")) { const first = String(crypto.randomInt(100000, 1000000)); setPin(first); console.log(`KUBER first run: your PIN is ${first}. Change it on System → Security.`); log("auth", "PIN lock enabled (first-run PIN printed to the console)"); }
function pinOk(pin) { const a = getSetting("auth.pin"); if (!a || !/^\d{4,8}$/.test(String(pin))) return false; const h = Buffer.from(hashPin(pin, a.salt), "hex"); return crypto.timingSafeEqual(h, Buffer.from(a.hash, "hex")); }
const SESS_IDLE = 4 * 3600e3, sessions = new Map(), guard = { fails: 0, until: 0 };
const cookieOf = req => Object.fromEntries((req.headers.cookie || "").split(";").map(x => x.trim().split("=")).filter(x => x[0]));
function authed(req) { const t = cookieOf(req).kuber_s, s = t && sessions.get(t); if (!s) return false; if (Date.now() - s.last > SESS_IDLE) { sessions.delete(t); return false; } s.last = Date.now(); return true; }
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const PUBLIC = new Set(["/login", "/api/login", "/api/login-info", "/style.css", "/kuber-logo.png", "/favicon.png"]);

// ── SSE clients ──────────────────────────────────────────────────────────
const clients = new Map();   // id -> { res, focus:Set }
function broadcast(event, data) { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients.values()) c.res.write(s); }
const focused = () => new Set([...clients.values()].flatMap(c => [...c.focus]));

// ── market sessions ──────────────────────────────────────────────────────
const SESS = { IN: ["Asia/Kolkata", 9 * 60 + 15, 15 * 60 + 30], US: ["America/New_York", 9 * 60 + 30, 16 * 60], TW: ["America/New_York", 9 * 60 + 30, 16 * 60], KR: ["Asia/Seoul", 9 * 60, 15 * 60 + 30] };
function marketOpen(mk) {
  const [tz, a, b] = SESS[mk] || SESS.US, p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false; const m = +p.hour * 60 + +p.minute; return m >= a && m <= b;
}
const open_ = c => marketOpen(c.mk === "TW" ? "US" : c.mk);
export const markets = () => Object.fromEntries(["IN", "US", "KR"].map(m => [m, marketOpen(m)]));

// ── live capture loop ────────────────────────────────────────────────────
// While a stock's market is open, every tracked stock is sampled at least once a minute (the company page you have
// open: every 15 s), whether or not the KUBER window is open. Each sample is validated before it is stored.
// When the session ends, the end-of-day pipeline runs for that stock.
const lastPoll = {}, lastBg = {}; let ticking = false;
async function poll(id) {
  const c = STATE.base[id] ? STATE.base[id] : company(id); if (!c) return;
  const sym = feedSymbol(c);
  try {
    const q = await quote(c); const prev = STATE.live[sym];
    if (q.quality?.ok === false) return;
    q.fetchedAt = Date.now(); STATE.live[sym] = q;
    if (!prev || prev.price !== q.price) broadcast("quote", { id, sym, price: q.price, chg: q.chg, time: q.time, open: q.open });
    if (!q.open && prev?.open) { log("market", `${id}: session closed at ${q.price}; end-of-day run in 20 minutes, once the official close has settled`); setTimeout(() => endOfDay(id).then(r => { if (r) { broadcast("refresh", { reason: "eod", id }); if (r.nS) learn().then(() => broadcast("learn", { at: now() })).catch(e => log("learn", e.message)); } }).catch(e => log("eod", e.stack)), 20 * 60e3); }
  } catch (e) { log("feed", e.message); }
}
// The source refreshes each quote about once a minute. KUBER learns each stock's refresh second from the quote
// timestamp and asks ~4 s after it, so prices on screen trail the source by seconds rather than up to two minutes.
const busyPoll = new Set();
function dueAt(id, sym) { const L = STATE.live[sym]; if (L?.open && L.time) { const next = (L.time + 60 + 4) * 1000; return lastPoll[id] && lastPoll[id] >= next ? lastPoll[id] + 15000 : next; } return (lastPoll[id] || 0) + 60000; }
let lastTickAt = Date.now();
async function tick() {
  // a long gap between ticks means the Mac was asleep: catch up from the cloud and run missed end-of-day steps
  const gap = Date.now() - lastTickAt; lastTickAt = Date.now();
  if (gap > 5 * 60e3) { log("power", `Mac woke after ${Math.round(gap / 60e3)} minutes asleep: catching up`); maintenance("wake").catch(e => log("maint", e.message)); }
  if (ticking) return; ticking = true;
  try {
    const open = markets(), ids = trackedIds(), f = focused(), t0 = Date.now(), cOf = id => STATE.base[id] || company(id), mkOf = id => { const c = cOf(id); return c ? (c.mk === "TW" ? "US" : c.mk) : null; };
    const live = ids.filter(id => open[mkOf(id)]), closing = ids.filter(id => !open[mkOf(id)] && STATE.live[feedSymbol(cOf(id))]?.open);
    const due = [...live, ...[...f].filter(id => !live.includes(id) && open[mkOf(id)])].filter(id => { const c = cOf(id); return c && !busyPoll.has(id) && t0 >= Math.min(dueAt(id, feedSymbol(c)), f.has(id) ? (lastPoll[id] || 0) + 15000 : Infinity); });
    for (const id of [...due, ...closing.filter(id => !busyPoll.has(id))]) { busyPoll.add(id); lastPoll[id] = Date.now(); poll(id).finally(() => busyPoll.delete(id)); }   // concurrent; the rate limiter paces them
    // continuous analysis: open company pages every minute; every other live stock every 15 minutes
    for (const id of live) {
      const fg = f.has(id), r = analyseLive(id, { trigger: fg ? "live" : "live-bg", minGapMs: fg ? 60000 : 900000, paths: fg ? 6000 : 3000 });
      if (r && fg) broadcast("analysis", r);
    }
  } finally { ticking = false; }
}
setInterval(() => tick().catch(e => log("tick", e.message)), 3000);
// keep the Mac from idle-sleeping while a tracked market is open, so no session goes unrecorded (setting "awake")
let awake = null;
function keepAwake() {
  const want = getSetting("awake", true) && trackedIds().some(id => { const c = STATE.base[id] || company(id); return c && open_(c); });
  if (want && !awake) { awake = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }); awake.on("exit", () => { awake = null; }); log("power", "Market open: keeping the Mac awake while KUBER records it"); }
  if (!want && awake) { awake.kill(); awake = null; log("power", "Markets closed: normal sleep allowed"); }
}
setInterval(keepAwake, 60000); setTimeout(keepAwake, 5000);

// ── maintenance: history sync, verification, forecasts, scoring, learning, news ──
// cloud collector: keep its stock list current, then pull in prices the Mac missed and refresh those days' realised volatility
async function cloudCatchUp(reason) {
  if (!(await CLOUD.collectorAvailable())) return null;
  const list = trackedIds().map(id => STATE.base[id] || company(id)).filter(Boolean).map(c => ({ sym: feedSymbol(c), path: saPath(c), mk: c.mk === "TW" ? "US" : c.mk }));
  await CLOUD.pushSymbols(list);
  const r = await CLOUD.pullTicks();
  for (const t of r.touched || []) { const c = list.find(x => x.sym === t.sym); if (!c) continue; const id = trackedIds().find(i => feedSymbol(STATE.base[i] || company(i)) === t.sym), co = id && (STATE.base[id] || company(id)); if (!co) continue;
    const day = new Date(t.ts * 1000).toLocaleDateString("en-CA", { timeZone: c.mk === "IN" ? "Asia/Kolkata" : c.mk === "KR" ? "Asia/Seoul" : "America/New_York" }); if (get("SELECT 1 AS x FROM eod WHERE sym=? AND date=?", t.sym, day)) realisedDay(co, day); }
  if (r.added) log("cloud", `Cloud catch-up (${reason}): ${r.added} prices added`);
  return r;
}
function execSelfTest() {
  const p = spawn(process.execPath, ["scripts/selftest.mjs"], { cwd: ROOT }); let o = "";
  p.stdout.on("data", d => o += d); p.on("close", () => { const fails = o.split("\n").filter(l => l.startsWith("FAIL")).map(l => l.replace(/^FAIL\s+/, "").replace(/\s+/, ": ")); setSetting("selftest.last", { at: now(), summary: o.split("\n")[0], fails });
    HEALTH.setAlert("selftest", fails.length ? `Self-test found ${fails.length} problem${fails.length > 1 ? "s" : ""}: ${fails.slice(0, 2).join(" · ")}${fails.length > 2 ? " …" : ""}` : null); if (fails.length) log("selftest", o.slice(0, 1500)); });
}
let maintRunning = false;
async function maintenance(reason) {
  if (maintRunning) return; maintRunning = true;
  try {
    await cloudCatchUp(reason).catch(e => log("cloud", "collector catch-up failed: " + e.message));
    bondsCycle(reason).catch(e => log("bonds", e.message));
    for (const id of heldIds()) if (!STATE.base[id] && !get("SELECT 1 AS x FROM catalog WHERE key=? AND status='ready'", id)) await CATALOG.ensure(id).catch(e => log("finder", e.message));
    for (const w of all("SELECT key FROM watch")) if (!get("SELECT 1 AS x FROM catalog WHERE key=? AND status='ready'", w.key)) await CATALOG.ensure(w.key).catch(e => log("finder", e.message));
    for (const id of trackedIds()) {
      const c = STATE.base[id] || company(id); if (!c) continue; const sym = feedSymbol(c);
      const have = get("SELECT COUNT(*) AS n, MAX(date) AS d FROM daily WHERE sym=?", sym);
      try { await syncDaily(c, "5Y"); } catch (e) { log("feed", e.message); }   // full window: the provider re-adjusts history after each dividend
      if (STATE.base[id] && !get("SELECT ok FROM verify WHERE cid=? AND ok=1", id)) await runVerification(id).catch(() => {});
      
    }
    // catch up on any trading day whose end-of-day step didn't run (engine was off at the close)
    for (const id of trackedIds()) { const c = STATE.base[id] || company(id); if (c && !open_(c)) await endOfDay(id, "catch-up").catch(e => log("eod", e.message)); }
    for (const id of trackedIds()) { const c = STATE.base[id] || company(id); if (c) confirmClose(c); }
    await officialCloses().catch(e => log("data", "official closes: " + e.message));
    reanchor();
    rescoreRecent();
    const nP = makeAutoPreds(), nS = scoreMatured() + scoreLadder(); makeLadder(); prune(); CATALOG.evict();
    trialGuard();
    if (HEALTH.diskOk()) { try { ARCHIVE.archiveOld(); } catch (e) { log("archive", e.message); } }
    CLOUD.sync().then(() => ARCHIVE.upload(CLOUD.cloudConfig())).catch(e => log("cloud", e.message));
    if (BACKUP.due() && HEALTH.diskOk()) BACKUP.snapshot();
    const last = getSetting("learn.last"); if (!last || Date.now() - Date.parse(last) > 20 * 3600e3 || nS > 0 || !get("SELECT 1 AS x FROM stock_models LIMIT 1")) await learn();
    const st = await LLM.status(); if (st.running) await LLM.scoreNews(id => (STATE.base[id] || {}).nm || id, 40);
    broadcast("refresh", { reason, preds: nP, scored: nS });
    setSetting("maint.last", now()); log("maint", `Maintenance (${reason}): ${nP} forecasts logged, ${nS} scored`);
    // self-test after every maintenance: any failure becomes an alert (banner + notification)
    execSelfTest();
  } finally { maintRunning = false; }
}
setTimeout(() => maintenance("startup").catch(e => log("maint", e.stack)), 1500);

// ── bond market ──────────────────────────────────────────────────────────
// live yields every 30 s while US Treasuries or Indian G-secs trade (every 15 minutes otherwise, to keep the last
// quotes on screen); official data each evening and at every maintenance/wake; analysis whenever new official data
// arrives (or at least every 12 hours), in a worker thread
function bondStocks() {
  return trackedIds().map(id => STATE.base[id] || company(id)).filter(Boolean).map(c => ({ c, mk: c.mk === "TW" ? "US" : c.mk })).filter(x => x.mk === "US" || x.mk === "IN")
    .map(({ c, mk }) => { const rows = dailySeries(feedSymbol(c)).slice(-1100), A = adjustedDaily(rows); return { id: c.id, nm: c.nm, mk, dates: rows.map(r => r.date), adj: A.out }; }).filter(s => s.dates.length > 30);
}
async function bondAnalysis(reason) {
  if (BONDS.BSTATE.analysing) return BONDS.BSTATE.analysing;
  BONDS.BSTATE.analysing = (async () => {
    const t0 = Date.now(), out = await job("bonds", BONDS.payload(bondStocks())), secs = (Date.now() - t0) / 1000;
    BONDS.storeAnalysis(out, secs); setSetting("bonds.analysis", { at: now(), reason, basis: bondBasis(), secs });
    log("bonds", `Bond analysis (${reason}) in ${secs.toFixed(1)} s: US as of ${out.US?.asOf || "—"}, India as of ${out.IN?.asOf || "—"}`); broadcast("bonds", { analysis: true });
  })().finally(() => { BONDS.BSTATE.analysing = null; });
  return BONDS.BSTATE.analysing;
}
const bondBasis = () => ["UST:10Y", "USTR:10Y", "CCIL:9Y-10Y", "ACM:TP10", "EFFR", "RBI:REPO", "MKT:IN30Y", "MKT:IN10Y"].map(s => get("SELECT MAX(date) AS d FROM bond_daily WHERE series=?", s)?.d || "").join("|") + "|" + (get("SELECT MAX(date) AS d FROM bond_nss")?.d || "");
async function bondsCycle(reason, { force = false, bars = true } = {}) {
  await BONDS.bondsDaily(reason, { bars, cloudPages: () => BONDS.storeCloudPages(CLOUD) });
  const a = getSetting("bonds.analysis"); if (force || !a || a.basis !== bondBasis() || Date.now() - Date.parse(a.at) > 12 * 3600e3) await bondAnalysis(reason);
}
setInterval(async () => {
  const on = BONDS.bondSession("US") || BONDS.bondSession("IN"), due = BONDS.BSTATE.lastFetch + (on ? 30e3 : 15 * 60e3);
  if (Date.now() < due) return;
  try { const ch = await BONDS.pollLive(); if (ch.length) broadcast("bonds", { live: BONDS.BSTATE.live }); } catch (e) { log("bonds", "live yields: " + e.message); }
}, 5000);
// evenings: the Treasury curve appears ~16:00–18:00 New York, CCIL's India curve ~19:00–21:00 IST. Check every
// 20 minutes until each is in for the day (official sources only; no bar downloads)
setInterval(() => {
  const ny = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hourCycle: "h23", weekday: "short", hour: "2-digit" }).formatToParts(new Date()), nyH = +ny.find(x => x.type === "hour").value, nyWd = ny.find(x => x.type === "weekday").value;
  const ist = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hourCycle: "h23", weekday: "short", hour: "2-digit" }).formatToParts(new Date()), inH = +ist.find(x => x.type === "hour").value, inWd = ist.find(x => x.type === "weekday").value;
  const nyToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), inToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const wantUS = !["Sat", "Sun"].includes(nyWd) && nyH >= 16 && (get("SELECT MAX(date) AS d FROM bond_daily WHERE series='UST:10Y'")?.d || "") < nyToday;
  const wantIN = !["Sat", "Sun"].includes(inWd) && inH >= 19 && (get("SELECT MAX(date) AS d FROM bond_nss")?.d || "") < inToday;
  const last = getSetting("bonds.sync"); const stale = !last || Date.now() - Date.parse(last.at) > 6 * 3600e3;
  if (wantUS || wantIN || stale) bondsCycle(stale ? "scheduled" : "evening", { bars: stale }).catch(e => log("bonds", e.message));
}, 20 * 60e3);
setInterval(() => { try { HEALTH.check(); broadcast("alerts", HEALTH.active()); } catch (e) { log("health", e.message); } }, 5 * 60e3);
// the cloud collector should run every minute while a tracked market is open
setInterval(async () => { try { if (!Object.values(markets()).some(Boolean) || !(await CLOUD.collectorAvailable())) return HEALTH.setAlert("collector", null); const st = await CLOUD.collectorStatus(), age = st?.lastRun ? (Date.now() - Date.parse(st.lastRun)) / 60e3 : Infinity;
  HEALTH.setAlert("collector", age > 10 ? `Cloud collector hasn't recorded for ${isFinite(age) ? Math.round(age) + " minutes" : "this session"} while a market is open` : st?.failed > 0 && st?.stored === 0 ? `Cloud collector requests are failing (${st.failed} failed in its last run)` : null); } catch (e) { log("health", "collector check: " + e.message); } }, 5 * 60e3);
setTimeout(() => { try { HEALTH.check(); } catch (e) { log("health", e.message); } }, 10 * 60e3);
// the 3-month trial starts on the first day the control arm exists
if (!getSetting("trial.start")) setSetting("trial.start", new Date().toISOString().slice(0, 10));
setInterval(() => maintenance("scheduled").catch(e => log("maint", e.stack)), 6 * 3600e3);

// ── fundamentals refresh (Python pipeline: screener.in + stockanalysis.com) ──
let refreshing = null;
function refreshFundamentals() {
  if (refreshing) return refreshing;
  const py = fs.existsSync(path.join(ROOT, ".venv/bin/python")) ? path.join(ROOT, ".venv/bin/python") : "python3";
  const step = args => new Promise((res, rej) => { const p = spawn(py, args, { cwd: ROOT }); let err = ""; p.stderr.on("data", d => err += d); p.on("close", code => code === 0 ? res() : rej(new Error(err.slice(-800) || "exit " + code))); });
  refreshing = (async () => { log("refresh", "Refreshing fundamentals from screener.in and stockanalysis.com"); await step(["pipeline/fetch.py", "core"]); await step(["pipeline/build_data.py"]); loadBase(); importNews(); setSetting("refresh.last", now()); log("refresh", "Fundamentals refreshed"); broadcast("refresh", { reason: "fundamentals" }); })().finally(() => { refreshing = null; });
  return refreshing;
}
// NSE publishes its official closes in the evening: look for them every 30 minutes from 17:00 IST until found
setInterval(() => { const ist = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(new Date())); if (ist >= 17) officialCloses().then(n => { const m = reanchor(); if (n || m) broadcast("refresh", { reason: "official closes" }); }).catch(e => log("data", "official closes: " + e.message)); }, 30 * 60e3);
// fundamentals refresh: once a day, only while no tracked market is trading (it downloads ~20 company pages and
// slowed live capture when it ran during the US session) and after the Indian close, so the day's filings are in
setInterval(() => { const l = getSetting("refresh.last"), anyOpen = Object.values(markets()).some(Boolean), ist = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  if ((!l || Date.now() - Date.parse(l) > 20 * 3600e3) && !anyOpen && ist >= 15) refreshFundamentals().catch(e => log("refresh", e.message)); }, 15 * 60e3);
function importNews() {
  const hash = s => [...s].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 16777619)) >>> 0, 2166136261).toString(36);
  const parseD = d => { const t = Date.parse(d); return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };
  tx(() => { for (const c of Object.values(STATE.base)) for (const n of c.news || []) run("INSERT OR IGNORE INTO news(id,cid,title,url,source,published) VALUES(?,?,?,?,?,?)", hash(n.u + n.t), c.id, n.t, n.u, n.s || "", parseD(n.d)); });
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
// browser protections on every response: no framing by other sites, no outside scripts, no sniffing, no referrers
const SEC = { "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'" };
const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...SEC }); res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const body = req => new Promise((res, rej) => { let s = ""; req.on("data", d => { s += d; if (s.length > 5e6) req.destroy(); }); req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } }); });
const COLLS = { orders: ["orders", ["id", "date", "sym", "mk", "name", "kind", "side", "qty", "price", "status", "note", "source", "created"]] };
function listColl(name) {
  if (name === "orders") return all("SELECT * FROM orders ORDER BY date DESC, id");
  if (name === "notes") return all("SELECT data FROM notes ORDER BY updated DESC").map(r => JSON.parse(r.data));
  if (name === "sims") return all("SELECT data FROM sims ORDER BY created DESC").map(r => JSON.parse(r.data));
  if (name === "watch") return all("SELECT * FROM watch");
}
function putColl(name, o) {
  const id = o.id || Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); o.id = id;
  if (name === "orders") run("INSERT INTO orders(id,date,sym,mk,name,kind,side,qty,price,status,note,source,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date, sym=excluded.sym, mk=excluded.mk, name=excluded.name, kind=excluded.kind, side=excluded.side, qty=excluded.qty, price=excluded.price, status=excluded.status, note=excluded.note", id, o.date, o.sym, ["IN", "US", "KR"].includes(o.mk) ? o.mk : "IN", o.name, o.kind, o.side, +o.qty, +o.price, o.status, o.note || "", o.source || "manual", o.created || now());
  else if (name === "notes") run("INSERT INTO notes(id,updated,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, data=excluded.data", id, o.updated || now(), JSON.stringify(o));
  else if (name === "sims") run("INSERT INTO sims(id,cid,end_date,status,created,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, status=excluded.status", id, o.cid, o.end, o.status || "pending", o.created || now(), JSON.stringify({ ...o, status: o.status || "pending" }));
  else if (name === "watch") run("INSERT OR IGNORE INTO watch(key,added) VALUES(?,?)", o.key, now());
  return id;
}
function delColl(name, id) { run(`DELETE FROM ${name === "watch" ? "watch WHERE key=?" : name + " WHERE id=?"}`, id); if (name === "sims") run("DELETE FROM preds WHERE id=?", "user|" + id); }

async function bootstrap() {
  const ids = trackedIds();
  return { asof: STATE.asof, companies: ids.map(company).filter(Boolean), claims: STATE.claims, params: Q.getParams(), defaults: Q.DEFAULT_PARAMS, paramsVersion: paramsVersion(),
    backtest: JSON.parse(fs.readFileSync(path.join(ROOT, "data", "backtest.json"), "utf8")), orders: listColl("orders"), sims: listColl("sims"), notes: listColl("notes"), watch: listColl("watch").map(w => w.key),
    hidden: getSetting("hidden", []), alerts: HEALTH.active(), calib: all("SELECT * FROM calib"), models: all("SELECT cid, spec, accepted, updated FROM stock_models"), verify: all("SELECT * FROM verify"), markets: markets(), llm: await LLM.status(), track: trackRecord(), refreshLast: getSetting("refresh.last"), maintLast: getSetting("maint.last") };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, M = req.method;
  try {
    // only this Mac's own address; blocks DNS-rebinding and cross-site requests
    if (!HOSTS.has(req.headers.host || "")) return send(res, 403, "Forbidden", "text/plain");
    const org = req.headers.origin; if (org && !HOSTS.has(org.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "cross-site request refused" });
    if (p === "/api/login-info") return send(res, 200, { digits: getSetting("auth.pin")?.digits || 4, lockedFor: Math.max(0, Math.ceil((guard.until - Date.now()) / 1000)) });
    if (p === "/api/login" && M === "POST") {
      if (Date.now() < guard.until) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil((guard.until - Date.now()) / 1000)} s.` });
      const b = await body(req);
      if (!pinOk(b.pin)) { guard.fails++; if (guard.fails >= 5) { guard.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (guard.fails - 5)); } log("auth", `Wrong PIN (attempt ${guard.fails})`); return send(res, 401, { error: guard.fails >= 5 ? `Wrong PIN. Locked for ${Math.ceil((guard.until - Date.now()) / 1000)} s.` : "Wrong PIN." }); }
      guard.fails = 0; guard.until = 0; const t = crypto.randomBytes(32).toString("hex"); sessions.set(t, { created: Date.now(), last: Date.now() });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...SEC, "set-cookie": `kuber_s=${t}; HttpOnly; SameSite=Strict; Path=/` }); return res.end(JSON.stringify({ ok: true }));
    }
    if (!PUBLIC.has(p) && !authed(req)) {
      if (p.startsWith("/api/")) return send(res, 401, { error: "locked" });
      res.writeHead(302, { location: "/login", "cache-control": "no-store", ...SEC }); return res.end();
    }
    if (p === "/login") return send(res, 200, fs.readFileSync(path.join(ROOT, "web", "login.html")), MIME[".html"]);
    if (p === "/api/logout" && M === "POST") { sessions.delete(cookieOf(req).kuber_s); res.writeHead(200, { "content-type": "application/json", "set-cookie": "kuber_s=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict" }); return res.end("{}"); }
    if (p === "/api/reveal" && M === "POST") {
      if (Date.now() < guard.until) return send(res, 429, { error: `Too many attempts. Try again in ${Math.ceil((guard.until - Date.now()) / 1000)} s.` });
      const b = await body(req);
      if (!pinOk(b.pin)) { guard.fails++; if (guard.fails >= 5) guard.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (guard.fails - 5)); log("auth", `Wrong PIN to show portfolio (attempt ${guard.fails})`); return send(res, 401, { error: guard.fails >= 5 ? `Wrong PIN. Locked for ${Math.ceil((guard.until - Date.now()) / 1000)} s.` : "Wrong PIN." }); }
      guard.fails = 0; guard.until = 0; return send(res, 200, { ok: true });
    }
    if (p === "/api/pin" && M === "POST") {
      const b = await body(req); if (!pinOk(b.current)) return send(res, 400, { error: "Current PIN is wrong." });
      if (!/^\d{4,8}$/.test(String(b.next || ""))) return send(res, 400, { error: "New PIN must be 4 to 8 digits." });
      setPin(b.next); log("auth", "PIN changed"); return send(res, 200, { ok: true });
    }
    if (p === "/api/stream") {
      const id = u.searchParams.get("client") || Math.random().toString(36).slice(2);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" }); res.write("retry: 3000\n\n");
      clients.set(id, { res, focus: new Set((u.searchParams.get("focus") || "").split(",").filter(Boolean)) });
      res.write(`event: hello\ndata: ${JSON.stringify({ markets: markets() })}\n\n`);
      const hb = setInterval(() => res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now(), markets: markets() })}\n\n`), 20000);
      req.on("close", () => { clearInterval(hb); clients.delete(id); }); return;
    }
    if (p === "/api/focus" && M === "POST") { const b = await body(req), c = clients.get(b.client); if (c) c.focus = new Set(b.ids || []); for (const id of b.ids || []) poll(id); return send(res, 200, { ok: true }); }
    if (p === "/api/bootstrap") return send(res, 200, await bootstrap());
    if (p.startsWith("/api/company/")) {
      const id = decodeURIComponent(p.slice(13)), c = company(id); if (!c) return send(res, 404, { error: "not found" });
      const sym = feedSymbol(c);
      return send(res, 200, { company: c, ticks: ticksToday(sym), analyses: all("SELECT * FROM analyses WHERE cid=? AND ts>=? ORDER BY ts", id, new Date(Date.now() - 4 * 864e5).toISOString()), calib: get("SELECT * FROM calib WHERE cid=?", id) || null, model: get("SELECT * FROM stock_models WHERE cid=?", id) || null,
        learnLog: all("SELECT * FROM learn_log WHERE cid=? ORDER BY id DESC LIMIT 30", id), news: all("SELECT * FROM news WHERE cid=? ORDER BY published DESC", id), preds: all("SELECT * FROM preds WHERE cid=? ORDER BY made DESC LIMIT 60", id), verify: get("SELECT * FROM verify WHERE cid=?", id) || null, markets: markets() });
    }
    if (p.startsWith("/api/analyse/") && M === "POST") { const id = decodeURIComponent(p.slice(13)), b = await body(req); return send(res, 200, analyseLive(id, { H: b.H || 52, trigger: "manual" })); }
    const cm = p.match(/^\/api\/(orders|notes|sims|watch)(?:\/(.+))?$/);
    if (cm) {
      const [, name, id] = cm;
      if (M === "GET") return send(res, 200, listColl(name));
      if (M === "POST" || M === "PUT") { const b = await body(req); if (name === "watch" && b.key) { try { await CATALOG.ensure(b.key, b.name); } catch (e) { return send(res, 400, { error: `Couldn't get data for ${b.key}: ${e.message}` }); } }
        // an order for a stock KUBER doesn't have: check the symbol exists on its exchange and download it first
        let fresh = null;
        if (name === "orders" && b.sym) { b.sym = String(b.sym).trim().toUpperCase(); b.mk = ["IN", "US", "KR"].includes(b.mk) ? b.mk : "IN"; const EX = { IN: "NSE", US: "NYSE/Nasdaq", KR: "KRX" }[b.mk];
          if (!/^[A-Z0-9][A-Z0-9.&_-]{0,19}$/.test(b.sym)) return send(res, 400, { error: `That isn't a valid ${EX} symbol.` });
          const cid = orderCid(b.mk, b.sym);
          if (STATE.base[cid] && (!b.name || b.name === b.sym)) b.name = STATE.base[cid].nm;
          if (!STATE.base[cid]) { try { const st = await CATALOG.ensure(cid, b.name); if (!b.name || b.name === b.sym) b.name = st?.name || b.sym; if (!get("SELECT 1 AS x FROM eod WHERE sym=?", feedSymbol({ id: cid, mk: b.mk, tk: b.sym }))) fresh = cid; } catch (e) { return send(res, 400, { error: `Couldn't find ${EX} symbol ${b.sym}: ${e.message}. Check the symbol and the market.` }); } } }
        const nid = putColl(name, b); if (name === "sims") scoreMatured();
        if (fresh) endOfDay(fresh, "catch-up").catch(e => log("eod", e.message)); broadcast("data", { coll: name }); return send(res, 200, { id: nid }); }
      if (M === "DELETE") { delColl(name, decodeURIComponent(id)); broadcast("data", { coll: name }); return send(res, 200, { ok: true }); }
    }
    if (p === "/api/params" && M === "GET") return send(res, 200, { params: Q.getParams(), defaults: Q.DEFAULT_PARAMS, version: paramsVersion(), history: all("SELECT id, ts, note, active, metrics FROM params_history ORDER BY id DESC LIMIT 30") });
    if (p === "/api/params/validate" && M === "POST") { const b = await body(req); return send(res, 200, await validate(b.params)); }
    if (p === "/api/params/activate" && M === "POST") { const b = await body(req); const full = activateParams(b.params, b.note, b.metrics); broadcast("params", { params: full, version: paramsVersion() }); return send(res, 200, { params: full }); }
    if (p.startsWith("/api/params/revert/") && M === "POST") { const r = get("SELECT * FROM params_history WHERE id=?", +p.split("/").pop()); if (!r) return send(res, 404, {}); const full = activateParams(JSON.parse(r.params), `Reverted to version ${r.id}`, JSON.parse(r.metrics || "null")); broadcast("params", { params: full, version: paramsVersion() }); return send(res, 200, { params: full }); }
    if (p === "/api/learn" && M === "GET") return send(res, 200, { calib: all("SELECT * FROM calib"), models: all("SELECT * FROM stock_models"), ladder: all("SELECT cid, kappa, weights, metrics, updated FROM ladder_calib"), ladderScored: all("SELECT cid, COUNT(*) AS n, AVG(in90) AS in90 FROM ladder WHERE scored IS NOT NULL GROUP BY cid"), modelLog: all("SELECT * FROM stock_model_log ORDER BY id DESC LIMIT 200"), log: all("SELECT * FROM learn_log ORDER BY id DESC LIMIT 200"), last: getSetting("learn.last"), track: trackRecord() });
    if (p === "/api/learn/run" && M === "POST") { const t = Date.now(), r = await learn(); broadcast("learn", { at: now() }); return send(res, 200, { companies: r.length, models: r.filter(x => x.model?.accepted).length, accepted: r.filter(x => x.accepted).length, secs: (Date.now() - t) / 1000 }); }
    if (p === "/api/maintenance" && M === "POST") { maintenance("manual").catch(e => log("maint", e.message)); return send(res, 200, { started: true }); }
    if (p === "/api/refresh" && M === "POST") { refreshFundamentals().catch(e => log("refresh", e.message)); return send(res, 200, { started: true }); }
    if (p === "/api/backtest" && M === "POST") { const b = await body(req); const ids = Object.keys(STATE.base); const list = ids.map(id => company(id)).map(c => c.live ? { ...c, wd: c.wd.slice(0, -1), wk: c.wk.slice(0, -1) } : c); Q.setParams(Q.getParams()); return send(res, 200, await job("backtest", { companies: list, params: Q.getParams(), paths: b.paths || 800, step: b.step || 8 })); }
    if (p === "/api/llm/status") return send(res, 200, await LLM.status());
    if (p === "/api/llm/score-news" && M === "POST") return send(res, 200, await LLM.scoreNews(id => (STATE.base[id] || {}).nm || id, 60));
    if (p === "/api/llm/ask" && M === "POST") {
      const b = await body(req), c = company(b.cid); if (!c) return send(res, 404, {});
      const A = analyseLive(c.id, { trigger: "ask" }), cl = STATE.claims?.V?.[c.id];
      const sm = get("SELECT spec, accepted, metrics FROM stock_models WHERE cid=?", c.id), ctx = { company: c.nm, ticker: c.tk, price: c.px, stockModel: sm ? { inUse: sm.accepted ? JSON.parse(sm.metrics).describe : "standard model", why: JSON.parse(sm.metrics).note } : null, priceSource: c.priceSource, priceAsOf: c.priceAsof || c.pxDate, fundamentalsAsOf: c.fundAsof, marketCap: c.mcap, pe: c.pe, pb: c.pb, roe: c.roe, debtToEquity: c.de, dividendYield: c.dy, financials: c.fin, verifiedFacts: cl ? { description: cl.desc[0], facts: cl.facts, segments: cl.seg.map(x => x[0]), relationships: cl.net, timeline: cl.hist } : { description: c.about }, news: all("SELECT published, title, label FROM news WHERE cid=? ORDER BY published DESC LIMIT 10", c.id), modelForecast52w: A && { median: A.median, range90: [A.p05, A.p95], probGain: A.pUp, note: "ranges calibrated in backtests; direction calls ~50% (no skill)" } };
      try { return send(res, 200, await LLM.ask(ctx, String(b.q || "").slice(0, 1000))); } catch (e) { return send(res, 503, { error: e.message }); }
    }
    if (p === "/api/live") {
      const syms = trackedIds().map(id => { const c = STATE.base[id] || company(id); return c && { id, nm: c.nm, mk: c.mk, sym: feedSymbol(c) }; }).filter(Boolean);
      const since = Math.floor(Date.now() / 1000) - 86400;
      return send(res, 200, { retentionYears: getSetting("retention.years", 4), awake: { on: getSetting("awake", true), active: !!awake }, dbBytes: fs.statSync(path.join(ROOT, "data", "kuber.db")).size + (fs.existsSync(path.join(ROOT, "data", "kuber.db-wal")) ? fs.statSync(path.join(ROOT, "data", "kuber.db-wal")).size : 0),
        totals: { ticks: get("SELECT COUNT(*) AS n FROM ticks").n, daily: get("SELECT COUNT(*) AS n FROM daily").n, analyses: get("SELECT COUNT(*) AS n FROM analyses").n, preds: get("SELECT COUNT(*) AS n FROM preds").n, rvDays: get("SELECT COUNT(*) AS n FROM rv").n, firstTick: get("SELECT MIN(ts) AS t FROM ticks").t },
        stocks: syms.map(x => ({ ...x, ticks24h: get("SELECT COUNT(*) AS n FROM ticks WHERE sym=? AND ts>=?", x.sym, since).n, lastTick: get("SELECT MAX(ts) AS t FROM ticks WHERE sym=?", x.sym).t, days: get("SELECT COUNT(*) AS n FROM rv WHERE sym=? AND n_ticks>0", x.sym).n, dq: get("SELECT SUM(accepted) AS a, SUM(rejected) AS r FROM dq WHERE sym=?", x.sym), lastRv: get("SELECT * FROM rv WHERE sym=? ORDER BY date DESC LIMIT 1", x.sym) || null, open: markets()[x.mk === "TW" ? "US" : x.mk] })),
        cloud: CLOUD.status(), archive: ARCHIVE.summary() });
    }
    if (p === "/api/wishlist" && M === "POST") {
      const b = await body(req), id = b.id, hidden = new Set(getSetting("hidden", []));
      if (STATE.base[id]) { if (b.on) hidden.delete(id); else { if (heldIds().has(id)) return send(res, 400, { error: "You hold this stock, so it stays tracked." }); hidden.add(id); } setSetting("hidden", [...hidden]); }
      else if (b.on) { try { await CATALOG.ensure(id, b.name); } catch (e) { return send(res, 400, { error: e.message }); } run("INSERT OR IGNORE INTO watch(key,added) VALUES(?,?)", id, now()); }
      else run("DELETE FROM watch WHERE key=?", id);
      log("wishlist", `${b.on ? "Added" : "Removed"} ${id}`); broadcast("data", { coll: "watch" });
      // a newly tracked stock gets its end-of-day step, forecasts and 90-day outlook straight away (not at the next maintenance)
      if (b.on) endOfDay(id, "catch-up").then(() => broadcast("refresh", { reason: "wishlist" })).catch(e => log("eod", `${id}: ${e.message}`));
      return send(res, 200, { ok: true, tracked: trackedIds() });
    }
    if (p === "/api/livegrid") {
      const mk = markets(), SESS_MIN = { IN: 375, US: 390, TW: 390, KR: 390 };
      return send(res, 200, trackedIds().map(id => { const c = company(id); if (!c) return null; const sym = feedSymbol(c), all30 = ticksToday(sym);
        // the latest session only: walk back from the newest sample until a gap of 3+ hours
        let k = all30.length - 1; while (k > 0 && all30[k].ts - all30[k - 1].ts < 3 * 3600) k--; const t = all30.slice(Math.max(0, k)), step = Math.max(1, Math.ceil(t.length / 240));
        // intraday statistics from every recorded sample
        const S = {}; if (t.length >= 2) {
          const px = t.map(x => x.price); S.open = px[0]; S.hi = Math.max(...px); S.lo = Math.min(...px); S.last = px[px.length - 1]; S.minutes = Math.round((t[t.length - 1].ts - t[0].ts) / 60);
          const b = new Map(); for (const x of t) b.set(Math.floor((x.ts - t[0].ts) / 300), x.price); const ks = [...b.keys()].sort((a, z) => a - z); let rv = 0, n5 = 0;
          for (let i = 1; i < ks.length; i++) if (ks[i] === ks[i - 1] + 1) { rv += Math.log(b.get(ks[i]) / b.get(ks[i - 1])) ** 2; n5++; }
          const full = SESS_MIN[c.mk] || 375; if (n5 >= 6 && S.minutes >= 30) S.rvAnn = Math.sqrt(rv * Math.max(1, full / S.minutes) * 252);
          S.n5 = n5;
          // trend over the last hour, tested on RETURNS (not price levels, whose errors are autocorrelated):
          // t = the hour's log return ÷ (sd of sample-to-sample returns × √n); a random walk gives |t| < 2 about 95% of the time
          const h = t.filter(x => x.ts >= t[t.length - 1].ts - 3600); if (h.length >= 10) { const r = []; for (let i = 1; i < h.length; i++) r.push(Math.log(h[i].price / h[i - 1].price)); const tot = r.reduce((a, x) => a + x, 0), sd = Q.sd(r), hrs = (h[h.length - 1].ts - h[0].ts) / 3600 || 1; S.trendPctHr = (Math.exp(tot / hrs) - 1) * 100; S.trendT = sd > 0 ? tot / (sd * Math.sqrt(r.length)) : null; S.trendN = h.length; }
        }
        const lr = get("SELECT made, p0, mu, vol FROM ladder_runs WHERE cid=? ORDER BY made DESC LIMIT 1", id);
        const lad = lr ? all("SELECT h, p05, p25, p50, p75, p95, pUp FROM ladder WHERE cid=? AND made=? AND h IN (1, 2, 3, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90) ORDER BY h", id, lr.made) : [];
        // previous close: from the live quote, or else the stored close of the trading day before this session
        const sessDate = t.length ? new Date(t[t.length - 1].ts * 1000).toLocaleDateString("en-CA", { timeZone: c.mk === "IN" ? "Asia/Kolkata" : c.mk === "KR" ? "Asia/Seoul" : "America/New_York" }) : null;
        const prev = STATE.live[sym]?.prev ?? (sessDate ? get("SELECT close FROM daily WHERE sym=? AND date < ? ORDER BY date DESC LIMIT 1", sym, sessDate)?.close ?? null : null), dVol = lr?.vol ? lr.vol / Math.sqrt(252) : null;
        if (prev && S.last && dVol) S.moveZ = Math.log(S.last / prev) / dVol;   // today's move in units of the model's daily volatility
        const daily = all("SELECT date, close FROM daily WHERE sym=? ORDER BY date DESC LIMIT 61", sym).reverse();
        return { id, nm: c.nm, tk: c.tk, mk: c.mk, cur: c.cur, px: c.px, chg: c.chg, prev, open: !!mk[c.mk === "TW" ? "US" : c.mk], nTicks: t.length, ticks: t.filter((_, i) => i % step === 0 || i === t.length - 1), stats: S,
          analysis: get("SELECT ts, px, median, p05, p25, p75, p95, pUp, vol, mu FROM analyses WHERE cid=? AND H=52 ORDER BY id DESC LIMIT 1", id) || null,
          ladderRun: lr || null, ladderRows: lad, ladder: Object.fromEntries(lad.filter(r => r.h === 20 || r.h === 60).map(r => [r.h, r])), daily };
      }).filter(Boolean));
    }
    if (p === "/api/find") return send(res, 200, await CATALOG.search(u.searchParams.get("q")));
    if (p.startsWith("/api/catalog/")) {
      const key = decodeURIComponent(p.slice(13));
      if (M === "POST") { const b = await body(req); CATALOG.ensure(key, b.name).catch(() => {}); await new Promise(r => setTimeout(r, 300)); }
      return send(res, 200, CATALOG.status(key) || { key, status: "none" });
    }
    if (p.startsWith("/api/ladder/")) return send(res, 200, ladderView(decodeURIComponent(p.slice(12))));
    if (p.startsWith("/api/rv/")) { const c = company(decodeURIComponent(p.slice(8))); if (!c) return send(res, 404, {}); return send(res, 200, all("SELECT * FROM rv WHERE sym=? ORDER BY date DESC LIMIT 60", feedSymbol(c))); }
    if (p === "/api/backup" && M === "GET") return send(res, 200, BACKUP.status());
    if (p === "/api/backup" && M === "POST") return send(res, 200, BACKUP.snapshot());
    if (p === "/api/backup/dir" && M === "POST") { const b = await body(req); try { return send(res, 200, { dir: BACKUP.setDir(b.dir) }); } catch (e) { return send(res, 400, { error: `Can't write to that folder: ${e.message}` }); } }
    if (p === "/api/awake" && M === "POST") { const b = await body(req); setSetting("awake", !!b.on); keepAwake(); return send(res, 200, { on: !!b.on }); }
    if (p === "/api/retention" && M === "POST") { const b = await body(req), y = Math.max(1, Math.min(20, Math.round(+b.years || 4))); setSetting("retention.years", y); log("retention", `Keeping intraday data for ${y} years`); return send(res, 200, { years: y }); }
    if (p === "/api/cloud" && M === "POST") { const b = await body(req); return send(res, 200, await CLOUD.configure(b)); }
    if (p === "/api/cloud/collector") return send(res, 200, await CLOUD.collectorStatus());
    // system simulations: every automatic forecast KUBER logged (1/4/13 weeks, all stocks) and each stock's 90-day outlook record
    if (p === "/api/autosims" && M === "GET") {
      const rows = all("SELECT id, cid, made, H, target, p0, median, p05, p25, p75, p95, pUp, actual, actual_date, scored, in50, in90, dirHit, err FROM preds WHERE kind='auto' ORDER BY made DESC, cid, H LIMIT 20000");
      // names and currencies for every stock in the record, including ones no longer tracked (e.g. removed from the list)
      const ids = [...new Set([...rows.map(r => r.cid), ...trackedIds()])], info = id => STATE.base[id] || (id.includes(":") ? company(id, { live: false }) : null);
      const names = Object.fromEntries(ids.map(id => [id, info(id)?.nm || id])), cur = Object.fromEntries(ids.map(id => [id, info(id)?.cur || (id.startsWith("IN:") ? "₹" : id.startsWith("KR:") || /^\d{6}$/.test(id) ? "₩" : "$")]));
      const ladder = all("SELECT cid, COUNT(DISTINCT made) runs, COUNT(*) days, SUM(scored IS NOT NULL) scored, AVG(CASE WHEN scored IS NOT NULL THEN in90 END) in90, AVG(CASE WHEN scored IS NOT NULL THEN in50 END) in50, MIN(made) first, MAX(made) last FROM ladder GROUP BY cid");
      return send(res, 200, { rows, names, cur, ladder });
    }
    if (p === "/api/bonds" && M === "GET") {
      const checks = all("SELECT name, ok, detail, ts FROM bond_checks WHERE id IN (SELECT MAX(id) FROM bond_checks GROUP BY name) ORDER BY name");
      return send(res, 200, { live: BONDS.BSTATE.live, session: { US: BONDS.bondSession("US"), IN: BONDS.bondSession("IN") }, lastFetch: BONDS.BSTATE.lastFetch, lastOk: BONDS.BSTATE.lastOk, lastError: BONDS.BSTATE.lastError, analysing: !!BONDS.BSTATE.analysing, analysis: BONDS.analysisOut(), checks, sync: getSetting("bonds.sync"), meta: getSetting("bonds.analysis") });
    }
    if (p === "/api/bonds/intraday" && M === "GET") { const s = u.searchParams.get("s") || "US10Y"; if (!BONDS.LIVE[s]) return send(res, 400, { error: "unknown series" }); return send(res, 200, BONDS.intraday(s, Math.min(240, +u.searchParams.get("h") || 30))); }
    if (p === "/api/bonds/history" && M === "GET") { const s = u.searchParams.get("s") || "UST:10Y"; if (!/^[A-Z0-9_]+(:[A-Z0-9 -]+)?$/.test(s)) return send(res, 400, { error: "bad series" }); return send(res, 200, BONDS.history(s, u.searchParams.get("from"))); }
    if (p === "/api/bonds/refresh" && M === "POST") { bondsCycle("manual", { force: true, bars: true }).catch(e => log("bonds", e.message)); return send(res, 200, { ok: true }); }
    if (p === "/api/cloud/probe" && M === "POST") { try { return send(res, 200, await CLOUD.probe()); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (p === "/api/cloud/sync" && M === "POST") { return send(res, 200, await CLOUD.sync(true)); }
    if (p === "/api/events") return send(res, 200, all("SELECT * FROM events ORDER BY id DESC LIMIT 200"));
    if (p === "/api/llm/model" && M === "POST") { const b = await body(req); setSetting("llm.model", b.model); return send(res, 200, { ok: true }); }
    // static
    let f = p === "/" ? "/index.html" : p;
    // the page always loads the newest scripts and styles (version stamp = file modification time)
    if (f === "/index.html") { const v = n => Math.round(fs.statSync(path.join(ROOT, "web", n)).mtimeMs); return send(res, 200, fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8").replace('src="/app.js"', `src="/app.js?v=${v("app.js")}"`).replace('src="/model.js"', `src="/model.js?v=${v("model.js")}"`).replace('href="/style.css"', `href="/style.css?v=${v("style.css")}"`), MIME[".html"]); }
    if (f === "/universe.json") return send(res, 200, fs.readFileSync(path.join(ROOT, "data", "universe_slim.json")), MIME[".json"]);
    const base = f.startsWith("/assets/") ? path.join(ROOT, "assets") : path.join(ROOT, "web"), fp = path.normalize(path.join(base, f.replace(/^\/assets\//, "/")));
    if (!fp.startsWith(base + path.sep) || /\.(db|sqlite|log|plist|env)$/i.test(fp) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return send(res, 404, "Not found", "text/plain");
    return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || "application/octet-stream");
  } catch (e) { log("http", `${M} ${p}: ${e.stack}`); return send(res, 500, { error: e.message }); }
});
server.listen(PORT, "127.0.0.1", () => { console.log(`KUBER running at http://127.0.0.1:${PORT}`); log("start", `Server started on port ${PORT}`); });
