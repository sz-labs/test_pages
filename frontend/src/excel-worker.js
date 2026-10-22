import * as XLSX from "./vendor/xlsx.mjs";
import * as InventoryCore from "./inventory-core.js";

self.onmessage = function (event) {
  try {
    const bytes = new Uint8Array(event.data);
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
    if (!zip && !ole) throw new Error("文件内容不是有效的 Excel 工作簿，请选择 .xlsx 或 .xls 文件");
    const workbook = XLSX.read(bytes, {
      type: "array", cellHTML: false, cellFormula: false,
      sheetRows: InventoryCore.MAX_RECORDS + 22,
      dateNF: "yyyy-mm-dd hh:mm:ss",
    });
    self.postMessage({ ok: true, workbook: InventoryCore.readWorkbook(XLSX, workbook) });
  } catch (error) {
    const message = /password|encrypt/i.test(error.message)
      ? "无法读取加密工作簿，请先在 Excel 中解除文件密码"
      : error.message || "无法读取工作簿，请检查文件是否损坏";
    self.postMessage({ ok: false, error: message });
  }
};
