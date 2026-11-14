import { pool } from "../../config/db.js";
import { fail, id, money, sendError } from "../controllerHelpers.js";
import { mrobotics, mroboticsConfig, mroboticsEnabled } from "./mroboticsClient.js";
import { settlePayment } from "./paymentController.js";

export async function resolveRechargeCatalog(body) {
  if (!mroboticsEnabled()) return;
  mroboticsConfig();
  if (!["prepaid", "dth"].includes(body.service)) fail(503, "MRobotics supports mobile and DTH recharge here; gift-code fulfillment is not configured.");
  if (!body.operator_id) body.operator_id = (await pool.query("SELECT id FROM service_operators WHERE code=$1 AND service=$2 AND is_active", [body.operator, body.service])).rows[0]?.id;
  if (body.service === "prepaid" && !body.circle_id) body.circle_id = (await pool.query("SELECT id FROM telecom_circles WHERE (name=$1 OR code=$1) AND is_active", [body.circle])).rows[0]?.id;
}
export function rechargePayload(payment, operator, plan) {
  const settings = mroboticsConfig();
  const company = settings.companies[operator.code];
  if (!company) fail(503, "MRobotics company ID is not configured for this operator.");
  if (!payment.amount.endsWith(".00")) fail(400, "MRobotics recharge requires a whole-rupee amount.");
  if (payment.service === "prepaid" && (plan.code?.startsWith("demo-") || typeof plan.mrobotics_is_stv !== "boolean")) fail(503, "This plan is not configured for live MRobotics recharge.");
  return { mobile_no: payment.recipient, amount: String(Number(payment.amount)), company_id: String(company),
    is_stv: payment.service === "dth" ? "false" : String(plan.mrobotics_is_stv),
    check_min_balance: "true", ...(settings.lapuId ? { lapu_id: settings.lapuId } : {}), ...(settings.groupId ? { group_id: settings.groupId } : {}) };
}
const localDate = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
export function validateRechargeResponse(data, payment, submission) {
  const status = typeof data.status === "string" ? data.status.toLowerCase() : "unknown";
  if (!["success", "failure", "pending"].includes(status)) fail(502, "Provider status is unrecognized. Funds remain reserved pending reconciliation.");
  if (String(data.mobile_no) !== payment.recipient || money(data.amount) !== payment.amount) fail(502, "Provider recharge details do not match this transaction.");
  if (data.order_id !== undefined && String(data.order_id) !== String(submission.order_id)) fail(502, "Provider order reference does not match.");
  if (data.id === undefined || data.id === null || !/^[a-zA-Z0-9_-]{1,200}$/.test(String(data.id))) fail(502, "Provider recharge reference is missing or invalid.");
  if (submission.provider_id && String(data.id) !== submission.provider_id) fail(502, "Provider recharge reference changed unexpectedly.");
  return { status, providerId: String(data.id), operatorReference: String(data.tnx_id || "").slice(0,200),
    response: { status, id: String(data.id), mobile_no: payment.recipient, amount: payment.amount, tnx_id: String(data.tnx_id || "").slice(0,200) } };
}
const processResponse = async (client, payment, submission, data) => {
  const result = validateRechargeResponse(data, payment, submission);
  await client.query(`UPDATE recharge_submissions SET provider_id=$2,operator_reference=$3,provider_status=$4,response_payload=$5,last_checked_at=NOW(),last_error=NULL,updated_at=NOW() WHERE transaction_id=$1`,
    [payment.id,result.providerId,result.operatorReference,result.status,JSON.stringify(result.response)]);
  if (result.status === "pending") return payment;
  const settled = await settlePayment({ transactionId: payment.id, amount: payment.amount, status: result.status === "success" ? "Successful" : "Failed",
    reference: result.providerId, provider: "mrobotics", reason: result.status === "success" ? "MRobotics confirmed recharge success." : "MRobotics confirmed recharge failure; reserved amount refunded." });
  return (await client.query("UPDATE transactions SET operator_reference=$2 WHERE id=$1 RETURNING *", [settled.id,result.operatorReference || null])).rows[0];
};
// The durable attempted_at marker is committed BEFORE network I/O. Even a server crash cannot replay a recharge.
export async function processRecharge(payment, { submit = false } = {}) {
  if (payment.status !== "Pending" || payment.provider !== "mrobotics") return payment;
  if (!mroboticsEnabled()) return { ...payment, provider_message: "MRobotics is disabled. This recharge requires provider reconciliation." };
  mroboticsConfig();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,1))", [payment.id]);
    payment = (await client.query("SELECT * FROM transactions WHERE id=$1", [payment.id])).rows[0];
    if (payment.status !== "Pending") return payment;
    let submission = (await client.query("SELECT * FROM recharge_submissions WHERE transaction_id=$1", [payment.id])).rows[0];
    if (!submission) fail(409, "Recharge submission record is missing.");
    // A previously received definitive response can be settled after a crash without querying an old date.
    if (["success","failure"].includes(submission.provider_status) && submission.response_payload) return await processResponse(client,payment,submission,submission.response_payload);
    let result;
    if (!submission.attempted_at && submit) {
      submission = (await client.query("UPDATE recharge_submissions SET attempted_at=NOW(),provider_status='submitting',updated_at=NOW() WHERE transaction_id=$1 RETURNING *", [payment.id])).rows[0];
      result = await mrobotics.submit({ ...submission.request_payload, order_id: submission.order_id });
    } else {
      if (!submission.attempted_at) return { ...payment, provider_message: "Not submitted yet. Retry the original request with the same idempotency key." };
      if (localDate(submission.attempted_at) !== localDate(Date.now())) return { ...payment, provider_message: "MRobotics status search covers today's recharges only. Contact support for reconciliation; do not repeat the recharge." };
      // One upstream status request per transaction per ten seconds, across app sessions.
      if (submission.last_checked_at && Date.now()-new Date(submission.last_checked_at).getTime() < 10000) return submission.last_error ? { ...payment, provider_message: "Recharge verification is pending. Check status before making another recharge." } : payment;
      await client.query("UPDATE recharge_submissions SET last_checked_at=NOW() WHERE transaction_id=$1", [payment.id]);
      result = await mrobotics.status(submission.order_id);
    }
    return await processResponse(client,payment,submission,result);
  } catch (error) {
    // Unknown responses and timeouts never cause automatic refunds or resubmissions.
    await client.query("UPDATE recharge_submissions SET last_error=$2,updated_at=NOW() WHERE transaction_id=$1", [payment.id,"Provider result could not be verified; manual/status reconciliation required."]);
    return { ...payment, provider_message: error.status ? error.message : "Recharge verification is pending. Check status before making another recharge." };
  } finally {
    try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,1))", [payment.id]); } finally { client.release(); }
  }
}
export const checkRecharge = async (req,res) => {
  try {
    const result = await pool.query("SELECT * FROM transactions WHERE id=$1 AND retailer_id=$2 AND service IN ('prepaid','dth')", [id(req.params.id), req.auth.id]);
    if (!result.rowCount) fail(404, "Recharge not found.");
    const payment = result.rows[0];
    if (payment.provider !== "mrobotics") fail(400, "This recharge does not use MRobotics.");
    return res.json({ success:true, data: await processRecharge(payment) });
  } catch(error) { return sendError(res,error); }
};

