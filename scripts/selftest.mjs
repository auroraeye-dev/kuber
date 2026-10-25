// KUBER self-test: checks the stored data for every tracked stock against KUBER's own rules. Read-only.
// Run: node scripts/selftest.mjs   (exit code 1 if any FAIL). Used by the daily health check.
import { DatabaseSync } from "node:sqlite";
const d = new DatabaseSync(new URL("../data/kuber.db", import.meta.url).pathname, { readOnly: true });
const q = (s, ...a) => d.prepare(s).all(...a), g = (s, ...a) => d.prepare(s).get(...a);
const out = []; const fail = (area, msg) => out.push(["FAIL", area, msg]), warn = (area, msg) => out.push(["WARN", area, msg]);
const TZ = { IN: "Asia/Kolkata", KR: "Asia/Seoul", US: "America/New_York" };
const localDate = (mk, t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ[mk] });
const mins = (mk, t = Date.now()) => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ[mk], hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(new Date(t)); const o = Object.fromEntries(p.map(x => [x.type, x.value])); return { m: +o.hour * 60 + +o.minute, wd: o.weekday }; };
const SESS = { IN: [555, 930], KR: [540, 930], US: [570, 960] };

// tracked stocks: starting companies (minus hidden, plus held), wishlist, held Finder stocks
const base = JSON.parse((await import("node:fs")).readFileSync(new URL("../data/companies.json", import.meta.url), "utf8")).companies;
const hidden = new Set(JSON.parse(g("SELECT value FROM settings WHERE key='hidden'")?.value || "[]"));
// holdings as company ids: a starting company of the order's market, else the Finder key (IN:XYZ, US:XYZ)
const cidOf = (mk, sym) => { mk = mk || "IN"; const b = base.find(c => c.tk === sym && (mk === "US" ? c.mk === "US" || c.mk === "TW" : c.mk === mk)); return b ? b.id : mk + ":" + sym; };
const qty = {}; for (const o of q("SELECT sym, mk, side, qty FROM orders WHERE status='executed'")) { const id = cidOf(o.mk, o.sym); qty[id] = (qty[id] || 0) + (o.side === "Buy" ? o.qty : -o.qty); }
const held = new Set(Object.keys(qty).filter(k => qty[k] > 1e-9));
const stocks = [];
for (const c of base) if (!hidden.has(c.id) || held.has(c.id)) stocks.push({ id: c.id, mk: c.mk === "TW" ? "US" : c.mk, sym: c.mk === "KR" ? c.tk + ".KS" : c.mk === "IN" ? c.tk + ".NS" : c.tk.replace(".", "-") });
for (const w of q("SELECT key FROM watch")) { const [mk, tk] = w.key.split(":"); stocks.push({ id: w.key, mk, sym: mk === "IN" ? tk + ".NS" : mk === "KR" ? tk + ".KS" : tk }); }
for (const id of held) if (!base.some(c => c.id === id) && !stocks.some(x => x.id === id)) { const [mk, tk] = id.split(":"); if (g("SELECT 1 x FROM catalog WHERE key=? AND status='ready'", id)) stocks.push({ id, mk, sym: mk === "IN" ? tk + ".NS" : mk === "KR" ? tk + ".KS" : tk }); else fail("holdings", `held ${id} has no downloaded data`); }

