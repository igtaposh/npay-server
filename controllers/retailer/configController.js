import { mroboticsEnabled } from "./mroboticsClient.js";
import { smepayEnabled } from "./smepayClient.js";

export const getAppConfig = (req, res) =>
  res.json({
    success: true,
    data: {
      // Compatibility with existing app versions. No flag can enable simulated behavior.
      demo: false,
      mock_recharge: false,
      mock_payment: false,
      mock_otp: false,
      recharge_provider: mroboticsEnabled() ? "mrobotics" : "manual",
      payment_gateway: smepayEnabled() ? "smepay" : "manual",
      otp_mode: "fixed",
      services: { prepaid: true, dth: false, "google-play": false },
    },
  });
