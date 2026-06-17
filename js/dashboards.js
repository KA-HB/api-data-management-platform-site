import { requireAuth, renderShell } from "./auth.js";
import { FUNCTIONS_BASE_URL } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { $, escapeHtml, renderRows, setButtonBusy, setText, startProgress, stopProgress, toast } from "./ui.js";

const profile = await requireAuth();
const charts = new Map();
let qbFilterOptions = null;
let availableDatasets = [];
let lastSummary = null;
let lastGeneralCoverage = null;

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
    $("#filter-employee")?.addEventListener("change", loadQbVisuals);
    $("#filter-start")?.addEventListener("change", loadQbVisuals);
    $("#filter-end")?.addEventListener("change", loadQbVisuals);
    $("#filter-service-item")?.addEventListener("change", loadQbVisuals);
    $("#filter-jobcode-1")?.addEventListener("change", () => {
      refreshDependentJobFilters();
      loadQbVisuals();
    });
    $("#filter-jobcode-2")?.addEventListener("change", () => {
      refreshDependentJobFilters();
      loadQbVisuals();
    });
    $("#filter-jobcode-3")?.addEventListener("change", loadQbVisuals);
    $("#filter-keyword")?.addEventListener("input", debounce(loadQbVisuals, 350));
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

    if (qbOptions?.data) {
      qbFilterOptions = qbOptions.data;
      populateQbFilters(qbFilterOptions);
    }

    lastSummary = summary;
    const experience = await callQbRollups(emptyQbPayload());
    lastGeneralCoverage = experience.data ? normalizeExperienceRollup(experience.data) : buildFastCoverageSummary(summary);
    renderGeneralDashboard(summary, lastGeneralCoverage);
    stopProgress(progress);

    if (profile.role === "admin" && $("#qb-viz-filters")) await loadQbVisuals();

    renderRecentUploads(isExperienceDashboard() ? summary.recent_uploads || [] : [...availableDatasets].sort((a, b) => Number(b.record_count || 0) - Number(a.record_count || 0)));
    renderRecentSyncs(summary.recent_syncs || []);
    renderRecentLogs(logs || []);
  } catch (error) {
    stopProgress(progress, `Error loading dashboard: ${error.message}`, "error");
  }
}

function renderGeneralDashboard(summary, coverage) {
  const hasNoUserDatasets = profile.role !== "admin" && numeric(summary?.datasets) === 0;
  setText("#metric-datasets", formatNumber(summary?.datasets));
  setText("#metric-keys", formatNumber(summary?.api_keys));
  setText("#metric-raw-records", formatNumber(coverage?.raw_records ?? summary?.records));
  setText("#metric-records", formatNumber(coverage?.unique_records ?? summary?.records));
  setText("#metric-hours", formatNumber(coverage?.filtered_hours ?? coverage?.hours));
  setText("#metric-employees", formatNumber(coverage?.filtered_employees ?? coverage?.employee_count));
  setText("#metric-services", formatNumber(coverage?.filtered_service_items ?? coverage?.service_item_count));
  setText("#data-scope-summary", hasNoUserDatasets ? "No dashboard datasets are assigned to this user yet. An admin can grant QuickBooks Time dashboard access from User Management." : coverage ? scopeSummary(coverage) : `Showing ${formatNumber(summary?.records)} authorized records. Full-year hours, employees, service-item totals, and duplicate removal require the latest Supabase search migration.`);

  renderChart("#records-by-dataset", "bar", coverage?.records_by_dataset || summary?.records_by_dataset || [], "name", coverage ? "records" : "record_count", coverage ? "Unique Records" : "Records");
  renderChart("#records-over-time", "line", coverage?.records_by_day || summary?.records_by_day || [], "date", "records", coverage ? "Unique Records" : "Records");
  renderChart("#activity-over-time", "line", summary?.activity_by_day || [], "date", "events", "Events");
}

