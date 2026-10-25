(() => {
"use strict";
// ═════════════════════════════ utilities ═════════════════════════════
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const fin = v => v != null && isFinite(v);
const pct = (v, d = 1, sign = true) => !fin(v) ? "—" : (sign && v > 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const x2 = (v, d = 2) => !fin(v) ? "—" : (+v).toFixed(d);
const cls = v => v > 0 ? "pos" : v < 0 ? "neg" : "";
function px(v, c) {
  if (!fin(v)) return "—";
  const neg = v < 0, a = Math.abs(v); c = c || {};   // a stock with no company data: plain number rather than an error
  const s = c.cur === "₩" ? "₩" + Math.round(a).toLocaleString("en-US") : c.cur === "₹" ? "₹" + a.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : (c.cur === "$" || c.mk === "US" || c.mk === "TW" ? "$" : "") + a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? "−" : "") + s;
}
const inr = v => !fin(v) ? "—" : (v < 0 ? "−" : "") + "₹" + Math.abs(Math.round(v)).toLocaleString("en-IN");
const inrS = v => !fin(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + "₹" + Math.abs(Math.round(v)).toLocaleString("en-IN");
const fmtDate = d => { if (!d) return "—"; const t = new Date(d.length === 10 ? d + "T00:00:00Z" : d); return isNaN(t) ? d : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); };
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const safeId = s => String(s).replace(/[^A-Za-z0-9_.~:@+-]/g, "_");
const SRCLINK = (c, key) => { const u = SRC[c.id]?.[key]; return u ? `<span class="src"><a href="${esc(u)}" target="_blank" rel="noopener">${esc(SRCNAME[key] || "source")}</a></span>` : ""; };
function money(v, c) { if (!fin(v)) return "—"; const u = c.fin.u || "", sym = u.split(" ")[0], unit = u.split(" ")[1] || ""; return (v < 0 ? "−" : "") + sym + finFmt(Math.abs(v), c) + (unit === "Cr" ? " Cr" : unit); }
function finFmt(v, c) { if (!fin(v)) return "—"; const x = v / (c.fin.d || 1), a = Math.abs(x), dec = a >= 100 ? 0 : a >= 10 ? 1 : 2; return c.cur === "₹" && (c.fin.d || 1) === 1 ? x.toLocaleString("en-IN", { maximumFractionDigits: 0 }) : x.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); }

// ═════════════════════════════ companies ═════════════════════════════
const CO = {};
for (const c of CORE) { c.core = true; c.V = V[c.id] || null; CO[c.id] = c; }
let UNI = null, uniLoading = null;
function loadUniverse() {
  if (UNI) return Promise.resolve(UNI);
  if (!uniLoading) uniLoading = fetch("universe.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(j => (UNI = j)).catch(e => { uniLoading = null; throw e; });
  return uniLoading;
}
function uniCompany(key) {
  if (CO[key]) return CO[key];
  const u = UNI?.items?.[key]; if (!u) return null;
  const [mk, tk] = key.split(":");
  const wd = [u.w0]; let t = Date.parse(u.w0 + "T00:00:00Z"); for (const d of u.dd) { t += d * 864e5; wd.push(new Date(t).toISOString().slice(0, 10)); }
  const c = { id: key, nm: u.n, tk, ex: mk === "IN" ? "NSE" : mk === "KR" ? "KRX" : "US", mk, cur: mk === "IN" ? "₹" : mk === "KR" ? "₩" : "$", src: u.src, sector: u.sec, px: u.px, chg: u.chg ?? null,
    asof: mk === "IN" ? ASOF.india : ASOF.us, mcap: u.mcap, mcapUSD: u.mcapN, pe: u.pe, fpe: u.fpe, pb: u.pb ?? (u.bv ? u.px / u.bv : null), bv: u.bv ?? (u.pb ? u.px / u.pb : null), roe: u.roe, roce: u.roce, roic: u.roic,
    de: u.de, dy: u.dy || 0, npm: u.npm, beta: u.beta, tgt: u.tgt, cons: u.cons, about: u.about, fyEndMonth: mk === "IN" ? 3 : 12, hi: u.hi, lo: u.lo,
    fin: { ...(u.fin || { y: [] }), u: mk === "IN" ? "₹ Cr" : "$ B", d: mk === "IN" ? 1 : 1000 }, shares: u.shares, finScale: mk === "IN" ? 1e7 : 1e6, wd, wk: u.wk, universe: true, news: [], docs: [{ t: "Source data", u: u.src }] };
  CO[key] = c; return c;
}
const allTracked = () => Object.values(CO).filter(c => c.core || STATE.watch.has(c.id));

// ═════════════════════════════ storage ═════════════════════════════
const STATE = { orders: [], sims: [], notes: [], watch: new Set(), mode: "local" };
const Store = {
  db: null,
  async init() {
    this.loadLocal();
    try {
      const [db, user] = await Promise.all([window.claude?.use?.("db"), window.claude?.use?.("user")]);
      const owner = user ? await user.isOwner().catch(() => false) : false;
      if (db && owner) { this.db = db; STATE.mode = "cloud"; this.subscribe(); render(); return; }
    } catch (e) { /* stay local */ }
    render();
  },
  loadLocal() {
    try { const j = JSON.parse(localStorage.getItem("synapse.v3") || "null"); if (j) { if (j.orders?.length) STATE.orders = j.orders; STATE.sims = j.sims || []; STATE.notes = j.notes || []; STATE.watch = new Set(j.watch || []); } } catch (e) {}
  },
  saveLocal() { try { localStorage.setItem("synapse.v3", JSON.stringify({ orders: STATE.orders, sims: STATE.sims, notes: STATE.notes, watch: [...STATE.watch] })); } catch (e) {} },
  subscribe() {
    const on = (name, apply) => this.db.collection(name).onSnapshot(snap => { apply(snap.docs.map(d => ({ id: d.id, ...d.data() }))); if (!isTyping()) render(); }, () => {});
    on("orders", rows => { STATE.orders = rows.length ? rows : ORDERS_SEED.map(seedToOrder); });
    on("sims", rows => { STATE.sims = rows; });
    on("notes", rows => { STATE.notes = rows; });
    on("watch", rows => { STATE.watch = new Set(rows.map(r => r.key)); if (STATE.watch.size) loadUniverse().then(() => { [...STATE.watch].forEach(uniCompany); render(); }).catch(() => {}); });
  },
  async put(coll, obj) {
    const id = obj.id || uid(), body = { ...obj }; delete body.id;
    if (this.db) {
      if (coll === "orders" && STATE.orders.every(o => o.id.startsWith("seed")) && !this.seeded) { this.seeded = true; await Promise.all(STATE.orders.filter(o => o.id !== id).map(o => { const b = { ...o }; delete b.id; return this.db.collection("orders").doc(o.id).set(b); })); }
      await this.db.collection(coll).doc(id).set(body); return id;
    }
    if (coll === "watch") STATE.watch.add(body.key); else { const arr = STATE[coll], i = arr.findIndex(x => x.id === id); if (i >= 0) arr[i] = { id, ...body }; else arr.push({ id, ...body }); }
    this.saveLocal(); if (!isTyping()) render(); return id;
  },
  async del(coll, id) {
    if (this.db) {
      if (coll === "orders" && STATE.orders.every(o => o.id.startsWith("seed")) && !this.seeded) { this.seeded = true; await Promise.all(STATE.orders.filter(o => o.id !== id).map(o => { const b = { ...o }; delete b.id; return this.db.collection("orders").doc(o.id).set(b); })); }
      await this.db.collection(coll).doc(coll === "watch" ? safeId(id) : id).delete(); return;
    }
    if (coll === "watch") STATE.watch.delete(id); else STATE[coll] = STATE[coll].filter(x => x.id !== id);
    this.saveLocal(); render();
  }
};
const isTyping = () => { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "range" && a.closest("#main"))); };
function seedToOrder(r, i) { return { id: "seed" + String(i).padStart(3, "0"), date: r[0], sym: r[1], name: r[2], kind: r[3], side: r[4], qty: r[5], price: r[6], status: r[7], note: r[8], source: "order history import" }; }

// ═════════════════════════════ portfolio from orders ═════════════════════════════
function companyForSym(sym) { return CO[sym] || (UNI ? uniCompany("IN:" + sym) : null); }
function portfolio() {
  const pos = {}, flows = [];
  const ex = STATE.orders.filter(o => o.status === "executed").sort((a, b) => a.date.localeCompare(b.date) || (a.side === "Buy" ? -1 : 1));
  for (const o of ex) {
    const P = pos[o.sym] = pos[o.sym] || { sym: o.sym, name: o.name, q: 0, cost: 0, realised: 0 };
    if (o.side === "Buy") { P.q += o.qty; P.cost += o.qty * o.price; if (o.kind !== "Corporate action") flows.push([o.date, -o.qty * o.price]); }
    else { const avg = P.q ? P.cost / P.q : 0; P.realised += o.qty * (o.price - avg); P.cost -= avg * o.qty; P.q -= o.qty; if (o.kind !== "Corporate action") flows.push([o.date, o.qty * o.price]); }
  }
  const rows = Object.values(pos);
  let invested = 0, value = 0, day = 0, realised = 0;
  for (const P of rows) {
    realised += P.realised; if (P.q <= 1e-9) continue;
    const c = companyForSym(P.sym); P.c = c; P.avg = P.cost / P.q;
    P.px = c?.px ?? null; P.value = fin(P.px) ? P.px * P.q : null; P.pl = fin(P.value) ? P.value - P.cost : null;
    invested += P.cost; if (fin(P.value)) { value += P.value; if (fin(c.chg)) day += P.value * (1 - 1 / (1 + c.chg / 100)); }
  }
  const open = rows.filter(P => P.q > 1e-9).sort((a, b) => (b.value || 0) - (a.value || 0));
  open.forEach(P => P.w = fin(P.value) && value ? P.value / value : null);
  flows.sort((a, b) => a[0].localeCompare(b[0]));
  const xirr = flows.length ? XIRR([...flows, [CORE[0].wd[CORE[0].wd.length - 1], value]]) : null;
  return { open, closed: rows.filter(P => P.q <= 1e-9), invested, value, day, realised, unreal: value - invested, xirr };
}
function XIRR(flows) {
  const t0 = Date.parse(flows[0][0]), yrs = flows.map(f => (Date.parse(f[0]) - t0) / (365.25 * 864e5));
  let r = 0.1;
  for (let it = 0; it < 100; it++) { let f = 0, d = 0; flows.forEach((fl, i) => { const v = Math.pow(1 + r, yrs[i]); f += fl[1] / v; d -= yrs[i] * fl[1] / (v * (1 + r)); }); if (!d) return null; const nr = r - f / d; if (!isFinite(nr)) return null; if (Math.abs(nr - r) < 1e-8) return nr; r = Math.max(-0.95, Math.min(10, nr)); }
  return r;
}

// ═════════════════════════════ analysis cache ═════════════════════════════
const RES = {};
let W = { ...Q.DEFAULT_W };
try { const s = JSON.parse(localStorage.getItem("synapse.w") || "null"); if (s && typeof s.value === "number") W = s; } catch (e) {}
function analysis(c) { if (!(c.id in RES)) RES[c.id] = Q.analyse(c, { H: 52, paths: 6000, W }); return RES[c.id]; }
function rescore() { for (const id in RES) if (RES[id]) { RES[id].score = Q.score(RES[id].F6, W); RES[id].label = Q.label(RES[id].score); } }
const scoreBadge = A => A ? `<span class="score ${A.label[1]}" title="${A.label[0]}">${A.score.toFixed(0)}</span>` : `<span class="faint">…</span>`;
const FN = { value: "Valuation", quality: "Quality", growth: "Growth", edge: "Statistical edge", trend: "Trend", safety: "Safety" };

// ═════════════════════════════ router ═════════════════════════════
let route = { name: "home", arg: null, q: {} }, cleanup = [];
function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1) || "");
  const [path, qs] = h.split("?"), q = Object.fromEntries(new URLSearchParams(qs || "")), p = path.split("/").filter(Boolean);
  if (!p.length) return { name: "home", q };
  if (p[0] === "c") return { name: "company", arg: p.slice(1).join("/"), q };
  return { name: p[0], arg: p[1], q };
}
const go = h => { location.hash = h; };
window.addEventListener("hashchange", () => { route = parseHash(); render(true); });
function render(scrollTop) {
  cleanup.forEach(f => { try { f(); } catch (e) {} }); cleanup = [];
  $$(".nav a").forEach(a => a.setAttribute("aria-current", a.dataset.r === route.name || (route.name === "company" && a.dataset.r === "home") ? "page" : "false"));
  const M = $("#main"); M.onclick = null;
  ({ home: vHome, company: vCompany, orders: vOrders, simulate: vSim, finder: vFinder, notes: vNotes, model: vModel }[route.name] || vHome)(M);
  if (scrollTop) try { window.scrollTo(0, 0); } catch (e) {}
}

