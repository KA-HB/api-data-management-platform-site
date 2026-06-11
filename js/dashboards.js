import { requireAuth, renderShell } from "./auth.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
const charts = new Map();
let qbFilterOptions = null;
let availableDatasets = [];
let currentFilters = {
  dataset_id: null,
  keyword_filter: null,
  employee_filter: null,
  start_date: null,
  end_date: null,
  jobcode_level1_filter: null,
  jobcode_level2_filter: null,
  jobcode_level3_filter: null,
  service_item_filter: null,
};
let allDashboardData = null;

if (profile) {
  renderShell(profile);
  await loadDatasets();
  await loadDashboard();
  
  if (profile.role === "admin") {
    // QB Time filter listeners
    $("#qb-viz-filters")?.addEventListener("submit", applyQbFilters);
    $("#clear-qb-filters")?.addEventListener("click", clearQbFilters);
    $("#filter-jobcode-1")?.addEventListener("change", refreshDependentJobFilters);
    $("#filter-jobcode-2")?.addEventListener("change", refreshDependentJobFilters);
    
    // Dataset selection listener
    $("#filter-dataset")?.addEventListener("change", handleDatasetChange);
  }
}

/**
 * Load available datasets for selection
 */
async function loadDatasets() {
  const { data, error } = await supabase.from("datasets").select("id,name,record_count").neq("name", "QuickBooks Time PTO").order("name");
  if (error) {
    toast(error.message, "error");
    return;
  }
  
  availableDatasets = data || [];
  const datasetSelect = $("#filter-dataset");
  if (datasetSelect) {
    datasetSelect.innerHTML = `
      <option value="">All datasets</option>
      ${availableDatasets.map((ds) => `<option value="${ds.id}" title="${ds.record_count} records">${escapeHtml(ds.name)}</option>`).join("")}
    `;
  }
}

/**
 * Handle dataset selection change - triggers dashboard refresh
 */
async function handleDatasetChange(event) {
  currentFilters.dataset_id = event.target.value || null;
  const progress = startProgress("Updating dashboard for selected dataset...");
  try {
    await loadDashboard();
    updateDatasetIndicator();
  } finally {
    stopProgress(progress);
  }
}

/**
 * Update visual indicator of current dataset selection
 */
function updateDatasetIndicator() {
  const datasetId = currentFilters.dataset_id;
  const indicator = $("#dataset-indicator");
  const selected = availableDatasets.find((ds) => ds.id === datasetId);
  
  if (indicator) {
    if (selected) {
      indicator.textContent = `Viewing: ${selected.name} (${selected.record_count.toLocaleString()} records)`;
      indicator.classList.remove("hidden");
    } else {
      indicator.classList.add("hidden");
    }
  }
}

async function loadDashboard() {
  const progress = startProgress("Loading dashboard data...");
  
  try {
    const [
      { data: summary, error: summaryError },
      { data: logs },
      qbOptions
    ] = await Promise.all([
      currentFilters.dataset_id 
        ? supabase.rpc("dashboard_summary_by_dataset", { dataset_uuid: currentFilters.dataset_id })
        : supabase.rpc("dashboard_summary"),
      supabase.from("activity_logs").select("action,details,created_at").order("created_at", { ascending: false }).limit(8),
      profile.role === "admin" ? supabase.rpc("dashboard_qbtime_filter_options") : Promise.resolve({ data: null, error: null }),
    ]);

    if (summaryError) return stopProgress(progress, summaryError.message, "error");
    
    stopProgress(progress);
    allDashboardData = summary;
    
    if (qbOptions?.data) {
      qbFilterOptions = qbOptions.data;
      populateQbFilters(qbFilterOptions);
    }

    // Update all metric displays
    setText("#metric-users", summary.users ?? "-");
    setText("#metric-datasets", summary.datasets ?? "-");
    setText("#metric-records", formatNumber(summary.records));
    setText("#metric-keys", summary.api_keys ?? "-");
    setText("#metric-sync", summary.last_sync_status || "Not run");

    // Update data source label
    const datasetId = currentFilters.dataset_id;
    const selected = availableDatasets.find((ds) => ds.id === datasetId);
    const sourceLabel = selected ? ` from ${selected.name}` : " across all datasets";
    
    setText("#data-source-label", `Data shown${sourceLabel}`);
    updateDatasetIndicator();

    // Render all charts
    renderChart("#records-by-dataset", "bar", summary.records_by_dataset || [], "name", "record_count", "Records");
    renderChart("#records-over-time", "line", summary.records_by_day || [], "date", "records", "Records");
    renderChart("#activity-over-time", "line", summary.activity_by_day || [], "date", "events", "Events");

    if (profile.role === "admin") await loadQbVisuals();

    renderRecentUploads(summary.recent_uploads || []);
    renderRecentSyncs(summary.recent_syncs || []);
    renderRecentLogs(logs || []);
  } catch (error) {
    stopProgress(progress, `Error loading dashboard: ${error.message}`, "error");
  }
}

