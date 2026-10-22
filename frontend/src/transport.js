import { CHUNK_BYTES } from "../../shared/limits.js";
import { MAX_RECORDS } from "../../shared/inventory-core.js";
export class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}
export function createApi({ root = "", token = () => "", fetchImpl = fetch } = {}) {
  return async (path, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (token()) headers.set("Authorization", `Bearer ${token()}`);
    let response;
    try {
      response = await fetchImpl(root + path, { ...options, headers, credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(path.endsWith("/complete") ? 310000 : options.method ? 120000 : 30000) });
    } catch { throw new ApiError("无法连接共享服务；已接收的分块会保留，可以重试继续上传"); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(typeof body.detail === "string" ? body.detail : "接口请求失败，请稍后重试", response.status);
    return body;
  };
}
export async function loadWorkbook(api, id) {
  const data = await api(`/api/uploads/${encodeURIComponent(id)}`);
  if (!Number.isInteger(data.recordCount) || data.recordCount < 1 || data.recordCount > MAX_RECORDS || !Array.isArray(data.sheets)) throw new Error("共享数据格式不正确");
  const sheets = data.sheets.map(sheet => ({ name: sheet.name, rows: [], rowNumbers: [] }));
  const byName = new Map(sheets.map(sheet => [sheet.name, sheet]));
  let cursor = "0", count = 0;
  const seen = new Set();
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error("共享数据分页游标重复，请重试");
    seen.add(cursor);
    const page = await api(`/api/uploads/${encodeURIComponent(id)}/records?cursor=${encodeURIComponent(cursor)}`);
    if (!Array.isArray(page.items) || (page.nextCursor !== null && !/^\d+$/.test(page.nextCursor))) throw new Error("共享数据分页格式不正确");
    for (const item of page.items) {
      const sheet = byName.get(item.sheetName);
      if (!sheet || ++count > data.recordCount) throw new Error("共享工作表记录不正确");
      sheet.rows.push(item.cells); sheet.rowNumbers.push(item.rowNumber);
    }
    if (!page.items.length && page.nextCursor !== null) throw new Error("共享分页没有返回记录");
    cursor = page.nextCursor;
  }
  if (count !== data.recordCount) throw new Error("共享记录未读取完整，请重新刷新");
  return { ...data, sheets };
}
export async function publishExcel({ api, file, storage = sessionStorage, scope = location.origin, onProgress = () => {}, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `inventory-import:${scope}:${sha256}`;
  let savedId;
  try { savedId = storage.getItem(key); } catch { /* Storage may be disabled. Upload still works. */ }
  let session;
  if (savedId) {
    try { session = await api(`/api/imports/${encodeURIComponent(savedId)}`); }
    catch (error) { if (![404, 410].includes(error.status)) throw error; }
  }
  if (!session) {
    session = await api("/api/imports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileName: file.name, size: file.size, sha256 }) });
    if (session.id) try { storage.setItem(key, session.id); } catch { /* Optional resume cache. */ }
  }
  const forget = () => { try { storage.removeItem(key); } catch { /* Optional resume cache. */ } };
  if (session.published) { forget(); return session.published; }
  if (!session.id || session.chunkBytes !== CHUNK_BYTES || !Array.isArray(session.received) || (session.sha256 && session.sha256 !== sha256) || (session.size && session.size !== file.size)) throw new Error("上传会话与当前文件不匹配");
  const total = Math.ceil(file.size / CHUNK_BYTES), received = new Set(session.received), missing = [];
  for (const index of received) if (!Number.isInteger(index) || index < 0 || index >= total) throw new Error("服务器返回的分块列表不正确");
  for (let i = 0; i < total; i++) if (!received.has(i)) missing.push(i);
  let next = 0;
  onProgress({ phase: "uploading", done: received.size, total });
  const worker = async () => {
    while (next < missing.length) {
      const index = missing[next++];
      for (let attempt = 0; ; attempt++) {
        try {
          await api(`/api/imports/${session.id}/chunks/${index}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(index * CHUNK_BYTES, Math.min(file.size, (index + 1) * CHUNK_BYTES)) });
          break;
        } catch (error) {
          if (attempt >= 2 || (error.status && ![408, 429].includes(error.status) && error.status < 500)) throw error;
          await delay(500 * 2 ** attempt);
        }
      }
      received.add(index); onProgress({ phase: "uploading", done: received.size, total });
    }
  };
  const workers = await Promise.allSettled([worker(), worker()]);
  const failure = workers.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  onProgress({ phase: "publishing", done: total, total });
  const result = await api(`/api/imports/${session.id}/complete`, { method: "POST" });
  forget(); return result;
}
