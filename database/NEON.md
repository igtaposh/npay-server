# Neon production connections

The existing pg driver is retained. DATABASE_URL takes precedence over legacy DB_* variables.
Use a pooled (-pooler) endpoint for requests and DATABASE_URL_UNPOOLED for migrations
and provider session advisory locks. Both URLs must refer to the same branch/database.
Neon connections verify TLS certificates and hostnames and enable SCRAM channel binding
when offered by the server. Never disable certificate verification.

Set both URLs as secrets in your deployment platform. The local .env is ignored by Git.
Use NODE_ENV=production and RUN_DB_MIGRATIONS=false. Set existing JWT_SECRET,
OTP_SECRET, provider settings and CORS_ORIGINS for your deployment as well.

Before first deployment, test on an isolated Neon branch and run:

```sh
node database/migrate.js
npm run create-admin
npm start
```

The migration command explicitly modifies the database through the direct endpoint.
It retains the existing SQL runner (all numbered files, one transaction per file);
it does not add migration history or concurrency protection. Run one migration job
at a time, and review the SQL before applying it to a populated database.
Server startup and admin creation only probe connectivity by default in production
or when DATABASE_URL is set. RUN_DB_MIGRATIONS=true explicitly restores startup migrations.
Legacy local development without DATABASE_URL still migrates on startup by default.

Pools default to 10 request connections and 3 direct connections per process.
Account for all replicas when sizing pools. Connections time out after 15 seconds,
idle connections close after 30 seconds, and connections rotate after 300 seconds.
No database queries or provider operations are automatically retried: retries can
otherwise duplicate financial actions. The existing /health remains a liveness check.

Existing production limitations outside this connection change include the fixed
123456 OTP in config/otp.js; replace it with verified delivery before public use.

References:
- https://neon.com/docs/connect/connection-pooling
- https://node-postgres.com/features/ssl
- https://node-postgres.com/apis/pool
