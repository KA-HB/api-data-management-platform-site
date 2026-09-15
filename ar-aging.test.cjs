const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
let code = fs.readFileSync(__dirname + '/js/ar-aging-report.js', 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace('const profile = await requireAuth("admin");', 'const profile = null;');
const context = vm.createContext({ console });
vm.runInContext(code, context);
vm.runInContext(`
const check = (condition, message) => { if (!condition) throw new Error(message); };
const asOf = new Date(2026, 8, 15, 12);
for (const [value, expected] of [["2026-08-17", 0], ["2026-08-16", 0], ["2026-08-15", 1], ["2026-08-06", 10], ["2026-10-01", 0], ["8/6/2026", 10], ["8/6/26", 10], ["2026-08-06T00:00:00Z", 10]]) {
  check(invoiceAging(value, asOf).daysLate === expected, value);
}
check(invoiceAging(new Date(2026, 7, 6), asOf).daysLate === 10, "Excel date");
for (const value of ["", "NaT", "garbage", "2026-02-30", "13/1/2026"]) check(invoiceAging(value, asOf).daysLate === "", "invalid " + value);
check(invoiceAging("2024-02-29", new Date(2024, 2, 31)).daysLate === 1, "leap year");
check(invoiceAging("2026-02-07", new Date(2026, 2, 10)).daysLate === 1, "spring DST");
check(invoiceAging("2026-10-02", new Date(2026, 10, 2)).daysLate === 1, "fall DST");
check(invoiceAging("2026-08-06", asOf).dateLate === "2026-09-05", "threshold date");
currentMapping = () => Object.fromEntries(REQUIRED_COLUMNS.map(c => [c,c]));
const today = new Date();
const dateAgo = days => { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days); return cellText(d); };
sourceRows = [40, 30, null].map((days, index) => ({
  "Projects Data": "Job|Task", Name: "Invoice" + index, "Billing Status": "Outstanding",
  "AR-PENDING": 100, "AR-RECEIVED": 0, "Submission Date": days === null ? "" : dateAgo(days)
}));
let report = buildReport();
check(report.pendingAmount === 300, "pending retained");
check(report.invalidDates === 1, "invalid flagged");
const total = report.invoiceDetail.at(-1);
check(total["# Total Late Invoices"] === 1 && total["Total Late Amount"] === 100, "late totals");
check(report.invoiceDetail[1]["Total Late Amount"] === 0, "current amount");
check(report.invoiceDetail[2]["Days Late"] === "", "unknown age");
previousRows = report.invoiceDetail.map(row => ({...row, "Communication Outcome": "Called"}));
report = buildReport();
check(report.carriedCommentRows === 3, "new report comment carryover");
previousRows = [{Project: "Invoice0", "Job Code 1": "Job", "Job Code 2": "Task", "Total Late Amount": 100, "Communication Outcome": "Legacy"}];
check(buildReport().invoiceDetail[0]["Communication Outcome"] === "Legacy", "legacy comments");
check(INVOICE_COLUMNS.length === 13, "export columns");
`, context);
console.log('AR aging checks passed: boundaries, dates, DST, totals, missing dates, and comment carryover.');


