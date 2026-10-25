// Bond market: US Treasuries and Indian government securities.
//
// Official end-of-day data (the record; replaces anything else for the same day)
//   US   Treasury daily par yield curve, 1 month – 30 years, since 1990     home.treasury.gov
//   US   Treasury daily real (TIPS) yield curve, 5 – 30 years, since 2003   home.treasury.gov
//   US   Federal Reserve H.15, same yields from a second official source     federalreserve.gov (cross-check only)
//   US   Effective fed funds rate, SOFR, the Fed's target range               markets.newyorkfed.org
//   US   ACM term premium (daily) and the yield-curve recession model         newyorkfed.org (Excel files)
//   IN   CCIL zero-coupon yield curve parameters (Nelson–Siegel–Svensson)     ccilindia.com (each evening)
//   IN   CCIL tenor-wise yields of the benchmark G-secs, T-bills and SDLs    ccilindia.com
//   IN   RBI policy repo, standing deposit and marginal standing facility    rbi.org.in
// Live and intraday (market data, used between official prints)
//   CNBC quotes (Tradeweb for Treasuries): US 1M–30Y every 30 s, India 10Y and 30Y; minute bars for the last 2 days
//   and 15-minute bars for the last 10 days fill any gap (sleep, shutdown) when the engine catches up.
// Cross-checks run after every sync and are stored in bond_checks; failures raise an alert and fail the self-test.
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { ROOT, all, get, run, tx, log, now, getSetting, setSetting } from "./db.mjs";
import { isolatedSpikes, withoutSpikes } from "./bondmath.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// one request at a time per host, 0.5 s apart (these are official sites; be polite)
const hostNext = {};
async function fetchText(url, { timeout = 60, accept = "*/*", file = null } = {}) {
  const host = new URL(url).host, w = Math.max(0, (hostNext[host] || 0) - Date.now()); hostNext[host] = Math.max(Date.now(), hostNext[host] || 0) + 500; if (w) await sleep(w);
  const args = ["-s", "-L", "-m", String(timeout), "-A", UA, "-H", `Accept: ${accept}`, "-w", "\n%{http_code}"]; if (file) args.push("-o", file); args.push(url);
  return new Promise((res, rej) => execFile("curl", args, { maxBuffer: 80e6 }, (err, out) => { if (err) return rej(new Error(`${host}: ${err.message.split("\n")[0]}`)); const i = out.lastIndexOf("\n"), status = +out.slice(i + 1); if (status !== 200) return rej(new Error(`${host} HTTP ${status}`)); res(file ? "" : out.slice(0, i)); }));
}
// one retry after a short pause for a server error or a dropped connection (seen: HTTP 503 from the bar history)
const fetchRetry = async (url, o) => { try { return await fetchText(url, o); } catch (e) { if (!/HTTP 5\d\d|curl|timed out|Couldn't/i.test(e.message)) throw e; await sleep(3000); return fetchText(url, o); } };
const fetchJSON = async (url, o) => JSON.parse(await fetchRetry(url, { ...o, accept: "application/json" }));
const upsertDaily = (series, date, y, src) => run("INSERT INTO bond_daily(series,date,y,src) VALUES(?,?,?,?) ON CONFLICT(series,date) DO UPDATE SET y=excluded.y, src=excluded.src", series, date, y, src);
const lastDate = series => get("SELECT MAX(date) AS d FROM bond_daily WHERE series=?", series)?.d || null;
const istDate = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
function parts(tz, t = Date.now()) { const o = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)).map(x => [x.type, x.value])); return { wd: o.weekday, m: +o.hour * 60 + +o.minute }; }

// ── sessions ─────────────────────────────────────────────────────────────
// US Treasuries trade almost round the clock: Sunday 18:00 – Friday 17:00 New York, with a break 17:00–18:00 each day.
// Indian G-secs trade on RBI's NDS-OM 09:00–17:00 IST, Monday to Friday. "Core" hours are when silence is a problem.
export function bondSession(mk, t = Date.now()) {
  if (mk === "IN") { const p = parts("Asia/Kolkata", t); return !["Sat", "Sun"].includes(p.wd) && p.m >= 540 && p.m < 1020; }
  const p = parts("America/New_York", t); if (p.wd === "Sat") return false; if (p.wd === "Sun") return p.m >= 1080; if (p.wd === "Fri") return p.m < 1020; return !(p.m >= 1020 && p.m < 1080);
}
export function bondCore(mk, t = Date.now()) { if (mk === "IN") return bondSession("IN", t); const p = parts("America/New_York", t); return !["Sat", "Sun"].includes(p.wd) && p.m >= 480 && p.m < 1020; }

