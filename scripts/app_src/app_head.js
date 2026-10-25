// ═════════════════════════════ data from the local KUBER engine ═════════════════════════════
let ASOF = {}, CORE = [], V = {}, SRC = {}, SRCNAME = {}, BACKTEST = {}, CO = {};
const STATE = { orders: [], sims: [], notes: [], watch: new Set(), calib: {}, models: {}, verify: {}, markets: {}, llm: { running: false }, track: null, live: {}, liveAnalysis: {} };
const CLIENT = Math.random().toString(36).slice(2, 10);
async function api(p, o = {}) {
  const r = await fetch(p, { method: o.method || "GET", headers: o.body ? { "content-type": "application/json" } : {}, body: o.body ? JSON.stringify(o.body) : undefined });
  if (r.status === 401) { location.replace("/login"); throw new Error("locked"); }
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ("HTTP " + r.status)); return j;
}
function ingest(B) {
  ASOF = B.asof; V = B.claims.V; SRC = B.claims.SRC; SRCNAME = B.claims.SRCNAME; BACKTEST = B.backtest;
  CO = {}; CORE = [];
  for (const c of B.companies) { c.core = !c.universe && !c.onDemand; c.V = V[c.id] || null; CO[c.id] = c; if (c.core) CORE.push(c); }
  STATE.hidden = B.hidden || []; STATE.alerts = B.alerts || []; STATE.orders = B.orders; STATE.sims = B.sims; STATE.notes = B.notes; STATE.watch = new Set(B.watch);
  STATE.calib = Object.fromEntries(B.calib.map(r => [r.cid, r])); STATE.models = Object.fromEntries((B.models || []).map(r => [r.cid, { ...r, spec: JSON.parse(r.spec) }])); STATE.verify = Object.fromEntries(B.verify.map(r => [r.cid, r]));
  STATE.markets = B.markets; STATE.llm = B.llm; STATE.track = B.track; STATE.refreshLast = B.refreshLast; STATE.maintLast = B.maintLast; STATE.paramsVersion = B.paramsVersion;
  Q.setParams(B.params); RESTALE = true;   // keep showing the last results while fresh ones are computed (warmAnalyses)
}
async function reload() { ingest(await api("/api/bootstrap")); warmAnalyses(); }
let UNI = null, uniLoading = null;
function loadUniverse() {
  if (UNI) return Promise.resolve(UNI);
  if (!uniLoading) uniLoading = fetch("/universe.json").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }).then(j => (UNI = j)).catch(e => { uniLoading = null; throw e; });
  return uniLoading;
}
function uniCompany(key) {
  if (CO[key]) return CO[key];
  const u = UNI?.items?.[key]; if (!u) return null;
  const [mk, tk] = key.split(":"), wd = [u.w0]; let t = Date.parse(u.w0 + "T00:00:00Z"); for (const d of u.dd) { t += d * 864e5; wd.push(new Date(t).toISOString().slice(0, 10)); }
  const c = { id: key, nm: u.n, tk, ex: mk === "IN" ? "NSE" : mk === "KR" ? "KRX" : "US", mk, cur: mk === "IN" ? "₹" : mk === "KR" ? "₩" : "$", src: u.src, sector: u.sec, px: u.px, chg: u.chg ?? null, asof: mk === "IN" ? ASOF.india : ASOF.us, mcap: u.mcap, mcapUSD: u.mcapN, pe: u.pe, fpe: u.fpe, pb: u.pb ?? (u.bv ? u.px / u.bv : null), bv: u.bv ?? (u.pb ? u.px / u.pb : null), roe: u.roe, roce: u.roce, roic: u.roic, de: u.de, dy: u.dy || 0, npm: u.npm, beta: u.beta, tgt: u.tgt, cons: u.cons, about: u.about, fyEndMonth: mk === "IN" ? 3 : 12, hi: u.hi, lo: u.lo, fin: { ...(u.fin || { y: [] }), u: mk === "IN" ? "₹ Cr" : "$ B", d: mk === "IN" ? 1 : 1000 }, shares: u.shares, finScale: mk === "IN" ? 1e7 : 1e6, wd, wk: u.wk, universe: true, news: [], docs: [{ t: "Source data", u: u.src }], priceSource: "filings-site snapshot (weekly)" };
  CO[key] = c; return c;
}
const allTracked = () => Object.values(CO).filter(c => (c.core && !(STATE.hidden || []).includes(c.id)) || STATE.watch.has(c.id));

