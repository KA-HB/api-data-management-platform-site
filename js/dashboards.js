import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
const charts = new Map();
let qbFilterOptions = null;

if (profile) {
  renderShell(profile);
  await loadDashboard();
  if (profile.role === "admin") {
    $("#qb-viz-filters")?.addEventListener("submit", applyQbFilters);
    $("#clear-qb-filters")?.addEventListener("click", clearQbFilters);
    $("#filter-jobcode-1")?.addEventListener("change", refreshDependentJobFilters);
    $("#filter-jobcode-2")?.addEventListener("change", refreshDependentJobFilters);
  }
}

async function loadDashboard() {
  const progress = startProgress("Loading dashboard data...");
  const [{ data: summary, error }, { data: logs }, qbOptions] = await Promise.all([
    supabase.rpc("dashboard_summary"),
    supabase.from("activity_logs").select("action,details,created_at").order("created_at", { ascending: false }).limit(8),
    profile.role === "admin" ? supabase.rpc("dashboard_qbtime_filter_options") : Promise.resolve({ data: null, error: null }),
  ]);

  if (error) return stopProgress(progress, error.message, "error");
  stopProgress(progress);
  if (qbOptions?.data) {
    qbFilterOptions = qbOptions.data;
    populateQbFilters(qbFilterOptions);
  }

  setText("#metric-users", summary.users ?? "-");
  setText("#metric-datasets", summary.datasets ?? "-");
  setText("#metric-records", formatNumber(summary.records));
  setText("#metric-keys", summary.api_keys ?? "-");
  setText("#metric-sync", summary.last_sync_status || "Not run");

  renderChart("#records-by-dataset", "bar", summary.records_by_dataset || [], "name", "record_count", "Records");
  renderChart("#records-over-time", "line", summary.records_by_day || [], "date", "records", "Records");
  renderChart("#activity-over-time", "line", summary.activity_by_day || [], "date", "events", "Events");

  if (profile.role === "admin") await loadQbVisuals();

  renderRecentUploads(summary.recent_uploads || []);
  renderRecentSyncs(summary.recent_syncs || []);
  renderRecentLogs(logs || []);
}

async function applyQbFilters(event) {
  event.preventDefault();
  await loadQbVisuals();
}

async function loadQbVisuals() {
  const progress = startProgress("Updating QuickBooks Time charts...");
  const { data, error } = await supabase.rpc("dashboard_qbtime_rollups", qbFilterPayload());
  if (error) return stopProgress(progress, error.message, "error");
  stopProgress(progress);
  renderChart("#hours-by-employee", "bar", data.hours_by_employee || [], "employee", "hours", "Hours");
  renderChart("#hours-by-jobcode", "bar", data.hours_by_jobcode || [], "jobcode", "hours", "Hours");
  renderChart("#hours-by-service-item", "bar", data.hours_by_service_item || [], "service_item", "hours", "Hours");
  renderChart("#hours-over-time", "line", data.hours_by_day || [], "date", "hours", "Hours");
  setText("#qb-filter-summary", `${formatNumber(data.filtered_timesheets)} timesheets, ${formatNumber(data.filtered_hours)} hours`);
}

function qbFilterPayload() {
  return {
    employee_filter: $("#filter-employee")?.value || null,
    start_date: $("#filter-start")?.value || null,
    end_date: $("#filter-end")?.value || null,
    jobcode_level1_filter: $("#filter-jobcode-1")?.value || null,
    jobcode_level2_filter: $("#filter-jobcode-2")?.value || null,
    jobcode_level3_filter: $("#filter-jobcode-3")?.value || null,
    service_item_filter: $("#filter-service-item")?.value || null,
  };
}

function clearQbFilters() {
  $("#qb-viz-filters")?.reset();
  refreshDependentJobFilters();
  loadQbVisuals();
}

function populateQbFilters(options) {
  fillSelect("#filter-employee", options.employees || [], "All employees");
  fillSelect("#filter-jobcode-1", options.jobcode_level1 || [], "All Job Code 1");
  fillSelect("#filter-service-item", (options.service_items || []).map((name) => ({ id: name, name })), "All service items");
  refreshDependentJobFilters();
}

function refreshDependentJobFilters() {
  if (!qbFilterOptions) return;
  const selectedLevel1 = $("#filter-jobcode-1")?.value || "";
  const selectedLevel2 = $("#filter-jobcode-2")?.value || "";
  const level2 = (qbFilterOptions.jobcode_level2 || []).filter((row) => !selectedLevel1 || row.parent_id === selectedLevel1);
  fillSelect("#filter-jobcode-2", level2, "All Job Code 2");
  if (selectedLevel2 && level2.some((row) => row.id === selectedLevel2)) $("#filter-jobcode-2").value = selectedLevel2;
  const nextLevel2 = $("#filter-jobcode-2")?.value || "";
  const level3 = (qbFilterOptions.jobcode_level3 || []).filter((row) => {
    if (nextLevel2) return row.parent_id === nextLevel2;
    if (selectedLevel1) return row.grandparent_id === selectedLevel1;
    return true;
  });
  fillSelect("#filter-jobcode-3", level3, "All Job Code 3");
}

function fillSelect(selector, rows, placeholder) {
  const select = $(selector);
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${rows.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join("")}`;
  if (current && rows.some((row) => row.id === current)) select.value = current;
}

function renderChart(selector, type, rows, labelKey, valueKey, label) {
  const canvas = $(selector);
  if (!canvas || !window.Chart) return;
  charts.get(selector)?.destroy();
  const context = canvas.getContext("2d");
  const dataRows = rows.length ? rows : [{ [labelKey]: "No data", [valueKey]: 0 }];
  charts.set(selector, new Chart(context, {
    type,
    data: {
      labels: dataRows.map((row) => String(row[labelKey] ?? "")),
      datasets: [{
        label,
        data: dataRows.map((row) => Number(row[valueKey] || 0)),
        borderColor: "#2563eb",
        backgroundColor: type === "line" ? "rgba(37, 99, 235, .16)" : ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#7c3aed", "#475569"],
        borderWidth: 2,
        tension: 0.28,
        fill: type === "line",
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, color: "#475467" }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: "#475467" }, grid: { color: "#eef2f7" } },
      },
    },
  }));
}

function renderRecentUploads(rows) {
  const tbody = $("#recent-uploads");
  if (!tbody) return;
  renderRows(tbody, rows, [
    (r) => escapeHtml(r.name),
    (r) => escapeHtml(r.source_type),
    (r) => formatNumber(r.record_count),
    (r) => escapeHtml(r.updated_at ? new Date(r.updated_at).toLocaleString() : "Never"),
  ]);
}

function renderRecentSyncs(rows) {
  const tbody = $("#recent-syncs");
  if (!tbody) return;
  renderRows(tbody, rows, [
    (r) => `<span class="status ${r.status === "success" ? "ok" : r.status === "partial" ? "warn" : "danger"}">${escapeHtml(r.status)}</span>`,
    (r) => escapeHtml(r.finished_at ? new Date(r.finished_at).toLocaleString() : "Running"),
    (r) => escapeHtml(r.message || JSON.stringify(r.stats || {})),
  ]);
}

function renderRecentLogs(rows) {
  const tbody = $("#recent-logs");
  if (!tbody) return;
  renderRows(tbody, rows, [
    (r) => escapeHtml(r.action),
    (r) => escapeHtml(new Date(r.created_at).toLocaleString()),
    (r) => `<pre>${escapeHtml(JSON.stringify(r.details, null, 2))}</pre>`,
  ]);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}