for (const s of stocks) {
  const rows = q("SELECT date, close, adj, open, high, low FROM daily WHERE sym=? ORDER BY date", s.sym), A = `${s.id}`;
  if (rows.length < 5) { fail(A, `only ${rows.length} daily rows`); continue; }
  // prices sane
  for (const r of rows.slice(-260)) {
    if (!(r.close > 0)) fail(A, `${r.date}: close ${r.close}`);
    if (r.high != null && r.low != null && (r.high < r.low - 1e-9 || r.close > r.high * 1.0005 || r.close < r.low * 0.9995)) warn(A, `${r.date}: close ${r.close} outside high/low ${r.low}–${r.high}`);
    if (r.adj != null && !(r.adj > 0)) fail(A, `${r.date}: adjusted ${r.adj}`);
  }
  for (let i = Math.max(1, rows.length - 260); i < rows.length; i++) { const m = rows[i].close / rows[i - 1].close - 1; if (Math.abs(m) > 0.25) warn(A, `${rows[i].date}: close moved ${(m * 100).toFixed(1)}% in a day (check corporate action)`); }
  // up to date: the latest completed trading day must be stored (weekdays; holidays tolerated as WARN)
  const last = rows[rows.length - 1].date, { m, wd } = mins(s.mk), today = localDate(s.mk), afterClose = m > SESS[s.mk][1] + 60;
  const expected = (wd !== "Sat" && wd !== "Sun" && afterClose) ? today : null;
  if (expected && last < expected) warn(A, `latest close ${last}, expected ${expected} (holiday, or not synced yet)`);
  // a day in progress must never be stored as a close (from 30 min before the open to 15 min after the bell)
  if (wd !== "Sat" && wd !== "Sun" && m >= SESS[s.mk][0] - 30 && m < SESS[s.mk][1] + 15 && last === today) fail(A, `a ${today} close is stored while that session is still in progress`);
  // official NSE closes applied
  if (s.mk === "IN") for (const o of q("SELECT o.date, o.close, d.close dc FROM official_close o JOIN daily d ON d.sym=o.sym AND d.date=o.date WHERE o.sym=?", s.sym)) if (Math.abs(o.dc / o.close - 1) > 1e-6) fail(A, `${o.date}: stored close ${o.dc} ≠ NSE official ${o.close}`);
  if (s.mk === "IN") { const miss = q("SELECT date FROM daily WHERE sym=? AND date>=? AND date<? AND date NOT IN (SELECT date FROM official_close WHERE sym=?)", s.sym, "2026-10-13", today, s.sym).map(r => r.date); const h = mins("IN").m; if (miss.length && !(miss.length === 1 && miss[0] === today)) (h > 20 * 60 || miss.some(x => x < today) ? (miss.filter(x => x < today).length ? fail : warn) : warn)(A, `no NSE official close for ${miss.join(", ")}`); }
  // end-of-day + forecasts for the latest completed close
  const done = last < today || afterClose || s.mk !== "IN";
  if (done && !g("SELECT 1 x FROM eod WHERE sym=? AND date=?", s.sym, last)) warn(A, `no end-of-day step for ${last}`);
  if (rows.length >= 200 && done) {
    const preds = g("SELECT COUNT(*) n FROM preds WHERE cid=? AND made=? AND kind='auto'", s.id, last).n;
    if (!preds) warn(A, `no 1/4/13-week forecasts made from the ${last} close`);
    const lr = g("SELECT COUNT(*) n FROM ladder WHERE cid=? AND made=?", s.id, last).n, lb = g("SELECT COUNT(*) n FROM ladder_base WHERE cid=? AND made=?", s.id, last).n;
    if (rows.length >= 260 && lr !== 90) warn(A, `90-day outlook from ${last}: ${lr} days (expected 90)`);
    if (lr !== lb) fail(A, `tuned outlook has ${lr} days but standard (control) has ${lb} for ${last}`);
    const run = g("SELECT p0 FROM ladder_runs WHERE cid=? AND made=?", s.id, last); if (run && Math.abs(run.p0 / rows[rows.length - 1].close - 1) > 0.001) fail(A, `outlook from ${last} anchored at ${run.p0}, stored close ${rows[rows.length - 1].close}`);
  }
  // numbers in forecasts are finite and ordered
  for (const T of ["ladder", "ladder_base"]) { const bad = g(`SELECT COUNT(*) n FROM ${T} WHERE cid=? AND (p05 IS NULL OR p95 IS NULL OR p05 <= 0 OR p05 > p25 OR p25 > p50 OR p50 > p75 OR p75 > p95)`, s.id).n; if (bad) fail(A, `${bad} malformed rows in ${T}`); }
  const badP = g("SELECT COUNT(*) n FROM preds WHERE cid=? AND (p05 <= 0 OR p05 > median OR median > p95 OR p0 <= 0)", s.id).n; if (badP) fail(A, `${badP} malformed forecasts`);
  // scored rows must point at a stored close
  for (const T of ["ladder", "ladder_base"]) { const bad = g(`SELECT COUNT(*) n FROM ${T} l WHERE l.cid=? AND l.scored IS NOT NULL AND NOT EXISTS (SELECT 1 FROM daily d WHERE d.sym=? AND d.date=l.actual_date)`, s.id, s.sym).n; if (bad) fail(A, `${bad} ${T} scores refer to a close that isn't stored`); }
  const misScored = g("SELECT COUNT(*) n FROM ladder l JOIN daily d ON d.sym=? AND d.date=l.actual_date WHERE l.cid=? AND l.scored IS NOT NULL AND abs(l.actual/d.close-1) > 0.001 AND l.actual_date >= date('now','-5 days')", s.sym, s.id).n; if (misScored) warn(A, `${misScored} recent outlook days scored against a close that has since changed (re-scored at next maintenance)`);
  // live samples only inside sessions
  const t = q("SELECT ts FROM ticks WHERE sym=? AND ts > strftime('%s','now','-3 days')", s.sym); let outside = 0; for (const x of t) { const z = mins(s.mk, x.ts * 1000); if (z.m < SESS[s.mk][0] - 1 || z.m > SESS[s.mk][1] + 2 || z.wd === "Sat" || z.wd === "Sun") outside++; } if (outside > 2) warn(A, `${outside} live samples stored outside trading hours in the last 3 days`);
}
// engine-wide
const st = k => { try { return JSON.parse(g("SELECT value FROM settings WHERE key=?", k)?.value || "null"); } catch { return null; } };
const ago = iso => iso ? (Date.now() - Date.parse(iso)) / 3600e3 : Infinity;
if (ago(st("maint.last")) > 8) fail("engine", `maintenance last ran ${ago(st("maint.last")).toFixed(1)} h ago`);
if (ago(st("learn.last")) > 30) fail("engine", `learning last ran ${ago(st("learn.last")).toFixed(1)} h ago`);
if (ago(st("backup.last")?.at) > 30) fail("backup", `last backup ${ago(st("backup.last")?.at).toFixed(1)} h ago`);
const cl = st("cloud"); if (cl?.enabled && ago(cl.lastSync) > 14) fail("cloud", `cloud backup last succeeded ${ago(cl.lastSync).toFixed(1)} h ago`);
for (const a of q("SELECT msg FROM alerts WHERE resolved IS NULL")) warn("alert", a.msg);
const nanP = g("SELECT COUNT(*) n FROM analyses WHERE ts > datetime('now','-2 days') AND (median IS NULL OR p05 IS NULL OR vol IS NULL OR median <= 0)").n; if (nanP) fail("analyses", `${nanP} recent analyses with missing numbers`);
const errs = q("SELECT kind, substr(msg,1,140) m FROM events WHERE ts > ? AND kind IN ('http','tick','worker','health') ORDER BY id DESC LIMIT 5", new Date(Date.now() - 864e5).toISOString()); for (const e of errs) fail("engine log", `${e.kind}: ${e.m}`);

