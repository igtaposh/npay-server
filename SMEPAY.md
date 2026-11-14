# SMEPay wallet checkout

The retailer wallet top-up flow supports SMEPay Inline DQR. Recharge fulfillment remains separate. Existing controller/routes/migrations folders are retained. No additional runtime dependencies are required.

## Configure after staging credentials are available

Set in the backend `.env` (never Expo public variables):

```dotenv
PAYMENT_GATEWAY=smepay
SMEPAY_ENVIRONMENT=test
SMEPAY_CLIENT_ID=your-test-client-id
SMEPAY_CLIENT_SECRET=your-test-client-secret
SMEPAY_CALLBACK_URL=https://your-public-api/api/retailer/payments/smepay/webhook
SMEPAY_VALIDATE_PATH=the-confirmed-inline-dqr-validation-path
```

Restart the server; startup runs `009_smepay_schema.sql` idempotently. Test credentials use staging.smepay.in; live credentials use extranet.smepay.in. Production rejects test mode. Live requires business approval, a whitelisted outbound server IP and SMEPay fee wallet coverage. Public HTTPS callback must route to the backend; ADB tunnels only connect your phone and cannot receive gateway callbacks.

PAYMENT_GATEWAY overrides mock payment behavior even when DEMO_MODE=true; demo OTP/recharge behavior remains controlled by DEMO_MODE. Without PAYMENT_GATEWAY=smepay existing behavior is retained. Never test simulated payments on a production database. No credentials were installed or live transactions attempted as part of implementation.

## API contract and verification prerequisite

The supplied V2 Postman examples and published package disagree on some fields. Both `slug` and `order_slug` are accepted from order creation. Status uses POST /api/external/order/status with external_reference_id (our transaction UUID). Requests authenticate using /api/external/auth; cached bearer tokens expire early and only a 401 is replayed once.

Before activating, confirm the Inline DQR validation endpoint with SMEPay. SMEPAY_VALIDATE_PATH is deliberately required rather than guessing that the wizard validation endpoint accepts the external token. The validation request contains client_id, amount (numeric rupees), slug and the external bearer token. Success requires status=true, valid=true and payment_status=SUCCESS (or TEST_SUCCESS exclusively in test mode). If your account's contract differs, update the adapter and test fixtures to that confirmed contract. Authentication and order creation alone cannot credit the wallet.

Webhook signature headers/algorithm are not established by the supplied V2 documentation. Accordingly the callback never trusts any status, amount, slug or provider ID from its request. It uses only ref_id/external_reference_id to locate a persisted checkout, then fetches provider status and validates the saved slug and amount server-to-server. If SMEPay supplies a signature contract, add that check as an additional verification layer. The endpoint is rate limited.

## Routes

All checkout routes except the webhook require retailer authentication and enforce ownership.

- POST /api/retailer/wallet/topups — amount string + Idempotency-Key. Returns transaction with checkout (payment_link, QR PNG data URI, intents, expiry, environment).
- GET /api/retailer/wallet/topups/:id/checkout — resume the persisted checkout, without creating another order.
- POST /api/retailer/wallet/topups/:id/status — {}. Reconcile provider status/validation and settle once when verified.
- POST /api/retailer/payments/smepay/webhook — ref_id or external_reference_id; returns only an acknowledgement.

Database advisory locking serializes creation across retries. The local UUID is the unique SMEPay merchant reference. Ambiguous create timeouts are recovered through status lookup; if the provider does not return the slug/order ID, the payment remains pending for reconciliation rather than creating a second order. Ambiguous initiate timeouts also switch to status checking rather than replaying initiation. Existing pending payments can be resumed from transaction details. Test and live checkouts cannot be mixed.

FAILED/EXPIRED status does not finalize the local ledger: a late bank success can still be checked. The client stops automatic polling after link expiry, but manual status checks and webhook processing remain available. Closing checkout does not cancel payment. There is no scheduled reconciliation worker yet; pending payments are checked by callbacks and authenticated app requests. Refunds and payouts are outside this wallet-collection implementation and require separate provider operations.

## Validation

`npm test` runs API/unit tests. Set RUN_API_INTEGRATION=1 and a dedicated DB_NAME=npay_test_* database to exercise database/ledger integration. Tests use injected provider responses and do not contact SMEPay. Before live activation, test your real staging response shapes, credentials, webhook delivery, the confirmed validation endpoint, UPI app handoff, cancellation, expiry and late success.