function buildFastCoverageSummary(summary) {
  const rows = availableDatasets.length ? availableDatasets : summary?.recent_uploads || [];
  const nonPtoRows = rows.filter((row) => !/pto/i.test(row.name || ""));
  const rawRecords = nonPtoRows.reduce((total, row) => total + numeric(row.record_count), 0);
  return {
    is_fast_fallback: true,
    raw_records: rawRecords || summary?.records || 0,
    unique_records: rawRecords || summary?.records || 0,
    duplicates_removed: null,
    dataset_count: nonPtoRows.length || summary?.datasets || 0,
    employee_count: 0,
    service_item_count: 0,
    hours: 0,
    filtered_employees: 0,
    filtered_service_items: 0,
    filtered_hours: 0,
    records_by_dataset: nonPtoRows.map((row) => ({ name: row.name, records: numeric(row.record_count) })).sort((a, b) => b.records - a.records),
    records_by_day: summary?.records_by_day || [],
  };
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
  const experience = await callQbRollups(payload);
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
  renderChart("#records-by-dataset", "bar", normalized.records_by_dataset || [], "name", "records", "Unique Records");
  renderChart("#records-over-time", "line", normalized.records_by_day || [], "date", "records", "Unique Records");

  setText("#metric-raw-records", formatNumber(normalized.raw_records ?? normalized.filtered_timesheets));
  setText("#metric-records", formatNumber(normalized.unique_records ?? normalized.filtered_timesheets));
  setText("#metric-hours", formatNumber(normalized.filtered_hours));
  setText("#metric-employees", formatNumber(normalized.filtered_employees));
  setText("#metric-services", formatNumber(normalized.filtered_service_items));
  setText("#qb-filter-summary", `${formatNumber(normalized.filtered_timesheets)} experience records, ${formatNumber(normalized.filtered_hours)} hours${dateRangeLabel(normalized)}`);
  setText("#data-scope-summary", scopeSummary(normalized));

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
  const result = await callQbRollupOnce(payload);
  if (!shouldExpandJobcodeFilter(payload, result.data, result.error)) return result;

  const expandedPayloads = expandedJobcodePayloads(payload);
  if (!expandedPayloads.length) return result;

  const expandedResults = await callExpandedQbRollups(expandedPayloads);
  if (expandedResults.error) return result;
  if (!numeric(expandedResults.data?.filtered_timesheets)) return result;
  return expandedResults;
}

