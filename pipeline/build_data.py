"""Turn data/core.json (+ peers) into data.js for the page. Every figure keeps its source URL."""
import json, re, pathlib, datetime
D = pathlib.Path(__file__).resolve().parent.parent
core = None
peers = json.loads((D / "data/src/peers.json").read_text()) if (D / "data/src/peers.json").exists() else {}
# Your stock list and per-company notes live in data/watchlist.json (private; see pipeline/watchlist.example.json)
_wl = D / "data/watchlist.json"
WL = json.loads((_wl if _wl.exists() else D / "pipeline/watchlist.example.json").read_text())
CORE_IDS = WL["india"] + list(WL["other"].keys())
MK = WL.get("market", {})
CYC = set(WL.get("cyclical", []))
NOTES = WL.get("notes", {})


def num(s):
    if s in (None, "", "n/a", "-"): return None
    s = str(s).replace(",", "").replace("%", "").replace("$", "").replace("₩", "").strip()
    m = re.match(r"^[-+]?[\d.]+", s)
    if not m: return None
    v = float(m.group(0)); suf = s[m.end():].strip()[:1]
    return v * {"T": 1e12, "B": 1e9, "M": 1e6, "K": 1e3}.get(suf, 1)

def last_n(arr, n): return arr[-n:] if arr else arr
MONTHS = "January February March April May June July August September October November December".split()


