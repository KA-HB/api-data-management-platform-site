import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
const charts = new Map();
let qbFilterOptions = null;
let availableDatasets = [];

if (profile) {
  renderShell(profile);
  await loadDatasets();
  await loadDashboard();

  if (profile.role === "admin") {
    $("#qb-viz-filters")?.addEventListener("submit", applyQbFilters);
    $("#clear-qb-filters")?.addEventListener("click", clearQbFilters);
    $("#dashboard-qb-sync")?.addEventListener("click", syncQuickBooksTime);
    $("#filter-dataset")?.addEventListener("change", () => {
      updateDatasetIndicator();
      loadQbVisuals();
    });
    $("#filter-jobcode-1")?.addEventListener("change", refreshDependentJobFilters);
    $("#filter-jobcode-2")?.addEventListener("change", refreshDependentJobFilters);
  }
}

async function loadDatasets() {
  const { data, error } = await supabase
    .from("datasets")
    .select("id,name,source_type,record_count,updated_at")
    .neq("name", "QuickBooks Time PTO")
    .order("name");
  if (error) return toast(error.message, "error");

  availableDatasets = data || [];
  const select = $("#filter-dataset");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">All authorized datasets</option>${availableDatasets.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)} (${formatNumber(row.record_count)} records)</option>`).join("")}`;
  if (current && availableDatasets.some((row) => row.id === current)) select.value = current;
  updateDatasetIndicator();
}

async function loadDashboard() {
  const progress = startProgress("Loading dashboard data...");
  try {
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

    const coverage = await callSearchSummary();
    const fallbackCoverage = coverage.data ? null : await buildClientCoverageSummary();
    renderGeneralDashboard(summary, coverage.data);
    if (!coverage.data && fallbackCoverage) renderGeneralDashboard(summary, fallbackCoverage);

    if (profile.role === "admin" && $("#qb-viz-filters")) await loadQbVisuals();

    renderRecentUploads(isExperienceDashboard() ? summary.recent_uploads || [] : [...availableDatasets].sort((a, b) => Number(b.record_count || 0) - Number(a.record_count || 0)));
    renderRecentSyncs(summary.recent_syncs || []);
    renderRecentLogs(logs || []);
  } catch (error) {
    stopProgress(progress, `Error loading dashboard: ${error.message}`, "error");
  }
}

function renderGeneralDashboard(summary, coverage) {
  setText("#metric-datasets", formatNumber(summary?.datasets));
  setText("#metric-keys", formatNumber(summary?.api_keys));
  setText("#metric-raw-records", formatNumber(coverage?.raw_records ?? summary?.records));
  setText("#metric-records", formatNumber(coverage?.unique_records ?? summary?.records));
  setText("#metric-hours", coverage ? formatNumber(coverage.hours) : "-");
  setText("#metric-employees", coverage ? formatNumber(coverage.employee_count) : "-");
  setText("#metric-services", coverage ? formatNumber(coverage.service_item_count) : "-");
  setText("#data-scope-summary", coverage ? scopeSummary(coverage) : `Showing ${formatNumber(summary?.records)} authorized records. Full-year hours, employees, service-item totals, and duplicate removal require the latest Supabase search migration.`);

  renderChart("#records-by-dataset", "bar", coverage?.records_by_dataset || summary.records_by_dataset || [], "name", coverage ? "records" : "record_count", coverage ? "Unique Records" : "Records");
  renderChart("#records-over-time", "line", coverage?.records_by_day || summary.records_by_day || [], "date", "records", coverage ? "Unique Records" : "Records");
  renderChart("#activity-over-time", "line", summary.activity_by_day || [], "date", "events", "Events");
}

function isExperienceDashboard() {
  return Boolean($("#qb-viz-filters"));
}

async function applyQbFilters(event) {
  event.preventDefault();
  updateDatasetIndicator();
  await loadQbVisuals();
}