async function callQbRollupOnce(payload) {
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

function shouldExpandJobcodeFilter(payload, data, error) {
  if (error) return false;
  const hasJobcodeFilter = Boolean(payload.jobcode_level1_filter || payload.jobcode_level2_filter || payload.jobcode_level3_filter);
  return hasJobcodeFilter && numeric(data?.filtered_timesheets) === 0;
}

async function callExpandedQbRollups(payloads) {
  const results = [];
  for (let index = 0; index < payloads.length; index += 8) {
    const batch = payloads.slice(index, index + 8);
    const settled = await Promise.all(batch.map((payload) => callQbRollupOnce(payload)));
    const errorResult = settled.find((result) => result.error);
    if (errorResult) return errorResult;
    results.push(...settled.map((result) => result.data).filter(Boolean));
  }
  return { data: mergeQbRollupData(results), error: null };
}

function expandedJobcodePayloads(payload) {
  if (!qbFilterOptions) return [];
  const base = { ...payload, jobcode_level1_filter: null, jobcode_level2_filter: null, jobcode_level3_filter: null };
  const level2Rows = qbFilterOptions.jobcode_level2 || [];
  const level3Rows = qbFilterOptions.jobcode_level3 || [];
  const payloads = new Map();

  const addPayload = (levelKey, rowOrValue) => {
    const value = typeof rowOrValue === "object" ? rowOrValue?.id : rowOrValue;
    const filter = String(value || "").trim();
    if (!filter) return;
    const nextPayload = { ...base, [levelKey]: filter };
    payloads.set(`${levelKey}:${filter}`, nextPayload);
  };

  if (payload.jobcode_level3_filter) {
    for (const row of matchingRows(level3Rows, payload.jobcode_level3_filter)) addPayload("jobcode_level3_filter", row);
    if (!payloads.size) addPayload("jobcode_level3_filter", payload.jobcode_level3_filter);
    return Array.from(payloads.values());
  }

  if (payload.jobcode_level2_filter) {
    const children = level3Rows.filter((row) => optionMatches(row, payload.jobcode_level2_filter, ["parent_id", "parent_name"]));
    for (const row of children) addPayload("jobcode_level3_filter", row);
    for (const row of matchingRows(level2Rows, payload.jobcode_level2_filter)) addPayload("jobcode_level2_filter", row);
    if (!payloads.size) addPayload("jobcode_level2_filter", payload.jobcode_level2_filter);
    return Array.from(payloads.values());
  }

  if (payload.jobcode_level1_filter) {
    const children = level2Rows.filter((row) => optionMatches(row, payload.jobcode_level1_filter, ["parent_id", "parent_name"]));
    const descendants = level3Rows.filter((row) => optionMatches(row, payload.jobcode_level1_filter, ["grandparent_id", "grandparent_name"]));
    for (const row of children) addPayload("jobcode_level2_filter", row);
    for (const row of descendants) addPayload("jobcode_level3_filter", row);
    if (!payloads.size) addPayload("jobcode_level1_filter", payload.jobcode_level1_filter);
  }

  return Array.from(payloads.values());
}

function matchingRows(rows, value) {
  return rows.filter((row) => optionMatches(row, value, ["id", "name"]));
}

function optionMatches(row, value, keys) {
  const selected = String(value || "").trim();
  return Boolean(selected && keys.some((key) => String(row?.[key] || "").trim() === selected));
}

function mergeQbRollupData(results) {
  const merged = {
    hours_by_employee: mergeRows(results, "hours_by_employee", (row) => row.employee, {
      hours: "sum",
      timesheets: "sum",
    }),
    hours_by_jobcode: mergeRows(results, "hours_by_jobcode", (row) => projectLabel(row.jobcode), {
      hours: "sum",
    }).map((row) => ({ jobcode: row.key, hours: row.hours })),
    hours_by_service_item: mergeRows(results, "hours_by_service_item", (row) => row.service_item, {
      hours: "sum",
    }),
    hours_by_day: mergeRows(results, "hours_by_day", (row) => row.date, {
      hours: "sum",
    }),
    records_by_dataset: mergeRows(results, "records_by_dataset", (row) => row.name, {
      records: "sum",
    }),
    records_by_day: mergeRows(results, "records_by_day", (row) => row.date, {
      records: "sum",
    }),
    experience_rows: mergeExperienceRows(results),
  };

  merged.employee_experience = mergeEmployeeExperience(results);
  merged.filtered_timesheets = sumResults(results, "filtered_timesheets");
  merged.filtered_hours = roundValue(sumResults(results, "filtered_hours"));
  merged.filtered_employees = distinctValues(merged.employee_experience, "employee").length;
  merged.filtered_service_items = distinctValues(merged.hours_by_service_item, "service_item").filter((name) => name && name !== "No service item").length;
  merged.filtered_jobcodes = distinctValues(merged.experience_rows, "jobcode").filter((name) => name && name !== "Unassigned").length || distinctValues(merged.hours_by_jobcode, "jobcode").length;
  merged.raw_records = sumResults(results, "raw_records") || merged.filtered_timesheets;
  merged.unique_records = sumResults(results, "unique_records") || merged.filtered_timesheets;
  merged.duplicates_removed = sumResults(results, "duplicates_removed");
  merged.dataset_count = Math.max(...results.map((data) => numeric(data.dataset_count)), 0);
  merged.date_start = minDate(results.map((data) => data.date_start));
  merged.date_end = maxDate(results.map((data) => data.date_end));

  merged.hours_by_employee = limitRows(merged.hours_by_employee, "hours", 15);
  merged.hours_by_jobcode = limitRows(merged.hours_by_jobcode, "hours", 15);
  merged.hours_by_service_item = limitRows(merged.hours_by_service_item, "hours", 15);
  merged.records_by_dataset = limitRows(merged.records_by_dataset, "records", 12);
  merged.employee_experience = limitRows(merged.employee_experience, "hours", 50);
  merged.experience_rows = limitRows(merged.experience_rows, "hours", 100);
  return merged;
}

function mergeRows(results, property, keyFn, numericFields) {
  const rows = new Map();
  for (const data of results) {
    for (const row of data?.[property] || []) {
      const key = String(keyFn(row) || "").trim() || "Unassigned";
      const current = rows.get(key) || { ...row, key };
      for (const [field, mode] of Object.entries(numericFields)) {
        if (mode === "sum") current[field] = roundValue(numeric(current[field]) + numeric(row[field]));
      }
      rows.set(key, current);
    }
  }
  return Array.from(rows.values());
}

function mergeEmployeeExperience(results) {
  const rows = mergeRows(results, "employee_experience", (row) => row.employee, {
    hours: "sum",
    timesheets: "sum",
  });
  for (const row of rows) {
    const matches = results.flatMap((data) => data?.experience_rows || []).filter((detail) => detail.employee === row.employee);
    row.jobcodes = distinctValues(matches, "jobcode").filter((value) => value && value !== "Unassigned").length || numeric(row.jobcodes);
    row.service_items = distinctValues(matches, "service_item").filter((value) => value && value !== "No service item").length || numeric(row.service_items);
    row.first_work = minDate(matches.map((detail) => detail.first_work).concat(row.first_work));
    row.last_work = maxDate(matches.map((detail) => detail.last_work).concat(row.last_work));
  }
  return rows;
}

function mergeExperienceRows(results) {
  const rows = new Map();
  for (const data of results) {
    for (const row of data?.experience_rows || []) {
      const key = [
        row.employee,
        row.jobcode_level1,
        row.jobcode_level2,
        row.jobcode_level3,
        row.jobcode,
        row.service_item,
      ].map((value) => String(value || "").trim()).join("|");
      const current = rows.get(key) || { ...row, hours: 0, timesheets: 0 };
      current.hours = roundValue(numeric(current.hours) + numeric(row.hours));
      current.timesheets = numeric(current.timesheets) + numeric(row.timesheets);
      current.first_work = minDate([current.first_work, row.first_work]);
      current.last_work = maxDate([current.last_work, row.last_work]);
      rows.set(key, current);
    }
  }
  return Array.from(rows.values());
}

function sumResults(results, key) {
  return roundValue(results.reduce((total, data) => total + numeric(data?.[key]), 0));
}

function limitRows(rows, sortKey, limit) {
  return [...rows].sort((a, b) => numeric(b[sortKey]) - numeric(a[sortKey])).slice(0, limit);
}

function roundValue(value) {
  return Math.round(numeric(value) * 100) / 100;
}

function minDate(values) {
  const dates = values.filter(Boolean).sort();
  return dates[0] || null;
}

function maxDate(values) {
  const dates = values.filter(Boolean).sort();
  return dates[dates.length - 1] || null;
}

async function callSearchSummary() {
  const result = await supabase.rpc("search_records_summary", searchSummaryPayload());
  if (!isSchemaCacheError(result.error)) return result;
  return { data: null, error: null };
}

function emptyQbPayload() {
  return {
    dataset_uuid: null,
    keyword_filter: null,
    employee_filter: null,
    start_date: null,
    end_date: null,
    jobcode_level1_filter: null,
    jobcode_level2_filter: null,
    jobcode_level3_filter: null,
    service_item_filter: null,
  };
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
  const selectedLevel3 = $("#filter-jobcode-3")?.value || "";
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
  if (selectedLevel3 && level3.some((row) => row.id === selectedLevel3)) $("#filter-jobcode-3").value = selectedLevel3;
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
  const palette = chartPalette();
  charts.set(selector, new Chart(context, {
    type,
    data: {
      labels: dataRows.map((row) => String(row[labelKey] ?? "")),
      datasets: [{
        label,
        data: dataRows.map((row) => Number(row[valueKey] || 0)),
        borderColor: palette.primary,
        backgroundColor: type === "line" ? palette.fill : palette.series,
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
        x: { beginAtZero: isBar, ticks: { maxRotation: 0, autoSkip: true, color: palette.tick, callback: isBar ? numberTick : shortTick }, grid: { display: false } },
        y: { beginAtZero: !isBar, ticks: { color: palette.tick, callback: isBar ? shortTick : numberTick }, grid: { color: palette.grid } },
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
  const employeeRows = (data.employee_experience || data.hours_by_employee || []).filter(hasNamedEmployee);
  const detailRows = (data.experience_rows || []).filter(hasNamedEmployee);
  const serviceRows = data.hours_by_service_item || [];
  const jobRows = normalizeProjectHours(data.hours_by_jobcode || []);
  const dayRows = data.hours_by_day || [];
  const employeeNames = distinctValues([...employeeRows, ...detailRows], "employee");
  const serviceNames = distinctValues([...serviceRows, ...detailRows], "service_item").filter((name) => name && name !== "No service item");
  return {
    ...data,
    employee_experience: employeeRows,
    experience_rows: detailRows,
    hours_by_employee: employeeRows,
    hours_by_jobcode: jobRows,
    hours_by_service_item: serviceRows,
    hours_by_day: dayRows,
    records_by_dataset: data.records_by_dataset || [],
    records_by_day: data.records_by_day || [],
    raw_records: numeric(data.raw_records ?? data.filtered_timesheets),
    unique_records: numeric(data.unique_records ?? data.filtered_timesheets),
    dataset_count: numeric(data.dataset_count),
    duplicates_removed: numeric(data.duplicates_removed),
    filtered_hours: numeric(data.filtered_hours ?? firstPositive(sumValues(dayRows, "hours"), sumValues(employeeRows, "hours"), sumValues(detailRows, "hours"))),
    filtered_employees: numeric(data.filtered_employees ?? employeeNames.length),
    filtered_service_items: numeric(data.filtered_service_items ?? serviceNames.length),
    filtered_timesheets: numeric(data.filtered_timesheets ?? sumValues(employeeRows, "timesheets") ?? detailRows.length),
  };
}

function hasNamedEmployee(row) {
  const employee = String(row?.employee || "").trim();
  return Boolean(employee && employee !== "Unassigned" && !/^[0-9]+$/.test(employee));
}

function normalizeProjectHours(rows) {
  const totals = new Map();
  for (const row of rows || []) {
    const project = projectLabel(row.jobcode);
    totals.set(project, (totals.get(project) || 0) + numeric(row.hours));
  }
  return Array.from(totals.entries())
    .map(([jobcode, hours]) => ({ jobcode, hours }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 15);
}

function projectLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Unassigned";
  const options = qbFilterOptions || {};
  const level1 = options.jobcode_level1 || [];
  const level2 = options.jobcode_level2 || [];
  const level3 = options.jobcode_level3 || [];
  const directLevel1 = level1.find((row) => row.id === raw || row.name === raw);
  if (directLevel1) return directLevel1.name;
  const directLevel2 = level2.find((row) => row.id === raw || row.name === raw);
  if (directLevel2) return directLevel2.parent_name || directLevel2.parent_id || directLevel2.name;
  const directLevel3 = level3.find((row) => row.id === raw || row.name === raw);
  if (directLevel3) return directLevel3.grandparent_name || directLevel3.grandparent_id || directLevel3.parent_name || directLevel3.name;
  const firstPathPart = raw.split("/").map((part) => part.trim()).find(Boolean);
  return firstPathPart || raw;
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

function chartPalette() {
  const isDark = document.documentElement.dataset.theme === "dark" || document.body.classList.contains("dark");
  return {
    primary: isDark ? "#60a5fa" : "#2563eb",
    fill: isDark ? "rgba(96, 165, 250, .18)" : "rgba(37, 99, 235, .16)",
    tick: isDark ? "#cbd5e1" : "#475467",
    grid: isDark ? "rgba(148, 163, 184, .18)" : "#eef2f7",
    series: isDark
      ? ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#22d3ee", "#a78bfa", "#94a3b8"]
      : ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#7c3aed", "#475569"],
  };
}

function isSchemaCacheError(error) {
  return /schema cache|could not find the function/i.test(error?.message || "");
}

function debounce(fn, delay) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

function scopeSummary(data) {
  if (data.is_fast_fallback) {
    return `Showing ${formatNumber(data.unique_records)} records across ${formatNumber(data.dataset_count)} dataset${Number(data.dataset_count) === 1 ? "" : "s"} from dataset metadata. Experience totals will update after the dashboard rollup finishes refreshing.`;
  }
  const scope = data.dataset_name || "All authorized datasets";
  const duplicateText = Number(data.duplicates_removed || 0)
    ? ` ${formatNumber(data.duplicates_removed)} duplicate rows excluded.`
    : " No duplicate rows found.";
  return `${scope}: ${formatNumber(data.unique_records)} unique records from ${formatNumber(data.raw_records)} raw rows across ${formatNumber(data.dataset_count)} dataset${Number(data.dataset_count) === 1 ? "" : "s"}.${duplicateText}`;
}
