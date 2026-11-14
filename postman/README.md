# nPay Postman verification

The saved Postman workspace keeps the original three collections: `admin`, `distributor`, and `retailers`. Their existing `auth` folders and original requests remain. New authentication checks are under `auth/verification`; other checks are grouped by accounts, catalog, content, wallet, recharge, history, security and support.

The suite contains 154 sequential requests. It covers all 95 registered role API routes plus `/health`. Expected 400/401/404/409/503 responses are asserted as successful negative tests. Provider lookups intentionally return 503 because recharge-provider integration was deferred.

## Files

- `admin.postman_collection.json`, `distributor.postman_collection.json`, `retailers.postman_collection.json`: portable exports of the added requests and assertions; original personal request bodies are excluded.
- `npay-api-verification.postman_environment.json`: initial fixture values and the same `BASE_URL_ADMIN`, `BASE_URL_DISTRIBUTOR`, `BASE_URL_RETAILER` convention as the existing environment. Contains test credentials only; no live database credentials or session tokens.
- `run-order.json`: exact cross-collection request order. Requests run sequentially; several later requests require IDs/tokens captured by earlier requests.
- `route-coverage.json`: route-to-step mapping with no uncovered routes.
- `verification-results.json` and `RESULTS.md`: final verified outcomes and the Postman run IDs.
- `start-test-server.mjs`: disposable database fixture server and local fake OTP adapter.

## Reproduce

Create an empty PostgreSQL 15+ database with a name starting `npay_test_`. From the server project root:

```bash
POSTMAN_TEST_DB_NAME=npay_test_postman \
POSTMAN_TEST_DB_HOST=127.0.0.1 \
POSTMAN_TEST_DB_PORT=5432 \
POSTMAN_TEST_DB_USER=postgres \
POSTMAN_TEST_DB_PASSWORD='your-local-test-database-password' \
node postman/start-test-server.mjs
```

The fixture server refuses a database outside the test name prefix and refuses to seed one that already contains admins. It sets its own database connection variables before importing application configuration. It listens only on loopback: API port 38081 and fake OTP port 38082. It creates the initial test admin; the remaining accounts, catalogs and transactions are created through the API requests.

Select `npay-api-verification` in Postman. For a fresh run, restore environment values from the initial export and use a fresh fixture database. Keep the original `New Environment` for your normal work. The test suite changes fixture passwords/M-PINs and revokes tokens, so its final environment values differ from the initial values.

Execute the requests in `run-order.json` order, using Send individually or ordered selections in Collection Runner. The order crosses the three role collections: retailer interest submission → admin onboarding/catalog setup → distributor onboarding → retailer purchase requests → admin settlement → retailer security flows → cleanup/logout. Running each entire role collection independently does not satisfy those dependencies. Preserve the listed order when selecting requests in the runner.

The native Postman run history contains the execution results from this verification. The exports can be imported elsewhere; importing them may create additional collections. They do not include or overwrite the original personal requests.

## Testing conventions

Requests use raw JSON, kebab-case names and the existing base URL variables. Post-response scripts assert HTTP status and the `{ success, msg, data }` envelope, then save IDs and tokens into environment variables. Later requests use those variables instead of hardcoded database IDs. Bearer tokens are explicit variables for each role.

Postman's V3 saved-request representation requires query parameters in its parameter list as well as the displayed URL. Saved filters and OTP lookups were corrected accordingly. The fake OTP requests use `Bearer {{OTP_TEST_KEY}}`; a raw bearer literal was automatically rewritten by Postman's secret handling, which initially broke fixture authentication.

The `test-support` requests read OTPs from the local fake delivery service and advance only the fixture database's resend timestamps. They are test harness endpoints, not production APIs. No real SMS/email, recharge-provider or payment-gateway calls occur. API test results therefore verify the application's contracts and database behavior; they do not verify external provider delivery.

## Verified behavior

Authentication/role protection, admin/distributor/retailer onboarding, account activation, distributor ownership, all catalog/content CRUD, effective commissions, profile updates, wallet top-up verification, idempotency, pending recharge debits, terminal settlement, commission credits, single refunds, transaction filtering, receipt ownership, encrypted gift-code recovery, OTP verification, email/phone changes, password/M-PIN changes and resets, refresh rotation, logout and revoked-token rejection.

The main financial fixture ends with INR 609.97 after a 1,000.00 top-up, one successful 299.00 prepaid recharge, an 8.97 commission, a 100.00 Google Play purchase, and full refunds for the failed prepaid and DTH requests.