// ═════════════════════════════ storage (local SQLite through the engine) ═════════════════════════════
const Store = {
  async put(coll, obj) { const r = await api("/api/" + coll, { method: "POST", body: obj }); await refreshColl(coll); return r.id; },
  async del(coll, id) { await api("/api/" + coll + "/" + encodeURIComponent(id), { method: "DELETE" }); await refreshColl(coll); }
};
async function refreshColl(coll) {
  const rows = await api("/api/" + coll);
  if (coll === "watch") { STATE.watch = new Set(rows.map(r => r.key)); await reload(); } else STATE[coll] = rows;
  if (!isTyping()) render();
}
const isTyping = () => { const a = document.activeElement; return a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "range" && a.closest("#main"))); };

// ═════════════════════════════ portfolio from orders ═════════════════════════════
// orders carry their market (o.mk): IN = NSE in rupees, US = NYSE/Nasdaq in dollars, KR = KRX in won.
// Each market is its own portfolio in its own currency: nothing is converted, so no exchange rate enters the numbers.
const BOOKS = { IN: { cur: "₹", name: "India", ex: "NSE", unit: "rupees", dp: 0, loc: "en-IN" }, US: { cur: "$", name: "US", ex: "NYSE / Nasdaq", unit: "US dollars", dp: 2, loc: "en-US" }, KR: { cur: "₩", name: "Korea", ex: "KRX", unit: "won", dp: 0, loc: "ko-KR" } };
function money(v, mk = "IN", signed = false) {
  const B = BOOKS[mk] || BOOKS.IN; if (!fin(v)) return "—";
  return (signed ? (v > 0 ? "+" : v < 0 ? "−" : "") : (v < 0 ? "−" : "")) + B.cur + Math.abs(v).toLocaleString(B.loc, { minimumFractionDigits: B.dp, maximumFractionDigits: B.dp });
}
function companyForOrder(mk, sym) {
  mk = mk || "IN"; const b = CORE.find(c => c.tk === sym && (mk === "US" ? c.mk === "US" || c.mk === "TW" : c.mk === mk));
  return (b && CO[b.id]) || CO[mk + ":" + sym] || (UNI ? uniCompany(mk + ":" + sym) : null);
}
function companyForSym(sym) { return companyForOrder("IN", sym); }
// amounts are hidden until the PIN is entered again (Overview/Orders "Show amounts"); hidden again after 10 minutes
let SHOWPF = false, showPfT = 0;
const priv = html => SHOWPF ? html : `<span class="masked" title="Hidden. Use Show amounts and your PIN">••••</span>`;
function portfolio() {
  const pos = {}, flows = {};
  const ex = STATE.orders.filter(o => o.status === "executed").sort((a, b) => a.date.localeCompare(b.date) || (a.side === "Buy" ? -1 : 1));
  for (const o of ex) {
    const mk = o.mk || "IN", P = pos[mk + ":" + o.sym] = pos[mk + ":" + o.sym] || { mk, sym: o.sym, name: o.name, q: 0, cost: 0, realised: 0 }, F = flows[mk] = flows[mk] || [];
    if (o.side === "Buy") { P.q += o.qty; P.cost += o.qty * o.price; if (o.kind !== "Corporate action") F.push([o.date, -o.qty * o.price]); }
    else { const avg = P.q ? P.cost / P.q : 0; P.realised += o.qty * (o.price - avg); P.cost -= avg * o.qty; P.q -= o.qty; if (o.kind !== "Corporate action") F.push([o.date, o.qty * o.price]); }
  }
  const books = {};
  for (const P of Object.values(pos)) {
    const B = books[P.mk] = books[P.mk] || { mk: P.mk, invested: 0, value: 0, day: 0, realised: 0, open: [], closed: [] };
    B.realised += P.realised; if (P.q <= 1e-9) { B.closed.push(P); continue; }
    const c = companyForOrder(P.mk, P.sym); P.c = c; P.avg = P.cost / P.q; P.px = c?.px ?? null; P.value = fin(P.px) ? P.px * P.q : null; P.pl = fin(P.value) ? P.value - P.cost : null;
    B.invested += P.cost; B.open.push(P); if (fin(P.value)) { B.value += P.value; if (fin(c.chg)) B.day += P.value * (1 - 1 / (1 + c.chg / 100)); }
  }
  const list = ["IN", "US", "KR"].filter(mk => books[mk]).map(mk => books[mk]);
  for (const B of list) {
    B.open.sort((a, b) => (b.value || 0) - (a.value || 0)); B.open.forEach(P => P.w = fin(P.value) && B.value ? P.value / B.value : null);
    B.unreal = B.value - B.invested; const F = (flows[B.mk] || []).sort((a, b) => a[0].localeCompare(b[0]));
    B.xirr = F.length && B.open.length ? XIRR([...F, [today(), B.value]]) : null;
  }
  return { books: list, open: list.flatMap(B => B.open), closed: list.flatMap(B => B.closed) };
}
function XIRR(flows) {
  const t0 = Date.parse(flows[0][0]), yrs = flows.map(f => (Date.parse(f[0]) - t0) / (365.25 * 864e5)); let r = 0.1;
  for (let it = 0; it < 100; it++) { let f = 0, d = 0; flows.forEach((fl, i) => { const v = Math.pow(1 + r, yrs[i]); f += fl[1] / v; d -= yrs[i] * fl[1] / (v * (1 + r)); }); if (!d) return null; const nr = r - f / d; if (!isFinite(nr)) return null; if (Math.abs(nr - r) < 1e-8) return nr; r = Math.max(-0.95, Math.min(10, nr)); }
  return r;
}