async function applyQbFilters(event) {
  event.preventDefault();
  
  // Validate that at least one filter is set
  const filters = qbFilterPayload();
  const hasFilters = Object.values(filters).some((v) => v !== null && v !== "");
  
  if (!hasFilters) {
    toast("Please select at least one filter criterion.", "error");
    return;
  }
  
  // Apply filters
  Object.assign(currentFilters, filters);
  await loadQbVisuals();
}

async function loadQbVisuals() {
  const payload = qbFilterPayload();
  
  // Validate filter payload for any missing dependencies
  if (payload.jobcode_level2_filter && !payload.jobcode_level1_filter && !payload.jobcode_level3_filter) {
    toast("Warning: Job Code Level 2 selected without Level 1. Results may be limited.", "info");
  }
  
  const progress = startProgress("Updating QuickBooks Time charts...");
  
  try {
    const { data, error } = await supabase.rpc("dashboard_qbtime_rollups", payload);
    if (error) return stopProgress(progress, error.message, "error");
    
    stopProgress(progress);
    
    // Render QB Time visuals
    renderChart("#hours-by-employee", "bar", data.hours_by_employee || [], "employee", "hours", "Hours");
    renderChart("#hours-by-jobcode", "bar", data.hours_by_jobcode || [], "jobcode", "hours", "Hours");
    renderChart("#hours-by-service-item", "bar", data.hours_by_service_item || [], "service_item", "hours", "Hours");
    renderChart("#hours-over-time", "line", data.hours_by_day || [], "date", "hours", "Hours");
    
    // Update QB metrics - these should reflect the filtered data
    setText("#metric-hours", formatNumber(data.filtered_hours));
    setText("#metric-timesheets", formatNumber(data.filtered_timesheets));
    setText("#metric-employees", formatNumber(data.filtered_employees));
    setText("#metric-services", formatNumber(data.filtered_service_items));
    
    // Build filter summary showing what's active
    const filterSummary = buildFilterSummary(data);
    setText("#qb-filter-summary", filterSummary);
    
    renderEmployeeExperience(data.employee_experience || []);
    renderExperienceDetail(data.experience_rows || []);
  } catch (error) {
    stopProgress(progress, `Error loading QB visuals: ${error.message}`, "error");
  }
}

/**
 * Build human-readable filter summary
 */
function buildFilterSummary(data) {
  const parts = [];
  const filters = qbFilterPayload();
  
  if (filters.keyword_filter) parts.push(`keyword: "${filters.keyword_filter}"`);
  if (filters.employee_filter) parts.push(`employee: "${filters.employee_filter}"`);
  if (filters.jobcode_level1_filter) parts.push(`job code: "${filters.jobcode_level1_filter}"`);
  if (filters.jobcode_level2_filter) parts.push(`sub-job: "${filters.jobcode_level2_filter}"`);
  if (filters.jobcode_level3_filter) parts.push(`detail: "${filters.jobcode_level3_filter}"`);
  if (filters.service_item_filter) parts.push(`service: "${filters.service_item_filter}"`);
  if (filters.start_date || filters.end_date) {
    parts.push(`period: ${formatDate(filters.start_date)} to ${formatDate(filters.end_date)}`);
  }
  
  if (parts.length === 0) {
    return `${formatNumber(data.filtered_timesheets)} timesheets, ${formatNumber(data.filtered_hours)} hours - All data`;
  }
  
  return `${formatNumber(data.filtered_timesheets)} timesheets, ${formatNumber(data.filtered_hours)} hours - Filtered by: ${parts.join(", ")}`;
}

