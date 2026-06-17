(function () {
  try {
    var saved = localStorage.getItem("data-platform-theme");
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = saved || (prefersDark ? "dark" : "light");
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.colorScheme = "light";
  }
}());
