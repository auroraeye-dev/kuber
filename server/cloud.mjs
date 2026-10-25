// Optional off-Mac backup to your own Supabase project (Postgres via its REST API).
// Local SQLite stays the primary store; this only copies rows up (upserts), never deletes anything locally.
// Set up: create a Supabase project, run data/supabase_schema.sql in its SQL editor, then paste the project URL and
// the service-role key on System → Cloud backup. The key is stored only in data/kuber.db on this Mac.
import { all, get, log, now, getSetting, setSetting } from "./db.mjs";

const TABLES = {
  daily: { pk: "sym,date", cols: ["sym", "date", "open", "high", "low", "close", "adj", "volume"] },
  ticks: { pk: "sym,ts", cols: ["sym", "ts", "price"] },
  rv: { pk: "sym,date", cols: ["sym", "date", "n_ticks", "n_5m", "rv_5m", "rs_range", "overnight", "close", "model_vol"] },
  preds: { pk: "id", cols: ["id", "cid", "kind", "made", "H", "target", "p0", "median", "p05", "p25", "p75", "p95", "pUp", "kappa", "params_ver", "actual", "actual_date", "scored", "pit", "in50", "in90", "dirHit", "err", "logErr", "iscore"] },
  analyses: { pk: "id", cols: ["id", "cid", "ts", "px", "H", "median", "p05", "p25", "p75", "p95", "pUp", "mu", "vol", "score", "trigger"] },
  orders: { pk: "id", cols: ["id", "date", "sym", "mk", "name", "kind", "side", "qty", "price", "status", "note", "source", "created"] },
  sims: { pk: "id", cols: ["id", "cid", "end_date", "status", "created", "data"] },
  notes: { pk: "id", cols: ["id", "updated", "data"] },
  stock_models: { pk: "cid", cols: ["cid", "spec", "accepted", "metrics", "updated"] },
  calib: { pk: "cid", cols: ["cid", "kappa_adj", "mu_adj", "n", "epochs", "accepted", "metrics", "updated"] },
  ladder_runs: { pk: "cid,made", cols: ["cid", "made", "p0", "mu", "q", "vol", "signals", "weights", "kappa", "spec", "created"] },
  ladder: { pk: "cid,made,h", cols: ["cid", "made", "h", "p0", "p05", "p25", "p50", "p75", "p95", "pUp", "actual", "actual_date", "scored", "in50", "in90", "qscore"] },
  bond_daily: { pk: "series,date", cols: ["series", "date", "y", "src"] },
  bond_nss: { pk: "date", cols: ["date", "b0", "b1", "b2", "b3", "t1", "t2", "src"] },
  bond_sec: { pk: "date,bucket", cols: ["date", "bucket", "security", "ytm"] }
};
import { execFileSync } from "node:child_process";
// the service-role key lives in the macOS login Keychain (item "KUBER Supabase"), never in the database or its backups
const KC = ["-s", "KUBER Supabase", "-a", "service_role"];
function keyGet() { try { return execFileSync("/usr/bin/security", ["find-generic-password", ...KC, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; } }
function keySet(k) { execFileSync("/usr/bin/security", ["add-generic-password", "-U", ...KC, "-w", k], { stdio: "ignore" }); }
let keyCache = null;
const cfg = () => { const c = getSetting("cloud", null); if (!c) return null; if (c.key) { keySet(c.key); const { key, ...rest } = c; setSetting("cloud", rest); keyCache = key; log("cloud", "Moved the Supabase key into the macOS Keychain"); return { ...rest, key }; } return { ...c, key: keyCache ??= keyGet() }; };
export function cloudConfig() { return cfg(); }
export function status() { const c = getSetting("cloud", null); return c ? { configured: true, enabled: !!c.enabled, url: c.url, lastSync: c.lastSync || null, lastError: c.lastError || null, pushed: c.pushed || {} } : { configured: false }; }

async function req(c, method, pathq, body) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(c.url.replace(/\/$/, "") + "/rest/v1/" + pathq, { method, signal: AbortSignal.timeout(600000),
        headers: { apikey: c.key, authorization: "Bearer " + c.key, "content-type": "application/json", ...(method === "POST" && !pathq.startsWith("rpc/") ? { prefer: "resolution=merge-duplicates,return=minimal" } : method === "PATCH" ? { prefer: "return=minimal" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`Supabase ${method} ${pathq.split("?")[0]}: HTTP ${r.status} ${t.slice(0, 200)}`); }
      return r;
    } catch (e) {
      if (attempt < MAX_RETRIES && (e.message.includes("timeout") || e.message.includes("fetch"))) {
        const delay = Math.pow(2, attempt) * 5000;
        log("cloud", `Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms: ${e.message.slice(0, 60)}`);
        await new Promise(r => setTimeout(r, delay));
      } else throw e;
    }
  }
}
export async function configure({ url, key, enabled = true }) {
  const old = cfg() || {};   // includes the key from the Keychain
  if (enabled === false && !url) { if (old.url) { const { key: _k, ...rest } = old; setSetting("cloud", { ...rest, enabled: false }); } return status(); }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url || "")) return { ...status(), error: "The project URL should look like https://abcdefgh.supabase.co" };
  const c = { ...old, url: url.replace(/\/$/, ""), key: key || old.key, enabled: true };
  if (!c.key) return { ...status(), error: "Paste the project's service-role key." };
  try { await req(c, "GET", "kuber_daily?select=sym&limit=1"); }
  catch (e) { return { ...status(), error: /42P01|does not exist|404/.test(e.message) ? "Connected, but the KUBER tables don't exist yet. Run data/supabase_schema.sql in the Supabase SQL editor first." : e.message }; }
  keySet(c.key); keyCache = c.key; const { key: _k, ...rest } = c; setSetting("cloud", rest); log("cloud", `Cloud backup connected to ${c.url} (key stored in the macOS Keychain)`); return status();
}

