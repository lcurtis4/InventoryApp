// branchBadge.js (#58) — show the currently-hosted git branch in the header
// badge so you can confirm at a glance which build you're UATing.
//
// How it works (simplest possible route, no backend / no build step):
//   The app is served from the project root, so `.git/HEAD` is reachable over
//   HTTP. That file is plain text — either:
//       ref: refs/heads/<branch>      (on a branch)
//   or a bare 40-char SHA             (detached HEAD).
//   We fetch it at load, parse the branch name, and write it into .ver-badge.
//
// Fallbacks (badge keeps its static version text if any of these happen):
//   • .git/HEAD not served (e.g. deployed without the .git folder)
//   • detached HEAD (shows short SHA instead)
//   • any fetch/parse error
(function () {
  "use strict";

  function applyBadge(label, title) {
    var el = document.querySelector(".ver-badge");
    if (!el) return;
    el.textContent = label;
    if (title) el.setAttribute("title", title);
  }

  function parseHead(text) {
    var t = (text || "").trim();
    var m = t.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) return { kind: "branch", value: m[1] };
    if (/^[0-9a-f]{7,40}$/i.test(t)) return { kind: "detached", value: t.slice(0, 7) };
    return null;
  }

  function init() {
    // Keep the static version as the fallback (already in the DOM).
    fetch(".git/HEAD", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HEAD " + res.status);
        return res.text();
      })
      .then(function (text) {
        var head = parseHead(text);
        if (!head) return; // leave version fallback in place
        if (head.kind === "branch") {
          applyBadge(head.value, "Hosted branch: " + head.value);
        } else {
          applyBadge("@" + head.value, "Detached HEAD @ " + head.value);
        }
      })
      .catch(function () {
        // Silent — .git not served (prod) or unreadable; keep version text.
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
