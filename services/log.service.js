const mongoose = require("mongoose");

const ServerLog = require("../models/serverLog.model");
const { createError } = require("../utils/errors");
const { isObjectId } = require("../utils/validate");

const STREAMS = ["app", "build", "tunnel", "agent"];
const LEVELS = ["info", "warn", "error"];
const MAX_BATCH = 500;

// Strip control characters (including ANSI escapes) that would corrupt a
// log view. Tabs are kept.
const cleanMessage = (value) =>
  String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, 4000);

const appendLogs = async ({ device, serverId, entries }) => {
  if (!Array.isArray(entries) || entries.length === 0) return 0;

  if (entries.length > MAX_BATCH) {
    throw createError(`At most ${MAX_BATCH} log lines per request.`, 400, "LOG_BATCH_TOO_LARGE");
  }

  const now = Date.now();
  const documents = [];

  for (const entry of entries) {
    if (!entry || typeof entry.message !== "string") continue;

    const message = cleanMessage(entry.message);
    if (!message) continue;

    const parsedTs = Date.parse(entry.ts);
    // Device clocks drift. Reject timestamps that are clearly wrong.
    const ts = Number.isFinite(parsedTs) && Math.abs(parsedTs - now) < 24 * 60 * 60 * 1000
      ? new Date(parsedTs)
      : new Date(now);

    documents.push({
      serverId,
      deviceId: device._id,
      deploymentId: typeof entry.deploymentId === "string" ? entry.deploymentId.slice(0, 64) : null,
      stream: STREAMS.includes(entry.stream) ? entry.stream : "app",
      level: LEVELS.includes(entry.level) ? entry.level : "info",
      message,
      ts,
    });
  }

  if (documents.length === 0) return 0;

  await ServerLog.insertMany(documents, { ordered: false });
  return documents.length;
};

// Cursor pagination on _id. `after` tails forward, `before` pages back.
const listLogs = async ({ serverId, stream, deploymentId, after, before, limit = 200 }) => {
  const filter = { serverId };

  if (stream !== undefined) {
    if (!STREAMS.includes(stream)) {
      throw createError(`stream must be one of: ${STREAMS.join(", ")}.`, 400, "INVALID_LOG_STREAM");
    }
    filter.stream = stream;
  }

  if (deploymentId) filter.deploymentId = String(deploymentId).slice(0, 64);

  for (const [name, cursor] of [["after", after], ["before", before]]) {
    if (cursor !== undefined && !isObjectId(cursor)) {
      throw createError(`${name} is not a valid log cursor.`, 400, "INVALID_LOG_CURSOR");
    }
  }

  if (after) filter._id = { $gt: new mongoose.Types.ObjectId(after) };
  if (before) filter._id = { ...(filter._id || {}), $lt: new mongoose.Types.ObjectId(before) };

  // Tailing reads oldest-first from the cursor. Otherwise return the most
  // recent lines, presented oldest-first.
  const ascending = Boolean(after);

  const rows = await ServerLog.find(filter)
    .sort({ _id: ascending ? 1 : -1 })
    .limit(limit)
    .select("stream level message ts deploymentId deviceId")
    .lean();

  if (!ascending) rows.reverse();

  return {
    logs: rows.map((row) => ({
      id: row._id,
      stream: row.stream,
      level: row.level,
      message: row.message,
      ts: row.ts,
      deploymentId: row.deploymentId,
      deviceId: row.deviceId,
    })),
    nextCursor: rows.length > 0 ? rows[rows.length - 1]._id : after || null,
    previousCursor: rows.length > 0 ? rows[0]._id : null,
  };
};

module.exports = { STREAMS, appendLogs, listLogs };