// bond market: maths tests, official data present and current, cross-source agreement, analysis current
{
  const bt = (await import("node:child_process")).spawnSync(process.execPath, [new URL("./bondtest.mjs", import.meta.url).pathname], { encoding: "utf8" });
  if (bt.status !== 0) fail("bonds", "maths tests failed: " + (bt.stdout || "").split("\n").filter(l => l.startsWith("FAIL")).slice(0, 3).join(" | "));
  const has = g("SELECT 1 x FROM sqlite_master WHERE name='bond_daily'");
  if (has) {
    const last = s => g("SELECT MAX(date) d FROM bond_daily WHERE series=?", s)?.d, bdays = (d, tz) => { if (!d) return 99; let n = 0, t = Date.parse(d + "T12:00:00Z"); const end = Date.parse(localDate(tz) + "T12:00:00Z"); while ((t += 864e5) < end) { const w = new Date(t).getUTCDay(); if (w && w !== 6) n++; } return n; };
    const uL = bdays(last("UST:10Y"), "US"), cL = bdays(g("SELECT MAX(date) d FROM bond_nss")?.d, "IN");
    if (!last("UST:10Y")) warn("bonds", "no Treasury yields stored yet (first download runs at the next maintenance)"); else if (uL > 2) fail("bonds", `Treasury curve is ${uL} business days old (latest ${last("UST:10Y")})`);
    if (!g("SELECT 1 x FROM bond_nss")) warn("bonds", "no CCIL India curve stored yet"); else if (cL > 2) fail("bonds", `CCIL India curve is ${cL} business days old`);
    const bad = g("SELECT COUNT(*) n FROM bond_daily WHERE (y < -2 OR y > 30) AND series NOT LIKE 'REC:%'").n; if (bad) fail("bonds", `${bad} stored yields outside −2%…30%`);
    const fut = g("SELECT COUNT(*) n FROM bond_daily WHERE date > date('now','+1 day') AND series NOT IN ('REC:PROB','REC:NBER')").n; if (fut) fail("bonds", `${fut} yields dated in the future`);
    const h = q("SELECT a.series s, a.date d, a.y ya, b.y yb FROM bond_daily a JOIN bond_daily b ON b.series='H15:'||substr(a.series,5) AND b.date=a.date WHERE a.series LIKE 'UST:%' AND abs(a.y-b.y) > 0.0051"); if (h.length) fail("bonds", `${h.length} Treasury yields differ from the Federal Reserve's H.15 (e.g. ${h[0].s} ${h[0].d}: ${h[0].ya} vs ${h[0].yb})`);
    for (const r of q("SELECT n.date d, n.b0, n.b1, n.b2, n.b3, n.t1, n.t2, s.ytm FROM bond_nss n JOIN bond_sec s ON s.date=n.date AND s.bucket='9Y-10Y'")) { const G = x => (1 - Math.exp(-x)) / x, x1 = 10 / r.t1, x2 = 10 / r.t2, z = r.b0 + r.b1 * G(x1) + r.b2 * (G(x1) - Math.exp(-x1)) + r.b3 * (G(x2) - Math.exp(-x2)); if (Math.abs(z - r.ytm) > 0.10) fail("bonds", `${r.d}: CCIL curve gives ${z.toFixed(4)}% at 10 years but the benchmark traded at ${r.ytm}%`); }
    for (const c of q("SELECT name, ok, detail FROM bond_checks WHERE id IN (SELECT MAX(id) FROM bond_checks GROUP BY name)")) if (!c.ok) fail("bonds", `${c.name}: ${c.detail}`);
    const an = g("SELECT made, data FROM bond_analysis WHERE market='US'");
    if (an) { const asOf = JSON.parse(an.data).asOf; if (last("UST:10Y") && asOf < last("UST:10Y") && Date.now() - Date.parse(an.made) > 6 * 3600e3) fail("bonds", `analysis is from ${asOf} but Treasury data reaches ${last("UST:10Y")}`); if (Date.now() - Date.parse(an.made) > 30 * 3600e3) fail("bonds", `bond analysis last ran ${((Date.now() - Date.parse(an.made)) / 3600e3).toFixed(0)} h ago`); }
    else if (last("UST:10Y")) warn("bonds", "bond analysis hasn't run yet");
  }
}
const nF = out.filter(x => x[0] === "FAIL").length, nW = out.length - nF;
console.log(`KUBER self-test: ${stocks.length} stocks · ${nF} FAIL · ${nW} WARN`);
for (const [lv, a, m] of out) console.log(`${lv.padEnd(4)}  ${a.padEnd(14)} ${m}`);
process.exit(nF ? 1 : 0);
