# KUBER

A personal stock and bond research engine that runs entirely on one Mac. It records live prices, keeps official end-of-day
data, forecasts every tracked stock with stochastic models, scores every forecast when its date arrives, and keeps only the
model changes that beat the standard model on data they never saw.

No numbers are invented: every figure on screen is either official/exchange data with its source, or computed from it by
a method named on the page. It is a research tool, not investment advice.

## What it does

- **Live capture** of NSE, NYSE/Nasdaq and KRX stocks during their sessions, with validation before anything is stored
  (stale quotes, impossible jumps and one-sample bad prints are rejected), a backup source per market when the main one
  goes stale, and an optional cloud collector (Supabase + `pg_cron`) that keeps recording while the Mac is asleep or off.
  The Mac reconciles gaps when it wakes.
- **Official closes**: NSE closes come from the exchange's bhavcopy; US/KRX closes are confirmed after the session.
  A day in progress is never stored as a close.
- **Forecasts** for 1, 4 and 13 weeks and a 90-day daily outlook for every stock, logged every trading day and scored
  automatically (system simulations), alongside your own simulations.
- **Learning**: per stock, alternative models are chosen on older forecasts and kept only if they beat the standard model
  on a later hold-out (Diebold–Mariano test). A tuned and a standard 90-day outlook run side by side; tuning switches off
  automatically if the standard is clearly better.
- **Bond market**: US Treasuries (official curves since 1990) and Indian government bonds (CCIL's official curve), with
  live yields, curve shape, factor decomposition, term premium, a recession signal, volatility ranges with a 30-year
  walk-forward test, bond maths, and each stock's sensitivity to yields.
- **Portfolio risk**: all holdings simulated together with their real correlations and shared crash days, logged and
  scored daily. What-if for a trade before making it, stress tests from the worst real periods and from market and yield
  shocks, and which holding drives the risk.
- **True profit**: charges (contract-note figures or estimates), dividends, the same money in a benchmark, and capital
  gains by financial year (first in, first out).
- **Trade plans**: hold vs stop/target exits vs staged buying on the same simulated paths, after charges and tax.
- **Today**: a daily brief, results and dividend dates, your own alert rules, and a decision journal that saves your
  reason and the forecast at the moment you decided.
- **Honest baselines**: forecasts are also compared with a no-forecast random walk, and model ideas are tested on past
  data without touching the live comparison.
- **Portfolios** per market in their own currency (₹, $, ₩), with amounts hidden until the PIN is entered again.
- **Self-test** after every maintenance run: data invariants per stock, official-close checks, forecast anchoring,
  bond cross-checks and the maths test suite. Failures raise an alert.

## Architecture

| Part | Files | |
|---|---|---|
| Engine | `server/server.mjs` | Local HTTP server on `127.0.0.1:8777` (this Mac only), live stream (SSE), schedulers, PIN lock |
| Storage | `server/db.mjs` | SQLite (Node's built-in `node:sqlite`), WAL mode |
| Market data | `server/market.mjs` | Quotes and daily history with validation, session clocks, adjusted prices |
| Model | `web/model.js` | The stochastic model library; the same code runs in the browser and in the engine |
| Forecasts | `server/engine.mjs` | Logging, scoring, 90-day outlooks, official closes, re-anchoring, learning orchestration |
| Learning | `server/worker.mjs` | Heavy maths in worker threads: backtests, per-stock model selection, calibration |
| Bonds | `server/bonds.mjs`, `bondmath.mjs`, `bondanalysis.mjs` | Sources and cross-checks; pure maths (tested); the analysis |
| Portfolio | `server/portfolio.mjs`, `portmath.mjs` | Joint simulation, what-if, stress, true profit, tax lots, rules, journal, brief; pure maths (tested) |
| Health | `server/health.mjs` | Capture, freshness and data-quality alerts; native notifications |
| Cloud | `server/cloud.mjs`, `data/supabase_*.sql` | Optional backup and the cloud collector |
| Pages | `scripts/app_src/*` → `web/app.js` | Front end, assembled by `scripts/assemble_app.py` |
| Fundamentals | `pipeline/*.py` | screener.in and stockanalysis.com fetchers, data builder, New York Fed file reader |
| Mac app | `native/KUBER.swift` | WKWebView window and notifications |

## Methods

- **Volatility**: GARCH(1,1), EWMA (RiskMetrics), constant, and HAR-RV on realised variance; Rogers–Satchell range
  variance from daily open/high/low.
- **Shocks**: filtered historical simulation (bootstrapped standardised residuals), Student-t, Gaussian.
- **Drift**: CAPM, risk-free, momentum, valuation and Ornstein–Uhlenbeck mean reversion, blended with weights shrunk
  toward CAPM; dividend yield paid out of the price.
- **Scoring**: CRPS-type quantile score, interval score, coverage of 50% / 90% ranges, Diebold–Mariano tests with
  Newey–West variance.
- **Bonds**: Nelson–Siegel–Svensson curves, principal components of curve changes, Diebold–Li level/slope/curvature,
  real-yield/breakeven and expectations/term-premium (ACM) decompositions, the New York Fed's yield-curve recession
  probit, GARCH + filtered historical simulation ranges with a Kupiec coverage test, exact bond repricing, duration,
  convexity, carry and roll-down, and stock rate sensitivities with Newey–West errors.

- **Portfolio**: per-stock GARCH with residuals drawn by date across all stocks (filtered historical simulation), so
  correlation and shared crash days stay as they happened; walk-forward test with Kupiec coverage and Diebold–Mariano
  comparison with a plain bootstrap; variance and tail risk contributions; results-day variance shrunk toward 1.

## Data sources

Exchange and official data: NSE (bhavcopy), US Treasury (par and real yield curves), Federal Reserve (H.15), New York Fed
(fed funds, SOFR, ACM term premium, recession model), CCIL (India zero-coupon curve and tenor-wise yields), RBI (policy
rates, NSE board-meeting dates), Nasdaq (US results dates). Market data: stockanalysis.com, Moneycontrol, CNBC and Yahoo
Finance (backups), screener.in (Indian fundamentals), CNBC (live yields).
Check each source's terms before any use beyond personal research.

## Setup (macOS)

```bash
scripts/setup.sh                                  # Python environment, login services
cp pipeline/watchlist.example.json data/watchlist.json   # then list your own stocks
.venv/bin/python pipeline/fetch.py core && .venv/bin/python pipeline/build_data.py
python3 scripts/assemble_app.py                   # builds web/app.js
node server/server.mjs                            # first run prints your PIN; change it on System → Security
```

Requires Node 24+ and Python 3.11+. Everything you add (orders, notes, prices, forecasts) stays in `data/`, which is
never committed.

## Tests

```bash
node scripts/bondtest.mjs    # bond maths against textbook values, published data and simulations with known answers
node scripts/porttest.mjs    # portfolio maths: known volatility and correlation, hand-worked tax lots and charges
node scripts/selftest.mjs    # data invariants on your own database (read-only)
```
