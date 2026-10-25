"""Synapse data pipeline: pulls verified numbers from screener.in (India) and stockanalysis.com (US/KR/TW ADR).
Every value keeps a source URL. Usage:
  python3 fetch.py core            -> data/core.json      (the 20 tracked companies, full detail)
  python3 fetch.py universe        -> data/universe.json  (NIFTY 500 + S&P 500, for the Finder)
"""
import json, re, sys, time, datetime, pathlib, concurrent.futures as cf
import requests
from bs4 import BeautifulSoup

OUT = pathlib.Path(__file__).resolve().parent.parent / "data"; OUT.mkdir(exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html,application/json"}
S = requests.Session(); S.headers.update(UA)

def get(url, tries=4, **kw):
    for i in range(tries):
        try:
            r = S.get(url, timeout=25, **kw)
            if r.status_code == 200:
                r.encoding = "utf-8"; return r
            if r.status_code in (429, 503): time.sleep(5 * (i + 1)); continue
            return r
        except requests.RequestException:
            time.sleep(2 * (i + 1))
    return None

def num(s):
    if s is None: return None
    s = s.replace(",", "").replace("%", "").replace("₹", "").replace("$", "").strip()
    m = re.match(r"^-?[\d.]+", s)
    if not m: return None
    try: v = float(m.group(0))
    except ValueError: return None
    suf = s[m.end():].strip()[:1]
    return v * {"T": 1e12, "B": 1e9, "M": 1e6, "K": 1e3}.get(suf, 1)

def weekly(points):
    """points: [(iso_date, price)] daily -> last close of each calendar week."""
    out, last = [], None
    for d, p in points:
        dt = datetime.date.fromisoformat(d[:10]); k = dt.isocalendar()[:2]
        if k != last: out.append([d[:10], round(float(p), 4)]); last = k
        else: out[-1] = [d[:10], round(float(p), 4)]
    return out

# ─────────────────────────── screener.in ───────────────────────────
def screener(slug, full=True):
    base = f"https://www.screener.in/company/{slug}/"
    url = base + "consolidated/"; r = get(url)
    if not r or r.status_code != 200: return None
    s = BeautifulSoup(r.text, "html.parser")
    if not s.select_one("#profit-loss table tbody tr td:nth-of-type(2)") or "Consolidated figures are not available" in r.text:
        url = base; r = get(url); s = BeautifulSoup(r.text, "html.parser")
    t = lambda e: e.get_text(" ", strip=True) if e else None
    ratios = {}
    for li in s.select("#top-ratios li"):
        ratios[t(li.select_one(".name"))] = t(li.select_one(".value"))
    def table(sec):
        tb = s.select_one(f"{sec} table")
        if not tb: return None, {}
        hdr = [t(th) for th in tb.select("thead th")][1:]
        rows = {}
        for tr in tb.select("tbody tr"):
            tds = tr.select("td")
            if not tds: continue
            lab = re.sub(r"\s*\+$", "", t(tds[0]) or "").strip()
            rows[lab] = [num(t(td)) for td in tds[1:]]
        return hdr, rows
    plh, pl = table("#profit-loss"); bsh, bs = table("#balance-sheet"); cfh, cfr = table("#cash-flow"); rth, rt = table("#ratios"); shh, sh = table("#quarterly-shp")
    pick = lambda rows, *names: next((rows[k] for k in rows for n in names if k.startswith(n)), None)
    hl = (ratios.get("High / Low") or "").replace("₹", "").split("/")
    cid = s.select_one("[data-company-id]")
    prices = []
    if cid:
        pr = get(f"https://www.screener.in/api/company/{cid['data-company-id']}/chart/?q=Price&days={1900 if full else 1900}")
        try: prices = weekly(pr.json()["datasets"][0]["values"])
        except Exception: prices = []
    prof = s.select_one(".company-profile .about") or s.select_one(".company-profile")
    about = t(prof) or ""
    about = re.sub(r"^About\s*", "", about); about = re.sub(r"\s*\[\d+\]", "", about)
    about = about.split("Key Points")[0].strip()[:600]
    sector = [t(a) for a in s.select("#peers a")][:4]
    d = {
        "src": url, "name": t(s.select_one("h1")), "ticker": slug, "exchange": "NSE", "market": "IN", "cur": "₹",
        "price": num(ratios.get("Current Price")), "mcap_cr": num(ratios.get("Market Cap")), "pe": num(ratios.get("Stock P/E")),
        "bv": num(ratios.get("Book Value")), "dy": num(ratios.get("Dividend Yield")), "roce": num(ratios.get("ROCE")), "roe": num(ratios.get("ROE")),
        "hi52": num(hl[0]) if hl and hl[0] else None, "lo52": num(hl[1]) if len(hl) > 1 else None,
        "sector": sector, "about": about, "wk": prices,
        "fin": {"y": plh, "rev": pick(pl, "Sales", "Revenue"), "op": pick(pl, "Operating Profit", "Financing Profit"), "opm": pick(pl, "OPM", "Financing Margin"),
                "np": pick(pl, "Net Profit"), "eps": pick(pl, "EPS"), "payout": pick(pl, "Dividend Payout")},
        "bs": {"y": bsh, "eq": pick(bs, "Equity Capital"), "res": pick(bs, "Reserves"), "debt": pick(bs, "Borrowings"), "tot": pick(bs, "Total Liabilities")},
        "cf": {"y": cfh, "cfo": pick(cfr, "Cash from Operating"), "fcf": pick(cfr, "Free Cash Flow")},
        "roce_hist": {"y": rth, "v": pick(rt, "ROCE")},
    }
    if sh: d["shp"] = {"date": shh[-1] if shh else None, **{k.replace(" +", ""): v[-1] for k, v in sh.items() if v and v[-1] is not None and k.split()[0] in ("Promoters", "FIIs", "DIIs", "Government", "Public")}}
    if full:
        d["pros"] = [t(li) for li in s.select(".pros li")]; d["cons"] = [t(li) for li in s.select(".cons li")]
        ann = []
        for li in s.select("#company-announcements-tab li, .documents .show-more-box li")[:8]:
            a = li.select_one("a")
            if a and a.get("href", "").startswith("http"):
                ann.append({"title": re.sub(r"\s+", " ", t(a))[:220], "url": a["href"]})
        d["announcements"] = ann
        d["reports"] = [{"title": t(a), "url": a["href"]} for a in s.select(".annual-reports li a") if a.get("href", "").startswith("http")][:3]
    return d

# ─────────────────────────── stockanalysis.com ───────────────────────────
def sa_rows(html):
    s = BeautifulSoup(html, "html.parser"); rows = {}
    for tr in s.select("table tr"):
        tds = [td.get_text(" ", strip=True) for td in tr.select("td,th")]
        if len(tds) >= 2 and tds[0] not in rows: rows[tds[0]] = tds[1:]
    return s, rows

def stockanalysis(path, full=True):
    """path like 'stocks/nvda' or 'quote/krx/000660'"""
    base = f"https://stockanalysis.com/{path}/"
    r = get(base + "statistics/")
    if not r or r.status_code != 200: return None
    _, st = sa_rows(r.text)
    sv = lambda k: num(st.get(k, [None])[0]) if k in st else None
    ov = get(base); ovt = ov.text if ov else ""
    so = BeautifulSoup(ovt, "html.parser")
    price = chg = asof = None
    big = so.select_one("div.text-4xl")
    if big:
        price = num(big.get_text()); par = big.parent.get_text(" ", strip=True)
        m = re.search(r"\(([-+]?[\d.]+)%\)", par); chg = float(m.group(1)) if m else None
        m = re.search(r"(?:At close|Market closed)?:?\s*([A-Z][a-z]{2} \d{1,2}, \d{4}[^A-Za-z]*(?:[AP]M)?\s*[A-Z]{2,4})", par); asof = m.group(1).strip() if m else None
    name = so.select_one("h1").get_text(" ", strip=True) if so.select_one("h1") else path
    news = []
    for m in re.finditer(r'\{url:"([^"]+)",img:"[^"]*",title:"((?:[^"\\]|\\.)*)",text:"(?:[^"\\]|\\.)*",source:"([^"]*)",type:"([^"]*)",tickers:[^,]*,time:"([^"]+)"', ovt):
        u, ti, src, ty, tm = m.groups()
        if not u.startswith("http"): continue
        news.append({"title": ti.replace('\\"', '"'), "url": u, "source": src, "time": tm})
        if len(news) >= 8: break
    d = {"src": base + "statistics/", "name": re.sub(r"\s*\(.*\)$", "", name), "price": price, "chg": chg, "asof": asof, "stats": {k: v[0] for k, v in st.items() if len(v) == 1}, "news": news}
    try:
        j = get(f"https://stockanalysis.com/api/symbol/{'s/' + path.split('/')[-1] if path.startswith('stocks') else 'a/' + '-'.join(path.split('/')[1:])}/history?range=5Y&period=Weekly").json()
        d["wk"] = [[x["t"], x["c"]] for x in reversed(j["data"])]
    except Exception:
        d["wk"] = []
    fr = get(base + "financials/")
    if fr:
        fs = BeautifulSoup(fr.text, "html.parser"); tb = fs.select_one("table")
        if tb:
            trs = tb.select("tr"); hdr = [c.get_text(" ", strip=True) for c in trs[0].select("th,td")][1:]
            def row(label):
                for tr in trs:
                    c = tr.select("th,td")
                    if c and c[0].get_text(" ", strip=True).startswith(label): return [num(x.get_text()) for x in c[1:]]
            d["fin"] = {"y": hdr, "rev": row("Revenue"), "op": row("Operating Income"), "np": row("Net Income"), "eps": row("EPS (Diluted)"), "fcf": row("Free Cash Flow"), "dps": row("Dividend Per Share")}
            m = re.search(r"(?:Financials in|in) (millions|thousands|billions) ([A-Z]{3})", fr.text)
            d["fin"]["unit"] = m.group(0) if m else None
    if full:
        br = get(base + "financials/balance-sheet/")
        if br:
            _, brow = sa_rows(br.text); hdr = brow.get("Fiscal Year", [])
            d["bvps_hist"] = {"y": hdr, "v": [num(x) for x in brow.get("Book Value Per Share", [])]}
        pr = get(base + "company/")
        if pr:
            ps, prow = sa_rows(pr.text)
            desc = ps.find(string=re.compile("Company Description"))
            body = ""
            if desc:
                el = desc.find_parent()
                nxt = el.find_next("p") if el else None
                parts = []
                while nxt and len(" ".join(parts)) < 1400:
                    parts.append(nxt.get_text(" ", strip=True)); nxt = nxt.find_next_sibling("p")
                body = " ".join(parts)
            addr = next((k for k in prow if k.startswith("Address")), None)
            d["profile"] = {"desc": body, "country": prow.get("Country", [None])[0], "founded": prow.get("Founded", [None])[0], "ipo": prow.get("IPO Date", [None])[0],
                            "industry": prow.get("Industry", [None])[0], "sector": prow.get("Sector", [None])[0], "employees": prow.get("Employees", [None])[0], "ceo": prow.get("CEO", [None])[0],
                            "address": addr.replace("Address:", "").strip() if addr else None, "website": prow.get("Website", [None])[0], "fy": prow.get("Fiscal Year", [None])[0],
                            "currency": prow.get("Reporting Currency", [None])[0], "cik": prow.get("CIK Code", [None])[0], "src": base + "company/"}
    return d


def watchlist():
    """Your stock list: data/watchlist.json (private), else the example. NSE tickers under "india"; other stocks map to
    their stockanalysis.com path ("stocks/msft", "quote/krx/000660")."""
    f = OUT / "watchlist.json"
    return json.loads((f if f.exists() else pathlib.Path(__file__).resolve().parent / "watchlist.example.json").read_text())

def core():
    W = watchlist(); CORE_IN, CORE_SA = W["india"], W["other"]
    out = {}
    for s in CORE_IN:
        out[s] = screener(s); print("IN", s, len(out[s]["wk"]) if out[s] else None, flush=True); time.sleep(0.5)
    for k, p in CORE_SA.items():
        out[k] = stockanalysis(p); print("SA", k, len(out[k]["wk"]) if out[k] else None, flush=True); time.sleep(0.5)
    out["_collected"] = datetime.datetime.now().isoformat(timespec="minutes")
    (OUT / "core.json").write_text(json.dumps(out, ensure_ascii=False))

def universe():
    # NIFTY 500 constituents (official NSE list) and S&P 500 (stockanalysis list page)
    nifty = []
    r = get("https://archives.nseindia.com/content/indices/ind_nifty500list.csv") or get("https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv")
    if r and r.status_code == 200:
        for line in r.text.splitlines()[1:]:
            p = line.split(",")
            if len(p) >= 3: nifty.append((p[2].strip(), p[0].strip(), p[1].strip()))
    sp = []
    r = get("https://stockanalysis.com/list/sp-500-stocks/")
    if r:
        for m in re.finditer(r'href="/stocks/([a-z.\-]+)/"', r.text):
            t = m.group(1)
            if t not in sp: sp.append(t)
    print("nifty", len(nifty), "sp", len(sp), flush=True)
    res = {}; done = {"in": 0, "us": 0}
    import threading
    lock = threading.Lock()
    def run_in():
        for sym, name, ind in nifty:
            try:
                d = screener(sym, full=False)
                if d:
                    d["industry"] = ind
                    with lock: res["IN:" + sym] = slim(d, "IN")
            except Exception: pass
            done["in"] += 1
            if done["in"] % 25 == 0: print("in", done["in"], len(res), flush=True)
            time.sleep(1.6)
    def job_us(t):
        try:
            d = stockanalysis("stocks/" + t, full=False)
            if d:
                with lock: res["US:" + t.upper()] = slim(d, "US")
        except Exception: pass
        done["us"] += 1
        if done["us"] % 50 == 0: print("us", done["us"], len(res), flush=True)
    th = threading.Thread(target=run_in); th.start()
    with cf.ThreadPoolExecutor(max_workers=3) as ex: list(ex.map(job_us, sp))
    th.join()
    (OUT / "universe.json").write_text(json.dumps({"collected": datetime.datetime.now().isoformat(timespec="minutes"), "n": len(res), "items": res}, ensure_ascii=False, separators=(",", ":")))
    print("done", len(res))

def slim(d, mk):
    wk = d.get("wk") or []
    if mk == "IN":
        return {"n": d["name"], "src": d["src"], "px": d["price"], "mcap": d["mcap_cr"], "pe": d["pe"], "bv": d["bv"], "dy": d["dy"], "roe": d["roe"], "roce": d["roce"],
                "hi": d["hi52"], "lo": d["lo52"], "sec": (d.get("sector") or [None])[-1] if d.get("sector") else d.get("industry"), "about": d.get("about", "")[:400],
                "fin": d["fin"], "debt": (d["bs"]["debt"] or [None])[-1] if d["bs"]["debt"] else None, "eqv": ((d["bs"]["eq"] or [0])[-1] or 0) + ((d["bs"]["res"] or [0])[-1] or 0) if d["bs"]["eq"] else None,
                "w0": wk[0][0] if wk else None, "wd": [x[0] for x in wk], "wk": [x[1] for x in wk]}
    st = d["stats"]; g = lambda k: num(st.get(k)) if st.get(k) not in (None, "n/a", "-") else None
    return {"n": d["name"], "src": d["src"], "px": d["price"], "chg": d.get("chg"), "mcap": st.get("Market Cap"), "pe": g("PE Ratio"), "fpe": g("Forward PE"), "pb": g("PB Ratio"),
            "dy": g("Dividend Yield"), "roe": g("Return on Equity (ROE)"), "roic": g("Return on Invested Capital (ROIC)"), "de": g("Debt / Equity"), "npm": g("Profit Margin"),
            "beta": g("Beta (5Y)"), "tgt": g("Price Target"), "cons": st.get("Analyst Consensus"), "fin": d.get("fin"),
            "w0": wk[0][0] if wk else None, "wd": [x[0] for x in wk], "wk": [x[1] for x in wk]}

def one(mk, sym):
    """Everything KUBER keeps for a company, fetched on demand (Finder): the same full download and builder as the
    starting companies (shareholding, cash flow, book value history, filings, reports, flags, profile). Prints JSON."""
    if mk == "IN": d = screener(sym, full=True)
    else: d = stockanalysis(("stocks/" + sym.lower()) if mk == "US" else f"quote/krx/{sym}", full=True)
    if not d: print("null"); return
    out = slim(d, "IN" if mk == "IN" else "US")
    try:
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent)); import build_data
        out["built"] = build_data.build(sym, d, mk=mk, peer=None)
    except Exception as e:
        out["buildError"] = str(e)[:300]
    out["collected"] = datetime.datetime.now().isoformat(timespec="minutes")
    print(json.dumps(out, ensure_ascii=False))

if __name__ == "__main__":
    if sys.argv[1] == "one": one(sys.argv[2], sys.argv[3])
    else: {"core": core, "universe": universe}[sys.argv[1]]()
