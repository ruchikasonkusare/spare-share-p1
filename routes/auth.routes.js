const express = require("express");

const {
  sendRegistrationOtp,
  completeRegistration,
  loginWithPassword,
  requestLoginOtp,
  loginWithOtp,
  forgotPasswordSendOTP,
  resetPassword,
  refreshSession,
  logout,
  getCurrentUser,
  updateNotificationPreferences,
  listSessions,
  revokeSession,
  logoutOtherSessions
} = require("../controllers/auth.controller");

const { createRateLimiter } = require("../middlewares/rateLimit.middleware");

const authenticator = require("../middlewares/authenticator.middleware");
const router = express.Router();

// Brute-force protection. Credential endpoints are limited per IP and per
// target email, so one address cannot be hammered from many IPs.
const emailOf = (req) => String((req.body && req.body.email) || "").trim().toLowerCase().slice(0, 254);
const AUTH_WINDOW_MS = Number(process.env.AUTH_RATE_WINDOW_MS) || 15 * 60 * 1000;
const ipLimiter = createRateLimiter({ windowMs: AUTH_WINDOW_MS, max: Number(process.env.AUTH_RATE_MAX_PER_IP) || 60 });
const emailLimiter = createRateLimiter({ windowMs: AUTH_WINDOW_MS, max: Number(process.env.AUTH_RATE_MAX_PER_EMAIL) || 10, keyGenerator: (req) => `${req.baseUrl}${req.path}:${emailOf(req)}` });
const refreshLimiter = createRateLimiter({ windowMs: 60 * 1000, max: Number(process.env.REFRESH_RATE_MAX_PER_MINUTE) || 30 });
router.use(["/register", "/login", "/forgot-password"], ipLimiter, emailLimiter);

// Registration
router.post("/register/send-otp", sendRegistrationOtp);
router.post("/register/complete", completeRegistration);

// Password Login
router.post("/login", loginWithPassword);

// OTP Login
router.post("/login/send-otp", requestLoginOtp);
router.post("/login/otp", loginWithOtp);

// Forgot Password
router.post("/forgot-password/send-otp", forgotPasswordSendOTP);
router.post("/forgot-password/reset", resetPassword);

// Refresh Session
router.post("/refresh", refreshLimiter, refreshSession);

// Logout
router.post("/logout", authenticator(), logout);

// Account and session management
router.get("/me", authenticator(), getCurrentUser);
router.patch("/me/notifications", authenticator(), updateNotificationPreferences);
router.get("/sessions", authenticator(), listSessions);
router.delete("/sessions/:sessionId", authenticator(), revokeSession);
router.post("/logout-others", authenticator(), logoutOtherSessions);

module.exports = router;
