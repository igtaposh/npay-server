import jwt from "jsonwebtoken";
import { pool } from "../config/db.js";
import { accountTables, sendError, uuidPattern } from "../controllers/controllerHelpers.js";

export const protect = role => async (req, res, next) => {
  try {
    const bearer = req.headers.authorization;
    if (!bearer?.startsWith("Bearer ")) return res.status(401).json({
      success: false,
      msg: "Please sign in."
    });
    let payload;
    try {
      payload = jwt.verify(bearer.slice(7), process.env.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "npay-server",
        audience: "npay-app"
      });
    } catch {
      return res.status(401).json({
        success: false,
        msg: "Invalid or expired token."
      });
    }
    if (payload.role !== role || !uuidPattern.test(payload.sub)) return res.status(403).json({
      success: false,
      msg: "Access denied."
    });
    const result = await pool.query(`SELECT *, credentials_changed_at::text AS credentials_version FROM ${accountTables[role]} WHERE id = $1`, [payload.sub]);
    const account = result.rows[0];
    if (!account || payload.version !== account.credentials_version || (role === "admin" ? !account.is_active : account.status !== "active")) {
      return res.status(401).json({
        success: false,
        msg: "Account or session is no longer active."
      });
    }
    if (role === "retailer") {
      if (!uuidPattern.test(payload.session_id || "")) return res.status(401).json({
        success: false,
        msg: "Invalid session."
      });
      const session = await pool.query(`SELECT id FROM retailer_sessions WHERE id = $1 AND retailer_id = $2 AND revoked_at IS NULL AND expires_at > NOW()`, [payload.session_id, account.id]);
      if (!session.rowCount) return res.status(401).json({
        success: false,
        msg: "Session expired. Please sign in."
      });
    }
    req.auth = {
      id: account.id,
      role,
      session_id: payload.session_id
    };
    req.account = account;
    next();
  } catch (error) {
    return sendError(res, error);
  }
};

// Per-process limiter. Use a shared reverse-proxy/Redis limiter across multiple instances.
const buckets = new Map();

export const rateLimit = (max = 20, windowMs = 60000) => (req, res, next) => {
  const now = Date.now();
  const key = `${req.ip}:${req.baseUrl}:${req.path}`;
  if (buckets.size > 10000) for (const [bucketKey, bucket] of buckets) if (bucket.expires <= now) buckets.delete(bucketKey);
  let bucket = buckets.get(key);
  if (!bucket || bucket.expires <= now) {
    if (buckets.size >= 20000) return res.status(429).json({
      success: false,
      msg: "Too many requests. Try again shortly."
    });
    bucket = {
      count: 0,
      expires: now + windowMs
    };
    buckets.set(key, bucket);
  }
  if (++bucket.count > max) {
    res.set("Retry-After", String(Math.ceil((bucket.expires - now) / 1000)));
    return res.status(429).json({
      success: false,
      msg: "Too many requests. Try again shortly."
    });
  }
  next();
};