// ═════════════════════════════ charts ═════════════════════════════
function spark(wk, w = 84, h = 24) { const s = wk.slice(-52), lo = Math.min(...s), hi = Math.max(...s); const d = s.map((v, i) => `${(i / (s.length - 1) * w).toFixed(1)},${(h - 2 - (v - lo) / (hi - lo || 1) * (h - 4)).toFixed(1)}`).join(" "); return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline class="${s[s.length - 1] >= s[0] ? "up" : "dn"}" points="${d}"/></svg>`; }
function timeChart({ c, hist, dates, fan, H, actual, refs = [], height = 260 }) {
  const W = 900, pad = { l: 6, r: 80, t: 12, b: 22 }, nH = hist.length, nF = fan ? H : 0;
  const all = [...hist, ...(fan ? fan.flatMap(f => [f.p05, f.p95]) : []), ...(actual || []), ...refs.map(r => r.v).filter(fin)];
  const lo = Math.min(...all) * 0.97, hi = Math.max(...all) * 1.03, span = (nH - 1) + nF;
  const X = i => pad.l + i / span * (W - pad.l - pad.r), Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const ticks = [0, 1, 2, 3].map(k => lo + (hi - lo) * k / 3).map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${W - pad.r + 6}" y="${Y(v) + 3}">${esc(px(v, c))}</text>`).join("");
  const line = (arr, off = 0) => arr.map((v, i) => `${i ? "L" : "M"}${X(i + off).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  let s = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="Price chart">${ticks}<path class="area" d="${line(hist)}L${X(nH - 1)},${height - pad.b}L${X(0)},${height - pad.b}Z"/>`;
  if (fan) {
    const p0 = hist[nH - 1], base = nH - 1, pts = k => [[0, p0], ...fan.map(f => [f.w, f[k]])];
    const band = (a, b) => "M" + [...pts(a), ...pts(b).reverse()].map(p => `${X(base + p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("L") + "Z";
    s += `<path class="band90" d="${band("p05", "p95")}"/><path class="band50" d="${band("p25", "p75")}"/><path class="median" d="${pts("p50").map((p, i) => `${i ? "L" : "M"}${X(base + p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("")}"/><line class="axis" x1="${X(base)}" x2="${X(base)}" y1="${pad.t}" y2="${height - pad.b}" stroke-dasharray="3 3"/>`;
    const f = fan[fan.length - 1];
    s += `<text x="${X(base + H) - 2}" y="${Y(f.p95) - 5}" text-anchor="end">95th ${esc(px(f.p95, c))}</text><text x="${X(base + H) - 2}" y="${Y(f.p50) - 5}" text-anchor="end">median ${esc(px(f.p50, c))}</text><text x="${X(base + H) - 2}" y="${Y(f.p05) + 13}" text-anchor="end">5th ${esc(px(f.p05, c))}</text>`;
  }
  if (actual) s += `<path class="actual" d="${line(actual, nH - 1)}"/>`;
  s += `<path class="price" d="${line(hist)}"/>`;
  for (const r of refs) if (fin(r.v)) s += `<line class="${r.cls}" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(r.v)}" y2="${Y(r.v)}"/><text x="${pad.l + 4}" y="${Y(r.v) - 4}">${esc(r.label)}</text>`;
  s += `<circle class="dot" cx="${X(nH - 1)}" cy="${Y(hist[nH - 1])}" r="3.5"/>`;
  if (dates) s += `<g class="xh" style="display:none"><line y1="${pad.t}" y2="${height - pad.b}"/><circle r="3"/><text y="${pad.t + 10}"></text></g>`;
  s += "</svg>";
  if (dates) { const id = "tc" + uid(); s = s.replace('<svg class="chart"', `<svg class="chart" data-tc="${id}"`); TC[id] = { W, pad, span, X, Y, hist, dates, c }; }
  return s;
}
const TC = {};
function bindTC(root) {
  root.querySelectorAll("svg[data-tc]").forEach(svg => {
    const T = TC[svg.dataset.tc], g = svg.querySelector(".xh"); if (!T || !g) return;
    svg.addEventListener("pointermove", e => {
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * T.W, i = Math.round((x - T.pad.l) / (T.W - T.pad.l - T.pad.r) * T.span);
      if (i < 0 || i >= T.hist.length) { g.style.display = "none"; return; }
      const X = T.X(i), Yv = T.Y(T.hist[i]); g.style.display = "";
      const [ln, ci, tx] = [g.querySelector("line"), g.querySelector("circle"), g.querySelector("text")];
      ln.setAttribute("x1", X); ln.setAttribute("x2", X); ci.setAttribute("cx", X); ci.setAttribute("cy", Yv); tx.setAttribute("x", Math.min(X + 6, T.W - 240)); tx.textContent = `${fmtDate(T.dates[i])} · ${px(T.hist[i], T.c)}`;
    });
    svg.addEventListener("pointerleave", () => g.style.display = "none");
  });
}
function finChart(c) {
  const f = c.fin, n = f.y.length, W = 900, H = 230, pad = { l: 6, r: 70, t: 10, b: 24 };
  const vals = [...(f.rev || []), ...(f.np || []), 0].filter(fin), hi = Math.max(...vals) * 1.08, lo = Math.min(0, ...vals) * 1.15;
  const Y = v => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b), gw = (W - pad.l - pad.r) / n, bw = gw * 0.3;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue and net profit by year">`;
  [lo, 0, hi / 2, hi].filter((v, i, a) => a.indexOf(v) === i).forEach(v => s += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${W - pad.r + 6}" y="${Y(v) + 3}">${esc(finFmt(v, c))}</text>`);
  f.y.forEach((y, i) => { const x = pad.l + i * gw + gw * 0.18, r = f.rev?.[i], p = f.np?.[i];
    if (fin(r)) s += `<rect class="bar-rev" x="${x}" y="${Y(Math.max(r, 0))}" width="${bw}" height="${Math.abs(Y(r) - Y(0))}"><title>${esc(y)} revenue ${esc(finFmt(r, c))}</title></rect>`;
    if (fin(p)) s += `<rect class="${p < 0 ? "bar-neg" : "bar-np"}" x="${x + bw + 3}" y="${Y(Math.max(p, 0))}" width="${bw}" height="${Math.max(1, Math.abs(Y(p) - Y(0)))}"><title>${esc(y)} net profit ${esc(finFmt(p, c))}</title></rect>`;
    s += `<text x="${x + bw}" y="${H - 8}" text-anchor="middle">${esc(y)}</text>`; });
  return s + "</svg>";
}
function pitChart(hist) { const W = 320, H = 110, mx = Math.max(...hist), bw = W / hist.length, n = hist.reduce((a, b) => a + b, 0), ideal = n / hist.length; return `<svg class="chart" viewBox="0 0 ${W} ${H + 16}" role="img" aria-label="Where actual prices fell within the forecast distribution">${hist.map((v, i) => `<rect class="cal" x="${(i * bw + 1).toFixed(1)}" y="${(H - v / mx * H).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(v / mx * H).toFixed(1)}" opacity=".75"/>`).join("")}<line class="ideal" x1="0" x2="${W}" y1="${H - ideal / mx * H}" y2="${H - ideal / mx * H}"/><text x="0" y="${H + 13}">0%</text><text x="${W / 2}" y="${H + 13}" text-anchor="middle">forecast percentile</text><text x="${W}" y="${H + 13}" text-anchor="end">100%</text></svg>`; }
function calChart(points) {
  const W = 260, H = 200, p = 26, X = v => p + v * (W - 2 * p), Y = v => H - p - v * (H - 2 * p);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Promised versus observed coverage"><line class="axis" x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(0)}"/><line class="axis" x1="${X(0)}" y1="${Y(0)}" x2="${X(0)}" y2="${Y(1)}"/><line class="ideal" x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}"/>${[0, 0.5, 1].map(v => `<text x="${X(v)}" y="${H - 8}" text-anchor="middle">${v * 100}%</text><text x="${p - 4}" y="${Y(v) + 3}" text-anchor="end">${v * 100}%</text>`).join("")}${points.map(([a, b, l]) => `<circle class="cal" cx="${X(a)}" cy="${Y(b)}" r="4"/><text x="${X(a) + 6}" y="${Y(b) - 6}">${esc(l)}</text>`).join("")}</svg>`;
}

// ═════════════════════════════ 3D information web ═════════════════════════════
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#888888";
class Web3D {
  constructor(host, { nodes, links, onPick, tip }) {
    this.host = host; this.nodes = nodes; this.onPick = onPick; this.tipFn = tip;
    this.ok = !!window.THREE && (() => { try { const cv = document.createElement("canvas"); return !!(cv.getContext("webgl") || cv.getContext("experimental-webgl")); } catch (e) { return false; } })();
    if (!this.ok) { host.insertAdjacentHTML("beforeend", `<div class="nogl">The 3D view needs WebGL, which is turned off in this browser. The same information is listed below.</div>`); return; }
    const w = host.clientWidth, h = host.clientHeight, R = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); R.setSize(w, h); R.setClearColor(0x000000, 0); host.prepend(R.domElement);
    this.lbl = document.createElement("div"); this.lbl.className = "lbls"; host.appendChild(this.lbl);
    this.tip = document.createElement("div"); this.tip.className = "tip"; this.tip.hidden = true; host.appendChild(this.tip);
    this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 500);
    this.meshes = []; this.byId = {};
    for (const n of nodes) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(n.size, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(n.color), transparent: true, opacity: 1 }));
      m.position.set(...n.pos); m.userData.n = n; n.mesh = m; this.scene.add(m); this.meshes.push(m); this.byId[n.id] = m;
      if (n.label) { const d = document.createElement("div"); d.className = "lbl " + (n.lcls || ""); d.innerHTML = n.label; this.lbl.appendChild(d); n.el = d; }
    }
    this.lines = []; const lc = new THREE.Color(css("--line2"));
    for (const L of links) { const a = this.byId[L.a], b = this.byId[L.b]; if (!a || !b) continue; const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a.position.clone(), b.position.clone()]), new THREE.LineBasicMaterial({ color: lc, transparent: true, opacity: L.o ?? 0.9 })); l.userData = { a, b, o: L.o ?? 0.9 }; this.scene.add(l); this.lines.push(l); }
    this.o = { th: 0.5, ph: 1.2, d: 62, tth: 0.5, tph: 1.2, td: 62, t: new THREE.Vector3(), tt: new THREE.Vector3() };
    this.auto = false; this.ray = new THREE.Raycaster(); this.mouse = new THREE.Vector2(-9, -9);
    this.bind(); this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.alive = true; this.dirty = true; this.loop = this.loop.bind(this); requestAnimationFrame(this.loop);
  }
  bind() {
    const el = this.renderer.domElement, pts = new Map(); let drag = null, pinch = null;
    el.addEventListener("pointerdown", e => { el.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
    el.addEventListener("pointermove", e => {
      const r = el.getBoundingClientRect(); this.mouse.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); this.mx = e.clientX - r.left; this.my = e.clientY - r.top;
      if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (pts.size === 2 && pinch) { const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); this.o.td = THREE.MathUtils.clamp(this.o.td * Math.pow(pinch / d, 0.6), 22, 110); pinch = d; this.dirty = true; return; }
      if (drag) { this.o.tth -= (e.clientX - drag.x) * 0.004; this.o.tph = THREE.MathUtils.clamp(this.o.tph - (e.clientY - drag.y) * 0.004, 0.25, 2.9); drag.x = e.clientX; drag.y = e.clientY; }
      this.needPick = true; this.dirty = true;
    });
    const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (drag && e.type === "pointerup" && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) { const n = this.pick(); if (n && this.onPick) this.onPick(n); } drag = null; };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", () => { this.mouse.set(-9, -9); this.setHover(null); });
    // gentle zoom: proportional to scroll distance and capped per event, so trackpads don't jump
    el.addEventListener("wheel", e => { e.preventDefault(); const dy = Math.max(-50, Math.min(50, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY)); this.o.td = THREE.MathUtils.clamp(this.o.td * Math.exp(dy * 0.001), 22, 110); this.dirty = true; }, { passive: false });
  }
  zoom(f) { this.o.td = THREE.MathUtils.clamp(this.o.td * f, 22, 110); this.dirty = true; }
  reset() { Object.assign(this.o, { tth: 0.5, tph: 1.2, td: 62 }); this.select(null); }
  pick() { this.ray.setFromCamera(this.mouse, this.cam); const h = this.ray.intersectObjects(this.meshes, false)[0]; return h ? h.object.userData.n : null; }
  setHover(n) { if (n === this.hov) return; this.hov = n; this.highlight(n || this.sel); if (n && this.tipFn) { this.tip.innerHTML = this.tipFn(n); this.tip.hidden = false; } else this.tip.hidden = true; this.dirty = true; }
  highlight(n) {
    const keep = new Set(); if (n) { keep.add(n.id); for (const l of this.lines) { const a = l.userData.a.userData.n, b = l.userData.b.userData.n; if (a === n || b === n) { keep.add(a.id); keep.add(b.id); } } }
    for (const m of this.meshes) { const on = !n || keep.has(m.userData.n.id); m.material.opacity = on ? 1 : 0.15; m.userData.n.hl = on ? 1 : 0.2; }
    for (const l of this.lines) { const a = l.userData.a.userData.n, b = l.userData.b.userData.n; l.material.opacity = !n || a === n || b === n ? l.userData.o : 0.12; }
    this.dirty = true;
  }
  select(id) { this.sel = id ? this.byId[id]?.userData.n : null; this.highlight(this.sel); if (this.sel) this.o.tt.copy(this.sel.mesh.position).multiplyScalar(0.5); else this.o.tt.set(0, 0, 0); this.dirty = true; }
  resize() { const w = this.host.clientWidth, h = this.host.clientHeight; if (!w || !h) return; this.renderer.setSize(w, h); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); this.dirty = true; }
  loop() {
    if (!this.alive) return; requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const o = this.o; if (this.auto && !this.hov) { o.tth += 0.0015; this.dirty = true; }
    const moving = Math.abs(o.tth - o.th) + Math.abs(o.tph - o.ph) + Math.abs(o.td - o.d) + o.t.distanceTo(o.tt) > 1e-4;
    if (!moving && !this.dirty && !this.needPick) return;
    const k = 0.18; o.th += (o.tth - o.th) * k; o.ph += (o.tph - o.ph) * k; o.d += (o.td - o.d) * k; o.t.lerp(o.tt, 0.12);
    this.cam.position.set(o.t.x + o.d * Math.sin(o.ph) * Math.sin(o.th), o.t.y + o.d * Math.cos(o.ph), o.t.z + o.d * Math.sin(o.ph) * Math.cos(o.th)); this.cam.lookAt(o.t);
    if (this.needPick) { this.needPick = false; this.setHover(this.pick()); }
    if (!this.tip.hidden) { this.tip.style.left = Math.min(this.mx + 14, this.host.clientWidth - 270) + "px"; this.tip.style.top = Math.min(this.my + 14, this.host.clientHeight - 110) + "px"; }
    this.renderer.render(this.scene, this.cam); this.dirty = false;
    const w = this.host.clientWidth, h = this.host.clientHeight, v = new THREE.Vector3();
    const focus = this.hov || this.sel, fHub = focus ? (focus.parent || (focus.lcls === "hub" ? focus.id : null)) : null, near = o.d < 34;
    for (const n of this.nodes) { if (!n.el) continue; v.copy(n.mesh.position).project(this.cam); if (v.z > 1 || (n.parent && !near && n.parent !== fHub && n !== focus)) { n.el.style.display = "none"; continue; } const dc = this.cam.position.distanceTo(n.mesh.position), fade = Math.max(0.25, Math.min(1, 1.6 - dc / o.d)); n.el.style.display = ""; n.el.style.opacity = (n.hl ?? 1) * fade; n.el.style.left = ((v.x + 1) / 2 * w) + "px"; n.el.style.top = ((1 - v.y) / 2 * h) + "px"; n.el.style.zIndex = Math.round((1 - v.z) * 1000); }
  }
  destroy() { if (!this.ok) return; this.alive = false; this.ro.disconnect(); this.renderer.dispose(); this.scene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); this.renderer.domElement.remove(); this.lbl.remove(); this.tip.remove(); }
}
function fib(n) { const out = [], g = Math.PI * (3 - Math.sqrt(5)); for (let i = 0; i < n; i++) { const y = 1 - (i / (n - 1 || 1)) * 2, r = Math.sqrt(1 - y * y), t = g * i; out.push([Math.cos(t) * r, y, Math.sin(t) * r]); } return out; }

