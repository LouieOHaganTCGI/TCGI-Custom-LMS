/* Progressive enhancements (the pages work without them): copy-to-clipboard and print. */
(function () {
  "use strict";
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest ? ev.target.closest("[data-copy],[data-print]") : null;
    if (!t) return;
    if (t.hasAttribute("data-print")) { window.print(); return; }
    var input = document.getElementById(t.getAttribute("data-copy"));
    if (!input) return;
    input.select();
    var done = function () { t.textContent = "Copied"; };
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, function () { document.execCommand("copy"); done(); });
    else { document.execCommand("copy"); done(); }
  });
})();
