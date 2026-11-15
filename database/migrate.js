import { initializeDatabase, closeDatabase } from "../config/db.js";
try {
  await initializeDatabase();
  console.log("Database migrations completed.");
} catch (error) {
  console.error("Database migration failed:", error.code || "MIGRATION_FAILED");
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
