import { otpSecret } from "../config/otp.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { pool } from "../config/db.js";

export const accountTables = {
  admin: "admins",
  distributor: "distributors",
  retailer: "retailers",
};

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const phonePattern = /^[6-9][0-9]{9}$/;

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const fail = (status, msg) => {
  const error = new Error(msg);
  error.status = status;
  throw error;
};

export const text = (value, label, max = 255) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail(400, `Invalid ${label}`);
  return value.trim();
};

export const id = (value, label = "ID") => {
  if (typeof value !== "string" || !uuidPattern.test(value))
    fail(400, `Invalid ${label}`);
  return value.toLowerCase();
};

export const password = (value) => {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    Buffer.byteLength(value) > 72
  ) {
    fail(
      400,
      "Password must be at least 8 characters and at most 72 bytes long.",
    );
  }
  return value;
};

export const pin = (value) => {
  if (typeof value !== "string" || !/^[0-9]{4}$/.test(value))
    fail(400, "M-PIN must contain 4 digits.");
  return value;
};

export const money = (value, min = 1n, max = 10000000n) => {
  if (typeof value !== "string" && typeof value !== "number")
    fail(400, "Invalid amount.");
  const raw = String(value);
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw))
    fail(400, "Invalid amount. Use at most two decimal places.");
  const [whole, decimal = ""] = raw.split(".");
  const cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0"));
  if (cents < min || cents > max)
    fail(400, "Amount is outside the allowed range.");
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};

export const hash = (value) => createHash("sha256").update(value).digest("hex");

export const keyedHash = (value) => {
  const secret = otpSecret();
  return createHmac("sha256", secret).update(value).digest("hex");
};

export const equal = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

export const hashPassword = async (value) => {
  const saltRounds = Number(process.env.SALT_ROUNDS || 12);
  if (!Number.isInteger(saltRounds) || saltRounds < 10 || saltRounds > 15)
    fail(503, "Invalid password hashing configuration.");
  return bcrypt.hash(value, saltRounds);
};

export const transaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const sendError = (res, error) => {
  if (error.status)
    return res.status(error.status).json({
      success: false,
      msg: error.message,
    });
  if (error.code === "23505")
    return res.status(409).json({
      success: false,
      msg: "Record already exists or request was already processed.",
    });
  if (
    ["23503", "23514", "23502", "22P02", "22001", "22003"].includes(error.code)
  ) {
    return res.status(400).json({
      success: false,
      msg: "Invalid data or referenced record.",
    });
  }
  console.error("Request failed:", error.code || error.name);
  return res.status(500).json({
    success: false,
    msg: "Internal server error",
  });
};

export const pagination = (req) => {
  const limit = Number(req.query.limit || 20);
  const page = Number(req.query.page || 1);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100000
  )
    fail(400, "Invalid pagination.");
  return {
    limit,
    offset: (page - 1) * limit,
    page,
  };
};

export const safeAccount = (row) => {
  const { password_hash, mpin_hash, adhar, pan, credentials_version, ...data } =
    row;
  if (data.bank_account_number)
    data.bank_account_number = `•••• ${data.bank_account_number.slice(-4)}`;
  if (adhar) data.aadhaar = `•••• •••• ${adhar.slice(-4)}`;
  if (pan) data.pan = `${pan.slice(0, 5)} •••• ${pan.slice(-1)}`;
  data.has_mpin = Boolean(mpin_hash);
  return data;
};

export const tokenFor = (account, role, sessionId) =>
  jwt.sign(
    {
      role,
      version: account.credentials_version,
      ...(sessionId
        ? {
            session_id: sessionId,
          }
        : {}),
    },
    process.env.JWT_SECRET,
    {
      subject: account.id,
      expiresIn: role === "retailer" ? "15m" : "1h",
      algorithm: "HS256",
      issuer: "npay-server",
      audience: "npay-app",
    },
  );