def build(k, d, mk=None, peer=None):
    """One company object from a full screener.in / stockanalysis.com fetch (also used by the Finder on demand)."""
    MKk = mk or MK.get(k, "US")
    if peer is None: peer = peers.get(k)
    if d.get("market") == "IN" or mk == "IN":
        wd = [x[0] for x in d["wk"]]; wk = [x[1] for x in d["wk"]]
        f = d["fin"]; n = 7
        y = last_n(f["y"], n)
        bs = d["bs"]; eqv = [(a or 0) + (b or 0) for a, b in zip(bs["eq"] or [], bs["res"] or [])]
        shares_now = d["mcap_cr"] / d["price"] if d["mcap_cr"] and d["price"] else None   # crore shares
        # book value per share history: (equity + reserves) / shares; shares from net profit / EPS when reliable
        bv_y, bv_v = [], []
        for i, lab in enumerate(bs["y"] or []):
            if i >= len(eqv): break
            sh = None
            if lab in (f["y"] or []):
                j = f["y"].index(lab); npj = (f["np"] or [None])[j] if f["np"] else None; ej = (f["eps"] or [None])[j] if f["eps"] else None
                if npj and ej and abs(ej) > 0.05 and npj / ej > 0: sh = npj / ej
            sh = sh or shares_now
            if sh: bv_y.append(lab); bv_v.append(round(eqv[i] / sh, 3))
        debt = (bs["debt"] or [None])[-1]; eq_last = eqv[-1] if eqv else None
        c = {"id": k, "nm": d["name"].replace(" Ltd", "").replace(" Co ", " Co. "), "tk": k, "ex": "NSE", "mk": "IN", "cur": "₹", "src": d["src"],
             "sector": ((peer or {}).get("industry") or [None])[-1], "px": wk[-1], "chg": round((wk[-1] / wk[-2] - 1) * 100, 2),
             "asof": "NSE close, " + datetime.date.fromisoformat(wd[-1]).strftime("%d %b %Y"),
             "mcap": f"₹{d['mcap_cr']:,.0f} Cr", "mcapUSD": d["mcap_cr"] * 1e7 / 88, "pe": d["pe"], "bv": d["bv"], "pb": round(wk[-1] / d["bv"], 2) if d["bv"] else None,
             "roe": d["roe"], "roce": d["roce"], "dy": d["dy"], "hi": d["hi52"], "lo": d["lo52"], "de": round(debt / eq_last, 2) if debt is not None and eq_last else None,
             "fin": {"y": y, "rev": last_n(f["rev"], n), "np": last_n(f["np"], n), "eps": last_n(f["eps"], n), "opm": last_n(f["opm"], n), "u": "₹ Cr", "d": 1},
             "cfo": {"y": last_n(d["cf"]["y"], 6), "v": last_n(d["cf"]["cfo"], 6)}, "bvpsH": {"y": bv_y, "v": bv_v},
             "fyEndMonth": 3, "shp": d.get("shp"), "fpos": d.get("pros", []), "fneg": d.get("cons", []),
             "news": [], "docs": [{"t": r["title"], "u": r["url"]} for r in d.get("reports", [])] + [{"t": "Full financials on screener.in", "u": d["src"]}, {"t": "NSE quote page", "u": f"https://www.nseindia.com/get-quotes/equity?symbol={k}"}],
             "wd": wd, "wk": wk, "peers": peer}
        for a in d.get("announcements", [])[:7]:
            t = a["title"]; m = re.search(r"\s(\d{1,2}) ([A-Z][a-z]{2})\s+-\s+(.*)$", t)
            if m:
                mon = "JanFebMarAprMayJunJulAugSepOctNovDec".index(m.group(2)) // 3 + 1
                yr = 2026 if mon <= 10 else 2025
                c["news"].append({"t": m.group(3).strip(), "d": f"{int(m.group(1))} {m.group(2)} {yr}", "u": a["url"], "s": "BSE filing"})
            else:
                c["news"].append({"t": re.sub(r"\s+", " ", t), "d": "", "u": a["url"], "s": "BSE filing"})
    else:
        st = d["stats"]; g = lambda key: num(st.get(key))
        wd = [x[0] for x in d["wk"]]; wk = [x[1] for x in d["wk"]]
        f = d.get("fin") or {}
        order = list(range(len(f.get("y", []))))[::-1]                       # oldest → newest
        y = [f["y"][i] for i in order]
        rev = [f["rev"][i] for i in order] if f.get("rev") else None
        npv = [f["np"][i] for i in order] if f.get("np") else None
        op = [f["op"][i] for i in order] if f.get("op") else None
        shares = g("Shares Outstanding"); px = d["price"] or wk[-1]; pe = g("PE Ratio"); pb = g("PB Ratio")
        unit = (f.get("unit") or "")
        cur_fin = re.search(r"(USD|TWD|KRW)", unit); cur_fin = cur_fin.group(1) if cur_fin else "USD"
        scale = 1e6 if "millions" in unit else 1e3 if "thousands" in unit else 1e9 if "billions" in unit else 1e6
        # EPS history = net income / shares, rescaled so the latest value equals price / P/E (handles ADR ratio & FX)
        s_eps = 1.0
        if pe and npv and npv[-1] and shares: s_eps = (px / pe) / (npv[-1] * scale / shares)
        elif npv and shares and cur_fin != "USD" and MKk == "TW": s_eps = 5 / 32.0
        eps = [round(v * scale / shares * s_eps, 4) if v is not None and shares else None for v in npv] if npv else None
        bh = d.get("bvps_hist") or {}
        b_order = list(range(len(bh.get("y", []))))[::-1]
        b_y = [bh["y"][i] for i in b_order]; b_v = [bh["v"][i] for i in b_order] if bh.get("v") else []
        if pb and b_v and b_v[-1]: sb = (px / pb) / b_v[-1]; b_v = [round(v * sb, 4) if v is not None else None for v in b_v]
        prof = d.get("profile") or {}
        fy = prof.get("fy") or "January - December"; endm = fy.split("-")[-1].strip()
        fin_units = {"USD": "$", "TWD": "NT$", "KRW": "₩"}[cur_fin]
        div = 1000 if cur_fin in ("USD", "TWD") else 1e6
        c = {"id": k, "nm": d["name"].replace(" Corporation", "").replace(", Inc.", "").replace(" Inc.", "").replace(" Limited", "").replace(" Co., Ltd.", "").strip(), "tk": k,
             "ex": {"TW": "NYSE (ADR)", "KR": "KRX"}.get(MKk, (prof.get("industry") and "NYSE/Nasdaq") or "US"), "mk": MKk, "cur": "₩" if MKk == "KR" else "$", "src": d["src"],
             "sector": prof.get("industry"), "px": px, "chg": d.get("chg"), "asof": d.get("asof") or "",
             "mcap": ("₩" if MKk == "KR" else "$") + st.get("Market Cap", ""), "mcapUSD": (g("Market Cap") or 0) / (1400 if MKk == "KR" else 1),
             "pe": pe, "fpe": g("Forward PE"), "pb": pb, "bv": round(px / pb, 3) if pb else None, "roe": g("Return on Equity (ROE)"), "roic": g("Return on Invested Capital (ROIC)"),
             "de": g("Debt / Equity"), "gm": g("Gross Margin"), "om": g("Operating Margin"), "npm": g("Profit Margin"), "dy": g("Dividend Yield") or 0, "beta": g("Beta (5Y)"),
             "ch52": g("52-Week Price Change"), "tgt": g("Price Target"), "cons": st.get("Analyst Consensus"), "emp": st.get("Employee Count") or prof.get("employees"),
             "fin": {"y": y, "rev": rev, "op": op, "np": npv, "eps": eps, "u": f"{fin_units} {'B' if div == 1000 else 'T'}", "d": div},
             "bvpsH": {"y": b_y, "v": b_v}, "fyEndMonth": MONTHS.index(endm) + 1 if endm in MONTHS else 12,
             "news": [{"t": n["title"], "d": n["time"][:12].rstrip(","), "u": n["url"], "s": n["source"]} for n in d.get("news", [])[:7]],
             "docs": ([{"t": "SEC filings (10-K, 10-Q, 8-K)", "u": f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={k}&type=&dateb=&owner=include&count=40"}] if MKk != "KR" else [{"t": "Korea DART filings", "u": "https://dart.fss.or.kr/"}])
                     + ([{"t": "Investor relations (" + prof["website"] + ")", "u": "https://" + prof["website"]}] if prof.get("website") else []) + [{"t": "Key statistics on stockanalysis.com", "u": d["src"]}],
             "profile": {k2: prof.get(k2) for k2 in ("ceo", "employees", "founded", "ipo", "industry", "sector", "website", "fy", "country", "src")},
             "wd": wd, "wk": wk}
    c["cyc"] = k in CYC
    c.update(NOTES.get(k, {}))   # per-company notes and flags from the private watchlist
    return c

if __name__ == "__main__":
  core = json.loads((D / "data/core.json").read_text())
  out = [build(k, core[k]) for k in CORE_IDS]

  asof = {"collected": core["_collected"], "india": next(c["asof"] for c in out if c["mk"] == "IN"), "us": next((c["asof"] for c in out if c["mk"] in ("US", "TW")), None), "kr": next((c["asof"] for c in out if c["mk"] == "KR"), None)}
  (D / "data/companies.json").write_text(json.dumps({"asof": asof, "companies": out}, ensure_ascii=False, separators=(",", ":")))
  if False: (D / "data.js").write_text("// Generated by pipeline/build_data.py from data/core.json — do not edit by hand.\nconst ASOF = " + json.dumps(asof) + ";\nconst CORE = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\nif (typeof module !== 'undefined') module.exports = { CORE, ASOF };\n")
  print("wrote", len(out), "companies,", (D / "data/companies.json").stat().st_size, "bytes")
  for c in out: print(c["id"], c["px"], c["chg"], c["pe"], c["pb"], c["fin"]["y"][-3:], (c["fin"]["eps"] or [])[-3:], c["bvpsH"]["v"][-2:] if c["bvpsH"]["v"] else None, len(c["wk"]), c["asof"])
