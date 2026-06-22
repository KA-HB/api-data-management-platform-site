import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth("admin");
const charts = new Map();
let filterOptions = null;
let lastAnomalies = [];
let hasRunDetection = false;

if (profile) {
  renderShell(profile);
  await loadFilterOptions();
  bindEvents();
  resetResults();
}

function bindEvents() {
  $("#anomaly-filters")?.addEventListener("submit", runDetection);
  $("#clear-anomaly-filters")?.addEventListener("click", clearFilters);
  $("#export-anomalies")?.addEventListener("click", exportCsv);
  $("#filter-dataset")?.addEventListener("change", rerunIfReady);
  $("#filter-employee")?.addEventListener("change", rerunIfReady);
  $("#filter-employee")?.addEventListener("input", debounce(rerunIfReady, 350));
  $("#filter-start")?.addEventListener("change", rerunIfReady);
  $("#filter-end")?.addEventListener("change", rerunIfReady);
  $("#filter-service-item")?.addEventListener("change", rerunIfReady);
  $("#filter-min-hours")?.addEventListener("change", rerunIfReady);
  $("#filter-min-timesheets")?.addEventListener("change", rerunIfReady);
  $("#filter-max-share")?.addEventListener("change", rerunIfReady);
  $("#filter-max-timesheets")?.addEventListener("change", rerunIfReady);
  $("#filter-limit")?.addEventListener("change", rerunIfReady);
  $("#filter-keyword")?.addEventListener("input", debounce(rerunIfReady, 350));
  $("#filter-jobcode-1")?.addEventListener("change", () => {
    refreshDependentJobFilters();
    rerunIfReady();
  });
  $("#filter-jobcode-2")?.addEventListener("change", () => {
    refreshDependentJobFilters();
    rerunIfReady();
  });
  $("#filter-jobcode-3")?.addEventListener("change", rerunIfReady);
}

async function loadFilterOptions() {
  const progress = startProgress("Loading anomaly filters...");
  const [datasetOptions, qbOptions] = await Promise.all([
    supabase.from("datasets").select("id,name").neq("name", "QuickBooks Time PTO").order("name"),
    supabase.rpc("dashboard_qbtime_filter_options"),
  ]);
  if (datasetOptions.error) return stopProgress(progress, datasetOptions.error.message, "error");
  if (qbOptions.error) return stopProgress(progress, qbOptions.error.message, "error");
  fillSelect("#filter-dataset", datasetOptions.data || [], "All datasets (deduped)");
  filterOptions = qbOptions.data || {};
  populateQbFilters(filterOptions);
  stopProgress(progress);
}

async function runDetection(event = null) {
  event?.preventDefault();
  const button = event?.submitter || $("#run-anomaly-detection");
  const progress = startProgress("Finding rare employee job and service item combinations...");
  setButtonBusy(button, true, "Finding...");
  const { data, error } = await supabase.rpc("qbtime_anomaly_detection", filterPayload());
  setButtonBusy(button, false);
  if (error) return stopProgress(progress, error.message, "error");
  stopProgress(progress);
  hasRunDetection = true;
  renderAnomalies(data || {});
}

function filterPayload() {
  return {
    keyword_filter: $("#filter-keyword")?.value.trim() || null,
    employee_filter: $("#filter-employee")?.value.trim() || null,
    start_date: $("#filter-start")?.value || null,
    end_date: $("#filter-end")?.value || null,
    jobcode_level1_filter: $("#filter-jobcode-1")?.value || null,
    jobcode_level2_filter: $("#filter-jobcode-2")?.value || null,
    jobcode_level3_filter: $("#filter-jobcode-3")?.value || null,
    service_item_filter: $("#filter-service-item")?.value || null,
    dataset_uuid_filter: $("#filter-dataset")?.value || null,
    min_hours: numberValue("#filter-min-hours", 0.25),
    min_timesheets: numberValue("#filter-min-timesheets", 1),
    limit_count: numberValue("#filter-limit", 100),
    max_employee_share: numberValue("#filter-max-share", 5) / 100,
    max_timesheets: numberValue("#filter-max-timesheets", 3),
  };
}