// ═════════════════════════════ analysis cache (uses learned per-company calibration) ═════════════════════════════
const RES = {}; let RESTALE = false, warmToken = 0;
// recompute every tracked company's analysis in the background (a few at a time, so the window stays responsive),
// replacing the previous results in place; the Overview re-renders as they arrive
function warmAnalyses() {
  const tok = ++warmToken, list = allTracked(); let i = 0;
  const repaint = () => { if (route.name === "home" && !isTyping()) render(); };
  const step = () => { if (tok !== warmToken) return; const t0 = performance.now();
    while (i < list.length && performance.now() - t0 < 40) { const c = list[i++]; try { RES[c.id] = Q.analyse(c, { H: 52, paths: 6000, ...calibFor(c.id) }); } catch (e) { RES[c.id] = null; } }
    if (i >= list.length) { RESTALE = false; repaint(); return; } if (i % 6 < 2) repaint(); setTimeout(step, 0); };
  setTimeout(step, 30);
}
// the stock's own model (if it passed its hold-out test), its learned band/drift correction, and the dividend
// yield q paid out of the price (forecasts of future exchange prices; capped because trailing yields can be stale)
const divYield = c => Math.min(0.10, Math.max(0, (c?.dy || 0) / 100));
const calibFor = id => { if (!Q.P.learn.enabled) return { q: divYield(CO[id]) }; const r = STATE.calib[id], m = STATE.models[id]; return { q: divYield(CO[id]), ...(m && m.accepted ? { spec: m.spec } : {}), ...(r && r.accepted ? { kappaAdj: r.kappa_adj, muAdj: r.mu_adj } : {}) }; };
function analysis(c) { if (!(c.id in RES) || (RESTALE && RES[c.id] && RES[c.id].c !== c)) RES[c.id] = Q.analyse(c, { H: 52, paths: 6000, ...calibFor(c.id) }); return RES[c.id]; }
const VOLNAME = { garch: "GARCH(1,1)", ewma: "EWMA", const: "Constant", rv: "Realised (HAR)" }, SHOCKNAME = { fhs: "bootstrapped residuals", t: "Student-t", gaussian: "Gaussian" };
const DRIFTNAME = { capm: "CAPM", rf: "risk-free (martingale)", momentum: "momentum", valuation: "valuation gap", meanrev: "mean reversion (OU)", sample: "sample mean", sentiment: "news sentiment" };
const SHOCKSHORT = { fhs: "bootstrapped", t: "Student-t", gaussian: "Gaussian" };
const specText = sp => sp ? `${VOLNAME[sp.vol] || sp.vol} volatility · ${SHOCKSHORT[sp.shock] || sp.shock} shocks · ${Math.round(sp.window / 52)}-year window · drift: ${(sp.drift || ["capm"]).map(d => DRIFTNAME[d] || d).join(" + ")}` : "standard model";
function volEq(G) { return G.kind === "rv" ? "ln RVₜ₊₁ = b₀ + b₁ ln RVₜ + b₂ ln RV̄(4 wk) + b₃ ln RV̄(13 wk)   (HAR on daily-range variance)" : G.kind === "ewma" ? `σₜ² = λ·σₜ₋₁² + (1 − λ)·εₜ₋₁²   (EWMA, λ = ${x2(G.lambda)})` : G.kind === "const" ? "σ² = sample variance of the window   (constant volatility)" : "σₜ² = ω + α·εₜ₋₁² + β·σₜ₋₁²   (GARCH 1,1)"; }
function volParams(G) { return G.kind === "rv" ? ["HAR weights (week · month · quarter)", G.har.slice(1).map(x => x2(x)).join(" · ")] : G.kind === "ewma" ? ["EWMA decay λ", x2(G.lambda)] : G.kind === "const" ? ["Constant volatility", pct(G.vNow, 0, false)] : ["GARCH α · β · persistence", `${x2(G.alpha)} · ${x2(G.beta)} · ${x2(G.persist, 3)}`]; }
const scoreBadge = A => A && A.label ? `<span class="score ${A.label[1]}" title="${A.label[0]}">${A.score.toFixed(0)}</span>` : A === null ? `<span class="faint" title="Not enough price history yet (about 30 weeks needed)">—</span>` : `<span class="faint">…</span>`;
const FN = { value: "Valuation", quality: "Quality", growth: "Growth", edge: "Statistical edge", trend: "Trend", safety: "Safety" };
let W = Q.P.score.weights;

