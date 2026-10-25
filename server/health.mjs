// Health checks every 5 minutes. A problem raises an alert (shown as a banner in KUBER and on the Trial and System
// pages) and one macOS notification; the alert clears itself when the problem goes away.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { all, get, run, log, now, getSetting, ROOT } from "./db.mjs";
import { trackedIds, company, STATE } from "./companies.mjs";
import { feedSymbol, sessionOpen, tradingToday, minutesIntoSession } from "./market.mjs";
import { BSTATE, bondCore } from "./bonds.mjs";

const MIN_FREE = 5e9;   // bytes
export function diskFree() { try { const s = fs.statfsSync(ROOT); return s.bavail * s.bsize; } catch { return null; } }
export const diskOk = () => { const f = diskFree(); return f == null || f > MIN_FREE; };

const KUBER_APP = "/Applications/KUBER.app";
function notify(title, msg) {
  if (getSetting("alerts.notify", true) === false) return;
  const esc = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 220);
  const osa = () => execFile("/usr/bin/osascript", ["-e", `display notification "${esc(msg)}" with title "${esc(title)}" sound name "Submarine"`], () => {});
  // through KUBER.app itself, so the alert shows KUBER's name and logo (osascript shows Script Editor's)
  // (exits non-zero if notifications aren't allowed for KUBER yet; then the plain macOS notification is used)
  if (fs.existsSync(KUBER_APP)) execFile(KUBER_APP + "/Contents/MacOS/KUBER", ["--notify", String(title).slice(0, 80), String(msg).slice(0, 220)], { timeout: 150e3 }, e => { if (e) osa(); });
  else osa();
}
function raise(key, level, msg) {
  const r = get("SELECT * FROM alerts WHERE key=?", key);
  if (r && !r.resolved) { run("UPDATE alerts SET last=?, msg=? WHERE key=?", now(), msg, key); return; }
  run("INSERT INTO alerts(key,level,msg,first,last,notified,resolved) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET level=excluded.level, msg=excluded.msg, first=excluded.first, last=excluded.last, notified=excluded.notified, resolved=NULL", key, level, msg, now(), now(), now());
  log("alert", `${level}: ${msg}`); notify(level === "problem" ? "KUBER needs attention" : "KUBER", msg);
}
function clear(key) { const r = get("SELECT * FROM alerts WHERE key=? AND resolved IS NULL", key); if (r) { run("UPDATE alerts SET resolved=? WHERE key=?", now(), key); log("alert", `resolved: ${r.msg}`); } }
const hoursSince = iso => iso ? (Date.now() - Date.parse(iso)) / 3600e3 : Infinity;

