// Market data with two providers and an independent cross-check:
//   primary  stockanalysis.com quote + daily-history API (NSE, NYSE/Nasdaq, KRX)
//   backup   Yahoo Finance chart API
//   verify   NSE: screener.in close (independent of the primary); US/KRX: Yahoo close
// All requests go through one rate limiter (≥1.5 s apart, long pause after HTTP 429).
import { execFile } from "node:child_process";
import { all, get, run, tx, log, now } from "./db.mjs";
import { withoutSpikes } from "./bondmath.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = ms => new Promise(z => setTimeout(z, ms));
const pause = {};
// rate limit: requests start at least 0.6 s apart (≤ 100 a minute) and at most 4 are in flight at once
// live quotes have priority; history downloads use at most 2 of the 4 lanes so they never starve live capture
let nextAt = 0, inFlight = 0, bulk = 0; const waitHi = [], waitLo = [];
async function slot(hi) {
  while (inFlight >= 4 || (!hi && bulk >= 2)) await new Promise(r => (hi ? waitHi : waitLo).push(r));
  inFlight++; if (!hi) bulk++; const w = Math.max(0, nextAt - Date.now()); nextAt = Math.max(Date.now(), nextAt) + 600; if (w) await sleep(w);
}
function release(hi) { inFlight = Math.max(0, inFlight - 1); if (!hi) bulk = Math.max(0, bulk - 1); const r = waitHi.shift() || waitLo.shift(); if (r) r(); }
function curl(url) {
  return new Promise((res, rej) => execFile("curl", ["-s", "-m", /history/.test(url) ? "60" : "15", "-A", UA, "-H", "Accept: application/json", "-w", "\n%{http_code}", url], { maxBuffer: 30e6 }, (err, out) => {
    if (err) return rej(err); const i = out.lastIndexOf("\n"); res({ status: +out.slice(i + 1), body: out.slice(0, i) });
  }));
}
async function getJSON(url) {
  const host = new URL(url).host;
  if (pause[host] && Date.now() < pause[host]) throw new Error(`${host} paused after rate limit`);
  const hi = /\/api\/quotes\//.test(url); await slot(hi);
  let r; try { r = await curl(url); } finally { release(hi); }
  if (r.status === 429) { pause[host] = Date.now() + 5 * 60e3; log("feed", `${host} rate-limited; pausing it for 5 minutes`); throw new Error(`${host} HTTP 429`); }
  if (r.status !== 200) throw new Error(`${host} HTTP ${r.status}`);
  return JSON.parse(r.body);
}

// exchange sessions in local time (minutes): KUBER's own clock decides whether a market is trading, because the
// provider's market-status flag proved wrong for NSE ("closed" on 21 Oct 2026 while quotes were updating)
const SESS = { IN: ["Asia/Kolkata", 555, 930], US: ["America/New_York", 570, 960], TW: ["America/New_York", 570, 960], KR: ["Asia/Seoul", 540, 930] };
function localNow(tz) { return Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()).map(x => [x.type, x.value])); }
export function sessionOpen(mk) { const [tz, a, b] = SESS[mk] || SESS.US, p = localNow(tz); if (p.weekday === "Sat" || p.weekday === "Sun") return false; const m = +p.hour * 60 + +p.minute; return m >= a && m <= b; }
// the exchange's local date while a session is in progress (until 15 min after the bell, while the official close settles), else null
export function minutesIntoSession(mk) { const [tz, a, b] = SESS[mk] || SESS.US, p = localNow(tz); if (p.weekday === "Sat" || p.weekday === "Sun") return -1; const m = +p.hour * 60 + +p.minute; return m >= a && m <= b ? m - a : -1; }
export function tradingToday(mk) { const [tz, a, b] = SESS[mk] || SESS.US, p = localNow(tz); if (p.weekday === "Sat" || p.weekday === "Sun") return null; const m = +p.hour * 60 + +p.minute; return m >= a - 30 && m < b + 15 ? `${p.year}-${p.month}-${p.day}` : null; }
export function feedSymbol(c) { if (c.mk === "KR") return c.tk + ".KS"; if (c.mk === "IN") return c.tk + ".NS"; return c.tk.replace(".", "-"); }
export function saPath(c) { if (c.mk === "KR") return "a/krx-" + c.tk.toLowerCase(); if (c.mk === "IN") return "a/nse-" + c.tk.toLowerCase(); return "s/" + c.tk.toLowerCase(); }
const ydate = (ts, off) => new Date((ts + off) * 1000).toISOString().slice(0, 10);

