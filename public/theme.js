(function () {
  var saved = null;
  try {
    saved = localStorage.getItem("tcd.theme");
  } catch (error) {
  }

  var dark = saved
    ? saved === "dark"
    : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