// ═════════════════════════════ HOME ═════════════════════════════
let listMode = "all", sortKey = "score", sortDir = -1;
function vHome(M) {
  const P = portfolio(), tracked = allTracked();
  const ranked = tracked.filter(c => RES[c.id]).sort((a, b) => RES[b.id].score - RES[a.id].score);
  const news = tracked.flatMap(c => (c.news || []).map(n => ({ c, ...n }))).filter(n => n.d && !isNaN(Date.parse(n.d))).sort((a, b) => Date.parse(b.d) - Date.parse(a.d));
  const seen = new Set(), top = news.filter(n => { const k = n.t.slice(0, 50); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
  M.innerHTML = `
  <div class="pagehead"><div><h1>Portfolio overview</h1><div class="sub">Prices: ${esc(ASOF.india)} · ${esc(ASOF.us)} · Korea ${esc(ASOF.kr)}. Not live.</div></div>
    <div class="storage">${STATE.mode === "cloud" ? "Orders, notes and simulations are saved privately to your account." : "Changes are saved in this browser only."}</div></div>
  <div class="kpis">
    <div class="kpi"><div class="k">Current value</div><div class="v">${inr(P.value)}</div><div class="s">${P.open.length} holdings</div></div>
    <div class="kpi"><div class="k">Invested (cost)</div><div class="v">${inr(P.invested)}</div><div class="s">from executed orders</div></div>
    <div class="kpi"><div class="k">Unrealised P&amp;L</div><div class="v ${cls(P.unreal)}">${inrS(P.unreal)}</div><div class="s ${cls(P.unreal)}">${pct(P.unreal / P.invested, 2)}</div></div>
    <div class="kpi"><div class="k">Realised P&amp;L</div><div class="v ${cls(P.realised)}">${inrS(P.realised)}</div><div class="s">closed trades</div></div>
    <div class="kpi"><div class="k">Day change</div><div class="v ${cls(P.day)}">${inrS(P.day)}</div><div class="s">vs previous close</div></div>
    <div class="kpi"><div class="k">XIRR</div><div class="v ${cls(P.xirr)}">${fin(P.xirr) ? pct(P.xirr, 1) : "—"}</div><div class="s">annualised, by order dates</div></div>
  </div>
  <div class="grid g-main">
    <div class="stack">
      <div class="panel"><header><h2>Holdings</h2><span class="muted small">From your orders · average-cost method</span><span class="r"><a class="btn sm" href="#/orders">Orders &amp; add trade</a></span></header><div class="body flush tbl">${holdingsTable(P)}</div></div>
      <div class="panel"><header><h2>Companies</h2><span class="r"><span class="seg" id="lm">${[["all", "All"], ["held", "Held"], ["watch", "Not held"]].map(([k, n]) => `<button data-m="${k}" aria-pressed="${listMode === k}">${n}</button>`).join("")}</span> <a class="btn sm" href="#/finder">Add stocks</a></span></header><div class="body flush tbl" id="ctable">${companiesTable(tracked, P)}</div></div>
    </div>
    <div class="stack">
      <div class="panel"><header><h2>Highest model scores</h2></header><div class="body">
        ${ranked.length ? `<ul class="list">${ranked.slice(0, 5).map(c => { const A = RES[c.id], top2 = Object.entries(A.F6).sort((a, b) => b[1].s - a[1].s).slice(0, 2).map(x => FN[x[0]].toLowerCase()); return `<li><div class="l"><a href="#/c/${encodeURIComponent(c.id)}" class="nm">${esc(c.nm)}</a><div class="nt">Strongest on ${top2.join(" and ")} · 52-wk median ${px(A.mc.median, c)} (${pct(A.mc.median / c.px - 1, 0)})</div></div>${scoreBadge(A)}</li>`; }).join("")}</ul>` : `<p class="muted">Running the model…</p>`}
        <p class="note small" style="margin:10px 0 0">The score summarises valuation, quality, growth, risk and trend. In backtests it did <b>not</b> predict which stocks would rise more (rank correlation ${x2(BACKTEST.scoreIC?.["26"]?.ic, 2)} over 26 weeks). Read it as a profile, not a buy signal. <a href="#/model">See the evidence</a></p></div></div>
      <div class="panel"><header><h2>Latest news &amp; filings</h2></header><div class="body"><ul class="list">${top.map(n => `<li><div class="l"><a href="${esc(n.u)}" target="_blank" rel="noopener">${esc(n.t)}</a><div class="nt"><a href="#/c/${encodeURIComponent(n.c.id)}">${esc(n.c.tk)}</a> · ${esc(n.s || "")} · ${esc(n.d)}</div></div></li>`).join("")}</ul></div></div>
    </div>
  </div>`;
  $("#lm").onclick = e => { const b = e.target.closest("button"); if (!b) return; listMode = b.dataset.m; $$("#lm button").forEach(x => x.setAttribute("aria-pressed", x === b)); $("#ctable").innerHTML = companiesTable(allTracked(), portfolio()); };
  M.onclick = e => { const s = e.target.closest("button.sort"); if (s) { const k = s.dataset.k; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = ["name", "pe", "pb"].includes(k) ? 1 : -1; } $("#ctable").innerHTML = companiesTable(allTracked(), portfolio()); return; } const r = e.target.closest("tr[data-go]"); if (r && !e.target.closest("a,button,select")) go(r.dataset.go); };
}
function holdingsTable(P) {
  if (!P.open.length) return `<p class="empty" style="padding:12px 14px">No holdings yet. Add trades on the <a href="#/orders">Orders</a> page.</p>`;
  return `<table><thead><tr><th class="t">Stock</th><th>Qty</th><th>Avg cost</th><th>Last</th><th>Value</th><th>P&amp;L</th><th>P&amp;L %</th><th>Weight</th><th>Day</th><th>Score</th></tr></thead><tbody>${P.open.map(h => { const c = h.c || { cur: "₹" }; return `<tr class="click" data-go="${h.c ? "#/c/" + encodeURIComponent(h.c.id) : "#/orders"}"><td class="t"><div class="co"><b>${esc(h.c?.nm || h.name)}</b><span>${esc(h.sym)}</span></div></td><td>${h.q}</td><td>${px(h.avg, c)}</td><td>${px(h.px, c)}</td><td>${inr(h.value)}</td><td class="${cls(h.pl)}">${inrS(h.pl)}</td><td class="${cls(h.pl)}">${pct(h.pl / h.cost)}</td><td>${pct(h.w, 1, false)}</td><td class="${cls(h.c?.chg)}">${fin(h.c?.chg) ? pct(h.c.chg / 100, 2) : "—"}</td><td>${h.c ? scoreBadge(RES[h.c.id]) : ""}</td></tr>`; }).join("")}</tbody></table>`;
}
function companiesTable(list, P) {
  const held = new Set(P.open.map(h => h.c?.id)), val = (c, k) => ({ score: RES[c.id]?.score ?? -1, name: c.nm, chg: c.chg ?? 0, pe: c.pe ?? 1e9, pb: c.pb ?? 1e9, roe: c.roe ?? -1e9, dy: c.dy ?? 0 })[k];
  const rows = list.filter(c => listMode === "all" || (listMode === "held" ? held.has(c.id) : !held.has(c.id))).sort((a, b) => { const x = val(a, sortKey), y = val(b, sortKey); return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir; });
  const th = (k, n, t) => `<th class="${t || ""}"><button class="sort" data-k="${k}">${n}${sortKey === k ? (sortDir < 0 ? " ▾" : " ▴") : ""}</button></th>`;
  return `<table><thead><tr>${th("name", "Company", "t")}<th>Price</th>${th("chg", "Day")}<th>1 year</th>${th("pe", "P/E")}${th("pb", "P/B")}${th("roe", "ROE")}${th("dy", "Div. yield")}${th("score", "Score")}</tr></thead><tbody>${rows.map(c => `<tr class="click" data-go="#/c/${encodeURIComponent(c.id)}"><td class="t"><div class="co"><b>${esc(c.nm)}${held.has(c.id) ? '<span class="tag held">held</span>' : ""}${c.universe ? '<span class="tag">added</span>' : ""}</b><span>${esc(c.tk)} · ${esc(c.ex)}${c.sector ? " · " + esc(c.sector) : ""}</span></div></td><td>${px(c.px, c)}</td><td class="${cls(c.chg)}">${fin(c.chg) ? pct(c.chg / 100, 2) : "—"}</td><td>${spark(c.wk)}</td><td>${c.pe ? x2(c.pe, 1) : "—"}</td><td>${x2(c.pb, 1)}</td><td>${fin(c.roe) ? c.roe.toFixed(1) + "%" : "—"}</td><td>${(c.dy || 0).toFixed(2)}%</td><td>${scoreBadge(RES[c.id])}</td></tr>`).join("")}</tbody></table>`;
}

// ═════════════════════════════ COMPANY ═════════════════════════════
const DEF = { "P/E": "Price ÷ earnings per share.", "P/B": "Price ÷ book value per share.", "ROE": "Net profit ÷ shareholders' equity.", "ROCE": "Return on capital employed.", "ROIC": "Return on invested capital.", "Debt / equity": "Borrowings ÷ equity.", "Dividend yield": "Annual dividend ÷ price.", "Market cap": "Shares × price.", "Net margin": "Net profit ÷ revenue." };
function vCompany(M) {
  const id = route.arg; let c = CO[id];
  if (!c && id && id.includes(":")) {
    if (!UNI) { M.innerHTML = `<p class="muted">Loading company data…</p>`; loadUniverse().then(() => { if (route.name === "company" && route.arg === id) render(); }).catch(() => { M.innerHTML = `<p>Couldn't load the stock list. <a href="#/">Back to overview</a></p>`; }); return; }
    c = uniCompany(id);
  }
  if (!c) { M.innerHTML = `<p>Company not found. <a href="#/">Back to overview</a></p>`; return; }
  const A = analysis(c), h = portfolio().open.find(x => x.c?.id === c.id);
  const secs = [["web", "Information web"], ["key", "Key numbers"], ["profile", "Profile"], ["pred", "Prediction"], ["fin", "Financials"], ["chain", "Suppliers, plants & peers"], ["news", "News & filings"], ["notes", "Notes"], ["ask", "Ask Claude"]];
  M.innerHTML = `
  <div class="chead"><div><h1>${esc(c.nm)}</h1><div class="sub">${esc(c.tk)} · ${esc(c.ex)}${c.sector ? " · " + esc(c.sector) : ""} · <a href="${esc(c.src)}" target="_blank" rel="noopener">data source</a> · ${esc(c.asof)}</div>
      ${h ? `<div class="sub">Your position: <b>${h.q}</b> @ ${px(h.avg, c)} · value ${inr(h.value)} · <span class="${cls(h.pl)}">${inrS(h.pl)} (${pct(h.pl / h.cost)})</span></div>` : ""}
      <div class="actions"><a class="btn primary" href="#/simulate?c=${encodeURIComponent(c.id)}">Simulate a trade</a>${c.mk === "IN" ? `<a class="btn" href="#/orders?add=${encodeURIComponent(c.tk)}">Add order</a>` : ""}${c.universe ? (STATE.watch.has(c.id) ? `<button class="btn" id="unwatch">Remove from dashboard</button>` : `<button class="btn" id="watch">Add to dashboard</button>`) : ""}</div></div>
    <div class="price"><div class="big">${px(c.px, c)}</div><div class="${cls(c.chg)} mono">${fin(c.chg) ? pct(c.chg / 100, 2) + " today" : ""}</div><div style="margin-top:6px" class="small muted">Model score ${scoreBadge(A)} ${A ? esc(A.label[0]) : ""}</div></div></div>
  <nav class="jump" aria-label="Sections">${secs.map(([k, n]) => `<a href="#/c/${encodeURIComponent(c.id)}" data-sec="${k}">${n}</a>`).join("")}</nav>
  <section class="cs" id="s-web"><div class="webwrap"><div class="web" id="web"><div class="webctl"><button class="btn sm" id="zin" aria-label="Zoom in">+</button><button class="btn sm" id="zout" aria-label="Zoom out">−</button><button class="btn sm" id="wreset">Reset</button><button class="btn sm" id="wauto" aria-pressed="false">Rotate</button></div><div class="weblegend" id="wl"></div></div>
    <div class="panel nodecard"><div class="body" id="nodecard"><div class="cat">How to read this</div><h4>${esc(c.nm)}</h4><p class="muted small">Each branch is one kind of information: valuation, profitability, financials, prediction, suppliers, customers, plants, peers, owners and news. Hover or click a branch to show its items, or zoom in to see every label. Drag to rotate, and click any node for details and its source.</p></div></div></div></section>
  <section class="cs" id="s-key"></section><section class="cs" id="s-profile"></section><section class="cs" id="s-pred"></section><section class="cs" id="s-fin"></section><section class="cs" id="s-chain"></section><section class="cs" id="s-news"></section><section class="cs" id="s-notes"></section><section class="cs" id="s-ask"></section>`;
  $(".jump").onclick = e => { const a = e.target.closest("a[data-sec]"); if (!a) return; e.preventDefault(); $("#s-" + a.dataset.sec)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("#watch")?.addEventListener("click", () => Store.put("watch", { id: safeId(c.id), key: c.id, added: today() }));
  $("#unwatch")?.addEventListener("click", () => Store.del("watch", c.id));
  secKey($("#s-key"), c, A, h); secProfile($("#s-profile"), c); secPred($("#s-pred"), c, A); secFin($("#s-fin"), c); secChain($("#s-chain"), c); secNews($("#s-news"), c); secNotes($("#s-notes"), c); secAsk($("#s-ask"), c, A);
  buildWeb(c, A, h);
}
const sh = (t, s = "") => `<div class="sh"><h2>${t}</h2>${s ? `<span class="muted small">${s}</span>` : ""}</div>`;
const stat = (k, v, s = "") => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
function secKey(P, c, A, h) {
  const T = A?.tech;
  P.innerHTML = sh("Key numbers", `Source: <a href="${esc(c.src)}" target="_blank" rel="noopener">${c.mk === "IN" ? "screener.in" : "stockanalysis.com"}</a> · ${esc(c.asof)}`) + `<div class="stats">${[
    stat("Market cap", esc(c.mcap || "—")), stat("P/E", c.pe ? x2(c.pe) : "n/a", c.pe ? "trailing" : "no trailing profit"), c.fpe ? stat("Forward P/E", x2(c.fpe)) : "", stat("P/B", x2(c.pb)), stat("Book value / share", px(c.bv, c)),
    stat("ROE", fin(c.roe) ? c.roe.toFixed(1) + "%" : "—"), fin(c.roce) ? stat("ROCE", c.roce.toFixed(1) + "%") : fin(c.roic) ? stat("ROIC", c.roic.toFixed(1) + "%") : "", stat("Debt / equity", x2(c.de)),
    fin(c.npm) ? stat("Net margin", c.npm.toFixed(1) + "%") : "", fin(c.gm) ? stat("Gross margin", c.gm.toFixed(1) + "%") : "", fin(c.om) ? stat("Operating margin", c.om.toFixed(1) + "%") : "",
    stat("Dividend yield", (c.dy || 0).toFixed(2) + "%"), c.beta ? stat("Beta (5Y)", x2(c.beta)) : "",
    stat("52-week range", `${px(c.lo ?? T?.lo, c)} – ${px(c.hi ?? T?.hi, c)}`), T ? stat("1-year change", `<span class="${cls(T.ret52)}">${pct(fin(c.ch52) ? c.ch52 / 100 : T.ret52)}</span>`) : "",
    c.tgt ? stat("Analyst target", px(c.tgt, c), `${esc(c.cons || "")} · ${pct(c.tgt / c.px - 1)}`) : "", c.emp ? stat("Employees", esc(c.emp)) : ""].join("")}</div>
    <div class="panel" style="margin-top:14px"><header><h2>Price history (weekly closes)</h2><span class="r legend"><span><i style="border-color:var(--text)"></i>Close</span>${h ? `<span><i style="border-color:var(--c4);border-top-style:dashed"></i>Your average cost</span>` : ""}</span></header><div class="body">${timeChart({ c, hist: c.wk, dates: c.wd, refs: h ? [{ v: h.avg, cls: "cost", label: "your avg " + px(h.avg, c) }] : [] })}<div class="small faint">${fmtDate(c.wd[0])} – ${fmtDate(c.wd[c.wd.length - 1])}</div></div></div>
    ${c.shp ? `<div class="panel" style="margin-top:14px"><header><h2>Shareholding</h2><span class="muted small">${esc(c.shp.date)} · screener.in</span></header><div class="body">${Object.entries(c.shp).filter(([k, v]) => k !== "date" && v > 0).map(([k, v]) => `<div style="display:grid;grid-template-columns:110px 1fr 60px;gap:10px;align-items:center;margin:5px 0"><span class="small muted">${esc(k)}</span><div class="bar"><i style="width:${v}%;background:var(--c1)"></i></div><span class="mono small" style="text-align:right">${v.toFixed(2)}%</span></div>`).join("")}</div></div>` : ""}`;
  bindTC(P);
}
function secProfile(P, c) {
  const V = c.V;
  if (!V) { P.innerHTML = sh("Profile") + `<div class="panel"><div class="body"><p style="margin-top:0">${esc(c.about || "No description in the source data.")}</p><p class="src">Source: <a href="${esc(c.src)}" target="_blank" rel="noopener">${c.mk === "IN" ? "screener.in" : "stockanalysis.com"}</a></p><p class="note small">Stocks added from the Finder show source figures only. Verified supplier, plant and history details exist for the 20 core companies.</p></div></div>`; return; }
  const pr = c.profile || {};
  const facts = [...V.facts.filter(f => !/^CEO$/.test(f[0]) || !pr.ceo), ...(pr.ceo ? [["CEO (per filings profile)", pr.ceo, "SA"]] : []), ...(pr.employees ? [["Employees", pr.employees, "SA"]] : []), ...(pr.ipo ? [["IPO date", pr.ipo, "SA"]] : [])];
  P.innerHTML = sh("Profile", "Every item links to its source") + `<div class="grid g2">
    <div class="panel"><div class="body"><p style="margin-top:0">${esc(V.desc[0])} ${SRCLINK(c, V.desc[1])}</p>${c.note ? `<p class="note warn small">${esc(c.note)}</p>` : ""}
      <ul class="list">${facts.map(f => `<li><span class="muted small">${esc(f[0])}</span><span style="text-align:right">${esc(f[1])} ${SRCLINK(c, f[2])}</span></li>`).join("")}</ul>
      <div style="margin-top:10px"><h3 style="margin-bottom:6px">Businesses &amp; segments</h3><div class="chips">${V.seg.map(s => `<span>${esc(s[0])}</span>`).join("")}</div><div style="margin-top:4px">${[...new Set(V.seg.map(s => s[1]))].map(k => SRCLINK(c, k)).join(" · ")}</div></div></div></div>
    <div class="panel"><header><h2>Timeline</h2></header><div class="body"><ul class="list">${V.hist.map(h => `<li><div class="l"><span class="mono small muted">${esc(h[0])}</span> ${esc(h[1])}</div>${SRCLINK(c, h[2])}</li>`).join("")}</ul></div></div>
    ${c.fpos?.length || c.fneg?.length ? `<div class="panel"><header><h2>Data flags</h2><span class="muted small">screener.in, computed from reported figures</span></header><div class="body"><ul class="list">${(c.fpos || []).map(r => `<li><span><span class="pos">+</span> ${esc(r)}</span></li>`).join("")}${(c.fneg || []).map(r => `<li><span><span class="neg">−</span> ${esc(r)}</span></li>`).join("")}</ul></div></div>` : ""}
  </div>`;
}
function secPred(P, c, A) {
  if (!A) { P.innerHTML = sh("Prediction") + `<p class="empty">Not enough price history to run the model.</p>`; return; }
  let H = 52;
  const draw = () => {
    const B = H === 52 ? A : Q.analyse(c, { H, paths: 6000, W }), mc = B.mc, f = mc.fan[mc.fan.length - 1], bh = BACKTEST.byH?.[String(H)];
    P.innerHTML = sh("Prediction", "Point-in-time model, calibrated on past data · not investment advice") + `
    <div class="panel"><header><h2>Price distribution in ${H} weeks</h2><span class="r seg" id="hz">${[13, 26, 52].map(x => `<button data-h="${x}" aria-pressed="${x === H}">${x} wks</button>`).join("")}</span></header><div class="body">
      ${timeChart({ c, hist: c.wk.slice(-104), fan: mc.fan, H, refs: [B.fv.fv ? { v: B.fv.fv, cls: "ref", label: "model fair value " + px(B.fv.fv, c) } : null, c.tgt ? { v: c.tgt, cls: "ref2", label: "analyst target " + px(c.tgt, c) } : null].filter(Boolean) })}
      <div class="legend"><span><i style="border-color:var(--text)"></i>Price, last 2 years</span><span><i style="border-color:var(--accent);border-top-style:dashed"></i>Median path</span><span><i style="border-color:var(--accent);opacity:.4;border-top-width:8px"></i>50% / 90% ranges</span>${B.fv.fv ? `<span><i style="border-color:var(--c2)"></i>Fair value (information only)</span>` : ""}${c.tgt ? `<span><i style="border-color:var(--c3);border-top-style:dashed"></i>Analyst target (not used)</span>` : ""}</div>
      <div class="result" style="margin-top:12px">
        <div><div class="k">Median price</div><div class="v">${px(mc.median, c)}</div><div class="s ${cls(mc.median / c.px - 1)}">${pct(mc.median / c.px - 1)}</div></div>
        <div><div class="k">50% range</div><div class="v small">${px(f.p25, c)} – ${px(f.p75, c)}</div><div class="s">held ${pct(bh?.in50, 0, false)} of the time in backtests</div></div>
        <div><div class="k">90% range</div><div class="v small">${px(f.p05, c)} – ${px(f.p95, c)}</div><div class="s">held ${pct(bh?.in90, 0, false)} in backtests</div></div>
        <div><div class="k">Probability of a gain</div><div class="v">${pct(mc.pUp, 0, false)}</div><div class="s">direction calls right ${pct(bh?.dir, 0, false)} in backtests</div></div>
        <div><div class="k">Bad case (CVaR 95%)</div><div class="v neg">−${(mc.cvar95 * 100).toFixed(0)}%</div><div class="s">average of the worst 5% of paths</div></div>
        <div><div class="k">Volatility used</div><div class="v">${pct(B.vol, 0, false)}</div><div class="s">GARCH forecast × κ ${x2(Q.CAL.kappaFor(H))}</div></div>
      </div>
      <p class="note small" style="margin-top:12px">Use this for the <b>range</b> of likely outcomes, which matched reality in backtests. It can't tell you whether the price will go up or down: direction calls were right about half the time.</p>
    </div></div>
    <div class="grid g2" style="margin-top:14px">
      <div class="panel"><header><h2>Score breakdown</h2><span class="muted small">0–100 profile, not a forecast</span></header><div class="body"><div id="nn"></div><div id="wsl" style="display:grid;gap:5px;margin-top:8px"></div><div style="margin-top:8px"><button class="btn sm" id="wres">Reset weights</button></div></div></div>
      <div class="panel"><header><h2>How this forecast is built</h2></header><div class="body">
        <div class="eq">d ln S = (μ − σₜ²/2) dt + σₜ dW
σₜ² = ω + α·εₜ₋₁² + β·σₜ₋₁²   (GARCH 1,1)</div>
        <ul class="list" style="margin-top:8px">
          <li><span class="muted small">Drift μ = risk-free + β × equity premium</span><span class="mono">${pct(B.dr.mu)}</span></li>
          <li><span class="muted small">Volatility drag σ²/2 (Itô)</span><span class="mono neg">−${(B.ito.drag * 100).toFixed(1)}%</span></li>
          <li><span class="muted small">GARCH α · β · persistence</span><span class="mono">${x2(B.G.alpha)} · ${x2(B.G.beta)} · ${x2(B.G.persist, 3)}</span></li>
          <li><span class="muted small">Volatility now / long-run</span><span class="mono">${pct(B.G.vNow, 0, false)} / ${pct(B.G.vLong, 0, false)}</span></li>
          <li><span class="muted small">Simulation</span><span class="mono">${mc.N.toLocaleString()} paths · bootstrapped residuals</span></li>
        </ul>
        <details class="more"><summary>Signals tested but not used</summary>
          <p class="small muted">Adding these to the drift made backtests worse (Brier ${x2(BACKTEST.variants.full.brier, 3)} vs ${x2(BACKTEST.variants.capm.brier, 3)} with CAPM only), so they are shown for information only.</p>
          <table><tbody>${B.drAll.sig.map(s => `<tr><td class="t">${esc(s.k)}<div class="faint small">${esc(s.note)}</div></td><td class="${cls(s.mu)}">${pct(s.mu)}</td></tr>`).join("")}</tbody></table>
          ${B.fv.comps.length ? `<h3 style="margin:10px 0 4px">Fair value methods</h3><table><tbody>${B.fv.comps.map(x => `<tr><td class="t">${esc(x.k)}<div class="faint small">${esc(x.how)}</div></td><td>${px(x.v, c)}</td></tr>`).join("")}</tbody></table>` : ""}</details>
        <details class="more"><summary>Random-walk tests, regime, options, technicals</summary><table><tbody>
            <tr><td class="t">Verdict</td><td class="t">${esc(B.rw.verdict)}</td></tr>
            <tr><td class="t">Variance ratio VR(2) · z</td><td>${x2(B.rw.vr2.VR)} · ${x2(B.rw.vr2.z)}</td></tr>
            <tr><td class="t">Runs test z</td><td>${x2(B.rw.runsZ)}</td></tr>
            <tr><td class="t">Hurst exponent</td><td>${x2(B.rw.hurst)}</td></tr>
            <tr><td class="t">Skew · excess kurtosis</td><td>${x2(B.rw.skew)} · ${x2(B.rw.kurt)}</td></tr>
            <tr><td class="t">P(calm regime next week), HMM</td><td>${pct(B.reg.pCalmNext, 0, false)}</td></tr>
            <tr><td class="t">3-month at-the-money call · put</td><td>${px(B.bs.call, c)} · ${px(B.bs.put, c)}</td></tr>
            <tr><td class="t">N(d₂), risk-neutral P(up) in 3 m</td><td>${pct(B.bs.pQ, 0, false)}</td></tr>
            <tr><td class="t">RSI · MACD histogram · vs 200-day</td><td>${x2(B.tech.rsi, 0)} · ${x2(B.tech.macdHist)} · ${pct(B.tech.above200)}</td></tr>
          </tbody></table></details>
      </div></div>
    </div>`;
    $("#hz").onclick = e => { const b = e.target.closest("button"); if (!b) return; H = +b.dataset.h; draw(); };
    drawNN(c, A); drawSliders(c);
  };
  draw();
}
function drawNN(c, A) {
  const F = A.F6, keys = Object.keys(FN), ins = []; keys.forEach(k => F[k].in.forEach(x => ins.push({ k, x })));
  const Wd = 600, H = Math.max(280, ins.length * 22 + 20), x0 = 210, x1 = 410, x2c = 550, yi = i => 14 + i * ((H - 28) / (ins.length - 1)), yf = i => 26 + i * ((H - 52) / (keys.length - 1)), yo = H / 2;
  const fv = x => x[2] === "pct" ? pct(x[1], 0) : x[2] === "pp" ? pct(x[1], 0, false) : x[2] === "x" ? (x[1] == null ? "n/a" : x2(x[1], 2)) : x2(x[1], 1);
  const col = s => `var(--s${s >= 68 ? 5 : s >= 57 ? 4 : s >= 45 ? 3 : s >= 34 ? 2 : 1})`, tot = Object.values(W).reduce((a, b) => a + b, 0);
  let s = `<svg class="chart nn" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Score network: inputs feed six factors that feed the score">`;
  ins.forEach((it, i) => { const fi = keys.indexOf(it.k); s += `<path class="edge" d="M${x0},${yi(i)} C${(x0 + x1) / 2},${yi(i)} ${(x0 + x1) / 2},${yf(fi)} ${x1},${yf(fi)}" style="stroke:${col(F[it.k].s)};stroke-opacity:.45" stroke-width="1.1"/>`; });
  keys.forEach((k, i) => { s += `<path class="edge" d="M${x1},${yf(i)} C${(x1 + x2c) / 2},${yf(i)} ${(x1 + x2c) / 2},${yo} ${x2c},${yo}" style="stroke:${col(F[k].s)};stroke-opacity:.8" stroke-width="${(1 + W[k] / tot * 20).toFixed(1)}"/>`; });
  ins.forEach((it, i) => { s += `<circle cx="${x0}" cy="${yi(i)}" r="3.5" style="fill:var(--surface);stroke:var(--line2)"/><text x="${x0 - 8}" y="${yi(i) + 3}" text-anchor="end" style="fill:var(--text);font-size:10.5px">${esc(it.x[0])} <tspan style="fill:var(--muted);font-family:var(--mono)">${esc(fv(it.x))}</tspan></text>`; });
  keys.forEach((k, i) => { s += `<circle cx="${x1}" cy="${yf(i)}" r="14" style="fill:var(--surface);stroke:${col(F[k].s)}" stroke-width="2"/><text x="${x1}" y="${yf(i) + 4}" text-anchor="middle" style="fill:var(--text);font-size:10.5px">${F[k].s.toFixed(0)}</text><text x="${x1 + 19}" y="${yf(i) - 9}" style="fill:var(--muted);font-size:10px">${FN[k]}</text>`; });
  s += `<circle cx="${x2c}" cy="${yo}" r="24" style="fill:var(--surface);stroke:${col(A.score)}" stroke-width="3"/><text x="${x2c}" y="${yo + 5}" text-anchor="middle" style="fill:var(--text);font-size:15px;font-weight:600">${A.score.toFixed(0)}</text></svg>`;
  $("#nn").innerHTML = s;
}
function drawSliders(c) {
  $("#wsl").innerHTML = Object.keys(FN).map(k => `<label class="slider" for="w-${k}"><span>${FN[k]}</span><input id="w-${k}" type="range" min="0" max="40" value="${Math.round(W[k] * 100)}" data-k="${k}"><span class="mono" id="wv-${k}">${Math.round(W[k] * 100)}</span></label>`).join("");
  $("#wsl").oninput = e => { const k = e.target.dataset.k; if (!k) return; W[k] = +e.target.value / 100; $("#wv-" + k).textContent = e.target.value; rescore(); try { localStorage.setItem("synapse.w", JSON.stringify(W)); } catch (x) {} drawNN(c, RES[c.id]); };
  $("#wres").onclick = () => { W = { ...Q.DEFAULT_W }; try { localStorage.removeItem("synapse.w"); } catch (x) {} rescore(); render(); };
}
function secFin(P, c) {
  const f = c.fin; if (!f?.y?.length) { P.innerHTML = sh("Financials") + `<p class="empty">No financial statements in the source data.</p>`; return; }
  const margin = f.np ? f.np.map((v, i) => fin(v) && fin(f.rev?.[i]) && f.rev[i] ? v / f.rev[i] : null) : null, growth = f.rev ? f.rev.map((v, i) => i && fin(v) && fin(f.rev[i - 1]) && f.rev[i - 1] > 0 ? v / f.rev[i - 1] - 1 : null) : null;
  const row = (k, a, fm = v => finFmt(v, c)) => a ? `<tr><td class="t">${k}</td>${a.map(v => `<td class="${v < 0 ? "neg" : ""}">${!fin(v) ? "—" : fm(v)}</td>`).join("")}</tr>` : "";
  P.innerHTML = sh("Financials", `${esc(f.u)} · source: <a href="${esc(c.src)}" target="_blank" rel="noopener">${c.mk === "IN" ? "screener.in (consolidated)" : "stockanalysis.com"}</a>`) + `
  <div class="panel"><div class="body">${finChart(c)}<div class="legend"><span><i style="border-color:var(--c1);border-top-width:8px"></i>Revenue</span><span><i style="border-color:var(--c2);border-top-width:8px"></i>Net profit</span></div></div></div>
  <div class="panel" style="margin-top:14px"><div class="body flush tbl"><table><thead><tr><th class="t"></th>${f.y.map(y => `<th>${esc(y)}</th>`).join("")}</tr></thead><tbody>
    ${row("Revenue", f.rev)}${row("Operating income", f.op)}${row("Net profit", f.np)}${row("EPS", f.eps, v => x2(v, 2))}${f.opm ? row("Operating margin", f.opm, v => v + "%") : ""}${row("Net margin", margin, v => (v * 100).toFixed(1) + "%")}${row("Revenue growth", growth, v => pct(v, 0))}
    ${c.cfo ? `<tr><td class="t">Cash from operations</td>${f.y.map(y => { const i = c.cfo.y.indexOf(y); return `<td>${i >= 0 && fin(c.cfo.v[i]) ? finFmt(c.cfo.v[i], c) : "—"}</td>`; }).join("")}</tr>` : ""}
  </tbody></table></div></div>${c.mk !== "IN" ? `<p class="small faint">EPS history is net income ÷ current shares, scaled to the reported P/E, so older years ignore buybacks.</p>` : ""}`;
}
function secChain(P, c) {
  const V = c.V, CAT = [["sup", "Suppliers & inputs"], ["cus", "Customers & channels"], ["pla", "Plants & sites"], ["com", "Competitors & peers"], ["own", "Owners, subsidiaries & JVs"]];
  if (!V) { P.innerHTML = sh("Suppliers, plants & peers") + `<p class="empty">Verified relationship data covers the 20 core companies only.</p>`; return; }
  P.innerHTML = sh("Suppliers, plants & peers", "Only relationships a source states are listed") + `<div class="grid g2">${CAT.map(([k, n]) => { const items = V.net[k] || []; return `<div class="panel"><header><h2>${n}</h2><span class="muted small">${items.length}</span></header><div class="body">${items.length ? `<ul class="list">${items.map(it => { const isPla = k === "pla", srcKey = isPla ? it[3] : it[2], tk = isPla ? null : it[3]; return `<li><div class="l"><div class="nm">${tk && CO[tk] ? `<a href="#/c/${encodeURIComponent(tk)}">${esc(it[0])}</a>` : esc(it[0])}</div><div class="nt">${esc(isPla ? it[1] + " · " + it[2] : it[1])}</div></div><div style="text-align:right">${SRCLINK(c, srcKey)}${isPla ? `<div class="src"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it[0] + " " + it[1])}" target="_blank" rel="noopener">map</a></div>` : ""}</div></li>`; }).join("")}</ul>` : `<p class="empty">None named in the sources used. See the annual report.</p>`}</div></div>`; }).join("")}</div>`;
}
function secNews(P, c) {
  P.innerHTML = sh("News & filings") + `<div class="grid g2"><div class="panel"><header><h2>Latest</h2><span class="muted small">${c.mk === "IN" ? "BSE filings via screener.in" : "via stockanalysis.com"}</span></header><div class="body">${(c.news || []).length ? `<ul class="list">${c.news.map(n => `<li><div class="l"><a href="${esc(n.u)}" target="_blank" rel="noopener">${esc(n.t)}</a><div class="nt">${esc(n.s || "")}${n.d ? " · " + esc(n.d) : ""}</div></div></li>`).join("")}</ul>` : `<p class="empty">No headlines in the snapshot.</p>`}<p><a class="btn sm" href="https://news.google.com/search?q=${encodeURIComponent(c.nm + " stock")}" target="_blank" rel="noopener">Search Google News</a></p></div></div>
  <div class="panel"><header><h2>Reports &amp; filings</h2></header><div class="body"><ul class="list">${(c.docs || []).map(d => `<li><a href="${esc(d.u)}" target="_blank" rel="noopener">${esc(d.t)}</a></li>`).join("")}</ul></div></div></div>`;
}
function secNotes(P, c) {
  const nid = "co-" + safeId(c.id), note = STATE.notes.find(n => n.id === nid);
  P.innerHTML = sh("Notes", "Private to you") + `<div class="panel"><div class="body"><label class="small muted" for="cnote">Your notes on ${esc(c.nm)}</label><textarea id="cnote" placeholder="Why you bought it, what to watch, price levels…">${esc(note?.body || "")}</textarea><div class="small faint" id="cnst">${note ? "Saved" : ""}</div></div></div>`;
  let t = null;
  $("#cnote").addEventListener("input", e => { clearTimeout(t); $("#cnst").textContent = "Saving…"; t = setTimeout(async () => { await Store.put("notes", { id: nid, title: c.nm, body: e.target.value, company: c.id, updated: new Date().toISOString() }); const s = $("#cnst"); if (s) s.textContent = "Saved"; }, 700); });
}
function buildWeb(c, A, hh) {
  const V = c.V, T = A?.tech, nodes = [], links = [];
  const tone = (v, g, b) => !fin(v) ? null : g(v) ? "pos" : b(v) ? "neg" : null;
  const M = (name, val, t, note) => ({ k: "metric", name, val, t, note: note || DEF[name] || "" });
  const groups = [];
  groups.push(["Valuation", "--c1", [M("Market cap", c.mcap || "—"), M("P/E", c.pe ? x2(c.pe, 1) : "n/a", tone(c.pe, v => v < 20, v => v > 40)), M("P/B", x2(c.pb), tone(c.pb, v => v < 2, v => v > 8)), M("Dividend yield", (c.dy || 0).toFixed(2) + "%", tone(c.dy || 0, v => v > 2, v => v === 0)), c.tgt ? M("Analyst target", px(c.tgt, c), tone(c.tgt / c.px - 1, v => v > 0.1, v => v < 0), c.cons || "") : null].filter(Boolean)]);
  groups.push(["Profitability", "--c2", [M("ROE", fin(c.roe) ? c.roe.toFixed(1) + "%" : "—", tone(c.roe, v => v > 15, v => v < 8)), fin(c.roce) ? M("ROCE", c.roce.toFixed(1) + "%", tone(c.roce, v => v > 15, v => v < 8)) : fin(c.roic) ? M("ROIC", c.roic.toFixed(1) + "%") : null, M("Debt / equity", x2(c.de), tone(c.de, v => v < 0.5, v => v > 1.5)), fin(c.npm) ? M("Net margin", c.npm.toFixed(1) + "%") : null].filter(Boolean)]);
  const f = c.fin, L = f?.y?.length ? f.y.length - 1 : -1;
  if (L >= 0) groups.push(["Financials", "--c6", [M("Revenue " + f.y[L], money(f.rev?.[L], c), null, "Latest reported revenue"), M("Net profit " + f.y[L], money(f.np?.[L], c), tone(f.np?.[L], v => v > 0, v => v < 0), "Latest reported net profit"), M("Revenue growth, 3 yr", pct(Q.cagr(f.rev, 3)) + "/yr", tone(Q.cagr(f.rev, 3), v => v > 0.1, v => v < 0))]]);
  if (A) groups.push(["Prediction, 52 wks", "--c4", [M("Score", A.score.toFixed(0) + " · " + A.label[0], null, "0–100 profile; not a return forecast"), M("Median price", px(A.mc.median, c), tone(A.mc.median / c.px - 1, v => v > 0.03, v => v < -0.03), "Middle of 6,000 simulated paths"), M("90% range", px(A.mc.p05, c) + " – " + px(A.mc.p95, c), null, "Backtest: held ~90% of the time"), M("Probability of gain", pct(A.mc.pUp, 0, false), null, "Direction calls were ~50% right in backtests"), M("Volatility", pct(A.vol, 0, false), tone(A.vol, v => v < 0.25, v => v > 0.45), "Annualised, GARCH")]]);
  if (T) groups.push(["Price & trend", "--c7", [M("52-week high", px(T.hi, c)), M("52-week low", px(T.lo, c)), M("1-year change", pct(T.ret52), tone(T.ret52, v => v > 0, v => v < 0)), M("vs 200-day average", pct(T.above200), tone(T.above200, v => v > 0, v => v < 0))]]);
  if (V) { const rel = (k, label, colv) => { const it = V.net[k] || []; if (it.length) groups.push([label, colv, it.map(x => k === "pla" ? { k: "rel", name: x[0], note: x[1] + " · " + x[2], src: x[3] } : { k: "rel", name: x[0], note: x[1], src: x[2], tk: x[3] })]); };
    rel("sup", "Suppliers & inputs", "--c3"); rel("cus", "Customers & channels", "--c2"); rel("pla", "Plants & sites", "--c4"); rel("com", "Competitors & peers", "--c5"); rel("own", "Owners & subsidiaries", "--c3"); }
  if (c.news?.length) groups.push(["News", "--c7", c.news.slice(0, 5).map(n => ({ k: "news", name: n.t, note: (n.s || "") + (n.d ? " · " + n.d : ""), u: n.u }))]);
  if (hh) groups.push(["Your position", "--c4", [M("Quantity", String(hh.q)), M("Average cost", px(hh.avg, c)), M("P&L", inrS(hh.pl) + " (" + pct(hh.pl / hh.cost) + ")", tone(hh.pl, v => v > 0, v => v < 0))]]);
  $("#wl").innerHTML = groups.map(g => `<span><i style="background:var(${g[1]})"></i>${esc(g[0])}</span>`).join("");
  const dirs = fib(groups.length), nrm = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); }, cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  nodes.push({ id: "center", pos: [0, 0, 0], size: 1.5, color: css("--accent"), label: esc(c.tk), lcls: "center", meta: { k: "center" } });
  groups.forEach(([gname, colv, items], gi) => {
    const col = css(colv), d = nrm(dirs[gi]), hubId = "h" + gi;
    nodes.push({ id: hubId, pos: d.map(x => x * 13), size: 0.55, color: col, label: esc(gname), lcls: "hub", meta: { k: "hub", name: gname, items } });
    links.push({ a: "center", b: hubId, o: 0.9 });
    const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], u = nrm(cross(d, up)), v = nrm(cross(d, u)), rr = items.length === 1 ? 0 : Math.min(6.5, 2.4 + items.length * 0.55);
    items.forEach((it, i) => {
      const ang = i / items.length * Math.PI * 2 + gi * 0.7, p = [0, 1, 2].map(j => d[j] * 22 + u[j] * Math.cos(ang) * rr + v[j] * Math.sin(ang) * rr), short = s => s.length > 28 ? s.slice(0, 26) + "…" : s;
      const label = it.k === "metric" ? `${esc(short(it.name))} <span class="v ${it.t || ""}">${esc(it.val)}</span>` : esc(short(it.name));
      nodes.push({ id: hubId + "_" + i, parent: hubId, pos: p, size: it.tk && CO[it.tk] ? 0.5 : 0.36, color: it.t === "pos" ? css("--pos") : it.t === "neg" ? css("--neg") : col, label, meta: { ...it, group: gname } });
      links.push({ a: hubId, b: hubId + "_" + i, o: 0.7 });
    });
  });
  const web = new Web3D($("#web"), {
    nodes, links,
    tip: n => { const m = n.meta; if (m.k === "center") return `<b>${esc(c.nm)}</b>`; if (m.k === "hub") return `<b>${esc(m.name)}</b> · ${m.items.length}`; return `<b>${esc(m.name)}</b>${m.val ? `: ${esc(m.val)}` : ""}<br><span class="muted">${esc(m.note || m.group)}</span>`; },
    onPick: n => { web.select(n.id); showNode(n, c); }
  });
  if (web.ok) {
    $("#zin").onclick = () => web.zoom(0.87); $("#zout").onclick = () => web.zoom(1.15); $("#wreset").onclick = () => web.reset();
    $("#wauto").onclick = e => { web.auto = !web.auto; e.currentTarget.setAttribute("aria-pressed", web.auto); };
    cleanup.push(() => web.destroy());
  } else $$(".webctl").forEach(x => x.hidden = true);
}
function showNode(n, c) {
  const m = n.meta, el = $("#nodecard"), src = m.src ? SRCLINK(c, m.src) : "";
  if (m.k === "center") { el.innerHTML = `<div class="cat">Company</div><h4>${esc(c.nm)}</h4><p class="small">${esc(c.V?.desc[0] || c.about || "")}</p>`; return; }
  if (m.k === "hub") { el.innerHTML = `<div class="cat">Branch</div><h4>${esc(m.name)}</h4><ul class="list">${m.items.map(it => `<li><span class="small">${esc(it.name)}</span><span class="mono small">${esc(it.val || "")}</span></li>`).join("")}</ul>`; return; }
  const tk = m.tk && CO[m.tk] ? CO[m.tk] : null;
  el.innerHTML = `<div class="cat">${esc(m.group)}</div><h4>${esc(m.name)}</h4>${m.val ? `<div class="mono" style="font-size:20px;margin:2px 0 6px">${esc(m.val)}</div>` : ""}<p class="small muted">${esc(m.note || "")}</p>${src ? `<p class="small">Source: ${src}</p>` : m.k === "metric" ? `<p class="src">Source: ${m.group.startsWith("Prediction") ? "model output" : m.group === "Your position" ? "your orders" : `<a href="${esc(c.src)}" target="_blank" rel="noopener">${c.mk === "IN" ? "screener.in" : "stockanalysis.com"}</a>`}</p>` : ""}${m.u ? `<p><a class="btn sm" href="${esc(m.u)}" target="_blank" rel="noopener">Open article</a></p>` : ""}${tk ? `<p><a class="btn sm primary" href="#/c/${encodeURIComponent(tk.id)}">Open ${esc(tk.nm)}</a></p>` : ""}`;
}

