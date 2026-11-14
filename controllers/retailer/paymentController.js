import { mroboticsEnabled } from "./mroboticsClient.js";
import { resolveRechargeCatalog, rechargePayload, processRecharge } from "./mroboticsController.js";
import { smepayEnabled, smepayConfig } from "./smepayClient.js";
import { ensureCheckout } from "./smepayController.js";
import { demoEnabled, resolveDemoRecharge } from "./demoController.js";
import {
  createHash,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { pool } from "../../config/db.js";
import {
  fail,
  id,
  text,
  money,
  transaction,
  verifyMpin,
  sendError,
} from "../controllerHelpers.js";
const requestKey = (req) =>
  text(
    req.get("Idempotency-Key") || req.body.idempotency_key,
    "idempotency key",
    150,
  );
const sameRequest = (existing, expected) => {
  if (
    Object.entries(expected).some(
      ([key, value]) => String(existing[key] ?? "") !== String(value ?? ""),
    )
  ) {
    fail(409, "Idempotency key was already used for a different request.");
  }
  return existing;
};
const activeWallet = async (client, req) => {
  const account = await client.query(
    `SELECT id FROM retailers WHERE id = $1 AND status = 'active'
    AND credentials_changed_at = $2 FOR SHARE`,
    [req.auth.id, req.account.credentials_version],
  );
  if (!account.rowCount)
    fail(401, "Account credentials changed. Please sign in again.");
  const wallet = await client.query(
    `SELECT * FROM retailer_wallets WHERE retailer_id = $1 FOR UPDATE`,
    [req.auth.id],
  );
  if (!wallet.rowCount) fail(404, "Wallet not found.");
  return wallet.rows[0];
};

export const createRecharge = async (req, res) => {
  try {
    if (mroboticsEnabled()) await resolveRechargeCatalog(req.body);
    else await resolveDemoRecharge(req.body);
    const { service } = req.body;
    if (!["prepaid", "dth", "google-play"].includes(service))
      fail(400, "Invalid recharge service.");
    const amount = money(
      req.body.amount,
      service === "google-play" ? 10000n : 100n,
      service === "google-play"
        ? 1000000n
        : service === "dth"
          ? 2500000n
          : 10000000n,
    );
    if (service !== "prepaid" && !amount.endsWith(".00"))
      fail(400, "This service requires a whole-rupee amount.");
    const operatorId = id(req.body.operator_id, "operator ID");
    const circleId =
      service === "prepaid" ? id(req.body.circle_id, "circle ID") : null;
    const planId = req.body.plan_id ? id(req.body.plan_id, "plan ID") : null;
    if (service === "prepaid" && !planId) fail(400, "Select a prepaid plan.");
    const recipient =
      service === "google-play"
        ? null
        : text(req.body.recipient, "recipient", 30);
    const key = requestKey(req);
    await verifyMpin(req.auth.id, req.body.mpin);
    const result = await transaction(async (client) => {
      const wallet = await activeWallet(client, req);
      const existing = await client.query(
        `SELECT * FROM transactions WHERE retailer_id = $1 AND idempotency_key = $2`,
        [req.auth.id, key],
      );
      const expected = {
        service,
        amount,
        operator_id: operatorId,
        circle_id: circleId,
        plan_id: planId,
        recipient,
      };
      if (existing.rowCount)
        return {
          existing: true,
          data: sameRequest(existing.rows[0], expected),
        };
      const operatorResult = await client.query(
        `SELECT * FROM service_operators WHERE id = $1 AND service = $2 AND is_active FOR SHARE`,
        [operatorId, service],
      );
      const operator = operatorResult.rows[0];
      if (!operator) fail(400, "Active operator not found for this service.");
      // Compare exact cents through NUMERIC in SQL instead of floating-point arithmetic.
      const bounds = await client.query(
        `SELECT $1::numeric BETWEEN $2::numeric AND $3::numeric AS valid`,
        [amount, operator.min_amount, operator.max_amount],
      );
      if (!bounds.rows[0].valid)
        fail(400, "Amount is outside the operator's allowed range.");
      if (
        service !== "google-play" &&
        (!new RegExp(`^[0-9]{${operator.account_digits || 10}}$`).test(
          recipient,
        ) ||
          (service === "prepaid" && !/^[6-9][0-9]{9}$/.test(recipient)))
      )
        fail(400, "Invalid recipient number.");
      if (circleId) {
        const circle = await client.query(
          `SELECT id FROM telecom_circles WHERE id = $1 AND is_active FOR SHARE`,
          [circleId],
        );
        if (!circle.rowCount) fail(400, "Active circle not found.");
      }
      let plan = {};
      if (planId) {
        const planResult = await client.query(
          `SELECT * FROM recharge_plans WHERE id = $1 AND operator_id = $2 AND is_active
          AND (circle_id IS NULL OR circle_id = $3) FOR SHARE`,
          [planId, operatorId, circleId],
        );
        plan = planResult.rows[0];
        if (!plan || (service === "prepaid" && plan.amount !== amount))
          fail(400, "Plan, amount or circle does not match.");
      }
      const providerPayload = mroboticsEnabled() ? rechargePayload({service,amount,recipient},operator,plan) : null;
      const commission = await client.query(
        `SELECT COALESCE(
        (SELECT rate FROM retailer_commission_slabs WHERE retailer_id = $1 AND operator_id = $2 AND is_active),
        (SELECT rate FROM commision_slab_by_admin WHERE operator_id = $2 AND is_active), 0) AS rate`,
        [req.auth.id, operatorId],
      );
      const response = await client.query(
        `INSERT INTO transactions
        (retailer_id, wallet_id, idempotency_key, service, operator_id, circle_id, plan_id, recipient,
         title, subtitle, plan_snapshot, amount, commission_rate)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          req.auth.id,
          wallet.id,
          key,
          service,
          operatorId,
          circleId,
          planId,
          recipient,
          `${operator.name} ${service === "google-play" ? "code" : service}`,
          recipient ? `•••• ${recipient.slice(-4)}` : "Gift code",
          JSON.stringify(plan),
          amount,
          commission.rows[0].rate,
        ],
      );
      let payment = response.rows[0];
      if (providerPayload) {
        payment = (await client.query("UPDATE transactions SET provider='mrobotics' WHERE id=$1 RETURNING *", [payment.id])).rows[0];
        await client.query("INSERT INTO recharge_submissions(transaction_id,request_payload) VALUES($1,$2)", [payment.id,JSON.stringify(providerPayload)]);
      }
      const funds = await client.query(
        `SELECT $1::numeric >= $2::numeric AS sufficient`,
        [wallet.balance, amount],
      );
      if (!funds.rows[0].sufficient)
        fail(400, "Wallet balance is too low for this recharge.");
      await client.query(
        `INSERT INTO wallet_entries (wallet_id, retailer_id, transaction_id, kind, amount)
        VALUES ($1,$2,$3,'recharge',$4)`,
        [wallet.id, req.auth.id, payment.id, amount],
      );
      return {
        existing: false,
        data: payment,
      };
    });
    result.data = result.data.provider === "mrobotics" ? await processRecharge(result.data,{submit:true}) : await settleDemo(result.data, req.auth.id);
    return res.status(result.existing ? 200 : 202).json({
      success: true,
      msg: result.data.provider === "mrobotics" ? "Recharge request recorded. The server verifies provider results before settlement." : demoEnabled() ? "Demo recharge completed; no operator was contacted." : "Recharge request is pending. Funds are reserved; no recharge provider has been called.",
      data: result.data,
      ...(demoEnabled() && result.data.provider !== "mrobotics" ? { demo: true } : {}),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createWalletTopup = async (req, res) => {
  try {
    if (smepayEnabled()) smepayConfig();
    const amount = money(req.body.amount, 100n, 10000000n);
    const key = requestKey(req);
    const result = await transaction(async (client) => {
      const wallet = await activeWallet(client, req);
      const existing = await client.query(
        `SELECT * FROM transactions WHERE retailer_id = $1 AND idempotency_key = $2`,
        [req.auth.id, key],
      );
      if (existing.rowCount)
        return {
          existing: true,
          data: sameRequest(existing.rows[0], {
            service: "wallet",
            amount,
          }),
        };
      const response = await client.query(
        `INSERT INTO transactions
        (retailer_id, wallet_id, idempotency_key, service, title, subtitle, amount, payment_method)
        VALUES ($1,$2,$3,'wallet','Wallet top-up','Awaiting payment verification',$4,'manual') RETURNING *`,
        [req.auth.id, wallet.id, key, amount],
      );
      return {
        existing: false,
        data: response.rows[0],
      };
    });
    result.data = smepayEnabled() ? await ensureCheckout(result.data, req.account) : await settleDemo(result.data, req.auth.id);
    return res.status(result.existing ? 200 : 202).json({
      success: true,
      msg: smepayEnabled() ? "SMEPay checkout ready. Balance changes only after server verification." : result.data.provider?.startsWith("smepay-") ? "This payment belongs to SMEPay. Its balance changes only after gateway verification." : demoEnabled() ? "Demo payment completed; no real money was transferred." : "Top-up request created. Balance changes only after payment verification by an admin.",
      data: result.data,
      ...(!smepayEnabled() && demoEnabled() && result.data.provider === "demo-provider" ? { demo: true } : {}),
    });
  } catch (error) {
    return sendError(res, error);
  }
};
const giftKey = () => {
  if (!process.env.GIFT_CODE_KEY && demoEnabled()) return createHash("sha256").update(`npay-demo:${process.env.JWT_SECRET}`).digest();
  if (!/^[0-9a-f]{64}$/i.test(process.env.GIFT_CODE_KEY || ""))
    fail(503, "Gift-code encryption is not configured.");
  return Buffer.from(process.env.GIFT_CODE_KEY, "hex");
};
const encryptCode = (code, transactionId) => {
  const key = giftKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(transactionId));
  const encrypted = Buffer.concat([
    cipher.update(code, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: [iv, cipher.getAuthTag(), encrypted]
      .map((value) => value.toString("base64"))
      .join("."),
    fingerprint: createHmac("sha256", key)
      .update(`gift-code:${code.replace(/[\s-]/g, "").toUpperCase()}`)
      .digest("hex"),
  };
};

export const getGiftCode = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.code_ciphertext, g.issued_at, g.expires_at, t.id FROM google_play_codes g
      JOIN transactions t ON t.id = g.transaction_id WHERE t.id = $1 AND t.retailer_id = $2 AND t.status = 'Successful'`,
      [id(req.params.id), req.auth.id],
    );
    if (!result.rowCount)
      return res.status(404).json({
        success: false,
        msg: "Issued gift code not found.",
      });
    const row = result.rows[0];
    const [iv, tag, encrypted] = row.code_ciphertext
      .split(".")
      .map((part) => Buffer.from(part, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", giftKey(), iv);
    decipher.setAAD(Buffer.from(row.id));
    decipher.setAuthTag(tag);
    const code = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
    res.set("Cache-Control", "no-store");
    return res.status(200).json({
      success: true,
      data: {
        code,
        issued_at: row.issued_at,
        expires_at: row.expires_at,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

// Admin-only manual settlement while provider integration is intentionally deferred.

export const settleTransaction = async (req, res) => {
  try {
    const transactionId = id(req.params.id);
    const { status } = req.body;
    if (!["Successful", "Failed"].includes(status))
      fail(400, "Settlement status must be Successful or Failed.");
    const amount = money(req.body.amount);
    const reference = text(
      req.body.reference,
      "external verification reference",
      200,
    );
    const reason = text(req.body.reason, "settlement reason", 2000);
    if (req.body.currency !== "INR")
      fail(400, "Settlement currency must be INR.");
    const result = await settlePayment({ transactionId, status, amount, reference, reason, actorId: req.auth.id, provider: "manual-admin", giftCode: req.body.gift_code });
    return res.status(200).json({
      success: true,
      msg: "Transaction settled successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getSettlementEvents = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, provider, event_id, payload, received_at, processed_at, processing_error
      FROM provider_events WHERE transaction_id = $1 ORDER BY received_at DESC`,
      [id(req.params.id)],
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const settlePayment = async ({ transactionId, status, amount, reference, reason, actorId, provider, giftCode }) => {
  return transaction(async (client) => {
      const response = await client.query(
        `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
        [transactionId],
      );
      const payment = response.rows[0];
      if (!payment) fail(404, "Transaction not found.");
      if (payment.amount !== amount)
        fail(400, "Amount does not match transaction.");
      if (payment.status !== "Pending") {
        if (
          payment.status !== status ||
          payment.provider_reference !== reference
        )
          fail(409, "Transaction already has a different final settlement.");
        return payment;
      }
      let encryptedCode;
      if (payment.service === "google-play" && status === "Successful") {
        encryptedCode = encryptCode(
          text(giftCode, "provider-issued gift code", 200),
          transactionId,
        );
      }
      const event = await client.query(
        `INSERT INTO provider_events (provider, event_id, transaction_id, payload)
        VALUES ($4, $1, $2, $3) RETURNING id`,
        [
          transactionId,
          transactionId,
          JSON.stringify({
            ...(provider === "manual-admin" ? { admin_id: actorId } : provider === "demo-provider" ? { retailer_id: actorId, demo: true } : { gateway: provider.startsWith("smepay-") ? "smepay" : provider }),
            status,
            amount,
            currency: "INR",
            reference,
            reason,
          }),
          provider,
        ],
      );
      const updated = await client.query(
        `UPDATE transactions SET status = $1, provider = $5, provider_reference = $2,
        failure_reason = $3, completed_at = NOW() WHERE id = $4 RETURNING *`,
        [status, reference, status === "Failed" ? reason : null, transactionId, provider],
      );
      const post = async (kind, entryAmount) =>
        client.query(
          `INSERT INTO wallet_entries
        (wallet_id, retailer_id, transaction_id, kind, amount) VALUES ($1,$2,$3,$4,$5)`,
          [
            payment.wallet_id,
            payment.retailer_id,
            payment.id,
            kind,
            entryAmount,
          ],
        );
      if (payment.service === "wallet") {
        if (status === "Successful") await post("topup", payment.amount);
      } else if (status === "Failed") {
        await post("refund", payment.amount);
      } else if (Number(payment.commission_amount) > 0) {
        await post("commission", payment.commission_amount);
      }
      if (encryptedCode)
        await client.query(
          `INSERT INTO google_play_codes (transaction_id, code_ciphertext, code_fingerprint, provider_reference)
        VALUES ($1,$2,$3,$4)`,
          [
            transactionId,
            encryptedCode.ciphertext,
            encryptedCode.fingerprint,
            reference,
          ],
        );
      await client.query(
        `UPDATE provider_events SET processed_at = NOW() WHERE id = $1`,
        [event.rows[0].id],
      );
      return updated.rows[0];
    });
};

const settleDemo = async (payment, retailerId) => {
  if (!demoEnabled() || payment.status !== "Pending" || (payment.provider?.startsWith("smepay-") || payment.provider === "mrobotics")) return payment;
  return settlePayment({transactionId:payment.id,status:"Successful",amount:payment.amount,
    reference:`demo-${payment.id}`,reason:"Development mock only; no payment or recharge provider was contacted.",
    actorId:retailerId,provider:"demo-provider",giftCode:payment.service === "google-play" ? `DEMO-${randomUUID().toUpperCase()}` : undefined});
};
