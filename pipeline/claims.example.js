// Shape of the company facts file (data/src/claims.js). Every fact carries a source key that must exist in SRC.
// V[id] = { desc: [text, srcKey], facts: [[label, text, srcKey]], seg: [[text, srcKey]], hist: [[year, text, srcKey]],
//           net: { sup: [[name, note, srcKey]], cus: [...], com: [...], own: [...], pla: [[name, place, note, srcKey]] } }
const SRC = { MSFT: { SA: "https://stockanalysis.com/stocks/msft/company/" } };
const SRCNAME = { SA: "stockanalysis.com company profile" };
const V = { MSFT: { desc: ["Develops software, cloud services and devices.", "SA"], facts: [], seg: [], hist: [], net: { sup: [], cus: [], com: [], own: [], pla: [] } } };
if (typeof module !== "undefined") module.exports = { V, SRC, SRCNAME };
