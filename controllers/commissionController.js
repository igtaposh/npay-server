import { pool } from "../config/db.js";
import {
  fail,
  id,
  pagination,
  sendError,
  transaction,
} from "./controllerHelpers.js";

export const setCommission = async (req, res) => {
  try {
    const distributor = req.auth.role === "distributor";
    const distributorId = distributor
      ? req.auth.id
      : id(req.body.distributor_id, "distributor ID");
    const operatorId = id(req.body.operator_id, "company/operator ID");
    const retailerId = distributor
      ? id(req.body.retailer_id, "retailer ID")
      : null;
    const rate = String(req.body.rate);
    if (!/^\d{1,3}(\.\d{1,4})?$/.test(rate) || Number(rate) > 100)
      fail(
        400,
        "Commission must be between 0 and 100 with at most four decimal places.",
      );
    if (
      req.body.is_active !== undefined &&
      typeof req.body.is_active !== "boolean"
    )
      fail(400, "Invalid status.");
    const active = req.body.is_active ?? true;
    const data = await transaction(async (client) => {
      // Serialize parent and child edits, including first-time allocations.
      const owner = await client.query(
        "SELECT id FROM distributors WHERE id = $1 FOR UPDATE",
        [distributorId],
      );
      if (!owner.rowCount) fail(404, "Distributor not found.");
      const operator = await client.query(
        "SELECT service FROM service_operators WHERE id = $1 AND is_active",
        [operatorId],
      );
      if (!operator.rowCount) fail(400, "Active company/operator not found.");
      if (req.body.service && req.body.service !== operator.rows[0].service)
        fail(400, "Company does not belong to the selected service.");
      if (distributor) {
        const retailer = await client.query(
          "SELECT id FROM retailers WHERE id = $1 AND distributor_id = $2 FOR SHARE",
          [retailerId, distributorId],
        );
        if (!retailer.rowCount)
          fail(404, "Retailer not found in your network.");
        const parent = await client.query(
          "SELECT rate, is_active FROM distributor_commission_slabs WHERE distributor_id = $1 AND operator_id = $2",
          [distributorId, operatorId],
        );
        if (
          active &&
          (!parent.rows[0]?.is_active ||
            Number(rate) > Number(parent.rows[0].rate))
        )
          fail(
            400,
            "Retailer rate cannot exceed your active administrator allocation.",
          );
        return (
          await client.query(
            `INSERT INTO retailer_commission_slabs (retailer_id, operator_id, rate, is_active)
          VALUES ($1,$2,$3,$4) ON CONFLICT (retailer_id, operator_id)
          DO UPDATE SET rate = EXCLUDED.rate, is_active = EXCLUDED.is_active, updated_at = NOW() RETURNING *`,
            [retailerId, operatorId, rate, active],
          )
        ).rows[0];
      }
      const children = await client.query(
        `SELECT MAX(c.rate) AS rate FROM retailer_commission_slabs c
        JOIN retailers r ON r.id = c.retailer_id
        WHERE r.distributor_id = $1 AND c.operator_id = $2 AND c.is_active`,
        [distributorId, operatorId],
      );
      if (active && Number(children.rows[0].rate || 0) > Number(rate))
        fail(
          409,
          "Lower active retailer allocations before reducing this distributor rate.",
        );
      return (
        await client.query(
          `INSERT INTO distributor_commission_slabs (distributor_id, operator_id, rate, is_active)
        VALUES ($1,$2,$3,$4) ON CONFLICT (distributor_id, operator_id)
        DO UPDATE SET rate = EXCLUDED.rate, is_active = EXCLUDED.is_active, updated_at = NOW() RETURNING *`,
          [distributorId, operatorId, rate, active],
        )
      ).rows[0];
    });
    return res.json({
      success: true,
      msg: "Commission saved successfully.",
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getCommissions = async (req, res) => {
  try {
    const distributor = req.auth.role === "distributor";
    const distributorId = distributor
      ? req.auth.id
      : req.query.distributor_id
        ? id(req.query.distributor_id)
        : null;
    const retailerId = req.query.retailer_id ? id(req.query.retailer_id) : null;
    const { limit, offset, page } = pagination(req);
    if (retailerId) {
      const owner = await pool.query(
        "SELECT id FROM retailers WHERE id = $1 AND ($2::uuid IS NULL OR distributor_id = $2)",
        [retailerId, distributorId],
      );
      if (!owner.rowCount) fail(404, "Retailer not found in your network.");
    }
    // Admin setup includes companies that do not have an allocation yet.
    if (!distributor && distributorId && !retailerId) {
      const owner = await pool.query(
        "SELECT id FROM distributors WHERE id = $1",
        [distributorId],
      );
      if (!owner.rowCount) fail(404, "Distributor not found.");
      const result = await pool.query(
        `SELECT o.id AS operator_id, o.name AS company, o.service,
          d.id, $1::uuid AS distributor_id, d.rate, COALESCE(d.is_active,false) AS is_active,
          COALESCE(children.rate,0) AS minimum_rate
        FROM service_operators o
        LEFT JOIN distributor_commission_slabs d ON d.operator_id=o.id AND d.distributor_id=$1
        LEFT JOIN (
          SELECT c.operator_id, MAX(c.rate) AS rate FROM retailer_commission_slabs c
          JOIN retailers r ON r.id=c.retailer_id
          WHERE r.distributor_id=$1 AND c.is_active GROUP BY c.operator_id
        ) children ON children.operator_id=o.id
        WHERE o.is_active ORDER BY o.service,o.name,o.id LIMIT $2 OFFSET $3`,
        [distributorId, limit, offset],
      );
      return res.json({ success: true, data: result.rows, page, limit });
    }
    const result = retailerId
      ? await pool.query(
          `SELECT o.id AS operator_id, o.name AS company, o.service,
          r.id, $1::uuid AS retailer_id, COALESCE(r.rate,0) AS rate, COALESCE(r.is_active,false) AS is_active,
          COALESCE(CASE WHEN d.is_active THEN d.rate END,0) AS distributor_rate,
          retailer_commission_rate($1,o.id) AS effective_rate
          FROM service_operators o
          JOIN retailers owner ON owner.id = $1
          LEFT JOIN retailer_commission_slabs r ON r.operator_id = o.id AND r.retailer_id = owner.id
          LEFT JOIN distributor_commission_slabs d ON d.operator_id = o.id AND d.distributor_id = owner.distributor_id
          WHERE o.is_active ORDER BY o.service, o.name LIMIT $2 OFFSET $3`,
          [retailerId, limit, offset],
        )
      : await pool.query(
          `SELECT d.*, o.name AS company, o.service, owner.name AS distributor
          FROM distributor_commission_slabs d JOIN service_operators o ON o.id = d.operator_id
          JOIN distributors owner ON owner.id = d.distributor_id
          WHERE ($1::uuid IS NULL OR d.distributor_id = $1)
          ORDER BY o.service, o.name, d.distributor_id LIMIT $2 OFFSET $3`,
          [distributorId, limit, offset],
        );
    return res.json({ success: true, data: result.rows, page, limit });
  } catch (error) {
    return sendError(res, error);
  }
};
