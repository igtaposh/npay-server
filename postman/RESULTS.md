# Postman verification results

Verified on 14 November 2026 using the native Postman desktop Collection Runner in the existing `npay` workspace. Test traffic used only the disposable `npay_test_postman` database and local fixture services. The existing application's `npay` database was not used for test mutations.

**Final outcome: 154/154 saved requests passed; 332 assertions; 95/95 role API routes covered plus `/health`; no uncovered routes.**

| Existing collection | Requests | Assertions | Final outcome |
| --- | ---: | ---: | --- |
| admin | 70 | 142 | Passed |
| distributor | 14 | 32 | Passed |
| retailers | 70 | 158 | Passed |

The final status is the latest verified outcome for each saved request, including corrected reruns. Earlier native run history retains resolved setup failures and incomplete runner starts. `verification-results.json` records every request's expected status, passing run ID and Postman request ID, plus historical run summaries. `route-coverage.json` maps all 95 role API routes to their verification steps.

## Fixed

- Restored the missing admin route protector before protected admin endpoints. It supplies `req.auth` and `req.account`, prevents unauthenticated access, and fixes the password-change/profile failure. The existing live local server was separately checked and now returns a structured 401 for unauthenticated admin profile requests.
- Added backend regression assertions for unauthenticated admin profile/password requests. All 17 backend integration tests pass against a separate fresh disposable database.
- Corrected Postman query parameter fields for plan selection, commission/history filtering and fake OTP retrieval.
- Replaced the fake OTP adapter's raw bearer literal with `Bearer {{OTP_TEST_KEY}}` because Postman's secret handling rewrote the literal.
- Recreated the missing saved M-PIN reset request and reran it successfully. Refreshed stale collection data and completed remaining requests individually when the native grouped runner stalled.

## Structure preserved

The collections remain `admin`, `distributor`, and `retailers`, with the original `auth` folders and both original requests unchanged. New auth checks are under `auth/verification`. Catalog/content/accounts, wallet/recharge/history and security/support requests are grouped by feature. Original environment values were not overwritten; tests use `npay-api-verification`.

## Behavior verified

Role authentication and authorization; onboarding and activation; distributor ownership; every catalog/content CRUD route; default and retailer commission rates; profile updates; token rotation; single top-up credit; recharge idempotency; pending fund reservation; commission snapshots; one-time refunds; terminal outcome conflicts; exact INR 609.97 closing balance; history filters; receipt ownership; encrypted gift-code access; OTP delivery through the local fake adapter; email/phone verification; password/M-PIN changes and resets; and logout/session revocation.

Provider lookup routes return the expected 503 because provider integration remains deferred. Successful OTP tests used a local fake adapter; no external SMS/email, payment gateway or recharge provider was contacted. The fake adapter's OTP/cooldown endpoints are test support only and are not part of the production API.

The temporary test services were shut down after verification. Use `README.md` and the fixture server to reproduce the suite against a fresh test database. The collection exports contain only the added tests and fixture values, not personal request bodies or live credentials.
