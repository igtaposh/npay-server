# nPay database and controller guide

Requires PostgreSQL 15+ (`UNIQUE NULLS NOT DISTINCT`). Keep migrations in the existing `database/migrations/` directory, numbered in dependency order. `config/db.js` runs them in lexical order, one transaction per file. The scripts support reruns; this is not a version-tracking migration system. Test on a copy before upgrading a populated database. No live database has been migrated by this change.

## Migration map

| File | Responsibility |
| --- | --- |
| `001_admin_schema.sql` | Existing privacy sections, company details, FAQs, legacy commission table; statement terminators corrected |
| `002_distributor_schema.sql` | Existing distributor records; statement terminator corrected |
| `003_retailer_schema.sql` | Retailer identity, distributor ownership, profile, password/M-PIN hashes and lockouts |
| `004_account_schema.sql` | Admin accounts, distributor credentials, retailer interest submissions, OTP challenges and sessions |
| `005_catalog_schema.sql` | Operators, circles, prepaid/DTH/gift catalogs and commission rates |
| `006_wallet_transaction_schema.sql` | Wallets, recharge/top-up history, immutable wallet entries, issued gift codes and callback deduplication |
| `007_support_schema.sql` | Team contacts, developer details, content ordering, landline support and automatic update timestamps |
| `008_reference_data.sql` | The app's 10 operator identifiers and 23 circle names; preserves configured rows on reruns |

Original names such as `adhar` and `commision_slab_by_admin` are retained. Map them to `aadhaar` and commission fields in API responses. Legacy `question`/`answer` commission columns are retained as nullable compatibility fields. Use `operator_id`, `rate`, and `is_active` instead. Existing placeholder rows are preserved by a NOT VALID check; replace them before editing them. Rates are percentages (2.4 means 2.4%), not fractions.

## Screen-to-data mapping

| App behavior | Tables / fields |
| --- | --- |
| Partner interest on login | `retailer_interests`: name, shop_address, phone; distributor assignment and follow-up status |
| Sign-in and profile | `retailers`: phone, password_hash, name, business_name, email, pan, adhar |
| Password reset/change, email change, M-PIN reset | `retailer_verifications`, retailer credential fields and `retailer_sessions` |
| Prepaid operator/circle/plan selection | `service_operators`, `telecom_circles`, `recharge_plans` |
| DTH customer lookup | Fetch from the configured provider; preserve customer name and plan/due details in transaction `plan_snapshot` |
| Google Play purchase and later code retrieval | `transactions` with service `google-play`, then `google_play_codes` |
| Balance and refresh time | `retailer_wallets.balance`, `updated_at` |
| Add wallet money | `transactions` with service `wallet`; verified successful payment posts a `topup` entry |
| History and transaction details | `transactions`, scoped by authenticated retailer; latest first using `(created_at, id)` |
| Commission screen | Active retailer override, otherwise active `commision_slab_by_admin` row for the operator |
| Help | `team_contacts` scoped to retailer's distributor plus global contacts; `company_details`, `faq` |
| Privacy/developer | `privacy_policy`, `developer_details` |

`transactions.status` matches the app exactly: `Pending`, `Successful`, `Failed`. `category` is generated from service: prepaid/DTH -> `recharge`, Google Play -> `google-play`, top-up -> `wallet`. The prototype currently writes gift purchases as `recharge`; update that integration when adding controllers. `created_at` is a real timestamp; format “Today”/“Yesterday” in the client.

Plan IDs are UUIDs; use `recharge_plans.code` for the prototype's string IDs such as `pop-299`. Plans are scoped to an operator and optionally a circle (NULL means all circles). Keep an immutable purchase snapshot so later catalog edits do not rewrite receipts. Only identifiers are seeded: sample prices, fake customers, demo codes, demo balances, contact details and commission rates are deliberately not inserted as live business data. Configure actual catalogs, contacts and rates through your admin work.

## Controller rules

Create a retailer and its zero-balance wallet in one transaction. Retailers belong to a distributor; registration interest does not automatically create an approved account. Activate accounts after onboarding. Existing distributors have nullable password hashes and `pending` status; set credentials and activate before allowing login. Admin and distributor authentication uses their respective tables.

Hash passwords and M-PINs with bcrypt; never store or return the plaintext. Set a four-digit M-PIN on onboarding before allowing recharges. OTPs are six digits: store a keyed hash, a short expiry and bounded attempts. Bind each challenge to its retailer, purpose, channel and exact destination. Email-change verification must target the proposed new address. Verify the current password for profile/security changes as the screens require. Lock the challenge row while verifying/consuming, check expiry and attempts, and set `consumed_at` in the same transaction as the credential change. `verified_at` supports the UI's separate verification and reset steps; expiry still applies after verification. Increment attempt counters even on rejection. Invalidate outstanding challenges after use/resend. Revoke sessions on credential reset and logout; check account status and credential timestamps for JWT authorization.

