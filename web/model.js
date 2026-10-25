// ─────────────────────────────────────────────────────────────────────────────
// KUBER MODEL v4 — point-in-time stochastic forecaster with editable parameters
// and a per-stock model specification chosen out of sample.
// Shared by the browser (web/) and the local engine (server/). Pure math: no
// network, no randomness that isn't seeded, no data that isn't passed in.
//
//   d ln S = (μ − σₜ²/2) dt + σₜ dW          Itô; σₜ follows GARCH(1,1)
//   paths  = filtered historical simulation  (bootstrapped GARCH residuals)
//   μ      = precision-weighted blend of enabled drift signals (Bayesian)
//   bands  = calibrated by κ(H) × per-company κ adjustment (learned)
//   spec   = per stock: volatility model, shock law, history window, drift signals
//   prices = history adjusted for dividends/splits/demergers for returns; exchange prices for levels
// ─────────────────────────────────────────────────────────────────────────────
const Q = (() => {
  const DEFAULT_PARAMS = {
    version: 4,
    market: {
      US: { rf: 0.040, erp: 0.050, r: 0.095, peBase: 12 },
      TW: { rf: 0.040, erp: 0.055, r: 0.095, peBase: 12 },
      KR: { rf: 0.0275, erp: 0.060, r: 0.100, peBase: 9 },
      IN: { rf: 0.065, erp: 0.055, r: 0.120, peBase: 16 }
    },
    data: { window: 156, minHistory: 30, lagDays: 60 },
    vol: { kappaKnots: [[4, 1.02], [13, 1.12], [26, 1.22], [52, 1.30]], floor: 0.08, cap: 1.5, alphaMax: 0.30, betaMin: 0.50 },
    sim: { method: "fhs", paths: 10000 },
    drift: {
      clampLo: -0.30, clampHi: 0.45,
      capm: { on: true, tau: 0.06 },
      valuation: { on: false, tau: 0.10, years: 3 },
      momentum: { on: false, tau: 0.14, k: 0.15 },
      sample: { on: false, tau: 0.15 },
      sentiment: { on: false, tau: 0.12, k: 0.10 }
    },
    fairValue: { wEarn: 0.6, wBook: 0.4 },
    score: { weights: { value: 0.22, quality: 0.18, growth: 0.12, edge: 0.20, trend: 0.13, safety: 0.15 } },
    learn: { enabled: true, minScored: 8, shrinkN0: 120, muCap: 0.15, validFrac: 0.3, kappaGrid: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5], acceptMargin: 0.0,
      selectModels: true, holdout: 0.3, minGain: 0.01, dmCrit: 1.645 }
  };
  let P = JSON.parse(JSON.stringify(DEFAULT_PARAMS));
  const deepMerge = (a, b) => { for (const k in b) { if (b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object") deepMerge(a[k], b[k]); else a[k] = b[k]; } return a; };
  function setParams(p) { P = deepMerge(JSON.parse(JSON.stringify(DEFAULT_PARAMS)), p || {}); return P; }
  const getParams = () => JSON.parse(JSON.stringify(P));

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const lin = (x, x0, x1) => clamp((x - x0) / (x1 - x0), 0, 1) * 100;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  const last = a => a[a.length - 1];
  function N(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2); return x >= 0 ? (1 + y) / 2 : (1 - y) / 2; }
  const npdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function gauss(u) { let s = null; return () => { if (s !== null) { const v = s; s = null; return v; } let a = u(), b = u(); if (a < 1e-12) a = 1e-12; const r = Math.sqrt(-2 * Math.log(a)); s = r * Math.sin(2 * Math.PI * b); return r * Math.cos(2 * Math.PI * b); }; }
  const hash = s => [...String(s)].reduce((h, ch) => (Math.imul(h ^ ch.charCodeAt(0), 16777619)) >>> 0, 2166136261);
  const DAY = 864e5, toT = d => Date.parse(d + "T00:00:00Z");
  const kappaFor = H => { const k = P.vol.kappaKnots; if (H <= k[0][0]) return k[0][1]; for (let i = 1; i < k.length; i++) if (H <= k[i][0]) { const [h0, v0] = k[i - 1], [h1, v1] = k[i]; return v0 + (v1 - v0) * (H - h0) / (h1 - h0); } return k[k.length - 1][1]; };

  function idxAtOrBefore(c, date) { const t = toT(date); let i = -1; for (let k = 0; k < c.wd.length; k++) { if (toT(c.wd[k]) <= t) i = k; else break; } return i; }
  function idxAtOrAfter(c, date) { const t = toT(date); for (let k = 0; k < c.wd.length; k++) if (toT(c.wd[k]) >= t) return k; return -1; }
  function returns(p) { const r = []; for (let i = 1; i < p.length; i++) r.push(Math.log(p[i] / p[i - 1])); return r; }

  // ── fundamentals as known at a date ───────────────────────────────────────
  function fyEnd(label, c) {
    if (!label || /TTM/i.test(label)) return null;
    let m = label.match(/([A-Z][a-z]{2})\s+(\d{4})/);
    if (m) return Date.UTC(+m[2], "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[1]) / 3 + 1, 0);
    m = label.match(/(\d{4})/);
    if (m) return Date.UTC(+m[1], c.fyEndMonth || 12, 0);
    return null;
  }
  function fundAt(c, date) {
    const f = c.fin, t = toT(date), lag = P.data.lagDays * DAY, out = { np: [], rev: [], eps: null, bvps: null, yrs: [] };
    const isLive = date >= c.wd[c.wd.length - 1];
    if (f && f.y) {
      for (let i = 0; i < f.y.length; i++) {
        const end = fyEnd(f.y[i], c), usable = end == null ? isLive : end + lag <= t;
        if (!usable) continue;
        out.yrs.push(f.y[i]); out.np.push(f.np?.[i] ?? null); out.rev.push(f.rev?.[i] ?? null);
        if (f.eps && f.eps[i] != null) out.eps = f.eps[i]; else if (f.np?.[i] != null && c.shares) out.eps = f.np[i] * (c.finScale || 1) / c.shares;
      }
    }
    if (c.bvpsH) for (let i = 0; i < c.bvpsH.y.length; i++) { const end = fyEnd(c.bvpsH.y[i], c), usable = end == null ? isLive : end + lag <= t; if (usable && c.bvpsH.v[i] != null) out.bvps = c.bvpsH.v[i]; }
    if (isLive) { if (c.pe) out.eps = c.px / c.pe; if (c.bv) out.bvps = c.bv; }
    return out;
  }
  function cagr(a, n) { const v = (a || []).filter(x => x != null); if (v.length < 2) return null; const k = Math.min(n, v.length - 1); const x0 = v[v.length - 1 - k], x1 = last(v); return (x0 > 0 && x1 > 0) ? Math.pow(x1 / x0, 1 / k) - 1 : null; }

  // ── GARCH(1,1) by grid-search maximum likelihood ─────────────────────────
  function garch(r) {
    const m = mean(r), e = r.map(x => x - m), vbar = e.reduce((a, x) => a + x * x, 0) / e.length;
    let best = { ll: -Infinity };
    for (let a = 0.02; a <= P.vol.alphaMax + 1e-9; a += 0.02) for (let b = P.vol.betaMin; b <= 0.975; b += 0.015) {
      if (a + b >= 0.995) continue;
      const w = vbar * (1 - a - b); let h = vbar, ll = 0;
      for (const x of e) { ll += -0.5 * (Math.log(2 * Math.PI * h) + x * x / h); h = w + a * x * x + b * h; }
      if (ll > best.ll) best = { ll, a, b, w };
    }
    let h = vbar; const z = [];
    for (const x of e) { z.push(x / Math.sqrt(h)); h = best.w + best.a * x * x + best.b * h; }
    const zm = mean(z), zs = sd(z) || 1, p = best.a + best.b;
    const fc = H => { let s = 0; for (let k = 1; k <= H; k++) s += vbar + Math.pow(p, k - 1) * (h - vbar); return s / H; };
    return { alpha: best.a, beta: best.b, omega: best.w, persist: p, hNext: h, vbar, z: z.map(x => (x - zm) / zs), vNow: Math.sqrt(h * 52), vLong: Math.sqrt(vbar * 52), vH: H => Math.sqrt(fc(H) * 52), halfLife: Math.log(0.5) / Math.log(p), ll: best.ll };
  }

  // EWMA (RiskMetrics): h = λh + (1−λ)ε², λ by maximum likelihood on a grid; no mean reversion
  function ewma(r) {
    const m = mean(r), e = r.map(x => x - m), vbar = e.reduce((a, x) => a + x * x, 0) / e.length, h0 = mean(e.slice(0, Math.min(12, e.length)).map(x => x * x)) || vbar;
    let best = { ll: -Infinity };
    for (const lam of [0.80, 0.85, 0.90, 0.93, 0.95, 0.97, 0.98, 0.99]) { let h = h0, ll = 0; for (const x of e) { ll += -0.5 * (Math.log(2 * Math.PI * h) + x * x / h); h = lam * h + (1 - lam) * x * x; } if (ll > best.ll) best = { ll, lam }; }
    let h = h0; const z = []; for (const x of e) { z.push(x / Math.sqrt(h)); h = best.lam * h + (1 - best.lam) * x * x; }
    const zm = mean(z), zs = sd(z) || 1;
    return { kind: "ewma", lambda: best.lam, alpha: 1 - best.lam, beta: best.lam, omega: 0, persist: 1, hNext: h, vbar, z: z.map(x => (x - zm) / zs), vNow: Math.sqrt(h * 52), vLong: Math.sqrt(vbar * 52), vH: () => Math.sqrt(h * 52), halfLife: Infinity, ll: best.ll };
  }
  // constant volatility (classic Black–Scholes assumption): sample variance of the window
  function constVol(r) {
    const m = mean(r), e = r.map(x => x - m), vbar = e.reduce((a, x) => a + x * x, 0) / Math.max(1, e.length - 1), z = e.map(x => x / Math.sqrt(vbar)), zm = mean(z), zs = sd(z) || 1;
    const ll = e.reduce((a, x) => a - 0.5 * (Math.log(2 * Math.PI * vbar) + x * x / vbar), 0);
    return { kind: "const", alpha: 0, beta: 0, omega: vbar, persist: 0, hNext: vbar, vbar, z: z.map(x => (x - zm) / zs), vNow: Math.sqrt(vbar * 52), vLong: Math.sqrt(vbar * 52), vH: () => Math.sqrt(vbar * 52), halfLife: 0, ll };
  }
  // HAR realised-volatility model (Corsi 2009) on weekly realised variance from daily ranges, in logs:
  //   ln RVₜ₊₁ = b₀ + b₁·ln RVₜ + b₂·ln RV̄ₜ(4 wk) + b₃·ln RV̄ₜ(13 wk) + e
  // Forecasts are scaled so that E[r²/h] = 1 on the fitting window (removes the range estimator's small bias).
  function solve(A, b) { const n = b.length, M = A.map((r, i) => [...r, b[i]]); for (let i = 0; i < n; i++) { let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[p][i])) p = k; [M[i], M[p]] = [M[p], M[i]]; if (Math.abs(M[i][i]) < 1e-12) return null; for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; } } return M.map((r, i) => r[n] / r[i]); }
  function harRV(r, rv) {
    const n = r.length; if (!rv || rv.length !== n || n < 40) return null;
    const floor = 1e-6, L = rv.map(x => Math.log(Math.max(floor, x || 0)));
    const avg = (t, k) => Math.log(Math.max(floor, mean(rv.slice(Math.max(0, t - k + 1), t + 1).map(x => x || 0))));
    const X = [], y = []; for (let t = 12; t < n - 1; t++) { X.push([1, L[t], avg(t, 4), avg(t, 13)]); y.push(L[t + 1]); }
    if (X.length < 25) return null;
    const XtX = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => X.reduce((s, x) => s + x[i] * x[j], 0))), Xty = [0, 1, 2, 3].map(i => X.reduce((s, x, k) => s + x[i] * y[k], 0)), b = solve(XtX, Xty);
    if (!b) return null;
    const res = y.map((v, k) => v - X[k].reduce((s, x, j) => s + x * b[j], 0)), s2 = res.reduce((s, e) => s + e * e, 0) / Math.max(1, res.length - 4);
    const pred = (l1, a4, a13) => Math.exp(b[0] + b[1] * l1 + b[2] * a4 + b[3] * a13 + s2 / 2);
    // in-sample one-step forecasts for t ≥ 13 (h for return r[t] uses information up to t−1)
    const hIn = []; for (let t = 13; t < n; t++) hIn.push(pred(L[t - 1], avg(t - 1, 4), avg(t - 1, 13)));
    const rr = r.slice(13), m = mean(r), scale = mean(rr.map((x, i) => (x - m) ** 2 / hIn[i])), hs = hIn.map(h => h * scale);
    const z = rr.map((x, i) => (x - m) / Math.sqrt(hs[i])), zm = mean(z), zs = sd(z) || 1;
    // iterate the HAR recursion forward for the forecast path
    const path = [], hist = rv.map(x => Math.max(floor, x || 0));
    for (let k = 0; k < 52; k++) { const t = hist.length - 1, f = pred(Math.log(hist[t]), Math.log(mean(hist.slice(-4))), Math.log(mean(hist.slice(-13)))); path.push(f * scale); hist.push(f); }
    const vbar = mean(rr.map(x => (x - m) ** 2)), persist = b[1] + b[2] + b[3];
    return { kind: "rv", har: b, scale, alpha: 0, beta: 0, omega: 0, persist, hNext: path[0], hPath: t => path[Math.min(path.length - 1, t - 1)], vbar, z: z.map(x => (x - zm) / zs),
      vNow: Math.sqrt(path[0] * 52), vLong: Math.sqrt(vbar * 52), vH: H => Math.sqrt(mean(path.slice(0, Math.max(1, Math.min(52, H)))) * 52), halfLife: persist < 1 && persist > 0 ? Math.log(0.5) / Math.log(persist) : Infinity, ll: null };
  }
  function volModel(r, kind, rv) { if (kind === "ewma") return ewma(r); if (kind === "const") return constVol(r); if (kind === "rv") { const h = harRV(r, rv); if (h) return h; } const g = garch(r); g.kind = "garch"; if (kind === "rv") g.fallback = "no daily ranges for this window"; return g; }
  // Student-t degrees of freedom from the standardised residuals' excess kurtosis (method of moments: κ = 6/(ν−4))
  function tDof(z) { const k = mean(z.map(x => x ** 4)) - 3; return k <= 0.2 ? 30 : clamp(4 + 6 / k, 4.5, 30); }

  // ── 2-state Gaussian HMM (Baum–Welch) ─────────────────────────────────────
  function hmm(r) {
    const T = r.length, s = sd(r), m = mean(r);
    let mu = [m + 0.3 * s, m - 0.3 * s], sg = [s * 0.7, s * 1.4], A = [[0.9, 0.1], [0.1, 0.9]], pi = [0.5, 0.5], gam = [];
    const pdf = (x, k) => Math.exp(-0.5 * ((x - mu[k]) / sg[k]) ** 2) / (sg[k] * Math.sqrt(2 * Math.PI)) + 1e-300;
    for (let it = 0; it < 40; it++) {
      const al = [], be = [], c = [];
      al[0] = [pi[0] * pdf(r[0], 0), pi[1] * pdf(r[0], 1)]; c[0] = al[0][0] + al[0][1]; al[0] = al[0].map(x => x / c[0]);
      for (let t = 1; t < T; t++) { const a = [0, 1].map(j => (al[t - 1][0] * A[0][j] + al[t - 1][1] * A[1][j]) * pdf(r[t], j)); c[t] = a[0] + a[1]; al[t] = a.map(x => x / c[t]); }
      be[T - 1] = [1, 1];
      for (let t = T - 2; t >= 0; t--) be[t] = [0, 1].map(i => (A[i][0] * pdf(r[t + 1], 0) * be[t + 1][0] + A[i][1] * pdf(r[t + 1], 1) * be[t + 1][1]) / c[t + 1]);
      gam = al.map((a, t) => { const g = [a[0] * be[t][0], a[1] * be[t][1]]; const z = g[0] + g[1]; return [g[0] / z, g[1] / z]; });
      const xi = [[0, 0], [0, 0]];
      for (let t = 0; t < T - 1; t++) { let z = 0; const x = [[0, 0], [0, 0]]; for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { x[i][j] = al[t][i] * A[i][j] * pdf(r[t + 1], j) * be[t + 1][j]; z += x[i][j]; } for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) xi[i][j] += x[i][j] / z; }
      pi = gam[0].slice();
      for (let i = 0; i < 2; i++) { const d = xi[i][0] + xi[i][1]; A[i] = [xi[i][0] / d, xi[i][1] / d]; }
      for (let k = 0; k < 2; k++) { const w = gam.reduce((a, g) => a + g[k], 0); mu[k] = gam.reduce((a, g, t) => a + g[k] * r[t], 0) / w; sg[k] = Math.max(s * 0.25, Math.sqrt(gam.reduce((a, g, t) => a + g[k] * (r[t] - mu[k]) ** 2, 0) / w)); }
    }
    const calm = sg[0] <= sg[1] ? 0 : 1, turb = 1 - calm, pNow = last(gam)[calm];
    return { calm: { mu: mu[calm] * 52, vol: sg[calm] * Math.sqrt(52), stay: A[calm][calm] }, turb: { mu: mu[turb] * 52, vol: sg[turb] * Math.sqrt(52), stay: A[turb][turb] }, pCalmNext: pNow * A[calm][calm] + (1 - pNow) * A[turb][calm], path: gam.map(g => g[calm]) };
  }

  // ── random-walk tests ─────────────────────────────────────────────────────
  function rwTests(r) {
    const T = r.length, m = mean(r), v1 = r.reduce((a, x) => a + (x - m) ** 2, 0) / (T - 1);
    const vr = q => { let s = 0, n = 0; for (let t = q - 1; t < T; t++) { let k = 0; for (let j = 0; j < q; j++) k += r[t - j]; s += (k - q * m) ** 2; n++; } const VR = (s / n) / (q * v1); return { VR, z: (VR - 1) / Math.sqrt(2 * (2 * q - 1) * (q - 1) / (3 * q * T)) }; };
    const med = [...r].sort((a, b) => a - b)[Math.floor(T / 2)], sg = r.map(x => x >= med), n1 = sg.filter(Boolean).length, n2 = T - n1;
    let runs = 1; for (let i = 1; i < T; i++) if (sg[i] !== sg[i - 1]) runs++;
    const runsZ = (runs - (2 * n1 * n2 / T + 1)) / Math.sqrt(2 * n1 * n2 * (2 * n1 * n2 - T) / (T * T * (T - 1)));
    let num = 0, den = 0; for (let t = 0; t < T; t++) { den += (r[t] - m) ** 2; if (t) num += (r[t] - m) * (r[t - 1] - m); }
    const ac1 = num / den, v2 = vr(2), v4 = vr(4);
    const pts = []; for (const w of [4, 8, 13, 26, 52]) { const rs = []; for (let s0 = 0; s0 + w <= T; s0 += w) { const seg = r.slice(s0, s0 + w), mm = mean(seg); let cum = 0, mx = -1e9, mn = 1e9; for (const x of seg) { cum += x - mm; mx = Math.max(mx, cum); mn = Math.min(mn, cum); } const ss = Math.sqrt(seg.reduce((a, x) => a + (x - mm) ** 2, 0) / w); if (ss > 0) rs.push((mx - mn) / ss); } if (rs.length) pts.push([Math.log(w), Math.log(mean(rs))]); }
    const mx = mean(pts.map(p => p[0])), my = mean(pts.map(p => p[1])), H = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    const sig = Math.abs(v2.z) > 1.96 || Math.abs(v4.z) > 1.96 || Math.abs(runsZ) > 1.96 || Math.abs(ac1) > 1.96 / Math.sqrt(T);
    const verdict = !sig ? "Consistent with a random walk" : (v2.VR > 1 && ac1 > 0) ? "Some evidence of trending" : (v2.VR < 1 && ac1 < 0) ? "Some evidence of mean reversion" : "Mixed evidence against a random walk";
    const sk = r.reduce((a, x) => a + ((x - m) / Math.sqrt(v1)) ** 3, 0) / T, ku = r.reduce((a, x) => a + ((x - m) / Math.sqrt(v1)) ** 4, 0) / T - 3;
    return { vr2: v2, vr4: v4, runs, runsZ, ac1, acBand: 1.96 / Math.sqrt(T), hurst: H, sig, verdict, skew: sk, kurt: ku, jb: T / 6 * (sk * sk + ku * ku / 4), T };
  }

  function technicals(p) {
    const sma = n => mean(p.slice(-Math.min(n, p.length)));
    const ema = (arr, n) => { const k = 2 / (n + 1); let e = arr[0]; return arr.map(v => (e = v * k + e * (1 - k))); };
    let g = 0, l = 0; for (let i = Math.max(1, p.length - 14); i < p.length; i++) { const d = p[i] - p[i - 1]; if (d > 0) g += d; else l -= d; }
    const e12 = ema(p, 12), e26 = ema(p, 26), macd = e12.map((x, i) => x - e26[i]), sig = ema(macd, 9);
    const w52 = p.slice(-52), px = last(p), s200 = sma(40);
    return { s50: sma(10), s200, above200: px / s200 - 1, rsi: l === 0 ? 100 : 100 - 100 / (1 + g / l), macdHist: last(macd) - last(sig), macd: last(macd), hi: Math.max(...w52), lo: Math.min(...w52), fromHi: px / Math.max(...w52) - 1, mom121: p.length > 52 ? p[p.length - 5] / p[p.length - 53] - 1 : p[p.length - 5] / p[0] - 1, ret52: px / w52[0] - 1 };
  }

  function fairValue(c, px, F, vol) {
    const M = P.market[c.mk], rEq = M.r + Math.min(0.06, 0.25 * Math.max(0, vol - 0.25));
    const gs = [cagr(F.rev, 3), cagr(F.np, 3), cagr(F.np, 5)].filter(x => x != null).map(x => clamp(x, -0.10, 0.40));
    const g = clamp(gs.length ? mean(gs) : 0, 0, c.cyc ? 0.06 : 0.20);
    let eps = F.eps, epsNote = "trailing EPS";
    if (eps && c.cyc) { const v = F.np.filter(x => x != null).slice(-5), now = last(v), avg = mean(v); if (now > 0 && avg > 0) { eps = eps * (0.5 + 0.5 * avg / now); epsNote = "cycle-normalised EPS"; } }
    const comps = [];
    if (eps && eps > 0 && !c.skipEarn) {
      let pej = Math.min(45, M.peBase + 1.5 * g * 100); if (c.cyc) pej = Math.min(pej, M.peBase * 0.8 + g * 100); pej *= M.r / rEq;
      comps.push({ k: "Earnings power", v: eps * pej, w: P.fairValue.wEarn, how: `${epsNote} × justified P/E ${pej.toFixed(1)} (growth ${(g * 100).toFixed(1)}%, cost of equity ${(rEq * 100).toFixed(1)}%)` });
    }
    const bv = F.bvps, roe = c.roeN != null ? c.roeN / 100 : (bv && F.eps ? F.eps / bv : null);
    if (bv && bv > 0 && roe != null) {
      const gb = Math.min(g, rEq - 0.03), pbj = roe > 0 ? clamp((roe - gb) / (rEq - gb), 0.5, 15) : 0.8;
      comps.push({ k: "Book value × ROE", v: bv * pbj, w: P.fairValue.wBook, how: `book value/share × justified P/B ${pbj.toFixed(2)} from ROE ${(roe * 100).toFixed(1)}%` });
    }
    if (c.skipFV) comps.length = 0;   // accounts too short or distorted for either method
    if (!comps.length) return { fv: null, up: 0, comps, g, rEq, conf: "None" };
    const ws = comps.reduce((a, x) => a + x.w, 0), fv = comps.reduce((a, x) => a + x.v * x.w, 0) / ws;
    return { fv, up: fv / px - 1, comps: comps.map(x => ({ ...x, wn: x.w / ws })), g, rEq, eps: F.eps, bvps: bv, conf: comps.length === 2 ? "Medium" : "Low" };
  }

  // drift signals; `all` = compute every signal for display regardless of on/off
  // mean reversion (Ornstein–Uhlenbeck, discretised as AR(1) on log price): Δyₜ = a + b·yₜ₋₁ + e
  // used only when the Dickey–Fuller t-statistic on b rejects a random walk at 5% (t < −2.86)
  function ouFit(p) {
    const y = p.map(Math.log), n = y.length - 1; if (n < 30) return null;
    const x = y.slice(0, -1), dy = y.slice(1).map((v, i) => v - y[i]), mx = mean(x), md = mean(dy);
    let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (dy[i] - md); }
    const b = sxy / sxx, a = md - b * mx, res = dy.map((v, i) => v - a - b * x[i]), s2 = res.reduce((s, e) => s + e * e, 0) / (n - 2), t = b / Math.sqrt(s2 / sxx);
    return { b, a, t, theta: b < 0 ? -a / b : null, halfLife: b < 0 ? Math.log(0.5) / Math.log(1 + b) : Infinity, y: y[y.length - 1], sig: t < -2.86 && b < 0 };
  }
  function driftSignals(c, px, vol, fv, tech, rw, r, sentiment, spec, p, H, all) {
    const M = P.market[c.mk], D = P.drift, beta = c.beta ? clamp(c.beta, 0.3, 2.2) : 1.0, out = [];
    const on = id => spec?.drift ? spec.drift.includes(id) : !!D[id]?.on;
    out.push({ id: "capm", k: "CAPM prior", mu: M.rf + beta * M.erp, tau: D.capm.tau, on: on("capm"), note: `risk-free ${(M.rf * 100).toFixed(2)}% + β ${beta.toFixed(2)} × ${(M.erp * 100).toFixed(1)}%` });
    if (fv.fv) out.push({ id: "valuation", k: "Valuation gap closing", mu: clamp(Math.log(fv.fv / px) / D.valuation.years + M.rf, -0.35, 0.45), tau: D.valuation.tau, on: on("valuation"), note: `ln(fair value ÷ price) ÷ ${D.valuation.years} yrs + risk-free` });
    out.push({ id: "momentum", k: "12-1 month momentum", mu: M.rf + D.momentum.k * clamp(rw.vr2.VR, 0.5, 1.5) * Math.log(1 + tech.mom121), tau: D.momentum.tau, on: on("momentum"), note: "scaled by the variance ratio" });
    out.push({ id: "sample", k: "Sample mean return", mu: mean(r) * 52 + vol * vol / 2, tau: Math.max(D.sample.tau, vol / Math.sqrt(r.length / 52)), on: on("sample"), note: `${r.length} weeks of history` });
    if (all || spec?.drift?.includes("rf")) out.push({ id: "rf", k: "Risk-free only (martingale)", mu: M.rf, tau: D.capm.tau, on: !!spec?.drift?.includes("rf"), note: "discounted price is a martingale: no risk premium assumed" });
    if ((all || spec?.drift?.includes("meanrev")) && p) {
      const o = ouFit(p), h = H || 52;
      if (o && o.sig) { const exp = (o.theta - o.y) * (1 - Math.pow(1 + o.b, h)); out.push({ id: "meanrev", k: "Mean reversion (OU)", mu: clamp(exp * 52 / h + vol * vol / 2, -0.6, 0.6), tau: D.momentum.tau, on: !!spec?.drift?.includes("meanrev"), note: `half-life ${o.halfLife.toFixed(0)} wks, Dickey–Fuller t ${o.t.toFixed(2)}` }); }
      else out.push({ id: "meanrev", k: "Mean reversion (OU)", mu: M.rf + beta * M.erp, tau: 1, on: !!spec?.drift?.includes("meanrev"), note: o ? `not significant (Dickey–Fuller t ${o.t.toFixed(2)} > −2.86), contributes nothing` : "not enough history" });
    }
    if (sentiment != null && isFinite(sentiment)) out.push({ id: "sentiment", k: "News sentiment (local LLM)", mu: M.rf + beta * M.erp + D.sentiment.k * sentiment, tau: D.sentiment.tau, on: on("sentiment"), note: `average headline sentiment ${sentiment.toFixed(2)} (−1 to +1)` });
    return { beta, sig: out };
  }
  // learned per-stock factor weights (non-negative, sum to 1); signals without a value fall back to CAPM
  function weighted(sig, W) {
    const by = Object.fromEntries(sig.map(s => [s.id, s])), capm = by.capm.mu; let mu = 0;
    for (const k in W) mu += W[k] * (by[k]?.mu ?? capm);
    sig.forEach(s => { s.on = (W[s.id] || 0) > 0; s.w = W[s.id] || 0; });
    return { mu: clamp(mu, P.drift.clampLo, P.drift.clampHi), postSd: null, used: Object.keys(W).filter(k => W[k] > 0), weights: W };
  }
  function combine(sig, onlyOn = true) {
    const use = sig.filter(s => !onlyOn || s.on); if (!use.length) use.push(sig[0]);
    const prec = use.map(s => 1 / (s.tau * s.tau)), Pp = prec.reduce((a, x) => a + x, 0);
    use.forEach((s, i) => s.w = prec[i] / Pp);
    return { mu: clamp(use.reduce((a, s, i) => a + s.mu * prec[i], 0) / Pp, P.drift.clampLo, P.drift.clampHi), postSd: Math.sqrt(1 / Pp), used: use.map(s => s.id) };
  }

  // ── simulation: FHS (bootstrapped GARCH residuals) or Gaussian GARCH ─────
  // Marsaglia–Tsang gamma sampler (shape ≥ 1), for Student-t shocks: t = Z / √(χ²ᵥ/ν), rescaled to unit variance
  function gammaS(u, z, a) { const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { let x, v; do { x = z(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const w = u(); if (w < 1 - 0.0331 * x ** 4 || Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } }
  function simulate(seedKey, S0, mu, G, H, paths, kappa, method) {
    const u = rng(hash(seedKey)), z = gauss(u), zp = G.z, nz = zp.length, k2 = kappa * kappa;
    const nu = method === "t" ? tDof(zp) : 0, tScale = nu ? Math.sqrt((nu - 2) / nu) : 1;
    const draw = method === "gaussian" ? z : method === "t" ? () => z() / Math.sqrt(2 * gammaS(u, z, nu / 2) / nu) * tScale : () => zp[(u() * nz) | 0] * (u() < 0.5 ? -1 : 1);
    const marks = []; for (let i = 1; i <= 12; i++) marks.push(Math.max(1, Math.round(H * i / 12)));
    const at = marks.map(() => new Float64Array(paths)), term = new Float64Array(paths);
    const sigH = Math.sqrt(G.vH(H) ** 2 * k2 * H / 52);
    let tp = 0, sl = 0, mddSum = 0;
    for (let p = 0; p < paths; p++) {
      let lnS = 0, h = G.hNext * k2, peak = 0, mdd = 0, mi = 0, bar = 0;
      for (let t = 1; t <= H; t++) {
        if (G.hPath) h = G.hPath(t) * k2;
        const e = Math.sqrt(h) * draw();
        lnS += mu / 52 - h / 2 + e;
        if (!G.hPath) h = G.omega * k2 + G.alpha * e * e + G.beta * h;
        if (lnS > peak) peak = lnS; if (peak - lnS > mdd) mdd = peak - lnS;
        if (!bar) { if (lnS >= sigH) bar = 1; else if (lnS <= -sigH) bar = -1; }
        while (mi < marks.length && t === marks[mi]) { at[mi][p] = S0 * Math.exp(lnS); mi++; }
      }
      term[p] = S0 * Math.exp(lnS); if (bar === 1) tp++; else if (bar === -1) sl++; mddSum += 1 - Math.exp(-mdd);
    }
    const q = (s, x) => s[Math.min(s.length - 1, Math.max(0, Math.floor(x * s.length)))];
    const fan = at.map((a, i) => { const s = Float64Array.from(a).sort(); return { w: marks[i], p05: q(s, .05), p25: q(s, .25), p50: q(s, .5), p75: q(s, .75), p95: q(s, .95) }; });
    const T = Float64Array.from(term).sort(), rets = Array.from(T, x => x / S0 - 1), tail = rets.slice(0, Math.max(1, Math.floor(0.05 * paths)));
    return { N: paths, H, nu: nu || null, fan, sorted: T, median: q(T, .5), p05: q(T, .05), p25: q(T, .25), p75: q(T, .75), p95: q(T, .95), mean: S0 * (mean(rets) + 1), pUp: rets.filter(x => x > 0).length / paths, p20: rets.filter(x => x > 0.2).length / paths, pm20: rets.filter(x => x < -0.2).length / paths, var95: -q(rets, 0.05), cvar95: -mean(tail), tp: tp / paths, sl: sl / paths, upB: S0 * Math.exp(sigH), dnB: S0 * Math.exp(-sigH), mdd: mddSum / paths };
  }
  function percentileOf(sorted, x) { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo / sorted.length; }

  function bsm(S, K, T, r, q, s) {
    const d1 = (Math.log(S / K) + (r - q + s * s / 2) * T) / (s * Math.sqrt(T)), d2 = d1 - s * Math.sqrt(T);
    const call = S * Math.exp(-q * T) * N(d1) - K * Math.exp(-r * T) * N(d2), put = K * Math.exp(-r * T) * N(-d2) - S * Math.exp(-q * T) * N(-d1);
    return { d1, d2, call, put, dC: Math.exp(-q * T) * N(d1), dP: -Math.exp(-q * T) * N(-d1), gamma: Math.exp(-q * T) * npdf(d1) / (S * s * Math.sqrt(T)), vega: S * Math.exp(-q * T) * npdf(d1) * Math.sqrt(T) / 100, thetaC: (-S * Math.exp(-q * T) * npdf(d1) * s / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * N(d2) + q * S * Math.exp(-q * T) * N(d1)) / 365, pQ: N(d2) };
  }

  // ── run the model at any as-of week index ────────────────────────────────
  // opts: idx, H, paths, kappaAdj, muAdj (per-company learned), spec (per-stock model), q (dividend yield
  //       subtracted to forecast the exchange price), sentiment, light (skip HMM), cache (Map, reused fits)
  const SPEC_DEFAULT = { vol: "garch", shock: null, window: null, drift: null };
  function specOf(s) { const o = { ...SPEC_DEFAULT, ...(s || {}) }; return { vol: o.vol, shock: o.shock || P.sim.method, window: o.window || P.data.window, drift: o.drift || null }; }
  function analyse(c, opts = {}) {
    const idx = opts.idx ?? c.wk.length - 1, H = opts.H ?? 52, paths = opts.paths ?? P.sim.paths, sp = specOf(opts.spec);
    const p = c.wk.slice(Math.max(0, idx - sp.window), idx + 1);
    if (p.length < P.data.minHistory) return null;
    // c.wk is adjusted for dividends and corporate actions; the forecast is expressed at the exchange price of the as-of date
    const date = c.wd[idx], px = c.wkRaw ? c.wkRaw[idx] : c.wk[idx], scale = px / c.wk[idx], r = returns(p);
    const kAdj = opts.kappaAdj ?? 1, kappa = (opts.kappa ?? kappaFor(H)) * kAdj;
    const ck = opts.cache ? `${c.id}|${idx}|${sp.window}|` : null, memo = (k, f) => { if (!ck) return f(); const key = ck + k; if (!opts.cache.has(key)) opts.cache.set(key, f()); return opts.cache.get(key); };
    const G = memo(sp.vol, () => volModel(r, sp.vol, c.wkVar ? c.wkVar.slice(Math.max(0, idx - sp.window) + 1, idx + 1) : null)), rw = memo("rw", () => rwTests(r)), tech0 = memo("tech", () => technicals(p)), reg = opts.light ? null : hmm(r);
    const tech = scale === 1 ? tech0 : { ...tech0, s50: tech0.s50 * scale, s200: tech0.s200 * scale, hi: tech0.hi * scale, lo: tech0.lo * scale };
    const vol = clamp(G.vH(H) * kappa, P.vol.floor, P.vol.cap);
    const F = fundAt(c, date), fv = fairValue(c, px, F, vol), S = driftSignals(c, px, vol, fv, tech, rw, r, opts.sentiment, opts.spec, p, H, opts.allSignals || !!opts.weights);
    const dr = opts.weights ? weighted(S.sig, opts.weights) : combine(S.sig, true), muAdj = opts.muAdj ?? 0, mu = clamp(dr.mu + muAdj, P.drift.clampLo, P.drift.clampHi);
    // μ is a total-return drift; the exchange price grows at μ − q when the dividend yield q is paid out (Merton 1973)
    const q = opts.q ?? 0, muP = mu - q;
    const mc = simulate(`${c.id}|${date}|${H}`, px, muP, G, H, paths, kappa, sp.shock);
    const M = P.market[c.mk], bs = bsm(px, px, 0.25, M.rf, (c.dy || 0) / 100, vol);
    const A = { c, idx, date, px, H, r, G, rw, tech, reg, vol, kappa, kAdj, muAdj, F, fv, sig: S.sig, beta: S.beta, dr: { ...dr, mu, base: dr.mu }, q, mc, bs, spec: sp, specCustom: !!opts.spec,
      ito: { mu: muP, sigma: vol, drag: vol * vol / 2, logDrift: muP - vol * vol / 2, mean: px * Math.exp(muP * H / 52), median: px * Math.exp((muP - vol * vol / 2) * H / 52) } };
    if (reg) { A.F6 = factors(c, A); A.score = score(A.F6); A.label = label(A.score); }
    return A;
  }

  function factors(c, A) {
    const F = {}, pe = A.F.eps > 0 ? A.px / A.F.eps : null, roe = A.F.bvps && A.F.eps ? A.F.eps / A.F.bvps : null, rf = P.market[c.mk].rf;
    const lastNp = last(A.F.np.filter(x => x != null)), lastRev = last(A.F.rev.filter(x => x != null)), npm = lastNp != null && lastRev ? lastNp / lastRev : null;
    const vRaw = 0.65 * lin(A.fv.up, -0.4, 0.6) + 0.35 * (pe ? lin(-pe, -60, -8) : 25);
    F.value = { s: A.fv.conf === "Medium" ? vRaw : 0.5 * vRaw + 25, in: [["Upside to fair value", A.fv.fv ? A.fv.up : null, "pct"], ["P/E", pe, "x"]] };
    F.quality = { s: (lin(roe ?? 0, 0, 0.35) + lin(-(c.de ?? 1), -2, 0) + lin(npm ?? 0, 0, 0.4)) / 3, in: [["ROE", roe, "pct"], ["Debt / equity", c.de, "x"], ["Net margin", npm, "pct"]] };
    const gr = cagr(A.F.rev, 3);
    F.growth = { s: lin(gr ?? 0, -0.1, 0.3), in: [["Revenue growth (3 yr)", gr, "pct"]] };
    const sh = (A.dr.mu - rf) / A.vol;
    F.edge = { s: 0.5 * lin(sh, -0.4, 0.8) + 0.5 * lin(A.mc.pUp, 0.35, 0.70), in: [["Sharpe (μ − rf)/σ", sh, "x"], ["P(up)", A.mc.pUp, "pp"]] };
    const T = A.tech;
    F.trend = { s: (lin(T.above200, -0.25, 0.25) + (T.macdHist > 0 ? 70 : 30) + (T.rsi < 30 ? 65 : T.rsi > 70 ? 35 : 50 + (T.rsi - 50) * 0.5)) / 3, in: [["Price vs 200-day avg", T.above200, "pct"], ["MACD histogram", T.macdHist, "num"], ["RSI", T.rsi, "num"]] };
    F.safety = { s: (lin(-A.vol, -0.75, -0.15) + lin(-A.mc.cvar95, -0.6, -0.1) + 100 * A.reg.pCalmNext) / 3, in: [["Volatility", A.vol, "pp"], ["CVaR 95%", A.mc.cvar95, "pp"], ["P(calm regime)", A.reg.pCalmNext, "pp"]] };
    return F;
  }
  function score(F, W = P.score.weights) { let s = 0, w = 0; for (const k in W) { s += F[k].s * W[k]; w += W[k]; } return s / w; }
  function label(s) { return s >= 68 ? ["Strong", "s5"] : s >= 57 ? ["Favourable", "s4"] : s >= 45 ? ["Neutral", "s3"] : s >= 34 ? ["Weak", "s2"] : ["Poor", "s1"]; }

  // ── 90-trading-day ladder: one forecast for every trading day ahead ─────
  // Daily GARCH(1,1) on adjusted daily log returns (3 years), filtered historical simulation, Itô drift.
  // The drift comes from the weekly model at the same as-of date (the stock's spec, learned weights, minus dividend
  // yield q). Per-stock horizon factors κ(h) rescale log-distances from the median (learned out of sample).
  const LB = [[1, 5], [6, 20], [21, 60], [61, 90]];
  const bucketOf = h => LB.findIndex(([a, b]) => h >= a && h <= b);
  function ladder(c, o = {}) {
    const j = o.j ?? c.dA.length - 1, N = o.H ?? 90, paths = o.paths ?? 4000;
    const p = c.dA.slice(Math.max(0, j - (o.window ?? 750)), j + 1); if (p.length < 250) return null;
    const r = returns(p), G = o.G || garch(r), px = c.dR ? c.dR[j] : c.dA[j], mu = o.mu ?? 0.08;
    const u = rng(hash(`${c.id}|L|${c.dd[j]}`)), zp = G.z, nz = zp.length, at = Array.from({ length: N }, () => new Float64Array(paths));
    for (let k = 0; k < paths; k++) {
      let lnS = 0, h = G.hNext;
      for (let t = 0; t < N; t++) { const e = Math.sqrt(h) * zp[(u() * nz) | 0] * (u() < 0.5 ? -1 : 1); lnS += mu / 252 - h / 2 + e; h = G.omega + G.alpha * e * e + G.beta * h; at[t][k] = lnS; }
    }
    const kap = o.kappa || [1, 1, 1, 1], q = (s, x) => s[Math.min(s.length - 1, Math.max(0, Math.floor(x * s.length)))];
    const rows = at.map((a, t) => {
      const s = a.sort(), m = q(s, 0.5), k = kap[bucketOf(t + 1)] ?? 1, f = x => px * Math.exp(m + (x - m) * k);
      let up = 0; for (const x of s) if (m + (x - m) * k > 0) up++;
      return { h: t + 1, p05: f(q(s, 0.05)), p25: f(q(s, 0.25)), p50: px * Math.exp(m), p75: f(q(s, 0.75)), p95: f(q(s, 0.95)), pUp: up / paths };
    });
    return { date: c.dd[j], j, px, mu, dailyVol: Math.sqrt(G.hNext), annVol: Math.sqrt(G.hNext * 252), garch: { alpha: G.alpha, beta: G.beta, persist: G.persist }, rows };
  }

  // ── evaluation & scoring rules ───────────────────────────────────────────
  // interval score for the 90% band (Gneiting & Raftery 2007): lower = better, rewards narrow + correct
  function intervalScore(lo, hi, y, alpha = 0.1) { return (hi - lo) + (2 / alpha) * Math.max(0, lo - y) + (2 / alpha) * Math.max(0, y - hi); }
  function evaluate(c, i0, i1, o = {}) {
    const H = i1 - i0; if (H < 1) return null;
    const A = analyse(c, { idx: i0, H, paths: o.paths ?? 2000, kappaAdj: o.kappaAdj, muAdj: o.muAdj, sentiment: o.sentiment, spec: o.spec, cache: o.cache, light: true }); if (!A) return null;
    // outcome on the same basis as the forecast: total-return value of one share bought at the as-of exchange price
    const actual = c.wk[i1] * A.px / c.wk[i0], pit = percentileOf(A.mc.sorted, actual);
    return { id: c.id, d0: c.wd[i0], d1: c.wd[i1], H, p0: A.px, actual, median: A.mc.median, p05: A.mc.p05, p25: A.mc.p25, p75: A.mc.p75, p95: A.mc.p95, pUp: A.mc.pUp, pit,
      in50: actual >= A.mc.p25 && actual <= A.mc.p75, in90: actual >= A.mc.p05 && actual <= A.mc.p95, dirHit: (A.mc.pUp >= 0.5) === (actual >= A.px), err: A.mc.median / actual - 1,
      logErr: Math.log(actual / A.mc.median), brier: (A.mc.pUp - (actual > A.px ? 1 : 0)) ** 2, iscore: intervalScore(A.mc.p05, A.mc.p95, actual) / A.px,
      qscore: quantileScore([[0.05, A.mc.p05], [0.25, A.mc.p25], [0.5, A.mc.median], [0.75, A.mc.p75], [0.95, A.mc.p95]], actual) / A.px };
  }
  // mean pinball loss over the stored quantiles ×2 — a discrete approximation of CRPS (Gneiting & Raftery 2007);
  // a proper scoring rule, so it rewards both a correct centre (drift) and a correct spread
  function quantileScore(qs, y) { let s = 0; for (const [t, q] of qs) s += 2 * ((y < q ? 1 : 0) - t) * (q - y); return s / qs.length; }
  // Diebold–Mariano test on loss differences d (positive = candidate better), Newey–West variance with Bartlett weights
  function dmTest(d, lag) {
    const n = d.length; if (n < 8) return { n, mean: n ? mean(d) : 0, t: 0, p: 1 };
    const m = mean(d), g = k => { let s = 0; for (let i = k; i < n; i++) s += (d[i] - m) * (d[i - k] - m); return s / n; };
    let v = g(0); for (let k = 1; k <= lag; k++) v += 2 * (1 - k / (lag + 1)) * g(k);
    const t = m / Math.sqrt(Math.max(v, 1e-18) / n); return { n, mean: m, t, p: 1 - N(t) };
  }
  function summarise(rows) {
    if (!rows.length) return null; const n = rows.length;
    return { n, in50: rows.filter(r => r.in50).length / n, in90: rows.filter(r => r.in90).length / n, dir: rows.filter(r => r.dirHit).length / n, mape: mean(rows.map(r => Math.abs(r.err))), medErr: rows.map(r => Math.abs(r.err)).sort((a, b) => a - b)[Math.floor(n / 2)], brier: mean(rows.map(r => r.brier)), qscore: rows[0].qscore != null ? mean(rows.map(r => r.qscore)) : null, iscore: mean(rows.filter(r => r.iscore != null).map(r => r.iscore)) || null, bias: mean(rows.map(r => r.logErr ?? 0)) };
  }
  // walk-forward backtest over a set of companies
  function backtest(list, o = {}) {
    const rows = [], Hs = o.horizons || [13, 26, 52], step = o.step || 8;
    for (const c of list) for (const H of Hs) for (let i = 60; i + H < c.wk.length; i += step) {
      const e = evaluate(c, i, i + H, { paths: o.paths || 800, ...(o.adj?.[c.id] || {}) }); if (e) rows.push(e);
    }
    return { rows, sum: summarise(rows) };
  }

  return { DEFAULT_PARAMS, setParams, getParams, get P() { return P; }, kappaFor, analyse, evaluate, quantileScore, dmTest, specOf, ouFit, volModel, tDof, harRV, ladder, LB, bucketOf, garch, summarise, backtest, intervalScore, score, label, factors, bsm, N, clamp, lin, mean, sd, cagr, idxAtOrBefore, idxAtOrAfter, percentileOf, fundAt };
})();
if (typeof module !== "undefined") module.exports = Q;
