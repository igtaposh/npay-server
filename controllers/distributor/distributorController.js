import { bankFields } from "./walletController.js";
import { ensureDistributorWallet } from "../../services/distributorWallet.js";
import { changeStaffPassword } from "../controllerHelpers.js";
import { pool } from "../../config/db.js";
import {
  emailPattern,
  phonePattern,
  password,
  pin,
  text,
  id,
  fail,
  hashPassword,
  loginAccount,
  safeAccount,
  transaction,
  pagination,
  sendError,
} from "../controllerHelpers.js";
const partnerFields = async (body) => {
  if (!phonePattern.test(body.phone || "")) fail(400, "Invalid phone number");
  if (!emailPattern.test(body.email || "")) fail(400, "Invalid email ID");
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(body.pan || "")) fail(400, "Invalid PAN");
  if (!/^[0-9]{12}$/.test(body.adhar || ""))
    fail(400, "Invalid Aadhaar number");
  if (
    body.gst &&
    !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(body.gst)
  )
    fail(400, "Invalid GST number");
  return [
    text(body.name, "name", 150),
    text(body.business_name, "business name", 150),
    body.phone,
    body.email.trim().toLowerCase(),
    text(body.business_address, "business address", 2000),
    body.pan,
    body.adhar,
    body.gst || null,
    await hashPassword(password(body.password)),
  ];
};

