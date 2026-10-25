// Nightly database snapshots: a consistent copy (VACUUM INTO, safe while KUBER runs), integrity-checked, gzipped.
// Keeps the last 14 daily copies plus the first copy of each month for 24 months.
// The folder (setting "backup.dir") can point at an external drive or any synced cloud folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import db, { log, now, getSetting, setSetting } from "./db.mjs";

export const backupDir = () => getSetting("backup.dir", path.join(os.homedir(), "KUBER Backups"));
const NAME = /^kuber-(\d{4}-\d{2}-\d{2})(?:-\d{4})?\.db\.gz$/;

export function list() {
  const dir = backupDir(); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => NAME.test(f)).sort().reverse().map(f => { const st = fs.statSync(path.join(dir, f)); return { file: f, date: f.match(NAME)[1], bytes: st.size, at: st.mtime.toISOString() }; });
}
export function status() { const l = list(); return { dir: backupDir(), last: getSetting("backup.last", null), lastError: getSetting("backup.error", null), count: l.length, bytes: l.reduce((a, x) => a + x.bytes, 0), recent: l.slice(0, 5) }; }

export function snapshot() {
  const dir = backupDir(), stamp = new Date().toISOString().slice(0, 10), hm = new Date().toTimeString().slice(0, 5).replace(":", "");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.kuber-${stamp}-${hm}.db`), out = path.join(dir, `kuber-${stamp}-${hm}.db.gz`);
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const chk = new DatabaseSync(tmp, { readOnly: true }), ok = chk.prepare("PRAGMA integrity_check").get(), rows = chk.prepare("SELECT (SELECT COUNT(*) FROM daily) AS daily, (SELECT COUNT(*) FROM ticks) AS ticks, (SELECT COUNT(*) FROM preds) AS preds, (SELECT COUNT(*) FROM orders) AS orders").get(); chk.close();
    if (Object.values(ok)[0] !== "ok") { fs.rmSync(tmp); throw new Error("integrity check failed on the snapshot: " + JSON.stringify(ok)); }
    fs.writeFileSync(out, zlib.gzipSync(fs.readFileSync(tmp), { level: 9 })); fs.rmSync(tmp);
    prune(dir);
    const size = fs.statSync(out).size;
    setSetting("backup.last", { at: now(), file: path.basename(out), bytes: size, rows: { ...rows } }); setSetting("backup.error", null);
    log("backup", `Saved ${path.basename(out)} (${(size / 1e6).toFixed(1)} MB, integrity ok: ${rows.daily} daily bars, ${rows.ticks} samples, ${rows.preds} forecasts, ${rows.orders} orders) to ${dir}`);
    return { ok: true, file: out, bytes: size, rows };
  } catch (e) { setSetting("backup.error", { at: now(), message: e.message }); log("backup", "Backup failed: " + e.message); return { ok: false, error: e.message }; }
}
function prune(dir) {
  const files = fs.readdirSync(dir).filter(f => NAME.test(f)).sort().reverse(), keep = new Set(), months = new Set();
  const days = [...new Set(files.map(f => f.match(NAME)[1]))].slice(0, 14);
  for (const f of files) { const d = f.match(NAME)[1]; if (days.includes(d) && ![...keep].some(k => k.match(NAME)[1] === d)) keep.add(f); }
  const recentMonths = [...new Set(files.map(f => f.match(NAME)[1].slice(0, 7)))].slice(0, 24);   // newest 24 months
  for (const f of [...files].reverse()) { const m = f.match(NAME)[1].slice(0, 7); if (recentMonths.includes(m) && !months.has(m)) { months.add(m); keep.add(f); } }   // first copy of each
  for (const f of files) if (!keep.has(f)) fs.rmSync(path.join(dir, f));
}
export function setDir(dir) {
  const d = path.resolve(String(dir || "").replace(/^~(?=$|\/)/, os.homedir()));
  fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK);
  setSetting("backup.dir", d); log("backup", `Backup folder set to ${d}`); return d;
}
export function due() { const l = getSetting("backup.last", null); return !l || Date.now() - Date.parse(l.at) > 20 * 3600e3; }
