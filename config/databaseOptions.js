// Shared by the application, migration command, and isolated configuration tests.
export function databaseOptions(env = process.env, { direct = false } = {}) {
  const integer = (key, fallback) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${key} must be a positive integer.`);
    return value;
  };
  const connectionString = direct
    ? env.DATABASE_URL_UNPOOLED || env.DATABASE_URL
    : env.DATABASE_URL;
  let connection = {
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
  };
  if (connectionString) {
    let url;
    try {
      url = new URL(connectionString);
    } catch {
      throw new Error("Invalid database connection URL.");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw new Error("Database URL must use postgres:// or postgresql://.");
    if (direct && url.hostname.includes("-pooler."))
      throw new Error(
        "DATABASE_URL_UNPOOLED must use a direct endpoint for migrations and session locks.",
      );
    if (url.hostname.endsWith(".neon.tech")) {
      // Validate both the certificate chain and hostname, regardless of pg defaults.
      for (const key of [
        "ssl",
        "sslmode",
        "sslcert",
        "sslkey",
        "sslrootcert",
        "uselibpqcompat",
      ])
        url.searchParams.delete(key);
      connection = {
        connectionString: url.toString(),
        ssl: { rejectUnauthorized: true },
        enableChannelBinding: true,
      };
    } else connection = { connectionString };
  } else if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is required in production.");
  }
  return {
    ...connection,
    max: integer(
      direct ? "DB_DIRECT_POOL_MAX" : "DB_POOL_MAX",
      direct ? 3 : 10,
    ),
    connectionTimeoutMillis: integer("DB_CONNECTION_TIMEOUT_MS", 15000),
    idleTimeoutMillis: integer("DB_IDLE_TIMEOUT_MS", 30000),
    maxLifetimeSeconds: integer("DB_MAX_LIFETIME_SECONDS", 300),
    application_name: direct ? "npay-server-direct" : "npay-server",
  };
}

export function shouldMigrateOnStartup(env = process.env) {
  if (
    env.RUN_DB_MIGRATIONS !== undefined &&
    !["true", "false"].includes(env.RUN_DB_MIGRATIONS)
  )
    throw new Error("RUN_DB_MIGRATIONS must be true or false.");
  return (
    env.RUN_DB_MIGRATIONS === "true" ||
    (env.RUN_DB_MIGRATIONS === undefined &&
      env.NODE_ENV !== "production" &&
      !env.DATABASE_URL)
  );
}
