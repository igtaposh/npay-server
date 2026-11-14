import express from "express";
import adminRoutes from "./routes/admin/adminRoutes.js";
import distributorRoutes from "./routes/distributor/distributorRoutes.js";
import retailerRoutes from "./routes/retailer/retailerRoute.js";

export const app = express();
app.disable("x-powered-by");
app.use((req,res,next) => {
  const origin=req.get("Origin");
  const allowed=(process.env.CORS_ORIGINS || "http://localhost:8081,http://localhost:8082,http://127.0.0.1:8081").split(",").map(value=>value.trim());
  if (origin && allowed.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.vary("Origin");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
    res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(origin && !allowed.includes(origin) ? 403 : 204);
  next();
});
app.use(
  express.json({
    limit: "64kb",
  }),
);
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "no-store");
  if (req.body === undefined) req.body = {};
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({
      success: false,
      msg: "Request body must be a JSON object.",
    });
  }
  next();
});
app.get("/health", (req, res) =>
  res.status(200).json({
    success: true,
    msg: "Server is running.",
  }),
);
app.use("/api/admin", adminRoutes);
app.use("/api/distributor", distributorRoutes);
app.use("/api/retailer", retailerRoutes);
app.use((req, res) =>
  res.status(404).json({
    success: false,
    msg: "API not found.",
  }),
);
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status =
    error.type === "entity.too.large"
      ? 413
      : error instanceof SyntaxError && error.status === 400
        ? 400
        : 500;
  return res.status(status).json({
    success: false,
    msg:
      status === 400
        ? "Invalid JSON body."
        : status === 413
          ? "Request body is too large."
          : "Internal server error",
  });
});
