<div align="center">

# nPay Server

**The backend behind the nPay recharge and retailer wallet experience.**

Retailer operations · Distributor management · Wallet accounting · Recharge fulfillment

![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.16-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-4169E1?style=flat-square&logo=postgresql&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-F7DF1E?style=flat-square&logo=javascript&logoColor=black)

[Quick start](#quick-start) · [Configuration](#configuration) · [API](#api-at-a-glance) · [Testing](#testing) · [Documentation](#documentation)

</div>

---

## Overview

nPay Server is an Express REST API for a recharge platform with three account roles: **admin**, **distributor**, and **retailer**. It manages partner onboarding, service catalogs, retailer wallets, transaction history, commissions, and account security in PostgreSQL.

Payment collection and recharge fulfillment are configured independently. SMEPay handles wallet checkout; MRobotics handles prepaid and DTH recharge requests through configured LAPU accounts. Local development also supports simulated flows.

## What’s inside

| Area | Capabilities |
| --- | --- |
| **Administration** | Dashboard, account activation, partner onboarding, catalogs, commissions, content, and manual settlement |
| **Distribution** | Retailer onboarding, assigned partner interests, account status, and retailer transaction history |
| **Retailer experience** | Profile, operators, circles, plans, wallet, receipts, transaction history, and support content |
| **Account security** | JWT authentication, retailer refresh-token rotation, logout revocation, bcrypt passwords and M-PINs, and OTP verification |
| **Wallet accounting** | Immutable ledger entries, pending recharge debits, settlement, refunds, and commission credits |
| **Integrations** | Optional SMEPay Inline DQR checkout and MRobotics prepaid/DTH fulfillment with pending-status reconciliation |
| **Development tools** | Demo account seeding, Node.js tests, SQL migrations, and Postman collections |

## Quick start

### 1. Install dependencies

Use **Node.js 22.16+**, **npm**, and a running **PostgreSQL 15+** instance.

```bash
cd npay-server
npm ci
cp .env.example .env
```

### 2. Configure the database and secrets

Create an empty database using a PostgreSQL role with permission to create databases:

```bash
createdb -h 127.0.0.1 -U postgres npay
```

Update `.env` with your connection settings:

```dotenv
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=npay
DB_USER=postgres
DB_PASSWORD=your-local-database-password
```

Generate a secret with:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Run it separately for `JWT_SECRET`, `OTP_SECRET`, and `GIFT_CODE_KEY`, then paste each value into `.env`. `JWT_SECRET` must contain at least 32 bytes; `GIFT_CODE_KEY` must be exactly 64 hexadecimal characters. Keep `.env` private; `.env.example` is the configuration template committed to the repository.

### 3. Create the first admin

Set these values in `.env`:

```dotenv
INITIAL_ADMIN_NAME=Your Name
INITIAL_ADMIN_PHONE=9876543210
INITIAL_ADMIN_EMAIL=admin@example.com
INITIAL_ADMIN_PASSWORD=replace-with-a-unique-password
```

```bash
npm run create-admin
```

The command initializes the database and creates the first admin. It refuses to run when an admin already exists; create additional admins through the authenticated API. Remove the bootstrap credentials from `.env` afterwards.

### 4. Start the API

```bash
npm run dev
```

For normal execution without watch mode:

```bash
npm start
```

The server loads `.env` using Node’s built-in loader and completes SQL migrations before accepting requests. Check the default local endpoint:

```bash
curl http://localhost:3000/health
```

```json
{
  "success": true,
  "msg": "Server is running."
}
```

## Configuration

See [`.env.example`](.env.example) for the complete template.

| Variables | Purpose |
| --- | --- |
| `PORT` | HTTP port; defaults to `3000` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL connection |
| `JWT_SECRET` | Access-token signing secret; at least 32 bytes |
| `SALT_ROUNDS` | Bcrypt cost; defaults to `12`, supported range `10–15` |
| `OTP_SECRET` | Key used to hash OTP challenges |
| `OTP_API_URL`, `OTP_API_KEY` | OTP delivery adapter configuration |
| `GIFT_CODE_KEY` | 32-byte encryption key encoded as 64 hexadecimal characters |
| `CORS_ORIGINS` | Comma-separated allowed browser origins |
| `INITIAL_ADMIN_*` | One-time admin bootstrap details |
| `DEMO_MODE` | Enables simulated development flows when `true`; disabled in production |
| `PAYMENT_GATEWAY`, `SMEPAY_*` | Optional SMEPay wallet checkout configuration |
| `RECHARGE_PROVIDER`, `MROBOTICS_*` | Optional MRobotics recharge configuration |

### Choose the operating mode

| Mode | Configuration | Behavior |
| --- | --- | --- |
| **Manual** | Leave provider selectors blank; `DEMO_MODE=false` | Recharges reserve funds and remain pending until admin settlement. Top-ups require verified manual settlement before wallet credit. |
| **Demo** | `DEMO_MODE=true` in development | Simulated recharge, checkout, and OTP delivery for local app development |
| **SMEPay checkout** | `PAYMENT_GATEWAY=smepay` plus `SMEPAY_*` settings | Creates wallet checkout and verifies payment with SMEPay before crediting funds |
| **MRobotics recharge** | `RECHARGE_PROVIDER=mrobotics` plus `MROBOTICS_*` settings | Submits configured prepaid/DTH recharges and reconciles pending provider results |

Provider selectors take precedence over their corresponding simulated flows. Set `DEMO_MODE=false` when connecting real services. `NODE_ENV=production` disables demo behavior.

SMEPay requires a confirmed Inline DQR validation path for your account. MRobotics requires working LAPUs, explicit company routing, and configured plans. Read the [SMEPay guide](SMEPAY.md) and [MRobotics guide](MROBOTICS.md) before enabling either integration. Provider adapter tests use simulated responses and do not establish live provider acceptance.

### Local demo account

After setting `DEMO_MODE=true` in `.env`:

```bash
npm run seed-demo
npm run dev
```

| Field | Development value |
| --- | --- |
| Retailer phone | `9999900002` |
| Password | `DemoLogin123!` |
| M-PIN | `1234` |

The seed creates a demo distributor and active retailer with a zero-balance wallet. Add simulated balance through the app. Rerunning preserves an existing demo retailer’s credentials and balance. Use a development database for this account.

## API at a glance

The default local base URL is `http://localhost:3000`.

| Prefix | Responsibility |
| --- | --- |
| `/health` | Server liveness |
| `/api/admin` | Platform administration, catalogs, content, and settlement |
| `/api/distributor` | Assigned retailer and onboarding operations |
| `/api/retailer` | Authentication, profile, wallet, recharge, history, and support |

Protected routes expect:

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

Wallet top-up and recharge creation use an `Idempotency-Key` header to identify retried requests. Money and rate values returned from PostgreSQL are decimal strings. Transaction statuses are `Pending`, `Successful`, and `Failed`.

Example admin login:

```bash
curl -X POST http://localhost:3000/api/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"9876543210","password":"your-admin-password"}'
```

See [API.md](API.md) for endpoint contracts, request bodies, authentication, and settlement details. Its original manual-provider overview predates the optional adapters; use [SMEPAY.md](SMEPAY.md) and [MROBOTICS.md](MROBOTICS.md) for integration behavior.

## Wallet and settlement flow

1. A retailer creates a recharge with an idempotency key.
2. The server validates the request and M-PIN, snapshots commission, and reserves wallet funds with a ledger debit.
3. The configured provider processes the request, or it remains pending for manual settlement.
4. Confirmed success settles the transaction and credits any commission. Confirmed failure refunds the original debit.

Wallet top-ups credit funds only after verified successful payment settlement. Uncertain provider responses stay pending for reconciliation; a timeout alone does not prove failure.

## Project structure

```text
npay-server/
├── app.js                  # Express app, middleware, and route mounting
├── server.js               # Startup, migrations, reconciler, and shutdown
├── config/
│   └── db.js               # PostgreSQL pool and migration runner
├── controllers/
│   ├── admin/              # Administration and content
│   ├── distributor/        # Partner and retailer management
│   ├── retailer/           # Auth, wallet, recharge, and provider adapters
│   └── controllerHelpers.js
├── middlewares/            # Authentication and role protection
├── routes/                 # Admin, distributor, and retailer routes
├── database/
│   └── migrations/         # Ordered SQL schema and reference data
├── postman/                # Collections, environment, and verification guide
├── create-admin.js         # First-admin bootstrap
├── seed-demo.js            # Development account seed
├── api.test.js             # Validation and opt-in API integration tests
├── smepay.test.js           # SMEPay client tests
└── mrobotics.test.js        # MRobotics client tests
```

Migrations run in filename order, one transaction per file, and are rerun at startup. The runner does not track migration versions. Review changes and test on a copy before upgrading a populated database.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start with Node.js watch mode |
| `npm run create-admin` | Initialize the schema and bootstrap the first admin |
| `npm run seed-demo` | Create development demo accounts |
| `npm test` | Run validation and provider client tests; API integration is opt-in |

## Testing

Run the default suite:

```bash
npm test
```

To exercise API and database behavior, create a **dedicated disposable database** whose name starts with `npay_test_`. Supply its connection values explicitly:

```bash
createdb -h 127.0.0.1 -U postgres npay_test_local

RUN_API_INTEGRATION=1 \
DB_HOST=127.0.0.1 \
DB_PORT=5432 \
DB_NAME=npay_test_local \
DB_USER=postgres \
DB_PASSWORD='your-local-test-database-password' \
npm test
```

The integration suite creates fixture accounts and transactions, exercises migration reruns and financial settlement, and injects provider responses. It does not perform real payments or recharges. Use a fresh disposable database for a repeatable run.

For request-by-request verification, import the collections and environment from [`postman/`](postman/) and follow the execution order in the [Postman guide](postman/README.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [API reference](API.md) | Role endpoints, validation, authentication, OTPs, and manual settlement |
| [Database guide](database/README.md) | Schema design, ledger rules, and data relationships |
| [SMEPay integration](SMEPAY.md) | Checkout configuration, payment verification, and activation prerequisites |
| [MRobotics integration](MROBOTICS.md) | LAPU routing, recharge submission, reconciliation, and provider limitations |
| [Postman verification](postman/README.md) | Collections, fixture setup, and sequential request execution |

---

<div align="center">

**nPay** · Recharge operations, connected.

</div>
