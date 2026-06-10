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
  const existing = document.querySelector(".notice");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = message;
  document.querySelector(".content, .login-card, body").prepend(el);
  if (type === "error") el.style.borderColor = "#f3a6a0";
  setTimeout(() => el.remove(), 7000);
}

export function renderRows(tbody, rows, columns) {
  tbody.innerHTML = "";
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
