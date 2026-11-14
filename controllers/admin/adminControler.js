import { changeStaffPassword } from "../controllerHelpers.js";
import { pool } from "../../config/db.js";
import {
  emailPattern,
  phonePattern,
  password,
  text,
  hashPassword,
  loginAccount,
  safeAccount,
  pagination,
  id,
  fail,
  sendError,
} from "../controllerHelpers.js";

export const createAdmin = async (req, res) => {
  const { name, phone, email, password: suppliedPassword } = req.body;
  try {
    if (!phone || !phonePattern.test(phone))
      return res.status(400).json({
        success: false,
        msg: "Invalid phone number",
      });
    if (!email || !emailPattern.test(email))
      return res.status(400).json({
        success: false,
        msg: "Invalid email ID",
      });
    const hashed_password = await hashPassword(password(suppliedPassword));
    const result = await pool.query(
      `INSERT INTO admins (name, phone, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
      [
        text(name, "name", 150),
        phone,
        email.trim().toLowerCase(),
        hashed_password,
      ],
    );
    return res.status(201).json({
      success: true,
      msg: "Admin created successfully.",
      data: safeAccount(result.rows[0]),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const loginAdmin = async (req, res) => {
  try {
    const result = await loginAccount(req, "admin");
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

export const getAdminProfile = async (req, res) => {
  return res.status(200).json({
    success: true,
    data: safeAccount(req.account),
  });
};

export const logoutAdmin = async (req, res) => {
  try {
    await pool.query(
      `UPDATE admins SET credentials_changed_at = clock_timestamp() WHERE id = $1`,
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

export const getAdmins = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const result = await pool.query(
      `SELECT * FROM admins ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
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

export const updateAdminStatus = async (req, res) => {
  try {
    const adminId = id(req.params.id);
    if (adminId === req.auth.id)
      fail(400, "You cannot deactivate your own account.");
    if (typeof req.body.is_active !== "boolean")
      fail(400, "Invalid account status.");
    const result = await pool.query(
      `UPDATE admins SET is_active = $1, credentials_changed_at = clock_timestamp() WHERE id = $2 RETURNING *`,
      [req.body.is_active, adminId],
    );
    if (!result.rowCount)
      return res.status(404).json({
        success: false,
        msg: "Admin not found.",
      });
    return res.status(200).json({
      success: true,
      msg: "Admin updated successfully.",
      data: safeAccount(result.rows[0]),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getDashboard = async (req, res) => {
  try {
    const result = await pool.query(`SELECT
      (SELECT COUNT(*) FROM distributors) AS distributors,
      (SELECT COUNT(*) FROM retailers) AS retailers,
      (SELECT COUNT(*) FROM retailer_interests WHERE status = 'new') AS new_interests,
      (SELECT COALESCE(SUM(balance), 0) FROM retailer_wallets) AS wallet_balance,
      (SELECT COUNT(*) FROM transactions WHERE status = 'Pending') AS pending_transactions,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'Successful' AND service <> 'wallet') AS recharge_volume`);
    return res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getTransactions = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const retailerId = req.query.retailer_id ? id(req.query.retailer_id) : null;
    const status = req.query.status || null;
    if (status && !["Pending", "Successful", "Failed"].includes(status))
      fail(400, "Invalid status.");
    const result = await pool.query(
      `SELECT * FROM transactions
      WHERE ($1::uuid IS NULL OR retailer_id = $1) AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [retailerId, status, limit, offset],
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

export const changeAdminPassword = async (req, res) => {
  try {
    await changeStaffPassword(req, "admin");
    return res.status(200).json({
      success: true,
      msg: "Password updated successfully. Please sign in again.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};
