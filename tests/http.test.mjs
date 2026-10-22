import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../service/app.js";
import { authService } from "../service/auth.js";
import { MAX_BYTES, CHUNK_BYTES } from "../shared/limits.js";
import { password } from "./helpers.mjs";
const id = "00000000-0000-4000-8000-000000000001";
const bearer = authService(password).issue().accessToken;
function setup() {
  const calls = [];
  const repository = new Proxy({}, { get: (_, key) => async (...args) => { calls.push([key, ...args]); return { id, received: [], chunkBytes: CHUNK_BYTES, items: [] }; } });
  const app = createApp({ repository, adminPassword: password });
  const call = (path, { method = "GET", body, admin = false, headers = {} } = {}) => app(new Request("https://example.test" + path, { method, ...(body === undefined ? {} : { body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) }), headers: { ...(admin ? { Authorization: `Bearer ${bearer}` } : {}), ...headers } }));
  return { calls, call };
}
test("anonymous read routes work through both direct and Vercel rewritten URLs", async () => {
  const { call, calls } = setup();
  assert.equal((await call("/api/health")).status, 200);
  assert.equal((await call("/api/inventory?route=uploads")).status, 200);
  assert.equal((await call(`/api/uploads/${id}/records?cursor=123`)).status, 200);
  assert.equal(calls.at(-1)[2], "123");
  assert.equal((await call("/mysql.local.yaml")).status, 404);
  assert.equal((await call(`/api/uploads/${id}/records?cursor=-1`)).status, 400);
});
test("all import mutations and state require administrator authentication", async () => {
  const { call, calls } = setup();
  for (const [path, method] of [["/api/imports", "POST"], [`/api/imports/${id}`, "GET"], [`/api/imports/${id}`, "DELETE"], [`/api/imports/${id}/chunks/0`, "PUT"], [`/api/imports/${id}/complete`, "POST"]]) assert.equal((await call(path, { method })).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await call("/api/session", { method: "POST", body: { password } })).status, 200);
  assert.equal(calls[0][0], "recordLogin"); assert.equal(calls[0][2], true);
});
test("file metadata permits exactly 20 MiB and rejects oversized or unsafe requests", async () => {
  const { call } = setup(); const body = { fileName: "库存.xlsx", size: MAX_BYTES, sha256: "a".repeat(64) };
  assert.equal((await call("/api/imports", { method: "POST", body, admin: true })).status, 201);
  for (const changes of [{ size: MAX_BYTES + 1 }, { size: 0 }, { fileName: "../evil.xlsx" }, { sha256: "wrong" }]) assert.equal((await call("/api/imports", { method: "POST", body: { ...body, ...changes }, admin: true })).status, 400);
  assert.equal((await call("/api/imports", { method: "POST", body: "bad json", admin: true })).status, 400);
  assert.equal((await call(`/api/imports/${id}/chunks/0`, { method: "PUT", body: new Uint8Array(CHUNK_BYTES + 1), admin: true })).status, 413);
});
test("CORS only enables configured origins and responses do not cache", async () => {
  const { call } = setup();
  assert.equal((await call("/api/imports", { method: "OPTIONS", headers: { origin: "https://untrusted.test" } })).status, 403);
  const response = await call("/api/uploads", { headers: { origin: "https://example.test" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "https://example.test"); assert.equal(response.headers.get("cache-control"), "no-store");
});
