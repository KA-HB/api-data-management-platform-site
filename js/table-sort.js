(() => {
  const sortableTables = [
    "#project-experience-body",
    "#employee-experience-body",
    "#experience-detail-body",
  ];
  const sortState = new WeakMap();

  ready(() => {
    for (const selector of sortableTables) {
      const body = document.querySelector(selector);
      if (body) makeTableSortable(body.closest("table"));
    }
  });

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  function makeTableSortable(table) {
    if (!table || table.dataset.sortableReady === "true") return;
    const headers = Array.from(table.querySelectorAll("thead th"));
    const body = table.querySelector("tbody");
    if (!headers.length || !body) return;

    table.dataset.sortableReady = "true";
    table.classList.add("sortable-table");

    headers.forEach((header, index) => {
      const label = header.textContent.trim();
      header.dataset.sortLabel = label;
      header.tabIndex = 0;
      header.role = "button";
      header.dataset.sortIndex = String(index);
      header.title = "Click to sort ascending/descending";
      header.style.cursor = "pointer";
      header.addEventListener("click", () => toggleSort(table, index));
      header.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleSort(table, index);
        }
      });
    });
  }

  function toggleSort(table, index) {
    const previous = sortState.get(table);
    const direction = previous?.index === index && previous.direction === "asc" ? "desc" : "asc";
    sortState.set(table, { index, direction });
    sortTable(table, index, direction);
  }

  function sortTable(table, index, direction) {
    const body = table.querySelector("tbody");
    if (!body) return;
    const rows = Array.from(body.querySelectorAll("tr"));
    if (rows.length < 2) {
      updateSortIndicators(table, index, direction);
      return;
    }

    const fragment = document.createDocumentFragment();
    rows
      .map((row, originalIndex) => ({ row, originalIndex, value: cellValue(row, index) }))
      .sort((left, right) => {
        const result = compareValues(left.value, right.value);
        return (direction === "asc" ? result : -result) || left.originalIndex - right.originalIndex;
      })
      .forEach(({ row }) => fragment.appendChild(row));

    body.replaceChildren(fragment);
    updateSortIndicators(table, index, direction);
  }

  function cellValue(row, index) {
    const cell = row.children[index];
    return normalizeValue(cell?.textContent || "");
  }

  function normalizeValue(value) {
    const text = String(value).replace(/\s+/g, " ").trim();
    const numericText = text.replace(/[$,%]/g, "").replace(/,/g, "");
    if (/^-?\d+(\.\d+)?$/.test(numericText)) {
      return { type: "number", value: Number(numericText), text };
    }

    const dateRange = text.split(/\s+-\s+/).map((part) => Date.parse(part)).filter((value) => !Number.isNaN(value));
    if (dateRange.length) return { type: "date", value: dateRange[0], text };

    const timestamp = Date.parse(text);
    if (!Number.isNaN(timestamp) && /\d{1,4}[-/]\d{1,2}[-/]\d{1,4}|[A-Za-z]{3,}\s+\d{1,2}/.test(text)) {
      return { type: "date", value: timestamp, text };
    }

    return { type: "text", value: text.toLocaleLowerCase(), text };
  }

  function compareValues(left, right) {
    if (left.type === right.type && (left.type === "number" || left.type === "date")) {
      return left.value - right.value;
    }
    return String(left.value).localeCompare(String(right.value), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  function updateSortIndicators(table, activeIndex, direction) {
    Array.from(table.querySelectorAll("thead th")).forEach((header, index) => {
      const label = header.dataset.sortLabel || header.textContent.replace(/[▲▼]\s*$/, "").trim();
      header.textContent = index === activeIndex ? `${label} ${direction === "asc" ? "▲" : "▼"}` : label;
      header.setAttribute("aria-sort", index === activeIndex ? (direction === "asc" ? "ascending" : "descending") : "none");
    });
  }
})();
