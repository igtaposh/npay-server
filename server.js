import { otpSecret } from "./config/otp.js";
import { startRechargeReconciler } from "./controllers/retailer/mroboticsController.js";
import { app } from "./app.js";
// import { initializeDatabase, pool } from "./config/db.js";
import { prepareDatabase, closeDatabase } from "./config/db.js";
let server;
let stopReconciler = async () => {};
try {
  if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32)
    throw new Error("JWT_SECRET must contain at least 32 bytes.");
  otpSecret();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  // await initializeDatabase();
  await prepareDatabase();
  server = app.listen(port, () =>
    console.log(`Server listening on port ${port}`),
  );
  stopReconciler = startRechargeReconciler();
  server.on("error", async (error) => {
    console.error("Server failed:", error.message);
    await stopReconciler();
    // await pool.end();
    await closeDatabase();
    process.exitCode = 1;
  });
} catch (error) {
  console.error(
    "Failed to initialize the database or start the server:",
    error.message,
  );
  // await pool.end();
  await closeDatabase();
  process.exitCode = 1;
}
const shutdown = () => {
  void stopReconciler().finally(() => {
    if (server)
      server.close(async () => {
        // await pool.end();
        await closeDatabase();
      });
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
