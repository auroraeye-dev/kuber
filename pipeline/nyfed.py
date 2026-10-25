"""Read the New York Fed's two official bond files and print JSON for KUBER's engine.

  ACM term premium (Adrian, Crump & Moench), daily: fitted yields, term premia, risk-neutral yields, 1-10 years
    https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls
  Recession probability from the yield curve, monthly (10y - 3m spread, 12-month-ahead probability, NBER dates)
    https://www.newyorkfed.org/medialibrary/media/research/capital_markets/allmonth.xls

Usage: python pipeline/nyfed.py ACM.xls ALLMONTH.xls   (files are downloaded by the engine)
"""
import json
import sys
from datetime import datetime

import xlrd


def iso(v):
    return datetime.strptime(v, "%d-%b-%Y").strftime("%Y-%m-%d")


def num(v):
    return float(v) if isinstance(v, (int, float)) and v == v else None


def acm(path):
    s = xlrd.open_workbook(path).sheet_by_name("ACM Daily")
    h = s.row_values(0)
    col = {k: h.index(k) for k in ("DATE", "ACMY02", "ACMY05", "ACMY10", "ACMTP02", "ACMTP05", "ACMTP10", "ACMRNY10")}
    out = []
    for r in range(1, s.nrows):
        row = s.row_values(r)
        if not row[col["DATE"]]:
            continue
        out.append([iso(row[col["DATE"]])] + [num(row[col[k]]) for k in ("ACMY10", "ACMTP10", "ACMRNY10", "ACMTP02", "ACMTP05")])
    return out


def rec(path):
    s = xlrd.open_workbook(path).sheets()[0]
    h = [str(x).strip() for x in s.row_values(0)]
    i_d, i_s, i_p, i_n = h.index("Date"), h.index("Spread"), h.index("Rec_prob"), h.index("NBER_Rec")
    out = []
    for r in range(1, s.nrows):
        row = s.row_values(r)
        if not row[i_d]:
            continue
        out.append([iso(row[i_d]), num(row[i_s]), num(row[i_p]), num(row[i_n])])
    return out


if __name__ == "__main__":
    print(json.dumps({"acm": acm(sys.argv[1]), "rec": rec(sys.argv[2])}))
