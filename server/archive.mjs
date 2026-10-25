// Storage tiers. Hot: the last 12 months of intraday samples stay in data/kuber.db (fast, used by the app).
// Cold: older months are written to archive/ticks-YYYY-MM.csv.gz, verified by reading them back, then removed from the
// database. When the Supabase backup is connected, archive files are uploaded to its storage bucket "kuber-archive"
// and, once confirmed uploaded, can be dropped from this Mac (setting archive.keepLocal = false).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { ROOT, all, get, run, tx, log, now, getSetting } from "./db.mjs";

const DIR = path.join(ROOT, "archive");
run(`CREATE TABLE IF NOT EXISTS archive_files(name TEXT PRIMARY KEY, month TEXT, rows INTEGER, bytes INTEGER, sha256 TEXT, created TEXT, uploaded TEXT)`);
const monthOf = ts => new Date(ts * 1000).toISOString().slice(0, 7);
const readFile = f => zlib.gunzipSync(fs.readFileSync(f)).toString("utf8").trim().split("\n").slice(1).filter(Boolean).map(l => { const [sym, ts, price] = l.split(","); return { sym, ts: +ts, price: +price }; });

export function archiveOld(hotMonths = getSetting("archive.hotMonths", 12)) {
  const cutTs = Math.floor(new Date(new Date().getUTCFullYear(), new Date().getUTCMonth() - hotMonths, 1).getTime() / 1000);
  const months = all("SELECT DISTINCT strftime('%Y-%m', ts, 'unixepoch') AS m FROM ticks WHERE ts < ?", cutTs).map(r => r.m).sort();
  let total = 0;
  for (const m of months) {
    fs.mkdirSync(DIR, { recursive: true });
    const t0 = Math.floor(Date.parse(m + "-01T00:00:00Z") / 1000), t1 = Math.min(cutTs, Math.floor(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1) / 1000));
    const rows = all("SELECT sym, ts, price FROM ticks WHERE ts >= ? AND ts < ? ORDER BY sym, ts", t0, t1); if (!rows.length) continue;
    const name = `ticks-${m}.csv.gz`, file = path.join(DIR, name);
    const prior = fs.existsSync(file) ? readFile(file) : [], seen = new Set(prior.map(r => r.sym + "|" + r.ts)), merged = [...prior, ...rows.filter(r => !seen.has(r.sym + "|" + r.ts))].sort((a, b) => a.sym.localeCompare(b.sym) || a.ts - b.ts);
    const buf = zlib.gzipSync("sym,ts,price\n" + merged.map(r => `${r.sym},${r.ts},${r.price}`).join("\n") + "\n", { level: 9 }), tmp = file + ".tmp";
    fs.writeFileSync(tmp, buf);
    const check = readFile(tmp); if (check.length !== merged.length) { fs.rmSync(tmp); throw new Error(`archive check failed for ${m}`); }
    fs.renameSync(tmp, file);
    tx(() => { run("DELETE FROM ticks WHERE ts >= ? AND ts < ?", t0, t1); run("INSERT INTO archive_files(name,month,rows,bytes,sha256,created,uploaded) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(name) DO UPDATE SET rows=excluded.rows, bytes=excluded.bytes, sha256=excluded.sha256, created=excluded.created, uploaded=NULL", name, m, merged.length, buf.length, crypto.createHash("sha256").update(buf).digest("hex"), now()); });
    total += rows.length;
  }
  if (total) log("archive", `Moved ${total.toLocaleString()} intraday samples older than ${hotMonths} months to archive files (${months.join(", ")})`);
  return total;
}
// samples for a period, from the database and, if needed, the archive files (used when replaying old intraday data)
export function ticksBetween(sym, t0, t1) {
  const out = all("SELECT ts, price FROM ticks WHERE sym=? AND ts>=? AND ts<? ORDER BY ts", sym, t0, t1);
  for (let m = monthOf(t0); m <= monthOf(t1 - 1); m = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString().slice(0, 7)) {
    const f = path.join(DIR, `ticks-${m}.csv.gz`); if (fs.existsSync(f)) for (const r of readFile(f)) if (r.sym === sym && r.ts >= t0 && r.ts < t1) out.push({ ts: r.ts, price: r.price });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
// upload archive files to the Supabase storage bucket (only when the cloud backup is configured)
export async function upload(cloud) {
  if (!cloud?.enabled || !cloud.url || !cloud.key) return 0; let n = 0;
  for (const f of all("SELECT * FROM archive_files WHERE uploaded IS NULL")) {
    const file = path.join(DIR, f.name); if (!fs.existsSync(file)) continue;
    const r = await fetch(`${cloud.url}/storage/v1/object/kuber-archive/${f.name}`, { method: "POST", headers: { apikey: cloud.key, authorization: "Bearer " + cloud.key, "content-type": "application/gzip", "x-upsert": "true" }, body: fs.readFileSync(file), signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`archive upload ${f.name}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    run("UPDATE archive_files SET uploaded=? WHERE name=?", now(), f.name); n++;
    if (getSetting("archive.keepLocal", true) === false) fs.rmSync(file);
  }
  if (n) log("archive", `Uploaded ${n} archive file${n > 1 ? "s" : ""} to Supabase storage`);
  return n;
}
export function summary() { const r = get("SELECT COUNT(*) AS files, COALESCE(SUM(rows),0) AS rows, COALESCE(SUM(bytes),0) AS bytes, SUM(uploaded IS NOT NULL) AS uploaded FROM archive_files"); return { ...r, hotMonths: getSetting("archive.hotMonths", 12), dir: DIR }; }