let running = null;
export function sync(force) { if (!running) running = doSync(force).finally(() => { running = null; }); return running; }
async function doSync(force) {
  const c = cfg(); if (!c || !c.enabled) return { skipped: "cloud backup not set up" };
  const wm = c.wm || {}, pushed = {}, t0 = Date.now();
  const push = async (name, rows) => {
    const T = TABLES[name];
    let cols = T.cols;
    for (let i = 0; i < rows.length; i += 1000) {
      const send = () => req(c, "POST", `kuber_${name}?on_conflict=${T.pk}`, rows.slice(i, i + 1000).map(r => Object.fromEntries(cols.map(k => [k, r[k] ?? null]))));
      // the order market column (added 22 Oct 2026) exists in Supabase only after supabase_collector.sql is re-run; back up the rest until then
      try { await send(); } catch (e) { if (name !== "orders" || !/\bmk\b/.test(e.message) || cols !== T.cols) throw e; cols = T.cols.filter(k => k !== "mk"); log("cloud", "Supabase has no orders.mk column yet: re-run data/supabase_collector.sql; backing up orders without it"); await send(); }
    }
    pushed[name] = (pushed[name] || 0) + rows.length;
  };
  try {
    // append-only or watermark-able tables
    for (;;) { const rows = all("SELECT sym, ts, price FROM ticks WHERE ts > ? ORDER BY ts LIMIT 20000", wm.ticks || 0); if (!rows.length) break; await push("ticks", rows); wm.ticks = rows[rows.length - 1].ts; if (rows.length < 20000) break; }
    for (;;) { const rows = all("SELECT * FROM analyses WHERE id > ? ORDER BY id LIMIT 20000", wm.analyses || 0); if (!rows.length) break; await push("analyses", rows); wm.analyses = rows[rows.length - 1].id; if (rows.length < 20000) break; }
    // daily bars: everything once, then the last 45 days (the provider re-adjusts recent history)
    const since = wm.daily && !force ? new Date(Date.parse(wm.daily) - 45 * 864e5).toISOString().slice(0, 10) : "0000";
    await push("daily", all("SELECT * FROM daily WHERE date >= ?", since)); wm.daily = get("SELECT MAX(date) AS d FROM daily").d;
    await push("rv", all("SELECT * FROM rv WHERE date >= ?", since));
    // small tables: full upsert
    for (const t of ["preds", "orders", "sims", "notes", "stock_models", "calib"]) await push(t, all(`SELECT * FROM ${t}`));
    await push("ladder_runs", all("SELECT * FROM ladder_runs WHERE made >= ?", since === "0000" ? "0000" : new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10)));
    await push("ladder", all("SELECT * FROM ladder WHERE made >= ?", since === "0000" ? "0000" : new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10)));
    // bond tables: everything once, then the last 60 days. They exist in Supabase only after supabase_collector.sql
    // (23 Oct 2026) is run; until then they are skipped without failing the rest of the backup.
    try {
      const bs = wm.bonds ? new Date(Date.parse(wm.bonds) - 60 * 864e5).toISOString().slice(0, 10) : "0000";
      await push("bond_daily", all("SELECT series, date, y, src FROM bond_daily WHERE date >= ?", bs)); await push("bond_nss", all("SELECT * FROM bond_nss WHERE date >= ?", bs)); await push("bond_sec", all("SELECT * FROM bond_sec WHERE date >= ?", bs));
      wm.bonds = get("SELECT MAX(date) AS d FROM bond_daily WHERE date <= ?", new Date().toISOString().slice(0, 10))?.d || wm.bonds; wm.bondError = null;
    } catch (e) { if (wm.bondError !== e.message.slice(0, 80)) log("cloud", "Bond tables not backed up (run data/supabase_collector.sql in Supabase): " + e.message.slice(0, 160)); wm.bondError = e.message.slice(0, 80); }
    setSetting("cloud", { ...getSetting("cloud"), wm, lastSync: now(), lastError: null, pushed });
    log("cloud", `Backed up to Supabase in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${Object.entries(pushed).map(([k, v]) => `${v} ${k}`).join(", ")}`);
    return { ok: true, pushed };
  } catch (e) {
    setSetting("cloud", { ...getSetting("cloud"), wm, lastError: e.message, lastErrorAt: now() }); log("cloud", e.message); return { ok: false, error: e.message, pushed };
  }
}