async function loadQbVisuals() {
  const payload = qbFilterPayload();
  if (payload.jobcode_level2_filter && !payload.jobcode_level1_filter && !payload.jobcode_level3_filter) {
    toast("Job Code 2 selected without Job Code 1. Results may be limited.", "info");
  }

  const progress = startProgress("Updating experience charts...");
  const [experience, coverage] = await Promise.all([callQbRollups(payload), callSearchSummary()]);
  const { data, error } = experience;
  if (error) {
    clearQbVisuals();
    return stopProgress(progress, error.message, "error");
  }

  stopProgress(progress);
  const normalized = normalizeExperienceRollup(data);
  renderChart("#hours-by-employee", "bar", normalized.hours_by_employee, "employee", "hours", "Hours");
  renderChart("#hours-by-jobcode", "bar", normalized.hours_by_jobcode, "jobcode", "hours", "Hours");
  renderChart("#hours-by-service-item", "bar", normalized.hours_by_service_item, "service_item", "hours", "Hours");
  renderChart("#hours-over-time", "line", normalized.hours_by_day, "date", "hours", "Hours");
  if (coverage.data) {
    renderChart("#records-by-dataset", "bar", coverage.data.records_by_dataset || [], "name", "records", "Unique Records");
    renderChart("#records-over-time", "line", coverage.data.records_by_day || [], "date", "records", "Unique Records");
  }

  setText("#metric-records", formatNumber(coverage.data?.unique_records ?? normalized.filtered_timesheets));
  setText("#metric-hours", formatNumber(normalized.filtered_hours));
  setText("#metric-employees", formatNumber(normalized.filtered_employees));
  setText("#metric-services", formatNumber(normalized.filtered_service_items));
  setText("#qb-filter-summary", `${formatNumber(normalized.filtered_timesheets)} experience records, ${formatNumber(normalized.filtered_hours)} hours${dateRangeLabel(normalized)}`);
  setText("#data-scope-summary", coverage.data ? scopeSummary(coverage.data) : `Showing QuickBooks Time rollup totals from the currently deployed dashboard function. Select the uploaded full-year dataset after the latest Supabase migration is applied for full dataset-specific totals.`);

  renderEmployeeExperience(normalized.employee_experience);
  renderExperienceDetail(normalized.experience_rows);
}

function clearQbVisuals() {
  setText("#metric-records", "-");
  setText("#metric-hours", "-");
  setText("#metric-employees", "-");
  setText("#metric-services", "-");
  setText("#qb-filter-summary", "No dataset-specific stats loaded");
  setText("#employee-experience-summary", "No matching employees");
  setText("#experience-detail-summary", "No matching experience rows");
  renderRows($("#employee-experience-body"), [], [() => ""]);
  renderRows($("#experience-detail-body"), [], [() => ""]);
}

async function callQbRollups(payload) {
  const result = await supabase.rpc("dashboard_qbtime_rollups", payload);
  if (!isSchemaCacheError(result.error)) return result;
  if (payload.dataset_uuid) {
    return { data: null, error: { message: "Dataset-specific dashboard filtering requires the latest Supabase dashboard migration." } };
  }
  const legacyPayload = { ...payload };
  delete legacyPayload.dataset_uuid;
  const legacyResult = await supabase.rpc("dashboard_qbtime_rollups", legacyPayload);
  if (!isSchemaCacheError(legacyResult.error)) return legacyResult;
  delete legacyPayload.keyword_filter;
  return supabase.rpc("dashboard_qbtime_rollups", legacyPayload);
}

async function callSearchSummary() {
  const result = await supabase.rpc("search_records_summary", searchSummaryPayload());
  if (!isSchemaCacheError(result.error)) return result;
  return { data: null, error: null };
}

async function syncQuickBooksTime() {
  const button = $("#dashboard-qb-sync");
  const progress = startProgress("Syncing QuickBooks Time data...");
  setButtonBusy(button, true, "Syncing...");
  try {
    const headers = await authHeaders();
    const response = await fetch(`${FUNCTIONS_BASE_URL}/qbtime?action=sync`, { method: "POST", headers });
    const payload = await readPayload(response);
    if (!response.ok) {
      stopProgress(progress, payload.error || `Sync failed with status ${response.status}`, "error");
      return;
    }
    const stats = payload.data?.stats || {};
    const errors = payload.data?.errors || [];
    const message = `Sync finished. Timesheets: ${formatNumber(stats.Timesheets)}; Employees: ${formatNumber(stats.Employees)}; Job Codes: ${formatNumber(stats["Job Codes"])}.${errors.length ? ` ${errors.length} warning${errors.length === 1 ? "" : "s"} logged.` : ""}`;
    stopProgress(progress, message, errors.length ? "info" : "success");
    await loadDatasets();
    await loadDashboard();
  } catch (error) {
    stopProgress(progress, error.message, "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" };
}

async function readPayload(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `Request failed with status ${response.status}` };
  }
}

