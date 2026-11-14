import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const database = process.env.POSTMAN_TEST_DB_NAME;
if (!/^npay_test_[a-zA-Z0-9_]+$/.test(database || "")) {
  throw new Error("Set POSTMAN_TEST_DB_NAME to a fresh disposable npay_test_* database.");
}
const apiPort = Number(process.env.POSTMAN_TEST_API_PORT || 38081);
const otpPort = Number(process.env.POSTMAN_TEST_OTP_PORT || 38082);
if (![apiPort, otpPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535) || apiPort === otpPort) {
  throw new Error("Invalid fixture ports.");
}
const fixtureKey = "npay-postman-fixtures-only";
Object.assign(process.env, {
  DEMO_MODE: "false",
  PAYMENT_GATEWAY: "",
  RECHARGE_PROVIDER: "",
  DB_HOST: process.env.POSTMAN_TEST_DB_HOST || "127.0.0.1",
  DB_PORT: process.env.POSTMAN_TEST_DB_PORT || "5432",
  DB_NAME: database,
  DB_USER: process.env.POSTMAN_TEST_DB_USER || "postgres",
  DB_PASSWORD: process.env.POSTMAN_TEST_DB_PASSWORD || "",
  JWT_SECRET: randomBytes(32).toString("hex"),
  SALT_ROUNDS: "10",
  OTP_SECRET: randomBytes(32).toString("hex"),
  OTP_API_URL: `http://127.0.0.1:${otpPort}`,
  OTP_API_KEY: fixtureKey,
  GIFT_CODE_KEY: randomBytes(32).toString("hex"),
});
const { pool, initializeDatabase } = await import("../config/db.js");
const { hashPassword } = await import("../controllers/controllerHelpers.js");
const { app } = await import("../app.js");
const deliveries = new Map();
let server;
let support;
const listen = (instance, port) => new Promise((resolve, reject) => {
  instance.once("error", reject);
  instance.listen(port, "127.0.0.1", resolve);
});
try {
  await initializeDatabase();
  const existing = await pool.query("SELECT id FROM admins LIMIT 1");
  if (existing.rowCount) throw new Error("Use a fresh fixture database; this database already contains admins.");
  await pool.query(
    `INSERT INTO admins (name, phone, email, password_hash) VALUES ('Postman Test Admin', '9876500001', 'postman-admin@example.com', $1)`,
    [await hashPassword("PostmanTest123!")],
  );
  support = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${fixtureKey}`) return reply(401, { success: false });
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/send") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 4096) return reply(413, { success: false });
        }
        const data = JSON.parse(raw);
        deliveries.set(data.destination, data.otp);
        return reply(200, { success: true });
      }
      if (req.method === "GET" && url.pathname === "/otp") {
        return reply(200, { success: true, data: { otp: deliveries.get(url.searchParams.get("destination")) || null } });
      }
      if (req.method === "POST" && url.pathname === "/cooldown") {
        await pool.query(`UPDATE retailer_verifications SET created_at = created_at - INTERVAL '2 minutes'`);
        return reply(200, { success: true });
      }
      return reply(404, { success: false });
    } catch {
      return reply(400, { success: false, msg: "Invalid fixture request." });
    }
  });
  await listen(support, otpPort);
  server = createServer(app);
  await listen(server, apiPort);
  console.log(`Fixture API http://127.0.0.1:${apiPort}; fake OTP service http://127.0.0.1:${otpPort}; database ${database}.`);
} catch (error) {
  console.error(error.message);
  support?.close();
  server?.close();
  await pool.end();
  process.exitCode = 1;
}
const shutdown = async () => {
  await Promise.all([server, support].filter(Boolean).map((instance) => new Promise((resolve) => instance.close(resolve))));
  await pool.end();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
