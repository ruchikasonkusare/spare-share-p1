require("dotenv").config();

const mongoose = require("mongoose");

const connectDB = require("./config/db.config");
const { validateEnvironment } = require("./config/env.config");
const { createApp } = require("./app");

const initializeCounters = require("./services/counter.service");
const { startMonitoringScheduler } = require("./services/scheduler.service");
const serverEndpointController = require("./controllers/serverEndpoint.controller");

const PORT = process.env.PORT || 5000;

let stopMonitoringScheduler = () => {};
let isShuttingDown = false;

const shutdown = (server, signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received. Shutting down SpareShare...`);

  stopMonitoringScheduler();

  server.close(async () => {
    console.log("HTTP server closed.");
    await mongoose.connection.close().catch(() => {});
    process.exit(0);
  });

  // Proxied keep-alive and WebSocket connections would otherwise hold the
  // process open.
  server.closeIdleConnections();

  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000).unref();
};

const startServer = async () => {
  try {
    validateEnvironment();

    await connectDB();
    await initializeCounters();

    const app = createApp();

    const server = app.listen(PORT, () => {
      console.log(`SpareShare API running on port ${PORT}`);
    });

    // WebSocket traffic to hosted applications.
    server.on("upgrade", serverEndpointController.proxyUpgrade);

    // Start monitoring only after MongoDB is ready.
    stopMonitoringScheduler = startMonitoringScheduler();

    process.on("SIGTERM", () => shutdown(server, "SIGTERM"));
    process.on("SIGINT", () => shutdown(server, "SIGINT"));
  } catch (error) {
    console.error("SpareShare startup failed:", error.message || error);
    process.exit(1);
  }
};

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

startServer();