function qbFilterPayload() {
  return {
    keyword_filter: $("#filter-keyword")?.value.trim() || null,
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
  currentFilters.keyword_filter = null;
  currentFilters.employee_filter = null;
  currentFilters.start_date = null;
  currentFilters.end_date = null;
  currentFilters.jobcode_level1_filter = null;
  currentFilters.jobcode_level2_filter = null;
  currentFilters.jobcode_level3_filter = null;
  currentFilters.service_item_filter = null;
  
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
  
  // Filter Level 2 based on selected Level 1
  const level2 = (qbFilterOptions.jobcode_level2 || []).filter((row) => !selectedLevel1 || row.parent_id === selectedLevel1);
  fillSelect("#filter-jobcode-2", level2, "All Job Code 2");
  
  // Preserve Level 2 selection if it's still valid
  if (selectedLevel2 && level2.some((row) => row.id === selectedLevel2)) {
    $("#filter-jobcode-2").value = selectedLevel2;
  }
  
  // Filter Level 3 based on selected Level 2 (or Level 1 if no Level 2)
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
  
  // Preserve selection if it's still valid
  if (current && rows.some((row) => row.id === current)) {
    select.value = current;
  }
}

function renderChart(selector, type, rows, labelKey, valueKey, label) {
  const canvas = $(selector);
  if (!canvas || !window.Chart) return;
  
  // Destroy existing chart to prevent memory leaks
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
        borderColor: "#2563eb",
        backgroundColor: type === "line" ? "rgba(37, 99, 235, .16)" : ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#7c3aed", "#475569"],
        borderWidth: 2,
        tension: 0.28,
        fill: type === "line",
      }],
    },
    options: {
      indexAxis: isBar ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items.map((item) => item.label).join(", "),
            label: (context) => `${context.dataset.label}: ${formatNumber(context.parsed.y || context.parsed)}`,
          },
        },
      },
      scales: {
        x: {
          beginAtZero: isBar,
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            color: "#475467",
            callback: isBar ? numberTick : shortTick,
          },
          grid: { display: false },
        },
        y: {
          beginAtZero: !isBar,
          ticks: {
            color: "#475467",
            callback: isBar ? shortTick : numberTick,
          },
          grid: { color: "#eef2f7" },
        },
      },
    },
  }));
}

function renderEmployeeExperience(rows) {
  const count = rows.length;
  const text = count
    ? `${formatNumber(count)} matching employees`
    : "No matching employees";
  
  setText("#employee-experience-summary", text);
  
  renderRows($("#employee-experience-body"), rows, [
    (r) => escapeHtml(r.employee),
    (r) => formatNumber(r.hours),
    (r) => formatNumber(r.timesheets),
    (r) => formatNumber(r.jobcodes),
    (r) => formatNumber(r.service_items),
    (r) => formatDate(r.first_work),
    (r) => formatDate(r.last_work),
  ]);
}

function renderExperienceDetail(rows) {
  const count = rows.length;
  const text = count
    ? `${formatNumber(count)} employee, job, and service combinations`
    : "No matching experience rows";
  
  setText("#experience-detail-summary", text);
  
  renderRows($("#experience-detail-body"), rows, [
    (r) => escapeHtml(r.employee),
    (r) => escapeHtml(r.jobcode_level1 || "-"),
    (r) => escapeHtml(r.jobcode_level2 || "-"),
    (r) => escapeHtml(r.jobcode_level3 || r.jobcode || "-"),
    (r) => escapeHtml(r.service_item || "No service item"),
    (r) => formatNumber(r.hours),
    (r) => `${formatDate(r.first_work)} - ${formatDate(r.last_work)}`,
  ]);
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
    (r) => {
      const statusClass = r.status === "success" ? "ok" : r.status === "partial" ? "warn" : "danger";
      return `<span class="status ${statusClass}">${escapeHtml(r.status)}</span>`;
    },
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

function formatDate(value) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : "-";
}

function dateRangeLabel(data) {
  if (!data.date_start && !data.date_end) return "";
  return ` from ${formatDate(data.date_start)} to ${formatDate(data.date_end)}`;
}

function shortTick(value) {
  const label = this.getLabelForValue ? this.getLabelForValue(value) : String(value);
  return label.length > 28 ? `${label.slice(0, 25)}...` : label;
}

function numberTick(value) {
  return Number(value || 0).toLocaleString();
}