// ═════════════════════════════ router ═════════════════════════════
let route = { name: "home", arg: null, q: {} }, cleanup = [];
function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1) || ""), [path, qs] = h.split("?"), q = Object.fromEntries(new URLSearchParams(qs || "")), p = path.split("/").filter(Boolean);
  if (!p.length) return { name: "home", q }; if (p[0] === "c") return { name: "company", arg: p.slice(1).join("/"), q }; return { name: p[0], arg: p[1], q };
}
const go = h => { location.hash = h; };
window.addEventListener("hashchange", () => { route = parseHash(); setFocus(); render(true); });
function render(scrollTop) {
  cleanup.forEach(f => { try { f(); } catch (e) {} }); cleanup = [];
  W = Q.P.score.weights;
  $$(".nav a").forEach(a => a.setAttribute("aria-current", a.dataset.r === route.name || (route.name === "company" && a.dataset.r === "home") ? "page" : "false"));
  const M = $("#main"); M.onclick = null;
  ({ home: vHome, live: vLive, bonds: vBonds, trial: vTrial, company: vCompany, orders: vOrders, simulate: vSim, finder: vFinder, notes: vNotes, model: vModel, algo: vAlgo, learn: vLearn, system: vSystem }[route.name] || vHome)(M);
  renderStatus(); renderTicker(); renderAlerts();
  if (scrollTop) try { window.scrollTo(0, 0); } catch (e) {}
}

