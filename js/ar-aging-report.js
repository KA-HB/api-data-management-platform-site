import { requireAuth, renderShell } from "./auth.js?v=20260814a";
import { $, escapeHtml, setButtonBusy, toast } from "./ui.js";

const REQUIRED_COLUMNS = ["Projects Data", "Billing Status", "AR-PENDING", "Name", "Submission Date", "AR-RECEIVED"];
const INVOICE_COLUMNS = ["Project", "Job Code 1", "Job Code 2", "Billing Status", "# Past Due", "# 30 Past Due", "# Outstanding", "# Total Late Invoices", "Total Late Amount", "Days Late", "Project Manager or Project Executive", "Operations Team/Accounts Receivable Lead", "OUTREACH"];
const EXPENSE_COLUMNS = ["Project", "Month", "Job Code 1", "Job Code 2", "Total Late Amount"];
let sourceRows = [];
let sourceHeaders = [];

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
  if (!file) return toast("Choose an AR workbook.", "error");
  const button = event.submitter;
  setButtonBusy(button, true, "Reading...");
  try {
    sourceRows = await parseFile(file);
    sourceHeaders = sourceRows.length ? Object.keys(sourceRows[0]) : [];
    if (!sourceRows.length) throw new Error("No rows were found in the first worksheet.");
    renderMappings();
    renderPreview();
    $("#ar-column-panel").classList.remove("hidden");
    $("#ar-preview-panel").classList.remove("hidden");
    setStatus(`${file.name}: ${sourceRows.length.toLocaleString()} rows ready. Nothing was uploaded.`, "success");
  } catch (error) {
    clearData();
    setStatus(error.message || "The workbook could not be read.", "error");
  } finally {
    setButtonBusy(button, false);
  }
}

async function parseFile(file) {
  if (file.name.toLowerCase().endsWith(".csv")) {
    return new Promise((resolve, reject) => Papa.parse(file, { header: true, skipEmptyLines: true, complete: (result) => resolve(result.data), error: reject }));
  }
  const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
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
  const details = [];
  sourceRows.forEach((row, index) => {
    const amount = numberValue(row[mapping["AR-PENDING"]]);
    if (!amount) return;
    const bucket = billingBucket(row[mapping["Billing Status"]]);
    if (bucket === "Other") return;
    const [job1, job2] = splitProject(row[mapping["Projects Data"]]);
    details.push({ project: String(row[mapping.Name] || "").trim() || "UNKNOWN", job1, job2, bucket, amount: Math.abs(amount), submissionDate: row[mapping["Submission Date"]], priority: bucketPriority(bucket), order: index });
  });
  const groups = new Map();
  details.forEach((detail) => { if (!groups.has(detail.job1)) groups.set(detail.job1, []); groups.get(detail.job1).push(detail); });
  const orderedGroups = [...groups.entries()].sort((a, b) => sum(b[1], "amount") - sum(a[1], "amount"));
  const invoiceDetail = [];
  orderedGroups.forEach(([job1, rows]) => {
    [...rows].sort((a, b) => a.priority - b.priority || b.amount - a.amount || a.order - b.order).forEach((row) => invoiceDetail.push({ Project: row.project, "Job Code 1": row.job1, "Job Code 2": row.job2, "Billing Status": row.bucket, "# Past Due": Number(row.bucket === "Past Due"), "# 30 Past Due": Number(row.bucket === "30 Past Due"), "# Outstanding": Number(row.bucket === "Outstanding"), "# Total Late Invoices": 1, "Total Late Amount": row.amount, "Days Late": daysLate(row.submissionDate), "Project Manager or Project Executive": "", "Operations Team/Accounts Receivable Lead": "", OUTREACH: "" }));
    invoiceDetail.push({ Project: `${job1} TOTAL`, "Job Code 1": job1, "Job Code 2": "", "Billing Status": "TOTAL", "# Past Due": rows.filter((row) => row.bucket === "Past Due").length, "# 30 Past Due": rows.filter((row) => row.bucket === "30 Past Due").length, "# Outstanding": rows.filter((row) => row.bucket === "Outstanding").length, "# Total Late Invoices": rows.length, "Total Late Amount": sum(rows, "amount"), "Days Late": "", "Project Manager or Project Executive": "", "Operations Team/Accounts Receivable Lead": "", OUTREACH: "" });
  });
  const expenses = sourceRows.map((row, index) => ({ row, index, received: numberValue(row[mapping["AR-RECEIVED"]]) })).filter((item) => item.received !== 0).map((item) => { const [job1, job2] = splitProject(item.row[mapping["Projects Data"]]); const submitted = item.row[mapping["Submission Date"]]; return { Project: submitted, Month: reportMonth(submitted), "Job Code 1": job1, "Job Code 2": job2, "Total Late Amount": Math.abs(item.received), order: item.index }; }).sort((a, b) => b["Total Late Amount"] - a["Total Late Amount"] || a.order - b.order).map(({ order, ...row }) => row);
  return { invoiceDetail, expenses, detailCount: details.length, pendingAmount: sum(details, "amount"), receivedAmount: sum(expenses, "Total Late Amount") };
}