// ═════════════════════════════ Ask Claude ═════════════════════════════
let sampleFn; const sampleReady = (async () => { try { sampleFn = await window.claude?.use?.("sample"); } catch (e) { sampleFn = null; } return sampleFn; })();
function secAsk(P, c, A) {
  const sug = [`How does ${c.tk} make money?`, "What are the biggest risks?", "Explain the valuation in plain words", "What should I watch in the next results?"];
  P.innerHTML = sh("Ask Claude") + `<div class="panel ask"><div class="body"><p class="small muted" style="margin-top:0">Claude sees this page's figures, sources and model output, plus its own background knowledge. It can't browse the web, so check important answers against the linked sources.</p>
    <div class="sugg">${sug.map(s => `<button type="button">${esc(s)}</button>`).join("")}</div>
    <form id="askf"><label class="small muted" for="askq">Question</label><textarea id="askq" style="min-height:70px"></textarea><div style="display:flex;gap:8px;margin-top:8px"><button class="btn primary" id="askb" type="submit">Ask</button><button class="btn" id="asks" type="button" hidden>Stop</button></div></form>
    <div class="out" id="askout" aria-live="polite">Answers appear here.</div></div></div>`;
  P.querySelectorAll(".sugg button").forEach(b => b.onclick = () => { $("#askq").value = b.textContent; $("#askf").requestSubmit(); });
  let ctl = null; $("#asks").onclick = () => ctl?.abort();
  $("#askf").onsubmit = async e => {
    e.preventDefault(); const q = $("#askq").value.trim(); if (!q) return;
    const out = $("#askout"), b = $("#askb"), s = $("#asks"), fn = await sampleReady;
    if (!fn) { out.textContent = "Asking Claude works when this page is opened inside Claude."; return; }
    ctl = new AbortController(); b.disabled = true; s.hidden = false; out.textContent = "Thinking…";
    const ctx = { company: c.nm, ticker: c.tk, price: c.px, currency: c.cur, asOf: c.asof, marketCap: c.mcap, pe: c.pe, pb: c.pb, roe: c.roe, debtToEquity: c.de, dividendYield: c.dy, analystTarget: c.tgt, financials: c.fin, verifiedFacts: c.V ? { description: c.V.desc[0], facts: c.V.facts, segments: c.V.seg.map(x => x[0]), relationships: c.V.net, timeline: c.V.hist } : { description: c.about }, news: (c.news || []).map(n => n.d + ": " + n.t), model: A ? { score: +A.score.toFixed(1), median52w: A.mc.median, range90: [A.mc.p05, A.mc.p95], probGain: A.mc.pUp, backtestNote: "ranges calibrated; direction calls ~51% (no skill)" } : null };
    const prompt = `You are an equity research assistant in a stock dashboard. Today is 20 October 2026. Answer about ${c.nm} (${c.tk}) using the DATA first and background knowledge second; say clearly when something is not in the data or may be outdated. Do not give personal buy/sell instructions; explain trade-offs. Under 220 words, plain English.\n\nDATA:\n${JSON.stringify(ctx)}\n\nQUESTION: ${q}`;
    try { await fn(prompt, { signal: ctl.signal, onText: ({ text }) => { out.textContent = text; } }); }
    catch (err) { if (err?.code === "cancelled") { if (!err.text) out.textContent = "Stopped."; } else out.textContent = (err?.text ? err.text + "\n\n" : "") + ({ not_granted: "Claude access wasn't allowed for this page.", rate_limited: "Too many questions in a short time. Try again in a minute." }[err?.code] || "Claude couldn't answer just now. Try again."); }
    finally { b.disabled = false; s.hidden = true; ctl = null; }
  };
}

