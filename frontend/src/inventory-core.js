const HEADERS = Object.freeze([
  "SKU编号", "SKU名称", "账号", "时间", "货架位", "原库存", "变动",
  "新库存", "仓库", "原成本价", "出入库价", "现成本价", "类型", "单据号",
]);
const MAX_RECORDS = 50000;
const NUMERIC_COLUMNS = new Set([5, 6, 7, 9, 10, 11]);
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const cleanHeader = (value) => String(value ?? "").replace(/[\s\uFEFF]/g, "");

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").replace(/[\s,，]/g, "").replace(/−/g, "-");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function makeRecord(cells, rowNumber) {
  const values = HEADERS.map((_, index) => String(cells[index] ?? ""));
  return {
    cells: values,
    rowNumber,
    change: parseNumber(values[6]),
    searchText: values.join("\n").toLocaleLowerCase("zh-CN"),
  };
}

function readSheet(XLSX, sheet, name) {
  if (!sheet || !sheet["!ref"]) throw new Error("工作表为空");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const fullRange = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"]);
  if (fullRange.e.r - fullRange.s.r > MAX_RECORDS + 20) {
    throw new Error(`单个工作表最多支持 ${MAX_RECORDS.toLocaleString("zh-CN")} 条记录，请拆分文件`);
  }
  if (range.e.c - range.s.c > 199) throw new Error("工作表列数过多，请使用库存更新记录格式");
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: false, defval: "", blankrows: true,
  });
  let headerRow = -1;
  let bestHeaders = [];
  let bestScore = -1;
  for (let index = 0; index < Math.min(20, matrix.length); index += 1) {
    const headers = matrix[index].map(cleanHeader);
    const score = HEADERS.filter((header) => headers.includes(header)).length;
    if (score > bestScore) { bestScore = score; bestHeaders = headers; }
    if (score === HEADERS.length) { headerRow = index; break; }
  }
  if (headerRow === -1) {
    const missing = HEADERS.filter((header) => !bestHeaders.includes(header));
    throw new Error(`缺少表头：${missing.join("、")}`);
  }
  const sourceHeaders = matrix[headerRow].map(cleanHeader);
  const duplicates = HEADERS.filter((header) => sourceHeaders.filter((value) => value === header).length > 1);
  if (duplicates.length) throw new Error(`表头重复：${duplicates.join("、")}`);
  const indices = HEADERS.map((header) => sourceHeaders.indexOf(header));
  const records = [];
  for (let index = headerRow + 1; index < matrix.length; index += 1) {
    const cells = indices.map((column) => String(matrix[index][column] ?? ""));
    if (cells.every((cell) => !cell.trim())) continue;
    records.push(makeRecord(cells, range.s.r + index + 1));
    if (records.length > MAX_RECORDS) throw new Error(`工作表超过 ${MAX_RECORDS} 条记录`);
  }
  if (!records.length) throw new Error("只有表头，没有数据记录");
  return { name, records };
}

function readWorkbook(XLSX, workbook) {
  const sheets = [];
  const skippedSheets = [];
  let count = 0;
  for (const name of workbook.SheetNames || []) {
    try {
      const sheet = readSheet(XLSX, workbook.Sheets[name], name);
      count += sheet.records.length;
      sheets.push(sheet);
    } catch (error) {
      skippedSheets.push({ name, reason: error.message });
    }
  }
  if (!sheets.length) {
    throw new Error(skippedSheets.length === 1
      ? skippedSheets[0].reason
      : "未找到符合库存更新记录格式的工作表，请检查文件表头");
  }
  if (count > MAX_RECORDS) throw new Error(`每个文件最多支持 ${MAX_RECORDS.toLocaleString("zh-CN")} 条记录，请拆分文件`);
  return { sheets, skippedSheets };
}

function filterRecords(records, filters = {}) {
  const words = String(filters.query || "").trim().toLocaleLowerCase("zh-CN").split(/\s+/).filter(Boolean);
  return records.filter((record) =>
    (!filters.warehouse || record.cells[8] === filters.warehouse) &&
    (!filters.type || record.cells[12] === filters.type) &&
    words.every((word) => record.searchText.includes(word))
  );
}

function getSummary(records) {
  const summary = { count: records.length, skuCount: 0, inQty: 0, outQty: 0, netQty: 0, invalidChanges: 0 };
  summary.skuCount = new Set(records.map((record) => record.cells[0]).filter(Boolean)).size;
  for (const record of records) {
    if (record.change === null) { summary.invalidChanges += 1; continue; }
    if (record.change > 0) summary.inQty += record.change;
    else summary.outQty -= record.change;
    summary.netQty += record.change;
  }
  return summary;
}

function parseTime(value) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const english = String(value).match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (english && months.includes(english[2].toLowerCase())) {
    return Date.UTC(+english[3], months.indexOf(english[2].toLowerCase()), +english[1], +english[4], +english[5], +(english[6] || 0));
  }
  const iso = String(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  return iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)) : null;
}

function sortRecords(records, column = null, direction = "asc") {
  if (column === null) return [...records];
  const sign = direction === "desc" ? -1 : 1;
  return [...records].sort((left, right) => {
    const a = left.cells[column];
    const b = right.cells[column];
    if (NUMERIC_COLUMNS.has(column) || column === 3) {
      const va = column === 3 ? parseTime(a) : parseNumber(a);
      const vb = column === 3 ? parseTime(b) : parseNumber(b);
      if (va === null && vb !== null) return 1;
      if (va !== null && vb === null) return -1;
      if (va !== null && vb !== null) return sign * (va - vb) || left.rowNumber - right.rowNumber;
    }
    return sign * collator.compare(a, b) || left.rowNumber - right.rowNumber;
  });
}

function serializeWorkbook(workbook) {
  return {
    schemaVersion: 1,
    sheets: workbook.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.records.map((record) => record.cells),
    })),
  };
}

function hydrateWorkbook(data) {
  if (!Array.isArray(data?.sheets) || !data.sheets.length) throw new Error("共享数据格式不正确");
  let count = 0;
  const sheets = data.sheets.map((sheet) => {
    if (typeof sheet.name !== "string" || !Array.isArray(sheet.rows)) throw new Error("共享工作表格式不正确");
    count += sheet.rows.length;
    if (count > MAX_RECORDS) throw new Error("共享数据超出支持的记录数");
    return {
      name: sheet.name,
      records: sheet.rows.map((cells, index) => {
        if (!Array.isArray(cells) || cells.length !== HEADERS.length) throw new Error("共享数据列数不正确");
        return makeRecord(cells, sheet.rowNumbers?.[index] ?? index + 2);
      }),
    };
  });
  return { sheets, skippedSheets: [] };
}


export { HEADERS, MAX_RECORDS, NUMERIC_COLUMNS, parseNumber, makeRecord, readWorkbook, filterRecords, getSummary, sortRecords, serializeWorkbook, hydrateWorkbook };