function qbFilterPayload() {
  return {
    dataset_uuid: $("#filter-dataset")?.value || null,
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

function searchSummaryPayload() {
  const jobcodeFilter = $("#filter-jobcode-3")?.value || $("#filter-jobcode-2")?.value || $("#filter-jobcode-1")?.value || null;
  return {
    dataset_uuid: $("#filter-dataset")?.value || null,
    search_term: $("#filter-keyword")?.value.trim() || null,
    start_date: dateTimeValue("#filter-start"),
    end_date: dateTimeValue("#filter-end", true),
    employee_filter: $("#filter-employee")?.value || null,
    jobcode_filter: jobcodeFilter,
    service_item_filter: $("#filter-service-item")?.value || null,
  };
}

function clearQbFilters() {
  $("#qb-viz-filters")?.reset();
  refreshDependentJobFilters();
  updateDatasetIndicator();
  loadQbVisuals();
}

function populateQbFilters(options) {
  fillSelect("#filter-employee", options.employees || [], "All employees");
  fillSelect("#filter-jobcode-1", options.jobcode_level1 || [], "All Job Code 1");
  fillSelect("#filter-service-item", (options.service_items || []).map((name) => ({ id: name, name })), "All service items");
  refreshDependentJobFilters();
}

function updateDatasetIndicator() {
  const indicator = $("#dataset-indicator");
  if (!indicator) return;
  const selected = availableDatasets.find((row) => row.id === ($("#filter-dataset")?.value || ""));
  if (!selected) {
    indicator.classList.add("hidden");
    indicator.textContent = "";
    return;
  }
  indicator.textContent = `Viewing dataset: ${selected.name} (${formatNumber(selected.record_count)} records)`;
  indicator.classList.remove("hidden");
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
            label: (item) => `${item.dataset.label}: ${formatNumber(item.parsed?.x ?? item.parsed?.y ?? item.raw)}`,
          },
        },
      },
      scales: {
        x: { beginAtZero: isBar, ticks: { maxRotation: 0, autoSkip: true, color: "#475467", callback: isBar ? numberTick : shortTick }, grid: { display: false } },
        y: { beginAtZero: !isBar, ticks: { color: "#475467", callback: isBar ? shortTick : numberTick }, grid: { color: "#eef2f7" } },
      },
    },
  }));
}

