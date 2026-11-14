import { initializeDatabase, pool } from "./config/db.js";
import {
  transaction,
  text,
  password,
  hashPassword,
  phonePattern,
  emailPattern,
} from "./controllers/controllerHelpers.js";
try {
  const name = text(process.env.INITIAL_ADMIN_NAME, "INITIAL_ADMIN_NAME", 150);
  const phone = text(
    process.env.INITIAL_ADMIN_PHONE,
    "INITIAL_ADMIN_PHONE",
    10,
  );
  const email = text(
    process.env.INITIAL_ADMIN_EMAIL,
    "INITIAL_ADMIN_EMAIL",
    255,
  ).toLowerCase();
  if (!phonePattern.test(phone) || !emailPattern.test(email))
    throw new Error("Invalid initial admin phone or email.");
  const hashedPassword = await hashPassword(
    password(process.env.INITIAL_ADMIN_PASSWORD),
  );
  await initializeDatabase();
  await transaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(170014)`);
    const existing = await client.query(`SELECT id FROM admins LIMIT 1`);
    if (existing.rowCount)
      throw new Error(
        "An admin already exists. Create additional admins through the protected API.",
      );
    await client.query(
      `INSERT INTO admins (name, phone, email, password_hash) VALUES ($1,$2,$3,$4)`,
      [name, phone, email, hashedPassword],
    );
  });
  console.log("Initial admin created successfully.");
} catch (error) {
  console.error("Admin creation failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
