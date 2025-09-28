// js/ui/dom.js
(function(){
  window.UI = window.UI || {};
  const $ = (id) => document.getElementById(id);

  function status(el, msg, err=false){
    if(!el) return;
    el.textContent = msg || "";
    el.classList.toggle("danger", !!err);
  }

  function renderTable(rows){
    const tb = $("grid")?.querySelector("tbody");
    if(!tb) return;
    tb.innerHTML = (rows||[]).map(r => `
      <tr>
        <td>${r.name}</td><td>${r.set_name}</td><td>${r.set_code || ""}</td>
        <td>${r.rarity}</td><td>${r.condition || ""}</td>
        <td>${r.qty}</td><td>${r._sent ? "✅" : "—"}</td>
      </tr>`).join("");
  }

  function showResume(show){
    const btn = $("resumeBtn"); if(!btn) return;
    btn.style.display = show ? "" : "none";
  }

  window.UI.$ = $;
  window.UI.status = status;
  window.UI.renderTable = renderTable;
  window.UI.showResume = showResume;
})();