export const createDistributor = async (req, res) => {
  try {
    const fields = await partnerFields(req.body);
    const result = await transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO distributors
      (name, business_name, phone, email, business_address, pan, adhar, gst, password_hash, distributor_slug, distributor_image_link, status, bank_account_holder, bank_name, bank_account_number, bank_ifsc)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$14,$15) RETURNING *`,
        [
          ...fields,
          text(req.body.distributor_slug, "distributor slug", 100),
          text(req.body.distributor_image_link, "image link", 2000),
          ...bankFields(req.body),
        ],
      );
      await ensureDistributorWallet(client, result.rows[0].id);
      return result;
    });
    return res.status(201).json({
      success: true,
      msg: "Distributor created successfully.",
      data: safeAccount(result.rows[0]),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const loginDistributor = async (req, res) => {
  try {
    const result = await loginAccount(req, "distributor");
    if (result.error)
      return res.status(401).json({
        success: false,
        msg: result.error,
      });
    return res.status(200).json({
      success: true,
      msg: "Signed in successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getDistributorProfile = async (req, res) =>
  res.status(200).json({
    success: true,
    data: safeAccount(req.account),
  });

export const logoutDistributor = async (req, res) => {
  try {
    await pool.query(
      `UPDATE distributors SET credentials_changed_at = clock_timestamp() WHERE id = $1`,
      [req.auth.id],
    );
    return res.status(200).json({
      success: true,
      msg: "Signed out from all devices.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getDistributors = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const result = await pool.query(
      `SELECT d.*, COALESCE(w.available,0) AS wallet_available, COALESCE(w.reserved,0) AS wallet_reserved
      FROM distributors d LEFT JOIN distributor_wallets w ON w.distributor_id=d.id
      ORDER BY d.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.status(200).json({
      success: true,
      data: result.rows.map(safeAccount),
      page,
      limit,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateDistributorStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "active", "suspended", "closed"].includes(status))
      fail(400, "Invalid status.");
    const result = await pool.query(
      `UPDATE distributors SET status = $1, credentials_changed_at = clock_timestamp() WHERE id = $2 RETURNING *`,
      [status, id(req.params.id)],
    );
    if (!result.rowCount)
      return res.status(404).json({
        success: false,
        msg: "Distributor not found.",
      });
    return res.status(200).json({
      success: true,
      msg: "Distributor updated successfully.",
      data: safeAccount(result.rows[0]),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createRetailer = async (req, res) => {
  try {
    const distributorId =
      req.auth.role === "distributor"
        ? req.auth.id
        : id(req.body.distributor_id, "distributor ID");
    const fields = await partnerFields(req.body);
    const mpinHash = req.body.mpin
      ? await hashPassword(pin(req.body.mpin))
      : null;
    const result = await transaction(async (client) => {
      const distributor = await client.query(
        `SELECT id FROM distributors WHERE id = $1 AND status = 'active' FOR SHARE`,
        [distributorId],
      );
      if (!distributor.rowCount) fail(400, "Active distributor not found.");
      const response = await client.query(
        `INSERT INTO retailers
        (name, business_name, phone, email, business_address, pan, adhar, gst, password_hash, distributor_id, retailer_slug, mpin_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          ...fields,
          distributorId,
          text(req.body.retailer_slug, "retailer slug", 100),
          mpinHash,
        ],
      );
      await client.query(
        `INSERT INTO retailer_wallets (retailer_id) VALUES ($1)`,
        [response.rows[0].id],
      );
      if (req.body.interest_id) {
        const interest = await client.query(
          `UPDATE retailer_interests SET status = 'approved', retailer_id = $1, distributor_id = $2
          WHERE id = $3 AND phone = $4 AND retailer_id IS NULL AND (distributor_id = $2 OR ($5 AND distributor_id IS NULL)) RETURNING id`,
          [
            response.rows[0].id,
            distributorId,
            id(req.body.interest_id),
            req.body.phone,
            req.auth.role === "admin",
          ],
        );
        if (!interest.rowCount)
          fail(409, "Interest is unavailable or does not match retailer.");
      }
      return response.rows[0];
    });
    return res.status(201).json({
      success: true,
      msg: "Retailer and wallet created successfully.",
      data: safeAccount(result),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getRetailers = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const distributorId =
      req.auth.role === "distributor"
        ? req.auth.id
        : req.query.distributor_id
          ? id(req.query.distributor_id)
          : null;
    const result = await pool.query(
      `SELECT r.*, w.balance FROM retailers r LEFT JOIN retailer_wallets w ON w.retailer_id = r.id
      WHERE ($1::uuid IS NULL OR r.distributor_id = $1) ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [distributorId, limit, offset],
    );
    return res.status(200).json({
      success: true,
      data: result.rows.map(safeAccount),
      page,
      limit,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateRetailerStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["pending", "active", "suspended", "closed"].includes(status))
      fail(400, "Invalid status.");
    const result = await transaction(async (client) => {
      const response = await client.query(
        `UPDATE retailers SET status = $1, credentials_changed_at = clock_timestamp()
        WHERE id = $2 AND ($3::uuid IS NULL OR distributor_id = $3) RETURNING *`,
        [
          status,
          id(req.params.id),
          req.auth.role === "distributor" ? req.auth.id : null,
        ],
      );
      if (!response.rowCount) fail(404, "Retailer not found.");
      await client.query(
        `UPDATE retailer_sessions SET revoked_at = NOW() WHERE retailer_id = $1 AND revoked_at IS NULL`,
        [req.params.id],
      );
      return response.rows[0];
    });
    return res.status(200).json({
      success: true,
      msg: "Retailer updated successfully.",
      data: safeAccount(result),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getInterests = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const result = await pool.query(
      `SELECT * FROM retailer_interests WHERE ($1::uuid IS NULL OR distributor_id = $1)
      ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.auth.role === "distributor" ? req.auth.id : null, limit, offset],
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
      page,
      limit,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateInterest = async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (!["new", "contacted", "rejected"].includes(status))
      fail(400, "Use retailer creation to approve an interest.");
    const distributorId =
      req.body.distributor_id == null ? null : id(req.body.distributor_id);
    if (
      req.auth.role !== "admin" &&
      distributorId &&
      distributorId !== req.auth.id
    )
      fail(403, "Access denied.");
    const result = await pool.query(
      `UPDATE retailer_interests SET status = $1, notes = $2,
      distributor_id = CASE WHEN $3 THEN COALESCE($4, distributor_id) ELSE distributor_id END
      WHERE id = $5 AND retailer_id IS NULL AND ($6::uuid IS NULL OR distributor_id = $6) RETURNING *`,
      [
        status,
        notes == null ? null : text(notes, "notes", 2000),
        req.auth.role === "admin",
        distributorId,
        id(req.params.id),
        req.auth.role === "distributor" ? req.auth.id : null,
      ],
    );
    if (!result.rowCount)
      return res.status(404).json({
        success: false,
        msg: "Unapproved interest not found.",
      });
    return res.status(200).json({
      success: true,
      msg: "Interest updated successfully.",
      data: result.rows[0],
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getRetailerTransactions = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const result = await pool.query(
      `SELECT t.* FROM transactions t JOIN retailers r ON r.id = t.retailer_id
      WHERE r.id = $1 AND r.distributor_id = $2 ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [id(req.params.id), req.auth.id, limit, offset],
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
      page,
      limit,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const changeDistributorPassword = async (req, res) => {
  try {
    await changeStaffPassword(req, "distributor");
    return res.status(200).json({
      success: true,
      msg: "Password updated successfully. Please sign in again.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};