// ═════════════════════════════ ORDERS ═════════════════════════════
let orderFilter = "all";
function vOrders(M) {
  const P = portfolio(), pre = route.q.add || "";
  const syms = [...new Set([...CORE.filter(c => c.mk === "IN").map(c => c.tk), ...STATE.orders.map(o => o.sym)])].sort();
  const rows = STATE.orders.slice().sort((a, b) => b.date.localeCompare(a.date)).filter(o => orderFilter === "all" || o.status === orderFilter);
  M.innerHTML = `<div class="pagehead"><div><h1>Orders &amp; positions</h1><div class="sub">Holdings, average cost and P&amp;L are calculated from executed orders using the average-cost method. Change an order's status if it's wrong.</div></div></div>
  <div class="panel"><header><h2>Add an order</h2><span class="muted small">Record every buy or sell here</span></header><div class="body">
    <form id="of" class="form">
      <div class="field"><label for="o-date">Date</label><input id="o-date" type="date" required value="${today()}"></div>
      <div class="field"><label for="o-sym">Stock (NSE symbol)</label><input id="o-sym" list="o-syms" required value="${esc(pre)}" placeholder="e.g. RELIANCE" autocomplete="off"><datalist id="o-syms">${syms.map(s => `<option value="${esc(s)}">`).join("")}</datalist></div>
      <div class="field"><label for="o-side">Buy or sell</label><select id="o-side"><option>Buy</option><option>Sell</option></select></div>
      <div class="field"><label for="o-qty">Quantity</label><input id="o-qty" type="number" min="1" step="1" required></div>
      <div class="field"><label for="o-price">Price per share (₹)</label><input id="o-price" type="number" min="0.01" step="0.01" required></div>
      <div class="field"><label for="o-kind">Type</label><select id="o-kind"><option>Delivery</option><option>Intraday</option><option>IPO allotment</option><option>Corporate action</option></select></div>
      <div class="field"><label for="o-status">Status</label><select id="o-status"><option value="executed">Executed</option><option value="not_executed">Not executed</option><option value="unknown">Unknown</option></select></div>
      <div class="field"><label for="o-note">Note (optional)</label><input id="o-note" autocomplete="off"></div>
      <div class="field"><button class="btn primary" type="submit">Save order</button></div>
    </form><div class="small" id="omsg" role="status"></div></div></div>
  <div class="stack" style="margin-top:14px">
    <div class="panel"><header><h2>Open positions</h2></header><div class="body flush tbl">${holdingsTable(P)}</div></div>
    <div class="panel"><header><h2>Realised P&amp;L</h2><span class="r mono ${cls(P.realised)}">${inrS(P.realised)}</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Stock</th><th>Realised</th></tr></thead><tbody>${[...P.closed, ...P.open].filter(x => Math.abs(x.realised) > 0.005).map(x => `<tr><td class="t">${esc(x.name)} <span class="faint">${esc(x.sym)}</span></td><td class="${cls(x.realised)}">${inrS(x.realised)}</td></tr>`).join("") || `<tr><td class="t muted" colspan="2">None yet</td></tr>`}</tbody></table></div></div>
  </div>
  <div class="panel" style="margin-top:14px"><header><h2>Order book</h2><span class="muted small">${STATE.orders.length} orders</span><span class="r seg" id="of2">${[["all", "All"], ["executed", "Executed"], ["not_executed", "Not executed"], ["unknown", "Unknown"]].map(([k, n]) => `<button data-f="${k}" aria-pressed="${orderFilter === k}">${n}</button>`).join("")}</span></header>
    <div class="body flush tbl"><table><thead><tr><th class="t">Date</th><th class="t">Stock</th><th class="t">Type</th><th class="t">Side</th><th>Qty</th><th>Price</th><th>Value</th><th class="t">Status</th><th class="t">Note</th><th></th></tr></thead><tbody>
    ${rows.map(o => `<tr><td class="t mono">${esc(o.date)}</td><td class="t"><b>${esc(o.sym)}</b> <span class="faint small">${esc(o.name || "")}</span></td><td class="t small">${esc(o.kind)}</td><td class="t ${o.side === "Buy" ? "pos" : "neg"}">${esc(o.side)}</td><td>${o.qty}</td><td>₹${(+o.price).toFixed(2)}</td><td>${inr(o.qty * o.price)}</td>
      <td class="t"><select data-st="${esc(o.id)}" aria-label="Status of ${esc(o.sym)} order on ${esc(o.date)}" style="font-size:12px;padding:2px 4px;border:1px solid var(--line2);border-radius:3px;background:var(--surface)">${[["executed", "Executed"], ["not_executed", "Not executed"], ["unknown", "Unknown"]].map(([v, n]) => `<option value="${v}" ${o.status === v ? "selected" : ""}>${n}</option>`).join("")}</select></td>
      <td class="t small muted" style="max-width:300px">${esc(o.note || "")}</td><td><button class="btn sm" data-del="${esc(o.id)}">Delete</button></td></tr>`).join("")}</tbody></table></div></div>
  `;
  $("#of").onsubmit = async e => {
    e.preventDefault(); const sym = $("#o-sym").value.trim().toUpperCase(), c = CO[sym] || companyForSym(sym), msg = $("#omsg");
    const o = { date: $("#o-date").value, sym, name: c?.nm || STATE.orders.find(x => x.sym === sym)?.name || sym, kind: $("#o-kind").value, side: $("#o-side").value, qty: +$("#o-qty").value, price: +$("#o-price").value, status: $("#o-status").value, note: $("#o-note").value, source: "manual", created: new Date().toISOString() };
    if (!o.date || !sym || !(o.qty > 0) || !(o.price > 0)) { msg.className = "small neg"; msg.textContent = "Fill in the date, stock, quantity and price."; return; }
    if (o.side === "Sell" && o.status === "executed") { const pos = portfolio().open.find(p => p.sym === sym); if (!pos || pos.q < o.qty) { msg.className = "small neg"; msg.textContent = `You hold ${pos?.q || 0} ${sym}, so selling ${o.qty} would go below zero. Check the quantity.`; return; } }
    await Store.put("orders", o); msg.className = "small pos"; msg.textContent = `Saved: ${o.side} ${o.qty} ${sym} at ₹${o.price.toFixed(2)}.`;
    if (STATE.mode === "cloud") setTimeout(() => render(), 300);
  };
  $("#of2").onclick = e => { const b = e.target.closest("button"); if (!b) return; orderFilter = b.dataset.f; render(); };
  $$("select[data-st]", M).forEach(s => s.onchange = () => { const o = STATE.orders.find(x => x.id === s.dataset.st); if (o) Store.put("orders", { ...o, status: s.value }); });
  $$("button[data-del]", M).forEach(b => { let armed = false; b.onclick = () => { if (!armed) { armed = true; b.textContent = "Confirm"; b.classList.add("primary"); setTimeout(() => { if (b.isConnected) { armed = false; b.textContent = "Delete"; b.classList.remove("primary"); } }, 3000); return; } Store.del("orders", b.dataset.del); }; });
}