Derive retailer identity from authentication, never the request body. Scope every receipt, wallet and gift-code lookup by that identity. Validate active operators, matching plan/operator/circle, provider-specific subscriber length, min/max amount and plan price on the server. For Google Play use integer amounts from 100 through 10,000; DTH uses integer amounts up to 25,000; top-ups range from 1 through 100,000. Read numeric values from `pg` as decimal strings and use decimal-safe arithmetic. Database NUMERIC columns round to two decimals: reject excess input precision before insertion.

### Recharge and settlement

1. Verify account status and M-PIN with bounded retries. Resolve the active commission rate on the server and snapshot it in `transactions.commission_rate` (default zero when no rate is configured).
2. Start a database transaction. Create a `Pending` transaction with a client-supplied idempotency key scoped to the retailer. If it exists, check the original request fields and return that transaction; do not charge again. Insert one `wallet_entries` row with `kind = 'recharge'` and the purchase amount, then commit. The trigger atomically debits the wallet and rejects overdrafts. This reserves funds while the provider is pending.
3. Call the provider using the transaction UUID as its idempotency reference. Do not hold database locks during the network call. A timeout remains `Pending` until reconciliation; it is not proof of failure.
4. Authenticate callbacks. Store `provider_events` using its unique provider/event ID, and lock the transaction row before settlement. Treat terminal statuses as final, ignore duplicates, and reject conflicting terminal callbacks. Reconciliation after a crash must reuse the original provider reference.
5. On success, update status/completed_at, persist operator/provider references and any encrypted gift code, and post a `commission` entry only if commission_amount is greater than zero. On confirmed failure, update status/completed_at and post a `refund` entry for the full original debit. Perform each settlement atomically. Mark the event processed in that same transaction.

The wallet trigger writes `balance_after` and updates wallet balance on INSERT. Do not update balance separately. Entries are immutable and unique per transaction/kind. Duplicate entry insertion raises SQLSTATE 23505 even with ON CONFLICT DO NOTHING; handle duplicates by checking the existing settlement under the transaction lock, not by blindly reinserting. A failed insert rolls back its balance change. Create wallets with zero balances; add funds through posted transactions. Restrict direct table updates to trusted backend code. The schema does not implement provider calls, callback authentication, terminal-state transition control, role authorization or distributed reconciliation: those are controller responsibilities.

The prototype only deducts on success; the server flow above debits while pending and refunds on confirmed failure. Display the server balance and status when integrating the app. Available balance is the wallet balance, including any pending debits.

### Wallet top-ups

Create a pending wallet transaction and payment-provider order. Credit only after verifying provider signature, order, amount, currency and payment status. In one database transaction, lock the record, mark it Successful and insert its `topup` entry. A request from the Add balance screen alone must not credit funds. Failed top-ups have no wallet entries. Keep provider names non-null whenever storing provider references so the unique provider/reference index deduplicates correctly.

### Gift codes

Persist provider-issued codes encrypted with a key outside the database; store a keyed fingerprint to prevent duplicate issuance. Return the decrypted code only for its successful transaction to the owning retailer. The schema enforces the Google Play service relationship; the controller must require successful issuance. Do not use the demo's deterministic code generator. Keep provider payloads free of secrets and plaintext gift codes.

## Validation and existing integration gaps

The migration set was exercised on temporary PostgreSQL 18, including reruns. Rollback-only fixtures checked top-up posting, duplicate credits including ON CONFLICT, recharge debits, commission rounding, cross-retailer wallet rejection, idempotency keys, immutable entries, overdrafts and refunds. No production credentials or database were used.

Controllers, middleware and routes are now implemented in the existing admin/distributor/retailer directories. See [API.md](../API.md) for setup, endpoint contracts, OTP delivery, manual settlement and integration tests. App state is still local; the mobile app must call these APIs to use persisted data. Recharge-provider integration is intentionally deferred: requests reserve funds and remain Pending until manual admin settlement. Mobile operator detection and DTH customer lookup return 503. Top-ups require manual admin payment verification before crediting. No provider callbacks or automatic reconciliation jobs run.

`config/db.js` sorts SQL files, releases clients and propagates errors. Startup awaits initialization before listening. The server uses the installed bcrypt dependency and Node's built-in .env loader. Migration 005 now creates the legacy commission table if absent, because the current 001 migration no longer defines it.
