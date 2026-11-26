const { getMonitoringConfig, runMonitoringCycle, markOfflineDevices } = require("./monitoring.service");
const { failStaleDeployments } = require("./deployment.service");
const { scheduleDueBackups, failStaleBackups } = require("./backup.service");
const { failStaleFailovers } = require("./failover.service");

let housekeepingRunning = false;

// Periodic maintenance. Every job claims its work atomically, so running
// the scheduler on more than one API instance is safe.
const runHousekeeping = async () => {
  if (housekeepingRunning) return;
  housekeepingRunning = true;

  const jobs = [
    ["offline devices", markOfflineDevices],
    ["stale deployments", failStaleDeployments],
    ["stale backups", failStaleBackups],
    ["stale failovers", failStaleFailovers],
    ["scheduled backups", scheduleDueBackups],
  ];

  try {
    for (const [name, job] of jobs) {
      try {
        await job();
      } catch (error) {
        console.error(`[SpareShare Scheduler] ${name} failed:`, error.message);
      }
    }
  } finally {
    housekeepingRunning = false;
  }
};

const runCycle = async () => {
  await runHousekeeping();
  await runMonitoringCycle();
};

const startMonitoringScheduler = () => {
  if (process.env.MONITORING_SCHEDULER_ENABLED !== "true") {
    console.log("[SpareShare Monitor] Scheduler is disabled.");
    return () => {};
  }

  const config = getMonitoringConfig();
  console.log(`[SpareShare Monitor] Scheduler started. Interval: ${config.intervalMs}ms`);

  const tick = () =>
    runCycle().catch((error) => {
      console.error("[SpareShare Monitor] Cycle error:", error);
    });

  tick();
  const timer = setInterval(tick, config.intervalMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    console.log("[SpareShare Monitor] Scheduler stopped.");
  };
};

module.exports = { startMonitoringScheduler, runCycle, runHousekeeping };
