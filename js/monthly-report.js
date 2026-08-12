import { requireAuth, renderShell } from "./auth.js?v=20260811b";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
let chart = null;
let report = null;
let activeBreakdownRun = 0;

if (profile) {
  renderShell(profile);
  bindEvents();
  $("#report-month").value = previousMonth();
  await generateReport();
}

function bindEvents() {
  $("#monthly-report-form")?.addEventListener("submit", generateReport);
  $("#export-report")?.addEventListener("click", exportCsv);
  $("#monthly-report-body")?.addEventListener("click", handleReportRowClick);
  $("#close-breakdown")?.addEventListener("click", closeBreakdown);
}

async function generateReport(event = null) {
  event?.preventDefault();
  const month = $("#report-month")?.value;
  if (!month) return toast("Select a reporting month.", "error");

  const button = event?.submitter || $("#generate-report");
  const progress = startProgress("Calculating billable hours for the selected month...");
  setButtonBusy(button, true, "Generating...");
  closeBreakdown();

  const { data, error } = await supabase.rpc("monthly_billable_hours", {
    report_month: month + "-01",
  });

  setButtonBusy(button, false);
  if (error) {
    clearReport();
    const missingRpc = /monthly_billable_hours|schema cache/i.test(error.message || "");
    const message = missingRpc
      ? "The monthly reporting database function has not been deployed yet."
      : error.message;
    return stopProgress(progress, message, "error");
  }

  stopProgress(progress);
  report = data || {};
  renderReport(report);
}

function renderReport(data) {
  const summary = data.summary || {};
  const rows = data.rows || [];
  const totalHours = Number(summary.total_hours || 0);

  setText("#metric-billable-hours", formatHours(totalHours));
  setText("#metric-jobcode-1", formatNumber(summary.jobcode_level1_count));
  setText("#metric-jobcode-pairs", formatNumber(summary.jobcode_combination_count));
  setText("#metric-time-entries", formatNumber(summary.total_timesheets));

  const monthLabel = formatMonth(data.month_start || $("#report-month")?.value + "-01");
  const refreshed = data.refreshed_at ? " Data refreshed " + formatDateTime(data.refreshed_at) + "." : "";
  setText("#report-status", monthLabel + " billable totals." + refreshed);
  setText(
    "#report-table-summary",
    rows.length
      ? rows.length + " Job Code 1 / Job Code 2 combinations, ordered by billable hours."
      : "No billable hours were found for " + monthLabel + "."
  );

  renderExclusions(["Billable is not Yes"]);
  renderChart(data.by_jobcode1 || []);
  rows.forEach((row, index) => { row.report_index = index; });
  renderRows($("#monthly-report-body"), rows, [
    (row) => escapeHtml(row.jobcode_level1),
    (row) => escapeHtml(row.jobcode_level2),
    (row) => '<span class="numeric-value">' + formatHours(row.hours) + '</span>',
    (row) => '<span class="numeric-value">' + formatPercent(totalHours ? Number(row.hours) / totalHours : 0) + '</span>',
    (row) => '<span class="numeric-value">' + formatNumber(row.timesheets) + '</span>',
    (row) => '<span class="numeric-value">' + formatNumber(row.employees) + '</span>',
    (row) => escapeHtml(formatDate(row.first_work)),
    (row) => escapeHtml(formatDate(row.last_work)),
    (row) => '<button class="secondary compact-button breakdown-button" type="button" data-breakdown-index="' + row.report_index + '">View details</button>',
  ]);
  decorateReportRows(rows);

  const exportButton = $("#export-report");
  if (exportButton) exportButton.disabled = !rows.length;
}

function decorateReportRows(rows) {
  $("#monthly-report-body")?.querySelectorAll("tr").forEach((tableRow, index) => {
    if (!rows[index]) return;
    tableRow.dataset.breakdownIndex = String(index);
    tableRow.classList.add("drilldown-row");
    tableRow.title = "View employee and billing breakdown";
  });
}

