// KUBER local database (SQLite, built into Node 22+). One file: data/kuber.db
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const db = new DatabaseSync(process.env.KUBER_DB || path.join(ROOT, "data", "kuber.db"));   // KUBER_DB: tests use a copy
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, date TEXT, sym TEXT, name TEXT, kind TEXT, side TEXT, qty REAL, price REAL, status TEXT, note TEXT, source TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS sims(id TEXT PRIMARY KEY, cid TEXT, end_date TEXT, status TEXT, created TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, updated TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS watch(key TEXT PRIMARY KEY, added TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS params_history(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, params TEXT, metrics TEXT, note TEXT, active INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS daily(sym TEXT, date TEXT, close REAL, volume REAL, PRIMARY KEY(sym, date));
CREATE TABLE IF NOT EXISTS ticks(sym TEXT, ts INTEGER, price REAL, PRIMARY KEY(sym, ts));
CREATE TABLE IF NOT EXISTS analyses(id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT, ts TEXT, px REAL, H INTEGER, median REAL, p05 REAL, p25 REAL, p75 REAL, p95 REAL, pUp REAL, mu REAL, vol REAL, score REAL, trigger TEXT);
CREATE INDEX IF NOT EXISTS analyses_cid ON analyses(cid, ts);
CREATE TABLE IF NOT EXISTS preds(id TEXT PRIMARY KEY, cid TEXT, kind TEXT, made TEXT, H INTEGER, target TEXT, p0 REAL, median REAL, p05 REAL, p25 REAL, p75 REAL, p95 REAL, pUp REAL, kappa REAL, params_ver INTEGER, actual REAL, actual_date TEXT, scored TEXT, pit REAL, in50 INTEGER, in90 INTEGER, dirHit INTEGER, err REAL, logErr REAL, iscore REAL);
CREATE INDEX IF NOT EXISTS preds_cid ON preds(cid, target);
CREATE TABLE IF NOT EXISTS calib(cid TEXT PRIMARY KEY, kappa_adj REAL, mu_adj REAL, n INTEGER, epochs INTEGER, accepted INTEGER, metrics TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS learn_log(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, run TEXT, cid TEXT, epoch INTEGER, n_train INTEGER, n_valid INTEGER, kappa_adj REAL, mu_adj REAL, base_score REAL, new_score REAL, accepted INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS news(id TEXT PRIMARY KEY, cid TEXT, title TEXT, url TEXT, source TEXT, published TEXT, sentiment REAL, label TEXT, relevant INTEGER, model TEXT, scored_at TEXT);
CREATE TABLE IF NOT EXISTS verify(cid TEXT PRIMARY KEY, src_date TEXT, src_close REAL, feed_close REAL, diff REAL, ok INTEGER, checked TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, msg TEXT);
CREATE TABLE IF NOT EXISTS stock_models(cid TEXT PRIMARY KEY, spec TEXT, accepted INTEGER, metrics TEXT, updated TEXT);
CREATE TABLE IF NOT EXISTS stock_model_log(id INTEGER PRIMARY KEY AUTOINCREMENT, run TEXT, cid TEXT, spec TEXT, accepted INTEGER, sel_score REAL, base_sel REAL, hold_score REAL, base_hold REAL, dm_t REAL, n_sel INTEGER, n_hold INTEGER, note TEXT);
`);
// bond market (22 Oct 2026): official end-of-day yields, live yields, India's official zero curve, analysis results
db.exec(`
CREATE TABLE IF NOT EXISTS bond_daily(series TEXT, date TEXT, y REAL, src TEXT, PRIMARY KEY(series, date));
CREATE TABLE IF NOT EXISTS bond_ticks(series TEXT, ts INTEGER, y REAL, src TEXT DEFAULT 'live', PRIMARY KEY(series, ts));
CREATE TABLE IF NOT EXISTS bond_nss(date TEXT PRIMARY KEY, b0 REAL, b1 REAL, b2 REAL, b3 REAL, t1 REAL, t2 REAL, src TEXT);
CREATE TABLE IF NOT EXISTS bond_sec(date TEXT, bucket TEXT, security TEXT, ytm REAL, PRIMARY KEY(date, bucket));
CREATE TABLE IF NOT EXISTS bond_analysis(market TEXT PRIMARY KEY, made TEXT, data TEXT, secs REAL);
CREATE TABLE IF NOT EXISTS bond_checks(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, name TEXT, ok INTEGER, detail TEXT);
`);
// adjusted close (dividends, splits) for modelling; raw close stays the exchange price; daily open/high/low for range-based volatility
// orders carry their market: IN (₹, NSE), US ($), KR (₩); everything recorded before 22 Oct 2026 is Indian
if (!db.prepare("PRAGMA table_info(orders)").all().some(c => c.name === "mk")) db.exec("ALTER TABLE orders ADD COLUMN mk TEXT NOT NULL DEFAULT 'IN'");
for (const col of ["adj", "open", "high", "low"]) if (!db.prepare("PRAGMA table_info(daily)").all().some(c => c.name === col)) db.exec(`ALTER TABLE daily ADD COLUMN ${col} REAL`);
db.exec(`
CREATE INDEX IF NOT EXISTS ticks_ts ON ticks(ts);
-- one row per stock per trading day, written at the close: realised volatility from KUBER's own intraday samples and from the day's range
CREATE TABLE IF NOT EXISTS rv(sym TEXT, date TEXT, n_ticks INTEGER, n_5m INTEGER, rv_5m REAL, rs_range REAL, overnight REAL, close REAL, model_vol REAL, first_ts INTEGER, last_ts INTEGER, PRIMARY KEY(sym, date));
-- data-quality ledger for live samples
CREATE TABLE IF NOT EXISTS dq(date TEXT, sym TEXT, accepted INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0, reasons TEXT, PRIMARY KEY(date, sym));
CREATE TABLE IF NOT EXISTS eod(sym TEXT, date TEXT, done TEXT, PRIMARY KEY(sym, date));
-- 90-trading-day outlook: one run per stock per completed close, one row per trading day ahead
CREATE TABLE IF NOT EXISTS ladder_runs(cid TEXT, made TEXT, p0 REAL, mu REAL, q REAL, vol REAL, signals TEXT, weights TEXT, kappa TEXT, spec TEXT, created TEXT, PRIMARY KEY(cid, made));
CREATE TABLE IF NOT EXISTS ladder(cid TEXT, made TEXT, h INTEGER, p0 REAL, p05 REAL, p25 REAL, p50 REAL, p75 REAL, p95 REAL, pUp REAL, actual REAL, actual_date TEXT, scored TEXT, in50 INTEGER, in90 INTEGER, qscore REAL, PRIMARY KEY(cid, made, h));
CREATE INDEX IF NOT EXISTS ladder_open ON ladder(scored, cid);
-- companies fetched on demand from the Finder (kept while on the wishlist, otherwise removed after 14 days unused)
CREATE TABLE IF NOT EXISTS catalog(key TEXT PRIMARY KEY, name TEXT, mk TEXT, tk TEXT, data TEXT, status TEXT, steps TEXT, test TEXT, fetched TEXT, viewed TEXT);
-- control arm for the 3-month trial: the standard model's outlook, logged and scored beside the tuned one
CREATE TABLE IF NOT EXISTS ladder_base(cid TEXT, made TEXT, h INTEGER, p0 REAL, p05 REAL, p25 REAL, p50 REAL, p75 REAL, p95 REAL, pUp REAL, actual REAL, actual_date TEXT, scored TEXT, in50 INTEGER, in90 INTEGER, qscore REAL, PRIMARY KEY(cid, made, h));
CREATE INDEX IF NOT EXISTS ladder_base_open ON ladder_base(scored, cid);
-- health alerts
CREATE TABLE IF NOT EXISTS alerts(key TEXT PRIMARY KEY, level TEXT, msg TEXT, first TEXT, last TEXT, notified TEXT, resolved TEXT);
-- official exchange closes (NSE bhavcopy); they take precedence over the data provider's daily history
CREATE TABLE IF NOT EXISTS official_close(sym TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, last REAL, source TEXT, fetched TEXT, PRIMARY KEY(sym, date));
CREATE TABLE IF NOT EXISTS ladder_calib(cid TEXT PRIMARY KEY, kappa TEXT, weights TEXT, metrics TEXT, updated TEXT);
`);

export const now = () => new Date().toISOString();
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export function tx(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } }
export function log(kind, msg) { run("INSERT INTO events(ts, kind, msg) VALUES(?,?,?)", now(), kind, String(msg).slice(0, 2000)); }
export function getSetting(key, dflt = null) { const r = get("SELECT value FROM settings WHERE key=?", key); return r ? JSON.parse(r.value) : dflt; }
export function setSetting(key, v) { run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(v)); }

// first run: import an initial order history if data/orders_seed.json exists ([date, sym, name, kind, side, qty, price, status], one row per order)
if (!get("SELECT 1 AS x FROM orders LIMIT 1") && fs.existsSync(path.join(ROOT, "data", "orders_seed.json"))) {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "orders_seed.json"), "utf8"));
  tx(() => seed.forEach((r, i) => run("INSERT INTO orders(id,date,sym,name,kind,side,qty,price,status,note,source,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", "seed" + String(i).padStart(3, "0"), r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], "order history import", now())));
  log("init", `Imported ${seed.length} orders from data/orders_seed.json`);
}
export default db;
