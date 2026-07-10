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
  renderAnomalyInsights(data);

  renderChart("#anomalies-by-employee", "bar", data.by_employee || [], "employee", "anomalies", "Flags");
  renderChart("#anomalies-by-reason", "bar", data.by_reason || [], "reason", "count", "Flags");
  renderChart("#anomalies-by-service", "bar", data.by_service_item || [], "service_item", "anomalies", "Flags");

  renderRows($("#anomaly-results-body"), lastAnomalies, [
    (r) => `<span class="status ${severityClass(r.severity)}">${escapeHtml(priorityLabel(r.severity))}</span>`,
    (r) => escapeHtml(r.employee),
    (r) => escapeHtml(r.reason),
    (r) => escapeHtml(detailJobcodeLabel(r, 1)),
    (r) => escapeHtml(detailJobcodeLabel(r, 2)),
    (r) => escapeHtml(detailJobcodeLabel(r, 3)),
    (r) => escapeHtml(displayServiceLabel(r.service_item)),
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

function detailJobcodeLabel(row, level) {
  const level1 = cleanJobcodeLabel(row?.jobcode_level1);
  const level2 = cleanJobcodeLabel(row?.jobcode_level2);
  const level3 = cleanJobcodeLabel(row?.jobcode_level3);
  const jobcode = cleanJobcodeLabel(row?.jobcode);
  if (level === 1) return level1 || jobcode || "Unassigned job code";
  if (level === 2) return level2 || (jobcode && jobcode !== level1 ? jobcode : "Not specified");
  return level3 || (jobcode && jobcode !== level2 && jobcode !== level1 ? jobcode : "Not specified");
}

function cleanServiceLabel(value) {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (!label || /^null$/i.test(label) || /^undefined$/i.test(label)) return null;
  return label;
}

function displayServiceLabel(value) {
  return cleanServiceLabel(value) || "No service item";
}

function renderChart(selector, type, rows, labelKey, valueKey, label) {
  const canvas = $(selector);
  if (!canvas || !window.Chart) return;
  charts.get(selector)?.destroy();
  const dataRows = Array.isArray(rows) && rows.length ? rows : [{ [labelKey]: "No data", [valueKey]: 0 }];
  const isBar = type === "bar";
  const palette = chartPalette();
  prepareChartFrame(canvas, type, dataRows, labelKey);
  const context = canvas.getContext("2d");
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
      layout: { padding: { top: 4, right: 12, bottom: 4, left: 4 } },
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
        x: {
          beginAtZero: true,
          ticks: { color: palette.tick, callback: isBar ? numberTick : shortTick, maxRotation: 0, autoSkip: !isBar },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { color: palette.tick, callback: isBar ? barLabelTick : numberTick, autoSkip: false, font: { size: 12 } },
          grid: { color: palette.grid },
        },
      },
    },
  }));
}

function prepareChartFrame(canvas, type, rows, labelKey) {
  const panel = canvas.closest(".chart-panel");
  const scroll = ensureChartScroll(canvas);
  const frame = canvas.parentElement;
  const panelWidth = Math.max(320, Math.floor((panel?.clientWidth || scroll?.clientWidth || 720) - 36));
  const labels = (rows || []).map((row) => String(row[labelKey] || ""));
  const longestLabel = labels.reduce((max, value) => Math.max(max, value.length), 0);
  const rowCount = Math.max(1, rows?.length || 0);
  const isBar = type === "bar";
  const isTall = panel?.classList.contains("tall-chart");
  const isWide = panel?.classList.contains("wide-chart");
  const baseHeight = isWide ? 560 : isTall ? 420 : 300;
  const rowHeight = isWide ? 36 : 34;
  const height = isBar ? Math.max(baseHeight, Math.min(isWide ? 960 : 780, rowCount * rowHeight + 90)) : baseHeight;
  const widthFromLabels = panelWidth + Math.max(0, longestLabel - 24) * 11;
  const widthFromPoints = type === "line" ? Math.max(panelWidth, rowCount * 54) : widthFromLabels;
  const maxWidth = isWide ? 2400 : 1800;
  frame.style.height = `${height}px`;
  frame.style.minWidth = `${Math.min(maxWidth, Math.max(panelWidth, widthFromPoints))}px`;
}

function ensureChartScroll(canvas) {
  if (canvas.parentElement?.classList.contains("chart-frame")) return canvas.parentElement.parentElement;
  const parent = canvas.parentElement;
  if (!parent) return null;
  const scroll = document.createElement("div");
  const frame = document.createElement("div");
  scroll.className = "chart-scroll";
  frame.className = "chart-frame";
  parent.insertBefore(scroll, canvas);
  scroll.appendChild(frame);
  frame.appendChild(canvas);
  return scroll;
}

