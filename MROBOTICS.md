# MRobotics recharge integration

Implemented from the authenticated MRobotics API documentation at https://mrobotics.in/user/apidocs (read through the user's browser on 14 November 2026). The normal rendered page hides several sections; the page source includes mobile/DTH, statewise and multirecharge examples. No account token was copied into code or configuration, and no real recharge was submitted.

MRobotics automates your own configured LAPU accounts. It is not a supplier of prepaid funds or a plan catalog. Configure working LAPUs and approved operator routes in its dashboard before enabling this integration.

## Configuration

Set these in the BACKEND .env only, then restart:

```dotenv
DEMO_MODE=false
RECHARGE_PROVIDER=mrobotics
MROBOTICS_API_TOKEN=your-dashboard-api-token
MROBOTICS_COMPANY_IDS={"jio":5,"airtel":2,"bsnl":4,"tata-play":7}
MROBOTICS_LAPU_ID=
MROBOTICS_GROUP_ID=
```

Choose company IDs for your actual account's LAPU routes. The examples in `.env.example` are not automatically enabled. Documented options include Vodafone 1, Airtel 2, Idea 3, BSNL 4, Jio 5, DishTV 6, TataSky 7, VideconApp 11, SunDirect 12, JioPosLite 17, Airtel Mitra DTH 24, DishTV EasyPay 27 and D2H Pay 28. Select Vi's Vodafone/Idea route and traditional/app routes intentionally; don't assume they share routing.

MROBOTICS_LAPU_ID and MROBOTICS_GROUP_ID are optional documented restrictions. Without them MRobotics selects its configured route. Existing PAYMENT_GATEWAY=smepay remains independent: SMEPay collects wallet funds, MRobotics fulfills mobile/DTH recharges. RECHARGE_PROVIDER takes precedence over demo recharge behavior even if DEMO_MODE=true; simulated OTP/wallet behavior is still configured separately. Never fund a real provider flow with simulated wallet credit in production. NODE_ENV=production disables the existing demo mechanism.

## API contract

The adapter uses POST application/x-www-form-urlencoded to https://mrobotics.in/api/recharge:

- api_token: server secret
- mobile_no: retailer's verified recharge request recipient (subscriber ID for DTH)
- amount: whole rupees
- company_id: configured operator mapping
- order_id: durable numeric merchant reference from recharge_submissions
- is_stv: server-owned plan flag; false for DTH subscriber-ID recharge
- check_min_balance=true, plus optional configured lapu_id/group_id

The response example documents status success/failure/pending, id, mobile_no, amount, tnx_id and other reporting fields. The implementation validates recipient, amount, status and stable provider ID before settlement and ignores extra fields such as provider balance. Optional echoed order_id must match. It persists only selected fields, never tokens. Outbound requests do not follow redirects and do not automatically retry.

Status checks POST api_token and order_id to /api/order_id_status. The docs label these as Post Data and suggest using query parameters if possible; the adapter uses a form body to keep the token out of URLs/logs. The docs do not show a separate status-response example. The current adapter accepts the documented recharge-record shape; unexpected/array/HTML/mismatched responses remain pending rather than causing a refund or success. Confirm the actual status response shape with your account during controlled acceptance testing.

No documented callback, plan lookup or DTH subscriber lookup was found; none is invented. Alternate statewise/multirecharge routes and Google Play fulfillment are not enabled by this adapter.

## Duplicate and uncertain results

MRobotics explicitly says it accepts repeated order IDs. recharge_submissions therefore persists attempted_at BEFORE the upstream request; database advisory locks serialize overlapping callers. A retry with the same local Idempotency-Key never resends an attempted recharge. Keep/recover the database and order-ID sequence across deployments; use this account from one coordinated order-ID allocation system.

A verified failure refunds the reserved debit exactly once through the existing immutable ledger. Success posts the snapshotted commission once. HTTP errors, timeout, malformed JSON, unknown status, absent references and mismatched amount/recipient NEVER trigger automatic refunds or another recharge. Crashing after the durable marker but before network delivery also requires status/manual reconciliation rather than blind resubmission.

The provider documents status searches for the current date only. The implementation compares India calendar dates and leaves older uncertain requests pending for manual provider/admin reconciliation. It can replay a definitive, locally persisted provider response after a crash, even on a later date. The backend also checks up to 50 eligible pending requests every 30 seconds while MRobotics is enabled, without resubmitting. It skips older-date uncertainty and uses the same per-transaction locks as app requests. Shutdown stops new reconciliation work and waits for the current check before closing the database. Monitor/support-review older unresolved requests.

Do not manually refund an uncertain request just because a network call timed out: first verify whether the LAPU recharge occurred.

## Catalog and app

Startup applies migration 010_mrobotics_schema.sql idempotently. Prepaid plans must be entered through existing admin plan APIs and explicitly set mrobotics_is_stv=true or false. For example PATCH the existing plan with {"mrobotics_is_stv":true}. Mock plans with codes beginning demo- cannot be submitted to MRobotics. Read is_stv semantics in your dashboard: Jio Prime+plans and BSNL STV require true; BSNL top-up requires false. Roaming plans with overlapping prices are explicitly warned about by MRobotics; do not list an unsupported plan as available.

The app fetches configured prepaid plans and IDs from the backend when mock_recharge=false. It uses a direct subscriber-ID/amount form for DTH instead of fabricated customer balances/plans. Selected amounts remain server validated. Configure catalog amounts, validity and benefits against your actual operator offering; MRobotics does not supply a plan-fetch API in these docs.

POST /api/retailer/recharges retains its existing contract plus real plan_id. POST /api/retailer/recharges/:id/status checks ownership and reconciles the saved provider order without submitting. The status screen and history receipt action use this route for pending MRobotics transactions. Status calls are throttled to one provider check per transaction per ten seconds. Disabling the provider cannot turn an old pending MRobotics recharge into a demo success.

Import postman/mrobotics.postman_collection.json for the separately organized recharge requests. Existing baseline test collections remain unchanged.

## Verification completed and activation limits

Automated tests use isolated PostgreSQL and injected provider responses. They cover concurrent retries (one debit/one submission), success, exactly-once failure refund, timeout followed by background reconciliation success, DTH routing, mismatched payloads, ownership, missing credentials and older-date reconciliation. Client tests/lint/typechecks/export run separately. These are integration tests of our implementation, not evidence of a live LAPU recharge.

Before activation confirm your provider accepts the allocated numeric order ID, actual status response shape, company mappings, supported plans and is_stv flags. A controlled live test requires your API token, active/funded LAPU and your own test recipient. No public callback URL/domain is needed for this polling-based integration; localhost can make outbound provider requests.

Browser verification used an isolated app/API/database: sign-in, a server-catalog prepaid plan, M-PIN submission, pending-to-success receipt, and the direct DTH form. SQL confirmed one recharge submission and one debit for the UI transaction. No live provider calls occurred.
