// Optional local LLM via Ollama (free, runs on this Mac). Used ONLY for reading text:
// labelling news headlines and answering questions from KUBER's own verified data.
// It never produces prices, ratios or forecasts.
import { all, run, now, log, getSetting } from "./db.mjs";
const BASE = "http://127.0.0.1:11434";

export async function status() {
  try {
    const r = await fetch(BASE + "/api/tags", { signal: AbortSignal.timeout(2000) });
    const j = await r.json(), models = (j.models || []).map(m => m.name);
    return { running: true, models, model: pickModel(models) };
  } catch { return { running: false, models: [], model: null }; }
}
function pickModel(models) {
  const want = getSetting("llm.model");
  if (want && models.includes(want)) return want;
  return models.find(m => /qwen2\.5:7b/.test(m)) || models.find(m => /qwen2\.5|llama3|mistral|phi|gemma/.test(m)) || models[0] || null;
}
async function generate(model, prompt, json = false, timeoutMs = 120000) {
  const r = await fetch(BASE + "/api/generate", { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, prompt, stream: false, format: json ? "json" : undefined, options: { temperature: 0, num_ctx: 8192 } }) });
  if (!r.ok) throw new Error("LLM HTTP " + r.status);
  return (await r.json()).response;
}

// label up to `limit` unscored headlines
export async function scoreNews(companyName, limit = 25) {
  const st = await status(); if (!st.running || !st.model) return { scored: 0, reason: "Ollama is not running" };
  const rows = all("SELECT * FROM news WHERE scored_at IS NULL ORDER BY published DESC LIMIT ?", limit);
  let n = 0;
  for (const r of rows) {
    const prompt = `You label one financial news headline for an equity research database.
Company: ${companyName(r.cid)} (${r.cid})
Headline: "${r.title}"
Source: ${r.source || "unknown"}

Return JSON only: {"relevant": true|false, "label": "positive"|"negative"|"neutral", "sentiment": number from -1 to 1}
"relevant" is false for routine compliance filings (trading window, certificates, newspaper notices). Judge only what the headline says; do not invent facts.`;
    try {
      const out = JSON.parse(await generate(st.model, prompt, true, 60000));
      const s = Math.max(-1, Math.min(1, Number(out.sentiment) || 0)), lab = ["positive", "negative", "neutral"].includes(out.label) ? out.label : "neutral";
      run("UPDATE news SET sentiment=?, label=?, relevant=?, model=?, scored_at=? WHERE id=?", out.relevant === false ? 0 : s, lab, out.relevant === false ? 0 : 1, st.model, now(), r.id); n++;
    } catch (e) { log("llm", `headline ${r.id}: ${e.message}`); }
  }
  return { scored: n, model: st.model };
}
// point-in-time sentiment: mean of relevant labelled headlines in the 14 days before `date`
export function sentimentAt(cid, date) {
  const d0 = new Date(Date.parse(date) - 14 * 864e5).toISOString().slice(0, 10);
  const r = all("SELECT sentiment FROM news WHERE cid=? AND relevant=1 AND sentiment IS NOT NULL AND published>=? AND published<=?", cid, d0, date);
  return r.length ? r.reduce((a, x) => a + x.sentiment, 0) / r.length : null;
}
export async function ask(context, question) {
  const st = await status(); if (!st.running || !st.model) throw new Error("Ollama is not running");
  const prompt = `You are KUBER's research assistant. Answer using ONLY the DATA below. If the answer is not in the DATA, say "That isn't in KUBER's data." Never invent numbers; quote numbers exactly as given. Do not give buy or sell instructions. Plain English, under 200 words.

DATA:
${JSON.stringify(context)}

QUESTION: ${question}`;
  return { answer: await generate(st.model, prompt, false, 180000), model: st.model };
}
