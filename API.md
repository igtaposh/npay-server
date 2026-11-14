# nPay API

The existing controller, middleware and route folders are retained. Named async controller exports use `pool.query`, positional SQL parameters, `try/catch` and `{ success, msg, data }` responses. The existing filename `adminControler.js` is retained too. Repeated validation, transaction and authentication code lives in `controllers/controllerHelpers.js`.

## Start

Requires Node.js 22.16+ and PostgreSQL 15+. Existing dependencies are sufficient; `bcrypt` replaces the uninstalled `bcryptjs` import, and Node's built-in `.env` loader replaces the uninstalled `dotenv` import.

1. Copy `.env.example` to `.env` and fill database settings, JWT_SECRET (at least 32 bytes) and SALT_ROUNDS (10–15, default 12). Generate secrets with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`.
2. Set INITIAL_ADMIN_NAME, INITIAL_ADMIN_PHONE, INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD; run `npm run create-admin`. This command creates only the first admin and refuses once an admin exists. Remove initial credentials from the environment afterwards.
3. Run `npm start` (or `npm run dev`). Migrations complete before HTTP traffic is accepted. Repeated startups preserve data.

The admin creation API requires an authenticated admin; there is no public admin-registration endpoint. The API accepts plaintext `password` over HTTPS and hashes it internally. Do not send a precomputed `password_hash`. Admin creation now requires the schema's `name` field. Passwords require at least 8 characters and at most 72 UTF-8 bytes. M-PINs must be strings containing exactly four digits.

All protected requests use `Authorization: Bearer <access_token>`. Admin and distributor access tokens expire in one hour. Retailer access tokens expire in 15 minutes; refresh tokens rotate and expire after 30 days. Numeric money/rates from PostgreSQL are decimal strings; dates are timestamps. Password/OTP/refresh hashes and unmasked Aadhaar/PAN are never returned. Lists accept `?page=1&limit=20` (limit at most 100).

## Recharge providers are intentionally deferred

No recharge provider or payment gateway is called. DTH lookup and mobile operator detection return 503. Catalog selection is available. `POST /api/retailer/recharges` creates a **Pending request and reserves wallet funds**; it does not complete a telecom recharge. Admins can manually settle a request after verifying the outcome externally, or mark it Failed to release the reserved funds. Pending requests are not automatically timed out or refunded.

Top-up creation also returns Pending, with **no immediate balance credit**. Only the protected admin settlement endpoint credits a verified successful top-up. This is the manual workflow until a payment gateway is connected. Do not automatically mark requests Successful from the app. Real provider integrations, provider callbacks and reconciliation jobs are outside this change.

## Admin APIs — `/api/admin`

| Method | Path | Body / purpose |
| --- | --- | --- |
| POST | `/login` | `{ phone, password }` |
| GET | `/profile` | Current account |
| POST | `/logout` | Revoke all admin access tokens |
| POST | `/password` | `{ current_password, new_password }`; sign in again afterwards |
| GET | `/dashboard` | Retailer/distributor counts, wallet balance, pending count, successful recharge volume |
| POST / GET | `/admins` | Create `{ name, phone, email, password }` / list |
| PATCH | `/admins/:id/status` | `{ is_active }`; cannot deactivate yourself |
| POST / GET | `/distributors` | Create distributor / list |
| PATCH | `/distributors/:id/status` | `{ status: "pending" | "active" | "suspended" | "closed" }` |
| POST / GET | `/retailers` | Create retailer / list (`?distributor_id=` supported) |
| PATCH | `/retailers/:id/status` | Same status values; revokes retailer sessions |
| GET | `/interests` | Partner interest submissions |
| PATCH | `/interests/:id` | `{ status: "new" | "contacted" | "rejected", notes?, distributor_id? }` |
| PUT | `/commissions` | `{ operator_id, rate, is_active?, retailer_id? }`; retailer_id sets an override |
| GET | `/commissions` | Default rates, or `?retailer_id=` for retailer overrides |
| GET | `/transactions` | Optional `?retailer_id=&status=` |
| POST | `/transactions/:id/settle` | Manual settlement; details below |
| GET | `/transactions/:id/events` | Settlement audit records; no plaintext gift codes |

Distributor creation body:

```json
{
  "name": "Distributor name",
  "business_name": "Example Distribution",
  "phone": "9876543210",
  "email": "distributor@example.com",
  "business_address": "Shop address",
  "pan": "ABCDE1234F",
  "adhar": "123456789012",
  "gst": null,
  "password": "A-long-unique-password",
  "distributor_slug": "example-distribution",
  "distributor_image_link": "https://example.com/image.png"
}
```

New partners start Pending. Activate the distributor before creating its retailers. Retailer creation uses the same identity/business/password fields, plus `distributor_id` (admin only), `retailer_slug`, optional four-digit `mpin`, and optional `interest_id`. Distributor image/slug fields are not used for retailers. It creates the retailer and a zero-balance wallet atomically. If interest_id is supplied, its phone and assignment must match; the interest is linked and approved in that same transaction. Activate the retailer separately. Without an initial M-PIN, the retailer must set one using their password before requesting a recharge.

### Content/catalog CRUD

For every path below, GET lists, POST creates, PATCH `/:id` updates provided fields, DELETE `/:id` disables the record when it has `is_active`; company/developer records are deleted. Unknown fields are rejected. UUID primary keys are assigned by the database. API list calls include inactive records for administration.

| Path | Required creation fields | Optional writable fields |
| --- | --- | --- |
| `/operators` | code, name, service (`prepaid`, `dth`, `google-play`) | logo_url, account_label, account_digits, min_amount, max_amount, is_active |
| `/circles` | code, name | is_active |
| `/plans` | operator_id, code, name, category, amount | circle_id, data_allowance, validity, channels, description, tag, is_active |
| `/faqs` | question, answer | sort_order, is_active |
| `/privacy-policies` | title, text | sort_order, is_active |
| `/companies` | head_office, email, phone | sub_office (JSON), whatsapp, work_hours |
| `/team-contacts` | role, role_full, name, phone | distributor_id, whatsapp, image_url, sort_order, is_active |
| `/developers` | name, company, role, app_version | github, instagram |

Prepaid plan categories: popular, unlimited, data, talktime, isd, topup. DTH plans use dth; gift plans use gift-code. A NULL circle means available in all circles. Only prepaid plans can have a circle. Team roles: founder, distributor, drm, arm. A NULL distributor_id means a global fallback contact. Retailer help prefers the assigned distributor's contact for each role. Default commission rates can be overridden per retailer; setting is_active=false on an override restores the default.

### Manual settlement

```json
{
  "status": "Successful",
  "amount": "1000.00",
  "currency": "INR",
  "reference": "unique-external-bank-or-operator-reference",
  "reason": "Receipt and outcome independently verified"
}
```

Allowed terminal statuses: Successful or Failed. Amount/currency must match the request. Successful Google Play settlement additionally requires `gift_code`, obtained externally, and a configured GIFT_CODE_KEY. Codes are encrypted with AES-256-GCM and bound to their transaction. Never lose the encryption key; changing it requires migrating existing ciphertext.

Settlement locks the transaction. Repeating the same terminal status/reference returns the original result; conflicting terminal outcomes return 409. Top-up success credits once. Recharge success credits its snapshotted commission, if positive. Recharge failure refunds the full debit once. The admin ID, reason, reference and amount are recorded in provider_events. Requests cannot directly edit wallet balances or mark themselves Successful.

## Distributor APIs — `/api/distributor`

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/login` | `{ phone, password }` |
| GET | `/profile` | Current account |
| POST | `/logout` | Revoke all distributor access tokens |
| POST | `/password` | `{ current_password, new_password }` |
| POST / GET | `/retailers` | Create/list only the distributor's retailers |
| PATCH | `/retailers/:id/status` | Change status only for an owned retailer |
| GET | `/retailers/:id/transactions` | Owned retailer's history |
| GET | `/interests` | Only assigned partner submissions |
| PATCH | `/interests/:id` | Follow-up status/notes for assigned submissions; cannot reassign |