// ── series ───────────────────────────────────────────────────────────────
export const UST_TENORS = [["1M", 1 / 12], ["2M", 2 / 12], ["3M", 0.25], ["4M", 1 / 3], ["6M", 0.5], ["1Y", 1], ["2Y", 2], ["3Y", 3], ["5Y", 5], ["7Y", 7], ["10Y", 10], ["20Y", 20], ["30Y", 30]];
export const LIVE = { US1M: "US", US3M: "US", US6M: "US", US1Y: "US", US2Y: "US", US3Y: "US", US5Y: "US", US7Y: "US", US10Y: "US", US20Y: "US", US30Y: "US", IN10Y: "IN", IN30Y: "IN" };
export const BSTATE = { live: {}, lastFetch: 0, lastOk: 0, lastError: null, analysing: null };

// ── US Treasury par and real curves ──────────────────────────────────────
const UST_COL = { "1 Mo": "1M", "2 Mo": "2M", "3 Mo": "3M", "4 Mo": "4M", "6 Mo": "6M", "1 Yr": "1Y", "2 Yr": "2Y", "3 Yr": "3Y", "5 Yr": "5Y", "7 Yr": "7Y", "10 Yr": "10Y", "20 Yr": "20Y", "30 Yr": "30Y", "5 YR": "5Y", "7 YR": "7Y", "10 YR": "10Y", "20 YR": "20Y", "30 YR": "30Y" };
const usDate = s => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim()); return m ? `${m[3]}-${m[1]}-${m[2]}` : null; };
export function parseUST(csv, prefix) {
  const L = csv.trim().split(/\r?\n/), head = L[0].split(",").map(h => h.replace(/"/g, "").trim()), out = [];
  for (const line of L.slice(1)) { const c = line.split(","), d = usDate(c[0] || ""); if (!d) continue; head.forEach((h, i) => { const t = UST_COL[h], v = c[i] === undefined || c[i] === "" ? NaN : +c[i]; if (t && Number.isFinite(v) && v > -5 && v < 30) out.push([prefix + t, d, v]); }); }
  return out;
}
async function ustYear(yr, real) {
  const type = real ? "daily_treasury_real_yield_curve" : "daily_treasury_yield_curve";
  return parseUST(await fetchRetry(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=${type}&field_tdr_date_value=${yr}&page&_format=csv`, { timeout: 90 }), real ? "USTR:" : "UST:");
}
async function syncUST() {
  const yNow = new Date().getUTCFullYear(), full = !getSetting("bonds.ust.backfilled", false); let n = 0;
  const years = full ? Array.from({ length: yNow - 1989 }, (_, i) => 1990 + i) : (new Date().getUTCMonth() === 0 ? [yNow - 1, yNow] : [yNow]);
  for (const yr of years) for (const real of [false, true]) {
    if (real && yr < 2003) continue;
    const rows = await ustYear(yr, real); tx(() => { for (const [s, d, v] of rows) upsertDaily(s, d, v, "US Treasury"); }); n += rows.length;
  }
  if (full) { setSetting("bonds.ust.backfilled", true); log("bonds", `Loaded the official Treasury yield curves since 1990 (${n.toLocaleString()} values)`); }
  return n;
}
// Federal Reserve H.15: the same constant-maturity yields from a second official publisher (last 60 business days)
const H15 = { RIFLGFCM01: "1M", RIFLGFCM03: "3M", RIFLGFCM06: "6M", RIFLGFCY01: "1Y", RIFLGFCY02: "2Y", RIFLGFCY03: "3Y", RIFLGFCY05: "5Y", RIFLGFCY07: "7Y", RIFLGFCY10: "10Y", RIFLGFCY20: "20Y", RIFLGFCY30: "30Y" };
async function syncH15() {
  const csv = await fetchRetry("https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series=bf17364827e38702b42a58cf8eaa3f78&lastobs=60&from=&to=&filetype=csv&label=include&layout=seriescolumn", { timeout: 60 });
  const L = csv.trim().split(/\r?\n/), hi = L.findIndex(l => l.startsWith('"Time Period"')); if (hi < 0) throw new Error("H.15 file format changed");
  const head = L[hi].split(",").map(h => h.replace(/"/g, "").replace(/_N\.B$/, "")); let n = 0;
  tx(() => { for (const line of L.slice(hi + 1)) { const c = line.split(","), d = c[0]; if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; head.forEach((h, i) => { const t = H15[h]; if (t && c[i] !== "ND" && Number.isFinite(+c[i]) && c[i] !== "") { upsertDaily("H15:" + t, d, +c[i], "Federal Reserve H.15"); n++; } }); } });
  return n;
}
// New York Fed: effective fed funds rate (with the FOMC target range) and SOFR
async function syncNYFedRates() {
  const first = !lastDate("EFFR"), end = new Date().toISOString().slice(0, 10), q = first ? `search.json?startDate=2016-03-01&endDate=${end}` : "last/60.json";
  const e = await fetchJSON(`https://markets.newyorkfed.org/api/rates/unsecured/effr/${q}`), s = await fetchJSON(`https://markets.newyorkfed.org/api/rates/secured/sofr/${q}`); let n = 0;
  tx(() => {
    for (const r of e.refRates || []) { if (!r.effectiveDate || !Number.isFinite(r.percentRate)) continue; upsertDaily("EFFR", r.effectiveDate, r.percentRate, "New York Fed"); if (Number.isFinite(r.targetRateFrom)) upsertDaily("FF_LO", r.effectiveDate, r.targetRateFrom, "New York Fed"); if (Number.isFinite(r.targetRateTo)) upsertDaily("FF_HI", r.effectiveDate, r.targetRateTo, "New York Fed"); n++; }
    for (const r of s.refRates || []) { if (r.effectiveDate && Number.isFinite(r.percentRate)) { upsertDaily("SOFR", r.effectiveDate, r.percentRate, "New York Fed"); n++; } }
  });
  return n;
}
// New York Fed Excel files (term premium daily; recession model monthly): once a day
async function syncNYFedFiles(force) {
  const last = getSetting("bonds.nyfed.last"); if (!force && last && Date.now() - Date.parse(last) < 20 * 3600e3) return 0;
  const dir = path.join(ROOT, "data", "cache"); fs.mkdirSync(dir, { recursive: true });
  const acm = path.join(dir, "ACMTermPremium.xls"), rec = path.join(dir, "nyfed_recession.xls");
  await fetchText("https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls", { file: acm, timeout: 180 });
  await fetchText("https://www.newyorkfed.org/medialibrary/media/research/capital_markets/allmonth.xls", { file: rec, timeout: 120 });
  const py = fs.existsSync(path.join(ROOT, ".venv/bin/python")) ? path.join(ROOT, ".venv/bin/python") : "python3";
  const j = await new Promise((res, rej) => { const p = spawn(py, ["-I", "pipeline/nyfed.py", acm, rec], { cwd: ROOT }); let o = "", e = ""; p.stdout.on("data", d => o += d); p.stderr.on("data", d => e += d); p.on("close", c => { try { c === 0 ? res(JSON.parse(o)) : rej(new Error(e.slice(-400))); } catch (x) { rej(x); } }); });
  if (!(j.acm?.length > 10000) || !(j.rec?.length > 700)) throw new Error("New York Fed files look incomplete");
  tx(() => {
    for (const [d, y10, tp10, rny10, tp2, tp5] of j.acm) { if (tp10 == null) continue; upsertDaily("ACM:Y10", d, y10, "NY Fed ACM"); upsertDaily("ACM:TP10", d, tp10, "NY Fed ACM"); upsertDaily("ACM:RNY10", d, rny10, "NY Fed ACM"); upsertDaily("ACM:TP2", d, tp2, "NY Fed ACM"); upsertDaily("ACM:TP5", d, tp5, "NY Fed ACM"); }
    for (const [d, spread, prob, nber] of j.rec) { if (spread != null) upsertDaily("REC:SPREAD", d, spread, "NY Fed"); if (prob != null) upsertDaily("REC:PROB", d, prob, "NY Fed"); if (nber != null) upsertDaily("REC:NBER", d, nber, "NBER via NY Fed"); }
  });
  setSetting("bonds.nyfed.last", now()); return j.acm.length + j.rec.length;
}

// ── India: CCIL zero curve and tenor-wise yields; RBI policy rates ───────
const strip = html => html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
export function parseCCIL(html) {
  const t = strip(html), nss = [], sec = [];
  for (const m of t.matchAll(/(\d{4}-\d{2}-\d{2}) 00:00:00\.0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)(?= |$)/g)) {
    const [, d, ...v] = m, [b0, b1, b2, b3, t1, t2] = v.map(Number);
    if (b0 > 0 && b0 < 25 && t1 > 0 && t2 > 0 && v.every(x => Number.isFinite(+x))) nss.push({ date: d, b0, b1, b2, b3, t1, t2 });
  }
  for (const m of t.matchAll(/(\d{4}-\d{2}-\d{2}) 00:00:00\.0 (\d+D|\d+Y(?:-\d+Y)?) (.+?) (\d{1,2}\.\d+)(?= \d{4}-\d{2}-\d{2} 00:00:00\.0| \*| \[| ​|$)/g)) {
    const [, d, bucket, security, y] = m; if (+y > 0 && +y < 25 && security.length < 60) sec.push({ date: d, bucket: /SGS|SDL/i.test(security) ? "SDL " + bucket : bucket, security: security.trim(), ytm: +y });
  }
  return { nss, sec };
}
export function storeCCIL({ nss, sec }, src = "CCIL") {
  let n = 0;
  tx(() => {
    for (const p of nss) { run("INSERT INTO bond_nss(date,b0,b1,b2,b3,t1,t2,src) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET b0=excluded.b0,b1=excluded.b1,b2=excluded.b2,b3=excluded.b3,t1=excluded.t1,t2=excluded.t2,src=excluded.src", p.date, p.b0, p.b1, p.b2, p.b3, p.t1, p.t2, src); n++; }
    for (const s of sec) { run("INSERT INTO bond_sec(date,bucket,security,ytm) VALUES(?,?,?,?) ON CONFLICT(date,bucket) DO UPDATE SET security=excluded.security, ytm=excluded.ytm", s.date, s.bucket, s.security, s.ytm); upsertDaily(s.bucket.startsWith("SDL") ? "SDL:" + s.bucket.slice(4) : "CCIL:" + s.bucket, s.date, s.ytm, src); n++; }
  });
  return n;
}
async function syncCCIL() {
  let n = 0;
  for (const pg of ["zcyc-parameters", "tenorwise-indicative-yields"]) { const p = parseCCIL(await fetchRetry(`https://www.ccilindia.com/${pg}`, { timeout: 60, accept: "text/html" })); if (!p.nss.length && !p.sec.length) throw new Error(`CCIL ${pg}: no data found (page format may have changed)`); n += storeCCIL(p, "CCIL"); }
  return n;
}
export function parseRBI(html) {
  const t = strip(html), f = re => { const m = re.exec(t); return m ? +m[1] : null; };
  return { repo: f(/Policy Repo Rate\s*:\s*([\d.]+)\s*%/), sdf: f(/Standing Deposit Facility Rate\s*:\s*([\d.]+)\s*%/), msf: f(/Marginal Standing Facility Rate\s*:\s*([\d.]+)\s*%/) };
}
export function storeRBI(r, date, src = "RBI") {
  if (!(r.repo > 0 && r.repo < 20)) return 0; let n = 0;
  tx(() => { for (const [k, v] of [["RBI:REPO", r.repo], ["RBI:SDF", r.sdf], ["RBI:MSF", r.msf]]) if (v > 0 && v < 25) { const prev = get("SELECT y FROM bond_daily WHERE series=? AND date<? ORDER BY date DESC LIMIT 1", k, date)?.y; if (prev != null && prev !== v) log("bonds", `RBI ${k.slice(4)} changed from ${prev}% to ${v}%`); upsertDaily(k, date, v, src); n++; } });
  return n;
}
async function syncRBI() { return storeRBI(parseRBI(await fetchRetry("https://www.rbi.org.in/", { timeout: 60, accept: "text/html" })), istDate()); }

// ── live yields (CNBC) ───────────────────────────────────────────────────
const QURL = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" + Object.keys(LIVE).join("%7C") + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json";
const lastTick = {};
function dq(series, ok, why) {
  const d = new Date().toISOString().slice(0, 10);
  run("INSERT INTO dq(date,sym,accepted,rejected,reasons) VALUES(?,?,?,?,?) ON CONFLICT(date,sym) DO UPDATE SET accepted=dq.accepted+excluded.accepted, rejected=dq.rejected+excluded.rejected, reasons=CASE WHEN excluded.reasons='' THEN dq.reasons ELSE excluded.reasons END", d, "B:" + series, ok ? 1 : 0, ok ? 0 : 1, why || "");
}
// validation before storing: a real yield, a fresh quote time, no impossible jump (25 bp within 10 minutes)
export function checkYield(series, y, t, nowS = Date.now() / 1000) {
  const why = [];
  if (!Number.isFinite(y) || y < -2 || y > 30) why.push("not a plausible yield");
  if (!Number.isFinite(t) || t > nowS + 120) why.push("bad timestamp");
  const lt = lastTick[series]; if (lt && Number.isFinite(y) && t - lt.t < 600 && Math.abs(y - lt.y) > 0.25) why.push("jump of more than 25 bp within 10 minutes");
  return why;
}
export async function pollLive() {
  BSTATE.lastFetch = Date.now(); const changed = [];
  let j; try { j = await fetchJSON(QURL, { timeout: 15 }); } catch (e) { BSTATE.lastError = e.message; throw e; }
  const nowS = Date.now() / 1000;
  for (const q of j?.FormattedQuoteResult?.FormattedQuote || []) {
    const series = q.symbol; if (!LIVE[series]) continue;
    const y = parseFloat(String(q.last || "").replace("%", "")), t = Date.parse(q.last_time) / 1000, chg = parseFloat(q.change);
    if (!Number.isFinite(y) || !Number.isFinite(t)) continue;
    const prev = BSTATE.live[series]; BSTATE.live[series] = { y, t, chg: Number.isFinite(chg) ? chg : null, fetchedAt: Date.now(), name: q.name };
    if (prev?.t === t) continue;
    if (nowS - t > 20 * 60) continue;                       // stale quote (market quiet or closed): shown, not stored
    const why = checkYield(series, y, t, nowS);
    if (why.length) { dq(series, false, why.join("; ")); log("quality", `${series}: rejected live yield ${y} (${why.join("; ")})`); continue; }
    lastTick[series] = { y, t }; dq(series, true);
    run("INSERT OR IGNORE INTO bond_ticks(series,ts,y,src) VALUES(?,?,?,?)", series, Math.round(t), y, "live"); changed.push(series);
  }
  BSTATE.lastOk = Date.now(); BSTATE.lastError = null;
  return changed;
}
// gap filling from the source's own bars: minute bars (2 days) and 15-minute bars (10 days)
async function backfillBars() {
  let n = 0;
  for (const s of Object.keys(LIVE)) for (const r of ["1D", "5D"]) {
    try {
      const j = await fetchJSON(`https://ts-api.cnbc.com/harmony/app/charts/${r}.json?symbol=${s}`, { timeout: 30 }), bars = j?.barData?.priceBars || [];
      const pts = bars.map(b => [Math.round(b.tradeTimeinMills / 1000), +b.close]).filter(([t, y]) => t > 0 && Number.isFinite(y) && y > -2 && y < 30), bad = isolatedSpikes(pts);
      if (bad.size) { dq(s, false, "isolated spike in the source's bar history"); log("quality", `${s}: ignored ${bad.size} isolated spike${bad.size > 1 ? "s" : ""} in the source's ${r} bars (e.g. ${[...bad].slice(0, 2).map(i => `${pts[i][1]} at ${new Date(pts[i][0] * 1000).toISOString().slice(0, 16)}Z`).join(", ")})`); }
      tx(() => { pts.forEach(([t, y], i) => { if (!bad.has(i)) n += run("INSERT OR IGNORE INTO bond_ticks(series,ts,y,src) VALUES(?,?,?,?)", s, t, y, "bars").changes; }); });
    } catch (e) { log("bonds", `${s} ${r} bars: ${e.message}`); }
  }
  if (n) log("bonds", `Filled ${n.toLocaleString()} intraday yields from the source's bar history (gaps while the Mac was off or asleep)`);
  return n;
}
// daily market closes from the same source: India 30-year since 2011 (the only free long India history), US 2Y/10Y for cross-checks
async function syncMarketDaily() {
  const end = new Date().toISOString().slice(0, 10).replace(/-/g, ""); let n = 0;
  for (const s of ["IN30Y", "US10Y", "US2Y"]) {
    const from = lastDate("MKT:" + s) ? new Date(Date.now() - 40 * 864e5).toISOString().slice(0, 10).replace(/-/g, "") : "20110101";
    const j = await fetchJSON(`https://ts-api.cnbc.com/harmony/app/bars/${s}/1D/${from}000000/${end}000000/adjusted/EST5EDT.json`, { timeout: 60 }), bars = j?.barData?.priceBars || [];
    tx(() => { for (const b of bars) { const d = String(b.tradeTime).slice(0, 8), y = +b.close; if (/^\d{8}$/.test(d) && Number.isFinite(y) && y > -2 && y < 30) { upsertDaily("MKT:" + s, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, y, "CNBC daily close"); n++; } } });
  }
  return n;
}
// India 10-year market close per day from the recorded intraday yields (last trade at or before 17:00 IST)
function indiaCloses() {
  const rows = withoutSpikes(all("SELECT ts, y FROM bond_ticks WHERE series='IN10Y' AND ts > ? ORDER BY ts", Math.floor(Date.now() / 1000) - 40 * 86400), r => r.y), byDay = {};
  for (const r of rows) { const p = parts("Asia/Kolkata", r.ts * 1000); if (p.m < 540 || p.m > 1020 || ["Sat", "Sun"].includes(p.wd)) continue; byDay[istDate(r.ts * 1000)] = r.y; }
  const today = istDate(), done = !bondSession("IN") && parts("Asia/Kolkata").m >= 1020; let n = 0;
  tx(() => { for (const [d, y] of Object.entries(byDay)) if (d < today || done) { upsertDaily("MKT:IN10Y", d, y, "CNBC close (recorded)"); n++; } });
  return n;
}
// storage: keep every live yield for 90 days, then one per 15 minutes
export function pruneBondTicks() {
  const cut = Math.floor(Date.now() / 1000) - 90 * 86400;
  const r = run("DELETE FROM bond_ticks WHERE ts < ? AND rowid NOT IN (SELECT MIN(rowid) FROM bond_ticks WHERE ts < ? GROUP BY series, ts / 900)", cut, cut);
  return r.changes;
}

// ── cross-checks ─────────────────────────────────────────────────────────
function check(name, ok, detail) { run("INSERT INTO bond_checks(ts,name,ok,detail) VALUES(?,?,?,?)", now(), name, ok ? 1 : 0, detail); return { name, ok, detail }; }
export function crossChecks() {
  const out = [];
  // 1 Treasury vs Federal Reserve H.15: identical official numbers
  { const r = all("SELECT a.series s, a.date d, a.y ya, b.y yb FROM bond_daily a JOIN bond_daily b ON b.series = 'H15:' || substr(a.series, 5) AND b.date = a.date WHERE a.series LIKE 'UST:%' AND a.date >= date('now','-90 days')");
    const bad = r.filter(x => Math.abs(x.ya - x.yb) > 0.0051); out.push(check("Treasury = Federal Reserve H.15", r.length > 0 && !bad.length, r.length ? `${r.length} yields compared over 90 days; ${bad.length} differ${bad.length ? ": " + bad.slice(0, 3).map(x => `${x.s} ${x.d} ${x.ya} vs ${x.yb}`).join(", ") : ""}` : "no overlapping dates yet")); }
  // 2 Treasury 10Y close vs the live source's daily close (different time of day: allow 8 bp)
  { const r = all("SELECT a.date d, a.y ya, b.y yb FROM bond_daily a JOIN bond_daily b ON b.series='MKT:US10Y' AND b.date=a.date WHERE a.series='UST:10Y' AND a.date >= date('now','-120 days')"), dif = r.map(x => Math.abs(x.ya - x.yb) * 100).sort((a, b) => a - b), med = dif.length ? dif[Math.floor(dif.length / 2)] : null;
    out.push(check("Live source agrees with Treasury (10Y)", dif.length > 20 && med <= 4 && dif[dif.length - 1] <= 15, dif.length ? `${dif.length} days: median gap ${med.toFixed(1)} bp, largest ${dif[dif.length - 1].toFixed(1)} bp (quotes taken at slightly different times)` : "not enough overlap yet")); }
  // 3 India: CCIL 10-year benchmark YTM vs the recorded market close; CCIL curve vs its own benchmark
  { const r = all("SELECT a.date d, a.y ya, b.y yb FROM bond_daily a JOIN bond_daily b ON b.series='MKT:IN10Y' AND b.date=a.date WHERE a.series='CCIL:9Y-10Y'");
    const dif = r.map(x => Math.abs(x.ya - x.yb) * 100); out.push(check("India 10Y: CCIL vs live source", !r.length || Math.max(...dif) <= 6, r.length ? `${r.length} days: largest gap ${Math.max(...dif).toFixed(1)} bp` : "first comparison after the next Indian session"));
    const z = all("SELECT n.date d, n.b0, n.b1, n.b2, n.b3, n.t1, n.t2, s.ytm FROM bond_nss n JOIN bond_sec s ON s.date=n.date AND s.bucket='9Y-10Y' ORDER BY n.date DESC LIMIT 30");
    const nssY = p => { const g = x => (1 - Math.exp(-x)) / x, x1 = 10 / p.t1, x2 = 10 / p.t2; return p.b0 + p.b1 * g(x1) + p.b2 * (g(x1) - Math.exp(-x1)) + p.b3 * (g(x2) - Math.exp(-x2)); };
    const dz = z.map(p => Math.abs(nssY(p) - p.ytm) * 100); out.push(check("India: CCIL curve fits its 10Y benchmark", !z.length || Math.max(...dz) <= 10, z.length ? `${z.length} days: largest gap ${Math.max(...dz).toFixed(1)} bp (zero-coupon curve vs a coupon bond's yield)` : "no CCIL data yet")); }
  // 4 recession model: KUBER's formula on the NY Fed's own spread reproduces its published probability (12 months later)
  { const r = all("SELECT s.date d, s.y spread, p.y prob FROM bond_daily s JOIN bond_daily p ON p.series='REC:PROB' AND p.date = date(s.date, '+12 months') WHERE s.series='REC:SPREAD' AND s.date >= '2000-01-01'");
    const N = x => 0.5 * (1 + erfA(x / Math.SQRT2)), bad = r.filter(x => Math.abs(N(-0.5333 - 0.633 * x.spread) - x.prob) > 0.002);
    out.push(check("Recession model = NY Fed's published values", r.length > 100 && !bad.length, `${r.length} months compared; ${bad.length} differ by more than 0.2 points`)); }
  // 5 freshness of the official records
  const lagDays = (series, tz) => { const d = lastDate(series); if (!d) return Infinity; let n = 0, t = Date.parse(d + "T12:00:00Z"); const end = Date.parse(new Date().toLocaleDateString("en-CA", { timeZone: tz }) + "T12:00:00Z"); while ((t += 864e5) < end) { const wd = new Date(t).getUTCDay(); if (wd && wd !== 6) n++; } return n; };
  const ustLag = lagDays("UST:10Y", "America/New_York"), ccLag = lagDays("CCIL:9Y-10Y", "Asia/Kolkata");
  out.push(check("Treasury curve up to date", ustLag <= 2, `latest ${lastDate("UST:10Y")} (${ustLag} business day${ustLag === 1 ? "" : "s"} behind; holidays allowed)`));
  out.push(check("CCIL India curve up to date", ccLag <= 2, `latest ${lastDate("CCIL:9Y-10Y")} (${ccLag} business day${ccLag === 1 ? "" : "s"} behind; holidays allowed)`));
  run("DELETE FROM bond_checks WHERE ts < ?", new Date(Date.now() - 30 * 864e5).toISOString());
  return out;
}
function erfA(x) { const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)); }

// ── daily sync: every source, each step independent (one failing source never blocks the others) ──
let syncing = null;
export function bondsDaily(reason = "scheduled", { cloudPages = null, bars = true } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const res = {}, step = async (k, f) => { try { res[k] = await f(); } catch (e) { res[k] = "error: " + e.message; log("bonds", `${k}: ${e.message}`); } };
    await step("treasury", syncUST); await step("h15", syncH15); await step("nyfedRates", syncNYFedRates); await step("nyfedFiles", () => syncNYFedFiles(false));
    await step("ccil", syncCCIL); await step("rbi", syncRBI);
    if (cloudPages) await step("cloudPages", cloudPages);
    if (bars) await step("bars", backfillBars);
    await step("marketDaily", syncMarketDaily); await step("indiaCloses", async () => indiaCloses());
    await step("prune", async () => pruneBondTicks());
    res.checks = crossChecks(); setSetting("bonds.sync", { at: now(), reason, res: Object.fromEntries(Object.entries(res).filter(([k]) => k !== "checks")) });
    const bad = res.checks.filter(c => !c.ok); log("bonds", `Bond data sync (${reason}): ${Object.entries(res).filter(([k]) => k !== "checks").map(([k, v]) => `${k} ${typeof v === "number" ? v : v}`).join(" · ")}; checks ${res.checks.length - bad.length}/${res.checks.length} passed`);
    return res;
  })().finally(() => { syncing = null; });
  return syncing;
}

