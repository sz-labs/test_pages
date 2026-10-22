import test from "node:test";
import assert from "node:assert/strict";
import { publishExcel, loadWorkbook, createApi, ApiError } from "../frontend/src/transport.js";
import { CHUNK_BYTES } from "../shared/limits.js";
import { storage } from "./helpers.mjs";

test("upload uses at most two 1 MiB requests, retries idempotently and resumes missing chunks", async () => {
  const cache = storage(), received = new Set(), attempts = new Map();
  const file = new File([new Uint8Array(5 * CHUNK_BYTES + 19)], "large.xlsx");
  let running = 0, maximum = 0, offline = true, creates = 0;
  const api = async (path, options = {}) => {
    if (path === "/api/imports") { creates++; return { id: "session-id", received: [], chunkBytes: CHUNK_BYTES }; }
    if (path === "/api/imports/session-id") return { id: "session-id", received: [...received], chunkBytes: CHUNK_BYTES };
    if (path.endsWith("/complete")) { assert.equal(received.size, 6); return { id: "published-id" }; }
    const index = Number(path.split("/").at(-1)); attempts.set(index, (attempts.get(index) || 0) + 1);
    running++; maximum = Math.max(maximum, running);
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(options.body.size, index === 5 ? 19 : CHUNK_BYTES);
      if (offline && index === 2) throw new ApiError("connection lost");
      received.add(index); return { received: true };
    } finally { running--; }
  };
  const options = { api, file, storage: cache, scope: "test", delay: async () => {} };
  await assert.rejects(publishExcel(options), /connection lost/);
  assert.equal(cache.size, 1); assert.equal(attempts.get(2), 3); assert.equal(maximum, 2);
  const completedBefore = new Set(received); offline = false;
  const result = await publishExcel(options);
  assert.equal(result.id, "published-id"); assert.equal(cache.size, 0); assert.equal(creates, 1);
  for (const index of completedBefore) assert.equal(attempts.get(index), 1);
});
test("a lost completion response returns original receipt on retry", async () => {
  const cache = storage(); let published = false, creates = 0;
  const api = async path => {
    if (path === "/api/imports") { creates++; return { id: "session-id", received: [], chunkBytes: CHUNK_BYTES }; }
    if (path.endsWith("/chunks/0")) return {};
    if (path.endsWith("/complete")) { published = true; throw new ApiError("response lost"); }
    return { id: "session-id", published: { id: "same-published-id", duplicate: true } };
  };
  const options = { api, file: new File(["bytes"], "test.xlsx"), storage: cache, scope: "test" };
  await assert.rejects(publishExcel(options)); assert.equal(published, true);
  assert.equal((await publishExcel(options)).id, "same-published-id"); assert.equal(creates, 1); assert.equal(cache.size, 0);
});
test("expired sessions are replaced; authorization errors preserve resume state", async () => {
  const cache = storage(); const file = new File(["abc"], "test.xlsx"); let mode = "initial", creates = 0;
  const api = async path => {
    if (path === "/api/imports") { creates++; return { id: "session", received: [], chunkBytes: CHUNK_BYTES }; }
    if (path === "/api/imports/session") throw new ApiError("session error", mode === "expired" ? 410 : 401);
    throw new ApiError("offline");
  };
  const options = { api, file, storage: cache, scope: "test", delay: async () => {} };
  await assert.rejects(publishExcel(options)); assert.equal(cache.size, 1);
  await assert.rejects(publishExcel(options), { status: 401 }); assert.equal(creates, 1);
  mode = "expired"; await assert.rejects(publishExcel(options)); assert.equal(creates, 2);
});
test("anonymous paged records merge in order and incomplete or cycling responses fail", async () => {
  const pages = [{ items: [{ sheetName: "sheet", rowNumber: 2, cells: ["0001"] }], nextCursor: "99" }, { items: [{ sheetName: "sheet", rowNumber: 3, cells: ["0002"] }], nextCursor: null }];
  const api = async path => path.includes("/records?") ? pages.shift() : { recordCount: 2, sheets: [{ name: "sheet" }] };
  const result = await loadWorkbook(api, "id"); assert.deepEqual(result.sheets[0].rowNumbers, [2, 3]); assert.equal(result.sheets[0].rows[0][0], "0001");
  await assert.rejects(loadWorkbook(async path => path.includes("/records?") ? { items: [], nextCursor: null } : { recordCount: 2, sheets: [{ name: "sheet" }] }, "id"), /未读取完整/);
  await assert.rejects(loadWorkbook(async path => path.includes("/records?") ? { items: [{ sheetName: "sheet", cells: [], rowNumber: 2 }], nextCursor: "0" } : { recordCount: 2, sheets: [{ name: "sheet" }] }, "id"), /游标重复/);
});
test("API adapter uses bearer only and keeps HTTP errors distinct from network errors", async () => {
  const api = createApi({ token: () => "test-token", fetchImpl: async (path, options) => {
    assert.equal(options.headers.get("authorization"), "Bearer test-token"); assert.equal(options.credentials, "omit");
    return Response.json({ detail: "unauthorized" }, { status: 401 });
  } });
  await assert.rejects(api("/api/imports"), { status: 401 });
  await assert.rejects(createApi({ fetchImpl: async () => { throw new Error("secret internal connection message"); } })("/api/uploads"), { status: 0 });
});
