// ═════════════════════════════ BONDS ═════════════════════════════
// US Treasuries and Indian government bonds: official end-of-day data, live yields in between, and the analysis
// the engine computes in the background (server/bondanalysis.mjs). Nothing here estimates anything new; it only shows.
let BMK = "US", BDATA = null, BINTRA = {}, bondT = 0;
const bp = (v, d = 0) => fin(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)} bp` : "—";
const ypct = (v, d = 2) => fin(v) ? `${v.toFixed(d)}%` : "—";
const bcls = v => fin(v) ? (v > 0 ? "neg" : v < 0 ? "pos" : "") : "";      // rising yields = falling bond prices
const pctile = v => fin(v) ? `${Math.round(v * 100)}th` : "—";
const tz2 = mk => mk === "IN" ? "Asia/Kolkata" : "America/New_York";
const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
// generic line chart: series [{pts: [[x, y]], color, dash, w, name}], numeric x (ms or years), optional zero line, shaded spans
function bChart(series, { W = 760, H = 220, xFmt = x => x, yFmt = y => y.toFixed(2), zero = false, xLog = false, spans = [], legend = true, area = false } = {}) {
  const all = series.flatMap(s => s.pts).filter(p => fin(p[0]) && fin(p[1])); if (all.length < 2) return `<p class="faint small">Not enough data yet.</p>`;
  const tx = x => xLog ? Math.log(x) : x, xs = all.map(p => tx(p[0])), ys = all.map(p => p[1]).concat(zero ? [0] : []);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys), sp = (hi - lo) || Math.abs(hi) * 0.01 || 1, pad = { l: 46, r: 12, t: 10, b: 22 };
  const X = x => pad.l + (tx(x) - x0) / ((x1 - x0) || 1) * (W - pad.l - pad.r), Y = y => pad.t + (1 - (y - lo + sp * 0.05) / (sp * 1.1)) * (H - pad.t - pad.b);
  const ticks = 4, yt = Array.from({ length: ticks + 1 }, (_, i) => lo - sp * 0.05 + sp * 1.1 * i / ticks);
  const xt = xLog ? [0.25, 1, 2, 5, 10, 30].filter(v => tx(v) >= x0 - 1e-9 && tx(v) <= x1 + 1e-9) : Array.from({ length: 5 }, (_, i) => x0 + (x1 - x0) * i / 4);
  return `<svg viewBox="0 0 ${W} ${H}" class="bchart" role="img" aria-label="${esc(series.map(s => s.name).join(", "))}" style="width:100%;height:auto">
    ${spans.map(([a, b]) => `<rect x="${X(a)}" y="${pad.t}" width="${Math.max(1, X(b) - X(a))}" height="${H - pad.t - pad.b}" fill="var(--faint)" fill-opacity="0.12"/>`).join("")}
    ${yt.map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="0.6"/><text x="${pad.l - 6}" y="${Y(v) + 3}" text-anchor="end" font-size="10" fill="var(--faint)">${esc(yFmt(v))}</text>`).join("")}
    ${zero && lo < 0 && hi > 0 ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--muted)" stroke-dasharray="3 3"/>` : ""}
    ${xt.map(v => `<text x="${X(v)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--faint)">${esc(String(xFmt(v)))}</text>`).join("")}
    ${series.map(s => { const pts = s.pts.filter(p => fin(p[0]) && fin(p[1])); if (!pts.length) return ""; const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
      return (area && s === series[0] ? `<path d="${d}L${X(pts[pts.length - 1][0]).toFixed(1)},${H - pad.b}L${X(pts[0][0]).toFixed(1)},${H - pad.b}Z" fill="${s.color}" fill-opacity="0.07"/>` : "") + `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.6}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} vector-effect="non-scaling-stroke"/>` + (s.dots ? pts.map(p => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="2.4" fill="${s.color}"/>`).join("") : ""); }).join("")}
  </svg>${legend && series.length > 1 ? `<div class="blegend">${series.map(s => `<span><i style="background:${s.color}${s.dash ? ";opacity:.6" : ""}"></i>${esc(s.name)}</span>`).join("")}</div>` : ""}`;
}
const dX = d => Date.parse(d + "T00:00:00Z"), yearFmt = x => new Date(x).getUTCFullYear(), monFmt = x => new Date(x).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
const matFmt = m => m < 1 ? `${Math.round(m * 12)}m` : `${m}y`;
const tile = (k, v, s, c = "") => `<div class="kpi"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
const pn = (title, sub, body, flush) => `<div class="panel"><header><h2>${title}</h2>${sub ? `<span class="muted small">${sub}</span>` : ""}</header><div class="body${flush ? " flush tbl" : ""}">${body}</div></div>`;
const how = t => `<p class="small muted" style="margin:8px 0 0">${t}</p>`;

async function vBonds(M) {
  M.innerHTML = `<div class="pagehead"><div><h1>Bond market</h1><div class="sub">US Treasuries and Indian government bonds. Official end-of-day data (US Treasury, Federal Reserve, New York Fed, CCIL, RBI) with live yields in between. The analysis reruns whenever new official data arrives; every source is cross-checked against a second one.</div></div>
    <div class="storage"><span class="seg" id="bmk">${[["US", "United States"], ["IN", "India"]].map(([k, n]) => `<button data-m="${k}" aria-pressed="${BMK === k}">${n}</button>`).join("")}</span> <button class="btn sm" id="brefresh">Refresh data</button></div></div>
    <div id="bbody"><p class="muted">Loading the bond market…</p></div>`;
  $("#bmk").onclick = e => { const b = e.target.closest("button"); if (!b) return; BMK = b.dataset.m; $$("#bmk button").forEach(x => x.setAttribute("aria-pressed", x === b)); drawBonds(); };
  $("#brefresh").onclick = async e => { e.target.disabled = true; e.target.textContent = "Refreshing…"; try { await api("/api/bonds/refresh", { method: "POST" }); e.target.textContent = "Running (about a minute)"; } catch (err) { e.target.textContent = err.message; } };
  try { BDATA = await api("/api/bonds"); } catch (e) { $("#bbody").innerHTML = `<p class="note warn">The engine didn't answer: ${esc(e.message)}</p>`; return; }
  drawBonds();
  clearInterval(bondT); bondT = setInterval(() => { if (route.name === "bonds") loadIntraday(); else clearInterval(bondT); }, 60000);
}
async function loadIntraday() {
  const S = BMK === "US" ? ["US10Y", "US2Y"] : ["IN10Y"];
  try { const r = await Promise.all(S.map(s => api(`/api/bonds/intraday?s=${s}&h=40`))); S.forEach((s, i) => BINTRA[s] = r[i]); const el = $("#bintra"); if (el) el.innerHTML = intraBonds(); } catch (e) { }
}
function intraBonds() {
  const A = BDATA.analysis?.[BMK] || {}, cols = ["var(--accent)", "var(--c3)"], names = BMK === "US" ? ["US10Y", "US2Y"] : ["IN10Y"];
  // the latest session only: from the last gap of more than 2 hours
  const sess = s => { const t = BINTRA[s] || []; let k = 0; for (let i = t.length - 1; i > 0; i--) if (t[i][0] - t[i - 1][0] > 7200) { k = i; break; } return t.slice(k); };
  const ser = names.map((s, i) => ({ name: { US10Y: "10-year", US2Y: "2-year", IN10Y: "India 10-year" }[s], color: cols[i], pts: sess(s).map(([t, y]) => [t * 1000, y]) })).filter(s => s.pts.length > 1);
  if (!ser.length) return `<p class="faint small">No live yields recorded in the last 40 hours.</p>`;
  const one = s => bChart([s], { H: 170, xFmt: x => new Date(x).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz2(BMK) }), yFmt: y => y.toFixed(3), legend: false, area: true });
  return `<div class="grid g2">${ser.map(s => { const p = s.pts, hiY = Math.max(...p.map(x => x[1])), loY = Math.min(...p.map(x => x[1])); return `<div><div class="small"><b>${esc(s.name)}</b> <span class="mono">${p[p.length - 1][1].toFixed(3)}%</span> <span class="faint">session high ${hiY.toFixed(3)} · low ${loY.toFixed(3)} · range ${((hiY - loY) * 100).toFixed(1)} bp · ${p.length} samples</span></div>${one(s)}</div>`; }).join("")}</div>`;
}
function drawBonds() {
  const B = $("#bbody"); if (!B || !BDATA) return;
  const A = BDATA.analysis?.[BMK];
  const checks = BDATA.checks || [], okN = checks.filter(c => c.ok).length;
  const status = `<div class="small muted" style="margin:-4px 0 12px">Live: ${BDATA.lastOk ? `updated ${ago(BDATA.lastOk)}` : "not yet"}${BDATA.session?.[BMK] ? ` · <span class="pos">${BMK === "US" ? "Treasuries trading" : "NDS-OM session open"}</span>` : ` · ${BMK === "US" ? "Treasury market closed" : "Indian session closed"}`} · Official data as of ${esc(fmtDate(A?.asOf))} · Analysis ${BDATA.meta?.at ? `run ${ago(Date.parse(BDATA.meta.at))} (${(BDATA.meta.secs || 0).toFixed(0)} s)` : "pending"}${BDATA.analysing ? " · <b>running now</b>" : ""} · Checks <span class="${okN === checks.length ? "pos" : "neg"}">${okN}/${checks.length} passed</span></div>`;
  if (!A || A.building) { B.innerHTML = status + `<p class="note">KUBER is downloading the bond history for the first time (the Treasury curve back to 1990 and the New York Fed files). This takes a few minutes; the page fills in automatically.</p>` + checksPanel(); return; }
  B.innerHTML = status + (BMK === "US" ? usView(A) : inView(A)) + checksPanel();
  loadIntraday();
}
function checksPanel() {
  const S = BDATA.sync?.res || {};
  return `<div style="margin-top:14px">${pn("Data and checks", `last sync ${BDATA.sync?.at ? esc(fmtTime(BDATA.sync.at)) : "—"}`, `<table><thead><tr><th class="t">Check</th><th class="t">Result</th><th class="t">Detail</th></tr></thead><tbody>${(BDATA.checks || []).map(c => `<tr><td class="t">${esc(c.name)}</td><td class="t">${c.ok ? '<span class="badge ok">passed</span>' : '<span class="badge no">failed</span>'}</td><td class="t small muted">${esc(c.detail)}</td></tr>`).join("")}</tbody></table>
    <p class="small muted" style="padding:8px 14px 12px;margin:0">Sources: US Treasury daily par and real yield curves (since 1990 / 2003) · Federal Reserve H.15 (second source for the same yields) · New York Fed: fed funds, SOFR, ACM term premium, yield-curve recession model · CCIL: India zero-coupon curve and tenor-wise yields · RBI: policy rates · Live yields and intraday history: CNBC (Tradeweb prices for Treasuries). Last sync: ${esc(Object.entries(S).map(([k, v]) => `${k} ${typeof v === "number" ? v.toLocaleString() : v}`).join(" · "))}</p>`, true)}</div>`;
}

// ── United States ──
function usView(A) {
  const L = BDATA.live || {}, t10 = A.tenors.find(t => t.t === "10Y"), t2 = A.tenors.find(t => t.t === "2Y"), s = k => A.spreads.find(x => x.k === k), r10 = A.real.find(r => r.t === "10Y"), P = A.policy, R = A.recession;
  return `<div id="bkpi">${usKpis(A)}</div>` + usRest(A);
}
function usKpis(A) {
  const L = BDATA.live || {}, t10 = A.tenors.find(t => t.t === "10Y"), t2 = A.tenors.find(t => t.t === "2Y"), s = k => A.spreads.find(x => x.k === k), r10 = A.real.find(r => r.t === "10Y"), P = A.policy, R = A.recession;
  const live = (k, off) => L[k] ? `${L[k].y.toFixed(3)}%` : ypct(off?.y), vsClose = L.US10Y && fin(t10?.y) ? (L.US10Y.y - t10.y) * 100 : null;
  return `<div class="kpis">
    ${tile("10-year Treasury", live("US10Y", t10), L.US10Y ? `${bp(vsClose, 1)} vs official close ${ypct(t10.y)}` : `official close ${esc(fmtDate(A.asOf))}`, "")}
    ${tile("2-year Treasury", live("US2Y", t2), `official ${ypct(t2.y)} · 1 month ${bp(t2.d21)}`)}
    ${tile("10y − 3m spread", bp(s("3m10y").bp), s("3m10y").bp < 0 ? `inverted ${s("3m10y").invertedDays} days` : `positive; last inverted ${esc(fmtDate(s("3m10y").lastInverted))}`)}
    ${tile("10y − 2y spread", bp(s("2s10s").bp), `${pctile(s("2s10s").pct)} percentile since 1990`)}
    ${tile("10y real yield (TIPS)", ypct(r10?.real.y), `inflation priced in: ${ypct(r10?.breakeven.y)} a year`)}
    ${tile("Fed funds (effective)", ypct(P?.effr), P ? `target ${P.rangeLo}–${P.rangeHi}% · ${esc(fmtDate(P.effrDate))}` : "")}
    ${tile("Recession in 12 months", R ? pct(R.official.prob, 0, false) : "—", R ? `NY Fed model, for ${esc(monFmt(dX(R.official.forMonth)))}` : "")}
  </div>`;
}
function usRest(A) {
  const t10 = A.tenors.find(t => t.t === "10Y"), s = k => A.spreads.find(x => x.k === k), P = A.policy, R = A.recession;
  const curve = bChart(A.curves.map((c, i) => ({ name: `${c.name} (${fmtDate(c.date)})`, color: ["var(--text)", "var(--accent)", "var(--c3)", "var(--faint)"][i], dash: i ? "4 3" : "", w: i ? 1.2 : 2, dots: !i, pts: c.pts })), { xLog: true, xFmt: matFmt, yFmt: y => y.toFixed(2) + "%" });
  const tenTable = `<table><thead><tr><th class="t">Maturity</th><th>Yield</th><th>1 day</th><th>1 week</th><th>1 month</th><th>1 year</th><th>10-yr percentile</th></tr></thead><tbody>${A.tenors.map(t => `<tr><td class="t">${matFmt(t.m)}</td><td class="mono">${ypct(t.y)}</td><td class="${bcls(t.d1)}">${bp(t.d1)}</td><td class="${bcls(t.d5)}">${bp(t.d5)}</td><td class="${bcls(t.d21)}">${bp(t.d21)}</td><td class="${bcls(t.d252)}">${bp(t.d252)}</td><td>${pctile(t.pct)}</td></tr>`).join("")}</tbody></table>`;
  const sh10 = s("3m10y").hist, sh2 = s("2s10s").hist;
  const shape = `<table><thead><tr><th class="t">Spread</th><th>Now</th><th>1 month</th><th>1 year</th><th>Percentile since 1990</th><th>vs 5 years (z)</th><th class="t">Inversion</th></tr></thead><tbody>${A.spreads.map(x => `<tr><td class="t">${esc(x.name)}</td><td class="mono">${bp(x.bp)}</td><td>${bp(x.d21)}</td><td>${bp(x.d252)}</td><td>${pctile(x.pct)}</td><td>${fin(x.z5y) ? x.z5y.toFixed(1) : "—"}</td><td class="t small">${x.invertedDays == null ? "—" : x.bp < 0 ? `<span class="neg">inverted ${x.invertedDays} days</span>` : x.lastInverted ? `last ${esc(fmtDate(x.lastInverted))}` : "not since 1990"}</td></tr>`).join("")}</tbody></table>`;
  const spreadChart = bChart([{ name: "10y − 3m", color: "var(--accent)", pts: sh10.map(([d, v]) => [dX(d), v]) }, { name: "10y − 2y", color: "var(--c3)", pts: sh2.map(([d, v]) => [dX(d), v]) }], { zero: true, xFmt: yearFmt, yFmt: v => v.toFixed(0) });
  const F = A.factors, D = A.decomposition, pc = A.pca;
  const moved = `<div class="grid g2"><div>
      <table><thead><tr><th class="t">10-year change</th><th>Total</th><th>Real yield</th><th>Inflation priced in</th></tr></thead><tbody>${D.realBreakeven.map(r => `<tr><td class="t small">${r.days === 21 ? "1 month" : r.days === 63 ? "3 months" : "1 year"} <span class="faint">since ${esc(fmtDate(r.from))}</span></td><td class="mono ${bcls(r.nominalBp)}">${bp(r.nominalBp)}</td><td>${bp(r.realBp)}</td><td>${bp(r.breakevenBp)}</td></tr>`).join("")}</tbody></table>
      ${how("Exact split: the nominal yield equals the real (inflation-protected) yield plus the inflation the market prices in (the breakeven). Both from the US Treasury.")}
    </div><div>
      <table><thead><tr><th class="t">10-year change (ACM)</th><th>Total</th><th>Expected rates</th><th>Term premium</th></tr></thead><tbody>${D.expectationsPremium.map(r => `<tr><td class="t small">${r.days === 21 ? "1 month" : r.days === 63 ? "3 months" : "1 year"} <span class="faint">to ${esc(fmtDate(r.to))}</span></td><td class="mono ${bcls(r.yBp)}">${bp(r.yBp, 1)}</td><td>${bp(r.expectedBp, 1)}</td><td>${bp(r.termPremiumBp, 1)}</td></tr>`).join("")}</tbody></table>
      ${how("New York Fed's Adrian–Crump–Moench model: the 10-year yield = the average short rate the market expects over 10 years + a term premium (extra pay for holding long bonds). Model estimates, published daily.")}
    </div></div>
    <div class="grid g2" style="margin-top:12px"><div>
      <table><thead><tr><th class="t">Curve factor (model-free)</th><th>Now</th><th>1 month</th><th>1 year</th></tr></thead><tbody>
      <tr><td class="t">Level <span class="faint small">average of 3m, 2y, 10y</span></td><td class="mono">${ypct(F.level)}</td><td>${bp(F.d21.levelBp)}</td><td>${bp(F.d252.levelBp)}</td></tr>
      <tr><td class="t">Slope <span class="faint small">10y − 3m</span></td><td class="mono">${bp(F.slopeBp)}</td><td>${bp(F.d21.slopeBp)}</td><td>${bp(F.d252.slopeBp)}</td></tr>
      <tr><td class="t">Curvature <span class="faint small">2·2y − 3m − 10y</span></td><td class="mono">${bp(F.curvatureBp)}</td><td>${bp(F.d21.curvatureBp)}</td><td>${bp(F.d252.curvatureBp)}</td></tr></tbody></table>
    </div><div>${pc ? `
      <table><thead><tr><th class="t">Principal component</th><th>Share of daily moves</th><th>Last day: 10y effect</th><th>Size</th></tr></thead><tbody>${["Level (all maturities together)", "Slope (short vs long)", "Curvature (middle vs ends)"].map((n, k) => `<tr><td class="t small">${n}</td><td>${pct(pc.share[k], 1, false)}</td><td class="${bcls(pc.lastDay.contrib10[k])}">${bp(pc.lastDay.contrib10[k], 1)}</td><td>${fin(pc.lastDay.sigmas[k]) ? `${pc.lastDay.sigmas[k] >= 0 ? "+" : "−"}${Math.abs(pc.lastDay.sigmas[k]).toFixed(1)} σ` : "—"}</td></tr>`).join("")}</tbody></table>
      ${how(`Estimated on ${pc.n} days of curve changes (${esc(fmtDate(pc.from))} – ${esc(fmtDate(pc.to))}). The three effects plus the rest (${bp(pc.lastDay.other10, 1)}) add up to the 10-year's actual move on the last day: ${bp(pc.lastDay.actual10, 1)}.`)}` : ""}
    </div></div>`;
  const ac = A.acm, tpChart = ac ? bChart([{ name: "10-year term premium (ACM)", color: "var(--accent)", pts: ac.hist.map(([d, v]) => [dX(d), v]) }, { name: "expected average short rate, 10 years", color: "var(--c3)", pts: ac.rnyHist.map(([d, v]) => [dX(d), v]) }], { zero: true, xFmt: yearFmt, yFmt: v => v.toFixed(1) + "%" }) : "";
  const policy = P ? `<table><tbody>
      <tr><td class="t">Effective fed funds rate</td><td class="mono">${ypct(P.effr)}</td><td class="t small muted">target range ${P.rangeLo}–${P.rangeHi}% (FOMC) · ${esc(fmtDate(P.effrDate))}</td></tr>
      <tr><td class="t">SOFR</td><td class="mono">${ypct(P.sofr)}</td><td class="t small muted">overnight secured funding · ${esc(fmtDate(P.sofrDate))}</td></tr>
      <tr><td class="t">2-year − fed funds</td><td class="mono">${bp(P.twoMinusEffrBp)}</td><td class="t small muted">${P.twoMinusEffrBp > 25 ? "the market prices policy rates higher over 2 years (hikes, or a term premium)" : P.twoMinusEffrBp < -25 ? "the market prices rate cuts over the next 2 years" : "little change priced over 2 years"}</td></tr>
      <tr><td class="t">3-month − fed funds</td><td class="mono">${bp(P.threeMMinusEffrBp)}</td><td class="t small muted">${Math.abs(P.threeMMinusEffrBp) < 15 ? "no move priced for the next meeting or two" : P.threeMMinusEffrBp > 0 ? "leaning toward a hike soon" : "leaning toward a cut soon"}</td></tr>
      ${ac ? `<tr><td class="t">10-year term premium (ACM)</td><td class="mono">${ypct(ac.tp10)}</td><td class="t small muted">${pctile(ac.pct)} percentile since 1990 · 1 month ${bp(ac.d21, 1)} · 1 year ${bp(ac.d252, 1)} · ${esc(fmtDate(ac.date))}</td></tr>` : ""}
    </tbody></table>${how("Spreads of market yields over the policy rate show what the market expects the Fed to do, mixed with a premium for lending longer. They are readings of market pricing, not forecasts by KUBER.")}` : "";
  const rec = R ? `<div class="result"><div><div class="k">NY Fed (official)</div><div class="v">${pct(R.official.prob, 1, false)}</div><div class="s">for ${esc(monFmt(dX(R.official.forMonth)))} · from the ${esc(monFmt(dX(R.official.spreadMonth)))} spread ${R.official.basedOnSpread.toFixed(2)} pts</div></div>${R.mtd ? `<div><div class="k">KUBER, this month so far</div><div class="v">${pct(R.mtd.prob, 1, false)}</div><div class="s">for ${esc(monFmt(dX(R.mtd.forMonth)))} · spread ${R.mtd.spread.toFixed(2)} pts over ${R.mtd.days} days</div></div>` : ""}</div>
    ${bChart([{ name: "probability of recession 12 months ahead", color: "var(--neg)", pts: R.hist.map(([d, v]) => [dX(d), v * 100]) }], { xFmt: yearFmt, yFmt: v => v.toFixed(0) + "%", spans: spansOf(R.nber), legend: false })}
    ${how(`Model: P = Φ(−0.5333 − 0.6330 × spread), the 10-year minus 3-month Treasury spread averaged over a month (Estrella & Mishkin; published by the New York Fed). Grey bands are US recessions (NBER). KUBER's month-to-date figure uses the Treasury 3-month yield; the NY Fed uses the 3-month bill on a bond-equivalent basis${R.consistency ? `, which differed by ${bp(R.consistency.diffBp, 1)} last month` : ""}. The curve has signalled every US recession since 1968 but with variable lead times and some false alarms (e.g. 1966, 2022–24).`)}` : "";
  return `<div class="stack">
    ${pn("Today", "live yields, latest session (Tradeweb via CNBC)", `<div id="bintra">${intraBonds()}</div>`)}
    <div class="grid g2">${pn("Yield curve", `official, as of ${esc(fmtDate(A.asOf))}`, curve + how("Yields by maturity. A normal curve rises with maturity; an inverted one (short above long) has historically preceded recessions."))}${pn("Shape of the curve", "spreads in basis points (1 bp = 0.01%)", shape + `<div style="margin-top:10px">${spreadChart}</div>`, false)}</div>
    ${pn("Every maturity", "changes in basis points; red = yields up (bond prices down)", tenTable, true)}
    ${pn("What moved the 10-year", "", moved)}
    <div class="grid g2">${pn("Policy and expectations", "", policy + (tpChart ? `<div style="margin-top:10px">${tpChart}</div>` : ""))}${pn("Recession signal from the curve", "", rec)}</div>
    ${volPanel(A.vol)}
    ${mathPanel(A.risk, A.carry, A.fit ? `Carry and roll-down use a ${esc(A.fit.kind)} curve fitted to today's yields (average error ${A.fit.rmseBp.toFixed(1)} bp, largest ${A.fit.maxErrBp.toFixed(1)} bp).` : "")}
    ${betaPanel(A.rateBetas, "US stocks and the 10-year Treasury yield")}
  </div>`;
}
const spansOf = months => { const s = []; let a = null, prev = null; for (const d of months) { const t = dX(d); if (a == null) a = t; else if (t - prev > 40 * 864e5) { s.push([a, prev + 30 * 864e5]); a = t; } prev = t; } if (a != null) s.push([a, prev + 30 * 864e5]); return s; };
function volPanel(V) {
  return pn("Volatility and likely ranges", "GARCH(1,1) on daily yield changes, ranges by filtered historical simulation", `<table><thead><tr><th class="t">Yield</th><th>Now</th><th>Daily move now · usual</th><th>1 week: 50% · 90% range</th><th>1 month: 50% · 90% range</th><th class="t">Tested since start of data (1-month ranges)</th></tr></thead><tbody>${V.map(v => v.building ? `<tr><td class="t">${esc(v.label)}</td><td colspan="5" class="t small muted">building history: ${v.have} of ${v.need} days</td></tr>` : `<tr>
      <td class="t">${esc(v.label)}</td><td class="mono">${ypct(v.y, 3)}</td><td>${v.dailyBp.now.toFixed(1)} · ${v.dailyBp.long.toFixed(1)} bp</td>
      <td class="small">${ypct(v.ranges[5].p25)}–${ypct(v.ranges[5].p75)} · ${ypct(v.ranges[5].p05)}–${ypct(v.ranges[5].p95)}</td>
      <td class="small">${ypct(v.ranges[21].p25)}–${ypct(v.ranges[21].p75)} · ${ypct(v.ranges[21].p05)}–${ypct(v.ranges[21].p95)}</td>
      <td class="t small">${v.backtest ? `${v.backtest.n} months: inside 90% range <b>${pct(v.backtest.in90, 0, false)}</b> (Kupiec p ${v.backtest.kupiecP.toFixed(2)}${v.backtest.kupiecP < 0.05 ? ", <span class=\"neg\">miscalibrated</span>" : ", consistent with 90%"}), inside 50% ${pct(v.backtest.in50, 0, false)} · vs plain history: ${v.backtest.dmT > 2 ? '<span class="pos">better</span>' : v.backtest.dmT < -2 ? '<span class="neg">worse</span>' : "no clear difference"} (DM t ${v.backtest.dmT.toFixed(1)})` : "—"}</td></tr>`).join("")}</tbody></table>
    ${how("Ranges describe how far yields have typically moved given today's volatility; they do not predict direction (the centre is today's yield). Each month since the data begins, the model was refitted on the previous 1,000 days only and its range compared with what then happened.")}`, true);
}
function mathPanel(risk, carry, note) {
  return `<div class="grid g2">${pn("Price sensitivity at today's yields", "par bonds, semi-annual coupons, exact repricing", `<table><thead><tr><th class="t">Bond</th><th>Yield</th><th>Duration</th><th>Convexity</th>${[-100, -25, 25, 100].map(b => `<th>${b > 0 ? "+" : "−"}${Math.abs(b)} bp</th>`).join("")}</tr></thead><tbody>${risk.map(r => `<tr><td class="t">${esc(r.label)}</td><td class="mono">${ypct(r.y)}</td><td>${r.modified.toFixed(2)}</td><td>${r.convexity.toFixed(0)}</td>${[-100, -25, 25, 100].map(b => { const s = r.shocks.find(x => x.bp === b); return `<td class="${s.pct >= 0 ? "pos" : "neg"}">${s.pct >= 0 ? "+" : "−"}${Math.abs(s.pct).toFixed(2)}%</td>`; }).join("")}</tr>`).join("")}</tbody></table>${how("Price change of the bond for an instant parallel move in its yield. Duration ≈ % price change per 1% yield change; convexity makes falls in yields help more than rises hurt.")}`, false)}
    ${carry ? pn("One year of carry and roll-down", "if the curve stays where it is", `<table><thead><tr><th class="t">Bond</th><th>Yield</th><th>Roll-down</th><th>Coupon</th><th>Price gain</th><th>Total</th><th>Yields can rise</th></tr></thead><tbody>${carry.map(c => `<tr><td class="t">${c.T}-year</td><td class="mono">${ypct(c.yT)}</td><td>${bp(c.rollBp, 1)}</td><td>${c.incomePct.toFixed(2)}%</td><td>${c.pricePct >= 0 ? "+" : "−"}${Math.abs(c.pricePct).toFixed(2)}%</td><td><b>${c.totalPct.toFixed(2)}%</b></td><td>${fin(c.breakevenBp) ? c.breakevenBp.toFixed(0) + " bp" : "—"}</td></tr>`).join("")}</tbody></table>${how("Buy a par bond today, hold it a year, sell it at the yield of a bond one year shorter on today's curve. \"Yields can rise\" is how far yields could rise over the year before the total return turns negative. " + note)}`, false) : ""}</div>`;
}
function betaPanel(rows, title) {
  if (!rows?.length) return "";
  const lab = rows.find(r => r.yLabel)?.yLabel || "";
  return pn(title, `daily stock returns on daily yield changes, last 2 years · yield: ${esc(lab)}`, `<table><thead><tr><th class="t">Company</th><th>If the yield rises 10 bp</th><th>± (1 s.e.)</th><th>t</th><th>Share of daily moves explained</th><th>Previous 2 years</th><th class="t">Reading</th></tr></thead><tbody>${rows.map(r => r.building ? `<tr><td class="t">${esc(r.nm)}</td><td colspan="6" class="t small muted">only ${r.n} matching days so far</td></tr>` : `<tr><td class="t"><a href="#/c/${encodeURIComponent(r.id)}">${esc(r.nm)}</a></td><td class="mono ${r.per10 >= 0 ? "pos" : "neg"}">${r.per10 >= 0 ? "+" : "−"}${Math.abs(r.per10).toFixed(2)}%</td><td>${r.se10.toFixed(2)}%</td><td>${r.t.toFixed(1)}</td><td>${pct(r.r2, 1, false)}</td><td>${fin(r.prev10) ? `${r.prev10 >= 0 ? "+" : "−"}${Math.abs(r.prev10).toFixed(2)}% (t ${r.prevT.toFixed(1)})` : "—"}</td><td class="t small">${Math.abs(r.t) >= 2.5 ? (r.per10 < 0 ? "clearly hurt by rising yields" : "clearly helped by rising yields") : Math.abs(r.t) >= 2 ? "probably sensitive (borderline)" : "no reliable link"}${fin(r.prevT) && Math.abs(r.t) >= 2 && Math.sign(r.per10) !== Math.sign(r.prev10) ? "; <span class=\"neg\">sign flipped vs the previous period</span>" : ""}</td></tr>`).join("")}</tbody></table>${how("Regression of each stock's daily return on the same day's change in the yield, with Newey–West standard errors (robust to autocorrelation and changing volatility). A typical day moves the yield by about " + (rows.find(r => fin(r.sdBp))?.sdBp?.toFixed(1) || "—") + " bp. The share explained is usually small: rates are one influence among many. With ~20 stocks tested, expect about one |t| above 2 by chance.")}`, true);
}

// ── India ──
function inView(A) { return `<div id="bkpi">${inKpis(A)}</div>` + inRest(A); }
function inKpis(A) {
  const L = BDATA.live || {}, sec = b => A.securities.find(s => s.bucket === b), s10 = sec("9Y-10Y"), Pol = A.policy, sp = n => A.spreads.find(x => x.name.startsWith(n))?.bp;
  const liveVs = L.IN10Y && fin(s10?.ytm) ? (L.IN10Y.y - s10.ytm) * 100 : null, liveUS = L.IN10Y && L.US10Y ? (L.IN10Y.y - L.US10Y.y) * 100 : null;
  return `<div class="kpis">
    ${tile("India 10-year G-sec", L.IN10Y ? `${L.IN10Y.y.toFixed(3)}%` : ypct(s10?.ytm, 4), fin(liveVs) ? `${bp(liveVs, 1)} vs CCIL ${esc(fmtDate(A.asOf))} (${ypct(s10?.ytm, 4)})` : `${esc(s10?.security || "")}`)}
    ${tile("India 30-year", L.IN30Y ? `${L.IN30Y.y.toFixed(3)}%` : ypct(sec("28Y-30Y")?.ytm, 4), `CCIL ${ypct(sec("28Y-30Y")?.ytm, 4)}`)}
    ${tile("RBI repo rate", ypct(Pol?.repo), Pol ? `corridor ${Pol.sdf}% (SDF) – ${Pol.msf}% (MSF)` : "")}
    ${tile("10y − repo", bp(sp("10y − repo")), "term spread over the policy rate")}
    ${tile("10y − 91-day bill", bp(sp("10y − 91")), "slope of the curve")}
    ${tile("India − US 10-year", bp(fin(liveUS) ? liveUS : sp("India 10y")), fin(liveUS) ? "live" : "official closes")}
    ${tile("State bonds premium (10y)", bp(sp("State")), "SDL over central government")}
  </div>`;
}
function inRest(A) {
  const H = A.history;
  const curve = A.curves ? bChart(A.curves.map((c, i) => ({ name: `${c.name} (${fmtDate(c.date)})`, color: ["var(--text)", "var(--accent)", "var(--c3)"][i], dash: i ? "4 3" : "", w: i ? 1.2 : 2, pts: c.pts })), { xLog: true, xFmt: matFmt, yFmt: y => y.toFixed(2) + "%" }) : "";
  const zt = `<table><thead><tr><th class="t">Maturity</th><th>Zero yield</th><th>1 day</th>${A.days > 2 ? `<th>Since ${esc(fmtDate(A.firstDate))}</th>` : ""}</tr></thead><tbody>${(A.zero || []).map(z => `<tr><td class="t">${matFmt(z.m)}</td><td class="mono">${ypct(z.y, 3)}</td><td class="${bcls(z.d1)}">${bp(z.d1, 1)}</td>${A.days > 2 ? `<td class="${bcls(z.dFirst)}">${bp(z.dFirst, 1)}</td>` : ""}</tr>`).join("")}</tbody></table>`;
  const st = `<table><thead><tr><th class="t">Tenor</th><th class="t">Security</th><th>Yield to maturity</th><th>1 day</th></tr></thead><tbody>${A.securities.map(s => `<tr><td class="t">${esc(s.bucket)}</td><td class="t small">${esc(s.security)}${s.prevSecurity ? ` <span class="faint">(was ${esc(s.prevSecurity)})</span>` : ""}</td><td class="mono">${ypct(s.ytm, 4)}</td><td class="${bcls(s.d1)}">${bp(s.d1, 1)}</td></tr>`).join("")}</tbody></table>`;
  const spt = `<table><tbody>${A.spreads.map(s => `<tr><td class="t">${esc(s.name)}</td><td class="mono">${bp(s.bp, 1)}</td></tr>`).join("")}</tbody></table>`;
  const h30 = bChart([{ name: "India 30-year (market close)", color: "var(--accent)", pts: A.hist30.map(([d, v]) => [dX(d), v]) }, ...(A.hist10.length > 20 ? [{ name: "India 10-year", color: "var(--c3)", pts: A.hist10.map(([d, v]) => [dX(d), v]) }] : [])], { xFmt: yearFmt, yFmt: v => v.toFixed(1) + "%" });
  return `<div class="stack">
    ${pn("Today", "live India 10-year (CNBC); NDS-OM trades 09:00–17:00 IST", `<div id="bintra">${intraBonds()}</div>`)}
    <div class="grid g2">${pn("Zero-coupon yield curve", `CCIL, Nelson–Siegel–Svensson, as of ${esc(fmtDate(A.asOf))}`, curve + how(`CCIL publishes the curve's six parameters each evening; KUBER computes every maturity from them exactly. Parameters: β0 ${A.nss.b0}, β1 ${A.nss.b1}, β2 ${A.nss.b2}, β3 ${A.nss.b3}, τ1 ${A.nss.t1}, τ2 ${A.nss.t2}.`))}${pn("Zero yields by maturity", "", zt, true)}</div>
    <div class="grid g2">${pn("Benchmark securities", "CCIL tenor-wise yields (T-bill and SDL yields are auction cut-offs)", st, true)}${pn("Spreads", "basis points", spt + how("India's curve is built from official CCIL data, which KUBER began recording on " + esc(fmtDate(A.firstDate)) + ". CCIL shows only its last two days publicly, so KUBER (and the cloud collector, while the Mac is off) saves it every evening."), true)}</div>
    ${pn("History", `India 10-year: ${H.tenYearDays} days recorded so far · 30-year market closes since ${esc(fmtDate(H.from30))}`, h30 + how(`Long-history statistics (volatility, ranges, stock links) use <b>${esc(H.using)}</b>. They switch to the 10-year automatically once it has ${H.tenNeeded} days of its own; no free source publishes a long official India 10-year series.`))}
    ${volPanel(A.vol)}
    ${mathPanel(A.risk, A.carry, "Carry and roll-down use CCIL's zero-coupon curve as the par curve (they differ by a few basis points).")}
    ${betaPanel(A.rateBetas, "Indian stocks and government bond yields")}
  </div>`;
}

// live yields arrive every ~30 s: redraw only the tiles; a new analysis reloads the page's data
function onBondEvent(d) {
  if (!BDATA) return;
  if (d.live) { BDATA.live = d.live; BDATA.lastOk = Date.now(); const A = BDATA.analysis?.[BMK], k = $("#bkpi"); if (k && A && !A.building) k.innerHTML = BMK === "US" ? usKpis(A) : inKpis(A); }
  if (d.analysis) api("/api/bonds").then(r => { BDATA = r; if (route.name === "bonds" && !isTyping()) drawBonds(); }).catch(() => {});
}