function renderAnomalies(data) {
  const summary = data.summary || {};
  lastAnomalies = data.anomalies || [];
  setText("#metric-anomalies", formatNumber(summary.total_anomalies));
  setText("#metric-high", formatNumber(summary.high_anomalies));
  setText("#metric-employees", formatNumber(summary.employees_with_anomalies));
  setText("#metric-combos", formatNumber(summary.combos_analyzed));
  setText("#anomaly-filter-summary", `${formatNumber(summary.filtered_timesheets)} timesheets, ${formatNumber(summary.filtered_hours)} hours${dateRangeLabel(summary)}`);
  setText("#anomaly-results-summary", lastAnomalies.length ? `${formatNumber(lastAnomalies.length)} rare combinations shown.` : "No rare combinations matched these filters.");

  renderChart("#anomalies-by-employee", "bar", data.by_employee || [], "employee", "anomalies", "Flags");
  renderChart("#anomalies-by-reason", "bar", data.by_reason || [], "reason", "count", "Flags");
  renderChart("#anomalies-by-service", "bar", data.by_service_item || [], "service_item", "anomalies", "Flags");

  renderRows($("#anomaly-results-body"), lastAnomalies, [
    (r) => `<span class="status ${severityClass(r.severity)}">${escapeHtml(priorityLabel(r.severity))}</span>`,
    (r) => escapeHtml(r.employee),
    (r) => escapeHtml(r.reason),
    (r) => escapeHtml(cleanJobcodeLabel(r.jobcode_level1) || "-"),
    (r) => escapeHtml(cleanJobcodeLabel(r.jobcode_level2) || "-"),
    (r) => escapeHtml(cleanJobcodeLabel(r.jobcode_level3) || cleanJobcodeLabel(r.jobcode) || "-"),
    (r) => escapeHtml(r.service_item || "No service item"),
    (r) => formatNumber(r.hours),
    (r) => formatNumber(r.timesheets),
    (r) => `${formatNumber(r.employee_hour_share)}%`,
    (r) => formatNumber(r.peer_employee_count),
    (r) => formatNumber(r.anomaly_score),
    (r) => `${formatDate(r.first_work)} - ${formatDate(r.last_work)}`,
  ]);
}

function populateQbFilters(options) {
  fillEmployeeOptions(options.employees || []);
  fillSelect("#filter-jobcode-1", options.jobcode_level1 || [], "All Job Code 1", { hideNumericNames: true });
  fillSelect("#filter-service-item", (options.service_items || []).map((name) => ({ id: name, name })), "All service items");
  refreshDependentJobFilters();
}

function fillEmployeeOptions(rows) {
  const list = $("#employee-options");
  if (!list) return;
  const cleanRows = (rows || []).filter((row) => row?.id && row?.name && !/^\d+$/.test(String(row.name).trim()));
  list.innerHTML = cleanRows
    .map((row) => `<option value="${escapeHtml(row.name)}" label="${escapeHtml(row.id)}"></option>`)
    .join("");
}

function refreshDependentJobFilters() {
  if (!filterOptions) return;
  const selectedLevel1 = $("#filter-jobcode-1")?.value || "";
  const selectedLevel2 = $("#filter-jobcode-2")?.value || "";
  const level2 = (filterOptions.jobcode_level2 || []).filter((row) => !selectedLevel1 || row.parent_id === selectedLevel1);
  fillSelect("#filter-jobcode-2", level2, "All Job Code 2", { hideNumericNames: true });
  if (selectedLevel2 && level2.some((row) => row.id === selectedLevel2)) $("#filter-jobcode-2").value = selectedLevel2;
  const nextLevel2 = $("#filter-jobcode-2")?.value || "";
  const level3 = (filterOptions.jobcode_level3 || []).filter((row) => {
    if (nextLevel2) return row.parent_id === nextLevel2;
    if (selectedLevel1) return row.grandparent_id === selectedLevel1;
    return true;
  });
  fillSelect("#filter-jobcode-3", level3, "All Job Code 3", { hideNumericNames: true });
}

