// Builds the in-memory company objects the model runs on:
// fundamentals (filings-based snapshot) + weekly price history (exchange feed, stored in SQLite) + live price.
import fs from "node:fs";
import path from "node:path";
import { ROOT, all, get } from "./db.mjs";
import { feedSymbol, dailySeries, weekly, verify, adjustedDaily, tradingToday } from "./market.mjs";
export { tradingToday };

const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
export const STATE = { base: {}, asof: {}, claims: null, universe: null, live: {} };

export function loadBase() {
  const j = read("companies.json");
  STATE.asof = j.asof; STATE.base = {}; try { STATE.refreshedAt = fs.statSync(path.join(ROOT, "data", "companies.json")).mtime.toISOString(); } catch {}
  for (const c of j.companies) STATE.base[c.id] = c;
  try { STATE.claims = read("claims.json"); } catch { STATE.claims = { V: {}, SRC: {}, SRCNAME: {} }; }
  try { STATE.universe = read("universe_slim.json"); } catch { STATE.universe = { items: {} }; }
}
// a Finder company: data fetched on demand (catalog table), never the bulk universe file
export function uniToCompany(key) {
  const row = get("SELECT data, fetched FROM catalog WHERE key=? AND status='ready'", key); if (!row) return null;
  const u = JSON.parse(row.data), [mk, tk] = key.split(":"), num = x => x == null || x === "" ? null : +x;
  // full download (same builder as the starting companies)
  if (u.built) return { ...u.built, id: key, tk, mk, universe: true, onDemand: true, fetched: row.fetched, asof: "fundamentals fetched " + (row.fetched || "").slice(0, 10), cyc: false, hold: undefined };
  // financial years oldest → newest, TTM last (the US/KRX source lists newest first)
  if (u.fin?.y?.length > 1) { const yr = l => /TTM/i.test(l) ? 9999 : +((l.match(/\d{4}/) || [0])[0]); if (yr(u.fin.y[0]) > yr(u.fin.y[u.fin.y.length - 1])) for (const k of Object.keys(u.fin)) if (Array.isArray(u.fin[k])) u.fin[k] = u.fin[k].slice().reverse(); }
  for (const k of ["px", "chg", "pe", "fpe", "pb", "bv", "dy", "roe", "roce", "roic", "de", "npm", "beta", "tgt", "hi", "lo"]) u[k] = num(u[k]);
  const wd = u.wd || [], cur = mk === "IN" ? "₹" : mk === "KR" ? "₩" : "$";
  return { id: key, nm: u.n, tk, ex: mk === "IN" ? "NSE" : mk === "KR" ? "KRX" : "US", mk, cur, src: u.src, sector: u.sec, px: u.px, chg: u.chg ?? null, asof: "fundamentals fetched " + (row.fetched || "").slice(0, 10),
    mcap: u.mcap, mcapUSD: u.mcapN, pe: u.pe, fpe: u.fpe, pb: u.pb ?? (u.bv ? u.px / u.bv : null), bv: u.bv ?? (u.pb ? u.px / u.pb : null), roe: u.roe, roce: u.roce, roic: u.roic, de: u.de, dy: u.dy || 0, npm: u.npm, beta: u.beta, tgt: u.tgt, cons: u.cons, about: u.about,
    fyEndMonth: mk === "IN" ? 3 : 12, hi: u.hi, lo: u.lo, fin: { ...(u.fin || { y: [] }), u: mk === "IN" ? "₹ Cr" : mk === "KR" ? "₩ B" : "$ B", d: mk === "IN" ? 1 : 1000 }, shares: u.shares, finScale: mk === "IN" ? 1e7 : 1e6,
    wd, wk: u.wk || [], universe: true, onDemand: true, fetched: row.fetched, news: [], docs: [{ t: "Source data", u: u.src }] };
}
// wishlist = starting companies you haven't removed + companies added from the Finder (holdings are always tracked)
// the company an order belongs to: a starting company of that market (e.g. RELIANCE, MSFT) or a Finder key (IN:XYZ, US:XYZ)
export function orderCid(mk, sym) {
  mk = mk || "IN"; const b = Object.values(STATE.base).find(c => c.tk === sym && (mk === "US" ? c.mk === "US" || c.mk === "TW" : c.mk === mk));
  return b ? b.id : mk + ":" + sym;
}
// company ids you hold (executed buys minus sells)
export function heldIds() { const q = {}; for (const o of all("SELECT sym, mk, side, qty FROM orders WHERE status='executed'")) { const id = orderCid(o.mk, o.sym); q[id] = (q[id] || 0) + (o.side === "Buy" ? o.qty : -o.qty); } return new Set(Object.keys(q).filter(k => q[k] > 1e-9)); }
export function trackedIds() {
  const hidden = new Set(JSON.parse(get("SELECT value FROM settings WHERE key='hidden'")?.value || "[]")), held = heldIds();
  // holdings that aren't starting companies are tracked under their market key (data downloaded on demand)
  const heldExtra = [...held].filter(id => !STATE.base[id]).filter(k => get("SELECT 1 AS x FROM catalog WHERE key=? AND status='ready'", k));
  return [...new Set([...Object.keys(STATE.base).filter(id => !hidden.has(id) || held.has(id)), ...all("SELECT key FROM watch").map(r => r.key).filter(k => !STATE.base[k]), ...heldExtra])];
}

