import { mroboticsEnabled } from "./mroboticsClient.js";
import { smepayEnabled } from "./smepayClient.js";
import { pool } from "../../config/db.js";
import { fail } from "../controllerHelpers.js";
import { prepaidPlans, dthProviders, lookupDthCustomer } from "./demoData.js";

export const demoEnabled = () => process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production";

export const getAppConfig = async (req, res) => res.json({
  success: true,
  data: { demo: demoEnabled(), mock_recharge: demoEnabled() && !mroboticsEnabled(), recharge_provider: mroboticsEnabled() ? "mrobotics" : demoEnabled() ? "demo" : "manual", mock_payment: demoEnabled() && !smepayEnabled(), payment_gateway: smepayEnabled() ? "smepay" : demoEnabled() ? "demo" : "manual", mock_otp: demoEnabled() },
});

export const resolveDemoRecharge = async (body) => {
  if (!demoEnabled()) return;
  const operator = await pool.query(`SELECT id FROM service_operators WHERE code = $1 AND service = $2 AND is_active`, [body.operator || (body.service === "google-play" ? "google-play" : null), body.service]);
  if (!body.operator_id && operator.rowCount) body.operator_id = operator.rows[0].id;
  if (body.service !== "prepaid") return;
  if (!body.circle_id) {
    const circle = await pool.query(`SELECT id FROM telecom_circles WHERE name = $1 AND is_active`, [body.circle]);
    body.circle_id = circle.rows[0]?.id;
  }
  if (!body.plan_id && body.plan_code && body.operator_id && body.circle_id) {
    const plan = prepaidPlans.find((p) => p.id === body.plan_code);
    if (!plan) fail(400, "Select a valid demo plan.");
    await pool.query(`INSERT INTO recharge_plans (operator_id, circle_id, code, name, category, amount, data_allowance, validity, description, tag)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (operator_id, circle_id, code) DO NOTHING`,
      [body.operator_id, body.circle_id, `demo-${plan.id}`, `Demo ${plan.description}`, plan.category, plan.amount, plan.data, plan.validity, plan.description, plan.tag || null]);
    const stored = await pool.query(`SELECT id FROM recharge_plans WHERE operator_id = $1 AND circle_id = $2 AND code = $3`, [body.operator_id, body.circle_id, `demo-${plan.id}`]);
    body.plan_id = stored.rows[0].id;
  }
};

export const demoDthCustomer = (body) => {
  if (!demoEnabled()) fail(503, "DTH customer lookup is not configured.");
  const provider = dthProviders.find((p) => p.id === body.operator);
  if (!provider || typeof body.subscriber !== "string" || !new RegExp(`^[0-9]{${provider.digits}}$`).test(body.subscriber)) fail(400, "Invalid DTH subscriber number.");
  return { ...lookupDthCustomer(provider.id, body.subscriber), demo: true };
};
