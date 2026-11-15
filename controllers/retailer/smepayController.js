// import { pool } from "../../config/db.js";
import { pool, sessionPool } from "../../config/db.js";
import { fail, id, money, sendError } from "../controllerHelpers.js";
import { smepay, smepayConfig, smepayEnabled } from "./smepayClient.js";
import { settlePayment } from "./paymentController.js";
const owned = async (transactionId, retailerId) => {
  const result = await pool.query(
    "SELECT * FROM transactions WHERE id=$1 AND retailer_id=$2 AND service='wallet'",
    [transactionId, retailerId],
  );
  if (!result.rowCount) fail(404, "Wallet payment not found.");
  return result.rows[0];
};
const checkoutData = (row) => ({
  provider: "smepay",
  environment: row.environment,
  payment_link: row.payment_link,
  qr_code: row.qr_code,
  intents: row.intents,
  expires_at: row.expires_at,
  payment_status: row.gateway_status,
});
export const ensureCheckout = async (payment, account) => {
  const settings = smepayConfig();
  if (payment.provider && payment.provider !== `smepay-${settings.environment}`)
    fail(409, "This payment belongs to a different payment provider.");
  await pool.query(
    "UPDATE transactions SET provider=$2,payment_method='upi' WHERE id=$1 AND status='Pending' AND provider IS NULL",
    [payment.id, `smepay-${settings.environment}`],
  );
  payment = {
    ...payment,
    provider: payment.provider || `smepay-${settings.environment}`,
  };
  await pool.query(
    `INSERT INTO payment_checkouts(transaction_id,environment) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [payment.id, settings.environment],
  );
  // Session advisory lock serializes checkout creation across retries and server processes.
  // const client = await pool.connect();
  const client = await sessionPool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      payment.id,
    ]);
    let row = (
      await client.query(
        "SELECT * FROM payment_checkouts WHERE transaction_id=$1",
        [payment.id],
      )
    ).rows[0];
    if (row.environment !== settings.environment)
      fail(409, "This payment belongs to a different gateway environment.");
    if (payment.status !== "Pending")
      return { ...payment, checkout: checkoutData(row) };
    if (!row.slug) {
      let order;
      if (row.attempted) {
        // Never create another order after an ambiguous timeout. Recover by our durable unique reference.
        order = await smepay.request("/api/external/order/status", {
          external_reference_id: payment.id,
        });
      } else {
        await client.query(
          "UPDATE payment_checkouts SET attempted=TRUE WHERE transaction_id=$1",
          [payment.id],
        );
        order = await smepay.request("/api/external/order/create", {
          amount: payment.amount,
          order_id: payment.id,
          callback_url: settings.callback,
          customer_details: {
            name: account.name,
            mobile: account.phone,
            ...(account.email ? { email: account.email } : {}),
          },
        });
      }
      const slug = order.order_slug || order.slug;
      if (
        typeof slug !== "string" ||
        !slug ||
        typeof order.order_id !== "string"
      )
        fail(
          502,
          "Gateway order needs reconciliation. Retry this payment; do not create another payment.",
        );
      row = (
        await client.query(
          `UPDATE payment_checkouts SET slug=$2,gateway_order_id=$3,updated_at=NOW() WHERE transaction_id=$1 RETURNING *`,
          [payment.id, slug, order.order_id],
        )
      ).rows[0];
    }
    if (!row.initiated) {
      if (row.initiate_attempted) return reconcilePayment(payment);
      await client.query(
        "UPDATE payment_checkouts SET initiate_attempted=TRUE WHERE transaction_id=$1",
        [payment.id],
      );
      const result = await smepay.request("/api/external/order/initiate", {
        slug: row.slug,
      });
      const expiry = Number(result.expires_at);
      if (
        !Number.isFinite(expiry) ||
        expiry <= 0 ||
        (!result.payment_link && !result.qr_code)
      )
        fail(502, "Gateway checkout response is incomplete.");
      row = (
        await client.query(
          `UPDATE payment_checkouts SET initiated=TRUE,payment_link=$2,qr_code=$3,intents=$4,expires_at=$5,gateway_status=$6,updated_at=NOW() WHERE transaction_id=$1 RETURNING *`,
          [
            payment.id,
            result.payment_link || null,
            result.qr_code || null,
            JSON.stringify(result.intents || {}),
            new Date(expiry * 1000),
            result.payment_status || "INITIATED",
          ],
        )
      ).rows[0];
    }
    return { ...payment, checkout: checkoutData(row) };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
        payment.id,
      ]);
    } finally {
      client.release();
    }
  }
};
export async function reconcilePayment(payment) {
  const settings = smepayConfig();
  let row = (
    await pool.query(
      "SELECT * FROM payment_checkouts WHERE transaction_id=$1",
      [payment.id],
    )
  ).rows[0];
  if (!row) fail(404, "SMEPay checkout not found.");
  if (row.environment !== settings.environment)
    fail(409, "Gateway environment does not match this payment.");
  if (payment.status !== "Pending")
    return { ...payment, checkout: checkoutData(row) };
  const status = await smepay.request("/api/external/order/status", {
    external_reference_id: payment.id,
  });
  const gatewayStatus = String(status.payment_status || "UNKNOWN");
  // Webhook contents are only a notification: fetch and validate using our saved amount and slug.
  if (money(status.amount) !== payment.amount)
    fail(502, "Gateway amount does not match this payment.");
  if (
    (status.external_reference_id &&
      status.external_reference_id !== payment.id) ||
    (status.order_id &&
      row.gateway_order_id &&
      status.order_id !== row.gateway_order_id)
  )
    fail(502, "Gateway order reference mismatch.");
  const successful =
    gatewayStatus === "SUCCESS" ||
    (settings.environment === "test" && gatewayStatus === "TEST_SUCCESS");
  if (successful) {
    if (!row.slug)
      fail(502, "Gateway validation requires the saved order slug.");
    const proof = await smepay.request(settings.validationPath, {
      amount: Number(payment.amount),
      slug: row.slug,
    });
    const validStatus =
      proof.payment_status === "SUCCESS" ||
      (settings.environment === "test" &&
        proof.payment_status === "TEST_SUCCESS");
    if (proof.status !== true || proof.valid !== true || !validStatus)
      fail(502, "Payment has not passed gateway validation.");
    payment = await settlePayment({
      transactionId: payment.id,
      status: "Successful",
      amount: payment.amount,
      reference: row.gateway_order_id,
      reason: "SMEPay server status and order validation confirmed payment.",
      provider: `smepay-${settings.environment}`,
    });
  }
  // FAILED/EXPIRED can still be followed by late bank confirmation: keep the local transaction reconcilable.
  row = (
    await pool.query(
      `UPDATE payment_checkouts SET gateway_status=$2,last_checked_at=NOW(),updated_at=NOW() WHERE transaction_id=$1 RETURNING *`,
      [payment.id, gatewayStatus],
    )
  ).rows[0];
  return { ...payment, checkout: checkoutData(row) };
}
export const getCheckout = async (req, res) => {
  try {
    if (!smepayEnabled()) fail(503, "SMEPay is not enabled.");
    const payment = await owned(id(req.params.id), req.auth.id);
    const result = await ensureCheckout(payment, req.account);
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error);
  }
};
export const checkPayment = async (req, res) => {
  try {
    if (!smepayEnabled()) fail(503, "SMEPay is not enabled.");
    const result = await reconcilePayment(
      await owned(id(req.params.id), req.auth.id),
    );
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error);
  }
};
export const webhook = async (req, res) => {
  try {
    if (!smepayEnabled()) fail(503, "SMEPay is not enabled.");
    const reference = id(
      req.body.ref_id || req.body.external_reference_id,
      "payment reference",
    );
    const result = await pool.query(
      "SELECT t.* FROM transactions t JOIN payment_checkouts p ON p.transaction_id=t.id WHERE t.id=$1 AND t.service='wallet'",
      [reference],
    );
    if (!result.rowCount) fail(404, "Payment not found.");
    await reconcilePayment(result.rows[0]);
    return res.json({ success: true });
  } catch (error) {
    return sendError(res, error);
  }
};
