// ═════════════════════════════ boot ═════════════════════════════
async function boot() {
  try { const t = localStorage.getItem("kuber.theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
  $("#theme").onclick = () => { const r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; r.dataset.theme = dark ? "light" : "dark"; try { localStorage.setItem("kuber.theme", r.dataset.theme); } catch (e) {} render(); };
  $("#lockb").onclick = async () => { try { await fetch("/api/logout", { method: "POST" }); } catch (e) {} location.replace("/login"); };
  route = parseHash(); bindSearch();
  try { await reload(); } catch (e) { $("#main").innerHTML = `<div class="panel"><div class="body"><h2>The KUBER engine isn't running</h2><p>Open the KUBER app again, or double-click <code>start.command</code> in the KUBER folder.</p><p class="small faint">${esc(e.message)}</p></div></div>`; return; }
  render(); connectLive();   // reload() has started warmAnalyses(), which fills in every score
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
