import { pool } from "../../config/db.js";
import {
  fail,
  id,
  money,
  pagination,
  sendError,
  text,
  transaction,
} from "../controllerHelpers.js";
import { ensureDistributorWallet } from "../../services/distributorWallet.js";

export function bankFields(body) {
  const account = String(body.bank_account_number || "").trim();
  const ifsc = String(body.bank_ifsc || "")
    .trim()
    .toUpperCase();
  if (!/^[0-9]{9,18}$/.test(account))
    fail(400, "Bank account number must contain 9 to 18 digits.");
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc))
    fail(400, "Enter a valid IFSC code.");
  return [
    text(body.bank_account_holder, "account holder", 150),
    text(body.bank_name, "bank name", 150),
    account,
    ifsc,
  ];
}
const bankColumns =
  "bank_account_holder, bank_name, bank_account_number, bank_ifsc";

export const getBankAccount = async (req, res) => {
  try {
    const owner = req.auth.role === "admin" ? id(req.params.id) : req.auth.id;
    const result = await pool.query(
      `SELECT ${bankColumns} FROM distributors WHERE id = $1`,
      [owner],
    );
    if (!result.rowCount) fail(404, "Distributor not found.");
    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    return sendError(res, error);
  }
};

// Admins enter bank details at registration and can correct existing accounts.
export const setBankAccount = async (req, res) => {
  try {
    const fields = bankFields(req.body);
    const result = await pool.query(
      `UPDATE distributors SET bank_account_holder=$2, bank_name=$3,
      bank_account_number=$4, bank_ifsc=$5, updated_at=NOW() WHERE id=$1 RETURNING ${bankColumns}`,
      [id(req.params.id), ...fields],
    );
    if (!result.rowCount) fail(404, "Distributor not found.");
    return res.json({
      success: true,
      msg: "Bank account saved. Existing withdrawal requests keep their original bank details.",
      data: result.rows[0],
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getWallet = async (req, res) => {
  try {
    const result = await transaction(async (client) => {
      await ensureDistributorWallet(client, req.auth.id);
      return (
        await client.query(
          `SELECT w.*,
        COALESCE((SELECT SUM(amount) FROM distributor_wallet_entries WHERE distributor_id=w.distributor_id AND kind='commission'),0) AS total_earned,
        COALESCE((SELECT SUM(amount) FROM distributor_withdrawals WHERE distributor_id=w.distributor_id AND status='paid'),0) AS total_paid
        FROM distributor_wallets w WHERE distributor_id=$1`,
          [req.auth.id],
        )
      ).rows[0];
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getWalletEntries = async (req, res) => {
  try {
    const { page, limit, offset } = pagination(req);
    const result = await pool.query(
      `SELECT e.*, t.amount AS recharge_amount, t.commission_rate AS retailer_rate,
      t.distributor_rate, t.distributor_commission_rate AS margin_rate, r.name AS retailer_name, o.name AS company, t.service
      FROM distributor_wallet_entries e LEFT JOIN transactions t ON t.id=e.transaction_id
      LEFT JOIN retailers r ON r.id=t.retailer_id LEFT JOIN service_operators o ON o.id=t.operator_id
      WHERE e.distributor_id=$1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2 OFFSET $3`,
      [req.auth.id, limit, offset],
    );
    return res.json({ success: true, data: result.rows, page, limit });
  } catch (error) {
    return sendError(res, error);
  }
};

export const requestWithdrawal = async (req, res) => {
  try {
    const amount = money(req.body.amount, 1n, 99999999999999n);
    const key = text(
      req.get("Idempotency-Key") || req.body.idempotency_key,
      "idempotency key",
      150,
    );
    const result = await transaction(async (client) => {
      // Locks use account → wallet order, matching registration/configuration.
      const owner = (
        await client.query(
          `SELECT *, credentials_changed_at::text AS credentials_version FROM distributors WHERE id=$1 FOR SHARE`,
          [req.auth.id],
        )
      ).rows[0];
      if (
        !owner ||
        owner.status !== "active" ||
        (req.account?.credentials_version &&
          req.account.credentials_version !== owner.credentials_version)
      )
        fail(401, "Account credentials changed. Please sign in again.");
      await ensureDistributorWallet(client, req.auth.id);
      const wallet = (
        await client.query(
          "SELECT * FROM distributor_wallets WHERE distributor_id=$1 FOR UPDATE",
          [req.auth.id],
        )
      ).rows[0];
      const existing = await client.query(
        "SELECT * FROM distributor_withdrawals WHERE distributor_id=$1 AND idempotency_key=$2",
        [req.auth.id, key],
      );
      if (existing.rowCount) {
        if (existing.rows[0].amount !== amount)
          fail(409, "Idempotency key was used for a different amount.");
        return { data: existing.rows[0], existing: true };
      }
      bankFields(owner);
      const sufficient = await client.query(
        "SELECT $1::numeric <= $2::numeric AS valid",
        [amount, wallet.available],
      );
      if (!sufficient.rows[0].valid)
        fail(400, "Requested amount exceeds your available balance.");
      const created = await client.query(
        `INSERT INTO distributor_withdrawals
        (distributor_id,idempotency_key,amount,${bankColumns}) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.auth.id, key, amount, ...bankFields(owner)],
      );
      const withdrawal = created.rows[0];
      await client.query(
        `INSERT INTO distributor_wallet_entries (distributor_id,withdrawal_id,kind,amount)
        VALUES ($1,$2,'withdrawal_hold',$3)`,
        [req.auth.id, withdrawal.id, amount],
      );
      return { data: withdrawal, existing: false };
    });
    return res
      .status(result.existing ? 200 : 201)
      .json({
        success: true,
        msg: "Withdrawal requested. The amount is reserved until administrator review.",
        data: result.data,
      });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getWithdrawals = async (req, res) => {
  try {
    const { page, limit, offset } = pagination(req);
    const owner =
      req.auth.role === "distributor"
        ? req.auth.id
        : req.query.distributor_id
          ? id(req.query.distributor_id)
          : null;
    const status = req.query.status || null;
    if (status && !["pending", "paid", "rejected"].includes(status))
      fail(400, "Invalid withdrawal status.");
    const result = await pool.query(
      `SELECT w.*, d.name AS distributor_name, d.business_name, d.phone, a.name AS processed_by_name
      FROM distributor_withdrawals w JOIN distributors d ON d.id=w.distributor_id
      LEFT JOIN admins a ON a.id=w.processed_by
      WHERE ($1::uuid IS NULL OR w.distributor_id=$1) AND ($2::text IS NULL OR w.status=$2)
      ORDER BY w.created_at DESC,w.id DESC LIMIT $3 OFFSET $4`,
      [owner, status, limit, offset],
    );
    return res.json({ success: true, data: result.rows, page, limit });
  } catch (error) {
    return sendError(res, error);
  }
};

export const processWithdrawal = async (req, res) => {
  try {
    const status = req.body.status;
    if (!["paid", "rejected"].includes(status))
      fail(400, "Choose paid or rejected.");
    let details = {};
    if (status === "paid") {
      const method = req.body.payment_method;
      if (!["upi", "neft", "imps", "rtgs", "cash", "other"].includes(method))
        fail(400, "Invalid payment method.");
      const paidAt = new Date(req.body.paid_at);
      if (
        typeof req.body.paid_at !== "string" ||
        !Number.isFinite(paidAt.getTime()) ||
        paidAt.getTime() > Date.now() + 300000
      )
        fail(400, "Enter a valid payment date and time.");
      const receipt = req.body.receipt_url
        ? text(req.body.receipt_url, "receipt URL", 2000)
        : null;
      if (receipt) {
        let url;
        try {
          url = new URL(receipt);
        } catch {
          fail(400, "Invalid receipt URL.");
        }
        if (!["http:", "https:"].includes(url.protocol))
          fail(400, "Receipt must be an HTTP or HTTPS link.");
      }
      details = {
        method,
        reference: text(req.body.payment_reference, "payment reference", 200),
        paidAt: paidAt.toISOString(),
        receipt,
        amount: money(req.body.amount, 1n, 99999999999999n),
        notes: req.body.notes
          ? text(req.body.notes, "payment notes", 2000)
          : null,
      };
    } else
      details.reason = text(
        req.body.rejection_reason,
        "rejection reason",
        2000,
      );
    const data = await transaction(async (client) => {
      const withdrawal = (
        await client.query(
          "SELECT * FROM distributor_withdrawals WHERE id=$1 FOR UPDATE",
          [id(req.params.id)],
        )
      ).rows[0];
      if (!withdrawal) fail(404, "Withdrawal request not found.");
      if (withdrawal.status !== "pending")
        fail(
          409,
          "This withdrawal has already been processed. Refresh the request list.",
        );
      if (status === "paid" && details.amount !== withdrawal.amount)
        fail(400, "Payment amount must exactly match the requested amount.");
      if (
        status === "paid" &&
        new Date(details.paidAt) < new Date(withdrawal.created_at)
      )
        fail(400, "Payment date cannot be before the withdrawal request.");
      const updated = await client.query(
        `UPDATE distributor_withdrawals SET status=$2,payment_method=$3,payment_reference=$4,
        paid_at=$5,receipt_url=$6,notes=$7,rejection_reason=$8,processed_by=$9,processed_at=NOW() WHERE id=$1 RETURNING *`,
        [
          withdrawal.id,
          status,
          details.method || null,
          details.reference || null,
          details.paidAt || null,
          details.receipt || null,
          details.notes || null,
          details.reason || null,
          req.auth.id,
        ],
      );
      await client.query(
        `INSERT INTO distributor_wallet_entries (distributor_id,withdrawal_id,kind,amount) VALUES ($1,$2,$3,$4)`,
        [
          withdrawal.distributor_id,
          withdrawal.id,
          status === "paid" ? "withdrawal_paid" : "withdrawal_release",
          withdrawal.amount,
        ],
      );
      return updated.rows[0];
    });
    return res.json({
      success: true,
      msg:
        status === "paid"
          ? "Payment recorded and wallet settled."
          : "Request rejected and reserved funds released.",
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
