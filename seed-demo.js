import { pool, initializeDatabase } from "./config/db.js";
import { hashPassword, transaction } from "./controllers/controllerHelpers.js";
import { demoEnabled } from "./controllers/retailer/demoController.js";
try {
  if (!demoEnabled())
    throw new Error(
      "Enable DEMO_MODE=true in development before creating the demo account.",
    );
  await initializeDatabase();
  const hashedPassword = await hashPassword("DemoLogin123!");
  const hashedMpin = await hashPassword("1234");
  await transaction(async (client) => {
    const existing = await client.query(
      `SELECT id FROM retailers WHERE retailer_slug='npay-demo-retailer'`,
    );
    if (existing.rowCount) {
      console.log(
        "Demo retailer already exists; credentials and balance were preserved.",
      );
      return;
    }
    const distributor = await client.query(
      `INSERT INTO distributors (name,business_name,phone,email,business_address,pan,adhar,distributor_image_link,distributor_slug,password_hash,status)
      VALUES ('Demo Distributor','nPay Demo','9999900001','demo-distributor@npay.example','Development demo only','DEMOD0001A','990000000001','demo','npay-demo-distributor',$1,'active')
      ON CONFLICT (distributor_slug) DO UPDATE SET distributor_slug=EXCLUDED.distributor_slug RETURNING id`,
      [hashedPassword],
    );
    const retailer = await client.query(
      `INSERT INTO retailers (distributor_id,name,business_name,phone,email,business_address,pan,adhar,retailer_slug,password_hash,mpin_hash,status)
      VALUES ($1,'Demo Retailer','nPay Demo Shop','9999900002','demo-retailer@npay.example','Development demo only','DEMOR0002A','990000000002','npay-demo-retailer',$2,$3,'active') RETURNING id`,
      [distributor.rows[0].id, hashedPassword, hashedMpin],
    );
    await client.query(
      `INSERT INTO retailer_wallets (retailer_id) VALUES ($1)`,
      [retailer.rows[0].id],
    );
    console.log(
      "Created development retailer: phone 9999900002; password DemoLogin123!; M-PIN 1234. Add demo balance from the app.",
    );
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
