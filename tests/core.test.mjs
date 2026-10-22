import test from "node:test";
import assert from "node:assert/strict";
import { parseExcel } from "../shared/excel.js";
import { MAX_BYTES } from "../shared/limits.js";
import { sqlDecimal } from "../service/repository.js";
import { databaseConfig } from "../service/config.js";
import { authService } from "../service/auth.js";
import { workbook, exampleRow, padZip, password } from "./helpers.mjs";

test("shared parser preserves all fourteen displayed strings, formatted precision and SKU zeros", () => {
  const bytes = workbook([exampleRow()], { format(sheet) { sheet.A2 = { t: "n", v: 42, z: "00000000" }; sheet.J2 = { t: "n", v: 3.14, z: "0.000000" }; } });
  const result = parseExcel(bytes).sheets[0].records[0];
  const expected = exampleRow(); expected[0] = "00000042"; expected[9] = "3.140000";
  assert.deepEqual(result.cells, expected); assert.equal(result.rowNumber, 2);
});
test("exact 20 MiB ZIP workbook passes; 20 MiB plus one and corrupt Excel fail", () => {
  const bytes = padZip(workbook(), MAX_BYTES);
  assert.equal(bytes.length, MAX_BYTES); assert.equal(parseExcel(bytes).sheets[0].records.length, 1);
  assert.throws(() => parseExcel(Buffer.concat([bytes, Buffer.from([0])])), /20 MB/);
  for (const content of [Buffer.alloc(0), Buffer.from("not excel"), workbook().subarray(0, 200)]) assert.throws(() => parseExcel(content));
});
test("oversized inflated ZIP and database field lengths are rejected", () => {
  const bytes = workbook(); const end = bytes.length - 22; const offset = bytes.readUInt32LE(end + 16);
  bytes.writeUInt32LE(129 * 1024 * 1024, offset + 24);
  assert.throws(() => parseExcel(bytes), /128 MB/);
  const row = exampleRow(); row[0] = "x".repeat(256);
  assert.throws(() => parseExcel(workbook([row])), /255/);
});
test("database numeric projection keeps DECIMAL precision while raw strings remain independent", () => {
  assert.equal(sqlDecimal("99,999,999,999,999,999,999,999,999.123456789012"), "99999999999999999999999999.123456789012");
  assert.equal(sqlDecimal("−2.5000000000001"), "-2.5");
  assert.equal(sqlDecimal("1e26"), null); assert.equal(sqlDecimal("NaN"), null); assert.equal(sqlDecimal(""), null);
});
test("private YAML supports environment and TLS PEM without loading client settings", () => {
  const config = databaseConfig({ MYSQL_CONFIG_YAML: 'mysql:\n  host: localhost\n  database: inventory_ci\n  username: tester\n  password: fake-test-secret\n  ssl:\n    enabled: true\n    ca_pem: test-ca' });
  assert.equal(config.user, "tester"); assert.deepEqual(config.ssl, { rejectUnauthorized: true, ca: "test-ca" }); assert.equal(config.multipleStatements, false);
  assert.throws(() => databaseConfig({ MYSQL_CONFIG_YAML: "mysql: {}" }), /incomplete/);
  assert.throws(() => databaseConfig({ MYSQL_CONFIG_YAML: "[broken" }), /unavailable/);
});
test("eight hour signed tokens reject tampering, expiry and other passwords", () => {
  const auth = authService(password); const issued = auth.issue();
  assert.equal(issued.expiresIn, 28800); assert.equal(auth.matches(password), true); assert.equal(auth.matches("wrong"), false);
  const request = token => new Request("https://example.test/api/imports", { headers: { Authorization: `Bearer ${token}` } });
  assert.doesNotThrow(() => auth.require(request(issued.accessToken)));
  assert.throws(() => auth.require(request(issued.accessToken.replace(/.$/, "X"))), { status: 401 });
  assert.throws(() => auth.require(request("1." + issued.accessToken.split(".").slice(1).join("."))), { status: 401 });
  assert.throws(() => authService(password + "changed").require(request(issued.accessToken)), { status: 401 });
  assert.throws(() => authService("").issue(), { status: 503 });
});
