import express from "express";
import adminRoutes from "./routes/admin/adminRoutes.js";
import distributorRoutes from "./routes/distributor/distributorRoutes.js";
import retailerRoutes from "./routes/retailer/retailerRoute.js";

export const app = express();

import cors from "cors";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const allowedOrigins = [
  process.env.ADMIN_PANEL_URL,
  process.env.DISTRIBUTOR_PANEL_URL,
];

const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  credentials: true,
};

app.use(cors(corsOptions));

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
