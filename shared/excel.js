import * as XLSX from "./vendor/xlsx.mjs";
import { readWorkbook, MAX_RECORDS } from "./inventory-core.js";
import { MAX_BYTES } from "./limits.js";

function inspectZip(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("文件内容不是有效的 .xlsx 工作簿");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error("Excel 文件不完整或已损坏");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true), total = 0;
  if (!count || count > 2048) throw new Error("工作簿内部文件数量超出限制");
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Excel 压缩结构不正确");
    const size = view.getUint32(offset + 24, true);
    total += size;
    if (size === 0xffffffff || total > 128 * 1024 * 1024) throw new Error("Excel 解压大小超出 128 MB 限制，请拆分文件");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}

export function parseExcel(content) {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("请选择不超过 20 MB 的非空 .xlsx 文件");
  inspectZip(bytes);
  try {
    const book = XLSX.read(bytes, { type: "array", cellHTML: false, cellFormula: false, sheetRows: MAX_RECORDS + 22, dateNF: "yyyy-mm-dd hh:mm:ss" });
    const parsed = readWorkbook(XLSX, book);
    const shortColumns = new Set([0, 2, 3, 4, 8, 12, 13]);
    const encoder = new TextEncoder();
    for (const sheet of parsed.sheets) {
      if ([...sheet.name].length > 255) throw new Error("工作表名称过长");
      for (const record of sheet.records) {
        for (const [index, cell] of record.cells.entries()) {
          if (shortColumns.has(index) && [...cell].length > 255) throw new Error(`第 ${record.rowNumber} 行字段超过数据库的 255 字符限制`);
          const limit = index === 1 ? 65535 : 4096;
          if (!shortColumns.has(index) && encoder.encode(cell).length > limit) throw new Error(`第 ${record.rowNumber} 行单元格内容过长`);
        }
      }
    }
    return parsed;
  } catch (error) {
    if (/password|encrypt/i.test(error.message)) throw new Error("无法读取加密工作簿，请先解除文件密码");
    throw error;
  }
}