function renderAnomalyInsights(data = {}) {
  const summaryEl = $("#anomaly-insight-summary");
  const cards = $("#anomaly-insight-cards");
  const recommendations = $("#anomaly-recommendations");
  if (!summaryEl && !cards && !recommendations) return;

  const summary = data.summary || {};
  const anomalies = data.anomalies || [];
  const totalAnomalies = Number(summary.total_anomalies || anomalies.length || 0);
  const highAnomalies = Number(summary.high_anomalies || anomalies.filter((row) => row.severity === "high").length || 0);
  const employees = Number(summary.employees_with_anomalies || distinctCount(anomalies, "employee"));
  const combos = Number(summary.combos_analyzed || 0);
  const topEmployee = topRow(data.by_employee || [], "employee", "anomalies");
  const topService = topRow(data.by_service_item || [], "service_item", "anomalies");
  const topReason = topRow(data.by_reason || [], "reason", "count");
  const highShare = totalAnomalies ? (highAnomalies / totalAnomalies) * 100 : 0;

  setText("#anomaly-insight-summary", totalAnomalies
    ? `${formatNumber(totalAnomalies)} rare combinations found across ${formatNumber(employees)} employee${employees === 1 ? "" : "s"}${dateRangeLabel(summary)}.`
    : "Run detection to generate anomaly insights.");

  if (cards) {
    cards.innerHTML = [
      insightCard("Highest priority", highAnomalies ? formatNumber(highAnomalies) : "0", `${formatNumber(highShare)}% of rare combos are high priority`),
      insightCard("Top employee", topEmployee.label || "-", topEmployee.label ? `${formatNumber(topEmployee.value)} rare combos` : "No employee flags yet"),
      insightCard("Top service", topService.label || "-", topService.label ? `${formatNumber(topService.value)} rare combos` : "No service flags yet"),
      insightCard("Top reason", topReason.label || "-", topReason.label ? `${formatNumber(topReason.value)} flags` : "No reason flags yet"),
    ].join("");
  }

  if (recommendations) {
    const items = [];
    if (!totalAnomalies) {
      items.push({ tone: "warn", text: "No anomaly graphics are available yet. Run detection or widen the filters to populate the charts." });
    }
    if (highShare >= 40) {
      items.push({ tone: "warn", text: `${formatNumber(highShare)}% of detected combinations are high priority. Review these before using the full list operationally.` });
    }
    if (topEmployee.label && totalAnomalies && topEmployee.value / totalAnomalies >= 0.35) {
      items.push({ tone: "", text: `${topEmployee.label} accounts for ${formatNumber((topEmployee.value / totalAnomalies) * 100)}% of rare combos. Start review there before scanning the whole table.` });
    }
    if (topService.label && totalAnomalies && topService.value / totalAnomalies >= 0.35) {
      items.push({ tone: "", text: `${topService.label} is driving ${formatNumber((topService.value / totalAnomalies) * 100)}% of rare service flags. Check whether the service mapping changed or is miscoded.` });
    }
    if (combos && totalAnomalies && totalAnomalies / combos < 0.02) {
      items.push({ tone: "ok", text: "The anomaly rate is low relative to combinations analyzed, so the current thresholds look selective." });
    }
    if (!items.length) {
      items.push({ tone: "ok", text: "No major concentration pattern stands out in the current anomaly results." });
    }
    recommendations.innerHTML = items.map((item) => `<li class="${escapeHtml(item.tone)}">${escapeHtml(item.text)}</li>`).join("");
  }
}

function insightCard(label, value, detail) {
  return `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(detail)}</small></div>`;
}

function topRow(rows, labelKey, valueKey) {
  const top = (rows || []).reduce((winner, row) => Number(row[valueKey] || 0) > Number(winner?.[valueKey] || 0) ? row : winner, null);
  return { label: top ? String(top[labelKey] || "") : "", value: Number(top?.[valueKey] || 0) };
}

function distinctCount(rows, key) {
  return new Set((rows || []).map((row) => String(row[key] || "").trim()).filter(Boolean)).size;
}

function chartPalette() {
  const isDark = document.documentElement.dataset.theme === "dark" || document.body.classList.contains("dark");
  return {
    primary: isDark ? "#60a5fa" : "#126c78",
    fill: isDark ? "rgba(96, 165, 250, .18)" : "rgba(18, 108, 120, .16)",
    tick: isDark ? "#cbd5e1" : "#475467",
    grid: isDark ? "rgba(148, 163, 184, .18)" : "#eef2f7",
    series: isDark
      ? ["#60a5fa", "#f87171", "#fbbf24", "#34d399", "#a78bfa", "#22d3ee", "#94a3b8"]
      : ["#126c78", "#dc2626", "#b54708", "#2563eb", "#7c3aed", "#15803d", "#475569"],
  };
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
  renderAnomalyInsights({ summary: {}, anomalies: [] });
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

function barLabelTick(value) {
  const label = this.getLabelForValue ? this.getLabelForValue(value) : String(value);
  return wrapChartLabel(label, 26, 3);
}

function wrapChartLabel(label, maxLength = 26, maxLines = 3) {
  const cleanLabel = String(label || "").replace(/\s+/g, " ").trim();
  if (cleanLabel.length <= maxLength) return cleanLabel;
  const words = cleanLabel.replace(/([/:_-])/g, "$1 ").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxLength) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > maxLength ? `${word.slice(0, maxLength - 3)}...` : word;
    if (lines.length === maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(" ").replace(/\.\.\.$/, "").length;
  if (used < cleanLabel.length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\.\.\.$/, "").slice(0, maxLength - 3)}...`;
  return lines;
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
