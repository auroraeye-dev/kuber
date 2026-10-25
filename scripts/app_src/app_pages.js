// ═════════════════════════════ KPIs ═════════════════════════════
function kpis(P) {
  if (!P.books.length) return `<p class="empty">No holdings yet. Add trades on the <a href="#/orders">Orders</a> page.</p>`;
  return P.books.map(B => { const X = BOOKS[B.mk], m = (v, sg) => priv(money(v, B.mk, sg));
    return `<div class="bookh"><b>${X.name} portfolio</b><span class="muted small">${X.ex} · in ${X.unit}${B.mk === "IN" ? "" : " (not converted to rupees)"}</span></div>
    <div class="kpis"><div class="kpi"><div class="k">Current value</div><div class="v">${m(B.value)}</div><div class="s">${B.open.length} holding${B.open.length === 1 ? "" : "s"}</div></div>
    <div class="kpi"><div class="k">Invested (cost)</div><div class="v">${m(B.invested)}</div><div class="s">from executed orders</div></div>
    <div class="kpi"><div class="k">Unrealised P&amp;L</div><div class="v ${SHOWPF ? cls(B.unreal) : ""}">${m(B.unreal, true)}</div><div class="s ${SHOWPF ? cls(B.unreal) : ""}">${priv(pct(B.unreal / B.invested, 2))}</div></div>
    <div class="kpi"><div class="k">Realised P&amp;L</div><div class="v ${SHOWPF ? cls(B.realised) : ""}">${m(B.realised, true)}</div><div class="s">closed trades</div></div>
    <div class="kpi"><div class="k">Day change</div><div class="v ${SHOWPF ? cls(B.day) : ""}">${m(B.day, true)}</div><div class="s">vs previous close</div></div>
    <div class="kpi"><div class="k">XIRR</div><div class="v ${SHOWPF ? cls(B.xirr) : ""}">${priv(fin(B.xirr) ? pct(B.xirr, 1) : "—")}</div><div class="s">annualised, by order dates</div></div></div>`; }).join("");
}
// Show / hide portfolio amounts (PIN checked by the engine, same PIN and lock-out as the login)
function pfBar() {
  return SHOWPF ? `<button class="btn sm" data-pf="hide">Hide amounts</button>`
    : `<form class="pfform" id="pfform" novalidate><label for="pfpin" class="small muted">Amounts hidden</label><input id="pfpin" type="password" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="PIN" aria-label="PIN to show amounts"><button class="btn sm primary" type="submit">Show amounts</button><span class="small neg" id="pfmsg" role="status"></span></form>`;
}
function setShowPf(on, auto) {
  clearTimeout(showPfT);
  if (auto && isTyping()) { showPfT = setTimeout(() => setShowPf(false, true), 30e3); return; }   // don't wipe a form being typed in; try again shortly
  SHOWPF = on; if (on) showPfT = setTimeout(() => setShowPf(false, true), 10 * 60e3);
  document.activeElement?.blur?.(); render();
}
document.addEventListener("click", e => { if (e.target.closest("[data-pf=hide]")) setShowPf(false); });
document.addEventListener("submit", async e => {
  if (e.target.id !== "pfform") return; e.preventDefault(); const pin = $("#pfpin").value.trim(), msg = $("#pfmsg");
  if (!/^\d{4,8}$/.test(pin)) { msg.textContent = "Enter your PIN."; return; }
  try { await api("/api/reveal", { method: "POST", body: { pin } }); setShowPf(true); } catch (err) { msg.textContent = err.message; $("#pfpin").value = ""; }
});
// holdings, one table per market, each in its own currency
function holdingsTable(P) {
  const books = P.books.filter(B => B.open.length);
  if (!books.length) return `<p class="empty" style="padding:12px 14px">No holdings yet. Add trades on the <a href="#/orders">Orders</a> page.</p>`;
  return books.map(B => `${books.length > 1 ? `<div class="bookrow">${BOOKS[B.mk].name} · ${BOOKS[B.mk].cur}</div>` : ""}<table><thead><tr><th class="t">Stock</th><th>Qty</th><th>Avg cost</th><th>Last</th><th>Value</th><th>P&amp;L</th><th>P&amp;L %</th><th>Weight</th><th>Day</th><th>Score</th></tr></thead><tbody>${B.open.map(h => { const c = h.c || { cur: BOOKS[B.mk].cur }, pl = SHOWPF ? cls(h.pl) : "";
    return `<tr class="click" data-go="${h.c ? "#/c/" + encodeURIComponent(h.c.id) : "#/orders"}"><td class="t"><div class="co"><b>${esc(h.c?.nm || h.name)}</b><span>${esc(h.sym)}</span></div></td><td>${priv(String(h.q))}</td><td>${priv(px(h.avg, c))}</td><td>${px(h.px, c)}</td><td>${priv(money(h.value, B.mk))}</td><td class="${pl}">${priv(money(h.pl, B.mk, true))}</td><td class="${pl}">${priv(pct(h.pl / h.cost))}</td><td>${priv(pct(h.w, 1, false))}</td><td class="${cls(h.c?.chg)}">${fin(h.c?.chg) ? pct(h.c.chg / 100, 2) : "—"}</td><td>${h.c ? scoreBadge(RES[h.c.id]) : ""}</td></tr>`; }).join("")}</tbody></table>`).join("");
}

// ═════════════════════════════ company: live section ═════════════════════════════
const DETAIL = {};
async function secLive(P, c) {
  P.innerHTML = sh("Live") + `<div class="panel"><div class="body"><p class="muted">Loading live data…</p></div></div>`;
  try { const [d, rv] = await Promise.all([api("/api/company/" + encodeURIComponent(c.id)), api("/api/rv/" + encodeURIComponent(c.id)).catch(() => [])]); DETAIL[c.id] = d; d.rv = rv; STATE.liveAnalysis[c.id] = d.analyses; } catch (e) { P.innerHTML = sh("Live") + `<p class="note warn">The engine didn't respond: ${esc(e.message)}</p>`; return; }
  drawLive(c);
}
function drawLive(c) {
  const P = $("#s-live"), D = DETAIL[c.id]; if (!P || !D) return;
  const mk = c.mk === "TW" ? "US" : c.mk, open = STATE.markets?.[mk], v = D.verify, cal = D.calib, an = (STATE.liveAnalysis[c.id] || []).filter(a => a.H === 52), last = an[an.length - 1];
  const ticks = D.ticks || [], tz = c.mk === "IN" ? "Asia/Kolkata" : c.mk === "KR" ? "Asia/Seoul" : "America/New_York";
  const auto = D.preds.filter(p => p.kind === "auto"), scored = auto.filter(p => p.scored), pending = auto.filter(p => !p.scored);
  P.innerHTML = sh("Live", `${open ? '<span class="dot on"></span>Market open: prices update every 15 seconds while this page is open' : '<span class="dot"></span>Market closed: showing the last close'}`) + `
  <div class="grid g2">
    <div class="panel"><header><h2>Price</h2><span class="r small muted">${esc(c.priceSource || "")}</span></header><div class="body">
      <div style="display:flex;gap:16px;align-items:baseline;flex-wrap:wrap"><span class="mono" style="font-size:24px" data-live-px="${esc(c.id)}">${px(c.px, c)}</span><span class="mono ${cls(c.chg)}" data-live-chg="${esc(c.id)}">${fin(c.chg) ? pct(c.chg / 100, 2) : ""}</span><span class="small faint">updated <span id="livetime">${c.live?.time ? new Date(c.live.time * 1000).toLocaleTimeString() : (c.pxDate ? fmtDate(c.pxDate) + " close" : "—")}</span></span></div>
      ${ticks.length > 5 ? intradayChart(c, ticks, tz) : `<p class="small faint">No intraday ticks stored yet${open ? " — they appear within a minute" : ""}.</p>`}
      <p class="small" style="margin-bottom:0">${v ? (v.ok ? `<span class="badge ok">verified</span> Feed close ${px(v.feed_close, c)} matches the filings-site close ${px(v.src_close, c)} on ${fmtDate(v.src_date)} (${pct(v.diff, 2)}).` : `<span class="badge no">check</span> Feed close ${px(v.feed_close, c)} differs from the filings-site close ${px(v.src_close, c)} on ${fmtDate(v.src_date)} by ${pct(v.diff, 2)}.`) : `<span class="badge">not yet verified</span> Cross-check runs after the first price sync.`}</p></div></div>
    <div class="panel"><header><h2>Continuous analysis</h2><span class="r"><button class="btn sm" id="runan">Run now</button></span></header><div class="body">
      ${last ? `<div class="result"><div><div class="k">52-wk median</div><div class="v">${px(last.median, c)}</div><div class="s">${fmtTime(last.ts)}</div></div><div><div class="k">90% range</div><div class="v small">${px(last.p05, c)} – ${px(last.p95, c)}</div></div><div><div class="k">P(gain)</div><div class="v">${pct(last.pUp, 0, false)}</div></div><div><div class="k">Volatility</div><div class="v">${pct(last.vol, 0, false)}</div></div></div>
        ${an.length > 2 ? bandHistoryChart(c, an) : ""}<p class="small faint" style="margin-bottom:0">${an.length} analyses stored in the last 4 days. While the market is open and this page is open, KUBER re-runs the model every minute on the newest price.</p>` : `<p class="muted">No analysis stored yet. Press "Run now".</p>`}
    </div></div>
    <div class="panel"><header><h2>This stock's model</h2><span class="r"><a class="btn sm" href="#/learn">Learning</a></span></header><div class="body">${modelPanel(D.model, cal, c)}</div></div>
    <div class="panel"><header><h2>Realised vs forecast volatility</h2><span class="muted small">each trading day, from KUBER's own samples</span></header><div class="body flush tbl">${rvTable(D.rv || [])}</div></div>
    <div class="panel"><header><h2>Automatic forecast record</h2><span class="muted small">${scored.length} scored · ${pending.length} waiting</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Made</th><th>Weeks</th><th class="t">Target</th><th>Median</th><th>90% range</th><th>Actual</th><th class="t">Result</th></tr></thead><tbody>${auto.slice(0, 12).map(p => `<tr><td class="t mono small">${esc(p.made)}</td><td>${p.H}</td><td class="t mono small">${esc(p.target)}</td><td>${px(p.median, c)}</td><td class="small">${px(p.p05, c)} – ${px(p.p95, c)}</td><td>${p.scored ? px(p.actual, c) : '<span class="faint">waiting</span>'}</td><td class="t">${p.scored ? `<span class="badge ${p.in90 ? "ok" : "no"}">${p.in90 ? "in 90%" : "outside"}</span>` : ""}</td></tr>`).join("") || `<tr><td class="t muted" colspan="7">KUBER logs a 4-week and a 13-week forecast every week and scores them when the date arrives.</td></tr>`}</tbody></table></div></div>
  </div>`;
  $("#runan").onclick = async e => { e.target.disabled = true; try { const a = await api("/api/analyse/" + encodeURIComponent(c.id), { method: "POST", body: { H: 52 } }); (STATE.liveAnalysis[c.id] ||= []).push(a); drawLive(c); } finally { e.target.disabled = false; } };
}
function modelPanel(m, cal, c) {
  if (!m && !cal) return `<p class="muted">Not learned yet. Learning runs at start-up and every day.</p>`;
  const M = m ? JSON.parse(m.metrics || "{}") : {}, sp = m ? JSON.parse(m.spec) : null, cm = cal ? JSON.parse(cal.metrics || "{}") : {};
  return `<ul class="list">
    <li><span class="muted small">Model in use</span><span>${m?.accepted ? '<span class="badge ok">own model</span>' : '<span class="badge">standard model</span>'}</span></li>
    <li><span class="muted small">Specification</span><span class="small" style="text-align:right">${esc(specText(sp))}</span></li>
    ${M.candidate && !m.accepted && JSON.stringify(M.candidate) !== JSON.stringify(M.base) ? `<li><span class="muted small">Best alternative found (rejected)</span><span class="small faint" style="text-align:right">${esc(specText(M.candidate))}</span></li>` : ""}
    ${M.nHold ? `<li><span class="muted small">Hold-out test (from ${esc(fmtDate(M.holdFrom))})</span><span class="mono small">${M.nHold} forecasts · DM t ${x2(M.dm?.t)}</span></li>` : ""}
    <li><span class="muted small">Band factor κ · drift correction</span><span class="mono">${cal?.accepted ? `× ${x2(cal.kappa_adj)} · ${pct(cal.mu_adj, 1)}/yr` : "none"}</span></li>
  </ul><p class="small muted" style="margin-bottom:0">${esc(M.note || "")}${cm.note ? ". Calibration: " + esc(cm.note) + "." : ""}</p>
  ${c.corpActions?.length ? `<p class="small faint" style="margin-bottom:0">Corporate action${c.corpActions.length > 1 ? "s" : ""} excluded from the return history: ${c.corpActions.map(a => `${esc(fmtDate(a.date))} (exchange price ${pct(a.rawMove, 1)})`).join(", ")}.</p>` : ""}`;
}
function rvTable(rows) {
  if (!rows.length) return `<p class="muted small" style="padding:10px 12px;margin:0">Filled in at each market close: realised volatility from the day's 5-minute samples and from its open/high/low/close, next to what the model forecast for that week.</p>`;
  const both = rows.filter(r => fin(r.rs_range) && fin(r.model_vol)), ratio = both.length ? Q.mean(both.map(r => Math.sqrt((r.rs_range + (r.overnight || 0)) * 252) / r.model_vol)) : null;
  return `<table><thead><tr><th class="t">Day</th><th>Samples</th><th>5-min realised</th><th>Range-based</th><th>Model</th></tr></thead><tbody>${rows.slice(0, 10).map(r => `<tr><td class="t mono small">${esc(r.date)}</td><td>${r.n_ticks}</td><td>${annVol(r.rv_5m, 252)}</td><td>${annVol(fin(r.rs_range) ? r.rs_range + (r.overnight || 0) : null, 252)}</td><td>${fin(r.model_vol) ? pct(r.model_vol, 0, false) : "—"}</td></tr>`).join("")}</tbody></table>
  ${ratio != null ? `<p class="small faint" style="padding:6px 12px;margin:0">Over ${both.length} day${both.length > 1 ? "s" : ""}, realised (range-based) averaged ${x2(ratio)} × the forecast. One day is noisy; this becomes informative after a few weeks. The 5-minute figure leaves out the overnight gap.</p>` : ""}`;
}
const fmtTime = ts => new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function intradayChart(c, ticks, tz) {
  const W = 600, H = 150, p = { l: 4, r: 66, t: 8, b: 18 }, xs = ticks.map(t => t.ts), ys = ticks.map(t => t.price), x0 = Math.min(...xs), x1 = Math.max(...xs), lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.1 || hi * 0.002;
  const X = x => p.l + (x - x0) / (x1 - x0 || 1) * (W - p.l - p.r), Y = y => p.t + (1 - (y - lo + pad) / (hi - lo + 2 * pad)) * (H - p.t - p.b);
  const tl = t => new Date(t * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Intraday price"><line class="grid" x1="${p.l}" x2="${W - p.r}" y1="${Y(hi)}" y2="${Y(hi)}"/><line class="grid" x1="${p.l}" x2="${W - p.r}" y1="${Y(lo)}" y2="${Y(lo)}"/><text x="${W - p.r + 4}" y="${Y(hi) + 3}">${esc(px(hi, c))}</text><text x="${W - p.r + 4}" y="${Y(lo) + 3}">${esc(px(lo, c))}</text><path class="price" d="${ticks.map((t, i) => `${i ? "L" : "M"}${X(t.ts).toFixed(1)},${Y(t.price).toFixed(1)}`).join("")}"/><text x="${p.l}" y="${H - 4}">${tl(x0)}</text><text x="${W - p.r}" y="${H - 4}" text-anchor="end">${tl(x1)} (exchange time)</text></svg>`;
}
function bandHistoryChart(c, an) {
  const W = 600, H = 120, p = { l: 4, r: 66, t: 8, b: 16 }, n = an.length, lo = Math.min(...an.map(a => a.p05)), hi = Math.max(...an.map(a => a.p95));
  const X = i => p.l + i / (n - 1) * (W - p.l - p.r), Y = y => p.t + (1 - (y - lo) / (hi - lo || 1)) * (H - p.t - p.b);
  const band = "M" + an.map((a, i) => `${X(i)},${Y(a.p95)}`).join("L") + "L" + an.slice().reverse().map((a, i) => `${X(n - 1 - i)},${Y(a.p05)}`).join("L") + "Z";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="How the 52-week forecast changed across recent analyses" style="margin-top:8px"><path class="band90" d="${band}"/><path class="median" d="${an.map((a, i) => `${i ? "L" : "M"}${X(i)},${Y(a.median)}`).join("")}"/><path class="price" d="${an.map((a, i) => `${i ? "L" : "M"}${X(i)},${Y(a.px)}`).join("")}"/><text x="${W - p.r + 4}" y="${Y(hi) + 3}">${esc(px(hi, c))}</text><text x="${W - p.r + 4}" y="${Y(lo) + 3}">${esc(px(lo, c))}</text><text x="${p.l}" y="${H - 3}">forecast history: price, median, 90% band</text></svg>`;
}

// ═════════════════════════════ company: 90-day outlook ═════════════════════════════
const FACTNAME = { capm: "CAPM (market risk)", valuation: "Valuation (earnings, revenue growth, book)", momentum: "Momentum", sample: "Own past return", meanrev: "Mean reversion", rf: "Risk-free rate", sentiment: "News sentiment" };
const addTradingDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); let k = 0; while (k < n) { t.setUTCDate(t.getUTCDate() + 1); const w = t.getUTCDay(); if (w && w < 6) k++; } return t.toISOString().slice(0, 10); };
async function secOutlook(P, c) {
  P.innerHTML = sh("90-day outlook") + `<div class="panel"><div class="body"><p class="muted">Loading…</p></div></div>`;
  let D; try { D = await api("/api/ladder/" + encodeURIComponent(c.id)); } catch (e) { P.innerHTML = sh("90-day outlook") + `<p class="note warn">${esc(e.message)}</p>`; return; }
  if (!D.run) { P.innerHTML = sh("90-day outlook") + `<div class="panel"><div class="body"><p class="muted" style="margin:0">The first outlook is logged at the next completed close.</p></div></div>`; return; }
  const R = D.rows, run = D.run, cal = D.calib, kp = run.kappa || [1, 1, 1, 1], pick = [1, 2, 5, 10, 20, 40, 60, 90].filter(h => h <= R.length);
  const W = run.weights, wTxt = W ? Object.entries(W).filter(([, v]) => v > 0).map(([k, v]) => `${FACTNAME[k] || k} ${pct(v, 0, false)}`).join(" · ") : "CAPM only (no other factor beat it on unseen years)";
  P.innerHTML = sh("90-day outlook", `made from the ${fmtDate(run.made)} close · one forecast for each of the next 90 trading days`) + `
  <div class="panel"><div class="body">${ladderChart(c, R, run)}
    <div class="legend"><span><i style="border-color:var(--accent);border-top-style:dashed"></i>Median</span><span><i style="border-color:var(--accent);opacity:.4;border-top-width:8px"></i>50% / 90% ranges</span>${R.some(r => r.scored) ? `<span><i style="border-color:var(--c4)"></i>Actual closes so far</span>` : ""}</div>
    <div class="tbl" style="margin-top:10px"><table><thead><tr><th class="t">Trading day</th><th class="t">About</th><th>Median</th><th>50% range</th><th>90% range</th><th>P(above today)</th><th>Actual</th></tr></thead><tbody>${pick.map(h => { const r = R[h - 1]; return `<tr><td class="t">+${h}</td><td class="t small mono">${esc(r.actual_date || addTradingDays(run.made, h))}</td><td>${px(r.p50, c)}</td><td class="small">${px(r.p25, c)} – ${px(r.p75, c)}</td><td class="small">${px(r.p05, c)} – ${px(r.p95, c)}</td><td>${pct(r.pUp, 0, false)}</td><td>${r.scored ? `${px(r.actual, c)} <span class="badge ${r.in90 ? "ok" : "no"}">${r.in90 ? "in 90%" : "outside"}</span>` : '<span class="faint">waiting</span>'}</td></tr>`; }).join("")}</tbody></table></div>
    <p class="small faint" style="margin-bottom:0">Dates skip weekends but not exchange holidays; each forecast is scored on the close of the h-th actual trading day.</p></div></div>
  <div class="grid g2" style="margin-top:14px">
    <div class="panel"><header><h2>How this stock's outlook is tuned</h2></header><div class="body"><ul class="list">
      <li><span class="muted small">Daily volatility model</span><span class="small">GARCH(1,1) on 3 years of daily returns · ${pct(run.vol, 0, false)} a year now</span></li>
      <li><span class="muted small">Growth per year (after ${pct(run.q || 0, 1, false)} dividend yield)</span><span class="mono">${pct(run.mu, 1)}</span></li>
      <li><span class="muted small">Factor weights</span><span class="small" style="text-align:right">${esc(wTxt)}</span></li>
      <li><span class="muted small">Band factor by horizon (1–5 · 6–20 · 21–60 · 61–90 days)</span><span class="mono">${kp.map(x => "×" + x2(x)).join(" · ")}</span></li></ul>
      <p class="small muted" style="margin-bottom:0">${cal ? esc(cal.note) + "." : "Learning hasn't run yet."} Weights tried on the past: ${cal?.weightsTried ? esc(Object.entries(cal.weightsTried).map(([k, v]) => `${FACTNAME[k] || k} ${pct(v, 0, false)}`).join(", ")) : "—"}${cal?.weightsTried && !cal.weights ? " (rejected: not better on later years)" : ""}. News sentiment joins the candidates once a few months of labelled headlines exist in the live record.</p></div></div>
    <div class="panel"><header><h2>Outlook record</h2><span class="muted small">${D.runs} outlook${D.runs === 1 ? "" : "s"} logged · ${D.scored.toLocaleString()} days scored · ${D.pending.toLocaleString()} waiting</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Days ahead</th><th>Live: scored</th><th>Live: in 90%</th><th>Live: in 50%</th><th>Replay: in 90% (before → after tuning)</th></tr></thead><tbody>${D.record.map((b, i) => { const rb = cal?.buckets?.[i]; return `<tr><td class="t">${b.range}</td><td>${b.n}</td><td>${b.n ? pct(b.in90, 0, false) : "—"}</td><td>${b.n ? pct(b.in50, 0, false) : "—"}</td><td class="small">${rb ? `${pct(rb.cov90, 0, false)} → ${pct(rb.cov90adj, 0, false)} (${rb.n.toLocaleString()} days)` : "—"}</td></tr>`; }).join("")}</tbody></table></div><div class="body small faint">Live scoring starts the trading day after the first outlook. "Replay" re-runs the same daily model over the past using only data available on each date.</div></div>
  </div>`;
}
function ladderChart(c, R, run) {
  const W = 760, H = 240, p = { l: 6, r: 78, t: 10, b: 22 }, n = R.length, lo = Math.min(run.p0, ...R.map(r => Math.min(r.p05, r.actual ?? Infinity))), hi = Math.max(run.p0, ...R.map(r => Math.max(r.p95, r.actual ?? -Infinity)));
  const X = h => p.l + h / n * (W - p.l - p.r), Y = y => p.t + (1 - (Math.log(y) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (H - p.t - p.b);
  const band = (a, b) => `M${X(0)},${Y(run.p0)}` + R.map(r => `L${X(r.h).toFixed(1)},${Y(r[a]).toFixed(1)}`).join("") + R.slice().reverse().map(r => `L${X(r.h).toFixed(1)},${Y(r[b]).toFixed(1)}`).join("") + `L${X(0)},${Y(run.p0)}Z`;
  const act = R.filter(r => r.scored), ticks = [0, 20, 40, 60, 90].filter(h => h <= n);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="90-day outlook for ${esc(c.nm)}: median and ranges by trading day">
    ${[lo, run.p0, hi].map(v => `<line class="grid" x1="${p.l}" x2="${W - p.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${W - p.r + 4}" y="${Y(v) + 3}">${esc(px(v, c))}</text>`).join("")}
    <path class="band90" d="${band("p95", "p05")}"/><path class="band50" d="${band("p75", "p25")}"/>
    <path class="median" d="M${X(0)},${Y(run.p0)}${R.map(r => `L${X(r.h).toFixed(1)},${Y(r.p50).toFixed(1)}`).join("")}"/>
    ${act.length ? `<path class="actual" d="M${X(0)},${Y(run.p0)}${act.map(r => `L${X(r.h).toFixed(1)},${Y(r.actual).toFixed(1)}`).join("")}"/>` : ""}
    ${ticks.map(h => `<text x="${X(h)}" y="${H - 6}" text-anchor="${h === 0 ? "start" : h === n ? "end" : "middle"}">${h === 0 ? fmtDate(run.made) : "+" + h + "d"}</text>`).join("")}</svg>`;
}

// ═════════════════════════════ Ask KUBER (local LLM) ═════════════════════════════
function secAsk(P, c) {
  const L = STATE.llm || {};
  P.innerHTML = sh("Ask KUBER", L.running ? `Local model: ${esc(L.model || "none installed")}` : "Local LLM not running") + `<div class="panel ask"><div class="body">
    ${L.running && L.model ? `<p class="small muted" style="margin-top:0">Runs on your Mac with ${esc(L.model)}. It may only use KUBER's verified data for this company and the model output; it is told to say so when something isn't in the data. Check important answers against the linked sources.</p>
    <div class="sugg">${[`How does ${c.tk} make money?`, "What do the latest filings and headlines say?", "Explain the forecast range in plain words", "What are the main risks in the numbers?"].map(s => `<button type="button">${esc(s)}</button>`).join("")}</div>
    <form id="askf"><label class="small muted" for="askq">Question</label><textarea id="askq" style="min-height:70px"></textarea><div style="margin-top:8px"><button class="btn primary" id="askb" type="submit">Ask</button></div></form><div class="out" id="askout" aria-live="polite">Answers appear here.</div>`
    : `<p style="margin-top:0">Install a free local model to ask questions and label news without any usage cost. Set it up on the <a href="#/system">System</a> page.</p>`}</div></div>`;
  if (!(L.running && L.model)) return;
  P.querySelectorAll(".sugg button").forEach(b => b.onclick = () => { $("#askq").value = b.textContent; $("#askf").requestSubmit(); });
  $("#askf").onsubmit = async e => { e.preventDefault(); const q = $("#askq").value.trim(); if (!q) return; const out = $("#askout"), b = $("#askb"); b.disabled = true; out.textContent = "Thinking on your Mac…"; try { const r = await api("/api/llm/ask", { method: "POST", body: { cid: c.id, q } }); out.textContent = r.answer; } catch (err) { out.textContent = "The local model didn't answer: " + err.message; } finally { b.disabled = false; } };
}

// ═════════════════════════════ ALGORITHMS ═════════════════════════════
const ALGOS = [
  { id: "data", t: "Data & look-ahead control", d: "Every forecast only sees prices up to its as-of week and annual financials published at least this many days after the fiscal year ends. Returns use prices adjusted for dividends and splits; demerger days are excluded because the provider's adjustment for them proved wrong. Forecasts are stated at the exchange price.", f: [["data.window", "Price history used (weeks)", "int", 52, 260], ["data.minHistory", "Minimum history to forecast (weeks)", "int", 20, 104], ["data.lagDays", "Reporting lag for financials (days)", "int", 0, 180]] },
  { id: "garch", t: "Volatility · GARCH(1,1)", eq: "σₜ² = ω + α·εₜ₋₁² + β·σₜ₋₁²     (fitted by maximum likelihood)", d: "Estimates how volatile the stock is now and how fast that decays back to normal. α measures reaction to shocks, β the memory.", f: [["vol.alphaMax", "Largest α searched", "num", 0.1, 0.5], ["vol.betaMin", "Smallest β searched", "num", 0.2, 0.9], ["vol.floor", "Volatility floor (annual)", "num", 0.02, 0.4], ["vol.cap", "Volatility cap (annual)", "num", 0.4, 3]] },
  { id: "calib", t: "Band calibration · κ(H)", eq: "σ_used(H) = κ(H) × κ_company × σ_GARCH(H)", d: "Multiplies the GARCH volatility so the 90% band really holds about 90% of outcomes. Fitted on 2,083 walk-forward predictions.", f: [["vol.kappaKnots.0.1", "κ at 4 weeks", "num", 0.5, 2.5], ["vol.kappaKnots.1.1", "κ at 13 weeks", "num", 0.5, 2.5], ["vol.kappaKnots.2.1", "κ at 26 weeks", "num", 0.5, 2.5], ["vol.kappaKnots.3.1", "κ at 52 weeks", "num", 0.5, 2.5]] },
  { id: "sim", t: "Monte Carlo · price paths", eq: "ln Sₜ₊₁ = ln Sₜ + μ/52 − hₜ/2 + √hₜ · zₜ     (Itô drift correction −h/2)", d: "Filtered historical simulation resamples the stock's own standardised shocks, keeping fat tails. Gaussian draws normal shocks instead.", f: [["sim.method", "Shock distribution (standard model)", "select", ["fhs", "t", "gaussian"]], ["sim.paths", "Paths per forecast", "int", 1000, 50000]] },
  { id: "drift", t: "Drift μ · Bayesian blend", eq: "μ = Σᵢ (μᵢ / τᵢ²) ÷ Σᵢ (1 / τᵢ²)     over enabled signals", d: "Each signal is an estimate of next year's return with an uncertainty τ. Smaller τ means more weight. Only CAPM is on by default, because the others lowered backtest accuracy.", f: [["drift.capm.on", "CAPM prior on", "bool"], ["drift.capm.tau", "CAPM τ", "num", 0.01, 0.5], ["drift.valuation.on", "Valuation gap on", "bool"], ["drift.valuation.tau", "Valuation τ", "num", 0.01, 0.5], ["drift.valuation.years", "Years for gap to close", "num", 1, 10], ["drift.momentum.on", "12-1 momentum on", "bool"], ["drift.momentum.tau", "Momentum τ", "num", 0.01, 0.5], ["drift.momentum.k", "Momentum strength k", "num", 0, 1], ["drift.sample.on", "Sample mean on", "bool"], ["drift.sample.tau", "Sample mean τ (minimum)", "num", 0.05, 1], ["drift.sentiment.on", "News sentiment on (local LLM labels)", "bool"], ["drift.sentiment.tau", "Sentiment τ", "num", 0.01, 0.5], ["drift.sentiment.k", "Sentiment strength k", "num", 0, 0.5], ["drift.clampLo", "Lowest drift allowed", "num", -1, 0], ["drift.clampHi", "Highest drift allowed", "num", 0, 1]] },
  { id: "market", t: "Market assumptions", eq: "μ_CAPM = r_f + β × ERP", d: "Risk-free rate (r_f), equity risk premium (ERP), cost of equity (r) and no-growth P/E per market.", f: ["IN", "US", "KR", "TW"].flatMap(m => [[`market.${m}.rf`, `${m} risk-free rate`, "num", 0, 0.15], [`market.${m}.erp`, `${m} equity premium`, "num", 0, 0.15], [`market.${m}.r`, `${m} cost of equity`, "num", 0.03, 0.25], [`market.${m}.peBase`, `${m} no-growth P/E`, "num", 4, 30]]) },
  { id: "select", t: "Per-stock model selection", eq: "choose spec = argmin CRPS(selection period);  keep it only if Diebold–Mariano t > t* on the unseen hold-out", d: "For each stock you hold or watch, KUBER tests volatility models (GARCH, EWMA, constant), shock laws (bootstrapped, Student-t, Gaussian), 2/3/5-year windows and drift sources (CAPM, risk-free, momentum, valuation, Ornstein–Uhlenbeck mean reversion). It picks the best on older forecasts, then must beat the standard model on later forecasts it never saw. Scored by a CRPS-type quantile score, which rewards both the right centre and the right spread.", f: [["learn.selectModels", "Choose a model per stock", "bool"], ["learn.holdout", "Hold-out share of history", "num", 0.15, 0.5], ["learn.minGain", "Improvement needed to switch (fraction)", "num", 0, 0.1], ["learn.dmCrit", "Diebold–Mariano t needed (1.645 = 5% one-sided)", "num", 1, 3]] },
  { id: "learn", t: "Per-stock calibration", eq: "κ_c = argmin quantile score on past forecasts;  μ_c = mean log error × n/(n+n₀)", d: "On top of the stock's model, each run fits a band factor and a drift correction on older forecasts, then tests them on newer ones it hasn't seen (walk-forward epochs). An adjustment is kept only if it wins most epochs.", f: [["learn.enabled", "Use learned adjustments", "bool"], ["learn.minScored", "Minimum forecasts per epoch", "int", 3, 50], ["learn.shrinkN0", "Shrinkage n₀ (higher = more cautious)", "int", 0, 1000], ["learn.muCap", "Largest drift correction allowed (per year)", "num", 0, 0.5], ["learn.acceptMargin", "Required improvement (fraction)", "num", 0, 0.2]] },
  { id: "fv", t: "Fair value (information only)", eq: "FV = w_E × EPS × P/E_justified + w_B × BVPS × (ROE − g)/(r − g)", d: "Shown on company pages; used by the drift only if the valuation signal is switched on.", f: [["fairValue.wEarn", "Weight on earnings method", "num", 0, 1], ["fairValue.wBook", "Weight on book-value method", "num", 0, 1]] },
  { id: "score", t: "Score weights", d: "The 0–100 profile score. Backtests found no link to future returns, so this is descriptive only.", f: ["value", "quality", "growth", "edge", "trend", "safety"].map(k => [`score.weights.${k}`, FN[k], "num", 0, 1]) },
  { id: "diag", t: "Diagnostics (reported, not used in the forecast)", eq: "Variance ratio · Wald–Wolfowitz runs · Hurst R/S · 2-state hidden Markov model · Black–Scholes–Merton · RSI · MACD", d: "Shown on each company's Prediction section for context.", f: [] }
];
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split("."), last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; };
let ALGO = { draft: null, result: null, busy: false, hist: null };
async function vAlgo(M) {
  if (!ALGO.draft) ALGO.draft = Q.getParams();
  if (!ALGO.hist) api("/api/params").then(r => { ALGO.hist = r.history; if (route.name === "algo") vAlgo(M); });
  const D = ALGO.draft, A = Q.getParams(), changed = p => JSON.stringify(getPath(D, p)) !== JSON.stringify(getPath(A, p));
  const nChanged = ALGOS.flatMap(a => a.f).filter(f => changed(f[0])).length;
  M.innerHTML = `<div class="pagehead"><div><h1>Algorithms</h1><div class="sub">Every calculation KUBER runs, with its parameters. Change anything, validate it on a walk-forward backtest against the active version, then activate it. Active version: v${STATE.paramsVersion || "—"}.</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="areset" ${nChanged ? "" : "disabled"}>Discard changes</button><button class="btn" id="adef">Load defaults</button><button class="btn primary" id="aval" ${ALGO.busy ? "disabled" : ""}>${ALGO.busy ? "Validating…" : `Validate${nChanged ? ` ${nChanged} change${nChanged > 1 ? "s" : ""}` : ""}`}</button></div></div>
  ${ALGO.result ? validationPanel(ALGO.result) : ""}
  <div class="stack">${ALGOS.map(a => `<div class="panel"><header><h2>${esc(a.t)}</h2></header><div class="body">${a.eq ? `<div class="eq" style="margin-bottom:8px">${esc(a.eq)}</div>` : ""}<p class="small muted" style="margin-top:0">${esc(a.d)}</p>
    ${a.f.length ? `<div class="form">${a.f.map(([p, label, type, lo, hi]) => { const v = getPath(D, p), id = "p-" + p.replace(/\./g, "-"), mark = changed(p) ? ' style="border-color:var(--warn)"' : "";
      if (type === "bool") return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" data-p="${p}" data-t="bool"${mark}><option value="true" ${v ? "selected" : ""}>On</option><option value="false" ${!v ? "selected" : ""}>Off</option></select></div>`;
      if (type === "select") return `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" data-p="${p}" data-t="str"${mark}>${lo.map(o => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select></div>`;
      return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" type="number" data-p="${p}" data-t="${type}" min="${lo}" max="${hi}" step="${type === "int" ? 1 : "any"}" value="${v}"${mark}><span class="hint">active: ${esc(String(getPath(A, p)))}</span></div>`; }).join("")}</div>` : ""}</div></div>`).join("")}</div>
  <div class="panel" style="margin-top:14px"><header><h2>Version history</h2></header><div class="body flush tbl"><table><thead><tr><th class="t">Version</th><th class="t">Activated</th><th class="t">Note</th><th>In 90%</th><th>Interval score</th><th></th></tr></thead><tbody>${(ALGO.hist || []).map(h => { const m = JSON.parse(h.metrics || "null"), s = m?.candidate || m?.all || m; return `<tr><td class="t">v${h.id}${h.active ? ' <span class="badge ok">active</span>' : ""}</td><td class="t small">${esc(fmtTime(h.ts))}</td><td class="t small">${esc(h.note || "")}</td><td>${s?.in90 != null ? pct(s.in90, 1, false) : "—"}</td><td>${s?.iscore != null ? x2(s.iscore, 3) : "—"}</td><td>${h.active ? "" : `<button class="btn sm" data-rev="${h.id}">Revert to this</button>`}</td></tr>`; }).join("") || `<tr><td class="t muted" colspan="6">Loading…</td></tr>`}</tbody></table></div></div>`;
  M.querySelectorAll("[data-p]").forEach(el => el.onchange = () => { const t = el.dataset.t, v = t === "bool" ? el.value === "true" : t === "str" ? el.value : t === "int" ? Math.round(+el.value) : +el.value; setPath(ALGO.draft, el.dataset.p, v); ALGO.result = null; vAlgo(M); });
  $("#areset").onclick = () => { ALGO.draft = Q.getParams(); ALGO.result = null; vAlgo(M); };
  $("#adef").onclick = () => { ALGO.draft = JSON.parse(JSON.stringify(Q.DEFAULT_PARAMS)); ALGO.result = null; vAlgo(M); };
  $("#aval").onclick = async () => { ALGO.busy = true; vAlgo(M); try { ALGO.result = await api("/api/params/validate", { method: "POST", body: { params: ALGO.draft } }); } catch (e) { ALGO.result = { error: e.message }; } ALGO.busy = false; if (route.name === "algo") vAlgo(M); };
  M.querySelectorAll("[data-rev]").forEach(b => { let armed = false; b.onclick = async () => { if (!armed) { armed = true; b.textContent = "Confirm revert"; return; } await api("/api/params/revert/" + b.dataset.rev, { method: "POST" }); ALGO = { draft: null, result: null, busy: false, hist: null }; await reload(); render(); }; });
  const act = $("#aact"); if (act) { let armed = !!ALGO.result?.better; act.onclick = async () => { if (!armed) { armed = true; act.textContent = "Activate anyway"; return; } await api("/api/params/activate", { method: "POST", body: { params: ALGO.draft, note: $("#anote").value || "Edited on the Algorithms page", metrics: ALGO.result } }); ALGO = { draft: null, result: null, busy: false, hist: null }; await reload(); render(); }; }
}
function validationPanel(R) {
  if (R.error) return `<p class="note warn">Validation failed: ${esc(R.error)}</p>`;
  const row = (k, n, f, better) => `<tr><td class="t">${n}</td><td>${f(R.active[k])}</td><td>${f(R.candidate[k])}</td><td class="${better(R.candidate[k], R.active[k]) ? "pos" : "neg"}">${better(R.candidate[k], R.active[k]) ? "better" : "worse"}</td></tr>`;
  return `<div class="panel" style="margin-bottom:14px"><header><h2>Validation: walk-forward backtest, ${R.candidate.n.toLocaleString()} predictions</h2><span class="r">${R.better ? '<span class="badge ok">candidate is better</span>' : '<span class="badge no">candidate is not better</span>'}</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Measure</th><th>Active</th><th>Candidate</th><th></th></tr></thead><tbody>
    ${row("iscore", "Interval score (lower is better)", v => x2(v, 3), (a, b) => a < b)}${row("in90", "Inside 90% range (target 90%)", v => pct(v, 1, false), (a, b) => Math.abs(a - 0.9) <= Math.abs(b - 0.9))}${row("in50", "Inside 50% range (target 50%)", v => pct(v, 1, false), (a, b) => Math.abs(a - 0.5) <= Math.abs(b - 0.5))}${row("brier", "Brier score for P(gain) (lower is better)", v => x2(v, 4), (a, b) => a <= b)}${row("dir", "Direction right", v => pct(v, 1, false), (a, b) => a >= b)}${row("medErr", "Median price error", v => pct(v, 1, false), (a, b) => a <= b)}
  </tbody></table></div><div class="body" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><div class="field" style="flex:1;min-width:220px"><label for="anote">Note for this version</label><input id="anote" placeholder="What did you change and why?"></div><button class="btn ${R.better ? "primary" : ""}" id="aact">${R.better ? "Activate" : "Activate anyway (not recommended)"}</button></div></div>`;
}

// ═════════════════════════════ LEARNING ═════════════════════════════
let LEARN = null;
function outlookLearnPanel(L) {
  const rows = (L.ladder || []).map(r => ({ ...r, M: JSON.parse(r.metrics || "{}"), k: JSON.parse(r.kappa || "[1,1,1,1]"), w: r.weights ? JSON.parse(r.weights) : null })), live = Object.fromEntries((L.ladderScored || []).map(r => [r.cid, r]));
  if (!rows.length) return "";
  return `<div class="panel" style="margin-top:14px"><header><h2>90-day outlooks</h2><span class="muted small">${rows.filter(r => r.k.some(x => x !== 1)).length} of ${rows.length} stocks use their own horizon band factors · ${rows.filter(r => r.w).length} use learned factor weights</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Company</th><th>Replayed outlooks</th><th>Replay in 90% (1–5 · 6–20 · 21–60 · 61–90 days)</th><th>Band factors</th><th class="t">Factor weights</th><th>Live days scored</th><th>Live in 90%</th></tr></thead><tbody>
    ${rows.sort((a, b) => a.cid.localeCompare(b.cid)).map(r => { const lv = live[r.cid]; return `<tr><td class="t"><a href="#/c/${encodeURIComponent(r.cid)}">${esc(CO[r.cid]?.nm || r.cid)}</a></td><td>${r.M.runs || 0}</td><td class="small">${(r.M.buckets || []).map(b => pct(b.cov90adj, 0, false)).join(" · ") || "—"}</td><td class="mono small">${r.k.map(x => x2(x)).join(" · ")}</td><td class="t small">${r.w ? esc(Object.entries(r.w).map(([k, v]) => `${FACTNAME[k] || k} ${pct(v, 0, false)}`).join(", ")) : '<span class="faint">CAPM only</span>'}</td><td>${lv ? lv.n.toLocaleString() : 0}</td><td>${lv ? pct(lv.in90, 0, false) : "—"}</td></tr>`; }).join("")}
  </tbody></table></div><div class="body small faint">Each stock is forecast every trading day for each of the next 90 trading days, and every one of those days is scored when it arrives. The same model is also replayed over the past to calibrate each stock from day one. Factor weights are kept only when they beat CAPM on later years they weren't fitted on.</div></div>`;
}
async function vLearn(M) {
  M.innerHTML = `<div class="pagehead"><div><h1>Learning</h1><div class="sub">Every stock gets its own model, chosen by testing on data it has never seen. KUBER also logs its own forecasts, scores them when their date arrives, and learns a per-stock correction on top.</div></div><div style="display:flex;gap:8px"><button class="btn" id="lmaint">Sync prices &amp; score now</button><button class="btn primary" id="lrun">Run learning now</button></div></div><p class="muted" id="lload">Loading…</p>`;
  try { LEARN = await api("/api/learn"); } catch (e) { $("#lload").textContent = "The engine didn't respond: " + e.message; return; }
  const T = LEARN.track, cal = Object.fromEntries(LEARN.calib.map(r => [r.cid, r])), models = LEARN.models.map(m => ({ ...m, M: JSON.parse(m.metrics || "{}"), sp: JSON.parse(m.spec) }));
  const held = new Set(portfolio().open.map(P => P.c?.id).filter(Boolean)), tag = id => held.has(id) ? '<span class="badge ok">held</span>' : STATE.watch.has(id) ? '<span class="badge">watchlist</span>' : '<span class="badge">tracked</span>';
  models.sort((a, b) => b.accepted - a.accepted || (held.has(b.cid) - held.has(a.cid)) || a.cid.localeCompare(b.cid));
  const nOwn = models.filter(m => m.accepted).length, nTested = models.filter(m => m.M.nHold).length;
  const bySum = s => s ? `<div class="result"><div><div class="k">Scored forecasts</div><div class="v">${s.n}</div></div><div><div class="k">Inside 90%</div><div class="v">${pct(s.in90, 0, false)}</div></div><div><div class="k">Inside 50%</div><div class="v">${pct(s.in50, 0, false)}</div></div><div><div class="k">Direction right</div><div class="v">${pct(s.dir, 0, false)}</div></div><div><div class="k">Median error</div><div class="v">${pct(s.medErr, 1, false)}</div></div></div>` : `<p class="muted">Nothing scored yet. Automatic forecasts mature 4 and 13 weeks after they are made.</p>`;
  const delta = (a, b) => fin(a) && fin(b) && b ? `<span class="${a < b ? "pos" : a > b ? "neg" : ""}">${pct(a / b - 1, 1)}</span>` : "—";
  $("#lload").remove();
  M.insertAdjacentHTML("beforeend", `
  <div class="grid g2">
    <div class="panel"><header><h2>How each stock gets its own model</h2></header><div class="body small"><ol style="margin:0;padding-left:18px;line-height:1.7">
      <li>Re-run the model point-in-time every 3 weeks over the stock's 5-year history, for 4, 13 and 26-week horizons, using only data available on each date.</li>
      <li>Split by date: the first ${pct(1 - (Q.P.learn.holdout ?? 0.3), 0, false)} of forecasts choose the model; the last ${pct(Q.P.learn.holdout ?? 0.3, 0, false)} are a hold-out that the choice never sees.</li>
      <li>Search one choice at a time: volatility model, shock distribution, history window, drift signals. Score = CRPS-type quantile score (lower is better).</li>
      <li>Keep the alternative only if it beats the standard model on the hold-out with a Diebold–Mariano t above ${x2(Q.P.learn.dmCrit ?? 1.645)} (Newey–West errors for overlapping forecasts) and its 90% band coverage is no worse.</li>
      <li>Then fit the band factor κ and drift correction μ on top, kept only if they win most walk-forward epochs.</li></ol>
      <p class="muted" style="margin-bottom:0">Last run: ${LEARN.last ? fmtTime(LEARN.last) : "never"}. Runs at start-up, every day, and whenever a forecast or simulation is scored.</p></div></div>
    <div class="panel"><header><h2>Live track record</h2><span class="muted small">real forecasts, scored when their date arrived · ${T.pending} waiting</span></header><div class="body">${bySum(T.all)}${T.byH && Object.keys(T.byH).length ? `<table style="margin-top:8px"><thead><tr><th class="t">Horizon</th><th>Scored</th><th>In 90%</th><th>In 50%</th><th>Direction</th></tr></thead><tbody>${Object.entries(T.byH).map(([h, x]) => `<tr><td class="t">${h} week${h > 1 ? "s" : ""}</td><td>${x.n}</td><td>${pct(x.in90, 0, false)}</td><td>${pct(x.in50, 0, false)}</td><td>${pct(x.dir, 0, false)}</td></tr>`).join("")}</tbody></table>` : ""}<p class="small muted">KUBER logs 1, 4 and 13-week forecasts at every market close. The 1-week ones start scoring a week from now, which feeds learning fast.</p>${T.user ? `<p class="small muted">Your simulations: ${T.user.n} scored, ${pct(T.user.in90, 0, false)} inside the 90% range.</p>` : ""}</div></div>
  </div>
  <div class="panel" style="margin-top:14px"><header><h2>Each stock's model</h2><span class="muted small">${nOwn} of ${models.length} use their own model · ${nTested} had enough history to test</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Company</th><th class="t">Model in use</th><th class="t">Best alternative found</th><th>Selection score vs standard</th><th>Hold-out score vs standard</th><th>DM t</th><th>κ · μ correction</th></tr></thead><tbody>
    ${models.map(m => { const r = cal[m.cid], alt = m.M.candidate && JSON.stringify(m.M.candidate) !== JSON.stringify(m.M.base); return `<tr><td class="t"><a href="#/c/${encodeURIComponent(m.cid)}">${esc(CO[m.cid]?.nm || m.cid)}</a> ${tag(m.cid)}</td><td class="t small">${m.accepted ? '<span class="badge ok">own</span> ' : ""}${esc(specText(m.sp))}</td><td class="t small faint">${m.accepted ? "in use: passed the hold-out test" : alt ? esc(specText(m.M.candidate)) : esc(m.M.nHold ? "none better" : m.M.note || "")}</td><td>${delta(m.M.selScore, m.M.baseSel)}</td><td>${delta(m.M.holdScore, m.M.baseHold)}</td><td class="mono">${(m.accepted || alt) && fin(m.M.dm?.t) ? x2(m.M.dm.t) : "—"}</td><td class="mono small">${r?.accepted ? `× ${x2(r.kappa_adj)} · ${pct(r.mu_adj, 1)}` : "none"}</td></tr>`; }).join("") || `<tr><td class="t muted" colspan="7">Not run yet. Press "Run learning now".</td></tr>`}
  </tbody></table></div><div class="body small faint">Scores are relative to the standard model (negative = better). An alternative that wins on the selection period but loses on the hold-out is a model that fitted the past, not the stock, and is rejected.</div></div>
  ${outlookLearnPanel(LEARN)}
  <div class="panel" style="margin-top:14px"><header><h2>Calibration epochs</h2><span class="muted small">latest ${LEARN.log.length}</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Run</th><th class="t">Company</th><th>Epoch</th><th>Train / test</th><th>κ</th><th>μ</th><th>Base score</th><th>Corrected score</th><th class="t">Result</th></tr></thead><tbody>${LEARN.log.slice(0, 80).map(l => `<tr><td class="t small">${esc(fmtTime(l.run))}</td><td class="t">${esc(l.cid)}</td><td>${l.epoch}</td><td>${l.n_train} / ${l.n_valid}</td><td>${x2(l.kappa_adj)}</td><td>${pct(l.mu_adj, 1)}</td><td>${x2(l.base_score, 4)}</td><td>${x2(l.new_score, 4)}</td><td class="t">${l.accepted ? '<span class="badge ok">better</span>' : '<span class="badge no">worse</span>'}</td></tr>`).join("")}</tbody></table></div></div>
  <p class="small faint">A learned drift correction mostly captures how much a stock has out- or under-performed recently. That can reverse when the market changes, which is why it is shrunk toward zero, capped, and re-tested every run. No setting here turns the model into a reliable direction predictor.</p>`);
  $("#lrun").onclick = async e => { e.target.disabled = true; e.target.textContent = "Running… (about a minute)"; try { await api("/api/learn/run", { method: "POST" }); await reload(); } finally { vLearn(M); } };
  $("#lmaint").onclick = async e => { e.target.disabled = true; e.target.textContent = "Started…"; await api("/api/maintenance", { method: "POST" }); };
}

// ═════════════════════════════ LIVE CAPTURE (System page) ═════════════════════════════
const fmtBytes = b => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB";
const annVol = (v, n) => fin(v) && v > 0 ? pct(Math.sqrt(v * n), 0, false) : "—";
function livePanel(L) {
  const T = L.totals, C = L.cloud || {};
  return `<div class="panel" style="margin-top:14px"><header><h2>Live capture</h2><span class="muted small">every tracked stock, at least once a minute while its market is open · each sample validated before it is stored</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Company</th><th class="t">Market</th><th>Samples (24 h)</th><th class="t">Last sample</th><th>Trading days captured</th><th>Accepted · rejected</th><th>Last day: realised vol (5-min · range)</th><th>Model forecast</th></tr></thead><tbody>
    ${L.stocks.map(x => { const r = x.lastRv; return `<tr><td class="t"><a href="#/c/${encodeURIComponent(x.id)}">${esc(x.nm)}</a></td><td class="t small"><span class="dot ${x.open ? "on" : ""}"></span>${x.open ? "open" : "closed"}</td><td>${x.ticks24h.toLocaleString()}</td><td class="t small mono">${x.lastTick ? fmtTime(x.lastTick * 1000) : "—"}</td><td>${x.days}</td><td class="small">${(x.dq?.a || 0).toLocaleString()} · <span class="${x.dq?.r ? "neg" : ""}">${(x.dq?.r || 0).toLocaleString()}</span></td><td class="small">${r ? `${esc(fmtDate(r.date))}: ${annVol(r.rv_5m, 252)} · ${annVol(fin(r.rs_range) ? r.rs_range + (r.overnight || 0) : null, 252)}` : "—"}</td><td class="small">${r && fin(r.model_vol) ? pct(r.model_vol, 0, false) : "—"}</td></tr>`; }).join("")}
  </tbody></table></div>
  <div class="body small"><div class="grid g2" style="gap:14px">
    <div><h3 style="margin:0 0 6px">Stored on this Mac</h3><ul class="list">
      <li><span class="muted small">Database size</span><span class="mono">${fmtBytes(L.dbBytes)}</span></li>
      <li><span class="muted small">Live samples</span><span class="mono">${T.ticks.toLocaleString()}${T.firstTick ? ` since ${esc(fmtDate(new Date(T.firstTick * 1000).toISOString().slice(0, 10)))}` : ""}</span></li>
      <li><span class="muted small">Daily bars · trading days with realised vol</span><span class="mono">${T.daily.toLocaleString()} · ${T.rvDays.toLocaleString()}</span></li>
      <li><span class="muted small">Forecasts logged · analyses</span><span class="mono">${T.preds.toLocaleString()} · ${T.analyses.toLocaleString()}</span></li>
      <li><span class="muted small">Archive (intraday older than ${L.archive?.hotMonths ?? 12} months)</span><span class="mono">${L.archive?.files ? `${L.archive.files} files · ${(L.archive.rows || 0).toLocaleString()} samples · ${fmtBytes(L.archive.bytes || 0)} · ${L.archive.uploaded || 0} in cloud` : "nothing old enough yet"}</span></li></ul>
      <form id="retf" style="display:flex;gap:8px;align-items:end;margin-top:8px"><div class="field"><label for="rety">Keep intraday data for (years)</label><input id="rety" type="number" min="1" max="20" value="${L.retentionYears}"></div><button class="btn" type="submit">Save</button></form><div class="small faint" id="retmsg">Daily prices, forecasts, simulations and orders are never deleted.</div><label class="small" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="awk" ${L.awake?.on ? "checked" : ""}> Keep the Mac awake while a tracked market is open${L.awake?.active ? ' <span class="badge ok">active now</span>' : ""}</label><div class="small faint">Prevents idle sleep only during sessions. Closing the lid still sleeps the Mac, and capture pauses until it wakes.</div></div>
    <div><h3 style="margin:0 0 6px">Cloud backup (Supabase, optional) ${C.configured && C.enabled ? '<span class="badge ok">on</span>' : '<span class="badge">off</span>'}</h3>
      <p class="small muted" style="margin-top:0">Copies everything above to your own Supabase project every 6 hours. Local data stays the primary copy. Run <code>data/supabase_schema.sql</code> once in the project's SQL editor, then connect with the project URL and its service-role key (stored only on this Mac).</p>
      ${C.configured ? `<p class="small"><b>Cloud collector</b> (records prices while this Mac is asleep or off): ${L.collector && !L.collector.error ? `${L.collector.symbols ?? "?"} stocks · last run ${L.collector.lastRun ? fmtTime(L.collector.lastRun) : "not yet (runs only while a market is open)"}${L.collector.lastRun ? ` · stored ${L.collector.stored}, failed ${L.collector.failed}` : ""}${L.collector.lastPull ? ` · last catch-up ${fmtTime(L.collector.lastPull.at)}: ${L.collector.lastPull.added} prices added` : ""}` : `<span class="faint">not installed: run <code>data/supabase_collector.sql</code> in the Supabase SQL Editor</span>`}</p>` : ""}
      ${C.configured ? `<p class="small">Project <span class="mono">${esc(C.url)}</span> · last backup ${C.lastSync ? fmtTime(C.lastSync) : "never"}${C.lastError ? ` · <span class="neg">${esc(C.lastError)}</span>` : ""} <button class="btn sm" id="cloudsync" type="button">Back up now</button></p>` : ""}
      <form id="cloudf" class="form"><div class="field"><label for="cloudu">Project URL</label><input id="cloudu" placeholder="https://abcdefgh.supabase.co" value="${esc(C.url || "")}" autocomplete="off"></div><div class="field"><label for="cloudk">Service-role key</label><input id="cloudk" type="password" autocomplete="off" placeholder="${C.configured ? "saved, paste to replace" : ""}"></div><div class="field"><button class="btn" type="submit">${C.configured ? "Update" : "Connect"}</button></div></form><div class="small" id="cloudmsg" role="status"></div></div>
  </div></div></div>`;
}

function backupPanel(B) {
  const L = B.last, onMac = !/^\/Volumes\//.test(B.dir) && !/CloudStorage|Google Drive|Dropbox|OneDrive/i.test(B.dir);
  return `<div class="panel" style="margin-top:14px"><header><h2>Backups</h2><span class="r">${L ? '<span class="badge ok">nightly</span>' : '<span class="badge">none yet</span>'}</span></header><div class="body">
    <p class="small" style="margin-top:0">Every night KUBER saves an integrity-checked, compressed copy of its whole database. It keeps the last 14 nights plus one copy per month for 2 years.${onMac ? ' <span class="warn">The folder is on this Mac\'s own disk, so it protects against a damaged database or a bad change, not against losing the Mac. Point it at an external drive or a synced cloud folder for that.</span>' : ""}</p>
    <ul class="list"><li><span class="muted small">Folder</span><span class="small mono">${esc(B.dir)}</span></li>
      <li><span class="muted small">Last backup</span><span class="small">${L ? `${fmtTime(L.at)} · ${fmtBytes(L.bytes)} · ${L.rows.daily.toLocaleString()} daily bars, ${L.rows.ticks.toLocaleString()} samples, ${L.rows.preds.toLocaleString()} forecasts, ${L.rows.orders} orders` : "never"}</span></li>
      <li><span class="muted small">Copies kept</span><span class="small">${B.count} · ${fmtBytes(B.bytes)}</span></li></ul>
    ${B.lastError ? `<p class="note warn small">Last attempt failed: ${esc(B.lastError.message)}</p>` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:10px"><button class="btn" id="bknow" type="button">Back up now</button>
      <form id="bkdirf" style="display:flex;gap:8px;align-items:end;flex:1;min-width:260px"><div class="field" style="flex:1"><label for="bkdir">Backup folder</label><input id="bkdir" value="${esc(B.dir)}" autocomplete="off"></div><button class="btn" type="submit">Change</button></form></div>
    <div class="small" id="bkmsg" role="status"></div>
    <p class="small faint" style="margin-bottom:0">To restore: run stop.command, unzip a copy (double-click it), rename it kuber.db, put it in KUBER/data, then open KUBER.</p></div></div>`;
}

// ═════════════════════════════ SYSTEM ═════════════════════════════
async function vSystem(M) {
  const [st, ev, LV, BK] = await Promise.all([api("/api/llm/status").catch(() => ({ running: false, models: [] })), api("/api/events").catch(() => []), api("/api/live").catch(() => null), api("/api/backup").catch(() => null)]); STATE.llm = st; const COL = await api("/api/cloud/collector").catch(() => null); if (LV) LV.collector = COL;
  const vrows = Object.values(STATE.verify);
  const cmd = s => `<div style="display:flex;gap:6px;align-items:center;margin:4px 0"><code class="eq" style="flex:1;padding:6px 8px">${esc(s)}</code><button class="btn sm" data-copy="${esc(s)}">Copy</button></div>`;
  M.innerHTML = `<div class="pagehead"><div><h1>System</h1><div class="sub">Data sources, verification, the local AI model and the engine log.</div></div></div>
  <div class="grid g2">
    <div class="panel"><header><h2>Data</h2></header><div class="body"><ul class="list">
      <li><span class="muted small">Prices</span><span class="small">stockanalysis.com exchange data (Yahoo Finance as backup): 5 years of daily closes, re-synced in full every 6 hours, plus live quotes every 15 s while markets are open</span></li>
      <li><span class="muted small">Price basis</span><span class="small">Returns use closes adjusted for dividends and splits; demerger days are excluded; forecasts and holdings use exchange prices</span></li>
      <li><span class="muted small">Fundamentals</span><span class="small">screener.in (India), stockanalysis.com (US/Korea/Taiwan ADR) · last refresh ${STATE.refreshLast ? fmtTime(STATE.refreshLast) : "20 Oct 2026 snapshot"}</span></li>
      <li><span class="muted small">Company facts</span><span class="small">Filings-based profiles; Wikipedia only for names, places and dates</span></li>
      <li><span class="muted small">Last maintenance</span><span class="small">${STATE.maintLast ? fmtTime(STATE.maintLast) : "—"}</span></li>
      <li><span class="muted small">Database</span><span class="small mono">KUBER/data/kuber.db</span></li></ul>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn" id="srefresh">Refresh fundamentals now</button><button class="btn" id="smaint">Sync prices, verify &amp; score</button></div><div class="small faint" id="smsg" style="margin-top:6px"></div></div></div>
    <div class="panel"><header><h2>Local AI model (free)</h2><span class="r">${st.running ? '<span class="badge ok">running</span>' : '<span class="badge no">not running</span>'}</span></header><div class="body">
      <p class="small" style="margin-top:0">KUBER uses a free model through Ollama to read headlines and answer questions from its own data. It never produces numbers or forecasts.</p>
      ${st.running ? `<div class="field"><label for="llmm">Model</label><select id="llmm">${st.models.map(m => `<option ${m === st.model ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>${st.models.length ? "" : `<p class="note warn small">No model installed yet. Run:</p>${cmd("ollama pull qwen2.5:7b")}`}<div style="margin-top:10px"><button class="btn" id="snews">Label new headlines now</button></div>`
      : `<p class="small">Ollama is bundled in <code>tools/ollama</code> and starts with KUBER. If it isn't running, start it and fetch the model in Terminal:</p>${cmd("~/KUBER/tools/ollama/ollama serve &")}${cmd("~/KUBER/tools/ollama/ollama pull qwen2.5:7b")}<p class="small muted">Then reload this page.</p>`}</div></div>
  </div>
  ${(() => { const acts = Object.values(CO).filter(c => c.corpActions?.length).flatMap(c => c.corpActions.map(a => ({ c, a }))); return acts.length ? `<div class="panel" style="margin-top:14px"><header><h2>Corporate actions detected</h2><span class="muted small">days where the provider's price adjustment jumped by more than 15%</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Company</th><th class="t">Date</th><th>Exchange price move</th><th>Provider's adjusted move</th><th class="t">How KUBER treats it</th></tr></thead><tbody>${acts.map(({ c, a }) => `<tr><td class="t">${esc(c.nm)}</td><td class="t mono small">${esc(a.date)}</td><td>${pct(a.rawMove, 1)}</td><td>${pct(a.providerAdjMove, 1)}</td><td class="t small">that day's return is excluded (set to 0). Forecasts across it are scored on the value of one original share, assuming the spun-off shares then moved with the parent</td></tr>`).join("")}</tbody></table></div></div>` : ""; })()}
  <div class="panel" style="margin-top:14px"><header><h2>Security</h2></header><div class="body">
    <p class="small" style="margin-top:0">KUBER is locked with a PIN. The engine only answers this Mac's own address, refuses requests from other websites, and stores the PIN as a salted hash. It locks itself after 4 hours without use, or when you press Lock. The database file on disk is not encrypted; FileVault protects it when your Mac is locked.</p>
    <form id="pinf" class="form"><div class="field"><label for="pin0">Current PIN</label><input id="pin0" type="password" inputmode="numeric" maxlength="8" autocomplete="current-password" required></div><div class="field"><label for="pin1">New PIN (4–8 digits)</label><input id="pin1" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" required></div><div class="field"><label for="pin2">Repeat new PIN</label><input id="pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="new-password" required></div><div class="field"><button class="btn" type="submit">Change PIN</button></div></form><div class="small" id="pinmsg" role="status"></div></div></div>
  ${BK ? backupPanel(BK) : ""}
  ${LV ? livePanel(LV) : ""}
  <div class="panel" style="margin-top:14px"><header><h2>Price verification</h2><span class="muted small">exchange feed vs filings-site close on the same date · tolerance 1%</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Company</th><th class="t">Date</th><th>Filings site</th><th>Exchange feed</th><th>Difference</th><th class="t">Result</th></tr></thead><tbody>${vrows.map(v => { const c = CO[v.cid] || { cur: "₹" }; return `<tr><td class="t">${esc(CO[v.cid]?.nm || v.cid)}</td><td class="t mono small">${esc(v.src_date)}</td><td>${px(v.src_close, c)}</td><td>${px(v.feed_close, c)}</td><td>${pct(v.diff, 2)}</td><td class="t">${v.ok ? '<span class="badge ok">verified</span>' : '<span class="badge no">mismatch</span>'}</td></tr>`; }).join("") || `<tr><td class="t muted" colspan="6">Runs after the first price sync.</td></tr>`}</tbody></table></div></div>
  <div class="panel" style="margin-top:14px"><header><h2>Engine log</h2></header><div class="body flush tbl"><table><tbody>${ev.slice(0, 120).map(e => `<tr><td class="t small mono" style="width:150px">${esc(fmtTime(e.ts))}</td><td class="t small" style="width:90px">${esc(e.kind)}</td><td class="t small">${esc(e.msg)}</td></tr>`).join("")}</tbody></table></div></div>`;
  M.querySelectorAll("[data-copy]").forEach(b => b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = "Copied"; }).catch(() => {}));
  $("#srefresh").onclick = async () => { await api("/api/refresh", { method: "POST" }); $("#smsg").textContent = "Refreshing fundamentals in the background. This takes about a minute; the page updates when done."; };
  $("#smaint").onclick = async () => { await api("/api/maintenance", { method: "POST" }); $("#smsg").textContent = "Syncing prices, verifying and scoring in the background."; };
  $("#bknow")?.addEventListener("click", async e => { e.target.disabled = true; e.target.textContent = "Saving…"; const r = await api("/api/backup", { method: "POST" }).catch(err => ({ error: err.message })); e.target.textContent = r.ok ? "Saved" : "Failed"; if (r.ok) vSystem(M); else $("#bkmsg").textContent = r.error; });
  $("#bkdirf")?.addEventListener("submit", async e => { e.preventDefault(); const r = await api("/api/backup/dir", { method: "POST", body: { dir: $("#bkdir").value.trim() } }).catch(err => ({ error: err.message })); $("#bkmsg").className = r.error ? "small neg" : "small pos"; $("#bkmsg").textContent = r.error || `Backups will be saved to ${r.dir}.`; });
  $("#awk")?.addEventListener("change", e => api("/api/awake", { method: "POST", body: { on: e.target.checked } }));
  $("#retf")?.addEventListener("submit", async e => { e.preventDefault(); const r = await api("/api/retention", { method: "POST", body: { years: $("#rety").value } }).catch(err => ({ error: err.message })); $("#retmsg").textContent = r.error || `Keeping intraday data for ${r.years} years.`; });
  $("#cloudf")?.addEventListener("submit", async e => { e.preventDefault(); const m = $("#cloudmsg"); m.className = "small muted"; m.textContent = "Testing the connection…"; const r = await api("/api/cloud", { method: "POST", body: { url: $("#cloudu").value.trim(), key: $("#cloudk").value.trim() } }).catch(err => ({ error: err.message })); m.className = r.error ? "small neg" : "small pos"; m.textContent = r.error || "Connected. The first backup starts now and repeats every 6 hours."; if (!r.error) api("/api/cloud/sync", { method: "POST" }).then(x => { m.textContent = x.ok ? `Backed up: ${Object.entries(x.pushed).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(", ")}.` : "Backup failed: " + (x.error || x.skipped); }); });
  $("#cloudsync")?.addEventListener("click", async e => { e.target.disabled = true; e.target.textContent = "Backing up…"; const x = await api("/api/cloud/sync", { method: "POST" }).catch(err => ({ error: err.message })); e.target.textContent = x.ok ? "Done" : "Failed: " + (x.error || x.skipped); });
  $("#pinf").onsubmit = async e => { e.preventDefault(); const m = $("#pinmsg"), a = $("#pin0").value, b = $("#pin1").value; if (b !== $("#pin2").value) { m.className = "small neg"; m.textContent = "The new PINs don't match."; return; } try { await api("/api/pin", { method: "POST", body: { current: a, next: b } }); m.className = "small pos"; m.textContent = "PIN changed."; e.target.reset(); } catch (err) { m.className = "small neg"; m.textContent = err.message; } };
  $("#llmm")?.addEventListener("change", e => api("/api/llm/model", { method: "POST", body: { model: e.target.value } }));
  $("#snews")?.addEventListener("click", async e => { e.target.disabled = true; e.target.textContent = "Labelling…"; const r = await api("/api/llm/score-news", { method: "POST" }).catch(err => ({ error: err.message })); e.target.textContent = r.error ? "Failed: " + r.error : `Labelled ${r.scored} headlines`; });
}

// ═════════════════════════════ FINDER (search everything, data on demand) ═════════════════════════════
let FIND = { q: "", hits: [], busy: false, t: null };
const MKNAME = { IN: "NSE", US: "NYSE / Nasdaq", KR: "KRX" };
const isHeld = id => portfolio().open.some(P => P.c?.id === id);
async function setWish(id, on, name) {
  try { await api("/api/wishlist", { method: "POST", body: { id, on, name } }); await reload(); return null; } catch (e) { return e.message; }
}
function vFinder(M) {
  const tracked = allTracked().sort((a, b) => a.nm.localeCompare(b.nm)), hidden = (STATE.hidden || []).filter(id => !CO[id] || !CO[id].core || true);
  M.innerHTML = `<div class="pagehead"><div><h1>Finder</h1><div class="sub">Search any company listed on NSE, NYSE/Nasdaq or KRX. KUBER only downloads a company's data when you open or add it, then checks its price against a second source and test-runs the model on its history. Companies you only looked at are removed after 14 days unused.</div></div></div>
  <div class="panel"><div class="body"><div class="field" style="max-width:560px"><label for="fq">Company name or ticker</label><input id="fq" value="${esc(FIND.q)}" placeholder="e.g. Reliance, HDFC Bank, Apple, SK hynix" autocomplete="off"></div></div><div class="body flush tbl" id="fres"></div></div>
  <div class="panel" style="margin-top:14px"><header><h2>Your wishlist</h2><span class="muted small">${tracked.length} companies tracked live · holdings can't be removed while you hold them</span></header><div class="body flush tbl"><table><thead><tr><th class="t">Company</th><th class="t">Market</th><th>Price</th><th>Day</th><th class="t">Status</th><th></th></tr></thead><tbody>
    ${tracked.map(c => { const h = isHeld(c.id); return `<tr><td class="t"><a href="#/c/${encodeURIComponent(c.id)}">${esc(c.nm)}</a> <span class="faint small mono">${esc(c.tk)}</span></td><td class="t small">${MKNAME[c.mk] || c.ex}</td><td data-live-px="${esc(c.id)}">${px(c.px, c)}</td><td class="${cls(c.chg)} mono" data-live-chg="${esc(c.id)}">${fin(c.chg) ? pct(c.chg / 100, 2) : ""}</td><td class="t">${h ? '<span class="badge ok">held</span>' : '<span class="badge">wishlist</span>'}</td><td>${h ? "" : `<button class="btn sm" data-wrm="${esc(c.id)}">Remove</button>`}</td></tr>`; }).join("")}
  </tbody></table></div>${hidden.length ? `<div class="body small">Removed: ${hidden.map(id => `<button class="btn sm" data-wadd="${esc(id)}" style="margin:2px">+ ${esc(id)}</button>`).join("")}</div>` : ""}<div class="small neg" id="wmsg" style="padding:0 12px 10px"></div></div>`;
  const draw = () => {
    const el = $("#fres"); if (!el) return;
    if (!FIND.q.trim()) { el.innerHTML = `<p class="muted small" style="padding:10px 12px;margin:0">Start typing to search every listed company.</p>`; return; }
    if (FIND.busy && !FIND.hits.length) { el.innerHTML = `<p class="muted small" style="padding:10px 12px;margin:0">Searching…</p>`; return; }
    el.innerHTML = FIND.hits.length ? `<table><thead><tr><th class="t">Company</th><th class="t">Ticker</th><th class="t">Market</th><th class="t">On this Mac</th><th></th></tr></thead><tbody>${FIND.hits.map(r => { const tr = allTracked().some(c => c.id === r.id), held = isHeld(r.id);
      return `<tr><td class="t"><a href="#/c/${encodeURIComponent(r.id)}?n=${encodeURIComponent(r.name)}">${esc(r.name)}</a></td><td class="t mono small">${esc(r.tk)}</td><td class="t small">${MKNAME[r.mk] || r.mk}</td><td class="t small">${held ? '<span class="badge ok">held</span>' : tr ? '<span class="badge ok">wishlist</span>' : r.cached ? `<span class="badge">data kept until 14 days unused</span>` : '<span class="faint">not downloaded</span>'}</td>
        <td style="white-space:nowrap"><a class="btn sm" href="#/c/${encodeURIComponent(r.id)}?n=${encodeURIComponent(r.name)}">Open</a> ${held ? "" : tr ? `<button class="btn sm" data-wrm="${esc(r.id)}">Remove from wishlist</button>` : `<button class="btn sm primary" data-wadd="${esc(r.id)}" data-n="${esc(r.name)}">+ Wishlist</button>`}</td></tr>`; }).join("")}</tbody></table>` : `<p class="muted small" style="padding:10px 12px;margin:0">No listed stock matches “${esc(FIND.q)}”.</p>`;
    bindWish(el);
  };
  const bindWish = root => {
    $$("[data-wadd]", root).forEach(b => b.onclick = async () => { b.disabled = true; b.textContent = CO[b.dataset.wadd] ? "Adding…" : "Downloading & testing…"; const err = await setWish(b.dataset.wadd, true, b.dataset.n); if (err) { b.textContent = "Failed"; $("#wmsg").textContent = err; } else { await refind(); vFinder(M); } });
    $$("[data-wrm]", root).forEach(b => b.onclick = async () => { b.disabled = true; const err = await setWish(b.dataset.wrm, false); if (err) { b.textContent = "Can't remove"; $("#wmsg").textContent = err; } else { await refind(); vFinder(M); } });
  };
  const refind = async () => { if (FIND.q.trim()) try { FIND.hits = await api("/api/find?q=" + encodeURIComponent(FIND.q)); } catch (e) {} };
  bindWish(M);
  $("#fq").addEventListener("input", e => { FIND.q = e.target.value; clearTimeout(FIND.t); FIND.busy = true; draw(); FIND.t = setTimeout(async () => { const q = FIND.q; try { const h = await api("/api/find?q=" + encodeURIComponent(q)); if (q === FIND.q) FIND.hits = h; } catch (err) { FIND.hits = []; } FIND.busy = false; draw(); }, 250); });
  draw();
}

// company page for a company KUBER doesn't have yet: download, check, test, then open
async function openOnDemand(id, M) {
  const name = route.q.n || id;
  const show = st => { M.innerHTML = `<div class="pagehead"><div><h1>${esc(st?.name || name)}</h1><div class="sub">${esc(id)} · not on this Mac yet. KUBER is downloading its data, checking it and testing the model on it.</div></div></div>
    <div class="panel"><div class="body"><ol class="small" style="margin:0;padding-left:18px;line-height:1.9">${(st?.steps || []).map(s => `<li>${s.ok ? '<span class="pos">✓</span>' : '<span class="neg">✗</span>'} <b>${esc(s.t)}</b>: ${esc(s.detail)}</li>`).join("")}${st?.status === "fetching" || !st ? '<li class="muted">Working… (about 20–40 seconds)</li>' : ""}</ol>
    ${st?.status === "failed" ? `<p class="note warn small">Couldn't finish. <button class="btn sm" id="odretry">Try again</button></p>` : ""}</div></div>`; const r = $("#odretry"); if (r) r.onclick = () => openOnDemand(id, M); };
  try { const d = await api("/api/company/" + encodeURIComponent(id)); addCompany(d.company); render(); return; } catch (e) { /* not on this Mac yet */ }
  show(null);
  let st = await api("/api/catalog/" + encodeURIComponent(id), { method: "POST", body: { name } }).catch(e => ({ status: "failed", steps: [{ t: "Stopped", ok: false, detail: e.message }] }));
  while (st.status === "fetching" && route.name === "company" && route.arg === id) { show(st); await new Promise(r => setTimeout(r, 1500)); st = await api("/api/catalog/" + encodeURIComponent(id)).catch(() => st); }
  if (route.name !== "company" || route.arg !== id) return;
  if (st.status !== "ready") { show(st); return; }
  show(st); await new Promise(r => setTimeout(r, 900));
  const d = await api("/api/company/" + encodeURIComponent(id)); addCompany(d.company); if (route.arg === id) render();
}
function addCompany(c) { c.core = !c.universe && !c.onDemand; c.V = V[c.id] || null; CO[c.id] = c; delete RES[c.id]; }

// top search box: tracked companies first, then every listed company
function bindSearch() {
  const inp = $("#qs"), box = $("#qsr"); let hits = [], on = 0, t = null;
  const paint = () => { box.innerHTML = hits.map((h, i) => `<button data-i="${i}" class="${i === on ? "on" : ""}"><span>${esc(h.n)}</span><span class="faint small mono">${esc(h.t)} · ${h.tag}</span></button>`).join("") || `<div class="empty" style="padding:8px 10px">No matches</div>`; box.hidden = false; };
  const show = () => {
    const q = inp.value.trim(), lq = q.toLowerCase(); if (!q) { box.hidden = true; return; }
    const local = allTracked().filter(c => c.nm.toLowerCase().includes(lq) || c.tk.toLowerCase().includes(lq)).map(c => ({ id: c.id, n: c.nm, t: c.tk, tag: isHeld(c.id) ? "held" : "wishlist" }));
    hits = local.slice(0, 10); on = 0; paint();
    clearTimeout(t); t = setTimeout(async () => { try { const r = await api("/api/find?q=" + encodeURIComponent(q)); if (inp.value.trim() !== q) return; const more = r.filter(x => !local.some(l => l.id === x.id)).map(x => ({ id: x.id, n: x.name, t: x.tk, tag: MKNAME[x.mk] || x.mk })); hits = [...local, ...more].slice(0, 12); paint(); } catch (e) {} }, 250);
  };
  const open = h => { go("#/c/" + encodeURIComponent(h.id) + "?n=" + encodeURIComponent(h.n)); inp.value = ""; box.hidden = true; };
  inp.addEventListener("input", show);
  inp.addEventListener("keydown", e => { if (e.key === "ArrowDown") { on = Math.min(hits.length - 1, on + 1); paint(); e.preventDefault(); } else if (e.key === "ArrowUp") { on = Math.max(0, on - 1); paint(); e.preventDefault(); } else if (e.key === "Enter" && hits[on]) open(hits[on]); else if (e.key === "Escape") box.hidden = true; });
  box.addEventListener("click", e => { const b = e.target.closest("button[data-i]"); if (b) open(hits[+b.dataset.i]); });
  document.addEventListener("click", e => { if (!e.target.closest(".search")) box.hidden = true; });
}

// ═════════════════════════════ LIVE (every tracked stock at a glance) ═════════════════════════════
// Rest the pointer on a card for 4 seconds and it expands to four card spaces with charts and the maths behind
// it. It stays open until another card is expanded, Esc, its × button, or the pointer leaves the grid for 2 seconds.
const LIVEUI = { big: null, data: {}, arm: null, leave: null };
const tzOf = mk => mk === "IN" ? "Asia/Kolkata" : mk === "KR" ? "Asia/Seoul" : "America/New_York";
const hhmm = (ts, mk) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tzOf(mk) });
async function vLive(M) {
  M.innerHTML = `<div class="pagehead"><div><h1>Live</h1><div class="sub">Every stock you hold or watch, with today's price path and the latest analysis. Rest the pointer on a card for 4 seconds to expand it with the full picture and the maths. Prices update as they arrive; charts every minute.</div></div></div><div id="lgrid" class="lgrid"><p class="muted">Loading…</p></div>`;
  const grid = $("#lgrid");
  const draw = async () => {
    let G; try { G = await api("/api/livegrid"); } catch (e) { return; }
    if (route.name !== "live" || !$("#lgrid")) return;
    const held = new Set(portfolio().open.map(P => P.c?.id)); LIVEUI.data = Object.fromEntries(G.map(g => [g.id, g]));
    const list = G.sort((a, b) => (held.has(b.id) - held.has(a.id)) || (b.open - a.open) || a.nm.localeCompare(b.nm));
    grid.innerHTML = list.map(g => liveCard(g, held.has(g.id))).join("") || `<p class="muted">Nothing tracked yet. Add companies from the Finder.</p>`;
    if (LIVEUI.big && LIVEUI.data[LIVEUI.big]) expand(LIVEUI.big, false);
  };
  const expand = (id, scroll = true) => {
    $$(".lcard.big", grid).forEach(x => { x.classList.remove("big"); x.querySelector(".lc-more").innerHTML = ""; });
    const el = grid.querySelector(`.lcard[data-id="${CSS.escape(id)}"]`); if (!el) return;
    LIVEUI.big = id; el.classList.add("big"); el.querySelector(".lc-more").innerHTML = liveMore(LIVEUI.data[id]);
    el.querySelector(".lc-x").onclick = e => { e.preventDefault(); e.stopPropagation(); collapse(); };
    if (scroll) { const r = el.getBoundingClientRect(); if (r.bottom > innerHeight || r.top < 80) el.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
  };
  const collapse = () => { LIVEUI.big = null; $$(".lcard.big", grid).forEach(x => { x.classList.remove("big"); x.querySelector(".lc-more").innerHTML = ""; }); };
  grid.addEventListener("mouseover", e => {
    const el = e.target.closest(".lcard"); clearTimeout(LIVEUI.leave);
    if (!el || el.classList.contains("arming") || el.classList.contains("big")) return;
    $$(".lcard.arming", grid).forEach(x => x.classList.remove("arming")); clearTimeout(LIVEUI.arm);
    el.classList.add("arming"); LIVEUI.arm = setTimeout(() => { el.classList.remove("arming"); expand(el.dataset.id); }, 4000);
  });
  grid.addEventListener("mouseout", e => { const el = e.target.closest(".lcard"); if (el && !el.contains(e.relatedTarget)) { el.classList.remove("arming"); clearTimeout(LIVEUI.arm); } });
  grid.addEventListener("mouseleave", () => { clearTimeout(LIVEUI.arm); LIVEUI.leave = setTimeout(collapse, 2000); });
  const esc = e => { if (e.key === "Escape") collapse(); }; document.addEventListener("keydown", esc);
  await draw(); const iv = setInterval(draw, 60000);
  cleanup.push(() => { clearInterval(iv); clearTimeout(LIVEUI.arm); clearTimeout(LIVEUI.leave); document.removeEventListener("keydown", esc); });
}
function liveCard(g, held) {
  const c = CO[g.id] || g, a = g.analysis, l20 = g.ladder?.[20], px0 = c.px ?? g.px, chg = c.chg ?? g.chg;
  return `<a class="lcard" data-id="${esc(g.id)}" href="#/c/${encodeURIComponent(g.id)}"><div class="lc-h"><span><b>${esc(g.tk)}</b> <span class="faint small">${esc(g.nm)}</span></span><span class="small">${held ? '<span class="badge ok">held</span> ' : ""}<span class="dot ${g.open ? "on" : ""}"></span>${g.open ? "live" : "closed"}<button class="lc-x" type="button" aria-label="Close">×</button></span></div>
    <div class="lc-p"><span class="mono" style="font-size:20px" data-live-px="${esc(g.id)}">${px(px0, c)}</span> <span class="${cls(chg)} mono" data-live-chg="${esc(g.id)}">${fin(chg) ? pct(chg / 100, 2) : ""}</span></div>
    ${intraChart(g, c, 268, 84, false)}
    <div class="lc-a small">${a ? `<div><span class="muted">52-wk median</span> ${px(a.median, c)} <span class="muted">· P(gain)</span> ${pct(a.pUp, 0, false)}</div><div><span class="muted">90% range</span> ${px(a.p05, c)} – ${px(a.p95, c)}</div>` : '<div class="muted">No analysis yet</div>'}
      ${l20 ? `<div><span class="muted">+20 days</span> ${px(l20.p50, c)} <span class="muted">(${px(l20.p05, c)} – ${px(l20.p95, c)})</span></div>` : ""}
      <div class="faint">${a ? "analysed " + fmtTime(a.ts) : ""}${g.nTicks ? ` · ${g.nTicks} samples this session` : ""}</div></div>
    <div class="lc-more"></div><span class="lc-arm" aria-hidden="true"></span></a>`;
}
// intraday chart: price path, previous close (dashed), session high/low, time labels
function intraChart(g, c, W, H, big) {
  const t = g.ticks || [];
  if (t.length < 3) return `<div class="lc-s faint small" style="height:${H}px">No prices recorded yet this session</div>`;
  const pad = { l: 4, r: big ? 70 : 52, t: 8, b: 16 }, ys = t.map(x => x.price), prev = g.prev, lo = Math.min(...ys, prev ?? Infinity), hi = Math.max(...ys, prev ?? -Infinity), x0 = t[0].ts, x1 = t[t.length - 1].ts, sp = (hi - lo) || hi * 0.002;
  const X = x => pad.l + (x - x0) / (x1 - x0 || 1) * (W - pad.l - pad.r), Y = y => pad.t + (1 - (y - lo + sp * 0.06) / (sp * 1.12)) * (H - pad.t - pad.b);
  const last = ys[ys.length - 1], up = last >= (prev ?? ys[0]), col = up ? "var(--pos)" : "var(--neg)", path = t.map((p, i) => `${i ? "L" : "M"}${X(p.ts).toFixed(1)},${Y(p.price).toFixed(1)}`).join("");
  const area = path + `L${X(x1).toFixed(1)},${H - pad.b}L${X(x0).toFixed(1)},${H - pad.b}Z`, lab = (v, txt) => `<text x="${W - pad.r + 4}" y="${Y(v) + 3}" font-size="${big ? 10.5 : 9.5}" fill="var(--faint)">${esc(txt)}</text>`;
  const sHi = Math.max(...ys), sLo = Math.min(...ys);
  return `<svg class="lc-s" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(g.nm)} price this session">
    <path d="${area}" fill="${col}" fill-opacity="0.08"/>
    ${prev ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(prev)}" y2="${Y(prev)}" stroke="var(--line2)" stroke-dasharray="3 3"/>${lab(prev, (big ? "prev close " : "") + px(prev, c))}` : ""}
    ${big ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(sHi)}" y2="${Y(sHi)}" stroke="var(--line)"/>${lab(sHi, "high " + px(sHi, c))}<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(sLo)}" y2="${Y(sLo)}" stroke="var(--line)"/>${lab(sLo, "low " + px(sLo, c))}` : ""}
    <path d="${path}" fill="none" stroke="${col}" stroke-width="${big ? 1.8 : 1.5}" vector-effect="non-scaling-stroke"/>
    <circle cx="${X(x1)}" cy="${Y(last)}" r="${big ? 3 : 2.5}" fill="${col}"/>
    <text x="${pad.l}" y="${H - 3}" font-size="${big ? 10.5 : 9.5}" fill="var(--faint)">${hhmm(x0, g.mk)}</text><text x="${W - pad.r}" y="${H - 3}" text-anchor="end" font-size="${big ? 10.5 : 9.5}" fill="var(--faint)">${hhmm(x1, g.mk)}</text></svg>`;
}
// last 60 trading days, then the 90-day outlook: median and 50% / 90% bands
function outlookChart(g, c, W, H) {
  const d = (g.daily || []).filter(r => r.close > 0), L = g.ladderRows || [], run = g.ladderRun;
  if (d.length < 5) return "";
  const nF = L.length ? L[L.length - 1].h : 0, n = d.length, tot = n - 1 + nF, pad = { l: 4, r: 70, t: 10, b: 16 };
  const vals = [...d.map(r => r.close), ...L.flatMap(r => [r.p05, r.p95])], lo = Math.min(...vals), hi = Math.max(...vals);
  const X = i => pad.l + i / (tot || 1) * (W - pad.l - pad.r), Y = y => pad.t + (1 - (Math.log(y) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (H - pad.t - pad.b);
  const hist = d.map((r, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(r.close).toFixed(1)}`).join(""), i0 = n - 1, p0 = run?.p0 ?? d[n - 1].close;
  const band = (a, b) => L.length ? `M${X(i0)},${Y(p0)}` + L.map(r => `L${X(i0 + r.h).toFixed(1)},${Y(r[a]).toFixed(1)}`).join("") + L.slice().reverse().map(r => `L${X(i0 + r.h).toFixed(1)},${Y(r[b]).toFixed(1)}`).join("") + "Z" : "";
  const last = L[L.length - 1];
  return `<svg class="lc-o" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(g.nm)}: last ${n} trading days and the 90-day outlook">
    ${L.length ? `<path d="${band("p95", "p05")}" fill="var(--accent)" fill-opacity="0.10"/><path d="${band("p75", "p25")}" fill="var(--accent)" fill-opacity="0.18"/><path d="M${X(i0)},${Y(p0)}${L.map(r => `L${X(i0 + r.h).toFixed(1)},${Y(r.p50).toFixed(1)}`).join("")}" fill="none" stroke="var(--accent)" stroke-dasharray="4 3" stroke-width="1.4" vector-effect="non-scaling-stroke"/>` : ""}
    <line x1="${X(i0)}" x2="${X(i0)}" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--line2)"/>
    <path d="${hist}" fill="none" stroke="var(--text)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    ${last ? `<text x="${W - pad.r + 4}" y="${Y(last.p95) + 3}" font-size="10.5" fill="var(--faint)">${esc(px(last.p95, c))}</text><text x="${W - pad.r + 4}" y="${Y(last.p50) + 3}" font-size="10.5" fill="var(--accent)">${esc(px(last.p50, c))}</text><text x="${W - pad.r + 4}" y="${Y(last.p05) + 3}" font-size="10.5" fill="var(--faint)">${esc(px(last.p05, c))}</text>` : ""}
    <text x="${pad.l}" y="${H - 3}" font-size="10.5" fill="var(--faint)">${esc(fmtDate(d[0].date))}</text><text x="${X(i0)}" y="${H - 3}" text-anchor="middle" font-size="10.5" fill="var(--faint)">${esc(fmtDate(d[n - 1].date))}</text>${nF ? `<text x="${W - pad.r}" y="${H - 3}" text-anchor="end" font-size="10.5" fill="var(--faint)">+${nF} trading days</text>` : ""}</svg>`;
}
// the expanded view: big charts plus today's numbers and the forecast, each with what it means
function liveMore(g) {
  if (!g) return "";
  const c = CO[g.id] || g, S = g.stats || {}, a = g.analysis, run = g.ladderRun, L = g.ladderRows || [], at = h => L.find(r => r.h === h);
  const z = S.moveZ, zTxt = !fin(z) ? "—" : `${z >= 0 ? "+" : "−"}${Math.abs(z).toFixed(1)} σ`, zNote = !fin(z) ? "" : Math.abs(z) < 1 ? "an ordinary day" : Math.abs(z) < 2 ? "a larger than usual move" : "an unusually large move (beyond 2 daily σ)";
  const tT = S.trendT, trend = !fin(S.trendPctHr) ? "—" : `${S.trendPctHr >= 0 ? "+" : "−"}${Math.abs(S.trendPctHr).toFixed(2)}% / hour`, tNote = !fin(tT) ? "needs 10+ samples in the last hour" : Math.abs(tT) < 2 ? `t ${tT.toFixed(1)}: no clear trend` : `t ${tT.toFixed(1)}: a stronger ${tT > 0 ? "rise" : "fall"} than random noise in the last hour (intraday moves rarely persist)`;
  const rv = S.rvAnn, mv = run?.vol, rvNote = !fin(rv) ? "needs 30+ minutes of trading" : mv ? `model expects ${pct(mv, 0, false)}; today is ${rv > mv * 1.3 ? "more turbulent" : rv < mv * 0.7 ? "calmer" : "about as expected"}` : "";
  const rng = fin(S.hi) && S.hi > S.lo ? (S.last - S.lo) / (S.hi - S.lo) : null;
  const row = (k, v, n) => `<div class="lm-row"><span class="muted">${k}</span><span class="mono">${v}</span>${n ? `<span class="faint lm-n">${n}</span>` : ""}</div>`;
  return `<div class="lm">
    <div class="lm-charts"><div class="lm-t small muted">This session ${S.minutes ? `· ${Math.floor(S.minutes / 60)}h ${S.minutes % 60}m of prices` : ""}</div>${intraChart(g, c, 620, 190, true)}
      <div class="lm-t small muted" style="margin-top:8px">Last ${(g.daily || []).length} trading days and the 90-day outlook${run ? ` (from the ${fmtDate(run.made)} close)` : ""}: median dashed, 50% and 90% ranges shaded</div>${outlookChart(g, c, 620, 170)}</div>
    <div class="lm-side small">
      <div class="lm-h">Today</div>
      ${row("Move vs model's daily volatility", zTxt, zNote)}
      ${row("Trend, last hour", trend, tNote)}
      ${row("Realised volatility (annualised)", fin(rv) ? pct(rv, 0, false) : "—", rvNote)}
      ${row("Position in today's range", fin(rng) ? pct(rng, 0, false) : "—", fin(rng) ? `low ${px(S.lo, c)} · high ${px(S.hi, c)}` : "")}
      <div class="lm-h">Outlook (trading days ahead)</div>
      <table class="lm-tab"><thead><tr><th class="t"></th><th>Median</th><th>90% range</th><th>P(up)</th></tr></thead><tbody>${[1, 5, 20, 60, 90].map(h => at(h)).filter(Boolean).map(r => `<tr><td class="t">+${r.h}</td><td>${px(r.p50, c)}</td><td>${px(r.p05, c)} – ${px(r.p95, c)}</td><td>${pct(r.pUp, 0, false)}</td></tr>`).join("") || `<tr><td class="t muted" colspan="4">Not enough history for an outlook yet</td></tr>`}</tbody></table>
      ${a ? `<div class="lm-h">52 weeks</div>${row("Median · P(gain)", `${px(a.median, c)} · ${pct(a.pUp, 0, false)}`)}${row("90% range", `${px(a.p05, c)} – ${px(a.p95, c)}`)}${row("Volatility · growth assumed", `${pct(a.vol, 0, false)} · ${pct(a.mu, 1)}/yr`)}` : ""}
      <p class="faint lm-n" style="margin:8px 0 0">σ = the model's daily volatility (GARCH on 3 years of daily returns). Trend = the last hour's return; t = that return ÷ its own volatility (about ±2 would be unusual for random noise). Realised volatility uses 5-minute returns scaled to a full session. Ranges are calibrated; direction is not predictable.</p>
      <p class="faint lm-n" style="margin:6px 0 0">Click the card to open ${esc(g.nm)} · Esc or × to close</p>
    </div></div>`;
}
// ═════════════════════════════ ALERTS (banner on every page) ═════════════════════════════
function renderAlerts() {
  let el = $("#alertbar"); const A = STATE.alerts || [];
  if (!el) { el = document.createElement("div"); el.id = "alertbar"; el.className = "wrap"; $("#main").before(el); }
  el.innerHTML = A.length ? `<div class="note warn small" role="alert" style="margin:10px 0 0">${A.length === 1 ? "" : `<b>${A.length} problems need attention.</b> `}${A.slice(0, 3).map(a => esc(a.msg)).join(" · ")}${A.length > 3 ? " · …" : ""} <a href="#/trial">Details</a></div>` : "";
}

// ═════════════════════════════ 3-MONTH TRIAL ═════════════════════════════
const TRIAL_DAYS = 90;
async function vTrial(M) {
  M.innerHTML = `<div class="pagehead"><div><h1>3-month trial</h1><div class="sub">Every trading day, each stock gets two 90-day outlooks: its tuned model and the standard model. Both are scored against the same real closes. This page shows whether the tuning is earning its place, stock by stock.</div></div></div><p class="muted" id="tload">Loading…</p>`;
  let T, AL; try { [T, AL] = await Promise.all([api("/api/trial"), api("/api/alerts")]); } catch (e) { $("#tload").textContent = e.message; return; }
  const day = T.tradingDaysLogged, pctDone = Math.min(1, day / TRIAL_DAYS);
  const ms = [[1, "First outlooks logged"], [5, "1-week forecasts start scoring"], [20, "1-month horizons scored; band factors start using live data"], [60, "3-month horizons scored"], [90, "Every horizon has a full live record: day-90 report"]];
  const all = T.stocks.filter(s => s.cmp.n), tot = all.reduce((a, s) => a + s.cmp.n, 0);
  const verdictBadge = v => ({ "tuned is better": '<span class="badge ok">tuned better</span>', "standard is better": '<span class="badge no">standard better</span>', "no clear difference": '<span class="badge">no clear difference</span>', "too early": '<span class="badge">too early</span>' })[v] || '<span class="faint">no scores yet</span>';
  $("#tload").remove();
  M.insertAdjacentHTML("beforeend", `
  ${AL.active.length ? `<div class="panel" style="margin-bottom:14px"><header><h2>Needs attention</h2></header><div class="body flush tbl"><table><tbody>${AL.active.map(a => `<tr><td class="t small mono" style="width:150px">${esc(fmtTime(a.first))}</td><td class="t"><span class="badge ${a.level === "problem" ? "no" : ""}">${esc(a.level)}</span> ${esc(a.msg)}</td></tr>`).join("")}</tbody></table></div></div>` : `<p class="note small" style="margin-top:0">All health checks pass: live capture, end-of-day steps, learning, backups${STATE.cloudOn ? ", cloud backup" : ""} and disk space. Checked every 5 minutes.</p>`}
  <div class="grid g2">
    <div class="panel"><header><h2>Progress</h2><span class="muted small">started ${T.start ? esc(fmtDate(T.start)) : "—"}</span></header><div class="body">
      <div class="result"><div><div class="k">Trading days logged</div><div class="v">${day} / ${TRIAL_DAYS}</div></div><div><div class="k">Outlook days scored (both models)</div><div class="v">${tot.toLocaleString()}</div></div><div><div class="k">Stocks in the trial</div><div class="v">${T.stocks.length}</div></div></div>
      <div style="height:8px;background:var(--surface2);border:1px solid var(--line);border-radius:4px;margin:12px 0"><div style="height:100%;width:${(pctDone * 100).toFixed(1)}%;background:var(--accent);border-radius:3px"></div></div>
      <ol class="small" style="margin:0;padding-left:18px;line-height:1.8">${ms.map(([d, t]) => `<li>${day >= d ? '<span class="pos">✓</span>' : `<span class="faint">day ${d}</span>`} ${esc(t)}</li>`).join("")}</ol></div></div>
    <div class="panel"><header><h2>How to read it</h2></header><div class="body small"><ul style="margin:0;padding-left:18px;line-height:1.7">
      <li><b>Score</b> is the average quantile score (CRPS-type) of the forecasts that have matured. Lower is better.</li>
      <li><b>Gain</b> is how much lower the tuned model's score is than the standard model's on the same days.</li>
      <li><b>DM t</b> is the Diebold–Mariano statistic on the paired differences. Above +2: tuning genuinely better. Below −2: genuinely worse. In between: not distinguishable yet.</li>
      <li>A verdict needs at least 200 paired outlook days. If the standard model is clearly better, KUBER <b>switches that stock's tuning off automatically</b> and records why. You can switch it back on below.</li>
      <li><b>In 90%</b> should sit near 90%. Much higher means ranges are too wide; much lower, too narrow.</li></ul></div></div>
  </div>
  <div class="panel" style="margin-top:14px"><header><h2>Tuned vs standard, per stock</h2></header><div class="body flush tbl"><table><thead><tr><th class="t">Company</th><th class="t">Tuning in use</th><th>Days scored</th><th>Score: tuned · standard</th><th>Gain</th><th>DM t</th><th>In 90%: tuned · standard</th><th>Waiting</th><th class="t">Verdict</th><th></th></tr></thead><tbody>
    ${T.stocks.sort((a, b) => (b.held - a.held) || a.nm.localeCompare(b.nm)).map(s => { const c = s.cmp, t = s.tuning, parts = [t.ownModel && "own model", t.kappa && t.kappa.some(x => x !== 1) && "band factors", t.weights && "factor weights", t.calib && "drift/band correction"].filter(Boolean);
      return `<tr><td class="t"><a href="#/c/${encodeURIComponent(s.id)}">${esc(s.nm)}</a> ${s.held ? '<span class="badge ok">held</span>' : ""}</td><td class="t small">${s.off ? `<span class="neg">off</span> <span class="faint">(${esc(s.off.reason)})</span>` : parts.length ? esc(parts.join(", ")) : '<span class="faint">none (standard)</span>'}</td><td>${(c.n || 0).toLocaleString()}</td><td class="mono small">${c.n ? `${x2(c.qt, 4)} · ${x2(c.qb, 4)}` : "—"}</td><td class="${c.n ? cls(c.gain) : ""}">${c.n ? pct(c.gain, 1) : "—"}</td><td class="mono">${c.n >= 30 ? x2(c.dm.t) : "—"}</td><td class="small">${c.n ? `${pct(c.in90t, 0, false)} · ${pct(c.in90b, 0, false)}` : "—"}</td><td>${s.pending.toLocaleString()}</td><td class="t">${verdictBadge(c.verdict)}</td><td>${s.off ? `<button class="btn sm" data-ton="${esc(s.id)}">Re-enable tuning</button>` : parts.length ? `<button class="btn sm" data-toff="${esc(s.id)}">Switch off</button>` : ""}</td></tr>`; }).join("")}
  </tbody></table></div><div class="body small faint">Both outlooks use the same random numbers and the same data, so differences come from the tuning alone. The standard model is KUBER's base model: GARCH(1,1), bootstrapped shocks, 3 years of history, CAPM drift, no per-stock adjustments.</div></div>
  ${AL.recent.length ? `<div class="panel" style="margin-top:14px"><header><h2>Health history</h2><span class="muted small">last 40 alerts</span></header><div class="body flush tbl"><table><tbody>${AL.recent.map(a => `<tr><td class="t small mono" style="width:150px">${esc(fmtTime(a.first))}</td><td class="t small">${esc(a.msg)}</td><td class="t small">${a.resolved ? `<span class="pos">resolved ${esc(fmtTime(a.resolved))}</span>` : '<span class="neg">open</span>'}</td></tr>`).join("")}</tbody></table></div></div>` : ""}`);
  const tog = async (id, on) => { await api("/api/trial/tuning", { method: "POST", body: { id, on } }); await reload(); vTrial(M); };
  $$("[data-toff]", M).forEach(b => b.onclick = () => { if (b.dataset.armed) tog(b.dataset.toff, false); else { b.dataset.armed = 1; b.textContent = "Confirm"; } });
  $$("[data-ton]", M).forEach(b => b.onclick = () => tog(b.dataset.ton, true));
}

// ═════════════════════════════ simulator: system simulations ═════════════════════════════
// Every automatic forecast the engine logs is a simulation made by the system: the same model, inputs stopping at the
// day it was made, scored against the real close when its date arrives. Shown beside your own simulations.
let SYS = null, sysStock = "all", sysStatus = "all", sysShow = 100;
async function drawSysSims() {
  const log = [...$$("#main .panel")].find(p => p.querySelector("h2")?.textContent === "Simulation log"); if (!log) return;
  let box = $("#syssims"); if (!box) { box = document.createElement("div"); box.id = "syssims"; box.style.marginTop = "14px"; log.insertAdjacentElement("afterend", box); }
  box.innerHTML = `<div class="panel"><header><h2>System simulations</h2><span class="muted small">loading…</span></header></div>`;
  try { SYS = await api("/api/autosims"); } catch (e) { box.innerHTML = `<p class="note warn">${esc(e.message)}</p>`; return; }
  renderSysSims();
}
function renderSysSims() {
  const box = $("#syssims"); if (!box || !SYS) return;
  const nm = id => SYS.names[id] || CO[id]?.nm || id, cc = id => CO[id] || { cur: SYS.cur?.[id] || "" }, all = SYS.rows, f = all.filter(r => (sysStock === "all" || r.cid === sysStock) && (sysStatus === "all" || (sysStatus === "scored" ? r.scored : !r.scored)));
  const done = all.filter(r => r.scored && (sysStock === "all" || r.cid === sysStock)), med = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
  const S = done.length ? { n: done.length, in50: done.filter(r => r.in50).length / done.length, in90: done.filter(r => r.in90).length / done.length, dir: done.filter(r => r.dirHit).length / done.length, err: med(done.map(r => Math.abs(r.err))) } : null;
  const stocks = [...new Set(all.map(r => r.cid))].sort((a, b) => nm(a).localeCompare(nm(b))), L = SYS.ladder.filter(l => sysStock === "all" || l.cid === sysStock);
  const waiting = all.filter(r => !r.scored && (sysStock === "all" || r.cid === sysStock)), next = waiting.map(r => r.target).sort()[0];
  box.innerHTML = `<div class="panel"><header><h2>System simulations</h2><span class="muted small">${all.length.toLocaleString()} made by KUBER automatically · ${all.filter(r => r.scored).length.toLocaleString()} scored</span>
    <span class="r"><select id="sys-s" aria-label="Stock" style="font-size:12.5px"><option value="all">All stocks</option>${stocks.map(id => `<option value="${esc(id)}" ${id === sysStock ? "selected" : ""}>${esc(nm(id))}</option>`).join("")}</select>
    <span class="seg" id="sys-f">${[["all", "All"], ["waiting", "Waiting"], ["scored", "Scored"]].map(([k, n]) => `<button data-f="${k}" aria-pressed="${sysStatus === k}">${n}</button>`).join("")}</span></span></header><div class="body">
    <p class="small muted" style="margin-top:0">After each trading day's close, KUBER runs the model for every tracked stock using only data up to that close, and records where it expects the price 1, 4 and 13 weeks later (median and 50% / 90% ranges). Each one is scored when its date arrives, exactly like your simulations, and the scores feed the learning step.</p>
    ${S ? `<div class="result" style="margin-bottom:12px"><div><div class="k">Scored</div><div class="v">${S.n.toLocaleString()}</div></div><div><div class="k">Inside 50% range</div><div class="v">${pct(S.in50, 0, false)}</div><div class="s">well calibrated ≈ 50%</div></div><div><div class="k">Inside 90% range</div><div class="v">${pct(S.in90, 0, false)}</div><div class="s">well calibrated ≈ 90%</div></div><div><div class="k">Direction right</div><div class="v">${pct(S.dir, 0, false)}</div><div class="s">coin flip = 50%</div></div><div><div class="k">Median price error</div><div class="v">${pct(S.err, 1, false)}</div></div></div>`
      : `<p class="note small">None scored yet: the first ones (1-week) mature on ${esc(fmtDate(next))}. ${waiting.length.toLocaleString()} are waiting.</p>`}
    ${L.length ? `<details class="more" style="margin-bottom:10px"><summary>90-day outlooks (one forecast for each of the next 90 trading days, made every day)</summary><div class="tbl" style="margin-top:8px"><table><thead><tr><th class="t">Company</th><th>Days made</th><th>Outlook days logged</th><th>Scored</th><th>Inside 50%</th><th>Inside 90%</th><th class="t">Since</th></tr></thead><tbody>${L.sort((a, b) => nm(a.cid).localeCompare(nm(b.cid))).map(l => `<tr><td class="t"><a href="#/c/${encodeURIComponent(l.cid)}">${esc(nm(l.cid))}</a></td><td>${l.runs}</td><td>${l.days.toLocaleString()}</td><td>${l.scored.toLocaleString()}</td><td>${l.scored ? pct(l.in50, 0, false) : "—"}</td><td>${l.scored ? pct(l.in90, 0, false) : "—"}</td><td class="t small">${esc(fmtDate(l.first))}</td></tr>`).join("")}</tbody></table></div><p class="small faint">Full detail per stock on its company page and on the Trial page.</p></details>` : ""}
    </div><div class="body flush tbl"><table><thead><tr><th class="t">Made</th><th class="t">Company</th><th>Weeks</th><th class="t">Target</th><th>Start price</th><th>Median</th><th>90% range</th><th>P(up)</th><th>Actual</th><th class="t">Result</th></tr></thead><tbody>
    ${f.slice(0, sysShow).map(r => { return `<tr><td class="t mono small">${esc(r.made)}</td><td class="t"><a href="#/c/${encodeURIComponent(r.cid)}">${esc(nm(r.cid))}</a></td><td>${r.H}</td><td class="t mono small">${esc(r.target)}</td><td>${px(r.p0, cc(r.cid))}</td><td>${px(r.median, cc(r.cid))}</td><td class="small">${px(r.p05, cc(r.cid))} – ${px(r.p95, cc(r.cid))}</td><td>${pct(r.pUp, 0, false)}</td><td>${r.scored ? px(r.actual, cc(r.cid)) : '<span class="faint">waiting</span>'}</td><td class="t">${r.scored ? `<span class="badge ${r.in50 ? "ok" : "no"}">50% ${r.in50 ? "✓" : "✗"}</span> <span class="badge ${r.in90 ? "ok" : "no"}">90% ${r.in90 ? "✓" : "✗"}</span> <span class="badge ${r.dirHit ? "ok" : "no"}">dir ${r.dirHit ? "✓" : "✗"}</span>` : ""}</td></tr>`; }).join("") || `<tr><td class="t muted" colspan="10">None match the filter.</td></tr>`}
    </tbody></table>${f.length > sysShow ? `<div style="padding:10px 14px"><button class="btn sm" id="sys-more">Show ${Math.min(200, f.length - sysShow)} more (${(f.length - sysShow).toLocaleString()} left)</button></div>` : ""}</div></div>`;
  $("#sys-s").onchange = e => { sysStock = e.target.value; sysShow = 100; renderSysSims(); };
  $("#sys-f").onclick = e => { const b = e.target.closest("button"); if (!b) return; sysStatus = b.dataset.f; sysShow = 100; renderSysSims(); };
  $("#sys-more")?.addEventListener("click", () => { sysShow += 200; renderSysSims(); });
}