// assemble one company: snapshot + feed history + live quote
// opts.live = false → only completed daily closes (for logging and scoring forecasts)
export function company(id, opts = {}) {
  const b = STATE.base[id] || uniToCompany(id); if (!b) return null;
  const c = { ...b, srcSnapshot: { px: b.px, wd: b.wd?.[b.wd.length - 1] } };
  const sym = feedSymbol(c); c.feedSym = sym;
  let rows = dailySeries(sym);
  // completed closes only: drop today's row while the exchange is still trading (the provider updates it live)
  if (opts.live === false && rows.length && rows[rows.length - 1].date === tradingToday(b.mk)) rows = rows.slice(0, -1);
  if (rows.length > 60 || (rows.length >= 5 && b.onDemand)) {   // new listings: use whatever daily history exists
    const w = weekly(rows); c.wd = w.wd; c.wk = w.wk; c.wkRaw = w.wkRaw; c.wkVar = w.rangeShare > 0.8 ? w.wkVar : null; c.adjusted = w.adjusted;
    c.priceSource = "exchange prices via stockanalysis.com (daily closes" + (w.adjusted ? "; history adjusted for dividends and splits; demerger days excluded" : "") + ")";
    c.corpActions = w.actions;
    if (opts.daily) { const A = adjustedDaily(rows); c.dd = rows.map(r => r.date); c.dA = A.out; c.dR = rows.map(r => r.close); }
    const lastRow = rows[rows.length - 1], prevRow = rows[rows.length - 2];
    c.px = lastRow.close; c.pxDate = lastRow.date; c.chg = prevRow ? (lastRow.close / prevRow.close - 1) * 100 : c.chg;
    const v = get("SELECT * FROM verify WHERE cid=?", id); c.verify = v || null;
  } else c.priceSource = "filings-site snapshot (weekly)";
  const L = opts.live === false ? null : STATE.live[sym];
  if (L && L.price && (!c.pxDate || L.day >= c.pxDate)) {               // intraday price overrides the last close
    // adjusted and raw coincide at the latest date, so the live price extends both series
    const raw = c.wkRaw || c.wk;
    if (c.wd.length && sameWeek(c.wd[c.wd.length - 1], L.day)) { c.wk = [...c.wk]; c.wk[c.wk.length - 1] = L.price; c.wkRaw = [...raw]; c.wkRaw[c.wkRaw.length - 1] = L.price; c.wd = [...c.wd]; c.wd[c.wd.length - 1] = L.day; }
    else { c.wk = [...c.wk, L.price]; c.wkRaw = [...raw, L.price]; c.wd = [...c.wd, L.day]; if (c.wkVar) c.wkVar = [...c.wkVar, null]; }
    c.px = L.price; c.chg = L.chg; c.live = { open: L.open, time: L.time, price: L.price };
    if (L.open) { const tz = c.mk === "IN" ? "Asia/Kolkata" : c.mk === "KR" ? "Asia/Seoul" : "America/New_York"; c.priceAsof = `live price, ${new Date(L.time * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz })} ${c.mk === "IN" ? "IST" : c.mk === "KR" ? "KST" : "New York"}`; }
  }
  // when the fundamentals (ratios, financials) were last downloaded: the evening refresh, or the Finder download
  const fd = b.onDemand ? b.fetched : STATE.asof?.collected; if (fd) c.fundAsof = new Date(fd).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  // the header states what the shown price is: live (with time) or the last completed close
  if (!c.priceAsof && c.pxDate) c.priceAsof = `${c.mk === "IN" ? "NSE" : c.mk === "KR" ? "KRX" : "US"} close, ${new Date(c.pxDate + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
  // valuation ratios move with price: rescale P/E, P/B, yield from the snapshot price
  if (b.px && c.px && b.px !== c.px) { const k = c.px / b.px; if (c.pe) c.pe = b.pe * k; if (c.pb) c.pb = b.pb * k; if (c.dy) c.dy = b.dy / k; c.ratiosAdjusted = true; }
  return c;
}
function sameWeek(a, b) { const f = d => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); }; return f(a) === f(b); }
export async function runVerification(id) {
  const b = STATE.base[id]; if (!b) return null;
  return verify(b, b.mk === "IN" ? { date: b.wd[b.wd.length - 1], close: b.wk[b.wk.length - 1] } : null);
}
