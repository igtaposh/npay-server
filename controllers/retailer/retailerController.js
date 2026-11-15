import { mroboticsEnabled, mroboticsConfig } from "./mroboticsClient.js";
import { comingSoon } from "./serviceAvailability.js";
import { pool } from "../../config/db.js";
import { fail, id, pagination, sendError } from "../controllerHelpers.js";

export const getOperators = async (req, res) => {
  try {
    const service = req.query.service || null;
    if (service === "dth" || service === "google-play")
      return comingSoon(res, service);
    if (service && !["prepaid", "dth", "google-play"].includes(service))
      fail(400, "Invalid service.");
    const result = await pool.query(
      `SELECT * FROM service_operators WHERE is_active = true AND service = 'prepaid' AND ($1::text IS NULL OR service = $1) ORDER BY name`,
      [service],
    );
    return res.status(200).json({
      success: true,
      data: mroboticsEnabled()
        ? result.rows.filter((operator) =>
            Boolean(mroboticsConfig().companies[operator.code]),
          )
        : result.rows,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getCircles = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM telecom_circles WHERE is_active = true ORDER BY name`,
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getPlans = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    if (["dth", "gift-code"].includes(req.query.category))
      return comingSoon(
        res,
        req.query.category === "dth" ? "dth" : "google-play",
      );
    const operatorId = id(req.query.operator_id, "operator ID");
    const selectedOperator = await pool.query(
      "SELECT service FROM service_operators WHERE id=$1",
      [operatorId],
    );
    const service = selectedOperator.rows[0]?.service;
    if (service === "dth" || service === "google-play")
      return comingSoon(res, service);
    const circleId = req.query.circle_id ? id(req.query.circle_id) : null;
    const category = req.query.category || null;
    if (
      category &&
      ![
        "popular",
        "unlimited",
        "data",
        "talktime",
        "isd",
        "topup",
        "dth",
        "gift-code",
      ].includes(category)
    )
      fail(400, "Invalid category.");
    const search =
      typeof req.query.q === "string" ? req.query.q.slice(0, 100) : "";
    const result = await pool.query(
      `SELECT p.* FROM recharge_plans p JOIN service_operators o ON o.id = p.operator_id
      WHERE o.is_active AND p.is_active AND o.service='prepaid' AND p.code NOT LIKE 'demo-%' AND p.operator_id = $1 AND (p.circle_id IS NULL OR p.circle_id = $2)
      AND ($7::boolean = false OR p.mrobotics_is_stv IS NOT NULL)
      AND ($3::text IS NULL OR p.category = $3)
      AND (p.name ILIKE '%' || $4 || '%' OR p.amount::text LIKE '%' || $4 || '%' OR p.description ILIKE '%' || $4 || '%')
      ORDER BY p.amount, p.id LIMIT $5 OFFSET $6`,
      [
        operatorId,
        circleId,
        category,
        search,
        limit,
        offset,
        mroboticsEnabled(),
      ],
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

export const getWallet = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, balance, currency, updated_at FROM retailer_wallets WHERE retailer_id = $1`,
      [req.auth.id],
    );
    if (!result.rowCount)
      return res.status(404).json({
        success: false,
        msg: "Wallet not found.",
      });
    return res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getWalletEntries = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const result = await pool.query(
      `SELECT * FROM wallet_entries WHERE retailer_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [req.auth.id, limit, offset],
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

export const getTransactions = async (req, res) => {
  try {
    const { limit, offset, page } = pagination(req);
    const category = req.query.category || null;
    const status = req.query.status || null;
    if (category && !["recharge", "wallet", "google-play"].includes(category))
      fail(400, "Invalid category.");
    if (status && !["Pending", "Successful", "Failed"].includes(status))
      fail(400, "Invalid status.");
    const result = await pool.query(
      `SELECT * FROM transactions WHERE retailer_id = $1
      AND ($2::text IS NULL OR category = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`,
      [req.auth.id, category, status, limit, offset],
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

export const getTransaction = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM transactions WHERE id = $1 AND retailer_id = $2`,
      [id(req.params.id), req.auth.id],
    );
    if (!result.rowCount)
      return res.status(404).json({
        success: false,
        msg: "Transaction not found.",
      });
    return res.status(200).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getCommissions = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id AS operator_id, o.code, o.name AS company, o.service,
      retailer_commission_rate($1, o.id) AS rate FROM service_operators o
      WHERE o.is_active ORDER BY o.service, o.name`,
      [req.auth.id],
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getHelp = async (req, res) => {
  try {
    const [contacts, company, faqs] = await Promise.all([
      pool.query(
        `SELECT DISTINCT ON (role) * FROM team_contacts WHERE is_active AND (distributor_id = $1 OR distributor_id IS NULL)
        ORDER BY role, distributor_id NULLS LAST, sort_order`,
        [req.account.distributor_id],
      ),
      pool.query(
        `SELECT * FROM company_details ORDER BY created_at DESC LIMIT 1`,
      ),
      pool.query(
        `SELECT * FROM faq WHERE is_active ORDER BY sort_order, created_at`,
      ),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        team_contacts: contacts.rows,
        company: company.rows[0] || null,
        faqs: faqs.rows,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getPrivacyPolicy = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM privacy_policy WHERE is_active ORDER BY sort_order, created_at`,
    );
    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getDeveloper = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM developer_details ORDER BY created_at DESC LIMIT 1`,
    );
    return res.status(200).json({
      success: true,
      data: result.rows[0] || null,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const lookupDthCustomer = (req, res) => comingSoon(res, "dth");

export const lookupMobileOperator = async (req, res) => {
  return res.status(503).json({
    success: false,
    msg: "Operator detection will be available after recharge-provider integration. Select an operator and circle manually.",
  });
};
