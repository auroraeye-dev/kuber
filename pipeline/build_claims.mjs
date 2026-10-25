// data/src/claims.js -> data/claims.json.
// Rule: Wikipedia supports names, places, relationships and dates only. Every figure
// (money, stakes, capacities, counts) on a Wikipedia-sourced item is rewritten out by hand
// below; the build fails if any figure slips through. Figures shown in KUBER come from
// filings-based sources (screener.in, stockanalysis.com) or exchange price data.
import { createRequire } from "node:module"; import fs from "node:fs";
// Facts live in data/src/claims.js (private: one entry per company you track; see pipeline/claims.example.js)
const require = createRequire(import.meta.url), own = new URL("../data/src/claims.js", import.meta.url);
const { V, SRC, SRCNAME } = require(fs.existsSync(own) ? own.pathname : "./claims.example.js");
const R = fs.existsSync(new URL("../data/src/claims_rewrite.json", import.meta.url)) ? JSON.parse(fs.readFileSync(new URL("../data/src/claims_rewrite.json", import.meta.url), "utf8")) : {};   // hand rewrites of Wikipedia items that carry figures
const isW = k => /^W\d?$/.test(k || ""), FIG = t => /\d/.test(t.replace(/\b(1[89]\d\d|20\d\d)\b/g, "").replace(/\b(Fab|Fabs|Gaudi|A|H|Taj|Hudson Yards|Q|i)\s?\d+[\d, ]*/g, "").replace(/\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/g, "").replace(/\b\d+(st|nd|rd|th|s)\b/g, "").replace(/\b50 Hudson\b/, "").replace(/\b51 Buckingham\b/, "").replace(/\bi54\b/, ""));
let n = 0; const bad = [];
const fix = (t, s) => { if (!isW(s)) return t; if (t in R) { n++; return R[t]; } if (FIG(t)) bad.push(t); return t; };
for (const v of Object.values(V)) {
  v.desc[0] = fix(v.desc[0], v.desc[1]);
  v.facts = v.facts.map(f => [f[0], fix(f[1], f[2]), f[2]]).filter(f => f[1]);
  v.seg = v.seg.map(s => [fix(s[0], s[1]), s[1]]);
  v.hist = v.hist.map(h => [h[0], fix(h[1], h[2]), h[2]]);
  for (const k of Object.keys(v.net)) v.net[k] = v.net[k].map(it => { const pla = k === "pla", src = pla ? it[3] : it[2], o = [...it]; o[0] = fix(it[0], src); if (pla) o[2] = fix(it[2], src); else o[1] = fix(it[1], src); return o; });
}
if (bad.length) { console.error("Figures still present on Wikipedia-sourced items:\n" + bad.join("\n")); process.exit(1); }
fs.writeFileSync(new URL("../data/claims.json", import.meta.url), JSON.stringify({ V, SRC, SRCNAME, rule: "Wikipedia supports names, places, relationships and dates only; figures come from filings-based sources or exchange data." }));
console.log("rewrote", n, "Wikipedia-sourced items; no figures remain on Wikipedia-sourced items");