// ═════════════════════════════ SIMULATOR ═════════════════════════════
function simEvaluate(s) {
  const c = CO[s.cid] || (UNI && s.cid.includes(":") ? uniCompany(s.cid) : null); if (!c) return { ...s, pending: true };
  const last = c.wd[c.wd.length - 1];
  if (s.end > last) return { ...s, pending: true };
  const i1 = Q.idxAtOrBefore(c, s.end), a = c.wk[i1];
  return { ...s, pending: false, actual: a, actualDate: c.wd[i1], in50: a >= s.p25 && a <= s.p75, in90: a >= s.p05 && a <= s.p95, dirHit: (s.pUp >= 0.5) === (a >= s.buyPx), err: s.median / a - 1, pnlActual: s.shares * (a - s.buyPx) };
}
function vSim(M) {
  const list = allTracked().sort((a, b) => a.nm.localeCompare(b.nm)), pre = route.q.c && CO[route.q.c] ? route.q.c : (list[0]?.id || "");
  const sims = STATE.sims.map(simEvaluate).sort((a, b) => (b.created || "").localeCompare(a.created || ""));
  const done = sims.filter(s => !s.pending), S = done.length ? { n: done.length, in50: done.filter(s => s.in50).length / done.length, in90: done.filter(s => s.in90).length / done.length, dir: done.filter(s => s.dirHit).length / done.length, med: done.map(s => Math.abs(s.err)).sort((a, b) => a - b)[Math.floor(done.length / 2)] } : null;
  M.innerHTML = `<div class="pagehead"><div><h1>Trade simulator</h1><div class="sub">Pick a stock, a quantity and two dates. The model forecasts the end-date price using <b>only data available on the buy date</b>, then compares the forecast with what actually happened.</div></div></div>
  <div class="panel"><header><h2>New simulation</h2></header><div class="body">
    <form id="sf" class="form">
      <div class="field"><label for="s-c">Company</label><select id="s-c">${list.map(c => `<option value="${esc(c.id)}" ${c.id === pre ? "selected" : ""}>${esc(c.nm)} (${esc(c.tk)})</option>`).join("")}</select></div>
      <div class="field"><label for="s-q">Shares</label><input id="s-q" type="number" min="1" step="1" value="10" required></div>
      <div class="field"><label for="s-b">Buy date</label><input id="s-b" type="date" required><span class="hint" id="s-bh"></span></div>
      <div class="field"><label for="s-e">End date</label><input id="s-e" type="date" required><span class="hint">Past dates are scored now. Future dates are saved and scored once the data covers them.</span></div>
      <div class="field"><button class="btn primary" type="submit" id="s-go">Run simulation</button></div>
    </form></div></div>
  <div id="sres" style="margin-top:14px"></div>
  <div class="panel" style="margin-top:14px"><header><h2>Simulation log</h2><span class="muted small">${sims.length} saved · private to you</span></header><div class="body">
    ${S ? `<div class="result" style="margin-bottom:12px"><div><div class="k">Scored simulations</div><div class="v">${S.n}</div></div><div><div class="k">Inside 50% range</div><div class="v">${pct(S.in50, 0, false)}</div><div class="s">well calibrated ≈ 50%</div></div><div><div class="k">Inside 90% range</div><div class="v">${pct(S.in90, 0, false)}</div><div class="s">well calibrated ≈ 90%</div></div><div><div class="k">Direction right</div><div class="v">${pct(S.dir, 0, false)}</div><div class="s">coin flip = 50%</div></div><div><div class="k">Median price error</div><div class="v">${pct(S.med, 1, false)}</div></div></div>` : ""}
    <div class="tbl"><table><thead><tr><th class="t">Run</th><th class="t">Stock</th><th>Shares</th><th class="t">Buy → end</th><th>Buy price</th><th>Predicted median</th><th>90% range</th><th>Actual</th><th>Error</th><th class="t">Result</th><th></th></tr></thead><tbody>
    ${sims.map(s => { const c = CO[s.cid] || { cur: s.cur || "₹" }; return `<tr><td class="t small mono">${esc((s.created || "").slice(0, 10))}</td><td class="t">${esc(s.name)}</td><td>${s.shares}</td><td class="t small mono">${esc(s.buyUsed)} → ${esc(s.end)}</td><td>${px(s.buyPx, c)}</td><td>${px(s.median, c)}</td><td class="small">${px(s.p05, c)} – ${px(s.p95, c)}</td><td>${s.pending ? `<span class="faint">waiting</span>` : px(s.actual, c)}</td><td>${s.pending ? "—" : pct(s.err, 1)}</td><td class="t">${s.pending ? `<span class="badge">pending</span>` : `<span class="badge ${s.in90 ? "ok" : "no"}">${s.in90 ? "in 90%" : "outside 90%"}</span> <span class="badge ${s.dirHit ? "ok" : "no"}">direction ${s.dirHit ? "✓" : "✗"}</span>`}</td><td><button class="btn sm" data-sdel="${esc(s.id)}">Delete</button></td></tr>`; }).join("") || `<tr><td class="t muted" colspan="11">No simulations saved yet.</td></tr>`}</tbody></table></div></div></div>
  <p class="small faint">For comparison, the model's walk-forward test over ${BACKTEST.n.toLocaleString()} predictions: ${pct(BACKTEST.all.in90, 0, false)} inside the 90% range, ${pct(BACKTEST.all.in50, 0, false)} inside the 50% range, direction right ${pct(BACKTEST.all.dir, 0, false)}. <a href="#/model">Full report</a></p>`;
  const sel = $("#s-c"), b = $("#s-b"), e = $("#s-e");
  const setBounds = () => { const c = CO[sel.value]; if (!c) return; const minI = Math.min(60, c.wd.length - 2); b.min = c.wd[minI]; b.max = c.wd[c.wd.length - 2]; e.max = "2028-12-31"; if (!b.value || b.value < b.min || b.value > b.max) b.value = c.wd[Math.max(minI, c.wd.length - 53)]; if (!e.value || e.value <= b.value) e.value = c.wd[c.wd.length - 1]; e.min = b.value; $("#s-bh").textContent = `From ${fmtDate(b.min)} (needs about a year of history first)`; };
  sel.onchange = setBounds; b.onchange = () => { e.min = b.value; }; setBounds();
  $("#sf").onsubmit = async ev => {
    ev.preventDefault(); const c = CO[sel.value], q = +$("#s-q").value; if (!c || !(q > 0)) return;
    const i0 = Q.idxAtOrAfter(c, b.value); if (i0 < 30) { $("#sres").innerHTML = `<p class="note warn">Not enough price history before that date.</p>`; return; }
    const last = c.wd[c.wd.length - 1], d0 = c.wd[i0], past = e.value <= last;
    const i1 = past ? Q.idxAtOrBefore(c, e.value) : -1;
    if (past && i1 <= i0) { $("#sres").innerHTML = `<p class="note warn">The end date must be at least a week after the buy date.</p>`; return; }
    const H = past ? i1 - i0 : Math.max(1, Math.round((Date.parse(e.value) - Date.parse(d0)) / (7 * 864e5)));
    $("#s-go").disabled = true; $("#sres").innerHTML = `<div class="panel"><div class="body"><p class="muted" style="margin:0">Simulating 10,000 price paths…</p></div></div>`;
    await new Promise(r => setTimeout(r, 30));
    const A = Q.analyse(c, { idx: i0, H, paths: 10000 }); $("#s-go").disabled = false;
    if (!A) { $("#sres").innerHTML = `<p class="note warn">The model could not run for this date.</p>`; return; }
    const mc = A.mc, rec = { cid: c.id, name: c.nm, cur: c.cur, shares: q, buy: b.value, buyUsed: d0, buyPx: A.px, end: past ? c.wd[i1] : e.value, H, median: mc.median, p05: mc.p05, p25: mc.p25, p75: mc.p75, p95: mc.p95, pUp: mc.pUp, mu: A.dr.mu, vol: A.vol, created: new Date().toISOString(), model: "v2" };
    $("#sres").innerHTML = simResult(c, A, simEvaluate(rec), i0, i1);
    $("#ssave").onclick = async () => { $("#ssave").disabled = true; $("#ssave").textContent = "Saved"; await Store.put("sims", rec); };
  };
  $$("button[data-sdel]", M).forEach(bt => bt.onclick = () => Store.del("sims", bt.dataset.sdel));
}
function simResult(c, A, s, i0, i1) {
  const mc = A.mc, hist = c.wk.slice(Math.max(0, i0 - 103), i0 + 1), actual = i1 > i0 ? c.wk.slice(i0, i1 + 1) : null;
  const pl = p => s.shares * (p - A.px);
  return `<div class="panel"><header><h2>${esc(c.nm)} · ${s.shares} shares · ${fmtDate(s.buyUsed)} → ${fmtDate(s.end)}</h2><span class="r"><button class="btn primary sm" id="ssave">Save to log</button></span></header><div class="body">
    ${timeChart({ c, hist, fan: mc.fan, H: s.H, actual })}
    <div class="legend"><span><i style="border-color:var(--text)"></i>Known on the buy date</span><span><i style="border-color:var(--accent);border-top-style:dashed"></i>Model median</span><span><i style="border-color:var(--accent);opacity:.4;border-top-width:8px"></i>50% / 90% ranges</span>${actual ? `<span><i style="border-color:var(--c4)"></i>What actually happened</span>` : ""}</div>
    <div class="result" style="margin-top:12px">
      <div><div class="k">Buy price (${fmtDate(s.buyUsed)})</div><div class="v">${px(A.px, c)}</div><div class="s">cost ${px(A.px * s.shares, c)}</div></div>
      <div><div class="k">Predicted median price</div><div class="v">${px(mc.median, c)}</div><div class="s">50% range ${px(mc.p25, c)} – ${px(mc.p75, c)}</div></div>
      <div><div class="k">Predicted P&amp;L (median)</div><div class="v ${cls(pl(mc.median))}">${px(pl(mc.median), c)}</div><div class="s">50% range ${px(pl(mc.p25), c)} to ${px(pl(mc.p75), c)}</div></div>
      <div><div class="k">Probability of profit</div><div class="v">${pct(mc.pUp, 0, false)}</div><div class="s">90% range ${px(mc.p05, c)} – ${px(mc.p95, c)}</div></div>
      ${s.pending ? `<div><div class="k">Actual result</div><div class="v faint">pending</div><div class="s">scored once data reaches ${fmtDate(s.end)}</div></div>` : `
      <div><div class="k">Actual price (${fmtDate(s.actualDate)})</div><div class="v">${px(s.actual, c)}</div><div class="s">landed at the ${pct(Q.percentileOf(mc.sorted, s.actual), 0, false)} point of the forecast</div></div>
      <div><div class="k">Actual P&amp;L</div><div class="v ${cls(s.pnlActual)}">${px(s.pnlActual, c)}</div><div class="s ${cls(s.actual / A.px - 1)}">${pct(s.actual / A.px - 1)}</div></div>
      <div><div class="k">Forecast vs actual</div><div class="v">${pct(s.err, 1)}</div><div class="s"><span class="badge ${s.in50 ? "ok" : "no"}">50% ${s.in50 ? "✓" : "✗"}</span> <span class="badge ${s.in90 ? "ok" : "no"}">90% ${s.in90 ? "✓" : "✗"}</span> <span class="badge ${s.dirHit ? "ok" : "no"}">direction ${s.dirHit ? "✓" : "✗"}</span></div></div>`}
    </div>
    <p class="small faint" style="margin-top:10px">Inputs stop at ${fmtDate(s.buyUsed)}: ${A.r.length} weekly returns${A.F.yrs.length ? `, financials through ${esc(A.F.yrs[A.F.yrs.length - 1])}` : ""}. Volatility ${pct(A.vol, 0, false)} (GARCH × ${x2(Q.CAL.kappaFor(s.H))}), drift ${pct(A.dr.mu)} a year. Weekly closing prices; dividends not included.</p>
  </div></div>`;
}

