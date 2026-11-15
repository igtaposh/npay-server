// Temporary fixed verification code requested for the current release.
// This does not prove phone/email ownership. Replace with real OTP delivery before public use.
export const FIXED_OTP = "123456";

export function otpSecret() {
  const secret = process.env.OTP_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    const error = new Error("OTP_SECRET must contain at least 32 bytes.");
    error.status = 503;
    throw error;
  }
  return secret;
}
