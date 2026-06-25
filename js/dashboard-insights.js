(() => {
  const SOURCE_BODY_SELECTOR = "#employee-experience-body";
  const TARGET_CANVAS_SELECTOR = "#hours-over-time";
  const TARGET_ID = "employee-coverage-insight";

  ready(() => {
    const canvas = document.querySelector(TARGET_CANVAS_SELECTOR);
    if (!canvas) return;

    const panel = canvas.closest(".panel");
    const heading = panel?.querySelector("h2");
    if (heading) heading.textContent = "Employee Coverage Summary";

    const target = document.createElement("div");
    target.id = TARGET_ID;
    target.className = "insight-card";
    canvas.replaceWith(target);

    renderInsight();
    const body = document.querySelector(SOURCE_BODY_SELECTOR);
    if (body) {
      const observer = new MutationObserver(() => window.requestAnimationFrame(renderInsight));
      observer.observe(body, { childList: true });
    }
  });

  function ready(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  function renderInsight() {
    const target = document.querySelector(`#${TARGET_ID}`);
    if (!target) return;

    const rows = employeeRows();
    if (!rows.length) {
      target.innerHTML = `<p class="muted">Employee coverage will appear once experience data loads.</p>`;
      return;
    }

    const topRows = rows
      .sort((a, b) => b.jobcodes - a.jobcodes || b.serviceItems - a.serviceItems || b.hours - a.hours || a.employee.localeCompare(b.employee))
      .slice(0, 8);
    const totals = rows.reduce((acc, row) => {
      acc.hours += row.hours;
      acc.entries += row.entries;
      acc.jobcodes += row.jobcodes;
      acc.serviceItems += row.serviceItems;
      return acc;
    }, { hours: 0, entries: 0, jobcodes: 0, serviceItems: 0 });

    target.innerHTML = `
      <div class="insight-summary-grid">
        <div><strong>${formatNumber(rows.length)}</strong><span>Employees</span></div>
        <div><strong>${formatNumber(totals.hours)}</strong><span>Total hours</span></div>
        <div><strong>${formatNumber(totals.entries)}</strong><span>Entries</span></div>
        <div><strong>${formatNumber(avg(rows, "jobcodes"))}</strong><span>Avg job codes / employee</span></div>
      </div>
      <p class="muted">Top employees by breadth of project and service experience.</p>
      <div class="table-wrap compact-insight-table">
        <table>
          <thead><tr><th>Employee</th><th>Job codes</th><th>Service items</th><th>Hours</th><th>Entries</th></tr></thead>
          <tbody>${topRows.map((row) => `
            <tr>
              <td>${escapeHtml(row.employee)}</td>
              <td>${formatNumber(row.jobcodes)}</td>
              <td>${formatNumber(row.serviceItems)}</td>
              <td>${formatNumber(row.hours)}</td>
              <td>${formatNumber(row.entries)}</td>
            </tr>
          `).join("")}</tbody>
        </table>
      </div>
    `;
  }

  function employeeRows() {
    return Array.from(document.querySelectorAll(`${SOURCE_BODY_SELECTOR} tr`))
      .map((tr) => {
        const cells = Array.from(tr.children).map((td) => td.textContent.trim());
        return {
          employee: cells[0] || "Unassigned",
          hours: numberValue(cells[1]),
          entries: numberValue(cells[2]),
          jobcodes: numberValue(cells[3]),
          serviceItems: numberValue(cells[4]),
        };
      })
      .filter((row) => row.employee && row.employee !== "-" && (row.hours || row.entries || row.jobcodes || row.serviceItems));
  }

  function numberValue(value) {
    const parsed = Number(String(value || "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function avg(rows, key) {
    if (!rows.length) return 0;
    return Math.round((rows.reduce((total, row) => total + row[key], 0) / rows.length) * 10) / 10;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[char] || char));
  }
})();