export async function reconcilePendingRecharges({ shouldStop = () => false } = {}) {
  if (!mroboticsEnabled()) return 0;
  mroboticsConfig();
  const pending = await pool.query(`SELECT t.* FROM transactions t JOIN recharge_submissions s ON s.transaction_id=t.id
    WHERE t.provider='mrobotics' AND t.status='Pending' AND s.attempted_at IS NOT NULL
      AND ((s.attempted_at AT TIME ZONE 'Asia/Kolkata')::date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date OR s.provider_status IN ('success','failure'))
      AND (s.last_checked_at IS NULL OR s.last_checked_at<NOW()-INTERVAL '30 seconds')
    ORDER BY s.last_checked_at NULLS FIRST,s.created_at LIMIT 50`);
  let processed = 0;
  for (const payment of pending.rows) {
    if (shouldStop()) break;
    await processRecharge(payment);
    processed++;
  }
  return processed;
}
export function startRechargeReconciler() {
  if (!mroboticsEnabled()) return async () => {};
  let flight;
  let stopping = false;
  const timer = setInterval(() => {
    if (flight) return;
    flight = reconcilePendingRecharges({ shouldStop: () => stopping }).catch(() => {
      console.error('MRobotics reconciliation could not complete; pending funds remain reserved.');
    }).finally(() => { flight = undefined; });
  }, 30000);
  timer.unref();
  return async () => { stopping = true; clearInterval(timer); await flight; };
}
