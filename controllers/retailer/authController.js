import { FIXED_OTP, otpSecret } from "../../config/otp.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { pool } from "../../config/db.js";
import {
  fail,
  text,
  id,
  password,
  pin,
  hashPassword,
  hash,
  keyedHash,
  equal,
  loginAccount,
  safeAccount,
  transaction,
  newSession,
  verifyMpin,
  emailPattern,
  phonePattern,
  sendError,
} from "../controllerHelpers.js";

export const loginRetailer = async (req, res) => {
  try {
    const result = await loginAccount(req, "retailer");
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

export const registerInterest = async (req, res) => {
  const { name, shop_address, phone } = req.body;
  try {
    if (!phonePattern.test(phone || ""))
      return res.status(400).json({
        success: false,
        msg: "Invalid phone number",
      });
    const result = await pool.query(
      `INSERT INTO retailer_interests (name, shop_address, phone) VALUES ($1,$2,$3) RETURNING id, created_at`,
      [text(name, "name", 100), text(shop_address, "shop address", 200), phone],
    );
    return res.status(201).json({
      success: true,
      msg: "Interest submitted successfully. Our team will contact you.",
      data: result.rows[0],
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const refreshSession = async (req, res) => {
  try {
    const suppliedToken = text(req.body.refresh_token, "refresh token", 200);
    const result = await transaction(async (client) => {
      const owner = await client.query(
        `SELECT retailer_id FROM retailer_sessions WHERE refresh_token_hash = $1`,
        [hash(suppliedToken)],
      );
      if (!owner.rowCount) fail(401, "Invalid or expired refresh token.");
      await client.query(`SELECT id FROM retailers WHERE id = $1 FOR UPDATE`, [
        owner.rows[0].retailer_id,
      ]);
      const response = await client.query(
        `SELECT s.id AS session_id, r.*, r.credentials_changed_at::text AS credentials_version FROM retailer_sessions s JOIN retailers r ON r.id = s.retailer_id
        WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() AND r.status = 'active' FOR UPDATE OF s`,
        [hash(suppliedToken)],
      );
      if (!response.rowCount) fail(401, "Invalid or expired refresh token.");
      await client.query(
        `UPDATE retailer_sessions SET revoked_at = NOW() WHERE id = $1`,
        [response.rows[0].session_id],
      );
      return newSession(client, response.rows[0], req.body.device_name);
    });
    return res.status(200).json({
      success: true,
      msg: "Session refreshed.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const logoutRetailer = async (req, res) => {
  try {
    await transaction(async (client) => {
      await client.query(`SELECT id FROM retailers WHERE id = $1 FOR UPDATE`, [
        req.auth.id,
      ]);
      if (req.body.all_devices === true) {
        await client.query(
          `UPDATE retailer_sessions SET revoked_at = NOW() WHERE retailer_id = $1 AND revoked_at IS NULL`,
          [req.auth.id],
        );
      } else {
        await client.query(
          `UPDATE retailer_sessions SET revoked_at = NOW() WHERE id = $1 AND retailer_id = $2`,
          [req.auth.session_id, req.auth.id],
        );
      }
    });
    return res.status(200).json({
      success: true,
      msg: "Signed out successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getRetailerProfile = async (req, res) =>
  res.status(200).json({
    success: true,
    data: safeAccount(req.account),
  });

export const updateRetailerProfile = async (req, res) => {
  try {
    if (
      !(await bcrypt.compare(
        password(req.body.current_password),
        req.account.password_hash,
      ))
    )
      fail(401, "Incorrect current password.");
    const name =
      req.body.name === undefined
        ? req.account.name
        : text(req.body.name, "name", 254);
    const businessName =
      req.body.business_name === undefined
        ? req.account.business_name
        : text(req.body.business_name, "business name", 150);
    if (req.body.name === undefined && req.body.business_name === undefined)
      fail(400, "Provide name or business_name.");
    const result = await pool.query(
      `UPDATE retailers SET name = $1, business_name = $2 WHERE id = $3 AND password_hash = $4 RETURNING *`,
      [name, businessName, req.auth.id, req.account.password_hash],
    );
    if (!result.rowCount) fail(409, "Credentials changed. Sign in again.");
    return res.status(200).json({
      success: true,
      msg: "Profile updated successfully.",
      data: safeAccount(result.rows[0]),
    });
  } catch (error) {
    return sendError(res, error);
  }
};
const issueChallenge = async (account, purpose, destination, channel) => {
  const otp = FIXED_OTP;
  const challengeId = randomUUID();
  const otpHash = keyedHash(`${challengeId}:${otp}`);
  await transaction(async (client) => {
    const current = await client.query(
      `SELECT id FROM retailers WHERE id = $1 AND password_hash = $2 AND status = 'active' FOR UPDATE`,
      [account.id, account.password_hash],
    );
    if (!current.rowCount)
      fail(401, "Account credentials changed. Please sign in again.");
    const recent = await client.query(
      `SELECT id FROM retailer_verifications WHERE retailer_id = $1 AND purpose = $2 AND created_at > NOW() - INTERVAL '1 minute'`,
      [account.id, purpose],
    );
    if (recent.rowCount)
      fail(429, "Wait one minute before requesting another OTP.");
    await client.query(
      `UPDATE retailer_verifications SET expires_at = clock_timestamp()
      WHERE retailer_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()`,
      [account.id, purpose],
    );
    await client.query(
      `INSERT INTO retailer_verifications (id, retailer_id, purpose, channel, destination, otp_hash, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW() + INTERVAL '5 minutes')`,
      [challengeId, account.id, purpose, channel, destination, otpHash],
    );
  });
  return {
    challenge_id: challengeId,
    expires_in: 300,
  };
};

export const requestPasswordReset = async (req, res) => {
  try {
    if (!phonePattern.test(req.body.phone || ""))
      fail(400, "Invalid phone number");
    otpSecret();
    const result = await pool.query(
      `SELECT * FROM retailers WHERE phone = $1 AND status = 'active'`,
      [req.body.phone],
    );
    const data = result.rowCount
      ? await issueChallenge(
          result.rows[0],
          "password_reset",
          result.rows[0].phone,
          "sms",
        )
      : {
          challenge_id: randomUUID(),
          expires_in: 300,
        };
    return res.status(200).json({
      success: true,
      msg: "Verification request prepared. If an active account exists, use the configured verification code.",
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const requestSecurityOtp = async (req, res) => {
  try {
    const { purpose } = req.body;
    if (
      ![
        "password_change",
        "mpin_reset",
        "email_change",
        "phone_verify",
      ].includes(purpose)
    )
      fail(400, "Invalid verification purpose.");
    if (
      !(await bcrypt.compare(
        password(req.body.current_password),
        req.account.password_hash,
      ))
    )
      fail(401, "Incorrect current password.");
    let destination = req.account.phone;
    const channel = purpose === "email_change" ? "email" : "sms";
    if (purpose === "email_change") {
      destination = text(req.body.email, "email", 255).toLowerCase();
      if (!emailPattern.test(destination)) fail(400, "Invalid email ID");
      const existing = await pool.query(
        `SELECT id FROM retailers WHERE lower(email) = $1 AND id <> $2`,
        [destination, req.auth.id],
      );
      if (existing.rowCount) fail(409, "Email ID already exists.");
    }
    const result = await issueChallenge(
      req.account,
      purpose,
      destination,
      channel,
    );
    return res.status(200).json({
      success: true,
      msg: "OTP verification is ready.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

// Password-reset verification is public. Other purposes require a signed-in retailer.

export const verifyOtp = async (req, res) => {
  try {
    const challengeId = id(req.body.challenge_id, "challenge ID");
    const otp = text(req.body.otp, "OTP", 6);
    if (!/^[0-9]{6}$/.test(otp)) fail(400, "OTP must contain 6 digits.");
    const result = await transaction(async (client) => {
      const owner = await client.query(
        `SELECT retailer_id FROM retailer_verifications WHERE id = $1`,
        [challengeId],
      );
      if (!owner.rowCount)
        return {
          error: "Invalid, used or expired OTP.",
        };
      await client.query(`SELECT id FROM retailers WHERE id = $1 FOR UPDATE`, [
        owner.rows[0].retailer_id,
      ]);
      const response = await client.query(
        `SELECT v.*, r.credentials_changed_at::text AS credentials_version, r.status FROM retailer_verifications v
        JOIN retailers r ON r.id = v.retailer_id WHERE v.id = $1 FOR UPDATE OF v`,
        [challengeId],
      );
      const challenge = response.rows[0];
      if (
        !challenge ||
        challenge.status !== "active" ||
        challenge.consumed_at ||
        challenge.verified_at ||
        challenge.expires_at <= new Date() ||
        challenge.attempts >= challenge.max_attempts
      )
        return {
          error: "Invalid, used or expired OTP.",
        };
      if (
        req.auth
          ? challenge.retailer_id !== req.auth.id
          : challenge.purpose !== "password_reset"
      )
        return {
          error: "Invalid verification request.",
        };
      if (!equal(challenge.otp_hash, keyedHash(`${challengeId}:${otp}`))) {
        await client.query(
          `UPDATE retailer_verifications SET attempts = attempts + 1 WHERE id = $1`,
          [challengeId],
        );
        return {
          error: "Incorrect OTP.",
        };
      }
      await client.query(
        `UPDATE retailer_verifications SET verified_at = NOW() WHERE id = $1`,
        [challengeId],
      );
      return {
        verification_token: jwt.sign(
          {
            type: "verification",
            challenge_id: challengeId,
            purpose: challenge.purpose,
            version: challenge.credentials_version,
          },
          process.env.JWT_SECRET,
          {
            subject: challenge.retailer_id,
            expiresIn: "5m",
            algorithm: "HS256",
            issuer: "npay-server",
            audience: "npay-verification",
          },
        ),
      };
    });
    if (result.error)
      return res.status(400).json({
        success: false,
        msg: result.error,
      });
    return res.status(200).json({
      success: true,
      msg: "OTP verified successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};
const consumeVerification = async (req, purposes, apply) => {
  let proof;
  try {
    proof = jwt.verify(
      text(req.body.verification_token, "verification token", 3000),
      process.env.JWT_SECRET,
      {
        algorithms: ["HS256"],
        issuer: "npay-server",
        audience: "npay-verification",
      },
    );
  } catch {
    fail(401, "Invalid or expired verification token.");
  }
  if (
    proof.type !== "verification" ||
    !purposes.includes(proof.purpose) ||
    (req.auth && proof.sub !== req.auth.id)
  )
    fail(403, "Invalid verification purpose.");
  return transaction(async (client) => {
    await client.query(`SELECT id FROM retailers WHERE id = $1 FOR UPDATE`, [
      id(proof.sub),
    ]);
    const response = await client.query(
      `SELECT v.*, r.credentials_changed_at::text AS credentials_version, r.status FROM retailer_verifications v
      JOIN retailers r ON r.id = v.retailer_id WHERE v.id = $1 AND v.retailer_id = $2 FOR UPDATE OF v`,
      [id(proof.challenge_id), id(proof.sub)],
    );
    const challenge = response.rows[0];
    if (
      !challenge ||
      challenge.status !== "active" ||
      challenge.purpose !== proof.purpose ||
      !challenge.verified_at ||
      challenge.consumed_at ||
      challenge.expires_at <= new Date() ||
      challenge.credentials_version !== proof.version
    )
      fail(401, "Verification expired or already used.");
    await apply(client, challenge);
    await client.query(
      `UPDATE retailer_verifications SET consumed_at = NOW() WHERE id = $1`,
      [challenge.id],
    );
  });
};

export const resetPassword = async (req, res) => {
  try {
    const hashedPassword = await hashPassword(password(req.body.new_password));
    await consumeVerification(
      req,
      req.auth ? ["password_change"] : ["password_reset"],
      async (client, challenge) => {
        await client.query(
          `UPDATE retailers SET password_hash = $1, credentials_changed_at = clock_timestamp(),
        failed_login_attempts = 0, login_locked_until = NULL WHERE id = $2`,
          [hashedPassword, challenge.retailer_id],
        );
        await client.query(
          `UPDATE retailer_sessions SET revoked_at = NOW() WHERE retailer_id = $1 AND revoked_at IS NULL`,
          [challenge.retailer_id],
        );
      },
    );
    return res.status(200).json({
      success: true,
      msg: "Password updated successfully. Please sign in again.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const completeEmailChange = async (req, res) => {
  try {
    await consumeVerification(
      req,
      ["email_change"],
      async (client, challenge) => {
        await client.query(
          `UPDATE retailers SET email = $1, is_email_verified = true WHERE id = $2`,
          [challenge.destination, challenge.retailer_id],
        );
      },
    );
    return res.status(200).json({
      success: true,
      msg: "Email updated successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const completePhoneVerification = async (req, res) => {
  try {
    await consumeVerification(
      req,
      ["phone_verify"],
      async (client, challenge) => {
        const result = await client.query(
          `UPDATE retailers SET is_phone_verified = true WHERE id = $1 AND phone = $2`,
          [challenge.retailer_id, challenge.destination],
        );
        if (!result.rowCount)
          fail(409, "Phone number changed. Request a new OTP.");
      },
    );
    return res.status(200).json({
      success: true,
      msg: "Phone verified successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const resetMpin = async (req, res) => {
  try {
    const mpinHash = await hashPassword(pin(req.body.new_mpin));
    await consumeVerification(
      req,
      ["mpin_reset"],
      async (client, challenge) => {
        await client.query(
          `UPDATE retailers SET mpin_hash = $1, failed_mpin_attempts = 0, mpin_locked_until = NULL,
        credentials_changed_at = clock_timestamp() WHERE id = $2`,
          [mpinHash, challenge.retailer_id],
        );
        await client.query(
          `UPDATE retailer_sessions SET revoked_at = NOW() WHERE retailer_id = $1 AND revoked_at IS NULL`,
          [challenge.retailer_id],
        );
      },
    );
    return res.status(200).json({
      success: true,
      msg: "M-PIN reset successfully. Please sign in again.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const changeMpin = async (req, res) => {
  try {
    const mpinHash = await hashPassword(pin(req.body.new_mpin));
    if (req.account.mpin_hash) {
      await verifyMpin(req.auth.id, req.body.current_mpin);
    } else if (
      !(await bcrypt.compare(
        password(req.body.current_password),
        req.account.password_hash,
      ))
    )
      fail(401, "Incorrect current password.");
    await transaction(async (client) => {
      const response = await client.query(
        `UPDATE retailers SET mpin_hash = $1, credentials_changed_at = clock_timestamp(),
        failed_mpin_attempts = 0, mpin_locked_until = NULL
        WHERE id = $2 AND mpin_hash IS NOT DISTINCT FROM $3 AND password_hash = $4 RETURNING id`,
        [
          mpinHash,
          req.auth.id,
          req.account.mpin_hash,
          req.account.password_hash,
        ],
      );
      if (!response.rowCount)
        fail(409, "Credentials changed. Please sign in again.");
      await client.query(
        `UPDATE retailer_sessions SET revoked_at = NOW() WHERE retailer_id = $1 AND revoked_at IS NULL`,
        [req.auth.id],
      );
    });
    return res.status(200).json({
      success: true,
      msg: "M-PIN updated successfully. Please sign in again.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};
