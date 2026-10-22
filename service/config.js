import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export function databaseConfig(env = process.env) {
  const filename = path.resolve(env.MYSQL_CONFIG_FILE || "mysql.local.yaml");
  let config;
  try { config = YAML.parse(env.MYSQL_CONFIG_YAML || fs.readFileSync(filename, "utf8"))?.mysql; }
  catch { throw new Error("MySQL configuration unavailable"); }
  for (const key of ["host", "database", "username", "password"]) {
    if (typeof config?.[key] !== "string" || !config[key] || config[key].includes("你的")) throw new Error("MySQL configuration incomplete");
  }
  const port = Number(config.port ?? 3306), timeout = Number(config.connect_timeout_ms ?? 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(timeout) || timeout < 1000 || timeout > 60000 || (config.charset && config.charset !== "utf8mb4")) throw new Error("MySQL configuration invalid");
  let ssl;
  if (config.ssl?.enabled) {
    ssl = { rejectUnauthorized: true };
    if (config.ssl.ca_pem) ssl.ca = config.ssl.ca_pem;
    else if (config.ssl.ca_file) ssl.ca = fs.readFileSync(path.resolve(path.dirname(filename), config.ssl.ca_file), "utf8");
  }
  return { host: config.host, port, database: config.database, user: config.username, password: config.password,
    charset: "utf8mb4", timezone: "Z", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    connectTimeout: timeout, multipleStatements: false, ...(ssl ? { ssl } : {}) };
}
