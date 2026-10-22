import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "../src/vendor/xlsx.mjs";
import * as core from "../src/inventory-core.js";

const row = (sku, change, warehouse = "测试仓", type = "出库 / 手动出库") => [
  sku, "测试商品", "test-account", "21 Oct 2026 17:24", "A-01", "100", change,
  "99", warehouse, "10.9800", "10.9800", "10.9800", type, "TEST-001",
];
function read(matrix) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), "记录");
  return core.readWorkbook(XLSX, workbook);
}

test("reads all 14 columns and keeps identifiers and source decimal precision", () => {
  const parsed = read([core.HEADERS, row("000123", "- 1")]);
  assert.equal(parsed.sheets[0].records[0].cells[0], "000123");
  assert.equal(parsed.sheets[0].records[0].cells[10], "10.9800");
  assert.equal(parsed.sheets[0].records[0].change, -1);
  assert.equal(parsed.sheets[0].records[0].rowNumber, 2);
});

test("uses numeric cell formatting for leading-zero SKU identifiers", () => {
  const worksheet = XLSX.utils.aoa_to_sheet([core.HEADERS, row(123, "- 1")]);
  worksheet.A2.z = "000000";
  const book = { SheetNames: ["记录"], Sheets: { 记录: worksheet } };
  assert.equal(core.readWorkbook(XLSX, book).sheets[0].records[0].cells[0], "000123");
});

test("finds reordered headers below a report title and ignores empty rows", () => {
  const headers = [...core.HEADERS].reverse().map((name) => ` ${name} `);
  const parsed = read([["库存记录"], [], headers, row("SKU-1", "+ 5").reverse(), [], row("SKU-2", "0").reverse()]);
  assert.equal(parsed.sheets[0].records.length, 2);
  assert.equal(parsed.sheets[0].records[0].cells[0], "SKU-1");
  assert.equal(parsed.sheets[0].records[0].rowNumber, 4);
});

test("rejects incomplete and duplicate headers instead of guessing columns", () => {
  assert.throws(() => read([core.HEADERS.slice(0, 13), row("SKU-1", "-1")]), /单据号/);
  assert.throws(() => read([[...core.HEADERS, "SKU编号"], [...row("SKU-1", "-1"), "duplicate"]]), /重复/);
});

test("reports unusable sheets while retaining valid worksheets", () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["说明"]]), "说明");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([core.HEADERS, row("A", "+1")]), "数据");
  const parsed = core.readWorkbook(XLSX, book);
  assert.equal(parsed.sheets.length, 1);
  assert.equal(parsed.skippedSheets[0].name, "说明");
});

test("separates zero from missing and accepts spaced signs", () => {
  assert.equal(core.parseNumber("- 1"), -1);
  assert.equal(core.parseNumber("+ 1,200"), 1200);
  assert.equal(core.parseNumber("0"), 0);
  assert.equal(core.parseNumber("-"), null);
  assert.equal(core.parseNumber(""), null);
  assert.equal(core.parseNumber("1 item"), null);
});

test("totals movements rather than summing repeated inventory balances", () => {
  const records = read([core.HEADERS, row("A", "- 2"), row("A", "+ 5"), row("B", "0"), row("C", "-")]).sheets[0].records;
  assert.deepEqual(core.getSummary(records), { count: 4, skuCount: 3, inQty: 5, outQty: 2, netQty: 3, invalidChanges: 1 });
});

test("combines keyword, warehouse and movement-type filters", () => {
  const records = read([core.HEADERS, row("SKU-A", "-1", "一号仓"), row("SKU-B", "+2", "二号仓", "入库 / 盘点入库")]).sheets[0].records;
  assert.equal(core.filterRecords(records, { query: "sku-b TEST-001", warehouse: "二号仓", type: "入库 / 盘点入库" }).length, 1);
  assert.equal(core.filterRecords(records, { query: "missing" }).length, 0);
});

test("sorts movements numerically and keeps original records unmodified", () => {
  const records = read([core.HEADERS, row("A", "- 2"), row("B", "- 10"), row("C", "+ 1"), row("D", "-")]).sheets[0].records;
  assert.deepEqual(core.sortRecords(records, 6).map((record) => record.cells[0]), ["B", "A", "C", "D"]);
  assert.deepEqual(core.sortRecords(records, 6, "desc").map((record) => record.cells[0]), ["C", "A", "B", "D"]);
  assert.equal(records[0].cells[0], "A");
});

test("serializes shared data without losing source strings or evaluating cell content", () => {
  const parsed = read([core.HEADERS, row("<img src=x onerror=alert(1)>", "- 1")]);
  const restored = core.hydrateWorkbook(core.serializeWorkbook(parsed));
  assert.deepEqual(restored.sheets[0].records[0].cells, parsed.sheets[0].records[0].cells);
  assert.equal(restored.sheets[0].records[0].change, -1);
  assert.throws(() => core.hydrateWorkbook({ sheets: [{ name: "错误", rows: [["missing columns"]] }] }), /列数/);
});