// ═════════════════════════════ FINDER ═════════════════════════════
let finderQ = "";
function vFinder(M) {
  M.innerHTML = `<div class="pagehead"><div><h1>Finder</h1><div class="sub">Search NIFTY 500 and S&amp;P 500 companies and add them to your dashboard. Figures from screener.in and stockanalysis.com, collected ${esc(fmtDate(ASOF.collected.slice(0, 10)))}.</div></div></div>
  <div class="panel"><div class="body"><div class="field" style="max-width:520px"><label for="fq">Company name or ticker</label><input id="fq" value="${esc(finderQ)}" placeholder="e.g. Reliance, TCS, Apple, MSFT" autocomplete="off"></div></div><div class="body flush tbl" id="fres"><p class="muted" style="padding:12px 14px">Loading the stock list…</p></div></div>
  <div class="panel" style="margin-top:14px"><header><h2>Added to your dashboard</h2></header><div class="body" id="fadded"></div></div>`;
  const drawAdded = () => { const keys = [...STATE.watch]; $("#fadded").innerHTML = keys.length ? `<ul class="list">${keys.map(k => { const c = UNI ? uniCompany(k) : null; return `<li><a href="#/c/${encodeURIComponent(k)}">${esc(c?.nm || k)}</a><button class="btn sm" data-rm="${esc(k)}">Remove</button></li>`; }).join("")}</ul>` : `<p class="empty">Nothing added yet.</p>`; $$("#fadded [data-rm]").forEach(b => b.onclick = () => Store.del("watch", b.dataset.rm)); };
  const draw = () => {
    if (!UNI) return; const q = finderQ.trim().toLowerCase(), items = Object.entries(UNI.items);
    const hits = (q ? items.filter(([k, u]) => k.toLowerCase().includes(q) || (u.n || "").toLowerCase().includes(q)) : items.slice().sort((a, b) => (b[1].mcapN || 0) - (a[1].mcapN || 0))).slice(0, 60);
    $("#fres").innerHTML = `<table><thead><tr><th class="t">Company</th><th class="t">Market</th><th>Price</th><th>P/E</th><th>P/B</th><th>ROE</th><th>Div. yield</th><th>Mkt cap</th><th></th></tr></thead><tbody>${hits.map(([k, u]) => { const [mk, tk] = k.split(":"), c = { cur: mk === "IN" ? "₹" : "$" }; return `<tr><td class="t"><div class="co"><b><a href="#/c/${encodeURIComponent(CO[tk] ? tk : k)}">${esc(u.n)}</a></b><span>${esc(tk)}${u.sec ? " · " + esc(u.sec) : ""}</span></div></td><td class="t small">${mk === "IN" ? "NSE" : "US"}</td><td>${px(u.px, c)}</td><td>${x2(u.pe, 1)}</td><td>${x2(u.pb ?? (u.bv ? u.px / u.bv : null), 1)}</td><td>${fin(u.roe) ? u.roe.toFixed(1) + "%" : "—"}</td><td>${fin(u.dy) ? u.dy.toFixed(2) + "%" : "—"}</td><td class="small">${esc(u.mcap || "—")}</td><td>${CO[tk] ? `<span class="faint small">core</span>` : STATE.watch.has(k) ? `<span class="faint small">added</span>` : `<button class="btn sm" data-add="${esc(k)}">Add</button>`}</td></tr>`; }).join("") || `<tr><td class="t muted" colspan="9">No matches.</td></tr>`}</tbody></table><p class="small faint" style="padding:8px 14px">${Object.keys(UNI.items).length.toLocaleString()} companies available.</p>`;
    $$("#fres [data-add]").forEach(b => b.onclick = async () => { const k = b.dataset.add; uniCompany(k); b.disabled = true; await Store.put("watch", { id: safeId(k), key: k, added: today() }); b.replaceWith(Object.assign(document.createElement("span"), { className: "faint small", textContent: "added" })); drawAdded(); });
  };
  $("#fq").addEventListener("input", e => { finderQ = e.target.value; draw(); });
  loadUniverse().then(() => { draw(); drawAdded(); }).catch(() => { $("#fres").innerHTML = `<p class="note warn" style="margin:12px 14px">The stock list couldn't be loaded. Reload the page to try again.</p>`; });
  drawAdded();
}

