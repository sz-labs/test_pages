import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import mysql from "mysql2/promise";
import { databaseConfig } from "../../service/config.js";
import { MySQLRepository } from "../../service/repository.js";
import { createApp } from "../../service/app.js";
import { authService } from "../../service/auth.js";
import { publishExcel, loadWorkbook, ApiError } from "../../frontend/src/transport.js";
import { MAX_BYTES, CHUNK_BYTES, PAGE_BYTES } from "../../shared/limits.js";
import { workbook, exampleRow, padZip, hash, password, storage } from "../helpers.mjs";

const enabled = process.env.INVENTORY_TEST_MYSQL === "1";
let connection, app, repository, config;
const bearer = authService(password).issue().accessToken;
before(async () => {
  if (!enabled) return;
  // Fail closed: these tests must never discover mysql.local.yaml or use a business database.
  assert.ok(process.env.MYSQL_CONFIG_YAML, "Explicit isolated test YAML required");
  config = databaseConfig({ MYSQL_CONFIG_YAML: process.env.MYSQL_CONFIG_YAML });
  assert.equal(config.database, "inventory_ci"); assert.ok(["127.0.0.1", "localhost"].includes(config.host));
  connection = await mysql.createConnection(config);
  for (const table of ["pages_inventory_import_chunks", "pages_inventory_import_sessions", "pages_inventory_auth_limits", "pages_inventory_records", "pages_inventory_uploads"]) await connection.query(`DROP TABLE IF EXISTS ${table}`);
  for (const path of ["tests/integration/schema.sql", "database/001_import_support.sql"]) {
    const sql = await fs.readFile(path, "utf8");
    for (const statement of sql.replace(/^--.*$/gm, "").split(";").filter(s => s.trim())) await connection.query(statement);
  }
  repository = new MySQLRepository(() => mysql.createConnection(config));
  app = createApp({ repository, adminPassword: password });
});
beforeEach(async () => {
  if (!enabled) return;
  await connection.query("DROP TRIGGER IF EXISTS inventory_ci_force_failure");
  for (const table of ["pages_inventory_import_sessions", "pages_inventory_auth_limits", "pages_inventory_uploads"]) await connection.query(`DELETE FROM ${table}`);
});
after(async () => { if (connection) await connection.end(); });
async function call(path, { method = "GET", body, admin = false, client = "127.0.0.1", handler = app } = {}) {
  return handler(new Request("https://example.test/api" + path, { method, headers: { ...(admin ? { Authorization: `Bearer ${bearer}` } : {}), "x-forwarded-for": client }, ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }) }));
}
async function ok(path, options) { const response = await call(path, options); const result = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`); return result; }
async function begin(bytes, overrides = {}) { return ok("/imports", { method: "POST", admin: true, body: { fileName: "test.xlsx", size: bytes.length, sha256: hash(bytes), ...overrides } }); }
async function send(id, bytes) { for (let index = 0; index * CHUNK_BYTES < bytes.length; index++) await ok(`/imports/${id}/chunks/${index}`, { method: "PUT", admin: true, body: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES) }); }
async function finish(id) { return ok(`/imports/${id}/complete`, { method: "POST", admin: true }); }
async function scalar(sql, args = []) { return Number((await connection.execute(sql, args))[0][0].n); }
const integration = (name, fn) => test(name, { skip: !enabled }, fn);

integration("administrator writes and anonymous pagination preserves fourteen raw cells", async () => {
  assert.equal((await call("/session", { method: "POST", body: { password } })).status, 200);
  const bytes = workbook([exampleRow()]), session = await begin(bytes);
  assert.equal((await call(`/imports/${session.id}/chunks/0`, { method: "PUT", body: bytes })).status, 401);
  await send(session.id, bytes);
  assert.equal((await ok("/uploads")).items.length, 0);
  const saved = await finish(session.id);
  assert.equal(saved.recordCount, 1); assert.equal(saved.duplicate, false);
  const parsed = await loadWorkbook(async path => ok(path.replace(/^\/api/, "")), saved.id);
  assert.deepEqual(parsed.sheets[0].rows[0], exampleRow());
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_import_chunks"), 0);
  assert.equal((await finish(session.id)).id, saved.id);
  assert.equal((await begin(bytes)).published.id, saved.id);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_records"), 1);
});
integration("20 MiB original XLSX crosses 4.5 MB using resumable two-worker chunks", async () => {
  const bytes = padZip(workbook(), MAX_BYTES); const cache = storage(); let lost = false;
  const api = async (path, options = {}) => {
    let body = options.body;
    if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
    else if (typeof body === "string") body = JSON.parse(body);
    const response = await call(path.replace(/^\/api/, ""), { method: options.method || "GET", body, admin: true });
    const result = await response.json();
    if (!response.ok) throw new ApiError(result.detail, response.status);
    // Simulate the server receiving chunk 2 while its HTTP response is lost once.
    if (!lost && path.endsWith("/chunks/2")) { lost = true; throw new ApiError("response lost"); }
    return result;
  };
  const saved = await publishExcel({ api, file: new File([bytes], "boundary.xlsx"), storage: cache, scope: "ci", delay: async () => {} });
  assert.equal(saved.recordCount, 1); assert.equal(lost, true); assert.equal(cache.size, 0);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_import_chunks"), 0);
  assert.equal((await call("/imports", { method: "POST", admin: true, body: { fileName: "too-big.xlsx", size: MAX_BYTES + 1, sha256: hash(bytes) } })).status, 400);
});
integration("missing, conflicting and corrupt chunks never publish partial records", async () => {
  const bytes = padZip(workbook(), CHUNK_BYTES + 1000), session = await begin(bytes);
  await ok(`/imports/${session.id}/chunks/0`, { method: "PUT", body: bytes.subarray(0, CHUNK_BYTES), admin: true });
  assert.deepEqual((await ok(`/imports/${session.id}`, { admin: true })).received, [0]);
  assert.equal((await call(`/imports/${session.id}/complete`, { method: "POST", admin: true })).status, 409);
  assert.equal((await call(`/imports/${session.id}/chunks/0`, { method: "PUT", admin: true, body: Buffer.alloc(CHUNK_BYTES) })).status, 409);
  await send(session.id, bytes); assert.equal((await finish(session.id)).recordCount, 1);
  for (const [content, digest] of [[workbook(), "f".repeat(64)], [Buffer.from("corrupt workbook"), null]]) {
    const draft = await begin(content, digest ? { sha256: digest } : {}); await send(draft.id, content);
    assert.equal((await call(`/imports/${draft.id}/complete`, { method: "POST", admin: true })).status, 422);
  }
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_uploads"), 1);
});
integration("cancel and request-triggered expiry cleanup remove raw chunks", async () => {
  const bytes = workbook(), draft = await begin(bytes); await send(draft.id, bytes);
  await ok(`/imports/${draft.id}`, { method: "DELETE", admin: true });
  assert.equal((await call(`/imports/${draft.id}`, { admin: true })).status, 410);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_import_chunks"), 0);
  const expired = await begin(bytes); await send(expired.id, bytes);
  await connection.execute("UPDATE pages_inventory_import_sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ?", [expired.id]);
  assert.equal((await call(`/imports/${expired.id}`, { admin: true })).status, 410);
  await begin(bytes);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_import_chunks"), 0);
});
integration("forced mid-transaction failure rolls back publication and can be retried", async () => {
  const bytes = workbook(), draft = await begin(bytes); await send(draft.id, bytes);
  await connection.query("CREATE TRIGGER inventory_ci_force_failure BEFORE INSERT ON pages_inventory_records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated forced failure'");
  assert.equal((await call(`/imports/${draft.id}/complete`, { method: "POST", admin: true })).status, 503);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_uploads"), 0);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_records"), 0);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_import_chunks"), 1);
  await connection.query("DROP TRIGGER inventory_ci_force_failure");
  assert.equal((await finish(draft.id)).recordCount, 1);
});
integration("concurrent import sessions converge to one published file and record set", async () => {
  const bytes = workbook(Array.from({ length: 25 }, (_, i) => exampleRow(i)));
  const first = await begin(bytes), second = await begin(bytes);
  await Promise.all([send(first.id, bytes), send(second.id, bytes)]);
  const results = await Promise.all([finish(first.id), finish(second.id)]);
  assert.equal(results[0].id, results[1].id);
  const repeated = await Promise.all([finish(first.id), finish(first.id)]); assert.equal(repeated[0].id, results[0].id);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_uploads"), 1);
  assert.equal(await scalar("SELECT COUNT(*) n FROM pages_inventory_records"), 25);
});
integration("record pages honor byte and row caps and fully reconstruct more than 500 rows", async () => {
  const rows = Array.from({ length: 601 }, (_, i) => { const row = exampleRow(i); row[1] = "x".repeat(6000); return row; });
  const bytes = workbook(rows), draft = await begin(bytes); await send(draft.id, bytes); const saved = await finish(draft.id);
  let cursor = "0", total = 0, pages = 0;
  do {
    const response = await call(`/uploads/${saved.id}/records?cursor=${cursor}`), text = await response.text();
    assert.ok(Buffer.byteLength(text) <= PAGE_BYTES); const body = JSON.parse(text);
    assert.ok(body.items.length <= 500); total += body.items.length; pages++; cursor = body.nextCursor;
  } while (cursor !== null);
  assert.equal(total, 601); assert.ok(pages > 2);
  const parsed = await loadWorkbook(async path => ok(path.replace(/^\/api/, "")), saved.id);
  assert.deepEqual(parsed.sheets[0].rows, rows);
});
integration("login throttles persist between cloud function instances and reset after five minutes", async () => {
  const other = createApp({ repository: new MySQLRepository(() => mysql.createConnection(config)), adminPassword: password });
  for (let i = 0; i < 10; i++) assert.equal((await call("/session", { method: "POST", body: { password: "wrong" }, handler: i % 2 ? other : app })).status, 401);
  assert.equal((await call("/session", { method: "POST", body: { password }, handler: other })).status, 429);
  await connection.query("UPDATE pages_inventory_auth_limits SET window_start = UTC_TIMESTAMP() - INTERVAL 6 MINUTE");
  assert.equal((await call("/session", { method: "POST", body: { password }, handler: other })).status, 200);
});