export function check() {
  const ids = trackedIds(), nowS = Date.now() / 1000;
  // 1 live capture: a tracked stock silent for 10+ minutes while its market is open (after the first 15 minutes)
  for (const id of ids) {
    const c = STATE.base[id] || company(id); if (!c) continue; const mk = c.mk === "TW" ? "US" : c.mk, key = "capture:" + id;
    const since = get("SELECT MAX(ts) AS t FROM ticks WHERE sym=?", feedSymbol(c))?.t || 0, intoSession = minutesIntoSession(mk);
    // by the exchange clock (not the source's open/closed flag, which has proved wrong): 15+ minutes into a session and silent for 10+
    // a thinly traded stock (e.g. a small-cap) can go 10+ minutes without a trade: if KUBER fetched its quote in the last 5 minutes
    // and the exchange's last trade is simply older, that is a quiet stock, not a capture failure
    const L = STATE.live[feedSymbol(c)], quiet = !!L?.fetchedAt && Date.now() - L.fetchedAt < 300e3 && (L.noTradeYet || (L.day === tradingToday(mk) && L.time > 0 && L.time <= since + 1));
    if (intoSession >= 15 && nowS - since > 600 && process.uptime() > 900 && !quiet) raise(key, "problem", `${c.nm}: no live price recorded for ${since ? Math.round((nowS - since) / 60) + " minutes" : "this whole session"} while its market is open`);
    else clear(key);
  }
  // 2 the engine's routine jobs
  const m = getSetting("maint.last"); hoursSince(m) > 8 ? raise("maint", "problem", `Maintenance hasn't completed for ${Math.round(hoursSince(m))} hours`) : clear("maint");
  const l = getSetting("learn.last"); hoursSince(l) > 30 ? raise("learn", "problem", `Learning hasn't run for ${Math.round(hoursSince(l))} hours`) : clear("learn");
  const b = getSetting("backup.last", null), be = getSetting("backup.error", null);
  if (be && (!b || Date.parse(be.at) > Date.parse(b.at))) raise("backup", "problem", `Last backup failed: ${be.message}`); else if (hoursSince(b?.at) > 30) raise("backup", "problem", `No backup for ${Math.round(hoursSince(b?.at))} hours`); else clear("backup");
  const cl = getSetting("cloud", null);
  if (cl?.enabled) { if (cl.lastError && (!cl.lastSync || Date.parse(cl.lastErrorAt || 0) > Date.parse(cl.lastSync))) raise("cloud", "problem", `Cloud backup failed: ${cl.lastError}`); else if (cl.lastSync && hoursSince(cl.lastSync) > 14) raise("cloud", "problem", `Cloud backup hasn't succeeded for ${Math.round(hoursSince(cl.lastSync))} hours`); else clear("cloud"); }
  // 3 end of day: a completed trading day without its forecasts (checked 2 hours after the close)
  const missing = process.uptime() < 7200 ? [] : ids.filter(id => { const c = STATE.base[id] || company(id); if (!c) return false; const mk = c.mk === "TW" ? "US" : c.mk, sym = feedSymbol(c), d = get("SELECT MAX(date) AS d FROM daily WHERE sym=?", sym)?.d;
    return d && !tradingToday(mk) && !get("SELECT 1 AS x FROM eod WHERE sym=? AND date=?", sym, d); });
  missing.length ? raise("eod", "problem", `End-of-day step missing for ${missing.join(", ")}`) : clear("eod");
  // 4 disk space
  const f = diskFree(); f != null && f < MIN_FREE ? raise("disk", "problem", `Only ${(f / 1e9).toFixed(1)} GB free on this Mac. KUBER has paused backups and archiving`) : clear("disk");
  // 5 data quality: many rejected live prices today
  const dq = all("SELECT sym, rejected, accepted FROM dq WHERE date=? AND rejected > 5 AND rejected > accepted * 0.2", new Date().toISOString().slice(0, 10));
  dq.length ? raise("quality", "warning", `Many live prices rejected today for ${dq.map(r => r.sym).join(", ")}; check the System page`) : clear("quality");
  // 6 bond market: live yields recorded during core hours; the official data current; every cross-check passing
  for (const [mk, series, name] of [["US", "US10Y", "US 10-year"], ["IN", "IN10Y", "India 10-year"]]) {
    const key = "bonds-live:" + mk, last = get("SELECT MAX(ts) AS t FROM bond_ticks WHERE series=?", series)?.t || 0, q = BSTATE.live[series], silent = (nowS - last) / 60;
    if (!bondCore(mk) || process.uptime() < 900 || silent < 15) { clear(key); continue; }
    if (!BSTATE.lastOk || Date.now() - BSTATE.lastOk > 5 * 60e3) raise(key, "problem", `KUBER can't reach the live bond source (${BSTATE.lastError || "no answer"}); ${name} not recorded for ${Math.round(silent)} minutes`);
    else if (q && nowS - q.t > 3600) raise(key, "warning", `The source's ${name} yield hasn't changed for ${Math.round((nowS - q.t) / 60)} minutes (a market holiday, or the source is stale)`);
    else if (silent > 30) raise(key, "problem", `${name} yield not recorded for ${Math.round(silent)} minutes although the source is answering`);
    else clear(key);
  }
  const bc = all("SELECT name, ok, detail FROM bond_checks WHERE id IN (SELECT MAX(id) FROM bond_checks GROUP BY name) AND ts > ?", new Date(Date.now() - 2 * 864e5).toISOString()).filter(r => !r.ok);
  bc.length ? raise("bonds", "problem", `Bond data check failed: ${bc.map(r => `${r.name} (${r.detail})`).join("; ").slice(0, 300)}`) : clear("bonds");
}
export const active = () => all("SELECT * FROM alerts WHERE resolved IS NULL ORDER BY level, first");
export const recent = () => all("SELECT * FROM alerts ORDER BY COALESCE(resolved, last) DESC LIMIT 40");
// set or clear an alert from a check that runs elsewhere (e.g. the cloud collector, which needs a network call)
export function setAlert(key, msg) { if (msg) raise(key, "problem", msg); else clear(key); }