function renderEmployeeExperience(rows) {
  setText("#employee-experience-summary", rows.length ? `${formatNumber(rows.length)} matching employees` : "No matching employees");
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
  setText("#experience-detail-summary", rows.length ? `${formatNumber(rows.length)} employee, job, and service combinations` : "No matching experience rows");
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

function normalizeExperienceRollup(data = {}) {
  const employeeRows = data.employee_experience || data.hours_by_employee || [];
  const detailRows = data.experience_rows || [];
  const serviceRows = data.hours_by_service_item || [];
  const jobRows = data.hours_by_jobcode || [];
  const dayRows = data.hours_by_day || [];
  const employeeNames = distinctValues([...employeeRows, ...detailRows], "employee");
  const serviceNames = distinctValues([...serviceRows, ...detailRows], "service_item").filter((name) => name && name !== "No service item");
  return {
    ...data,
    employee_experience: employeeRows,
    experience_rows: detailRows,
    hours_by_employee: data.hours_by_employee || employeeRows,
    hours_by_jobcode: jobRows,
    hours_by_service_item: serviceRows,
    hours_by_day: dayRows,
    filtered_hours: numeric(data.filtered_hours ?? firstPositive(sumValues(dayRows, "hours"), sumValues(employeeRows, "hours"), sumValues(detailRows, "hours"))),
    filtered_employees: numeric(data.filtered_employees ?? employeeNames.length),
    filtered_service_items: numeric(data.filtered_service_items ?? serviceNames.length),
    filtered_timesheets: numeric(data.filtered_timesheets ?? sumValues(employeeRows, "timesheets") ?? detailRows.length),
  };
}

async function buildClientCoverageSummary() {
  if (!availableDatasets.length) return null;
  const datasetIds = availableDatasets.map((dataset) => dataset.id);
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("records")
      .select("id,dataset_id,json_data,source_hash,created_at")
      .in("dataset_id", datasetIds)
      .range(from, from + pageSize - 1);
    if (error) {
      console.warn("Dashboard fallback summary failed", error);
      return null;
    }
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return summarizeRecords(rows);
}

function summarizeRecords(rows) {
  const unique = new Map();
  for (const row of rows || []) {
    unique.set(row.source_hash || row.id, row);
  }
  const records = Array.from(unique.values());
  const employees = new Set();
  const services = new Set();
  const byDataset = new Map();
  const byDay = new Map();
  let hours = 0;

  for (const row of records) {
    const normalized = normalizeRecord(row);
    if (normalized.employee) employees.add(normalized.employee);
    if (normalized.serviceItem) services.add(normalized.serviceItem);
    hours += normalized.hours;
    const dataset = availableDatasets.find((item) => item.id === row.dataset_id);
    const datasetName = dataset?.name || "Unknown dataset";
    byDataset.set(datasetName, (byDataset.get(datasetName) || 0) + 1);
    if (normalized.date) byDay.set(normalized.date, (byDay.get(normalized.date) || 0) + 1);
  }

  return {
    dataset_name: null,
    raw_records: rows.length,
    unique_records: records.length,
    duplicates_removed: Math.max(rows.length - records.length, 0),
    dataset_count: new Set(records.map((row) => row.dataset_id)).size,
    employee_count: employees.size,
    service_item_count: services.size,
    hours: roundNumber(hours),
    records_by_dataset: Array.from(byDataset, ([name, records]) => ({ name, records })).sort((a, b) => b.records - a.records),
    records_by_day: Array.from(byDay, ([date, records]) => ({ date, records })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function normalizeRecord(row) {
  const data = row.json_data || {};
  const firstName = data.fname || data.first_name || data.firstName || "";
  const lastName = data.lname || data.last_name || data.lastName || "";
  const employee = [
    data.employee_name,
    data.employee,
    `${firstName} ${lastName}`.trim(),
    data.username,
    data.user_name,
    data.user_id,
    data.employee_number,
    data.email,
  ].find((value) => String(value || "").trim());
  const serviceItem = [
    data["service item"],
    data.service_item,
    data.serviceItem,
    data.service,
  ].find((value) => String(value || "").trim() && String(value).trim() !== "No service item");
  const seconds = numeric(data.duration_seconds ?? data.duration);
  const hours = numeric(data.hours ?? data.Hours ?? data.total_hours ?? data.totalHours ?? (seconds ? seconds / 3600 : 0));
  const date = String(data.local_date || data.date || data.start_date || data.created_at || row.created_at || "").slice(0, 10);
  return {
    employee: employee ? String(employee).trim() : "",
    serviceItem: serviceItem ? String(serviceItem).trim() : "",
    hours,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
  };
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

function numeric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function roundNumber(value) {
  return Math.round(numeric(value) * 100) / 100;
}

function sumValues(rows, key) {
  if (!rows?.length) return 0;
  return rows.reduce((total, row) => total + numeric(row[key]), 0);
}

function firstPositive(...values) {
  return values.find((value) => numeric(value) > 0) || 0;
}

function distinctValues(rows, key) {
  return Array.from(new Set((rows || []).map((row) => String(row[key] || "").trim()).filter(Boolean)));
}

function formatDate(value) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : "-";
}

function dateTimeValue(selector, endOfDay = false) {
  const value = $(selector)?.value;
  if (!value) return null;
  return `${value}T${endOfDay ? "23:59:59" : "00:00:00"}`;
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

function isSchemaCacheError(error) {
  return /schema cache|could not find the function/i.test(error?.message || "");
}

function scopeSummary(data) {
  const scope = data.dataset_name || "All authorized datasets";
  const duplicateText = Number(data.duplicates_removed || 0)
    ? ` ${formatNumber(data.duplicates_removed)} duplicate rows excluded.`
    : " No duplicate rows found.";
  return `${scope}: ${formatNumber(data.unique_records)} unique records from ${formatNumber(data.raw_records)} raw rows across ${formatNumber(data.dataset_count)} dataset${Number(data.dataset_count) === 1 ? "" : "s"}.${duplicateText}`;
}