export const newSession = async (client, account, deviceName) => {
  const refreshToken = randomBytes(48).toString("hex");
  const result = await client.query(
    `INSERT INTO retailer_sessions (retailer_id, refresh_token_hash, device_name, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '30 days') RETURNING id`,
    [
      account.id,
      hash(refreshToken),
      typeof deviceName === "string" ? deviceName.slice(0, 200) : null,
    ],
  );
  return {
    access_token: tokenFor(account, "retailer", result.rows[0].id),
    refresh_token: refreshToken,
    expires_in: 900,
  };
};

export const loginAccount = async (req, role) => {
  const phone = text(req.body.phone, "phone", 10);
  if (!phonePattern.test(phone)) fail(400, "Invalid phone number");
  const suppliedPassword = password(req.body.password);
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT *, credentials_changed_at::text AS credentials_version FROM ${accountTables[role]} WHERE phone = $1 FOR UPDATE`,
      [phone],
    );
    const account = result.rows[0];
    if (!account)
      return {
        error: "Invalid phone number or password.",
      };
    if (role === "retailer" && account.login_locked_until > new Date())
      return {
        error: "Account temporarily locked. Try again later.",
      };
    if (
      !account.password_hash ||
      !(await bcrypt.compare(suppliedPassword, account.password_hash))
    ) {
      if (role === "retailer")
        await client.query(
          `UPDATE retailers SET failed_login_attempts = failed_login_attempts + 1,
         login_locked_until = CASE WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END WHERE id = $1`,
          [account.id],
        );
      return {
        error: "Invalid phone number or password.",
      };
    }
    if (role === "admin" ? !account.is_active : account.status !== "active")
      return {
        error: "Account is not active.",
      };
    if (role === "retailer") {
      await client.query(
        `UPDATE retailers SET failed_login_attempts = 0, login_locked_until = NULL, last_login_at = NOW() WHERE id = $1`,
        [account.id],
      );
      return {
        ...(await newSession(client, account, req.body.device_name)),
        account: safeAccount(account),
      };
    }
    return {
      access_token: tokenFor(account, role),
      expires_in: 3600,
      account: safeAccount(account),
    };
  });
};

export const verifyMpin = async (retailerId, suppliedPin) => {
  pin(suppliedPin);
  const result = await transaction(async (client) => {
    const response = await client.query(
      `SELECT mpin_hash, failed_mpin_attempts, mpin_locked_until FROM retailers WHERE id = $1 FOR UPDATE`,
      [retailerId],
    );
    const account = response.rows[0];
    if (!account?.mpin_hash) return "Set your M-PIN before continuing.";
    if (account.mpin_locked_until > new Date())
      return "M-PIN temporarily locked. Try again later.";
    if (!(await bcrypt.compare(suppliedPin, account.mpin_hash))) {
      await client.query(
        `UPDATE retailers SET failed_mpin_attempts = failed_mpin_attempts + 1,
        mpin_locked_until = CASE WHEN failed_mpin_attempts + 1 >= 5 THEN NOW() + INTERVAL '15 minutes' ELSE NULL END WHERE id = $1`,
        [retailerId],
      );
      return "Incorrect M-PIN.";
    }
    await client.query(
      `UPDATE retailers SET failed_mpin_attempts = 0, mpin_locked_until = NULL WHERE id = $1`,
      [retailerId],
    );
    return null;
  });
  if (result) fail(401, result);
};

export const changeStaffPassword = async (req, role) => {
  const currentPassword = password(req.body.current_password);
  const hashedPassword = await hashPassword(password(req.body.new_password));
  await transaction(async (client) => {
    const result = await client.query(
      `SELECT password_hash FROM ${accountTables[role]} WHERE id = $1 FOR UPDATE`,
      [req.auth.id],
    );
    if (
      !result.rowCount ||
      !(await bcrypt.compare(currentPassword, result.rows[0].password_hash))
    )
      fail(401, "Incorrect current password.");
    await client.query(
      `UPDATE ${accountTables[role]} SET password_hash = $1, credentials_changed_at = clock_timestamp() WHERE id = $2`,
      [hashedPassword, req.auth.id],
    );
  });
};