function handleReportRowClick(event) {
  const target = event.target.closest("[data-breakdown-index]");
  const index = Number(target?.dataset.breakdownIndex);
  if (!Number.isInteger(index)) return;
  loadBreakdown(index);
}

async function loadBreakdown(index) {
  const selected = report?.rows?.[index];
  const month = $("#report-month")?.value;
  if (!selected || !month) return;

  const run = ++activeBreakdownRun;
  const panel = $("#job-breakdown-panel");
  panel?.classList.remove("hidden");
  setText("#breakdown-title", selected.jobcode_level1 + " / " + selected.jobcode_level2);
  setText("#breakdown-summary", "Loading employee, service item, and billing details...");
  setBreakdownMetrics(null);
  $("#breakdown-warning")?.classList.add("hidden");
  $("#monthly-breakdown-body").innerHTML = '<tr><td colspan="9" class="muted">Loading exact monthly hours...</td></tr>';
  markSelectedReportRow(index);
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });

  const { data, error } = await supabase.rpc("monthly_job_hours_breakdown", {
    report_month: month + "-01",
    selected_jobcode_level1: selected.jobcode_level1,
    selected_jobcode_level2: selected.jobcode_level2,
  });
  if (run !== activeBreakdownRun) return;
  if (error) {
    setText("#breakdown-summary", /monthly_job_hours_breakdown|schema cache/i.test(error.message || "")
      ? "The monthly breakdown database function has not been deployed yet."
      : error.message);
    $("#monthly-breakdown-body").innerHTML = '<tr><td colspan="9" class="muted">Breakdown unavailable.</td></tr>';
    return;
  }

  renderBreakdown(data || {}, selected);
}

function renderBreakdown(data, selected) {
  const summary = data.summary || {};
  const rows = data.rows || [];
  const billableHours = Number(summary.billable_hours || 0);
  const nonbillableHours = Number(summary.nonbillable_hours || 0);
  const totalEntries = Number(summary.billable_entries || 0) + Number(summary.nonbillable_entries || 0);
  const matchesLine = Math.abs(billableHours - Number(selected.hours || 0)) < 0.011;

  setBreakdownMetrics({ ...summary, total_entries: totalEntries });
  setText(
    "#breakdown-summary",
    formatMonth(data.month_start) + " details. " +
      (matchesLine ? "Billable hours reconcile to the selected report line." : "Billable hours differ from the selected report line; regenerate the monthly report.")
  );

  const warning = $("#breakdown-warning");
  if (warning) {
    warning.textContent = nonbillableHours > 0
      ? formatHours(nonbillableHours) + " non-billable hours across " + formatNumber(summary.nonbillable_entries) + " entries were found for this same job. They are flagged below and excluded from the report total."
      : "No non-billable time was found for this job during the selected month.";
    warning.classList.toggle("hidden", nonbillableHours <= 0);
  }

  renderRows($("#monthly-breakdown-body"), rows, [
    (row) => row.is_billable
      ? '<span class="status ok">Billable</span>'
      : '<span class="status danger">Non-billable</span>',
    (row) => escapeHtml(row.employee),
    (row) => escapeHtml(row.jobcode_level1),
    (row) => escapeHtml(row.jobcode_level2),
    (row) => escapeHtml(row.service_item),
    (row) => '<span class="numeric-value">' + formatHours(row.hours) + '</span>',
    (row) => '<span class="numeric-value">' + formatNumber(row.timesheets) + '</span>',
    (row) => escapeHtml(formatDate(row.first_work)),
    (row) => escapeHtml(formatDate(row.last_work)),
  ]);
  $("#monthly-breakdown-body")?.querySelectorAll("tr").forEach((tableRow, index) => {
    tableRow.classList.toggle("nonbillable-row", !rows[index]?.is_billable);
  });
}

