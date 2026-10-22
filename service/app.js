import { check, HttpError } from "./errors.js";
import { authService } from "./auth.js";
import { MySQLRepository } from "./repository.js";
import { MAX_BYTES, CHUNK_BYTES } from "../shared/limits.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
async function readBody(request, max) {
  const length = request.headers.get("content-length");
  check(!length || /^\d+$/.test(length) && Number(length) <= max, 413, "请求内容过大");
  const chunks = []; let size = 0;
  if (request.body) for await (const chunk of request.body) {
    size += chunk.length;
    check(size <= max, 413, "请求内容过大");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function readJson(request) {
  try { return JSON.parse((await readBody(request, 16384)).toString("utf8")); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "请求 JSON 格式不正确"); }
}

export function createApp({ repository = new MySQLRepository(), adminPassword = process.env.ADMIN_PASSWORD,
  allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://sz-labs.github.io,http://127.0.0.1:5173,http://localhost:5173").split(",") } = {}) {
  const auth = authService(adminPassword);
  return async function handle(request) {
    const url = new URL(request.url);
    const route = "/" + (url.searchParams.get("route") ?? url.pathname.replace(/^\/api\/?/, "")).replace(/^\/+|\/+$/g, "");
    const origin = request.headers.get("origin");
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (origin && (allowedOrigins.includes(origin) || origin === url.origin)) {
      headers["Access-Control-Allow-Origin"] = origin; headers.Vary = "Origin";
      headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Authorization,Content-Type";
    }
    const reply = (data, status = 200) => Response.json(data, { status, headers });
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: origin && !headers["Access-Control-Allow-Origin"] ? 403 : 204, headers });
      check(url.pathname.startsWith("/api/"), 404, "Not found");
      if (request.method === "GET" && route === "/health") return reply(await repository.ping());
      if (request.method === "POST" && route === "/session") {
        const body = await readJson(request);
        check(typeof body?.password === "string" && body.password.length <= 1024 && body.password.length > 0, 400, "请填写管理口令");
        const valid = auth.matches(body.password);
        await repository.recordLogin(auth.clientKey(request), valid);
        check(valid, 401, "管理口令不正确");
        return reply(auth.issue());
      }
      if (request.method === "GET" && route === "/uploads") return reply(await repository.listUploads());
      const upload = route.match(/^\/uploads\/([^/]+)(\/records)?$/);
      if (request.method === "GET" && upload) {
        check(uuid.test(upload[1]), 400, "记录编号不正确");
        if (!upload[2]) return reply(await repository.getUpload(upload[1]));
        const cursor = url.searchParams.get("cursor") || "0";
        check(/^\d{1,20}$/.test(cursor), 400, "分页游标不正确");
        return reply(await repository.getRecords(upload[1], cursor));
      }
      const match = route.match(/^\/imports(?:\/([^/]+)(?:\/chunks\/([^/]+)|(\/complete))?)?$/);
      check(match, 404, "Not found");
      auth.require(request);
      if (request.method === "POST" && !match[1]) {
        const body = await readJson(request);
        check(body && typeof body.fileName === "string" && [...body.fileName].length <= 255 && /\.xlsx$/i.test(body.fileName) && !/[\\/\x00]/.test(body.fileName), 400, "请选择文件名不超过 255 字符的 .xlsx 文件");
        check(Number.isInteger(body.size) && body.size > 0 && body.size <= MAX_BYTES, 400, "文件最大支持 20 MB");
        check(typeof body.sha256 === "string" && /^[a-f0-9]{64}$/.test(body.sha256), 400, "文件摘要不正确");
        return reply(await repository.createImport(body), 201);
      }
      check(match[1] && uuid.test(match[1]), 400, "上传会话编号不正确");
      if (request.method === "GET" && !match[2] && !match[3]) return reply(await repository.getImport(match[1]));
      if (request.method === "DELETE" && !match[2] && !match[3]) return reply(await repository.cancelImport(match[1]));
      if (request.method === "PUT" && match[2] !== undefined) {
        check(/^\d{1,2}$/.test(match[2]), 400, "分块序号不正确");
        return reply(await repository.putChunk(match[1], Number(match[2]), await readBody(request, CHUNK_BYTES)));
      }
      if (request.method === "POST" && match[3]) return reply(await repository.completeImport(match[1]));
      throw new HttpError(405, "请求方法不支持");
    } catch (error) {
      if (error instanceof HttpError) return reply({ detail: error.message }, error.status);
      // Never include driver messages, SQL, connection strings, or credentials in responses/logs.
      console.error("[inventory-api]", typeof error.code === "string" ? error.code : error.constructor.name);
      return reply({ detail: error.code === "ER_NO_SUCH_TABLE" ? "请先按部署说明执行辅助表初始化 SQL" : "数据库服务暂时不可用，请检查服务端配置后重试" }, 503);
    }
  };
}
