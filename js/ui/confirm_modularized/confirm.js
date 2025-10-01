// confirm.js — shim loader for modularized Confirm UI (supports custom base)
(function () {
  'use strict';

  // Locate this script tag
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var s = scripts[i];
      if (s.src && /(^|\/)confirm\.js(\?|#|$)/.test(s.src)) return s;
    }
    return null;
  })();

  // If you add data-confirm-base on the script tag, it wins
  var explicit = script && script.getAttribute('data-confirm-base');

  // Infer base: folder of this file + "confirm_modularized/"
  var inferredBase = (function () {
    if (!script || !script.src) return 'js/ui/confirm_modularized/';
    var withoutFile = script.src.replace(/[^\/?#]+(?:\?.*)?$/, '');
    return withoutFile.replace(/\/?$/, '/') + 'confirm_modularized/';
  })();

  var base = explicit || inferredBase;

  var files = [
    'selectors.js',
    'utils.js',
    'state.js',
    'recent.js',
    'modal.js',
    'index.js'
  ];

  function loadSequentially(list, cb) {
    var i = 0;
    function next() {
      if (i >= list.length) return cb && cb();
      var s = document.createElement('script');
      s.src = base + list[i++];
      s.defer = true;
      s.onload = next;
      s.onerror = function (e) {
        console.error('[confirm] Failed to load', s.src, e);
        next();
      };
      document.head.appendChild(s);
    }
    next();
  }

  loadSequentially(files, function () {
    console.log('[confirm] modules loaded from', base);
  });
})();