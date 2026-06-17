export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function setText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value ?? "";
}

export function toast(message, type = "info") {
  const existing = document.querySelector(".notice.toast, .notice.loading");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = `notice ${type} toast`;
  el.textContent = message;
  document.querySelector(".content, .login-card, body").prepend(el);
  setTimeout(() => el.remove(), 7000);
}

export function startProgress(message, { indeterminate = true } = {}) {
  const existing = document.querySelector(".notice.toast, .notice.loading");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "notice loading";
  el.innerHTML = `${escapeHtml(message)}<div class="progress ${indeterminate ? "indeterminate" : ""}"><div class="progress-bar"></div></div>`;
  document.querySelector(".content, .login-card, body").prepend(el);
  return el;
}

export function updateProgress(el, message, percent = null) {
  if (!el) return;
  const bar = el.querySelector(".progress-bar");
  el.childNodes[0].nodeValue = message;
  if (percent !== null && bar) {
    el.querySelector(".progress")?.classList.remove("indeterminate");
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

export function stopProgress(el, message = "", type = "info") {
  if (!el) return;
  el.remove();
  if (message) toast(message, type);
}

export function setButtonBusy(button, busy, label = "Working...") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.classList.add("is-busy");
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.classList.remove("is-busy");
    button.disabled = false;
    delete button.dataset.originalText;
  }
}

export function renderRows(tbody, rows, columns) {
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows?.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${columns.length}">No records found.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const row of rows || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = columns.map((column) => `<td>${column(row)}</td>`).join("");
    tbody.appendChild(tr);
  }
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  }[char]));
}

export function initTheme() {
  const saved = localStorage.getItem("data-platform-theme");
  const preferredDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const theme = saved || (preferredDark ? "dark" : "light");
  setTheme(theme);
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    updateThemeToggle(button);
    if (button.dataset.themeBound === "true") return;
    button.dataset.themeBound = "true";
    button.addEventListener("click", () => {
      const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      setTheme(nextTheme);
      document.querySelectorAll("[data-theme-toggle]").forEach(updateThemeToggle);
    });
  });
}

function updateThemeToggle(button) {
  const isDark = document.documentElement.dataset.theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  button.classList.add("theme-toggle");
  button.innerHTML = `<span aria-hidden="true">${isDark ? "&#9728;" : "&#9790;"}</span>`;
  button.setAttribute("aria-label", label);
  button.title = label;
}

function setTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized;
  localStorage.setItem("data-platform-theme", normalized);
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: normalized } }));
}
