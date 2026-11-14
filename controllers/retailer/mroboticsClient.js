import { fail } from "../controllerHelpers.js";
export const mroboticsEnabled = () => process.env.RECHARGE_PROVIDER === "mrobotics";
export const mroboticsConfig = () => {
  const token = process.env.MROBOTICS_API_TOKEN;
  if (!token) fail(503, "MRobotics API token is not configured.");
  let companies;
  try { companies = JSON.parse(process.env.MROBOTICS_COMPANY_IDS || "{}"); } catch { fail(503, "Invalid MRobotics operator configuration."); }
  if (!companies || typeof companies !== "object" || Array.isArray(companies)) fail(503, "Invalid MRobotics operator configuration.");
  for (const value of Object.values(companies)) if (!Number.isInteger(value) || value < 1 || value > 1000) fail(503, "Invalid MRobotics company ID.");
  const lapuId = process.env.MROBOTICS_LAPU_ID || "";
  const groupId = process.env.MROBOTICS_GROUP_ID || "";
  if ([lapuId, groupId].some(value => value && !/^\d{1,15}$/.test(value))) fail(503, "Invalid MRobotics LAPU/group ID.");
  return { token, companies, lapuId, groupId };
};
export function createMroboticsClient({ transport = fetch, config = mroboticsConfig } = {}) {
  const request = async (path, fields) => {
    const settings = config();
    let response;
    try {
      response = await transport(`https://mrobotics.in/api/${path}`, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...fields, api_token: settings.token }).toString(), signal: AbortSignal.timeout(15000) });
    } catch { fail(503, "Recharge response is uncertain. Check this transaction's status; do not submit another recharge."); }
    if (!response.ok) fail(502, "Recharge provider response is uncertain. Check transaction status.");
    let data;
    try { data = await response.json(); } catch { fail(502, "Recharge provider returned an unreadable response. Check transaction status."); }
    if (!data || Array.isArray(data) || typeof data !== "object") fail(502, "Recharge provider returned an unsupported response.");
    return data;
  };
  // Deliberately no retries: MRobotics accepts duplicate order IDs.
  return { submit: payload => request("recharge", payload), status: orderId => request("order_id_status", { order_id: String(orderId) }) };
}
export const mrobotics = createMroboticsClient();