A distributor cannot choose another distributor_id or access admin APIs. Passing distributor_id during retailer creation does not override the authenticated distributor.

## Retailer APIs — `/api/retailer`

Public:

| Method | Path | Body |
| --- | --- | --- |
| POST | `/login` | `{ phone, password, device_name? }` |
| POST | `/interests` | `{ name, shop_address, phone }` |
| POST | `/refresh` | `{ refresh_token, device_name? }` |
| POST | `/password-reset/request` | `{ phone }` -> challenge_id |
| POST | `/password-reset/verify` | `{ challenge_id, otp }` -> verification_token |
| POST | `/password-reset/complete` | `{ verification_token, new_password }` |
| GET | `/privacy-policy` | Active policy sections |
| GET | `/developer` | Latest developer record |

Authenticated:

| Method | Path | Body / query |
| --- | --- | --- |
| GET / PATCH | `/profile` | PATCH `{ current_password, name?, business_name? }`; email uses OTP flow |
| POST | `/logout` | Optional `{ all_devices: true }` |
| POST | `/security/otp/request` | `{ purpose, current_password, email? }` |
| POST | `/security/otp/verify` | `{ challenge_id, otp }` -> verification_token |
| POST | `/security/password` | `{ verification_token, new_password }` |
| POST | `/security/email` | `{ verification_token }`; uses the verified destination, not a replacement body field |
| POST | `/security/phone` | `{ verification_token }` |
| POST | `/security/mpin` | Initial setup: `{ current_password, new_mpin }`; change: `{ current_mpin, new_mpin }` |
| POST | `/security/mpin/reset` | `{ verification_token, new_mpin }` |
| GET | `/operators` | Optional `?service=prepaid|dth|google-play` |
| GET | `/circles` | Active circles |
| GET | `/plans` | Required `?operator_id=`, optional `circle_id`, `category`, `q`, `page`, `limit` |
| GET | `/commissions` | Effective operator rates |
| GET | `/help` | Scoped contacts, latest company details, active FAQs |
| GET | `/wallet` | Balance, currency and updated_at |
| GET | `/wallet/entries` | Own immutable ledger entries |
| POST | `/wallet/topups` | `{ amount }` and Idempotency-Key header; returns Pending |
| POST | `/recharges` | Recharge body below and Idempotency-Key header; returns Pending |
| GET | `/transactions` | Optional category (`recharge`, `wallet`, `google-play`) and status filters |
| GET | `/transactions/:id` | Own transaction only |
| GET | `/transactions/:id/gift-code` | Own successful issued code only |
| POST | `/dth/lookup` | 503 until provider integration |
| POST | `/operators/lookup` | 503 until provider integration |

