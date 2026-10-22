import { parseExcel } from "../../shared/excel.js";
self.onmessage = (event) => {
  try { self.postMessage({ ok: true, workbook: parseExcel(event.data) }); }
  catch (error) { self.postMessage({ ok: false, error: error.message || "无法读取工作簿" }); }
};