// ── analysis payload (read from the database; the maths runs in a worker thread) ──
// official pages the cloud saved while the Mac was off: parse and store them like a direct download
export async function storeCloudPages(CLOUD) {
  const pages = await CLOUD.pullPages(); let n = 0;
  for (const p of pages) { if (p.status !== 200 || !p.content) continue; if (p.name.startsWith("ccil")) n += storeCCIL(parseCCIL(p.content), "CCIL (saved by the cloud)"); else if (p.name === "rbi") n += storeRBI(parseRBI(p.content), istDate(Date.parse(p.at)), "RBI (saved by the cloud)"); }
  if (pages.length) CLOUD.pagesRead(pages[pages.length - 1].at);
  return n;
}
export function payload(stocks) {
  const ser = (s, from = "1900-01-01") => all("SELECT date, y FROM bond_daily WHERE series=? AND date>=? ORDER BY date", s, from).map(r => [r.date, r.y]);
  const dates = all("SELECT DISTINCT date FROM bond_daily WHERE series LIKE 'UST:%' ORDER BY date").map(r => r.date), idx = new Map(dates.map((d, i) => [d, i]));
  const align = prefix => Object.fromEntries(UST_TENORS.map(([t]) => { const a = new Array(dates.length).fill(null); for (const [d, y] of ser(prefix + t)) if (idx.has(d)) a[idx.get(d)] = y; return [t, a]; }));
  const ticks = s => intraday(s, 72);
  return {
    asOf: now(), live: BSTATE.live,
    us: { dates, nom: align("UST:"), real: align("USTR:"), effr: ser("EFFR"), sofr: ser("SOFR"), ffLo: ser("FF_LO"), ffHi: ser("FF_HI"), acm: { tp10: ser("ACM:TP10", "1990-01-01"), rny10: ser("ACM:RNY10", "1990-01-01"), y10: ser("ACM:Y10", "1990-01-01"), tp2: ser("ACM:TP2", "1990-01-01"), tp5: ser("ACM:TP5", "1990-01-01") }, rec: { spread: ser("REC:SPREAD"), prob: ser("REC:PROB"), nber: ser("REC:NBER") }, mkt10: ser("MKT:US10Y"), ticks10: ticks("US10Y"), ticks2: ticks("US2Y") },
    in: { nss: all("SELECT * FROM bond_nss ORDER BY date"), sec: all("SELECT * FROM bond_sec ORDER BY date, bucket"), ccil10: ser("CCIL:9Y-10Y"), mkt10: ser("MKT:IN10Y"), mkt30: ser("MKT:IN30Y"), repo: ser("RBI:REPO"), sdf: ser("RBI:SDF"), msf: ser("RBI:MSF"), ticks10: ticks("IN10Y") },
    stocks
  };
}
export function storeAnalysis(out, secs) { tx(() => { for (const [mk, data] of Object.entries(out)) run("INSERT INTO bond_analysis(market,made,data,secs) VALUES(?,?,?,?) ON CONFLICT(market) DO UPDATE SET made=excluded.made, data=excluded.data, secs=excluded.secs", mk, now(), JSON.stringify(data), secs); }); }
export function analysisOut() { return Object.fromEntries(all("SELECT market, made, data, secs FROM bond_analysis").map(r => [r.market, { made: r.made, secs: r.secs, ...JSON.parse(r.data) }])); }
export function intraday(series, hours = 30) { return withoutSpikes(all("SELECT ts, y FROM bond_ticks WHERE series=? AND ts > ? ORDER BY ts", series, Math.floor(Date.now() / 1000) - hours * 3600), r => r.y).map(r => [r.ts, r.y]); }
export function history(series, from) { return all("SELECT date, y FROM bond_daily WHERE series=? AND date>=? ORDER BY date", series, from || "1990-01-01").map(r => [r.date, r.y]); }
