"""Compact data/universe.json -> universe.json (published next to the page, loaded by the Finder)."""
import json, pathlib, datetime, re
D = pathlib.Path(__file__).resolve().parent.parent
u = json.loads((D / "data/universe.json").read_text())
def num(s):
    if s in (None, "", "n/a", "-"): return None
    s = str(s).replace(",", "").replace("$", "").strip(); m = re.match(r"^-?[\d.]+", s)
    if not m: return None
    v = float(m.group(0)); return v * {"T": 1e12, "B": 1e9, "M": 1e6, "K": 1e3}.get(s[m.end():].strip()[:1], 1)
def r4(x): return None if x is None else float(f"{x:.5g}")
out = {}
for k, d in u["items"].items():
    if not d or not d.get("wk") or len(d["wk"]) < 30 or not d.get("px"): continue
    wd = d["wd"]; dd = [(datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days for a, b in zip(wd, wd[1:])]
    f = d.get("fin") or {}
    if k.startswith("IN:"):
        n = 7; y = (f.get("y") or [])[-n:]
        fin = {"y": y, "rev": (f.get("rev") or [])[-n:] or None, "np": (f.get("np") or [])[-n:] or None, "eps": (f.get("eps") or [])[-n:] or None}
        chg = None
        if len(wd) > 1 and dd[-1] <= 4: chg = round((d["wk"][-1] / d["wk"][-2] - 1) * 100, 2)
        rec = {"n": d["n"].replace(" Ltd", ""), "src": d["src"], "px": d["px"], "chg": chg, "mcap": f"₹{d['mcap']:,.0f} Cr" if d.get("mcap") else None, "mcapN": d["mcap"] * 1e7 / 88 if d.get("mcap") else 0,
               "pe": d.get("pe"), "bv": d.get("bv"), "dy": d.get("dy"), "roe": d.get("roe"), "roce": d.get("roce"), "hi": d.get("hi"), "lo": d.get("lo"), "sec": d.get("sec"), "about": (d.get("about") or "")[:400],
               "de": round(d["debt"] / d["eqv"], 2) if d.get("debt") is not None and d.get("eqv") else None, "fin": fin}
    else:
        ys = f.get("y") or []; order = list(range(len(ys)))[::-1]
        pick = lambda key: [f[key][i] for i in order] if f.get(key) else None
        mc = num(d.get("mcap"))
        rec = {"n": d["n"], "src": d["src"], "px": d["px"], "chg": d.get("chg"), "mcap": "$" + d["mcap"] if d.get("mcap") else None, "mcapN": mc or 0, "pe": d.get("pe"), "fpe": d.get("fpe"), "pb": d.get("pb"),
               "dy": d.get("dy"), "roe": d.get("roe"), "roic": d.get("roic"), "de": d.get("de"), "npm": d.get("npm"), "beta": d.get("beta"), "tgt": d.get("tgt"), "cons": d.get("cons"),
               "fin": {"y": [ys[i] for i in order], "rev": pick("rev"), "np": pick("np")}, "shares": (mc / d["px"]) if mc and d["px"] else None}
    rec.update({"w0": wd[0], "dd": dd, "wk": [r4(x) for x in d["wk"]]})
    out[k] = {kk: vv for kk, vv in rec.items() if vv is not None}
(D / "universe.json").write_text(json.dumps({"collected": u["collected"], "items": out}, ensure_ascii=False, separators=(",", ":")))
print(len(out), "companies", (D / "universe.json").stat().st_size // 1024, "KB")
