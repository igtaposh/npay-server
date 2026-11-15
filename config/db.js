import { databaseOptions, shouldMigrateOnStartup } from "./databaseOptions.js";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import path from "node:path";
const { Pool } = pg;
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

// Previous local-only configuration retained for reference.
// export const pool = new Pool({
//   host: process.env.DB_HOST,
//   port: process.env.DB_PORT,
//   database: process.env.DB_NAME,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
// });
export const pool = new Pool(databaseOptions());
// Session advisory locks must never run through transaction pooling.
export const sessionPool = process.env.DATABASE_URL
  ? new Pool(databaseOptions(process.env, { direct: true }))
  : pool;
export const closeDatabase = () =>
  Promise.all(
    [...new Set([pool, sessionPool])].map((connectionPool) =>
      connectionPool.end(),
    ),
  );
export async function prepareDatabase() {
  if (shouldMigrateOnStartup()) await initializeDatabase();
  else await pool.query("SELECT 1");
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationFolder = path.join(__dirname, "../database/migrations");

export const initializeDatabase = async () => {
  // const client = await pool.connect();
  const client = await sessionPool.connect();
  try {
    const files = (await readdir(migrationFolder))
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      console.log(`Running migration: ${file}`);
      const sql = await readFile(path.join(migrationFolder, file), "utf8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`Completed: ${file}`);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", error);
    throw error;
  } finally {
    client.release();
  }
};
// Previous per-connection logging retained for reference.
// try {
//   pool.on("connect", () => {
//     console.log("Database is connected.");
//   });
// } catch (error) {
//   console.log("error connecting to database :", error);
// }
for (const connectionPool of new Set([pool, sessionPool])) {
  connectionPool.on("error", (error) => {
    // Do not log connection URLs, SQL, or provider/customer data.
    console.error("Idle database connection failed:", error.code || "UNKNOWN");
  });
}