function renderPreview() {
  let report;
  try { report = buildReport(); } catch (error) { $("#ar-preview-summary").textContent = error.message; return; }
  $("#ar-source-rows").textContent = sourceRows.length.toLocaleString();
  $("#ar-invoice-rows").textContent = report.invoiceDetail.length.toLocaleString();
  $("#ar-expense-rows").textContent = report.expenses.length.toLocaleString();
  $("#ar-pending-total").textContent = currency(report.pendingAmount);
  $("#ar-preview-summary").textContent = `${report.detailCount.toLocaleString()} invoice details plus project total rows; ${currency(report.receivedAmount)} AR received.`;
  $("#ar-preview-body").innerHTML = report.invoiceDetail.slice(0, 10).map((row) => `<tr><td>${escapeHtml(row.Project)}</td><td>${escapeHtml(row["Job Code 1"])}</td><td>${escapeHtml(row["Job Code 2"])}</td><td>${escapeHtml(row["Billing Status"])}</td><td>${escapeHtml(currency(row["Total Late Amount"]))}</td><td>${escapeHtml(row["Days Late"])}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">No qualifying AR-PENDING rows were found.</td></tr>';
}

function generateReport(event) {
  const button = event.currentTarget;
  setButtonBusy(button, true, "Generating...");
  try {
    const report = buildReport();
    const workbook = XLSX.utils.book_new();
    const invoiceSheet = XLSX.utils.json_to_sheet(report.invoiceDetail, { header: INVOICE_COLUMNS });
    const expenseSheet = XLSX.utils.json_to_sheet(report.expenses, { header: EXPENSE_COLUMNS });
    configureSheet(invoiceSheet, INVOICE_COLUMNS, [34, 20, 20, 18, 12, 15, 14, 20, 20, 12, 32, 38, 18]);
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
function clearData() { sourceRows = []; sourceHeaders = []; $("#ar-column-panel").classList.add("hidden"); $("#ar-preview-panel").classList.add("hidden"); }
function setStatus(message, type) { const status = $("#ar-aging-status"); status.textContent = message; status.className = `notice ${type}`; }
function normalize(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function numberValue(value) { const parsed = Number(String(value ?? "").replace(/[$,()]/g, (match) => match === "(" ? "-" : "")); return Number.isFinite(parsed) ? parsed : 0; }
function billingBucket(value) { const text = String(value ?? "").toLowerCase(); return text.includes("30") ? "30 Past Due" : text.includes("past due") ? "Past Due" : text.includes("outstanding") ? "Outstanding" : "Other"; }
function bucketPriority(value) { return value === "Past Due" ? 1 : value === "30 Past Due" ? 2 : value === "Outstanding" ? 3 : 4; }
function splitProject(value) { const text = String(value ?? ""); const index = text.indexOf("|"); return index < 0 ? [text.trim(), ""] : [text.slice(0, index).trim(), text.slice(index + 1).trim()]; }
function parseDate(value) { if (value instanceof Date && !Number.isNaN(value.getTime())) return value; const text = String(value ?? "").trim(); if (!text || /^(nan|nat)$/i.test(text)) return null; const date = new Date(text); return Number.isNaN(date.getTime()) ? null : date; }
function daysLate(value) { const date = parseDate(value); if (!date) return ""; const today = new Date(); return Math.trunc((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000); }
function reportMonth(value) { const date = parseDate(value); return date ? `${date.getFullYear().toString().padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}` : "NaT"; }
function sum(rows, key) { return rows.reduce((total, row) => total + Number(row[key] || 0), 0); }
function currency(value) { return Number(value || 0).toLocaleString(undefined, { style: "currency", currency: "USD" }); }
