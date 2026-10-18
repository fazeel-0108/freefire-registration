/* ==================================================================
   Rules page — one small behaviour: hand the page to the browser's own
   print dialog so a squad can keep a PDF copy of the rules.
   ================================================================== */

(function () {
  var button = document.getElementById("printRules");
  if (!button) return;

  button.addEventListener("click", function () {
    window.print();
  });
})();
