import { requireAuth, renderShell } from "./auth.js?v=20260814a";
import { $, escapeHtml, setButtonBusy, toast } from "./ui.js";

const REQUIRED_COLUMNS = ["Projects Data", "Billing Status", "AR-PENDING", "Name", "Submission Date", "AR-RECEIVED"];
const INVOICE_COLUMNS = ["Project", "Job Code 1", "Job Code 2", "Billing Status", "# Total Late Invoices", "Pending Amount", "Total Late Amount", "Day Submitted", "Date Late", "Days Late", "Responsible Staff", "Date of Update", "Communication Outcome"];
const EXPENSE_COLUMNS = ["Project", "Month", "Job Code 1", "Job Code 2", "Total Late Amount"];
let sourceRows = [];
let sourceHeaders = [];
let previousRows = [];

const profile = await requireAuth("admin");
if (profile) {
  renderShell(profile);
  $("#ar-aging-form")?.addEventListener("submit", loadWorkbook);
  $("#generate-ar-report")?.addEventListener("click", generateReport);
  $("#clear-ar-workbook")?.addEventListener("click", clearWorkspace);
}

async function loadWorkbook(event) {
  event.preventDefault();
  const file = $("#ar-aging-file").files[0];
  const previousFile = $("#previous-ar-aging-file").files[0];
  if (!file) return toast("Choose an AR workbook.", "error");
  const button = event.submitter;
  setButtonBusy(button, true, "Reading...");
  try {
    sourceRows = await parseFile(file);
    previousRows = previousFile ? await parseFile(previousFile, { preferredSheetName: "Invoice Detail" }) : [];
    sourceHeaders = sourceRows.length ? Object.keys(sourceRows[0]) : [];
    if (!sourceRows.length) throw new Error("No rows were found in the first worksheet.");
    renderMappings();
    renderPreview();
    $("#ar-column-panel").classList.remove("hidden");
    $("#ar-preview-panel").classList.remove("hidden");
    const previousStatus = previousFile ? ` Previous comments loaded from ${previousFile.name}.` : "";
    setStatus(`${file.name}: ${sourceRows.length.toLocaleString()} rows ready.${previousStatus} Nothing was uploaded.`, "success");
  } catch (error) {
    clearData();
    setStatus(error.message || "The workbook could not be read.", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function parseFile(file, { preferredSheetName = "" } = {}) {
  if (file.name.toLowerCase().endsWith(".csv")) {
    return new Promise((resolve, reject) => Papa.parse(file, { header: true, skipEmptyLines: true, complete: (result) => resolve(result.data), error: reject }));
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const sheetName = preferredSheetName && workbook.SheetNames.includes(preferredSheetName) ? preferredSheetName : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
}

function renderMappings() {
  $("#ar-column-mappings").innerHTML = REQUIRED_COLUMNS.map((field) => {
    const suggested = findSuggestedHeader(field);
    const options = [`<option value="">Choose column</option>`, ...sourceHeaders.map((header) => `<option value="${escapeHtml(header)}"${header === suggested ? " selected" : ""}>${escapeHtml(header)}</option>`)].join("");
    return `<label>${escapeHtml(field)}<select data-ar-field="${escapeHtml(field)}">${options}</select></label>`;
  }).join("");
  $("#ar-column-mappings").querySelectorAll("select").forEach((select) => select.addEventListener("change", renderPreview));
}

function findSuggestedHeader(field) {
  const exact = sourceHeaders.find((header) => header === field);
  if (exact) return exact;
  const normalized = normalize(field);
  return sourceHeaders.find((header) => normalize(header) === normalized) || "";
}

function currentMapping() {
  return Object.fromEntries([...document.querySelectorAll("[data-ar-field]")].map((select) => [select.dataset.arField, select.value]));
}

function buildReport() {
  const mapping = currentMapping();
  const missing = REQUIRED_COLUMNS.filter((field) => !mapping[field]);
  if (missing.length) throw new Error(`Choose columns for: ${missing.join(", ")}.`);
  const previousComments = buildPreviousComments();
  const asOf = new Date();
  let carriedCommentRows = 0;
  const details = [];
  sourceRows.forEach((row, index) => {
    const amount = numberValue(row[mapping["AR-PENDING"]]);
    if (!amount) return;
    const bucket = billingBucket(row[mapping["Billing Status"]]);
    if (bucket === "Other") return;
    const [job1, job2] = splitProject(row[mapping["Projects Data"]]);
    details.push({ project: String(row[mapping.Name] || "").trim() || "UNKNOWN", job1, job2, bucket, amount: Math.abs(amount), aging: invoiceAging(row[mapping["Submission Date"]], asOf), priority: bucketPriority(bucket), order: index });
  });
  const groups = new Map();
  details.forEach((detail) => { if (!groups.has(detail.job1)) groups.set(detail.job1, []); groups.get(detail.job1).push(detail); });
  const orderedGroups = [...groups.entries()].sort((a, b) => sum(b[1], "amount") - sum(a[1], "amount"));
  const invoiceDetail = [];
  orderedGroups.forEach(([job1, rows]) => {
    [...rows].sort((a, b) => a.priority - b.priority || b.amount - a.amount || a.order - b.order).forEach((row) => {
      const previous = previousComments.get(commentKey(row.project, row.job1, row.job2, row.amount)) || {};
      if (previous.dateOfUpdate || previous.communicationOutcome) carriedCommentRows += 1;
      invoiceDetail.push({ Project: row.project, "Job Code 1": row.job1, "Job Code 2": row.job2, "Billing Status": row.bucket, "Pending Amount": row.amount, "# Total Late Invoices": row.aging.daysLate === "" ? "" : Number(row.aging.daysLate > 0), "Total Late Amount": row.aging.daysLate === "" ? "" : row.aging.daysLate > 0 ? row.amount : 0, "Day Submitted": row.aging.submitted, "Date Late": row.aging.dateLate, "Days Late": row.aging.daysLate, "Responsible Staff": "", "Date of Update": previous.dateOfUpdate || "", "Communication Outcome": previous.communicationOutcome || "" });
    });
    invoiceDetail.push({ Project: `${job1} TOTAL`, "Job Code 1": job1, "Job Code 2": "", "Billing Status": "TOTAL", "Pending Amount": sum(rows, "amount"), "# Total Late Invoices": rows.filter((row) => row.aging.daysLate > 0).length, "Total Late Amount": sum(rows.filter((row) => row.aging.daysLate > 0), "amount"), "Day Submitted": "", "Date Late": "", "Days Late": "", "Responsible Staff": "", "Date of Update": "", "Communication Outcome": "" });
  });
  const expenses = sourceRows.map((row, index) => ({ row, index, received: numberValue(row[mapping["AR-RECEIVED"]]) })).filter((item) => item.received !== 0).map((item) => { const [job1, job2] = splitProject(item.row[mapping["Projects Data"]]); const submitted = item.row[mapping["Submission Date"]]; return { Project: submitted, Month: reportMonth(submitted), "Job Code 1": job1, "Job Code 2": job2, "Total Late Amount": Math.abs(item.received), order: item.index }; }).sort((a, b) => b["Total Late Amount"] - a["Total Late Amount"] || a.order - b.order).map(({ order, ...row }) => row);
  return { invalidDates: details.filter((row) => row.aging.daysLate === "").length, invoiceDetail, expenses, detailCount: details.length, pendingAmount: sum(details, "amount"), receivedAmount: sum(expenses, "Total Late Amount"), carriedCommentRows };
}

function buildPreviousComments() {
  if (!previousRows.length) return new Map();
  const headers = Object.keys(previousRows[0]);
  const projectHeader = findHeader(headers, ["Project"]);
  const job1Header = findHeader(headers, ["Job Code 1"]);
  const job2Header = findHeader(headers, ["Job Code 2"]);
  const amountHeader = findHeader(headers, ["Pending Amount"]) || findHeader(headers, ["Total Late Amount"]);
  const dateHeader = findHeader(headers, ["Date of Update"]);
  const outcomeHeader = findHeader(headers, ["Communication Outcome", "Column1"]);
  const missing = [[projectHeader, "Project"], [job1Header, "Job Code 1"], [job2Header, "Job Code 2"], [amountHeader, "Total Late Amount"]].filter(([header]) => !header).map(([, label]) => label);
  if (missing.length) throw new Error(`The previous AR report is missing matching columns: ${missing.join(", ")}.`);
  if (!dateHeader && !outcomeHeader) throw new Error("The previous AR report needs Date of Update, Communication Outcome, or the older Column1 field.");

  const comments = new Map();
  previousRows.forEach((row) => {
    const key = commentKey(row[projectHeader], row[job1Header], row[job2Header], row[amountHeader]);
    const current = comments.get(key) || {};
    const dateOfUpdate = dateHeader ? cellText(row[dateHeader]) : "";
    const communicationOutcome = outcomeHeader ? cellText(row[outcomeHeader]) : "";
    comments.set(key, {
      dateOfUpdate: dateOfUpdate || current.dateOfUpdate || "",
      communicationOutcome: communicationOutcome || current.communicationOutcome || "",
    });
  });
  return comments;
}

function findHeader(headers, names) {
  return headers.find((header) => names.some((name) => normalize(header) === normalize(name))) || "";
}

function commentKey(project, job1, job2, amount) {
  return [...[project, job1, job2].map((value) => normalizeKeyPart(value)), amountKey(amount)].join("|");
}

function renderPreview() {
  let report;
  try { report = buildReport(); } catch (error) { $("#ar-preview-summary").textContent = error.message; return; }
  $("#ar-source-rows").textContent = sourceRows.length.toLocaleString();
  $("#ar-invoice-rows").textContent = report.invoiceDetail.length.toLocaleString();
  $("#ar-expense-rows").textContent = report.expenses.length.toLocaleString();
  $("#ar-pending-total").textContent = currency(report.pendingAmount);
  const carryover = previousRows.length ? ` ${report.carriedCommentRows.toLocaleString()} rows matched previous comments.` : "";
  $("#ar-preview-summary").textContent = `${report.detailCount.toLocaleString()} invoice details plus project total rows; ${currency(report.receivedAmount)} AR received.${carryover} ${report.invalidDates ? `${report.invalidDates} invoice rows have missing or invalid submission dates; their late values are blank and excluded from late totals.` : ""}`;
  $("#ar-preview-body").innerHTML = report.invoiceDetail.slice(0, 10).map((row) => `<tr><td>${escapeHtml(row.Project)}</td><td>${escapeHtml(row["Job Code 1"])}</td><td>${escapeHtml(row["Job Code 2"])}</td><td>${escapeHtml(row["Billing Status"])}</td><td>${row["Total Late Amount"] === "" ? "" : escapeHtml(currency(row["Total Late Amount"]))}</td><td>${escapeHtml(row["Day Submitted"])}</td><td>${escapeHtml(row["Date Late"])}</td><td>${escapeHtml(row["Days Late"])}</td></tr>`).join("") || '<tr><td colspan="8" class="muted">No qualifying AR-PENDING rows were found.</td></tr>';
}

function generateReport(event) {
  const button = event.currentTarget;
  setButtonBusy(button, true, "Generating...");
  try {
    const report = buildReport();
    const workbook = XLSX.utils.book_new();
    const invoiceSheet = XLSX.utils.json_to_sheet(report.invoiceDetail, { header: INVOICE_COLUMNS });
    const expenseSheet = XLSX.utils.json_to_sheet(report.expenses, { header: EXPENSE_COLUMNS });
    configureSheet(invoiceSheet, INVOICE_COLUMNS, [34, 20, 20, 18, 20, 20, 20, 18, 18, 12, 24, 18, 28]);
    configureSheet(expenseSheet, EXPENSE_COLUMNS, [22, 14, 20, 20, 20]);
    XLSX.utils.book_append_sheet(workbook, invoiceSheet, "Invoice Detail");
    XLSX.utils.book_append_sheet(workbook, expenseSheet, "Expenses");
    XLSX.writeFile(workbook, `Aging_AR_Report_${new Date().toISOString().slice(0, 10)}.xlsx`);
    setStatus("Report downloaded. Workbook data stayed in this browser.", "success");
  } catch (error) {
    setStatus(error.message || "The report could not be created.", "error");
  } finally { setButtonBusy(button, false); }
}

function configureSheet(sheet, columns, widths) {
  sheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(columns.length - 1)}1` };
  sheet["!cols"] = widths.map((wch) => ({ wch }));
}

function clearWorkspace() { $("#ar-aging-form").reset(); clearData(); setStatus("Choose an Excel or CSV file to begin.", "info"); }
function clearData() { sourceRows = []; sourceHeaders = []; previousRows = []; $("#ar-column-panel").classList.add("hidden"); $("#ar-preview-panel").classList.add("hidden"); }
function setStatus(message, type) { const status = $("#ar-aging-status"); status.textContent = message; status.className = `notice ${type}`; }
function normalize(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function normalizeKeyPart(value) { return cellText(value).toLocaleLowerCase().replace(/\s+/g, " "); }
function amountKey(value) { return String(Math.round(Math.abs(numberValue(value)) * 100)); }
function cellText(value) { if (value instanceof Date && !Number.isNaN(value.getTime())) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; return String(value ?? "").trim(); }
function numberValue(value) { const parsed = Number(String(value ?? "").replace(/[$,()]/g, (match) => match === "(" ? "-" : "")); return Number.isFinite(parsed) ? parsed : 0; }
function billingBucket(value) { const text = String(value ?? "").toLowerCase(); return text.includes("30") ? "30 Past Due" : text.includes("past due") ? "Past Due" : text.includes("outstanding") ? "Outstanding" : "Other"; }
function bucketPriority(value) { return value === "Past Due" ? 1 : value === "30 Past Due" ? 2 : value === "Outstanding" ? 3 : 4; }
function splitProject(value) { const text = String(value ?? ""); const index = text.indexOf("|"); return index < 0 ? [text.trim(), ""] : [text.slice(0, index).trim(), text.slice(index + 1).trim()]; }
// Treat submission values as calendar dates, not instants, to avoid timezone/DST shifts.
function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : calendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  const text = String(value ?? "").trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(text);
  if (match) return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (!match) return null;
  let year = Number(match[3]);
  if (match[3].length === 2) year += year < 30 ? 2000 : 1900;
  return calendarDate(year, Number(match[1]), Number(match[2]));
}
function calendarDate(year, month, day) {
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}
function invoiceAging(value, asOf = new Date()) {
  const submitted = parseDate(value);
  if (!submitted) return { submitted: cellText(value), dateLate: "", daysLate: "" };
  const today = Date.UTC(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const due = submitted.getTime() + 30 * 86400000;
  return {
    submitted: submitted.toISOString().slice(0, 10),
    dateLate: new Date(due).toISOString().slice(0, 10),
    daysLate: Math.max(0, Math.round((today - due) / 86400000)),
  };
}
function reportMonth(value) { const date = parseDate(value); return date ? date.toISOString().slice(0, 7) : "NaT"; }
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key] || 0), 0); }
function currency(value) { return Number(value || 0).toLocaleString(undefined, { style: "currency", currency: "USD" }); }