// ── cloud collector (data/supabase_collector.sql): the cloud records prices while the Mac is asleep or off ──
// The Mac keeps the cloud's stock list current and, on every start, wake and maintenance run, pulls in every
// price the cloud has that the Mac does not. Both read the same source quote (same timestamp), so duplicates
// collapse on the (sym, ts) key.
import { run as dbRun, tx as dbTx } from "./db.mjs";
async function getJSON(c, pathq) { const r = await req(c, "GET", pathq); return r.json(); }
export async function collectorAvailable() {
  const c = cfg(); if (!c?.enabled || !c.key) return false;
  try { await getJSON(c, "kuber_cloud_symbols?select=sym&limit=1"); return true; } catch { return false; }
}
// stocks the cloud should record: [{sym, path, mk}]
export async function pushSymbols(list) {
  const c = cfg(); if (!c?.enabled || !c.key) return { skipped: true };
  const rows = list.map(x => ({ sym: x.sym, path: x.path, mk: x.mk, active: true, updated: now() }));
  await req(c, "POST", "kuber_cloud_symbols?on_conflict=sym", rows);
  const keep = new Set(rows.map(r => r.sym)), cur = await getJSON(c, "kuber_cloud_symbols?select=sym,active");
  const stale = cur.filter(r => r.active && !keep.has(r.sym)).map(r => r.sym);
  if (stale.length) await req(c, "PATCH", `kuber_cloud_symbols?sym=in.(${stale.map(encodeURIComponent).join(",")})`, { active: false });
  return { active: rows.length, deactivated: stale.length };
}
// pull cloud prices newer than the watermark (with a 6-hour overlap) into the local ticks table
export async function pullTicks() {
  const c = cfg(); if (!c?.enabled || !c.key) return { skipped: true };
  const wm = getSetting("cloud.ticksWm", 0), from = Math.max(0, wm - 6 * 3600); let added = 0, seen = 0, bonds = 0, maxTs = wm; const touched = new Map();
  // Supabase returns at most 1,000 rows per request whatever limit is asked (23 Oct 2026: a pull stopped after the first
  // 1,000 and missed a whole Korean morning), so keep paging until a page comes back empty
  for (let off = 0; ; ) {
    const rows = await getJSON(c, `kuber_cloud_ticks?select=sym,ts,price&ts=gt.${from}&order=ts.asc,sym.asc&offset=${off}&limit=1000`);
    if (!rows.length) break; seen += rows.length; off += rows.length;
    // bond yields recorded by the cloud arrive as sym "B:<series>" and go to the bond table, not the stock prices
    dbTx(() => { for (const r of rows) { if (r.sym.startsWith("B:")) { bonds += dbRun("INSERT OR IGNORE INTO bond_ticks(series,ts,y,src) VALUES(?,?,?,?)", r.sym.slice(2), r.ts, r.price, "cloud").changes; if (r.ts > maxTs) maxTs = r.ts; continue; } const ch = dbRun("INSERT OR IGNORE INTO ticks(sym,ts,price) VALUES(?,?,?)", r.sym, r.ts, r.price).changes; if (ch) { added++; const day = new Date(r.ts * 1000).toISOString().slice(0, 10); touched.set(r.sym + "|" + day, { sym: r.sym, ts: r.ts }); } if (r.ts > maxTs) maxTs = r.ts; } });
  }
  setSetting("cloud.ticksWm", maxTs);
  if (added) log("cloud", `Pulled ${added} prices from the cloud collector that the Mac missed (${touched.size} stock-days)`);
  if (bonds) log("cloud", `Pulled ${bonds} bond yields from the cloud collector that the Mac missed`);
  setSetting("cloud.lastPull", { at: now(), added, seen, bonds });
  return { added, seen, bonds, touched: [...touched.values()] };
}
// official pages the cloud saved (CCIL, RBI) that the Mac hasn't read yet, oldest first
export async function pullPages() {
  const c = cfg(); if (!c?.enabled || !c.key) return [];
  let cursor = getSetting("cloud.pagesWm", "1970-01-01T00:00:00Z"); const out = [];
  for (let k = 0; k < 50; k++) { const rows = await getJSON(c, `kuber_cloud_pages?select=name,at,status,content&at=gt.${encodeURIComponent(cursor)}&order=at.asc&limit=10`); if (!rows.length) break; out.push(...rows); cursor = rows[rows.length - 1].at; if (rows.length < 10) break; }
  return out;   // the caller marks them read (pagesRead) once they are stored
}
export function pagesRead(at) { setSetting("cloud.pagesWm", at); }
export async function collectorStatus() {
  const c = cfg(); if (!c?.enabled || !c.key) return null;
  try { const [last] = await getJSON(c, "kuber_cloud_log?select=at,stored,failed,requested&order=at.desc&limit=1"), [cnt] = await getJSON(c, "kuber_cloud_symbols?select=count&active=is.true"); return { lastRun: last?.at || null, stored: last?.stored ?? null, failed: last?.failed ?? null, requested: last?.requested ?? null, symbols: cnt?.count ?? null, lastPull: getSetting("cloud.lastPull", null) }; }
  catch (e) { return { error: e.message, lastPull: getSetting("cloud.lastPull", null) }; }
}
// one-off check that the source answers requests made from the cloud
export async function probe() {
  const c = cfg(); if (!c?.enabled || !c.key) throw new Error("cloud not connected");
  const n = await (await req(c, "POST", "rpc/kuber_cloud_probe", {})).json();
  await new Promise(r => setTimeout(r, 12000));
  return { requested: n, results: await (await req(c, "POST", "rpc/kuber_cloud_probe_result", {})).json() };
}