function fillSelect(selector, rows, placeholder, { hideNumericNames = false } = {}) {
  const select = $(selector);
  if (!select) return;
  const current = select.value;
  const cleanRows = (rows || []).filter((row) => row?.id && row?.name && (!hideNumericNames || cleanJobcodeLabel(row.name)));
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${cleanRows.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join("")}`;
  if (current && cleanRows.some((row) => row.id === current)) select.value = current;
}

function cleanJobcodeLabel(value) {
  const label = String(value || '').replace(/\s+/g, ' ').trim();
  if (!label || label === '0' || /^[0-9]+$/.test(label)) return null;
  return label;
}

function renderChart(selector, type, rows, labelKey, valueKey, label) {
  const canvas = $(selector);
  if (!canvas || !window.Chart) return;
  charts.get(selector)?.destroy();
  const context = canvas.getContext("2d");
  const dataRows = rows.length ? rows : [{ [labelKey]: "No data", [valueKey]: 0 }];
  const isBar = type === "bar";
  charts.set(selector, new Chart(context, {
    type,
    data: {
      labels: dataRows.map((row) => String(row[labelKey] ?? "")),
      datasets: [{
        label,
        data: dataRows.map((row) => Number(row[valueKey] || 0)),
        borderColor: "#126c78",
        backgroundColor: ["#126c78", "#2563eb", "#b54708", "#7c3aed", "#15803d", "#dc2626", "#475569"],
        borderWidth: 2,
      }],
    },
    options: {
      indexAxis: isBar ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { color: "#475467", callback: isBar ? numberTick : shortTick }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#475467", callback: isBar ? shortTick : numberTick }, grid: { color: "#eef2f7" } },
      },
    },
  }));
}

function clearFilters() {
  $("#anomaly-filters")?.reset();
  refreshDependentJobFilters();
  resetResults();
}

function rerunIfReady(event = null) {
  if (!hasRunDetection) return;
  runDetection(event);
}

function resetResults() {
  hasRunDetection = false;
  lastAnomalies = [];
  setText("#metric-anomalies", "-");
  setText("#metric-high", "-");
  setText("#metric-employees", "-");
  setText("#metric-combos", "-");
  setText("#anomaly-filter-summary", "Choose filters, then run rare-combination detection.");
  setText("#anomaly-results-summary", "Run detection to load results.");
  charts.forEach((chart) => chart.destroy());
  charts.clear();
  renderRows($("#anomaly-results-body"), [], [
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
    () => "",
  ]);
}

function exportCsv() {
  if (!lastAnomalies.length) return toast("Run anomaly detection before exporting.", "error");
  const headers = ["severity", "employee", "reason", "jobcode_level1", "jobcode_level2", "jobcode_level3", "service_item", "hours", "timesheets", "employee_hour_share", "employee_timesheet_share", "peer_employee_count", "anomaly_score", "first_work", "last_work"];
  const lines = [headers.join(",")].concat(lastAnomalies.map((row) => headers.map((header) => csvCell(row[header])).join(",")));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "qbtime-anomalies.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const clean = String(value ?? "").replace(/"/g, "\"\"");
  return `"${clean}"`;
}

function numberValue(selector, fallback) {
  const value = Number($(selector)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDate(value) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : "-";
}

function dateRangeLabel(summary) {
  if (!summary.date_start && !summary.date_end) return "";
  return ` from ${formatDate(summary.date_start)} to ${formatDate(summary.date_end)}`;
}

function severityClass(severity) {
  if (severity === "high") return "danger";
  if (severity === "medium") return "warn";
  return "info";
}

function priorityLabel(severity) {
  if (severity === "high") return "High";
  if (severity === "medium") return "Medium";
  return "Watch";
}

function shortTick(value) {
  const label = this.getLabelForValue ? this.getLabelForValue(value) : String(value);
  return label.length > 30 ? `${label.slice(0, 27)}...` : label;
}

function numberTick(value) {
  return Number(value || 0).toLocaleString();
}

function debounce(fn, delay) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}
