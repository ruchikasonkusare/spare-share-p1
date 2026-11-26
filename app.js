const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const installationRoutes = require("./routes/installation.routes");
const serverRoutes = require("./routes/server.routes");
const githubRoutes = require("./routes/github.routes");
const serverEndpointRoutes = require("./routes/serverEndpoint.routes");
const deviceAgentRoutes = require("./routes/deviceAgent.routes");
const serverEnvironmentRoutes = require("./routes/serverEnvironment.routes");
const deviceRoutes = require("./routes/device.routes");
const notificationRoutes = require("./routes/notification.routes");

const serverEndpointController = require("./controllers/serverEndpoint.controller");
const { getDashboardSummary } = require("./controllers/serverOps.controller");

const authenticator = require("./middlewares/authenticator.middleware");
const errorMiddleware = require("./middlewares/error.middleware");
const { securityHeaders, notFound } = require("./middlewares/security.middleware");

const createApp = () => {
  const app = express();

  app.disable("x-powered-by");

  // Behind a platform load balancer the client address arrives in
  // X-Forwarded-For. Rate limiting depends on reading it correctly.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy !== undefined && trustProxy !== "") {
    app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === "true");
  } else if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  // PUBLIC PERMANENT ENDPOINT ROUTES
  // Keep these before body-parsing middleware so request bodies stream
  // straight through to the hosted application.
  app.use(serverEndpointController.proxyByHost);
  app.all("/s/:permanentId", serverEndpointController.proxyTraffic);
  app.all("/s/:permanentId/*path", serverEndpointController.proxyTraffic);

  // API MIDDLEWARE
  app.use(securityHeaders);

  const allowedOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  // The mobile app does not use CORS. Browser origins must be listed.
  app.use(
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      maxAge: 600,
    })
  );

  app.use(
    express.json({
      limit: "1mb",
      verify: (req, res, buffer) => {
        if (req.originalUrl.split("?")[0] === "/api/github/webhook") {
          req.rawBody = Buffer.from(buffer);
        }
      },
    })
  );

  app.use(express.urlencoded({ extended: true, limit: "100kb" }));

  // API ROUTES
  app.use("/api/auth", authRoutes);
  app.use("/api/setup", installationRoutes);
  app.use("/api/server", serverRoutes);
  app.use("/api/github", githubRoutes);
  app.use("/api/server-endpoint", serverEndpointRoutes);
  app.use("/api/device-agent", deviceAgentRoutes);
  app.use("/api/server-env", serverEnvironmentRoutes);
  app.use("/api/devices", deviceRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.get("/api/dashboard/summary", authenticator(), getDashboardSummary);

  // HEALTH CHECKS
  app.get("/", (req, res) => {
    return res.status(200).json({ success: true, message: "SpareShare API is running." });
  });

  app.get("/healthz", (req, res) => {
    const mongoose = require("mongoose");
    const databaseReady = mongoose.connection.readyState === 1;
    return res.status(databaseReady ? 200 : 503).json({
      success: databaseReady,
      database: databaseReady ? "connected" : "disconnected",
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use(notFound);
  app.use(errorMiddleware);

  return app;
};

module.exports = { createApp };