// rows: [date, close, volume, adjusted close, open, high, low]. The provider back-adjusts the whole history whenever a
// dividend or corporate action happens, so a full 5-year sync rewrites every stored adjusted value.
// official closes override the provider's history (which can be stale or carry the last trade instead of the close)
export function applyOfficial(sym) {
  let n = 0;
  for (const o of all("SELECT o.* FROM official_close o JOIN daily d ON d.sym=o.sym AND d.date=o.date WHERE o.sym=? AND (abs(d.close - o.close) > 1e-9 OR d.high IS NOT o.high OR d.low IS NOT o.low)", sym)) {
    const d = get("SELECT close FROM daily WHERE sym=? AND date=?", sym, o.date);
    n += run("UPDATE daily SET adj = CASE WHEN adj IS NULL THEN NULL ELSE adj * ? END, close=?, open=COALESCE(?, open), high=COALESCE(?, high), low=COALESCE(?, low) WHERE sym=? AND date=?", o.close / d.close, o.close, o.open, o.high, o.low, sym, o.date).changes;
  }
  return n;
}
// NSE's official end-of-day file ("bhavcopy"), published each evening: CLOSE_PRICE is the official close (VWAP of the
// last 30 minutes), LAST_PRICE the last trade. Returns { SYMBOL: {open, high, low, close, last} } for EQ series, or null.
export async function nseBhavcopy(date) {
  const [y, m, d] = date.split("-"), url = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`;
  const r = await new Promise(res => execFile("curl", ["-s", "-m", "60", "-A", UA, "-w", "\n%{http_code}", url], { maxBuffer: 30e6 }, (err, out) => { if (err) return res(null); const i = out.lastIndexOf("\n"); res({ status: +out.slice(i + 1), body: out.slice(0, i) }); }));
  if (!r || r.status !== 200 || !/SYMBOL/.test(r.body.slice(0, 200))) return null;
  const lines = r.body.trim().split(/\r?\n/), hdr = lines[0].split(",").map(x => x.trim()), ix = k => hdr.indexOf(k), out = {};
  for (const ln of lines.slice(1)) { const f = ln.split(",").map(x => x.trim()); if (f[ix("SERIES")] !== "EQ") continue; const n = k => +f[ix(k)]; out[f[ix("SYMBOL")]] = { open: n("OPEN_PRICE"), high: n("HIGH_PRICE"), low: n("LOW_PRICE"), close: n("CLOSE_PRICE"), last: n("LAST_PRICE") }; }
  return out;
}
function storeDaily(sym, rows) { tx(() => { for (const [d, c, v, a, o, h, l] of rows) if (c != null) run("INSERT INTO daily(sym,date,close,volume,adj,open,high,low) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(sym,date) DO UPDATE SET close=excluded.close, volume=excluded.volume, adj=COALESCE(excluded.adj, daily.adj), open=COALESCE(excluded.open, daily.open), high=COALESCE(excluded.high, daily.high), low=COALESCE(excluded.low, daily.low)", sym, d, c, v ?? null, a ?? null, o ?? null, h ?? null, l ?? null); }); applyOfficial(sym); return rows.length; }
async function saHistory(c, range) { const j = await getJSON(`https://stockanalysis.com/api/symbol/${saPath(c)}/history?range=${range}&period=Daily`); return (j.data || []).map(x => [x.t, x.c, x.v, x.a ?? null, x.o ?? null, x.h ?? null, x.l ?? null]).reverse(); }
async function yhHistory(c, range) { const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(feedSymbol(c))}?range=${range.toLowerCase()}&interval=1d`), r = j?.chart?.result?.[0]; if (!r) throw new Error("no data"); const q = r.indicators.quote[0], ad = r.indicators.adjclose?.[0]?.adjclose; return r.timestamp.map((t, i) => [ydate(t, r.meta.gmtoffset || 0), q.close[i], q.volume[i], ad?.[i] ?? null, q.open?.[i] ?? null, q.high?.[i] ?? null, q.low?.[i] ?? null]); }

export async function syncDaily(c, range = "5Y") {
  const sym = feedSymbol(c), mk = c.mk === "TW" ? "US" : c.mk, live = tradingToday(mk);
  // the provider's history includes the day in progress (a partial "close"): never store a row until that session is over
  const done = rows => live ? rows.filter(r => r[0] !== live) : rows;
  try {
    const rows = await saHistory(c, range);
    // the provider's long history can serve a stale copy of the latest days (seen 21 Oct 2026: 5Y had a mid-session
    // close, 1M the final one). Overlay the last month, rescaling its adjusted closes to match at the first shared date.
    if (range !== "1M") {
      try {
        const recent = await saHistory(c, "1M"), byDate = new Map(rows.map((r, i) => [r[0], i]));
        const first = recent.find(r => byDate.has(r[0]) && r[3] && rows[byDate.get(r[0])][3]), k = first ? rows[byDate.get(first[0])][3] / first[3] : 1;
        for (const r of recent) { const fixed = [r[0], r[1], r[2], r[3] != null ? r[3] * k : null, r[4], r[5], r[6]]; if (byDate.has(r[0])) rows[byDate.get(r[0])] = fixed; else rows.push(fixed); }
        rows.sort((x, y) => x[0].localeCompare(y[0]));
      } catch { /* long history alone */ }
    }
    return { n: storeDaily(sym, done(rows)), provider: "stockanalysis.com" };
  }
  catch (e1) { try { return { n: storeDaily(sym, done(await yhHistory(c, range === "5Y" ? "5y" : "3mo"))), provider: "Yahoo Finance" }; } catch (e2) { throw new Error(`${c.id}: ${e1.message}; backup: ${e2.message}`); } }
}
export async function quote(c) {
  const sym = feedSymbol(c); let q;
  try {
    const d = (await getJSON(`https://stockanalysis.com/api/quotes/${saPath(c)}`)).data;
    const mk = c.mk === "TW" ? "US" : c.mk, fresh = Math.abs(Date.now() - d.ts) < 45 * 60e3;   // KRX data from this source can be delayed ~20 min
    // a thinly traded stock has no trade time until its first trade of the day (seen on a small US stock): that is "no trade yet", not a bad price
    if (!Number.isFinite(Number(d.ts)) || !(d.ts > 0)) { q = { sym, price: d.p, prev: d.cl, chg: d.cp, time: null, open: false, noTradeYet: true, providerStatus: d.ms, day: d.td, provider: "stockanalysis.com", quality: { ok: true, why: [] } }; return q; }
    // trading = inside the exchange's session by our clock, the quote is for today, and its timestamp is fresh
    q = { sym, price: d.p, prev: d.cl, chg: d.cp, time: Math.round(d.ts / 1000), open: sessionOpen(mk) && fresh && d.td === tradingToday(mk), delaySec: Math.round((Date.now() - d.ts) / 1000), providerStatus: d.ms, day: d.td, provider: "stockanalysis.com" };
  } catch (e) {
    const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m`), m = j?.chart?.result?.[0]?.meta; if (!m) throw e;
    const per = m.currentTradingPeriod?.regular, t = Date.now() / 1000, prev = m.chartPreviousClose ?? m.previousClose;
    q = { sym, price: m.regularMarketPrice, prev, chg: prev ? (m.regularMarketPrice / prev - 1) * 100 : null, time: m.regularMarketTime, open: per ? t >= per.start && t <= per.end : false, day: ydate(m.regularMarketTime, m.gmtoffset || 0), provider: "Yahoo Finance" };
  }
  q.quality = checkTick(sym, q);
  if (q.quality.ok && q.open) run("INSERT OR IGNORE INTO ticks(sym,ts,price) VALUES(?,?,?)", sym, q.time, q.price);
  return q;
}
// Validation for live samples before they are stored: a real number, a fresh timestamp, and no impossible jump
// (exchange limits: NSE bands ≤ 20%, KRX ±30%; US has none, so 40% from the previous close is treated as an error).
const lastTick = {};
function checkTick(sym, q) {
  const why = [], p = q.price;
  if (!(Number.isFinite(p) && p > 0)) why.push("not a positive price");
  if (!Number.isFinite(q.time) || Math.abs(Date.now() / 1000 - q.time) > 7 * 86400) why.push("stale timestamp");
  if (q.prev > 0 && Number.isFinite(p) && Math.abs(p / q.prev - 1) > 0.4) why.push("more than 40% from the previous close");
  const lt = lastTick[sym]; if (lt && q.open && lt.day === q.day && Math.abs(p / lt.price - 1) > 0.2 && q.time - lt.time < 600) why.push("jump of more than 20% within 10 minutes");
  if (!why.length && q.open) lastTick[sym] = { price: p, time: q.time, day: q.day };
  if (q.open || why.length) {
    const d = q.day || new Date().toISOString().slice(0, 10);
    run("INSERT INTO dq(date,sym,accepted,rejected,reasons) VALUES(?,?,?,?,?) ON CONFLICT(date,sym) DO UPDATE SET accepted=dq.accepted+excluded.accepted, rejected=dq.rejected+excluded.rejected, reasons=CASE WHEN excluded.reasons='' THEN dq.reasons ELSE excluded.reasons END", d, sym, why.length ? 0 : 1, why.length ? 1 : 0, why.join("; "));
    if (why.length) log("quality", `${sym}: rejected live price ${p} (${why.join("; ")})`);
  }
  return { ok: !why.length, why };
}
// isolated one-sample spikes (> 1% away from neighbours that agree within 0.4%) are bad prints: kept in the table,
// left out of everything computed or drawn from intraday prices
const cleanTicks = rows => withoutSpikes(rows, r => Math.log(r.price), { jump: 0.01, agree: 0.004 });
export function ticksOn(sym, t0, t1) { return cleanTicks(all("SELECT ts, price FROM ticks WHERE sym=? AND ts>=? AND ts<? ORDER BY ts", sym, t0, t1)); }
export function dailySeries(sym) { return all("SELECT date, close, adj, open, high, low FROM daily WHERE sym=? ORDER BY date", sym); }
export function ticksToday(sym) { const since = Math.floor(Date.now() / 1000) - 30 * 3600; return cleanTicks(all("SELECT ts, price FROM ticks WHERE sym=? AND ts>=? ORDER BY ts", sym, since)); }
// Adjusted series, chain-linked back from the latest exchange close:
//  · ordinary days use the provider's adjusted-close ratio (captures dividends and splits);
//  · days where the provider's adjustment factor jumps by more than 15% are demergers or similar. The provider's
//    factor proved unreliable there (two Indian demergers in 2025–26 turned into +21% / +79% "gains"), so the
//    return on that one day is treated as unknown and set to zero instead of trusting either series.
export function adjustedDaily(rows) {
  const n = rows.length, haveAdj = n > 0 && rows.every(r => r.adj != null && r.close != null), out = new Array(n), actions = [];
  if (!n) return { out, actions, haveAdj };
  out[n - 1] = rows[n - 1].close;
  for (let i = n - 1; i > 0; i--) {
    const a = rows[i - 1], b = rows[i];
    let g = haveAdj ? b.adj / a.adj : b.close / a.close;
    if (haveAdj) { const f = (b.adj / b.close) / (a.adj / a.close); if (Math.abs(Math.log(f)) > Math.log(1.15)) { actions.push({ date: b.date, rawMove: b.close / a.close - 1, providerAdjMove: g - 1, factor: f }); g = 1; } }
    out[i - 1] = out[i] / g;
  }
  return { out, actions: actions.reverse(), haveAdj };
}
// Daily variance from the day's prices: overnight gap² + Rogers–Satchell range estimator
//   RS = ln(H/C)·ln(H/O) + ln(L/C)·ln(L/O)   (unbiased under drift; Rogers & Satchell 1991)
// The overnight gap uses adjusted prices, so dividends and excluded demerger days don't count as moves.
// Falls back to the squared close-to-close return when the day's open/high/low are missing or inconsistent.
export function dailyVariance(rows, out) {
  const v = new Array(rows.length).fill(null); let nRange = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], p = rows[i - 1], cc = Math.log(out[i] / out[i - 1]);
    const ok = r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0 && r.high >= Math.max(r.open, r.close) - 1e-9 && r.low <= Math.min(r.open, r.close) + 1e-9;
    if (!ok) { v[i] = cc * cc; continue; }
    const on = cc - Math.log(r.close / r.open), rs = Math.log(r.high / r.close) * Math.log(r.high / r.open) + Math.log(r.low / r.close) * Math.log(r.low / r.open);
    v[i] = on * on + Math.max(0, rs); nRange++;
  }
  return { v, nRange };
}
// last close of each Monday-based week; wk = adjusted (for returns), wkRaw = exchange close (for prices shown),
// wkVar = that week's realised variance from daily ranges (for the realised-volatility model)
export function weekly(rows) {
  const { out, actions, haveAdj } = adjustedDaily(rows), { v, nRange } = dailyVariance(rows, out), wd = [], wk = [], wkRaw = [], wkVar = []; let key = null;
  rows.forEach((r, i) => {
    const d = new Date(r.date + "T00:00:00Z"), mon = new Date(d); mon.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const k = mon.toISOString().slice(0, 10);
    if (k !== key) { wd.push(r.date); wk.push(out[i]); wkRaw.push(r.close); wkVar.push(v[i] ?? 0); key = k; } else { wd[wd.length - 1] = r.date; wk[wk.length - 1] = out[i]; wkRaw[wkRaw.length - 1] = r.close; wkVar[wkVar.length - 1] += v[i] ?? 0; }
  });
  // the latest week may be unfinished (e.g. a Tuesday): scale its variance to a full five-day week
  if (rows.length) { const last = new Date(rows[rows.length - 1].date + "T00:00:00Z"), dow = last.getUTCDay(); if (dow >= 1 && dow <= 4) wkVar[wkVar.length - 1] *= 5 / dow; }
  return { wd, wk, wkRaw, wkVar, rangeShare: rows.length > 1 ? nRange / (rows.length - 1) : 0, adjusted: haveAdj, actions };
}
export async function verify(c, snapshot) {
  const sym = feedSymbol(c), mine = get("SELECT date, close FROM daily WHERE sym=? AND date<=? ORDER BY date DESC LIMIT 1", sym, snapshot?.date || "9999");
  if (!mine) return null;
  let other = null, by = null;
  if (c.mk === "IN" && snapshot && snapshot.date === mine.date) { other = snapshot.close; by = "screener.in"; }
  else { try { const rows = await yhHistory(c, "1mo"), hit = rows.find(r => r[0] === mine.date); if (hit && hit[1] != null) { other = hit[1]; by = "Yahoo Finance"; } } catch { /* retried next maintenance */ } }
  if (other == null) return null;
  const diff = mine.close / other - 1, ok = Math.abs(diff) <= 0.01 ? 1 : 0;
  run("INSERT INTO verify(cid,src_date,src_close,feed_close,diff,ok,checked) VALUES(?,?,?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET src_date=excluded.src_date, src_close=excluded.src_close, feed_close=excluded.feed_close, diff=excluded.diff, ok=excluded.ok, checked=excluded.checked", c.id, mine.date, other, mine.close, diff, ok, now() + " via " + by);
  if (!ok) log("verify", `${c.id}: stored close ${mine.close} vs ${by} ${other} on ${mine.date} (${(diff * 100).toFixed(2)}%)`);
  return { diff, ok, by };
}
