import { fail } from "../controllerHelpers.js";
export const smepayEnabled = () => process.env.PAYMENT_GATEWAY === "smepay";
export const smepayConfig = () => {
  const environment = process.env.SMEPAY_ENVIRONMENT || "test";
  if (!["test", "live"].includes(environment)) fail(503, "Invalid SMEPay environment.");
  if (process.env.NODE_ENV === "production" && environment !== "live") fail(503, "Production requires SMEPay live mode.");
  const clientId = process.env.SMEPAY_CLIENT_ID;
  const clientSecret = process.env.SMEPAY_CLIENT_SECRET;
  const callback = process.env.SMEPAY_CALLBACK_URL;
  const validationPath = process.env.SMEPAY_VALIDATE_PATH;
  if (!clientId || !clientSecret || !callback || !validationPath) fail(503, "SMEPay credentials, callback URL and confirmed validation path must be configured.");
  let url;
  try { url = new URL(callback); } catch { fail(503, "Invalid SMEPay callback URL."); }
  if (url.protocol !== "https:" || url.username || url.password) fail(503, "SMEPay callback must use public HTTPS.");
  if (!/^\/api\/(?:wiz\/)?external\/[a-z/-]+$/.test(validationPath)) fail(503, "Invalid SMEPay validation path.");
  return { environment, clientId, clientSecret, callback, validationPath,
    baseUrl: environment === "live" ? "https://extranet.smepay.in" : "https://staging.smepay.in" };
};
// An injectable transport lets tests exercise the real client without contacting the gateway.
export function createSmepayClient({ config = smepayConfig, transport = fetch } = {}) {
  let cached; let authenticating;
  const post = async (settings, path, body, token) => {
    let response;
    try {
      response = await transport(`${settings.baseUrl}${path}`, { method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error" });
    } catch { fail(503, "Payment service could not be reached. Retry the same payment to check its status."); }
    let data;
    try { data = await response.json(); } catch { fail(502, "Payment service returned an invalid response."); }
    if (!response.ok || data.status === false) {
      const error = new Error("Payment service rejected the request. Check gateway configuration or retry this payment.");
      error.status = 502; error.gatewayStatus = response.status;
      error.gatewayCode = String(data.code || data.error || ""); throw error;
    }
    return data;
  };
  const getToken = async (settings) => {
    const key = `${settings.baseUrl}:${settings.clientId}:${settings.clientSecret}`;
    if (cached?.key === key && cached.expires > Date.now()) return cached.token;
    if (authenticating?.key === key) return authenticating.promise;
    const promise = (async () => {
      const data = await post(settings, "/api/external/auth", { client_id: settings.clientId, client_secret: settings.clientSecret });
      if (typeof data.access_token !== "string" || !data.access_token) fail(502, "Payment authentication failed.");
      if (data.environment && data.environment !== settings.environment) fail(502, "SMEPay environment mismatch.");
      cached = { key, token: data.access_token, expires: Date.now() + Math.max(1, Math.min(Number(data.expires_in) || 600, 600) - 60) * 1000 };
      return cached.token;
    })();
    const flight = { key, promise }; authenticating = flight;
    try { return await promise; } finally { if (authenticating === flight) authenticating = undefined; }
  };
  return { async request(path, body) {
    const settings = config(); const token = await getToken(settings);
    try { return await post(settings, path, { ...body, client_id: settings.clientId }, token); }
    catch (error) {
      // Only authentication rejection is safe to replay; never retry ambiguous create/initiate timeouts.
      if (error.gatewayStatus !== 401) throw error;
      if (cached?.token === token) cached = undefined;
      return post(settings, path, { ...body, client_id: settings.clientId }, await getToken(settings));
    }
  } };
}
export const smepay = createSmepayClient();
