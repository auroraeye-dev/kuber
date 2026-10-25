// Finder: search every listed company, fetch a company's data only when you pick it, check it, test the model on it.
// Data for companies you only looked at is removed after 14 days unused; wishlist companies are kept and tracked live.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { ROOT, all, get, run, log, now, tx } from "./db.mjs";
import { STATE, company, uniToCompany, heldIds } from "./companies.mjs";
import { syncDaily, quote, feedSymbol, dailySeries } from "./market.mjs";
const Q = createRequire(import.meta.url)("../web/model.js");

// ── search ───────────────────────────────────────────────────────────────
// local names (instant, offline) + the data provider's live search (every NSE, NYSE/Nasdaq and KRX stock)
let names = null;
function localNames() {
  if (!names) { names = Object.entries(STATE.universe?.items || {}).map(([k, u]) => ({ key: k, name: u.n })); for (const c of Object.values(STATE.base)) names.push({ key: c.mk + ":" + c.tk, name: c.nm, id: c.id }); }
  return names;
}
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
function curlJSON(url) { return new Promise((res, rej) => { const p = spawn("curl", ["-s", "-m", "12", "-A", UA, "-H", "Accept: application/json", url]); let o = ""; p.stdout.on("data", d => o += d); p.on("close", () => { try { res(JSON.parse(o)); } catch (e) { rej(new Error("search unavailable")); } }); }); }
export async function search(q) {
  q = String(q || "").trim(); if (q.length < 1) return [];
  const lq = q.toLowerCase(), out = new Map();
  for (const n of localNames()) if (n.key.toLowerCase().split(":")[1].startsWith(lq) || n.name.toLowerCase().includes(lq)) out.set(n.key, { key: n.key, name: n.name });
  if (q.length >= 2) {
    try {
      const j = await curlJSON("https://stockanalysis.com/api/search?q=" + encodeURIComponent(q));
      for (const x of j.data || j || []) {
        let key = null;
        if (x.t === "s") key = "US:" + x.s.toUpperCase();
        else if (x.t === "sy" && x.st === "s" && /^nse\//i.test(x.s)) key = "IN:" + x.s.split("/")[1].toUpperCase();
        else if (x.t === "sy" && x.st === "s" && /^krx\//i.test(x.s)) key = "KR:" + x.s.split("/")[1].toUpperCase();
        if (key && !out.has(key)) out.set(key, { key, name: x.n });
      }
    } catch { /* local results only */ }
  }
  const watch = new Set(all("SELECT key FROM watch").map(r => r.key)), cat = new Map(all("SELECT key, status, fetched FROM catalog").map(r => [r.key, r]));
  return [...out.values()].slice(0, 40).map(r => {
    const base = Object.values(STATE.base).find(c => c.mk + ":" + c.tk === r.key);
    return { ...r, mk: r.key.split(":")[0], tk: r.key.split(":")[1], id: base ? base.id : r.key, core: !!base, watch: watch.has(r.key), cached: cat.get(r.key)?.status === "ready", fetched: cat.get(r.key)?.fetched || null };
  });
}

// ── fetch, check and test one company ─────────────────────────────────────
const jobs = new Map();
export function status(key) { const r = get("SELECT key, name, status, steps, test, fetched FROM catalog WHERE key=?", key); return r ? { ...r, steps: JSON.parse(r.steps || "[]"), test: r.test ? JSON.parse(r.test) : null } : null; }
export function ensure(key, name) {
  if (!/^(IN|US|KR):[A-Z0-9][A-Z0-9.&_-]{0,19}$/.test(String(key))) return Promise.reject(new Error("not a valid stock key"));
  const r = get("SELECT status FROM catalog WHERE key=?", key);
  if (r?.status === "ready") { run("UPDATE catalog SET viewed=? WHERE key=?", now(), key); return Promise.resolve(status(key)); }
  if (!jobs.has(key)) jobs.set(key, fetchOne(key, name).finally(() => jobs.delete(key)));
  return jobs.get(key);
}
function fundamentals(mk, tk) {
  const py = fs.existsSync(path.join(ROOT, ".venv/bin/python")) ? path.join(ROOT, ".venv/bin/python") : "python3";
  return new Promise((res, rej) => { const p = spawn(py, ["pipeline/fetch.py", "one", mk, tk], { cwd: ROOT }); let o = "", e = ""; p.stdout.on("data", d => o += d); p.stderr.on("data", d => e += d); p.on("close", code => { try { const j = JSON.parse(o.trim().split("\n").pop() || "null"); j ? res(j) : rej(new Error("the source has no data for this company")); } catch { rej(new Error(e.slice(-300) || "fetch failed")); } }); });
}
async function fetchOne(key, name) {
  const [mk, tk] = key.split(":"); if (!["IN", "US", "KR"].includes(mk) || !/^[A-Z0-9][A-Z0-9.&_-]{0,19}$/.test(tk || "")) throw new Error("Only NSE, NYSE/Nasdaq and KRX stock tickers are supported");
  const steps = [], step = (t, ok, detail) => { steps.push({ t, ok, detail, at: now() }); run("UPDATE catalog SET steps=? WHERE key=?", JSON.stringify(steps), key); };
  run("INSERT INTO catalog(key,name,mk,tk,status,steps,viewed) VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status='fetching', steps='[]', viewed=excluded.viewed", key, name || tk, mk, tk, "fetching", "[]", now());
  try {
    // 1 fundamentals from the filings site (screener.in for India, stockanalysis.com otherwise)
    const d = await fundamentals(mk, tk);
    run("UPDATE catalog SET name=?, data=? WHERE key=?", d.n || name || tk, JSON.stringify(d), key);
    const B = d.built || {}, extras = [B.shp && "shareholding", B.cfo?.v?.length && "cash flow", B.bvpsH?.v?.length && "book value history", B.news?.length && `${B.news.length} filings/news`, B.docs?.length && `${B.docs.length} documents`, (B.fpos?.length || B.fneg?.length) && "data flags", B.profile?.ceo && "company profile"].filter(Boolean);
    step("Fundamentals", true, `${mk === "IN" ? "screener.in" : "stockanalysis.com"}: price ${d.px}, P/E ${d.pe ?? "n/a"}, ${d.fin?.y?.length || 0} years of financials${extras.length ? "; " + extras.join(", ") : ""}${d.buildError ? " (full detail failed: " + d.buildError + ")" : ""}`);
    // 2 five years of daily prices (with open/high/low and adjusted closes)
    const stub = { id: key, mk, tk }, h = await syncDaily(stub, "5Y"), rows = dailySeries(feedSymbol(stub));
    if (rows.length < 5) throw new Error(`only ${rows.length} days of price history`);
    step("Price history", true, `${rows.length.toLocaleString()} trading days from ${rows[0].date} (${h.provider})`);
    // 3 cross-check: the filings site's price vs the exchange feed's latest close
    const last = rows[rows.length - 1], diff = d.px ? last.close / d.px - 1 : null;
    step("Price check", diff != null && Math.abs(diff) <= 0.03, diff == null ? "no second price to compare" : `exchange feed ${last.close} on ${last.date} vs ${mk === "IN" ? "screener.in" : "filings page"} ${d.px} (${(diff * 100).toFixed(2)}%${Math.abs(diff) <= 0.03 ? ", within 3%: same day or one session apart" : ", check: may be a corporate action or a stale page"})`);
    run("UPDATE catalog SET status='ready', fetched=? WHERE key=?", now(), key);
    // 4 test the model on this company's own history: walk-forward, point in time
    const c = company(key, { live: false });
    const bt = Q.backtest([c], { paths: 800, step: 6, horizons: [4, 13, 26] }), S = bt.sum;
    const test = S ? { n: S.n, in90: S.in90, in50: S.in50, dir: S.dir, medErr: S.medErr, weeks: c.wk.length, corpActions: c.corpActions?.length || 0 } : null;
    run("UPDATE catalog SET test=? WHERE key=?", JSON.stringify(test), key);
    step("Model test", !S || Math.abs(S.in90 - 0.9) <= 0.1, S ? `${S.n} past forecasts replayed: ${(S.in90 * 100).toFixed(0)}% inside the 90% range, ${(S.in50 * 100).toFixed(0)}% inside 50%, direction right ${(S.dir * 100).toFixed(0)}%` : `newly listed (${rows.length} trading days): prices, fundamentals and live tracking work now; forecasts start once it has about 30 weeks of trading, and model tests after about 70`);
    log("finder", `Fetched and tested ${key} (${d.n})`);
    return status(key);
  } catch (e) {
    step("Stopped", false, e.message); run("UPDATE catalog SET status='failed' WHERE key=?", key); log("finder", `${key}: ${e.message}`); throw e;
  }
}
// companies you only looked at: drop their data after 14 days unused (wishlist and holdings are kept)
export function evict(days = 14) {
  const cut = new Date(Date.now() - days * 864e5).toISOString(), watch = new Set(all("SELECT key FROM watch").map(r => r.key));
  const held = heldIds();
  const old = all("SELECT key, mk, tk FROM catalog WHERE COALESCE(viewed, fetched, '') < ?", cut).filter(r => !watch.has(r.key) && !held.has(r.key));
  tx(() => { for (const r of old) { const sym = feedSymbol({ id: r.key, mk: r.mk, tk: r.tk }); run("DELETE FROM daily WHERE sym=?", sym); run("DELETE FROM ticks WHERE sym=?", sym); run("DELETE FROM catalog WHERE key=?", r.key); } });
  if (old.length) log("finder", `Removed data for ${old.length} looked-up compan${old.length > 1 ? "ies" : "y"} not used for ${days} days`);
}