Recharge example:

```json
{
  "service": "prepaid",
  "operator_id": "operator-uuid-from-catalog",
  "circle_id": "circle-uuid-from-catalog",
  "plan_id": "plan-uuid-from-catalog",
  "recipient": "9876543210",
  "amount": "299.00",
  "mpin": "1234"
}
```

For DTH use service=dth and the correct subscriber number; circle_id is omitted and plan_id optional. For Google Play use service=google-play with its operator_id and amount; recipient/circle are omitted. Prepaid requires a matching active plan/operator/circle and exact plan amount. DTH and gift codes require integer rupee amounts. Google Play allows ₹100–₹10,000; DTH up to ₹25,000; top-ups ₹1–₹100,000. Operator limits also apply.

Supply `Idempotency-Key: <unique-string>` for each new purchase/top-up; retries must reuse the original key and identical purchase fields. `idempotency_key` in the body is also accepted. Concurrent retries charge once; reusing a key for a different request returns 409. Insufficient balance rolls back the transaction and debit. Never send retailer_id as identity; it always comes from the verified access token.

### OTP delivery

OTP endpoints return 503 until OTP_API_URL, OTP_API_KEY and OTP_SECRET are configured. An adapter at `<OTP_API_URL>/send` receives POST JSON `{ channel: "sms" | "email", destination, otp, purpose }` with a Bearer API key. It must deliver the message and return a successful JSON response. The API never sends OTPs back to the mobile app or logs them.

Purposes: password_change, mpin_reset, email_change (requires proposed email), phone_verify. Password reset is requested separately through the public route. Challenges expire in five minutes, allow five attempts and have a one-minute resend cooldown. Verification returns a purpose-bound proof token; completion consumes it atomically. A proof cannot be reused for another account, purpose or destination. Password and M-PIN changes revoke sessions and require signing in again.

Login and M-PIN verification lock after five failures for 15 minutes. Authentication/security routes also use per-process IP limits. Configure shared rate limiting at the trusted reverse proxy when running multiple instances. The app does not trust arbitrary X-Forwarded-For headers by default. Deploy behind HTTPS. Native Expo clients do not require CORS; configure an explicit allowed web origin at your proxy if using the web build.

## Tests

`npm test` runs validation tests without connecting to a database. HTTP integration tests are opt-in and refuse any database name outside `npay_test_*`. Use an **empty disposable database**, then run:

```bash
RUN_API_INTEGRATION=1 DB_NAME=npay_test_api DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres npm test
```

Tests apply/rerun migrations and create fixture accounts/catalog entries. They start a local fake OTP delivery adapter; no real OTPs or payments are sent. Checks include authentication/role boundaries, distributor ownership, content validation, concurrent idempotency and settlement, commissions/refunds, overdrafts, encrypted gift codes, OTP replay/purpose/destination checks, password reset and session revocation.

## Connected mobile app development mode

The `npay-recharge` app now uses these APIs. See its `INTEGRATION.md` for device URL configuration and native rebuild instructions. `GET /api/retailer/config` returns the mock-provider flags. Set `DEMO_MODE=true` only for local development; `NODE_ENV=production` disables every mock regardless of that flag.

Development mode simulates OTP delivery (123456 returned only with development challenges), checkout confirmation, DTH lookup, recharge success and non-redeemable `DEMO-` gift codes. It retains real account authentication, challenge validation, ledger posting, idempotency and ownership checks. Prototype prepaid plan codes are resolved against server-owned fixtures and stored with a `demo-` catalog prefix. Normal mode keeps existing UUID-based catalogs and pending/manual settlement behavior. Mock provider events are recorded as `demo-provider`, separately from `manual-admin` settlements.

Run `npm run seed-demo` to create the dedicated demo retailer with zero balance (9999900002 / DemoLogin123!, M-PIN 1234). It does not reset an existing demo account or change existing partner credentials. Add balance through the app to exercise dummy checkout. Real users can continue signing in with their existing active retailer accounts. CORS origins are configured through the comma-separated `CORS_ORIGINS` variable.


SMEPay Inline DQR wallet checkout is documented in [SMEPAY.md](./SMEPAY.md). New ownership-protected resume/status endpoints and the callback route are included there. Import `postman/smepay.postman_collection.json` for the separate staging checkout sequence; the existing manual/demo verification collections retain their behavior.


MRobotics mobile/DTH fulfillment is documented in [MROBOTICS.md](./MROBOTICS.md), including configuration, server-managed plan flags, durable single-attempt submission and POST `/api/retailer/recharges/:id/status`. The separate Postman collection is `postman/mrobotics.postman_collection.json`.
