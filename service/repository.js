import { createHash, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import Decimal from "decimal.js";
import { databaseConfig } from "./config.js";
import { HttpError, check } from "./errors.js";
import { parseExcel } from "../shared/excel.js";
import { CHUNK_BYTES, PAGE_BYTES } from "../shared/limits.js";

Decimal.set({ precision: 50 });

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => typeof value === "string" ? JSON.parse(value) : value;
export function uploadMetadata(row) {
  const date = row.created_at instanceof Date ? row.created_at : new Date(row.created_at.replace(" ", "T").replace(/Z?$/, "Z"));
  return { id: row.id, fileName: row.filename, uploadedAt: date.toISOString(), recordCount: row.record_count, sheetCount: json(row.sheet_names).length };
}
export function sqlDecimal(value) {
  const text = String(value).replace(/[\s,，]/g, "").replace(/−/g, "-");
  if (text.length > 256 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const number = new Decimal(text).toDecimalPlaces(12, Decimal.ROUND_HALF_UP);
  return number.isFinite() && number.abs().lessThan("1e26") ? number.toFixed() : null;
}
const columns = ["upload_id", "sheet_name", "source_row", "sku_code", "sku_name", "account", "occurred_at", "shelf", "original_qty", "change_qty", "new_qty", "warehouse", "original_cost", "movement_cost", "current_cost", "movement_type", "document_no", "cells"];

export class MySQLRepository {
  constructor(connect = () => mysql.createConnection(databaseConfig())) { this.connect = connect; }
  async withConnection(action) {
    const connection = await this.connect();
    try { return await action(connection); }
    finally { await connection.end(); }
  }
  async transaction(connection, action) {
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    try { const result = await action(); await connection.commit(); return result; }
    catch (error) { await connection.rollback().catch(() => {}); throw error; }
  }
  async ping() { return this.withConnection(async c => { await c.query("SELECT 1"); return { status: "ok", database: "connected" }; }); }
  async listUploads() {
    return this.withConnection(async c => {
      const [rows] = await c.query("SELECT * FROM pages_inventory_uploads ORDER BY created_at DESC, id DESC LIMIT 50");
      return { items: rows.map(uploadMetadata) };
    });
  }
  async getUpload(id) {
    return this.withConnection(async c => {
      const [rows] = await c.execute("SELECT * FROM pages_inventory_uploads WHERE id = ?", [id]);
      check(rows.length, 404, "没有找到这份上传记录");
      return { ...uploadMetadata(rows[0]), sheets: json(rows[0].sheet_names).map(name => ({ name })) };
    });
  }
  async getRecords(id, cursor = "0") {
    return this.withConnection(async c => {
      const [rows] = await c.execute("SELECT id, sheet_name, source_row, cells FROM pages_inventory_records WHERE upload_id = ? AND id > ? ORDER BY id ASC LIMIT 501", [id, cursor]);
      const items = [];
      let bytes = 128;
      for (const row of rows) {
        const item = { sheetName: row.sheet_name, rowNumber: row.source_row, cells: json(row.cells) };
        const size = Buffer.byteLength(JSON.stringify(item)) + 1;
        check(size + 128 <= PAGE_BYTES, 413, "共享记录包含超大单元格，无法分页读取");
        if (items.length === 500 || bytes + size > PAGE_BYTES) break;
        items.push(item); bytes += size;
      }
      return { items, nextCursor: items.length < rows.length ? String(rows[items.length - 1].id) : null };
    });
  }
  async recordLogin(clientKey, valid) {
    return this.withConnection(c => this.transaction(c, async () => {
      await c.query("DELETE FROM pages_inventory_auth_limits WHERE window_start < UTC_TIMESTAMP(3) - INTERVAL 5 MINUTE LIMIT 100");
      await c.execute("INSERT IGNORE INTO pages_inventory_auth_limits (client_key, failures, window_start) VALUES (?, 0, UTC_TIMESTAMP(3))", [clientKey]);
      const [[row]] = await c.execute("SELECT failures FROM pages_inventory_auth_limits WHERE client_key = ? FOR UPDATE", [clientKey]);
      check(row.failures < 10, 429, "尝试次数过多，请五分钟后重试");
      if (valid) await c.execute("DELETE FROM pages_inventory_auth_limits WHERE client_key = ?", [clientKey]);
      else await c.execute("UPDATE pages_inventory_auth_limits SET failures = failures + 1 WHERE client_key = ?", [clientKey]);
    }));
  }
  async createImport(input) {
    return this.withConnection(async c => {
      await c.query("DELETE FROM pages_inventory_import_sessions WHERE expires_at <= UTC_TIMESTAMP(3) LIMIT 10");
      const [[existing]] = await c.execute("SELECT * FROM pages_inventory_uploads WHERE sha256 = ?", [input.sha256]);
      if (existing) return { published: { ...uploadMetadata(existing), duplicate: true } };
      const id = randomUUID();
      await c.execute("INSERT INTO pages_inventory_import_sessions (id, filename, file_size, sha256, chunk_count, created_at, expires_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) + INTERVAL 24 HOUR)", [id, input.fileName, input.size, input.sha256, Math.ceil(input.size / CHUNK_BYTES)]);
      return { id, received: [], chunkBytes: CHUNK_BYTES };
    });
  }
  async session(c, id, lock = false) {
    const [[session]] = await c.execute("SELECT *, expires_at > UTC_TIMESTAMP(3) AS active FROM pages_inventory_import_sessions WHERE id = ?" + (lock ? " FOR UPDATE" : ""), [id]);
    check(session && Number(session.active) === 1, 410, "上传会话已过期或已取消，请重新选择文件上传");
    return session;
  }
  async status(c, session) {
    if (session.upload_id) {
      const [[upload]] = await c.execute("SELECT * FROM pages_inventory_uploads WHERE id = ?", [session.upload_id]);
      check(upload, 404, "已发布的记录不存在");
      return { id: session.id, published: { ...uploadMetadata(upload), duplicate: true } };
    }
    const [chunks] = await c.execute("SELECT chunk_index FROM pages_inventory_import_chunks WHERE session_id = ? ORDER BY chunk_index", [session.id]);
    return { id: session.id, received: chunks.map(row => row.chunk_index), chunkBytes: CHUNK_BYTES, fileName: session.filename, size: session.file_size, sha256: session.sha256 };
  }
  async getImport(id) { return this.withConnection(async c => this.status(c, await this.session(c, id))); }
  async putChunk(id, index, body) {
    return this.withConnection(c => this.transaction(c, async () => {
      const session = await this.session(c, id, true);
      check(!session.upload_id, 409, "这份文件已经发布");
      check(Number.isInteger(index) && index >= 0 && index < session.chunk_count, 400, "分块序号不正确");
      const expected = Math.min(CHUNK_BYTES, session.file_size - index * CHUNK_BYTES);
      check(body.length === expected, 400, "分块大小与文件信息不一致");
      const sha256 = digest(body);
      const [[existing]] = await c.execute("SELECT sha256 FROM pages_inventory_import_chunks WHERE session_id = ? AND chunk_index = ?", [id, index]);
      if (existing) check(existing.sha256 === sha256, 409, "同一序号的分块内容不一致，请重新创建上传");
      else await c.execute("INSERT INTO pages_inventory_import_chunks (session_id, chunk_index, sha256, body) VALUES (?, ?, ?, ?)", [id, index, sha256, body]);
      return { index, received: true };
    }));
  }
  async cancelImport(id) {
    return this.withConnection(async c => { await c.execute("DELETE FROM pages_inventory_import_sessions WHERE id = ?", [id]); return { cancelled: true }; });
  }
  async completeImport(id) {
    let sha256;
    try {
      return await this.withConnection(c => this.transaction(c, async () => {
        const session = await this.session(c, id, true);
        sha256 = session.sha256;
        if (session.upload_id) return (await this.status(c, session)).published;
        const [chunks] = await c.execute("SELECT chunk_index, body FROM pages_inventory_import_chunks WHERE session_id = ? ORDER BY chunk_index", [id]);
        check(chunks.length === session.chunk_count && chunks.every((chunk, index) => chunk.chunk_index === index), 409, "文件尚未传完整，请继续上传缺失分块");
        const content = Buffer.concat(chunks.map(chunk => chunk.body));
        check(content.length === session.file_size && digest(content) === sha256, 422, "文件大小或 SHA-256 校验失败，请重新上传");
        const [[existing]] = await c.execute("SELECT * FROM pages_inventory_uploads WHERE sha256 = ?", [sha256]);
        let result;
        if (existing) result = { ...uploadMetadata(existing), duplicate: true };
        else {
          let parsed;
          try { parsed = parseExcel(content); } catch (error) { throw new HttpError(422, error.message); }
          const uploadId = randomUUID();
          const count = parsed.sheets.reduce((sum, sheet) => sum + sheet.records.length, 0);
          await c.execute("INSERT INTO pages_inventory_uploads (id, filename, sha256, created_at, record_count, sheet_names) VALUES (?, ?, ?, UTC_TIMESTAMP(3), ?, ?)", [uploadId, session.filename, sha256, count, JSON.stringify(parsed.sheets.map(sheet => sheet.name))]);
          let batch = [], batchBytes = 0;
          const flush = async () => {
            if (!batch.length) return;
            const placeholders = batch.map(() => "(" + columns.map(() => "?").join(",") + ")").join(",");
            await c.query(`INSERT INTO pages_inventory_records (${columns.join(",")}) VALUES ${placeholders}`, batch.flat());
            batch = []; batchBytes = 0;
          };
          for (const sheet of parsed.sheets) for (const record of sheet.records) {
            const a = record.cells;
            const values = [uploadId, sheet.name, record.rowNumber, a[0], a[1], a[2], a[3], a[4], sqlDecimal(a[5]), sqlDecimal(a[6]), sqlDecimal(a[7]), a[8], sqlDecimal(a[9]), sqlDecimal(a[10]), sqlDecimal(a[11]), a[12], a[13], JSON.stringify(a)];
            const size = Buffer.byteLength(JSON.stringify(values)) * 2;
            if (batch.length >= 250 || batchBytes + size > CHUNK_BYTES) await flush();
            batch.push(values); batchBytes += size;
          }
          await flush();
          const [[saved]] = await c.execute("SELECT * FROM pages_inventory_uploads WHERE id = ?", [uploadId]);
          result = { ...uploadMetadata(saved), duplicate: false, skippedSheets: parsed.skippedSheets };
        }
        await this.receipt(c, id, result.id);
        return result;
      }));
    } catch (error) {
      if (error.code !== "ER_DUP_ENTRY" || !sha256) throw error;
      // Concurrent imports with the same hash converge after the winner commits.
      return this.withConnection(c => this.transaction(c, async () => {
        const [[winner]] = await c.execute("SELECT * FROM pages_inventory_uploads WHERE sha256 = ?", [sha256]);
        if (!winner) throw error;
        await this.receipt(c, id, winner.id);
        return { ...uploadMetadata(winner), duplicate: true };
      }));
    }
  }
  async receipt(c, sessionId, uploadId) {
    await c.execute("UPDATE pages_inventory_import_sessions SET upload_id = ? WHERE id = ?", [uploadId, sessionId]);
    await c.execute("DELETE FROM pages_inventory_import_chunks WHERE session_id = ?", [sessionId]);
  }
}