// ═════════════════════════════ NOTES ═════════════════════════════
let noteSel = null;
function vNotes(M) {
  const notes = STATE.notes.slice().sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  if (!noteSel || !notes.find(n => n.id === noteSel)) noteSel = notes[0]?.id || null;
  const cur = notes.find(n => n.id === noteSel);
  M.innerHTML = `<div class="pagehead"><div><h1>Notes</h1><div class="sub">A private notepad. Notes written on a company page appear here too.</div></div><button class="btn primary" id="nnew">New note</button></div>
  <div class="notes"><div class="panel notelist">${notes.map(n => `<button data-n="${esc(n.id)}" class="${n.id === noteSel ? "on" : ""}"><div class="t">${esc(n.title || "Untitled")}</div><div class="d">${esc(fmtDate((n.updated || "").slice(0, 10)))}${n.company ? " · " + esc(CO[n.company]?.tk || n.company) : ""}</div></button>`).join("") || `<p class="empty" style="padding:10px 12px">No notes yet.</p>`}</div>
  <div class="panel"><div class="body">${cur ? `<div class="field"><label for="nt">Title</label><input id="nt" value="${esc(cur.title || "")}" autocomplete="off"></div><div class="field" style="margin-top:10px"><label for="nb">Note</label><textarea id="nb" style="min-height:380px">${esc(cur.body || "")}</textarea></div><div style="display:flex;justify-content:space-between;margin-top:8px"><span class="small faint" id="nst">Saved</span><button class="btn sm" id="ndel">Delete note</button></div>` : `<p class="empty">Create a note to start writing.</p>`}</div></div></div>`;
  $("#nnew").onclick = async () => { const id = "n-" + uid(); noteSel = id; await Store.put("notes", { id, title: "Untitled", body: "", updated: new Date().toISOString() }); render(); setTimeout(() => $("#nt")?.select(), 50); };
  $$("[data-n]", M).forEach(b => b.onclick = () => { noteSel = b.dataset.n; render(); });
  if (cur) {
    let t = null; const save = () => { clearTimeout(t); $("#nst").textContent = "Saving…"; t = setTimeout(async () => { await Store.put("notes", { ...cur, title: $("#nt").value, body: $("#nb").value, updated: new Date().toISOString() }); const s = $("#nst"); if (s) s.textContent = "Saved"; }, 700); };
    $("#nt").addEventListener("input", save); $("#nb").addEventListener("input", save);
    let armed = false; $("#ndel").onclick = e => { if (!armed) { armed = true; e.target.textContent = "Click again to delete"; return; } noteSel = null; Store.del("notes", cur.id); };
  }
}

// ═════════════════════════════ MODEL REPORT ═════════════════════════════
function vModel(M) {
  const B = BACKTEST, ic = B.scoreIC || {};
  M.innerHTML = `<div class="pagehead"><div><h1>Model accuracy</h1><div class="sub">Walk-forward backtest run ${esc(B.run)} on the 20 core stocks: ${B.n.toLocaleString()} predictions, each made with only the data available at the time.</div></div></div>
  <div class="kpis">
    <div class="kpi"><div class="k">Inside 90% range</div><div class="v">${pct(B.all.in90, 1, false)}</div><div class="s">target 90%</div></div>
    <div class="kpi"><div class="k">Inside 50% range</div><div class="v">${pct(B.all.in50, 1, false)}</div><div class="s">target 50%</div></div>
    <div class="kpi"><div class="k">Direction right</div><div class="v">${pct(B.all.dir, 1, false)}</div><div class="s">coin flip 50%</div></div>
    <div class="kpi"><div class="k">Median price error</div><div class="v">${pct(B.all.medErr, 1, false)}</div><div class="s">all horizons</div></div>
    <div class="kpi"><div class="k">Brier score, P(gain)</div><div class="v">${x2(B.all.brier, 3)}</div><div class="s">"always ${pct(B.baseUp, 0, false)} up" scores ${x2(B.climatologyBrier, 3)}</div></div>
  </div>
  <div class="grid g2">
    <div class="panel"><header><h2>Verdict</h2></header><div class="body">
      <p style="margin-top:0"><b>The ranges are reliable.</b> When the model said a price had a 90% chance of landing in a range, it did ${pct(B.all.in90, 0, false)} of the time. That held at 4, 13, 26 and 52 weeks.</p>
      <p><b>It cannot predict direction.</b> Up/down calls were right ${pct(B.all.dir, 0, false)} of the time. Assuming "up" every time would have done better over 2022–2026, because ${pct(B.baseUp, 0, false)} of these windows ended higher. This is consistent with decades of research showing weekly stock prices are close to a random walk.</p>
      <p><b>The score is not a return predictor.</b> Ranking stocks by score and comparing with their next returns gave rank correlations of ${x2(ic["13"]?.ic, 3)} (13 weeks) and ${x2(ic["26"]?.ic, 3)} (26 weeks). Neither is statistically different from zero (t = ${x2(ic["13"]?.icT, 2)} and ${x2(ic["26"]?.icT, 2)}).</p>
      <p class="note small">Use the model to size risk ("how bad could this get, and how likely is it?"), not to time buys and sells.</p></div></div>
    <div class="panel"><header><h2>Calibration</h2><span class="muted small">promised vs observed</span></header><div class="body" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:12px;align-items:center">
      ${calChart([[0.5, B.all.in50, "50%"], [0.9, B.all.in90, "90%"]])}
      <div><div class="small muted">Where actual prices fell inside the forecast (flat bars = perfect calibration)</div>${pitChart(B.pitHist)}<div class="small faint">Outcomes lean toward the upper deciles: these stocks rose more than the model's cautious CAPM drift assumed.</div></div></div></div>
  </div>
  <div class="grid g2" style="margin-top:14px">
    <div class="panel"><header><h2>By horizon</h2></header><div class="body flush tbl"><table><thead><tr><th class="t">Horizon</th><th>Predictions</th><th>In 50%</th><th>In 90%</th><th>Direction</th><th>Median error</th><th>κ</th></tr></thead><tbody>${Object.entries(B.byH).map(([h, s]) => `<tr><td class="t">${h} weeks</td><td>${s.n}</td><td>${pct(s.in50, 0, false)}</td><td>${pct(s.in90, 0, false)}</td><td>${pct(s.dir, 0, false)}</td><td>${pct(s.medErr, 1, false)}</td><td>${x2(Q.CAL.kappaFor(+h))}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="panel"><header><h2>Drift signals tested</h2><span class="muted small">lower Brier is better</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Drift built from</th><th>Brier</th><th>Direction</th><th>In 90%</th></tr></thead><tbody>${[["capm", "CAPM prior only (used)"], ["noval", "CAPM + momentum + sample mean"], ["nomom", "CAPM + valuation + sample mean"], ["full", "All four signals"]].map(([k, n]) => `<tr><td class="t">${n}</td><td>${x2(B.variants[k].brier, 4)}</td><td>${pct(B.variants[k].dir, 1, false)}</td><td>${pct(B.variants[k].in90, 1, false)}</td></tr>`).join("")}</tbody></table><p class="small faint" style="padding:8px 14px">Valuation and momentum signals made forecasts worse on this sample, so the live model leaves them out of the drift. Tested at κ = 1.15.</p></div></div>
  </div>
  <div class="panel" style="margin-top:14px"><header><h2>By stock</h2></header><div class="body flush tbl"><table><thead><tr><th class="t">Stock</th><th>Predictions</th><th>In 50%</th><th>In 90%</th><th>Direction</th><th>Median error</th></tr></thead><tbody>${Object.entries(B.byStock).map(([id, s]) => `<tr><td class="t"><a href="#/c/${encodeURIComponent(id)}">${esc(CO[id]?.nm || id)}</a></td><td>${s.n}</td><td>${pct(s.in50, 0, false)}</td><td>${pct(s.in90, 0, false)}</td><td>${pct(s.dir, 0, false)}</td><td>${pct(s.medErr, 1, false)}</td></tr>`).join("")}</tbody></table></div></div>
  <div class="panel" style="margin-top:14px"><header><h2>Method</h2></header><div class="body grid g2">
    <div><h3>1 · Price process</h3><p class="small">Log price follows d ln S = (μ − σₜ²/2)dt + σₜ dW. By Itô's lemma the median grows at μ − σ²/2, slower than the mean. That gap is the volatility drag.</p>
      <h3>2 · Volatility</h3><p class="small">GARCH(1,1) is fitted by maximum likelihood on up to 156 weekly log returns before the as-of date and forecast over the horizon. It is then multiplied by a calibration factor κ(H), from 1.02 at 4 weeks to 1.30 at 52 weeks, chosen so the 90% band holds about 90% of outcomes.</p>
      <h3>3 · Simulation</h3><p class="small">Filtered historical simulation: standardised GARCH residuals are resampled with a random sign, so fat tails and volatility clustering come from the stock's own history. Each forecast uses 10,000 paths (6,000 on summary pages), with a fixed seed so results repeat.</p></div>
    <div><h3>4 · Drift</h3><p class="small">CAPM prior: μ = risk-free rate + β × equity premium (India 6.5% + 5.5%, US 4% + 5%, Korea 2.75% + 6%). Under the risk-neutral measure the discounted price is a martingale. Extra drift signals hurt accuracy in backtests.</p>
      <h3>5 · No look-ahead</h3><p class="small">Prices are cut at the as-of week. Annual financials become usable 60 days after the fiscal year ends. Analyst targets are not used because historical targets aren't available.</p>
      <h3>6 · Also reported</h3><p class="small">Variance-ratio and runs tests, the Hurst exponent, a 2-state hidden Markov regime model, Black–Scholes option values, and RSI, MACD and moving averages. These are shown for context only.</p></div></div></div>
  <div class="panel" style="margin-top:14px"><header><h2>Re-run a quick test in your browser</h2></header><div class="body"><p class="small muted" style="margin-top:0">Runs 300 fresh walk-forward predictions (20 stocks × 3 horizons × 5 random dates) with new random paths.</p><button class="btn" id="rerun">Run test</button><div class="progress"><i id="rp"></i></div><div id="rr" style="margin-top:10px"></div></div></div>
  <div class="panel" style="margin-top:14px"><header><h2>Data sources</h2></header><div class="body small"><ul class="list"><li>Prices, ratios, financials, shareholding and filings for India: <a href="https://www.screener.in" target="_blank" rel="noopener">screener.in</a></li><li>Prices, ratios, financials, company profiles and news for the US, Korea and the Taiwan ADR: <a href="https://stockanalysis.com" target="_blank" rel="noopener">stockanalysis.com</a></li><li>Company facts, plants, relationships and history: the Wikipedia article linked on each item</li><li>Exchange announcements: BSE India (linked)</li><li>Your orders: entered on the Orders page</li></ul><p class="faint">Collected ${esc(ASOF.collected)}. Prices do not update live.</p></div></div>`;
  $("#rerun").onclick = async () => {
    const btn = $("#rerun"); btn.disabled = true; const rows = [], jobs = [];
    for (const c of CORE) for (const H of [13, 26, 52]) for (let k = 0; k < 5; k++) { const room = c.wk.length - 61 - H; if (room <= 0) continue; const i0 = 60 + Math.floor(Math.random() * room); jobs.push([c, i0, i0 + H]); }
    for (let j = 0; j < jobs.length; j++) { const [c, a, b] = jobs[j], e = Q.evaluate(c, a, b, 1500); if (e) rows.push(e); if (j % 6 === 0) { $("#rp").style.width = (j / jobs.length * 100) + "%"; await new Promise(r => setTimeout(r, 0)); } }
    $("#rp").style.width = "100%"; btn.disabled = false;
    const s = Q.summarise(rows);
    $("#rr").innerHTML = `<div class="result"><div><div class="k">Predictions</div><div class="v">${s.n}</div></div><div><div class="k">Inside 50%</div><div class="v">${pct(s.in50, 0, false)}</div></div><div><div class="k">Inside 90%</div><div class="v">${pct(s.in90, 0, false)}</div></div><div><div class="k">Direction right</div><div class="v">${pct(s.dir, 0, false)}</div></div><div><div class="k">Median error</div><div class="v">${pct(s.medErr, 1, false)}</div></div></div>`;
  };
}

// ═════════════════════════════ search & boot ═════════════════════════════
function bindSearch() {
  const inp = $("#qs"), box = $("#qsr"); let hits = [], on = 0;
  const show = () => { const q = inp.value.trim().toLowerCase(); if (!q) { box.hidden = true; return; }
    const local = allTracked().filter(c => c.nm.toLowerCase().includes(q) || c.tk.toLowerCase().includes(q)).map(c => ({ id: c.id, n: c.nm, t: c.tk, tag: "dashboard" }));
    const uni = UNI ? Object.entries(UNI.items).filter(([k, u]) => (u.n || "").toLowerCase().includes(q) || k.toLowerCase().includes(q)).slice(0, 10).map(([k, u]) => ({ id: CO[k.split(":")[1]] ? k.split(":")[1] : k, n: u.n, t: k.split(":")[1], tag: k.startsWith("IN") ? "NSE" : "US" })) : [];
    hits = [...local, ...uni.filter(u => !local.some(l => l.t === u.t))].slice(0, 10); on = 0;
    box.innerHTML = hits.map((h, i) => `<button data-i="${i}" class="${i === on ? "on" : ""}"><span>${esc(h.n)}</span><span class="faint small mono">${esc(h.t)} · ${h.tag}</span></button>`).join("") || `<div class="empty" style="padding:8px 10px">No matches</div>`; box.hidden = false; };
  inp.addEventListener("focus", () => loadUniverse().then(show).catch(() => {}));
  inp.addEventListener("input", show);
  inp.addEventListener("keydown", e => { if (e.key === "ArrowDown") { on = Math.min(hits.length - 1, on + 1); e.preventDefault(); } else if (e.key === "ArrowUp") { on = Math.max(0, on - 1); e.preventDefault(); } else if (e.key === "Enter" && hits[on]) { go("#/c/" + encodeURIComponent(hits[on].id)); inp.value = ""; box.hidden = true; return; } else if (e.key === "Escape") { box.hidden = true; return; } else return; $$("button", box).forEach((b, i) => b.classList.toggle("on", i === on)); });
  box.addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (!b) return; go("#/c/" + encodeURIComponent(hits[+b.dataset.i].id)); inp.value = ""; box.hidden = true; });
  document.addEventListener("click", e => { if (!e.target.closest(".search")) box.hidden = true; });
}
function boot() {
  try { const t = localStorage.getItem("synapse.theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  $("#theme").onclick = () => { const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.dataset.theme = dark ? "light" : "dark"; try { localStorage.setItem("synapse.theme", r.dataset.theme); } catch (e) {} render(); };
  route = parseHash(); bindSearch();
  STATE.orders = ORDERS_SEED.map(seedToOrder);
  CORE.slice(0, 4).forEach(analysis);
  render();
  Store.init();
  let i = 0; const step = () => { if (i >= CORE.length) { if (route.name === "home" && !isTyping()) render(); return; } analysis(CORE[i++]); if (i % 6 === 0 && route.name === "home" && !isTyping()) render(); setTimeout(step, 0); }; setTimeout(step, 30);
  setTimeout(() => { if (STATE.watch.size) loadUniverse().then(() => { [...STATE.watch].forEach(uniCompany); render(); }).catch(() => {}); }, 300);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
