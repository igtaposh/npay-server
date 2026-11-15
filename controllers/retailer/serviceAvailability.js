export function comingSoon(res, service) {
  return res.status(501).json({
    success: false,
    code: "COMING_SOON",
    msg:
      service === "dth"
        ? "DTH recharge is coming soon."
        : "Google Play recharge is coming soon.",
  });
}
