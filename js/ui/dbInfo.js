// dbInfo.js (#53) — surface the local Card DB's freshness in the footer.
//
// Shows, in one unobtrusive line:
//   • DB version      (manifest.version, a YYYY-MM-DD snapshot date)
//   • card count      (manifest.count)
//   • last updated    (state.lastSuccessAt, else manifest.builtAt) as relative time
//   • a subtle ⚠ warning when the most recent refresh FAILED (state.lastFailureAt
//     newer than lastSuccessAt) so the user knows they're on last-good data.
//
// Data comes from the existing CardDb API (no new storage):
//   CardDb.ready()        — resolves when the DB is loaded (warmed on boot)
//   CardDb.manifest()     — { version, builtAt, count, sha256 } (#53)
//   CardDb.refreshState() — { lastSuccessAt, lastFailureAt, lastFailureVersion, ... }
(function () {
  "use strict";

  var EL_ID = "dbInfo";

  function el() { return document.getElementById(EL_ID); }

  // "2026-05-30" → "May 30, 2026". Falls back to the raw string if unparseable.
  function fmtVersion(v) {
    if (!v) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
    if (!m) return String(v);
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // ISO/epoch → "just now" / "5 min ago" / "3 days ago", else absolute date.
  function fmtRelative(iso) {
    if (!iso) return "";
    var then = new Date(iso).getTime();
    if (isNaN(then)) return "";
    var secs = Math.floor((Date.now() - then) / 1000);
    if (secs < 0) secs = 0;
    if (secs < 60) return "just now";
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + " min ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hrs / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    return new Date(then).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function fmtCount(n) {
    var num = Number(n);
    if (!isFinite(num) || num <= 0) return "";
    return num.toLocaleString();
  }

  // True when a refresh failure is newer than the last success → stale data.
  function refreshFailed(state) {
    if (!state || !state.lastFailureAt) return false;
    var fail = new Date(state.lastFailureAt).getTime();
    if (isNaN(fail)) return false;
    var ok = state.lastSuccessAt ? new Date(state.lastSuccessAt).getTime() : 0;
    if (isNaN(ok)) ok = 0;
    return fail > ok;
  }

  function render(manifest, state) {
    var node = el();
    if (!node) return;
    manifest = manifest || {};
    state = state || {};

    var version = manifest.version || "";
    if (!version) {
      node.textContent = "Card DB: unavailable";
      node.classList.remove("db-info--warn");
      return;
    }

    var parts = ["Card DB " + fmtVersion(version)];
    var cnt = fmtCount(manifest.count);
    if (cnt) parts.push(cnt + " cards");

    var updatedIso = state.lastSuccessAt || manifest.builtAt || "";
    var rel = fmtRelative(updatedIso);
    if (rel) parts.push("updated " + rel);

    node.textContent = parts.join(" · ");
    node.title = "Local Yu-Gi-Oh card database — version " + version +
      (manifest.builtAt ? " (built " + manifest.builtAt + ")" : "");

    if (refreshFailed(state)) {
      var staleFrom = state.lastFailureVersion || version;
      node.textContent += "  ⚠ last refresh failed — showing last-good data from " + fmtVersion(staleFrom);
      node.classList.add("db-info--warn");
      if (state.lastFailureReason) {
        node.title += " · last refresh failed: " + state.lastFailureReason;
      }
    } else {
      node.classList.remove("db-info--warn");
    }
  }

  function init() {
    var node = el();
    if (!node) return;
    if (!window.CardDb || typeof window.CardDb.ready !== "function") {
      node.textContent = "Card DB: unavailable";
      return;
    }
    window.CardDb.ready()
      .then(function () {
        return Promise.all([
          typeof window.CardDb.manifest === "function" ? window.CardDb.manifest() : null,
          typeof window.CardDb.refreshState === "function" ? window.CardDb.refreshState() : null,
        ]);
      })
      .then(function (res) {
        render(res[0], res[1]);
      })
      .catch(function (e) {
        var n = el();
        if (n) n.textContent = "Card DB: unavailable";
        console.warn("[dbInfo] could not read CardDb state:", e && e.message);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