function setBreakdownMetrics(summary) {
  setText("#breakdown-billable-hours", summary ? formatHours(summary.billable_hours) : "-");
  setText("#breakdown-nonbillable-hours", summary ? formatHours(summary.nonbillable_hours) : "-");
  setText("#breakdown-employees", summary ? formatNumber(summary.employee_count) : "-");
  setText("#breakdown-entries", summary ? formatNumber(summary.total_entries) : "-");
}

function markSelectedReportRow(index) {
  $("#monthly-report-body")?.querySelectorAll("tr").forEach((row, rowIndex) => {
    row.classList.toggle("selected-report-row", rowIndex === index);
    row.querySelector("[data-breakdown-index]")?.setAttribute("aria-pressed", rowIndex === index ? "true" : "false");
  });
}

function closeBreakdown() {
  activeBreakdownRun += 1;
  $("#job-breakdown-panel")?.classList.add("hidden");
  markSelectedReportRow(-1);
}

function renderExclusions(categories) {
  const container = $("#excluded-categories");
  if (!container) return;
  container.innerHTML = categories.map((category) => '<span class="badge">' + escapeHtml(category) + '</span>').join("");
}

function renderChart(rows) {
  chart?.destroy();
  const canvas = $("#monthly-hours-chart");
  const frame = $("#report-chart-frame");
  if (!canvas || !frame || typeof Chart === "undefined") return;

  const height = Math.max(520, rows.length * 34 + 90);
  frame.style.height = height + "px";
  frame.style.minWidth = "780px";

  chart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: rows.map((row) => row.jobcode_level1),
      datasets: [{
        label: "Billable hours",
        data: rows.map((row) => Number(row.hours || 0)),
        backgroundColor: "#2563eb",
        borderColor: "#1d4ed8",
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => formatHours(context.parsed.x) + " billable hours",
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: "Billable hours" },
          ticks: { callback: (value) => formatNumber(value) },
        },
        y: {
          ticks: { autoSkip: false, font: { size: 12 } },
        },
      },
    },
  });
}

function clearReport() {
  report = null;
  chart?.destroy();
  chart = null;
  setText("#metric-billable-hours", "-");
  setText("#metric-jobcode-1", "-");
  setText("#metric-jobcode-pairs", "-");
  setText("#metric-time-entries", "-");
  setText("#report-table-summary", "The report could not be loaded.");
  renderRows($("#monthly-report-body"), [], new Array(9).fill(() => ""));
  closeBreakdown();
  const exportButton = $("#export-report");
  if (exportButton) exportButton.disabled = true;
}

function exportCsv() {
  const rows = report?.rows || [];
  if (!rows.length) return;

  const totalHours = Number(report.summary?.total_hours || 0);
  const columns = [
    ["Job Code 1", (row) => row.jobcode_level1],
    ["Job Code 2", (row) => row.jobcode_level2],
    ["Billable Hours", (row) => Number(row.hours || 0).toFixed(2)],
    ["Month Share", (row) => (totalHours ? Number(row.hours || 0) / totalHours : 0).toFixed(4)],
    ["Entries", (row) => row.timesheets],
    ["Employees", (row) => row.employees],
    ["First Work", (row) => row.first_work],
    ["Last Work", (row) => row.last_work],
  ];
  const csv = [
    columns.map(([heading]) => csvCell(heading)).join(","),
    ...rows.map((row) => columns.map(([, value]) => csvCell(value(row))).join(",")),
  ].join("\r\n");

  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = "monthly-billable-hours-" + $("#report-month").value + ".csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvCell(value) {
  return '"' + String(value ?? "").replaceAll('"', '""') + '"';
}

function previousMonth() {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() - 1);
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function formatHours(value) {
  return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatPercent(value) {
  return Number(value || 0).toLocaleString(undefined, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatMonth(value) {
  const date = new Date(String(value).slice(0, 10) + "T00:00:00");
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(String(value).slice(0, 10) + "T00:00:00").toLocaleDateString();
}

function formatDateTime(value) {
  return new Date(value).toLocaleString();
}
