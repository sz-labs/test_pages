import * as XLSX from "../shared/vendor/xlsx.mjs";
import { HEADERS } from "../shared/inventory-core.js";
import { createHash } from "node:crypto";
export const password = "isolated-ci-password-only-12345";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const exampleRow = (index = 0) => [String(index).padStart(8, "0"), "测试商品", "测试账号", "2026-10-22 08:09:10", "A-01", "100.0000", "−2.5000", "97.5000", "测试仓库", "3.141590", "3.100000", "3.141590", "出库", "000012345"];
export function workbook(rows = [exampleRow()], options = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  if (options.format) options.format(sheet);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "库存更新记录");
  return Buffer.from(XLSX.write(book, { type: "array", bookType: "xlsx", compression: false }));
}
export function storage() { const map = new Map(); return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key), get size() { return map.size; } }; }
// Add an unused ZIP entry so an otherwise valid workbook can reach an exact byte boundary.
export function padZip(input, target) {
  const end = input.length - 22;
  if (input.readUInt32LE(end) !== 0x06054b50) throw new Error("Fixture ZIP must have no comment");
  const offset = input.readUInt32LE(end + 16), name = Buffer.from("padding.bin");
  const length = target - input.length - 30 - name.length - 46 - name.length;
  if (length < 0) throw new Error("Padding target too small");
  const padding = Buffer.alloc(length), local = Buffer.alloc(30), entry = Buffer.alloc(46);
  let crc = 0xffffffff;
  for (const byte of padding) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(length, 18); local.writeUInt32LE(length, 22); local.writeUInt16LE(name.length, 26);
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(length, 20); entry.writeUInt32LE(length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
  const tail = Buffer.from(input.subarray(end));
  tail.writeUInt16LE(tail.readUInt16LE(8) + 1, 8); tail.writeUInt16LE(tail.readUInt16LE(10) + 1, 10);
  tail.writeUInt32LE(tail.readUInt32LE(12) + entry.length + name.length, 12);
  tail.writeUInt32LE(offset + local.length + name.length + padding.length, 16);
  return Buffer.concat([input.subarray(0, offset), local, name, padding, input.subarray(offset, end), entry, name, tail]);
}
