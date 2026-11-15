import { pool } from "../../config/db.js";
import {
  fail,
  id,
  text,
  money,
  pagination,
  emailPattern,
  sendError,
} from "../controllerHelpers.js";

// Identifiers come only from this allowlist, never from a URL or request body.
const resources = {
  operator: {
    table: "service_operators",
    required: ["code", "name", "service"],
    fields: {
      code: "text:50",
      name: "text:150",
      service: ["prepaid", "dth", "google-play"],
      logo_url: "optional:2000",
      account_label: "optional:100",
      account_digits: "digits",
      min_amount: "money",
      max_amount: "money",
      is_active: "boolean",
    },
  },
  circle: {
    table: "telecom_circles",
    required: ["code", "name"],
    fields: {
      code: "text:50",
      name: "text:100",
      is_active: "boolean",
    },
  },
  plan: {
    table: "recharge_plans",
    required: ["operator_id", "code", "name", "category", "amount"],
    fields: {
      operator_id: "uuid",
      circle_id: "nullable-uuid",
      code: "text:100",
      name: "text:200",
      category: [
        "popular",
        "unlimited",
        "data",
        "talktime",
        "isd",
        "topup",
        "dth",
        "gift-code",
      ],
      amount: "money",
      data_allowance: "optional:100",
      validity: "optional:100",
      channels: "optional:100",
      description: "optional:5000",
      tag: "optional:100",
      mrobotics_is_stv: "boolean",
      is_active: "boolean",
    },
  },
  faq: {
    table: "faq",
    required: ["question", "answer"],
    fields: {
      question: "text:200",
      answer: "text:10000",
      sort_order: "integer",
      is_active: "boolean",
    },
  },
  privacyPolicy: {
    table: "privacy_policy",
    required: ["title", "text"],
    fields: {
      title: "text:200",
      text: "text:20000",
      sort_order: "integer",
      is_active: "boolean",
    },
  },
  company: {
    table: "company_details",
    required: ["head_office", "email", "phone"],
    fields: {
      head_office: "text:2000",
      sub_office: "json",
      email: "email",
      phone: "phone",
      whatsapp: "optional-phone",
      work_hours: "optional:150",
    },
  },
  teamContact: {
    table: "team_contacts",
    required: ["role", "role_full", "name", "phone"],
    fields: {
      distributor_id: "nullable-uuid",
      role: ["founder", "distributor", "drm", "arm"],
      role_full: "text:200",
      name: "text:150",
      phone: "phone",
      whatsapp: "optional-phone",
      image_url: "optional:2000",
      sort_order: "integer",
      is_active: "boolean",
    },
  },
  developer: {
    table: "developer_details",
    required: ["name", "company", "role", "app_version"],
    fields: {
      name: "text:150",
      company: "text:150",
      role: "text:150",
      github: "optional:150",
      instagram: "optional:150",
      app_version: "text:30",
    },
  },
};
const validateField = (value, type, label) => {
  if (Array.isArray(type)) {
    if (!type.includes(value)) fail(400, `Invalid ${label}`);
    return value;
  }
  if (type === "uuid") return id(value, label);
  if (type === "nullable-uuid") return value === null ? null : id(value, label);
  if (type === "money") return money(value, 1n, 99999999999999n);
  if (type === "boolean") {
    if (typeof value !== "boolean") fail(400, `Invalid ${label}`);
    return value;
  }
  if (type === "integer" || type === "digits") {
    if (
      !Number.isInteger(value) ||
      (type === "digits"
        ? value < 1 || value > 30
        : Math.abs(value) > 2147483647)
    )
      fail(400, `Invalid ${label}`);
    return value;
  }
  if (type === "json") {
    if (
      value !== null &&
      (typeof value !== "object" || JSON.stringify(value).length > 10000)
    )
      fail(400, `Invalid ${label}`);
    return value === null ? null : JSON.stringify(value);
  }
  if (type === "email") {
    if (
      typeof value !== "string" ||
      value.length > 255 ||
      !emailPattern.test(value)
    )
      fail(400, "Invalid email ID");
    return value.toLowerCase();
  }
  if (type.includes("phone")) {
    if (type === "optional-phone" && value === null) return null;
    if (typeof value !== "string" || !/^\+?[0-9 ()-]{7,20}$/.test(value))
      fail(400, `Invalid ${label}`);
    return value;
  }
  if (type.startsWith("optional:") && value === null) return null;
  return text(value, label, Number(type.split(":")[1]));
};
const writeResource = async (resource, req, updating = false) => {
  const config = resources[resource];
  const keys = Object.keys(req.body);
  if (!keys.length || keys.some((key) => !Object.hasOwn(config.fields, key)))
    fail(400, "Provide valid fields only.");
  if (!updating && config.required.some((key) => req.body[key] === undefined))
    fail(400, `Required fields: ${config.required.join(", ")}`);
  const values = keys.map((key) =>
    validateField(req.body[key], config.fields[key], key),
  );
  if (resource === "plan") {
    // Validate the merged record so PATCH cannot change just one side of a relationship.
    const existing = updating
      ? (
          await pool.query(`SELECT * FROM recharge_plans WHERE id = $1`, [
            id(req.params.id),
          ])
        ).rows[0]
      : {};
    if (!existing) fail(404, "Plan not found.");
    const plan = {
      ...existing,
      ...req.body,
    };
    const operator = (
      await pool.query(`SELECT service FROM service_operators WHERE id = $1`, [
        id(plan.operator_id),
      ])
    ).rows[0];
    if (!operator) fail(400, "Operator not found.");
    if (
      (operator.service === "prepaid" &&
        ["dth", "gift-code"].includes(plan.category)) ||
      (operator.service === "dth" && plan.category !== "dth") ||
      (operator.service === "google-play" && plan.category !== "gift-code") ||
      (operator.service !== "prepaid" && plan.circle_id)
    )
      fail(400, "Plan category or circle does not match operator service.");
  }
  const query = updating
    ? `UPDATE ${config.table} SET ${keys.map((key, index) => `${key} = $${index + 1}`).join(", ")} WHERE id = $${keys.length + 1} RETURNING *`
    : `INSERT INTO ${config.table} (${keys.join(", ")}) VALUES (${keys.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING *`;
  const result = await pool.query(
    query,
    updating ? [...values, id(req.params.id)] : values,
  );
  if (!result.rowCount) fail(404, "Record not found.");
  return result.rows[0];
};
const listResource = async (resource, req) => {
  const { limit, offset, page } = pagination(req);
  const result = await pool.query(
    `SELECT * FROM ${resources[resource].table} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return {
    data: result.rows,
    page,
    limit,
  };
};
const removeResource = async (resource, req) => {
  const config = resources[resource];
  const softDelete = Object.hasOwn(config.fields, "is_active");
  const result = await pool.query(
    softDelete
      ? `UPDATE ${config.table} SET is_active = false WHERE id = $1 RETURNING id`
      : `DELETE FROM ${config.table} WHERE id = $1 RETURNING id`,
    [id(req.params.id)],
  );
  if (!result.rowCount) fail(404, "Record not found.");
};

export const createOperator = async (req, res) => {
  try {
    const result = await writeResource("operator", req);
    return res.status(201).json({
      success: true,
      msg: "Operator created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateOperator = async (req, res) => {
  try {
    const result = await writeResource("operator", req, true);
    return res.status(200).json({
      success: true,
      msg: "Operator updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getOperators = async (req, res) => {
  try {
    const result = await listResource("operator", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deleteOperator = async (req, res) => {
  try {
    await removeResource("operator", req);
    return res.status(200).json({
      success: true,
      msg: "Operator removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createCircle = async (req, res) => {
  try {
    const result = await writeResource("circle", req);
    return res.status(201).json({
      success: true,
      msg: "Circle created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateCircle = async (req, res) => {
  try {
    const result = await writeResource("circle", req, true);
    return res.status(200).json({
      success: true,
      msg: "Circle updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getCircles = async (req, res) => {
  try {
    const result = await listResource("circle", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deleteCircle = async (req, res) => {
  try {
    await removeResource("circle", req);
    return res.status(200).json({
      success: true,
      msg: "Circle removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createPlan = async (req, res) => {
  try {
    const result = await writeResource("plan", req);
    return res.status(201).json({
      success: true,
      msg: "Plan created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updatePlan = async (req, res) => {
  try {
    const result = await writeResource("plan", req, true);
    return res.status(200).json({
      success: true,
      msg: "Plan updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getPlans = async (req, res) => {
  try {
    const result = await listResource("plan", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deletePlan = async (req, res) => {
  try {
    await removeResource("plan", req);
    return res.status(200).json({
      success: true,
      msg: "Plan removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createFaq = async (req, res) => {
  try {
    const result = await writeResource("faq", req);
    return res.status(201).json({
      success: true,
      msg: "Faq created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateFaq = async (req, res) => {
  try {
    const result = await writeResource("faq", req, true);
    return res.status(200).json({
      success: true,
      msg: "Faq updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getFaqs = async (req, res) => {
  try {
    const result = await listResource("faq", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deleteFaq = async (req, res) => {
  try {
    await removeResource("faq", req);
    return res.status(200).json({
      success: true,
      msg: "Faq removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createPrivacyPolicy = async (req, res) => {
  try {
    const result = await writeResource("privacyPolicy", req);
    return res.status(201).json({
      success: true,
      msg: "PrivacyPolicy created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updatePrivacyPolicy = async (req, res) => {
  try {
    const result = await writeResource("privacyPolicy", req, true);
    return res.status(200).json({
      success: true,
      msg: "PrivacyPolicy updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getPrivacyPolicies = async (req, res) => {
  try {
    const result = await listResource("privacyPolicy", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deletePrivacyPolicy = async (req, res) => {
  try {
    await removeResource("privacyPolicy", req);
    return res.status(200).json({
      success: true,
      msg: "PrivacyPolicy removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createCompany = async (req, res) => {
  try {
    const result = await writeResource("company", req);
    return res.status(201).json({
      success: true,
      msg: "Company created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateCompany = async (req, res) => {
  try {
    const result = await writeResource("company", req, true);
    return res.status(200).json({
      success: true,
      msg: "Company updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getCompanies = async (req, res) => {
  try {
    const result = await listResource("company", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deleteCompany = async (req, res) => {
  try {
    await removeResource("company", req);
    return res.status(200).json({
      success: true,
      msg: "Company removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createTeamContact = async (req, res) => {
  try {
    const result = await writeResource("teamContact", req);
    return res.status(201).json({
      success: true,
      msg: "TeamContact created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateTeamContact = async (req, res) => {
  try {
    const result = await writeResource("teamContact", req, true);
    return res.status(200).json({
      success: true,
      msg: "TeamContact updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getTeamContacts = async (req, res) => {
  try {
    const result = await listResource("teamContact", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deleteTeamContact = async (req, res) => {
  try {
    await removeResource("teamContact", req);
    return res.status(200).json({
      success: true,
      msg: "TeamContact removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const createDeveloper = async (req, res) => {
  try {
    const result = await writeResource("developer", req);
    return res.status(201).json({
      success: true,
      msg: "Developer created successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const updateDeveloper = async (req, res) => {
  try {
    const result = await writeResource("developer", req, true);
    return res.status(200).json({
      success: true,
      msg: "Developer updated successfully.",
      data: result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const getDevelopers = async (req, res) => {
  try {
    const result = await listResource("developer", req);
    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const deleteDeveloper = async (req, res) => {
  try {
    await removeResource("developer", req);
    return res.status(200).json({
      success: true,
      msg: "Developer removed successfully.",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export { setCommission, getCommissions } from "../commissionController.js";