// ═════════════════════════════ live stream ═════════════════════════════
let ES = null;
function connectLive() {
  ES = new EventSource(`/api/stream?client=${CLIENT}`);
  ES.addEventListener("hello", e => { STATE.markets = JSON.parse(e.data).markets; setFocus(); renderStatus(); });
  ES.addEventListener("ping", e => { STATE.markets = JSON.parse(e.data).markets; STATE.lastPing = Date.now(); renderStatus(); });
  ES.addEventListener("quote", e => {
    const q = JSON.parse(e.data), c = CO[q.id]; STATE.live[q.id] = q; if (!c) return;
    const prev = c.px; c.px = q.price; c.chg = q.chg; c.live = { open: q.open, time: q.time, price: q.price };
    $$(`[data-live-px="${CSS.escape(q.id)}"]`).forEach(el => { el.textContent = px(q.price, c); el.classList.remove("flash-up", "flash-dn"); void el.offsetWidth; el.classList.add(q.price >= prev ? "flash-up" : "flash-dn"); });
    $$(`[data-live-chg="${CSS.escape(q.id)}"]`).forEach(el => { el.textContent = fin(q.chg) ? pct(q.chg / 100, 2) : ""; el.className = cls(q.chg) + " mono"; });
    if (route.name === "company" && route.arg === q.id) { const t = $("#livetime"); if (t && q.time) t.textContent = new Date(q.time * 1000).toLocaleTimeString(); }
    if (route.name === "home" && !isTyping()) { clearTimeout(STATE.homeT); STATE.homeT = setTimeout(() => { const k = $("#kpis-live"); if (k) k.innerHTML = kpis(portfolio()); }, 400); }
  });
  ES.addEventListener("analysis", e => { const a = JSON.parse(e.data); (STATE.liveAnalysis[a.cid] ||= []).push(a); if (route.name === "company" && route.arg === a.cid) drawLive(CO[a.cid]); });
  ES.addEventListener("bonds", e => { if (route.name === "bonds") onBondEvent(JSON.parse(e.data)); });
  ES.addEventListener("alerts", e => { STATE.alerts = JSON.parse(e.data); renderAlerts(); });
  ES.addEventListener("params", async () => { await reload(); render(); });
  ES.addEventListener("refresh", async () => { await reload(); if (!isTyping()) render(); });
  ES.addEventListener("learn", async () => { await reload(); if (!isTyping()) render(); });
  ES.addEventListener("data", async e => { const d = JSON.parse(e.data); if (d.coll !== "watch") { STATE[d.coll] = await api("/api/" + d.coll); if (!isTyping()) render(); } });
  ES.onerror = () => { STATE.offline = true; renderStatus(); fetch("/api/login-info").then(() => fetch("/api/focus", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).then(r => { if (r.status === 401) location.replace("/login"); }).catch(() => {}); };
  ES.onopen = () => { STATE.offline = false; renderStatus(); };
}
function setFocus() { const ids = route.name === "company" && route.arg ? [route.arg] : []; api("/api/focus", { method: "POST", body: { client: CLIENT, ids } }).catch(() => {}); }
// live ticker: holdings first, then the rest; prices update in place from the live stream (data-live-px)
function renderTicker() {
  const el = $("#tickt"); if (!el) return;
  const held = new Set(portfolio().open.map(P => P.c?.id).filter(Boolean)), list = allTracked().sort((a, b) => (held.has(b.id) - held.has(a.id)) || a.nm.localeCompare(b.nm));
  const m = STATE.markets || {}, item = c => `<a href="#/c/${encodeURIComponent(c.id)}" title="${esc(c.nm)}${held.has(c.id) ? " · you hold this" : ""}">${held.has(c.id) ? '<span class="hold"></span>' : ""}<span class="dot ${m[c.mk === "TW" ? "US" : c.mk] ? "on" : ""}"></span><span class="tk">${esc(c.tk)}</span><span class="mono" data-live-px="${esc(c.id)}">${px(c.px, c)}</span><span class="${cls(c.chg)} mono" data-live-chg="${esc(c.id)}">${fin(c.chg) ? pct(c.chg / 100, 2) : ""}</span></a>`;
  const key = list.map(c => c.id + (held.has(c.id) ? "*" : "") + (m[c.mk === "TW" ? "US" : c.mk] ? "o" : "")).join(",");
  if (el.dataset.key === key) { list.forEach(c => $$(`[data-live-px="${CSS.escape(c.id)}"]`, el).forEach(x => { x.textContent = px(c.px, c); })); return; }   // keep the scroll position
  const html = list.map(item).join("");
  el.innerHTML = html + html; el.dataset.key = key;   // duplicated for a seamless loop
}
function renderStatus() {
  const el = $("#mkt"); if (!el) return; const m = STATE.markets || {};
  el.innerHTML = STATE.offline ? `<span class="dot off"></span>Engine offline` : ["IN", "US", "KR"].map(k => `<span title="${k === "IN" ? "NSE" : k === "US" ? "NYSE / Nasdaq" : "KRX"}"><span class="dot ${m[k] ? "on" : ""}"></span>${k === "IN" ? "NSE" : k === "US" ? "US" : "KRX"}</span>`).join("");
}
