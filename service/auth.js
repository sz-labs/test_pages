import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { check } from "./errors.js";
const hash = (value) => createHash("sha256").update(value).digest();
export function authService(password) {
  function configured() { check(typeof password === "string" && password.length >= 16, 503, "请先配置至少 16 字符的 ADMIN_PASSWORD"); }
  const sign = (payload) => createHmac("sha256", password).update(payload).digest("hex");
  return {
    matches(candidate) { configured(); return timingSafeEqual(hash(candidate), hash(password)); },
    issue() {
      configured(); const payload = `${Math.floor(Date.now() / 1000) + 8 * 3600}.${randomBytes(16).toString("hex")}`;
      return { accessToken: `${payload}.${sign(payload)}`, expiresIn: 8 * 3600 };
    },
    require(request) {
      configured(); const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] || "";
      const match = token.match(/^(\d{1,12})\.([a-f0-9]{32})\.([a-f0-9]{64})$/);
      check(match && Number(match[1]) > Date.now() / 1000 && timingSafeEqual(Buffer.from(match[3], "hex"), Buffer.from(sign(`${match[1]}.${match[2]}`), "hex")), 401, "请先以管理员身份登录");
    },
    clientKey(request) {
      configured(); const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
      return createHmac("sha256", password).update(ip).digest("hex");
    },
  };
}
