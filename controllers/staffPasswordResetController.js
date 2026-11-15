import { randomBytes, randomUUID } from "node:crypto";
import { FIXED_OTP, otpSecret } from "../config/otp.js";
import { accountTables, equal, fail, hashPassword, id, keyedHash, password, phonePattern, sendError, transaction } from "./controllerHelpers.js";

// Replace this function with the SMS API integration. Keep the code and reset
// tokens out of responses/logs. The temporary code comes from config/otp.js.
async function preparePasswordResetOtp() {
  return FIXED_OTP;
}
const active = (account, role) => account && (role === "admin" ? account.is_active : account.status === "active");

export function staffPasswordReset(role) {
  if (!["admin", "distributor"].includes(role)) throw new Error("Unsupported password-reset role");
  const table = accountTables[role];
  const ownerColumn = `${role}_id`;
  const invalid = "Invalid or expired reset request. Request a new OTP.";

  // Always lock the account before its challenges to serialize request/verify/reset.
  async function lockChallenge(client, challengeId) {
    const lookup = await client.query(`SELECT ${ownerColumn} AS account_id FROM staff_password_resets WHERE id = $1 AND role = $2`, [challengeId, role]);
    if (!lookup.rowCount) return null;
    const owner = await client.query(`SELECT *, credentials_changed_at::text AS credentials_version FROM ${table} WHERE id = $1 FOR UPDATE`, [lookup.rows[0].account_id]);
    if (!active(owner.rows[0], role)) return null;
    const result = await client.query(`SELECT *, expires_at > clock_timestamp() AS unexpired FROM staff_password_resets WHERE id = $1 AND role = $2 FOR UPDATE`, [challengeId, role]);
    const challenge = result.rows[0];
    if (!challenge || challenge.consumed_at || !challenge.unexpired || challenge.attempts >= 5 || challenge.credentials_version !== owner.rows[0].credentials_version) return null;
    return { challenge, account: owner.rows[0] };
  }

  return {
    requestOtp: async (req, res) => {
      try {
        otpSecret();
        const phone = req.body.phone;
        if (typeof phone !== "string" || !phonePattern.test(phone)) fail(400, "Enter a valid 10-digit phone number.");
        const challengeId = randomUUID();
        const result = await transaction(async (client) => {
          const found = await client.query(`SELECT *, credentials_changed_at::text AS credentials_version FROM ${table} WHERE phone = $1 FOR UPDATE`, [phone]);
          const account = found.rows[0];
          if (!active(account, role)) return null;
          const recent = await client.query(`SELECT id FROM staff_password_resets WHERE ${ownerColumn} = $1 AND created_at > clock_timestamp() - INTERVAL '1 minute' LIMIT 1`, [account.id]);
          if (recent.rowCount) return { cooldown: true };
          const otp = await preparePasswordResetOtp({ phone, role, challengeId });
          await client.query(`UPDATE staff_password_resets SET consumed_at = clock_timestamp() WHERE ${ownerColumn} = $1 AND consumed_at IS NULL`, [account.id]);
          await client.query(`INSERT INTO staff_password_resets (id, role, ${ownerColumn}, credentials_version, otp_hash, expires_at)
            VALUES ($1,$2,$3,$4,$5,clock_timestamp() + INTERVAL '10 minutes')`,
            [challengeId, role, account.id, account.credentials_version, keyedHash(`${role}:${challengeId}:${otp}`)]);
          return { ready: true };
        });
        if (result?.cooldown) fail(429, "Wait one minute before requesting another OTP.");
        return res.json({ success: true, msg: "If an active account exists, OTP verification is ready.", data: { challenge_id: challengeId, expires_in: 600, resend_after: 60 } });
      } catch (error) { return sendError(res, error); }
    },
    verifyOtp: async (req, res) => {
      try {
        const challengeId = id(req.body.challenge_id, "reset request");
        const otp = req.body.otp;
        if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) fail(400, "OTP must contain 6 digits.");
        const result = await transaction(async (client) => {
          const locked = await lockChallenge(client, challengeId);
          if (!locked || locked.challenge.verified_at) return { error: invalid };
          if (!equal(locked.challenge.otp_hash, keyedHash(`${role}:${challengeId}:${otp}`))) {
            await client.query("UPDATE staff_password_resets SET attempts = attempts + 1 WHERE id = $1", [challengeId]);
            return { error: "Invalid OTP. After five failed attempts, request a new OTP." };
          }
          const resetToken = randomBytes(32).toString("hex");
          await client.query("UPDATE staff_password_resets SET verified_at = clock_timestamp(), reset_token_hash = $2 WHERE id = $1", [challengeId, keyedHash(resetToken)]);
          return { reset_token: resetToken };
        });
        if (result.error) fail(400, result.error);
        return res.json({ success: true, msg: "OTP verified. Set your new password.", data: result });
      } catch (error) { return sendError(res, error); }
    },
    resetPassword: async (req, res) => {
      try {
        const challengeId = id(req.body.challenge_id, "reset request");
        const newPassword = password(req.body.password);
        const token = req.body.reset_token;
        if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) fail(400, invalid);
        const result = await transaction(async (client) => {
          const locked = await lockChallenge(client, challengeId);
          if (!locked || !locked.challenge.verified_at || !equal(locked.challenge.reset_token_hash, keyedHash(token))) return { error: invalid };
          const passwordHash = await hashPassword(newPassword);
          await client.query(`UPDATE ${table} SET password_hash = $2, credentials_changed_at = clock_timestamp() WHERE id = $1`, [locked.account.id, passwordHash]);
          await client.query(`UPDATE staff_password_resets SET consumed_at = clock_timestamp(), reset_token_hash = NULL WHERE ${ownerColumn} = $1 AND consumed_at IS NULL`, [locked.account.id]);
          return { done: true };
        });
        if (result.error) fail(400, result.error);
        return res.json({ success: true, msg: "Password reset successfully. Sign in with your new password." });
      } catch (error) { return sendError(res, error); }
    },
  };
}
