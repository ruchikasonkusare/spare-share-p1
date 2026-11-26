// End-to-end tests. Starts a real MongoDB replica set, the real API
// process and real device-agent processes, then drives them over HTTP.
//
//   node tests/run.js            run everything
//   KEEP_TMP=1 node tests/run.js keep the working directory for inspection
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const {
  sleep, getFreePort, results, section, check, assert, assertEqual, waitFor,
  startSmtpSink, createGitRemote, startProcess, isPidAlive, createClient,
} = require("./lib");

const BACKEND_DIR = path.join(__dirname, "..");
const AGENT_BUNDLE = path.join(BACKEND_DIR, "..", "agent", "dist", "spareshare-agent.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "spareshare-e2e-"));
const WEBHOOK_SECRET = "test-webhook-secret";
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);

// ------------------------------------------------------------
// Fixture applications
// ------------------------------------------------------------

const nodeApp = (version) => ({
  "package.json": JSON.stringify({
    name: "ss-node-app",
    version: "1.0.0",
    private: true,
    scripts: { start: "node server.js" },
    dependencies: { express: "^4.19.2" },
  }, null, 2),
  ".gitignore": "node_modules\n",
  "server.js": `
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const VERSION = ${JSON.stringify(version)};
const app = express();
app.use(express.text({ type: "*/*" }));

const dataFile = path.join(process.env.SPARESHARE_DATA_DIR || ".", "value.txt");

app.get("/", (req, res) => res.send("hello from node-app " + VERSION));
app.get("/env", (req, res) => res.json({
  PROCESS_ONLY: process.env.PROCESS_ONLY || null,
  BOTH_VAR: process.env.BOTH_VAR || null,
  FILE_ONLY: process.env.FILE_ONLY || null,
  dotenv: fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : null,
  port: process.env.PORT,
  pid: process.pid,
  agentToken: process.env.SPARESHARE_AGENT_TOKEN || null,
  nodeEnv: process.env.NODE_ENV || null,
}));
app.get("/data", (req, res) => res.send(fs.existsSync(dataFile) ? fs.readFileSync(dataFile, "utf8") : ""));
app.post("/data", (req, res) => { fs.writeFileSync(dataFile, String(req.body)); res.send("saved"); });
app.all("/echo", (req, res) => res.json({ method: req.method, query: req.query, body: req.body, forwardedHost: req.headers["x-forwarded-host"] || null }));
app.get("/go", (req, res) => res.redirect("/data"));
app.get("/boom", (req, res) => res.status(500).send("boom"));
app.get("/leak", (req, res) => { console.log("value is " + process.env.BOTH_VAR); res.send("logged"); });

const server = app.listen(process.env.PORT, () => console.log("node-app " + VERSION + " listening on " + process.env.PORT));

server.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
  socket.write(Buffer.from([0x81, 0x05, 0x77, 0x73, 0x2d, 0x6f, 0x6b]));
});
`,
});

const flaskApp = {
  "requirements.txt": "flask>=3.0,<4\n",
  "app.py": `
import os
from flask import Flask

app = Flask(__name__)

@app.route("/")
def index():
    return "hello from flask " + os.environ.get("PROCESS_ONLY", "none")
`,
};

const staticSite = {
  "index.html": "<!doctype html><title>static</title><h1>static-ok</h1>\n",
  "about.html": "<h1>about</h1>\n",
};

const main = async () => {
  console.log(`Working directory: ${TMP}`);

  // ----------------------------------------------------------
  // Infrastructure
  // ----------------------------------------------------------

  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const mongoUri = replSet.getUri("spareshare-test");
  const smtp = await startSmtpSink();
  const remote = await createGitRemote(path.join(TMP, "git"));
  const apiPort = await getFreePort();
  const base = `http://127.0.0.1:${apiPort}`;
  const api = createClient(`${base}/api`);
  const site = createClient(base);

  const backendEnv = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(apiPort),
    MONGO_URI: mongoUri,
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    ENV_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
    SPARESHARE_PUBLIC_BASE_URL: base,
    SPARESHARE_APPS_DOMAIN: "apps.test",
    ALLOW_PRIVATE_DESTINATIONS: "true",
    BCRYPT_ROUNDS: "4",
    ACCESS_TOKEN_EXPIRES_IN: "15m",
    MAIL_CONFIG: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.port),
    SMTP_USER: "sink",
    SMTP_PASSWORD: "sink",
    EMAIL_FROM: "SpareShare <no-reply@spareshare.invalid>",
    NOTIFICATION_EMAIL_ENABLED: "true",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_ID: "",
    GITHUB_PRIVATE_KEY: "",
    BACKUP_STORAGE_DRIVER: "local",
    BACKUP_LOCAL_DIR: path.join(TMP, "backup-storage"),
    AGENT_BUNDLE_PATH: AGENT_BUNDLE,
    AGENT_HEARTBEAT_INTERVAL_SECONDS: "2",
    AGENT_COMMAND_POLL_INTERVAL_SECONDS: "1",
    MONITORING_SCHEDULER_ENABLED: "true",
    MONITORING_INTERVAL_MS: "2000",
    MONITORING_TIMEOUT_MS: "2000",
    MONITORING_HEARTBEAT_STALE_MS: "8000",
    MONITORING_FAILURE_THRESHOLD: "2",
    MONITORING_RECOVERY_COOLDOWN_MS: "60000",
    SERVER_HEARTBEAT_MAX_AGE_MS: "15000",
    FAILOVER_GRACE_MS: "3000",
    AUTH_RATE_MAX_PER_EMAIL: "8",
    AUTH_RATE_MAX_PER_IP: "500",
  };

  for (const name of ["B2_REGION", "B2_ENDPOINT", "B2_ACCESS_KEY_ID", "B2_SECRET_ACCESS_KEY", "B2_BUCKET_NAME", "FCM_PROJECT_ID"]) {
    delete backendEnv[name];
  }

  let backend = null;
  const agents = {};

  const startBackend = () => {
    backend = startProcess("backend", process.execPath, ["server.js"], {
      env: backendEnv,
      cwd: BACKEND_DIR,
      logFile: path.join(TMP, "backend.log"),
    });
    return backend;
  };

  const agentHome = (name) => path.join(TMP, `agent-${name}`);

  const startAgent = (name, token, extraEnv = {}) => {
    agents[name] = startProcess(`agent-${name}`, process.execPath, [AGENT_BUNDLE, "run"], {
      env: {
        ...process.env,
        SPARESHARE_API_URL: `${base}/api`,
        SPARESHARE_AGENT_TOKEN: token,
        SPARESHARE_HOME: agentHome(name),
        SPARESHARE_TUNNEL_PROVIDER: "direct",
        SPARESHARE_TICK_MS: "1500",
        SPARESHARE_STARTUP_TIMEOUT_MS: "60000",
        ...extraEnv,
      },
      cwd: TMP,
      logFile: path.join(TMP, `agent-${name}.log`),
    });
    return agents[name];
  };

  const agentState = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(agentHome(name), "state.json"), "utf8"));
    } catch {
      return { servers: {} };
    }
  };

  const cleanup = async () => {
    for (const agent of Object.values(agents)) await agent.stop("SIGKILL");

    // Hosted applications are detached from their agent on purpose, so
    // they are stopped here by process group.
    for (const name of Object.keys(agents)) {
      for (const entry of Object.values(agentState(name).servers || {})) {
        for (const info of [entry.app, entry.tunnel]) {
          if (info && Number.isInteger(info.pid) && info.pid > 1) {
            try {
              process.kill(-info.pid, "SIGKILL");
            } catch {
              // already gone
            }
          }
        }
      }
    }

    if (backend) await backend.stop();
    await mongoose.disconnect().catch(() => {});
    await smtp.close();
    await remote.close();
    await replSet.stop();
    if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
  };

  process.on("SIGINT", () => cleanup().then(() => process.exit(130)));

  const ctx = {};
  const db = () => mongoose.connection.db;
  const oid = (value) => new mongoose.Types.ObjectId(String(value));
  const enabled = (name) => ONLY.length === 0 || ONLY.includes(name);

  // Reusable flows --------------------------------------------------

  const readOtp = async (email) =>
    waitFor(`OTP email for ${email}`, () => {
      const message = smtp.latestFor(email);
      const match = message && /code is: (\d{6})/.exec(message);
      return match ? match[1] : null;
    }, 10000, 200);

  const registerUser = async (name, email, password) => {
    const sent = await api("POST", "/auth/register/send-otp", { body: { name, email } });
    assertEqual(sent.status, 200, "send-otp status");
    const otp = await readOtp(email);
    const done = await api("POST", "/auth/register/complete", {
      body: { name, email, password, otp, roleType: "Developer", consent: { termsAccepted: true, privacyPolicyAccepted: true } },
    });
    assertEqual(done.status, 201, `register status (${JSON.stringify(done.body)})`);
  };

  const login = async (email, password) => {
    const response = await api("POST", "/auth/login", { body: { email, password, clientDeviceId: `test-${email}` } });
    assertEqual(response.status, 200, `login status (${JSON.stringify(response.body)})`);
    return response.body.data;
  };

  const waitDeployment = async (serverId, deploymentId, timeoutMs = 240000) =>
    waitFor(`deployment ${deploymentId} to finish`, async () => {
      const response = await api("GET", `/server/${serverId}/deployments/${deploymentId}`, { token: ctx.token });
      const deployment = response.body.data && response.body.data.deployment;
      return deployment && !deployment.isActive ? deployment : null;
    }, timeoutMs, 1000);

  const deploy = async (serverId, body = {}, headers = {}) => {
    const response = await api("POST", `/server/${serverId}/deployments`, { token: ctx.token, body, headers });
    assert([200, 202].includes(response.status), `deploy status ${response.status}: ${JSON.stringify(response.body)}`);
    return response.body.data.deployment;
  };

  const overview = async (serverId) => {
    const response = await api("GET", `/server/${serverId}/overview`, { token: ctx.token });
    assertEqual(response.status, 200, `overview status (${JSON.stringify(response.body)})`);
    return response.body.data;
  };

  const through = (permanentId, route, options) => site(options && options.method ? options.method : "GET", `/s/${permanentId}${route}`, { raw: true, ...options });

  const waitServing = (permanentId, expected, timeoutMs = 30000) =>
    waitFor(`permanent URL to serve "${expected}"`, async () => {
      const response = await through(permanentId, "/");
      return response.status === 200 && response.text.includes(expected) ? response : null;
    }, timeoutMs, 500);

  const waitCommand = async (commandId, timeoutMs = 30000) =>
    waitFor(`command ${commandId} to finish`, async () => {
      const command = await db().collection("recoverycommands").findOne({ commandId });
      return command && ["completed", "failed", "expired"].includes(command.status) ? command : null;
    }, timeoutMs, 300);

  const notificationsOfType = async (type) =>
    db().collection("notifications").find({ userId: oid(ctx.userId), type }).toArray();

  try {
    // ========================================================
    section("1. Backend startup and configuration");
    // ========================================================

    await check("refuses to start with an invalid configuration", async () => {
      const broken = startProcess("backend-broken", process.execPath, ["server.js"], {
        env: { ...backendEnv, MONGO_URI: "", PORT: String(await getFreePort()) },
        cwd: BACKEND_DIR,
        logFile: path.join(TMP, "backend-broken.log"),
      });
      await waitFor("process to exit", () => !broken.isRunning(), 15000, 200);
      assert(/MONGO_URI is required/.test(broken.tail()), `expected a configuration error, got: ${broken.tail(5)}`);
    });

    startBackend();

    await check("starts, connects to MongoDB and answers health checks", async () => {
      await waitFor("API to listen", async () => (await site("GET", "/")).status === 200, 30000, 300);
      const health = await site("GET", "/healthz");
      assertEqual(health.status, 200, "healthz status");
      assertEqual(health.body.database, "connected", "database");
      assert(/Scheduler started/.test(backend.tail(50)), "monitoring scheduler did not start");
    });

    await mongoose.connect(mongoUri);

    await check("unknown routes return a JSON 404 and malformed JSON a 400", async () => {
      const missing = await api("GET", "/nope");
      assertEqual(missing.status, 404, "404 status");
      assertEqual(missing.body.code, "ROUTE_NOT_FOUND", "404 code");
      const malformed = await api("POST", "/auth/login", { body: "{not json", headers: { "Content-Type": "application/json" } });
      assertEqual(malformed.status, 400, "malformed status");
      assertEqual(malformed.body.code, "INVALID_JSON", "malformed code");
    });

    // ========================================================
    section("2. Authentication and sessions");
    // ========================================================

    const email = "owner@example.test";
    const password = "correct horse battery";

    await check("registers with an emailed OTP (real SMTP delivery)", async () => {
      await registerUser("Test Owner", email, password);
    });

    await check("rejects a duplicate registration and weak input", async () => {
      const duplicate = await api("POST", "/auth/register/send-otp", { body: { name: "X Y", email } });
      assertEqual(duplicate.status, 409, "duplicate status");
      const invalid = await api("POST", "/auth/register/send-otp", { body: { name: "X Y", email: "not-an-email" } });
      assertEqual(invalid.status, 400, "invalid email status");
      const typed = await api("POST", "/auth/register/send-otp", { body: { name: { $gt: "" }, email: { $gt: "" } } });
      assertEqual(typed.status, 400, "non-string input status");
    });

    await check("logs in with a password and returns the access token expiry", async () => {
      const data = await login(email, password);
      assert(data.accessToken && data.refreshToken && data.sessionId, "tokens missing");
      assert(data.expiresIn > 0 && data.expiresIn <= 900, `expiresIn should reflect the 15m token, got ${data.expiresIn}`);
      assert(Date.parse(data.accessTokenExpiresAt) < Date.parse(data.expiresAt), "access token must expire before the session");
      Object.assign(ctx, { token: data.accessToken, refreshToken: data.refreshToken, sessionId: data.sessionId, userId: data.user.id });
    });

    await check("rejects a wrong password and unauthenticated requests", async () => {
      const wrong = await api("POST", "/auth/login", { body: { email, password: "wrong-password" } });
      assertEqual(wrong.status, 401, "wrong password status");
      assertEqual((await api("GET", "/server")).status, 401, "no token status");
      assertEqual((await api("GET", "/server", { token: "garbage" })).status, 401, "bad token status");
    });

    await check("returns the current user and lists sessions", async () => {
      const me = await api("GET", "/auth/me", { token: ctx.token });
      assertEqual(me.status, 200, "me status");
      assertEqual(me.body.data.user.email, email, "me email");
      assert(!("passwordHash" in me.body.data.user), "password hash leaked");
      const sessions = await api("GET", "/auth/sessions", { token: ctx.token });
      assert(sessions.body.data.sessions.some((item) => item.isCurrent), "current session missing");
    });

    await check("rotates refresh tokens and revokes the session on reuse", async () => {
      const second = await login(email, password);
      const first = await api("POST", "/auth/refresh", { body: { refreshToken: second.refreshToken, sessionId: second.sessionId } });
      assertEqual(first.status, 200, "refresh status");
      assert(first.body.data.refreshToken !== second.refreshToken, "refresh token was not rotated");
      const reuse = await api("POST", "/auth/refresh", { body: { refreshToken: second.refreshToken, sessionId: second.sessionId } });
      assertEqual(reuse.status, 401, "reuse status");
      const after = await api("POST", "/auth/refresh", { body: { refreshToken: first.body.data.refreshToken, sessionId: second.sessionId } });
      assertEqual(after.status, 401, "session must be revoked after reuse");
      // The same-device login above replaced the first session, so sign in again.
      const fresh = await login(email, password);
      Object.assign(ctx, { token: fresh.accessToken, refreshToken: fresh.refreshToken, sessionId: fresh.sessionId });
    });

    await check("logs in with an emailed OTP", async () => {
      assertEqual((await api("POST", "/auth/login/send-otp", { body: { email } })).status, 200, "send status");
      const otp = await readOtp(email);
      const wrong = await api("POST", "/auth/login/otp", { body: { email, otp: otp === "000000" ? "111111" : "000000" } });
      assertEqual(wrong.status, 400, "wrong OTP status");
      const ok = await api("POST", "/auth/login/otp", { body: { email, otp, clientDeviceId: "otp-device" } });
      assertEqual(ok.status, 200, `OTP login status (${JSON.stringify(ok.body)})`);
      const replay = await api("POST", "/auth/login/otp", { body: { email, otp } });
      assertEqual(replay.status, 400, "OTP must be single use");
    });

    await check("OTP request does not reveal whether an account exists", async () => {
      const unknown = await api("POST", "/auth/login/send-otp", { body: { email: "nobody@example.test" } });
      assertEqual(unknown.status, 200, "unknown account status");
    });

    await check("resets a forgotten password and revokes existing sessions", async () => {
      const resetEmail = "reset@example.test";
      await registerUser("Reset User", resetEmail, "old password 123");
      const before = await login(resetEmail, "old password 123");
      assertEqual((await api("POST", "/auth/forgot-password/send-otp", { body: { email: resetEmail } })).status, 200, "send status");
      const otp = await readOtp(resetEmail);
      const reset = await api("POST", "/auth/forgot-password/reset", { body: { email: resetEmail, otp, newPassword: "new password 456" } });
      assertEqual(reset.status, 200, `reset status (${JSON.stringify(reset.body)})`);
      assertEqual((await api("GET", "/auth/me", { token: before.accessToken })).status, 401, "old session must be revoked");
      assertEqual((await api("POST", "/auth/login", { body: { email: resetEmail, password: "old password 123" } })).status, 401, "old password");
      await login(resetEmail, "new password 456");
    });

    await check("rate limits repeated login attempts for one account", async () => {
      let limited = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await api("POST", "/auth/login", { body: { email: "bruteforce@example.test", password: "x" } });
        if (response.status === 429) {
          limited = true;
          assert(response.headers.get("retry-after"), "Retry-After header missing");
          break;
        }
      }
      assert(limited, "no 429 after 12 attempts");
    });

    await check("logout revokes the session server side", async () => {
      const session = await login("reset@example.test", "new password 456");
      assertEqual((await api("POST", "/auth/logout", { token: session.accessToken })).status, 200, "logout status");
      assertEqual((await api("GET", "/auth/me", { token: session.accessToken })).status, 401, "token must stop working");
    });

    // A second account for authorization checks.
    await registerUser("Other User", "other@example.test", "another password 1");
    ctx.otherToken = (await login("other@example.test", "another password 1")).accessToken;

    // ========================================================
    section("3. Devices and device-agent credentials");
    // ========================================================

    await check("registers an Android device through the setup endpoint", async () => {
      const response = await api("POST", "/setup/saveInfo", {
        token: ctx.token,
        body: { androidId: "abc123android", manufacturer: "Google", model: "Pixel 6", osName: "Android", osVersion: "14", appVersion: "1.0", architecture: "arm64-v8a", totalRam: 8 * 1024 ** 3, totalStorage: 128 * 1024 ** 3 },
      });
      assertEqual(response.status, 200, `saveInfo status (${JSON.stringify(response.body)})`);
      assert(/^DEVSS-\d{6}$/.test(response.body.data.deviceId), "public device id format");
      assertEqual(response.body.data.deviceName, "Google Pixel 6", "device name");
      const again = await api("POST", "/setup/saveInfo", { token: ctx.token, body: { androidId: "abc123android", manufacturer: "Google", model: "Pixel 6" } });
      assertEqual(again.body.data.deviceId, response.body.data.deviceId, "re-registration must keep the id");
      assertEqual(again.body.data.deviceName, "Google Pixel 6", "re-registration must not rename the device");
      ctx.androidDeviceId = response.body.data.deviceId;
    });

    for (const name of ["A", "B", "C"]) {
      await check(`registers Linux device ${name} and provisions its agent token`, async () => {
        const created = await api("POST", "/devices", { token: ctx.token, body: { name: `Test Device ${name}`, deviceType: "linux", architecture: os.arch() } });
        assertEqual(created.status, 201, `create status (${JSON.stringify(created.body)})`);
        const id = created.body.data.device.id;
        const provisioned = await api("POST", `/devices/${id}/agent-token`, { token: ctx.token });
        assertEqual(provisioned.status, 201, "provision status");
        assert(/^ss_agent_[a-f0-9]{96}$/.test(provisioned.body.data.agentToken), "agent token format");
        ctx[`device${name}`] = id;
        ctx[`agentToken${name}`] = provisioned.body.data.agentToken;
      });
    }

    await check("agent endpoints reject missing, malformed and rotated tokens", async () => {
      assertEqual((await api("GET", "/device-agent/config")).status, 401, "missing token");
      assertEqual((await api("GET", "/device-agent/config", { token: "ss_agent_bad" })).status, 401, "malformed token");
      const old = ctx.agentTokenC;
      const rotated = await api("POST", `/device-agent/provision/${ctx.deviceC}`, { token: ctx.token });
      ctx.agentTokenC = rotated.body.data.agentToken;
      assertEqual((await api("GET", "/device-agent/config", { token: old })).status, 401, "rotated token must stop working");
      assertEqual((await api("GET", "/device-agent/config", { token: ctx.agentTokenC })).status, 200, "new token");
    });

    await check("device operations are scoped to the owner", async () => {
      assertEqual((await api("GET", `/devices/${ctx.deviceA}`, { token: ctx.otherToken })).status, 404, "other user GET");
      assertEqual((await api("POST", `/devices/${ctx.deviceA}/agent-token`, { token: ctx.otherToken })).status, 404, "other user provision");
      const list = await api("GET", "/devices", { token: ctx.otherToken });
      assertEqual(list.body.data.devices.length, 0, "other user device list");
      const duplicate = await api("POST", "/devices", { token: ctx.token, body: { name: "Test Device A" } });
      assertEqual(duplicate.status, 409, "duplicate name status");
    });

    // ========================================================
    section("4. Servers, permanent URLs and environment variables");
    // ========================================================

    ctx.commitV1 = remote.commit("node-app", nodeApp("v1"), "v1");

    await check("creates a server with a repository, a primary device and a permanent URL", async () => {
      const response = await api("POST", "/server", {
        token: ctx.token,
        body: { name: "Node App", repository: { provider: "other", repositoryUrl: remote.url("node-app"), branch: "main" }, deviceId: ctx.deviceA },
      });
      assertEqual(response.status, 201, `create status (${JSON.stringify(response.body)})`);
      ctx.serverId = response.body.data.server._id;
      ctx.permanentUrl = response.body.data.permanentUrl;
      ctx.permanentId = ctx.permanentUrl.split("/s/")[1];
      assert(ctx.permanentUrl.startsWith(`${base}/s/node-app-`), `unexpected permanent URL ${ctx.permanentUrl}`);
      assertEqual(response.body.data.server.slug, "node-app", "slug");
    });

    await check("validates server input", async () => {
      const lowPort = await api("POST", "/server", { token: ctx.token, body: { name: "Bad Port", port: 80 } });
      assertEqual(lowPort.status, 400, "privileged port status");
      const badRepo = await api("POST", "/server", { token: ctx.token, body: { name: "Bad Repo", repository: { provider: "other", repositoryUrl: "https://user:pass@example.com/x.git" } } });
      assertEqual(badRepo.status, 400, "embedded credentials status");
      const badRoot = await api("POST", "/server", { token: ctx.token, body: { name: "Bad Root", build: { rootDirectory: "../etc" } } });
      assertEqual(badRoot.status, 400, "path traversal status");
      const duplicate = await api("POST", "/server", { token: ctx.token, body: { name: "Node App" } });
      assertEqual(duplicate.status, 409, "duplicate slug status");
    });

    await check("slug availability route is reachable", async () => {
      const taken = await api("GET", "/server/check-slug?slug=Node%20App", { token: ctx.token });
      assertEqual(taken.status, 200, "status");
      assertEqual(taken.body.data.available, false, "taken slug");
      const free = await api("GET", "/server/check-slug?slug=something-new", { token: ctx.token });
      assertEqual(free.body.data.available, true, "free slug");
    });

    await check("another account cannot read or control the server", async () => {
      for (const [method, route, body] of [
        ["GET", `/server/${ctx.serverId}`], ["GET", `/server/${ctx.serverId}/overview`],
        ["POST", `/server/${ctx.serverId}/deployments`, {}], ["GET", `/server/${ctx.serverId}/logs`],
        ["GET", `/server-env/${ctx.serverId}`], ["POST", `/server/${ctx.serverId}/actions`, { action: "stop" }],
        ["DELETE", `/server/${ctx.serverId}`],
      ]) {
        const response = await api(method, route, { token: ctx.otherToken, body });
        assertEqual(response.status, 404, `${method} ${route}`);
      }
    });

    await check("assigns a standby device", async () => {
      const response = await api("POST", `/server/${ctx.serverId}/devices`, { token: ctx.token, body: { deviceId: ctx.deviceB } });
      assertEqual(response.status, 201, `assign status (${JSON.stringify(response.body)})`);
      assertEqual(response.body.data.role, "standby", "second device role");
      const repeat = await api("POST", `/server/${ctx.serverId}/devices`, { token: ctx.token, body: { deviceId: ctx.deviceB } });
      assertEqual(repeat.status, 200, "repeated assignment must be idempotent");
      const list = await api("GET", `/server/${ctx.serverId}/devices`, { token: ctx.token });
      assertEqual(list.body.data.devices.length, 2, "assigned device count");
      const foreign = await api("POST", `/server/${ctx.serverId}/devices`, { token: ctx.otherToken, body: { deviceId: ctx.deviceB } });
      assertEqual(foreign.status, 404, "other user assign");
    });

    await check("stores environment variables encrypted and masks them on read", async () => {
      const saved = await api("PUT", `/server-env/${ctx.serverId}`, {
        token: ctx.token,
        body: { variables: [
          { key: "PROCESS_ONLY", value: "process-secret-1", target: "process" },
          { key: "FILE_ONLY", value: "file secret with 'quote' and $dollar", target: "file" },
          { key: "BOTH_VAR", value: "both-value-ABC123", target: "both" },
          { key: "MULTILINE", value: "line1\nline2", target: "file" },
        ] },
      });
      assertEqual(saved.status, 200, `save status (${JSON.stringify(saved.body)})`);
      assertEqual(saved.body.data.revision, 1, "revision");
      const read = await api("GET", `/server-env/${ctx.serverId}`, { token: ctx.token });
      assert(!JSON.stringify(read.body).includes("process-secret-1"), "plaintext value returned by the API");
      assertEqual(read.body.data.variables.length, 4, "variable count");
      const stored = await db().collection("serverenvironments").findOne({ serverId: oid(ctx.serverId) });
      assert(!JSON.stringify(stored).includes("process-secret-1"), "plaintext value stored in MongoDB");
      const reserved = await api("PUT", `/server-env/${ctx.serverId}`, { token: ctx.token, body: { variables: [{ key: "SPARESHARE_X", value: "1" }] } });
      assertEqual(reserved.status, 400, "reserved prefix status");
      const invalid = await api("PUT", `/server-env/${ctx.serverId}`, { token: ctx.token, body: { variables: [{ key: "1BAD", value: "1" }] } });
      assertEqual(invalid.status, 400, "invalid key status");
    });

    await check("concurrent environment saves do not lose updates", async () => {
      const writes = await Promise.all(
        ["CONCURRENT_A", "CONCURRENT_B", "CONCURRENT_C"].map((key) =>
          api("PUT", `/server-env/${ctx.serverId}`, { token: ctx.token, body: { variables: [{ key, value: "1", target: "process" }], sync: false } })
        )
      );
      assert(writes.every((item) => item.status === 200), `statuses: ${writes.map((item) => item.status)}`);
      const read = await api("GET", `/server-env/${ctx.serverId}`, { token: ctx.token });
      const keys = read.body.data.variables.map((item) => item.key);
      for (const key of ["CONCURRENT_A", "CONCURRENT_B", "CONCURRENT_C"]) assert(keys.includes(key), `${key} was lost`);
      assertEqual(read.body.data.revision, 4, "revision after three writes");
    });

    // ========================================================
    section("5. Device agent and first deployment");
    // ========================================================

    await check("deployment is refused while the device is offline", async () => {
      const response = await api("POST", `/server/${ctx.serverId}/deployments`, { token: ctx.token, body: {} });
      assertEqual(response.status, 409, "status");
      assertEqual(response.body.code, "DEVICE_OFFLINE", "code");
    });

    await check("agents start from the single-file bundle and report online", async () => {
      startAgent("A", ctx.agentTokenA);
      startAgent("B", ctx.agentTokenB);
      await waitFor("devices A and B to be online", async () => {
        const list = await api("GET", "/devices", { token: ctx.token });
        const online = list.body.data.devices.filter((device) => device.status === "online").map((device) => device.id);
        return online.includes(ctx.deviceA) && online.includes(ctx.deviceB);
      }, 30000);
      const device = await api("GET", `/devices/${ctx.deviceA}`, { token: ctx.token });
      assertEqual(device.body.data.device.agentVersion, "1.0.0", "reported agent version");
      assert(device.body.data.device.metrics.memoryTotalMb > 0, "device metrics missing");
    });

    await check("a second agent on the same device home refuses to start", async () => {
      const duplicate = startProcess("agent-dup", process.execPath, [AGENT_BUNDLE, "run"], {
        env: { ...process.env, SPARESHARE_API_URL: `${base}/api`, SPARESHARE_AGENT_TOKEN: ctx.agentTokenA, SPARESHARE_HOME: agentHome("A") },
        cwd: TMP,
        logFile: path.join(TMP, "agent-dup.log"),
      });
      await waitFor("duplicate agent to exit", () => !duplicate.isRunning(), 20000, 300);
      assert(/already running/.test(duplicate.tail()), `unexpected output: ${duplicate.tail(5)}`);
    });

    await check("deploys a Node.js app: clone, detect, install, start, health check", async () => {
      const queued = await deploy(ctx.serverId, {}, { "Idempotency-Key": "first-deploy-0001" });
      ctx.deployV1 = queued.deploymentId;
      const repeat = await api("POST", `/server/${ctx.serverId}/deployments`, { token: ctx.token, body: {}, headers: { "Idempotency-Key": "first-deploy-0001" } });
      assertEqual(repeat.status, 200, "repeated idempotent request status");
      assertEqual(repeat.body.data.deployment.deploymentId, queued.deploymentId, "repeated request must return the same deployment");
      const concurrent = await api("POST", `/server/${ctx.serverId}/deployments`, { token: ctx.token, body: {} });
      assertEqual(concurrent.status, 409, "second deployment while one is running");

      const deployment = await waitDeployment(ctx.serverId, queued.deploymentId);
      assertEqual(deployment.status, "running", `final status (error: ${deployment.error})`);
      assertEqual(deployment.detection.language, "node", "detected language");
      assertEqual(deployment.detection.framework, "express", "detected framework");
      assertEqual(deployment.detection.packageManager, "npm", "detected package manager");
      assertEqual(deployment.source.commitSha, ctx.commitV1, "deployed commit");
      const steps = deployment.steps.map((step) => step.name);
      for (const step of ["cloning", "detecting", "installing_runtime", "installing_dependencies", "building", "starting"]) {
        assert(steps.includes(step), `missing step ${step}`);
      }
      assert(deployment.steps.every((step) => step.status === "completed"), "every step should be completed");
    });

    await check("the app is reachable through the permanent URL", async () => {
      await waitServing(ctx.permanentId, "hello from node-app v1");
      const data = await overview(ctx.serverId);
      assertEqual(data.server.status, "running", "server status");
      assertEqual(data.runtime.tunnelStatus, "connected", "tunnel status");
      assertEqual(data.server.runtime.framework, "express", "stored framework");
    });

    await check("environment reaches the app: .env file and process injection", async () => {
      const env = JSON.parse((await through(ctx.permanentId, "/env")).text);
      ctx.appPid = env.pid;
      assertEqual(env.PROCESS_ONLY, "process-secret-1", "process-target variable in process.env");
      assertEqual(env.BOTH_VAR, "both-value-ABC123", "both-target variable in process.env");
      assertEqual(env.FILE_ONLY, null, "file-target variable must not be in process.env");
      assert(env.dotenv.includes("FILE_ONLY="), ".env is missing the file-target variable");
      assert(env.dotenv.includes("BOTH_VAR='both-value-ABC123'"), ".env is missing the both-target variable");
      assert(!env.dotenv.includes("PROCESS_ONLY"), "process-target variable must not be written to .env");
      assert(env.dotenv.includes('MULTILINE="line1\\nline2"'), "multi-line value is not escaped correctly");
      assertEqual(env.agentToken, null, "the agent token leaked into the application environment");
      assertEqual(env.nodeEnv, "production", "NODE_ENV default");
      const file = path.join(agentHome("A"), "apps", ctx.serverId, "releases", ctx.deployV1, ".env");
      assertEqual((fs.statSync(file).mode & 0o777).toString(8), "600", ".env file mode");
    });

    await check(".env round-trips through a dotenv parser unchanged", async () => {
      const file = path.join(agentHome("A"), "apps", ctx.serverId, "releases", ctx.deployV1, ".env");
      const parsed = require("dotenv").parse(fs.readFileSync(file));
      assertEqual(parsed.FILE_ONLY, "file secret with 'quote' and $dollar", "FILE_ONLY");
      assertEqual(parsed.MULTILINE, "line1\nline2", "MULTILINE");
    });

    await check("build and application logs are collected, with secrets redacted", async () => {
      await through(ctx.permanentId, "/leak");
      const logs = await waitFor("logs to arrive", async () => {
        const response = await api("GET", `/server/${ctx.serverId}/logs?limit=1000`, { token: ctx.token });
        const lines = response.body.data.logs;
        return lines.some((line) => line.stream === "app" && line.message.includes("value is")) ? lines : null;
      }, 20000);
      assert(logs.some((line) => line.stream === "build" && line.message.includes("npm install")), "build log missing");
      assert(logs.some((line) => line.stream === "build" && line.deploymentId === ctx.deployV1), "build log not tied to the deployment");
      assert(logs.some((line) => line.stream === "app" && line.message.includes("listening on")), "app log missing");
      const leak = logs.find((line) => line.message.includes("value is"));
      assertEqual(leak.message, "value is [redacted]", "secret value must be redacted before leaving the device");
      const tail = await api("GET", `/server/${ctx.serverId}/logs?after=${logs[logs.length - 1].id}`, { token: ctx.token });
      assertEqual(tail.status, 200, "tail status");
      const badCursor = await api("GET", `/server/${ctx.serverId}/logs?after=xyz`, { token: ctx.token });
      assertEqual(badCursor.status, 400, "invalid cursor status");
    });

    // ========================================================
    section("6. Reverse proxy and request routing");
    // ========================================================

    await check("forwards method, query string and body", async () => {
      const response = await through(ctx.permanentId, "/echo?a=1&b=two", { method: "POST", body: "payload-123", headers: { "Content-Type": "text/plain" } });
      const echoed = JSON.parse(response.text);
      assertEqual(echoed.method, "POST", "method");
      assertEqual(echoed.query.b, "two", "query");
      assertEqual(echoed.body, "payload-123", "body");
      assert(echoed.forwardedHost, "X-Forwarded-Host missing");
    });

    await check("rewrites upstream redirects to the permanent URL", async () => {
      const response = await through(ctx.permanentId, "/go");
      assertEqual(response.status, 302, "status");
      assertEqual(response.headers.get("location"), `${base}/s/${ctx.permanentId}/data`, "Location header");
    });

    await check("routes by wildcard host name", async () => {
      // fetch() does not allow overriding Host, so this uses http directly.
      const response = await new Promise((resolve, reject) => {
        const request = require("http").request(
          { host: "127.0.0.1", port: apiPort, path: "/echo?via=host", method: "GET", headers: { Host: `${ctx.permanentId}.apps.test` } },
          (res) => {
            let text = "";
            res.on("data", (chunk) => { text += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, text }));
          }
        );
        request.on("error", reject);
        request.end();
      });
      assertEqual(response.status, 200, "status");
      assertEqual(JSON.parse(response.text).query.via, "host", "the app must receive the request at its root");
    });

    await check("proxies WebSocket upgrades", async () => {
      const reply = await new Promise((resolve, reject) => {
        const socket = net.connect(apiPort, "127.0.0.1");
        let received = Buffer.alloc(0);
        socket.setTimeout(8000, () => { socket.destroy(); reject(new Error("WebSocket upgrade timed out")); });
        socket.on("error", reject);
        socket.on("data", (chunk) => {
          received = Buffer.concat([received, chunk]);
          if (received.includes("ws-ok")) { socket.destroy(); resolve(received.toString("latin1")); }
        });
        socket.on("close", () => resolve(received.toString("latin1")));
        socket.write(`GET /s/${ctx.permanentId}/socket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      assert(reply.startsWith("HTTP/1.1 101"), `expected 101, got: ${reply.slice(0, 60)}`);
      assert(reply.includes("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="), "Sec-WebSocket-Accept missing");
      assert(reply.includes("ws-ok"), "frame from the application did not arrive");
    });

    await check("records traffic statistics", async () => {
      const stats = await waitFor("traffic counters", async () => {
        const data = await overview(ctx.serverId);
        return data.metrics && data.metrics.traffic.totalRequests >= 5 ? data.metrics.traffic : null;
      }, 10000);
      assert(stats.successfulRequests >= 4, "successful requests not counted");
      assert(stats.minuteBuckets.length >= 1, "minute bucket missing");
    });

    await check("enforces allowed methods and the per-endpoint rate limit", async () => {
      const security = await api("PATCH", `/server-endpoint/${ctx.serverId}/security`, { token: ctx.token, body: { allowedMethods: ["GET", "HEAD"], rateLimitPerMinute: 4 } });
      assertEqual(security.status, 200, `security status (${JSON.stringify(security.body)})`);
      assertEqual((await through(ctx.permanentId, "/echo", { method: "POST", body: "x" })).status, 405, "blocked method");
      let limited = false;
      for (let request = 0; request < 8; request += 1) {
        if ((await through(ctx.permanentId, "/")).status === 429) { limited = true; break; }
      }
      assert(limited, "endpoint rate limit was not enforced");
      await api("PATCH", `/server-endpoint/${ctx.serverId}/security`, { token: ctx.token, body: { allowedMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"], rateLimitPerMinute: 100000 } });
    });

    await check("redirect routing mode sends a 307 to the device URL", async () => {
      await api("PATCH", `/server-endpoint/${ctx.serverId}/routing-mode`, { token: ctx.token, body: { routingMode: "redirect" } });
      const response = await through(ctx.permanentId, "/data?x=1");
      assertEqual(response.status, 307, "status");
      assert(/^http:\/\/127\.0\.0\.1:\d+\/data\?x=1$/.test(response.headers.get("location")), `Location: ${response.headers.get("location")}`);
      await api("PATCH", `/server-endpoint/${ctx.serverId}/routing-mode`, { token: ctx.token, body: { routingMode: "proxy" } });
    });

    await check("unknown and malformed permanent IDs are rejected", async () => {
      assertEqual((await site("GET", "/s/does-not-exist-0000000000")).status, 404, "unknown id");
      assertEqual((await site("GET", "/s/Bad_ID!")).status, 400, "malformed id");
    });

    await check("a device may only register a Cloudflare Quick Tunnel URL", async () => {
      for (const tunnelUrl of ["https://evil.example.com", "http://abc.trycloudflare.com", "https://trycloudflare.com.evil.com", "https://abc.trycloudflare.com/path", "http://10.0.0.5:8080"]) {
        const response = await api("POST", `/device-agent/servers/${ctx.serverId}/tunnel`, { token: ctx.agentTokenA, body: { tunnelUrl } });
        assertEqual(response.status, 400, `tunnel URL ${tunnelUrl}`);
      }
      const foreign = await api("POST", `/device-agent/servers/${ctx.serverId}/tunnel`, { token: ctx.agentTokenC, body: { tunnelUrl: "https://abc-def.trycloudflare.com" } });
      assertEqual(foreign.status, 403, "unassigned device");
    });

    // ========================================================
    section("7. Environment synchronization");
    // ========================================================

    await check("a saved variable is synced to the device and the app restarts with it", async () => {
      const saved = await api("PUT", `/server-env/${ctx.serverId}`, {
        token: ctx.token,
        body: { variables: [{ key: "PROCESS_ONLY", value: "process-secret-2", target: "process" }, { key: "NEW_FILE_VAR", value: "fresh", target: "file" }] },
      });
      assertEqual(saved.status, 200, "save status");
      assert(saved.body.data.syncQueuedDevices >= 1, "no sync was queued");
      const env = await waitFor("app to restart with the new value", async () => {
        const response = await through(ctx.permanentId, "/env");
        if (response.status !== 200) return null;
        const parsed = JSON.parse(response.text);
        return parsed.PROCESS_ONLY === "process-secret-2" ? parsed : null;
      }, 40000);
      assert(env.pid !== ctx.appPid, "the process was not restarted");
      assert(env.dotenv.includes("NEW_FILE_VAR='fresh'"), ".env was not regenerated");
      assert(env.dotenv.includes(`revision ${saved.body.data.revision}`), ".env does not carry the new revision");
      ctx.appPid = env.pid;
    });

    await check("deleting a variable removes it from the device", async () => {
      const removed = await api("DELETE", `/server-env/${ctx.serverId}/NEW_FILE_VAR`, { token: ctx.token });
      assertEqual(removed.status, 200, "delete status");
      await waitFor("variable to disappear from .env", async () => {
        const response = await through(ctx.permanentId, "/env");
        return response.status === 200 && !JSON.parse(response.text).dotenv.includes("NEW_FILE_VAR");
      }, 40000);
    });

    await check("an agent can only read the environment of servers assigned to it", async () => {
      const own = await api("GET", `/device-agent/servers/${ctx.serverId}/environment`, { token: ctx.agentTokenA });
      assertEqual(own.status, 200, "assigned device");
      assertEqual(own.body.data.variables.PROCESS_ONLY.value, "process-secret-2", "decrypted value for the assigned agent");
      const foreign = await api("GET", `/device-agent/servers/${ctx.serverId}/environment`, { token: ctx.agentTokenC });
      assertEqual(foreign.status, 403, "unassigned device");
    });

    // ========================================================
    section("8. Process management and self-healing");
    // ========================================================

    const action = async (name) => {
      const response = await api("POST", `/server/${ctx.serverId}/actions`, { token: ctx.token, body: { action: name } });
      assertEqual(response.status, 202, `${name} status (${JSON.stringify(response.body)})`);
      return response.body.data;
    };

    await check("stop: the process ends and the permanent URL returns 503", async () => {
      await action("stop");
      await waitFor("process to stop", () => !isPidAlive(ctx.appPid), 20000);
      await waitFor("server status stopped", async () => (await overview(ctx.serverId)).server.status === "stopped", 20000);
      assertEqual((await through(ctx.permanentId, "/")).status, 503, "status while stopped");
      // The agent must not restart an app the owner stopped.
      await sleep(5000);
      assertEqual((await through(ctx.permanentId, "/")).status, 503, "the stopped app was restarted");
    });

    await check("start: the process comes back and serves again", async () => {
      await action("start");
      await waitServing(ctx.permanentId, "hello from node-app v1", 40000);
      ctx.appPid = JSON.parse((await through(ctx.permanentId, "/env")).text).pid;
    });

    await check("restart: the process is replaced", async () => {
      const previous = ctx.appPid;
      const data = await action("restart");
      await waitCommand(data.commandId);
      const env = await waitFor("a new process", async () => {
        const response = await through(ctx.permanentId, "/env");
        if (response.status !== 200) return null;
        const parsed = JSON.parse(response.text);
        return parsed.pid !== previous ? parsed : null;
      }, 30000);
      assert(!isPidAlive(previous), "the old process is still alive");
      ctx.appPid = env.pid;
    });

    await check("self-healing: a crashed app is restarted automatically", async () => {
      const previous = ctx.appPid;
      process.kill(previous, "SIGKILL");
      const env = await waitFor("automatic restart", async () => {
        const response = await through(ctx.permanentId, "/env");
        if (response.status !== 200) return null;
        const parsed = JSON.parse(response.text);
        return parsed.pid !== previous ? parsed : null;
      }, 40000);
      ctx.appPid = env.pid;
      await waitFor("restart to be logged", async () => {
        const response = await api("GET", `/server/${ctx.serverId}/logs?stream=agent&limit=200`, { token: ctx.token });
        return response.body.data.logs.some((line) => /Restarting \(attempt 1 of/.test(line.message));
      }, 15000);
    });

    await check("the app survives an agent restart without downtime", async () => {
      const pid = ctx.appPid;
      await agents.A.stop("SIGTERM");
      assert(isPidAlive(pid), "stopping the agent killed the application");
      assertEqual((await through(ctx.permanentId, "/")).status, 200, "app must keep serving while the agent is down");
      startAgent("A", ctx.agentTokenA);
      await sleep(6000);
      assertEqual(JSON.parse((await through(ctx.permanentId, "/env")).text).pid, pid, "the agent restarted an app that was already running");
    });

    await check("diagnostics command reports real process state", async () => {
      const queued = await api("POST", "/device-agent/commands", { token: ctx.token, body: { serverId: ctx.serverId, deviceId: ctx.deviceA, action: "FULL_DIAGNOSTICS" } });
      assertEqual(queued.status, 201, "queue status");
      const command = await waitCommand(queued.body.data.commandId);
      assertEqual(command.status, "completed", "command status");
      const report = command.result.servers[ctx.serverId];
      assertEqual(report.pid !== null && report.processAlive, true, "process state");
      assertEqual(report.listening, true, "port state");
      assert(command.result.tools.node && command.result.tools.git, "tool versions missing");
      const invalid = await api("POST", "/device-agent/commands", { token: ctx.token, body: { serverId: ctx.serverId, deviceId: ctx.deviceA, action: "DEPLOY" } });
      assertEqual(invalid.status, 400, "DEPLOY must not be queueable directly");
      const foreign = await api("POST", "/device-agent/commands", { token: ctx.otherToken, body: { serverId: ctx.serverId, deviceId: ctx.deviceA, action: "FULL_DIAGNOSTICS" } });
      assertEqual(foreign.status, 404, "other user queue");
    });

    // ========================================================
    section("9. Redeploy, rollback, failure handling and cancellation");
    // ========================================================

    await check("redeploys a new commit", async () => {
      ctx.commitV2 = remote.commit("node-app", nodeApp("v2"), "v2");
      const queued = await deploy(ctx.serverId);
      const deployment = await waitDeployment(ctx.serverId, queued.deploymentId);
      assertEqual(deployment.status, "running", `status (error: ${deployment.error})`);
      assertEqual(deployment.source.commitSha, ctx.commitV2, "commit");
      await waitServing(ctx.permanentId, "hello from node-app v2");
      ctx.deployV2 = queued.deploymentId;
    });

    await check("a failing deployment is reported and the previous release keeps serving", async () => {
      remote.commit("node-app", { "server.js": 'console.error("boot failure"); process.exit(7);\n' }, "broken");
      const queued = await deploy(ctx.serverId);
      const deployment = await waitDeployment(ctx.serverId, queued.deploymentId);
      assertEqual(deployment.status, "failed", "status");
      assert(/exited during startup/.test(deployment.error), `error: ${deployment.error}`);
      await waitServing(ctx.permanentId, "hello from node-app v2", 40000);
      assert((await notificationsOfType("deployment.failed")).length >= 1, "no failure notification");
    });

    await check("rolls back to an earlier deployment's exact commit", async () => {
      const response = await api("POST", `/server/${ctx.serverId}/deployments/${ctx.deployV1}/rollback`, { token: ctx.token });
      assertEqual(response.status, 202, `rollback status (${JSON.stringify(response.body)})`);
      const deployment = await waitDeployment(ctx.serverId, response.body.data.deployment.deploymentId);
      assertEqual(deployment.status, "running", `status (error: ${deployment.error})`);
      assertEqual(deployment.source.commitSha, ctx.commitV1, "commit");
      await waitServing(ctx.permanentId, "hello from node-app v1");
    });

    await check("a cancelled deployment stops on the device", async () => {
      remote.commit("node-app", nodeApp("v3"), "v3");
      const queued = await deploy(ctx.serverId);
      const cancelled = await api("POST", `/server/${ctx.serverId}/deployments/${queued.deploymentId}/cancel`, { token: ctx.token });
      assertEqual(cancelled.status, 200, "cancel status");
      assertEqual(cancelled.body.data.deployment.status, "cancelled", "status");
      // The lock is released, and the device did not switch to v3.
      await sleep(8000);
      assert((await through(ctx.permanentId, "/")).text.includes("v1"), "the cancelled release went live");
      const again = await deploy(ctx.serverId, { commitSha: ctx.commitV2 });
      const deployment = await waitDeployment(ctx.serverId, again.deploymentId);
      assertEqual(deployment.status, "running", `status after cancel (error: ${deployment.error})`);
      await waitServing(ctx.permanentId, "hello from node-app v2");
      ctx.appPid = JSON.parse((await through(ctx.permanentId, "/env")).text).pid;
    });

    await check("deployment history is listed", async () => {
      const list = await api("GET", `/server/${ctx.serverId}/deployments?limit=50`, { token: ctx.token });
      const statuses = list.body.data.deployments.map((item) => item.status);
      for (const status of ["running", "superseded", "failed", "cancelled"]) assert(statuses.includes(status), `missing ${status}`);
      assertEqual(statuses.filter((status) => status === "running").length, 1, "exactly one deployment should be current");
    });

    // ========================================================
    section("10. Python (Flask) deployment");
    // ========================================================

    if (enabled("python")) {
      await check("deploys a Flask app in a virtual environment", async () => {
        remote.commit("flask-app", flaskApp, "flask");
        const created = await api("POST", "/server", { token: ctx.token, body: { name: "Flask App", repository: { provider: "other", repositoryUrl: remote.url("flask-app") }, deviceId: ctx.deviceA } });
        assertEqual(created.status, 201, "create status");
        ctx.flaskServerId = created.body.data.server._id;
        ctx.flaskPermanentId = created.body.data.permanentUrl.split("/s/")[1];
        await api("PUT", `/server-env/${ctx.flaskServerId}`, { token: ctx.token, body: { variables: [{ key: "PROCESS_ONLY", value: "flask-env", target: "process" }] } });
        const queued = await deploy(ctx.flaskServerId);
        const deployment = await waitDeployment(ctx.flaskServerId, queued.deploymentId, 400000);
        assertEqual(deployment.status, "running", `status (error: ${deployment.error})`);
        assertEqual(deployment.detection.language, "python", "language");
        assertEqual(deployment.detection.framework, "flask", "framework");
        await waitServing(ctx.flaskPermanentId, "hello from flask flask-env");
      });

      await check("two servers on one device get different ports", async () => {
        const state = agentState("A").servers;
        assert(state[ctx.serverId].port !== state[ctx.flaskServerId].port, "port collision");
      });
    }

    // ========================================================
    section("11. Static site and tunnel process management");
    // ========================================================

    await check("deploys a static site and manages a tunnel process (cloudflared stand-in)", async () => {
      // A stand-in executable with cloudflared's command-line contract. It
      // exercises spawn, URL parsing, reporting and restart. It does not
      // prove connectivity to Cloudflare.
      const stub = path.join(TMP, "cloudflared-standin.sh");
      fs.writeFileSync(stub, [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "cloudflared version 0.0.0-standin"; exit 0; fi',
        "ID=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \\n')",
        'echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2',
        'echo "INF Thank you for trying Cloudflare Tunnel. https://api.trycloudflare.com is the control endpoint" >&2',
        "sleep 1",
        'echo "INF |  https://standin-$ID-test.trycloudflare.com  |" >&2',
        "exec sleep 100000",
        "",
      ].join("\n"), { mode: 0o755 });

      startAgent("C", ctx.agentTokenC, { SPARESHARE_TUNNEL_PROVIDER: "cloudflared", SPARESHARE_CLOUDFLARED_PATH: stub });
      await waitFor("device C online", async () => (await api("GET", `/devices/${ctx.deviceC}`, { token: ctx.token })).body.data.device.status === "online", 30000);

      remote.commit("static-site", staticSite, "static");
      const created = await api("POST", "/server", { token: ctx.token, body: { name: "Static Site", repository: { provider: "other", repositoryUrl: remote.url("static-site") }, deviceId: ctx.deviceC, monitoringEnabled: false } });
      ctx.staticServerId = created.body.data.server._id;
      const queued = await deploy(ctx.staticServerId);
      const deployment = await waitDeployment(ctx.staticServerId, queued.deploymentId);
      assertEqual(deployment.status, "running", `status (error: ${deployment.error})`);
      assertEqual(deployment.detection.framework, "static", "framework");

      const entry = agentState("C").servers[ctx.staticServerId];
      const local = await fetch(`http://127.0.0.1:${entry.port}/`);
      assert((await local.text()).includes("static-ok"), "static site is not served");
      assertEqual((await fetch(`http://127.0.0.1:${entry.port}/../../etc/passwd`)).status, 404, "path traversal");
      assertEqual((await fetch(`http://127.0.0.1:${entry.port}/about`)).status, 200, "extensionless page");
    });

    await check("the tunnel URL is parsed, reported and mapped to the permanent URL", async () => {
      const data = await waitFor("tunnel URL to be registered", async () => {
        const result = await overview(ctx.staticServerId);
        return result.runtime.tunnelUrl ? result : null;
      }, 30000);
      assert(/^https:\/\/standin-[a-f0-9]{8}-test\.trycloudflare\.com$/.test(data.runtime.tunnelUrl), `unexpected URL ${data.runtime.tunnelUrl}`);
      assertEqual(data.runtime.tunnelStatus, "connected", "tunnel status");
      ctx.firstTunnelUrl = data.runtime.tunnelUrl;
      const endpoint = await db().collection("serverendpoints").findOne({ serverId: oid(ctx.staticServerId) });
      assertEqual(endpoint.redirectionLinks[0].destinationLink, ctx.firstTunnelUrl, "endpoint destination");
      assertEqual(endpoint.redirectionLinks[0].isActive, true, "endpoint link active");
    });

    await check("self-healing: a dead tunnel process is restarted and the new URL published", async () => {
      const tunnelPid = agentState("C").servers[ctx.staticServerId].tunnel.pid;
      assert(isPidAlive(tunnelPid), "tunnel process is not running");
      process.kill(tunnelPid, "SIGKILL");
      const data = await waitFor("a new tunnel URL", async () => {
        const result = await overview(ctx.staticServerId);
        return result.runtime.tunnelUrl && result.runtime.tunnelUrl !== ctx.firstTunnelUrl ? result : null;
      }, 40000);
      const endpoint = await db().collection("serverendpoints").findOne({ serverId: oid(ctx.staticServerId) });
      assertEqual(endpoint.redirectionLinks[0].destinationLink, data.runtime.tunnelUrl, "endpoint follows the new URL");
      assert(endpoint.permanentId, "permanent ID must not change");
    });

    // ========================================================
    section("12. Backup and restore");
    // ========================================================

    await check("creates a verified backup of the application and its data", async () => {
      assertEqual((await through(ctx.permanentId, "/data", { method: "POST", body: "backed-up-value" })).status, 200, "write data");
      const requested = await api("POST", `/server/${ctx.serverId}/backups`, { token: ctx.token });
      assertEqual(requested.status, 202, `request status (${JSON.stringify(requested.body)})`);
      ctx.backupId = requested.body.data.backup.backupId;
      const duplicate = await api("POST", `/server/${ctx.serverId}/backups`, { token: ctx.token });
      assertEqual(duplicate.status, 409, "second backup while one is running");
      const backup = await waitFor("backup to complete", async () => {
        const list = await api("GET", `/server/${ctx.serverId}/backups`, { token: ctx.token });
        const item = list.body.data.backups.find((entry) => entry.backupId === ctx.backupId);
        if (item && item.status === "failed") throw new Error(`backup failed: ${item.error}`);
        return item && item.status === "completed" ? item : null;
      }, 60000);
      assert(backup.sizeBytes > 0 && /^[a-f0-9]{64}$/.test(backup.sha256), "size or checksum missing");

      const stored = path.join(TMP, "backup-storage", "backups", ctx.serverId, `${ctx.backupId}.tar.gz`);
      const actual = crypto.createHash("sha256").update(fs.readFileSync(stored)).digest("hex");
      assertEqual(actual, backup.sha256, "stored archive checksum");

      const listing = execFileSync("tar", ["-tzf", stored]).toString();
      assert(listing.includes("data/value.txt"), "data directory missing from the archive");
      assert(listing.includes("/server.js"), "application source missing from the archive");
      assert(!/node_modules/.test(listing), "node_modules must not be archived");
      assert(!/\/\.env\n/.test(listing), "the generated .env (decrypted secrets) must not be archived");
    });

    await check("a backup with a wrong checksum is rejected", async () => {
      const record = { backupId: crypto.randomUUID(), serverId: oid(ctx.serverId), deviceId: oid(ctx.deviceA), status: "pending", trigger: "manual", storage: { driver: "local", key: `backups/${ctx.serverId}/tampered.tar.gz` }, createdAt: new Date(), updatedAt: new Date() };
      await db().collection("backups").insertOne(record);
      const upload = await fetch(`${base}/api/device-agent/backups/${record.backupId}/content`, { method: "PUT", headers: { Authorization: `Bearer ${ctx.agentTokenA}`, "Content-Type": "application/gzip" }, body: "not really a tarball" });
      assertEqual(upload.status, 200, "upload status");
      const complete = await api("POST", `/device-agent/backups/${record.backupId}/complete`, { token: ctx.agentTokenA, body: { sizeBytes: 20, sha256: "0".repeat(64) } });
      assertEqual(complete.status, 409, "status");
      assertEqual(complete.body.code, "BACKUP_INTEGRITY_MISMATCH", "code");
      const foreign = await api("GET", `/device-agent/backups/${ctx.backupId}/download-source`, { token: ctx.agentTokenC });
      assertEqual(foreign.status, 403, "unassigned device download");
      await db().collection("backups").deleteOne({ backupId: record.backupId });
    });

    await check("restores the backup: data returns and the app serves again", async () => {
      await through(ctx.permanentId, "/data", { method: "POST", body: "changed-after-backup" });
      assertEqual((await through(ctx.permanentId, "/data")).text, "changed-after-backup", "precondition");
      const response = await api("POST", `/server/${ctx.serverId}/backups/${ctx.backupId}/restore`, { token: ctx.token, body: {} });
      assertEqual(response.status, 202, `restore status (${JSON.stringify(response.body)})`);
      const deployment = await waitDeployment(ctx.serverId, response.body.data.deployment.deploymentId);
      assertEqual(deployment.status, "running", `status (error: ${deployment.error})`);
      assertEqual(deployment.trigger, "restore", "trigger");
      await waitServing(ctx.permanentId, "hello from node-app v2", 40000);
      assertEqual((await through(ctx.permanentId, "/data")).text, "backed-up-value", "restored data");
      const env = JSON.parse((await through(ctx.permanentId, "/env")).text);
      assertEqual(env.PROCESS_ONLY, "process-secret-2", "environment is rebuilt from the backend on restore");
      ctx.appPid = env.pid;
    });

    await check("backup settings and scheduled backups", async () => {
      const settings = await api("PATCH", `/server/${ctx.serverId}/backups/settings`, { token: ctx.token, body: { enabled: true, intervalHours: 1, retentionCount: 2 } });
      assertEqual(settings.status, 200, "settings status");
      const scheduled = await waitFor("a scheduled backup", async () => {
        const list = await api("GET", `/server/${ctx.serverId}/backups`, { token: ctx.token });
        return list.body.data.backups.find((item) => item.trigger === "scheduled" && item.status === "completed");
      }, 60000);
      assert(scheduled, "no scheduled backup was taken");
      ctx.backupId = scheduled.backupId;
      const invalid = await api("PATCH", `/server/${ctx.serverId}/backups/settings`, { token: ctx.token, body: { intervalHours: 0 } });
      assertEqual(invalid.status, 400, "invalid interval status");
    });

    // ========================================================
    section("13. Monitoring and automatic recovery");
    // ========================================================

    await check("a hung app is detected, a recovery command is issued and the server recovers", async () => {
      const since = new Date();
      process.kill(ctx.appPid, "SIGSTOP");

      const command = await waitFor("an automatic recovery command", async () =>
        db().collection("recoverycommands").findOne({ serverId: oid(ctx.serverId), "payload.source": "automatic_monitoring", createdAt: { $gt: since } }), 40000);
      assert(["RESTART_TUNNEL", "RESTART_APPLICATION", "CHECK_TUNNEL"].includes(command.action), `unexpected action ${command.action}`);
      assertEqual(command.payload.failureType, "tunnel_unreachable", "classified failure");

      // server.down is de-duplicated for ten minutes, so an earlier outage
      // in this run may already have raised it.
      await waitFor("a server.down notification", async () => (await notificationsOfType("server.down")).length >= 1, 20000);
      const state = await db().collection("servermonitoringstates").findOne({ serverId: oid(ctx.serverId) });
      assert(state.lastFailureType !== "none", "failure was not classified");

      const env = await waitFor("the hung process to be replaced", async () => {
        const response = await through(ctx.permanentId, "/env").catch(() => null);
        if (!response || response.status !== 200) return null;
        const parsed = JSON.parse(response.text);
        return parsed.pid !== ctx.appPid ? parsed : null;
      }, 90000, 1000);
      ctx.appPid = env.pid;

      await waitFor("a server.recovered notification", async () =>
        (await notificationsOfType("server.recovered")).some((item) => item.createdAt > since), 30000);
      const finished = await waitCommand(command.commandId, 30000);
      assertEqual(finished.status, "completed", "recovery command status");
    });

    await check("health classification distinguishes failure types", async () => {
      const { classifyMonitoringFailure } = require("../services/monitoring.service");
      const ok = { reachable: true, status: 200 };
      const down = { reachable: false, status: null };
      assertEqual(classifyMonitoringFailure({ deviceIsOnline: false, endpointProbe: ok, tunnelProbe: ok }), "device_unreachable", "offline device");
      assertEqual(classifyMonitoringFailure({ deviceIsOnline: true, endpointProbe: ok, tunnelProbe: down }), "tunnel_unreachable", "dead tunnel");
      assertEqual(classifyMonitoringFailure({ deviceIsOnline: true, endpointProbe: ok, tunnelProbe: { reachable: true, status: 502 } }), "tunnel_upstream_error", "502");
      assertEqual(classifyMonitoringFailure({ deviceIsOnline: true, endpointProbe: ok, tunnelProbe: { reachable: true, status: 500 } }), "application_http_error", "500");
      assertEqual(classifyMonitoringFailure({ deviceIsOnline: true, endpointProbe: down, tunnelProbe: ok }), "permanent_endpoint_failure", "proxy failure");
      assertEqual(classifyMonitoringFailure({ deviceIsOnline: true, endpointProbe: ok, tunnelProbe: { reachable: true, status: 404 } }), "none", "404 is a serving app");
    });

    // ========================================================
    section("14. Multi-device hosting and failover");
    // ========================================================

    await check("automatic failover: the device dies and the standby takes over from the backup", async () => {
      const appGroup = agentState("A").servers[ctx.serverId].app.pid;
      const flaskGroup = ctx.flaskServerId ? agentState("A").servers[ctx.flaskServerId].app.pid : null;

      // Simulate the phone dying: the agent and everything it hosts vanish.
      await agents.A.stop("SIGKILL");
      for (const group of [appGroup, flaskGroup]) {
        if (group) { try { process.kill(-group, "SIGKILL"); } catch { /* gone */ } }
      }

      await waitFor("device A to be marked offline", async () => (await api("GET", `/devices/${ctx.deviceA}`, { token: ctx.token })).body.data.device.status === "offline", 30000);

      const event = await waitFor("failover to complete", async () => {
        const response = await api("GET", `/server/${ctx.serverId}/failover`, { token: ctx.token });
        const latest = response.body.data.events[0];
        if (latest && latest.status === "failed") throw new Error(`failover failed: ${latest.error}`);
        return latest && latest.status === "completed" ? latest : null;
      }, 180000, 1000);

      assertEqual(event.trigger, "automatic", "trigger");
      assertEqual(event.strategy, "backup", "strategy");
      assertEqual(String(event.toDeviceId._id), ctx.deviceB, "target device");

      const data = await overview(ctx.serverId);
      assertEqual(String(data.server.activeDeviceId), ctx.deviceB, "active device");
      await waitServing(ctx.permanentId, "hello from node-app v2", 40000);
      assertEqual((await through(ctx.permanentId, "/data")).text, "backed-up-value", "data restored on the standby");
      assert(ctx.permanentUrl === data.permanentUrl, "the permanent URL changed");

      const portB = agentState("B").servers[ctx.serverId].port;
      const env = JSON.parse((await through(ctx.permanentId, "/env")).text);
      assertEqual(Number(env.port), portB, "traffic is served by device B");
      assertEqual(env.PROCESS_ONLY, "process-secret-2", "environment on the standby");
      ctx.appPidB = env.pid;

      for (const type of ["device.offline", "failover.started", "failover.completed"]) {
        assert((await notificationsOfType(type)).length >= 1, `missing ${type} notification`);
      }
    });

    if (enabled("python")) {
      await check("a server with no standby raises a clear alert instead of failing over", async () => {
        await waitFor("failover.unavailable notification", async () =>
          (await notificationsOfType("failover.unavailable")).some((item) => String(item.serverId) === ctx.flaskServerId), 60000);
        // 502 while the last heartbeat still looks fresh, 503 once it is stale.
        const immediate = await through(ctx.flaskPermanentId, "/");
        assert([502, 503].includes(immediate.status), `expected 502 or 503, got ${immediate.status}`);
        await waitFor("the proxy to stop trying a dead device", async () => {
          const response = await through(ctx.flaskPermanentId, "/");
          return response.status === 503 && /SERVER_HEARTBEAT_STALE/.test(response.text);
        }, 30000);
      });
    }

    await check("no split brain: the old primary returns and stays stopped", async () => {
      startAgent("A", ctx.agentTokenA);
      await waitFor("device A online again", async () => (await api("GET", `/devices/${ctx.deviceA}`, { token: ctx.token })).body.data.device.status === "online", 30000);
      await sleep(8000);
      const entry = agentState("A").servers[ctx.serverId];
      assert(!entry.app.pid || !isPidAlive(entry.app.pid), "the old primary restarted its copy");
      const env = JSON.parse((await through(ctx.permanentId, "/env")).text);
      assertEqual(env.pid, ctx.appPidB, "traffic must still be served by device B");
      const stale = await api("POST", `/device-agent/servers/${ctx.serverId}/tunnel`, { token: ctx.agentTokenA, body: { tunnelUrl: "http://127.0.0.1:9" } });
      assertEqual(stale.status, 200, "standby may register");
      assertEqual(stale.body.data.isActiveDevice, false, "a standby registration must not take traffic");
      assertEqual(JSON.parse((await through(ctx.permanentId, "/env")).text).pid, ctx.appPidB, "routing changed after a standby registered a tunnel");
      assert((await notificationsOfType("device.online")).length >= 1, "missing device.online notification");
    });

    await check("manual failover moves the server back", async () => {
      const response = await api("POST", `/server/${ctx.serverId}/failover`, { token: ctx.token, body: { targetDeviceId: ctx.deviceA } });
      assertEqual(response.status, 202, `status (${JSON.stringify(response.body)})`);
      const duplicate = await api("POST", `/server/${ctx.serverId}/failover`, { token: ctx.token, body: { targetDeviceId: ctx.deviceA } });
      assertEqual(duplicate.status, 409, "second failover while one is running");
      await waitFor("manual failover to complete", async () => {
        const events = (await api("GET", `/server/${ctx.serverId}/failover`, { token: ctx.token })).body.data.events;
        if (events[0].status === "failed") throw new Error(`failover failed: ${events[0].error}`);
        return events[0].trigger === "manual" && events[0].status === "completed";
      }, 180000, 1000);
      await waitServing(ctx.permanentId, "hello from node-app v2", 40000);
      const env = JSON.parse((await through(ctx.permanentId, "/env")).text);
      assertEqual(Number(env.port), agentState("A").servers[ctx.serverId].port, "traffic is served by device A again");
      await waitFor("device B to stop its copy", () => !isPidAlive(ctx.appPidB), 30000);
    });

    await check("failover validation", async () => {
      const same = await api("POST", `/server/${ctx.serverId}/failover`, { token: ctx.token, body: { targetDeviceId: ctx.deviceA } });
      assertEqual(same.status, 409, "failover to the active device");
      const unassigned = await api("POST", `/server/${ctx.serverId}/failover`, { token: ctx.token, body: { targetDeviceId: ctx.deviceC } });
      assertEqual(unassigned.status, 409, "failover to an unassigned device");
      const inUse = await api("DELETE", `/devices/${ctx.deviceA}`, { token: ctx.token });
      assertEqual(inUse.status, 409, "removing a device that serves a running server");
    });

    // ========================================================
    section("15. Notifications");
    // ========================================================

    await check("lists, counts and marks notifications as read", async () => {
      const list = await api("GET", "/notifications?limit=100", { token: ctx.token });
      assertEqual(list.status, 200, "list status");
      assert(list.body.data.notifications.length >= 8, `expected several notifications, got ${list.body.data.notifications.length}`);
      assert(list.body.data.unread >= 1, "unread count");
      const first = list.body.data.notifications[0];
      const read = await api("POST", `/notifications/${first.id}/read`, { token: ctx.token });
      assertEqual(read.body.data.notification.read, true, "read flag");
      const count = await api("GET", "/notifications/unread-count", { token: ctx.token });
      assertEqual(count.body.data.unread, list.body.data.unread - 1, "unread count after reading one");
      const foreign = await api("POST", `/notifications/${first.id}/read`, { token: ctx.otherToken });
      assertEqual(foreign.status, 404, "other user");
      await api("POST", "/notifications/read-all", { token: ctx.token });
      assertEqual((await api("GET", "/notifications/unread-count", { token: ctx.token })).body.data.unread, 0, "unread after read-all");
      assertEqual((await api("GET", "/notifications", { token: ctx.otherToken })).body.data.notifications.length, 0, "other user sees nothing");
    });

    await check("critical notifications are delivered by email", async () => {
      const mail = await waitFor("notification email", () => {
        const all = smtp.allFor(email).filter((message) => /Subject: \[SpareShare\]/.test(message));
        return all.length > 0 ? all : null;
      }, 15000);
      assert(mail.some((message) => /Failover started|Server is unreachable|Device went offline|Deployment failed/.test(message)), "no critical notification email found");
    });

    await check("email notifications can be turned off", async () => {
      const response = await api("PATCH", "/auth/me/notifications", { token: ctx.token, body: { email: false } });
      assertEqual(response.body.data.notificationPreferences.email, false, "preference");
    });

    await check("dashboard summary is computed from stored records", async () => {
      const response = await api("GET", "/dashboard/summary", { token: ctx.token });
      assertEqual(response.status, 200, "status");
      const data = response.body.data;
      const expectedServers = await db().collection("servers").countDocuments({ owner: oid(ctx.userId), isActive: true });
      const expectedDeployments = await db().collection("deployments").countDocuments({});
      assertEqual(data.servers.total, expectedServers, "server count");
      assertEqual(data.deployments.total, expectedDeployments, "deployment count");
      assertEqual(data.devices.total, 4, "device count");
      assert(data.servers.items.find((item) => item.id === ctx.serverId).totalRequests > 0, "per-server request count");
    });

    // ========================================================
    section("16. GitHub webhook");
    // ========================================================

    await check("verifies webhook signatures", async () => {
      const send = (payload, secret, event) => {
        const body = JSON.stringify(payload);
        const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
        return api("POST", "/github/webhook", { body, headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature, "X-GitHub-Event": event, "X-GitHub-Delivery": crypto.randomUUID() } });
      };
      assertEqual((await send({ zen: "x" }, WEBHOOK_SECRET, "ping")).status, 200, "valid ping");
      assertEqual((await send({ zen: "x" }, "wrong-secret", "ping")).status, 401, "invalid signature");
      assertEqual((await api("POST", "/github/webhook", { body: { zen: "x" } })).status, 401, "missing signature");
      const push = await send({ ref: "refs/heads/main", after: "a".repeat(40), repository: { id: 999999 } }, WEBHOOK_SECRET, "push");
      assertEqual(push.status, 200, "push status");
      assert(/0 deployment/.test(push.body.message), `push message: ${push.body.message}`);
    });

    await check("a push to a tracked repository starts an automatic deployment", async () => {
      await db().collection("servers").updateOne({ _id: oid(ctx.serverId) }, { $set: { "repository.repositoryId": 424242, "repository.autoDeploy": true } });
      const payload = JSON.stringify({ ref: "refs/heads/main", after: ctx.commitV1, repository: { id: 424242 } });
      const headers = { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex")}`, "X-GitHub-Event": "push", "X-GitHub-Delivery": "delivery-0001" };
      const first = await api("POST", "/github/webhook", { body: payload, headers });
      assert(/1 deployment/.test(first.body.message), `first delivery: ${first.body.message}`);
      const redelivery = await api("POST", "/github/webhook", { body: payload, headers });
      assert(/0 deployment/.test(redelivery.body.message), `a redelivered webhook must not deploy twice: ${redelivery.body.message}`);
      const latest = (await api("GET", `/server/${ctx.serverId}/deployments?limit=1`, { token: ctx.token })).body.data.deployments[0];
      assertEqual(latest.trigger, "webhook", "trigger");
      const deployment = await waitDeployment(ctx.serverId, latest.deploymentId);
      assertEqual(deployment.status, "running", `status (error: ${deployment.error})`);
      await waitServing(ctx.permanentId, "hello from node-app v1");
    });

    // ========================================================
    section("16b. GitHub sign-in and connected accounts");
    // ========================================================

    if (enabled("github-signin") || ONLY.length === 0) {
      // A stand-in for GitHub. It knows two GitHub people: "alice" can
      // reach installations 501 (alice) and 502 (acme org), "bob" has not
      // installed the app anywhere.
      const http = require("http");
      const APP_ID = "777";
      const fakeInstallations = {
        501: { id: 501, app_id: 777, account: { id: 11, login: "alice" }, target_type: "User", repository_selection: "all", permissions: { contents: "read", metadata: "read" }, suspended_at: null },
        502: { id: 502, app_id: 777, account: { id: 22, login: "acme" }, target_type: "Organization", repository_selection: "selected", permissions: { contents: "read", metadata: "read" }, suspended_at: null },
        900: { id: 900, app_id: 123, account: { id: 33, login: "other-app" }, target_type: "User", repository_selection: "all", permissions: {}, suspended_at: null },
      };
      const fakeRepos = {
        501: [{ id: 1, name: "site", full_name: "alice/site", private: false, default_branch: "main", html_url: "h", clone_url: "c", owner: { login: "alice" } }],
        502: [{ id: 2, name: "api", full_name: "acme/api", private: true, default_branch: "trunk", html_url: "h", clone_url: "c", owner: { login: "acme" } }],
      };
      const gone = new Set();
      const seen = { secrets: [] };

      const fakeGitHub = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const url = new URL(req.url, "http://fake");
          const send = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
          };
          const auth = req.headers.authorization || "";

          if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
            const body = JSON.parse(raw || "{}");
            seen.secrets.push(body.client_secret);
            if (body.code === "code-alice-1") return send(200, { access_token: "user-token-alice" });
            if (body.code === "code-bob-12") return send(200, { access_token: "user-token-bob" });
            return send(200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
          }
          if (url.pathname === "/user") {
            if (auth === "Bearer user-token-alice") return send(200, { id: 11, login: "alice" });
            if (auth === "Bearer user-token-bob") return send(200, { id: 44, login: "bob" });
            return send(401, { message: "Bad credentials" });
          }
          if (url.pathname === "/user/installations") {
            if (auth === "Bearer user-token-alice") return send(200, { total_count: 3, installations: [fakeInstallations[501], fakeInstallations[900], fakeInstallations[502]] });
            if (auth === "Bearer user-token-bob") return send(200, { total_count: 0, installations: [] });
            return send(401, { message: "Bad credentials" });
          }
          const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
          if (req.method === "POST" && tokenMatch) {
            if (gone.has(tokenMatch[1]) || !fakeRepos[tokenMatch[1]]) return send(404, { message: "Not Found" });
            return send(201, { token: `inst-${tokenMatch[1]}`, expires_at: new Date(Date.now() + 3600000).toISOString() });
          }
          if (url.pathname === "/installation/repositories") {
            const id = auth.replace("Bearer inst-", "");
            const list = fakeRepos[id] || [];
            return send(200, { total_count: list.length, repositories: list });
          }
          const detailMatch = /^\/app\/installations\/(\d+)$/.exec(url.pathname);
          if (detailMatch && req.method === "GET") {
            const found = fakeInstallations[detailMatch[1]];
            return found ? send(200, found) : send(404, { message: "Not Found" });
          }
          if (detailMatch && req.method === "DELETE") {
            seen.deleted = detailMatch[1];
            res.writeHead(204);
            return res.end();
          }
          return send(404, { message: `fake GitHub has no ${req.method} ${url.pathname}` });
        });
      });
      const fakePort = await getFreePort();
      await new Promise((resolve) => fakeGitHub.listen(fakePort, "127.0.0.1", resolve));
      const fakeBase = `http://127.0.0.1:${fakePort}`;

      // Put the collection back to how an older database looks, so the
      // start-up migration has something to do.
      await db().collection("githubinstallations").dropIndexes().catch(() => {});
      await db().collection("githubinstallations").createIndex({ installationId: 1 }, { unique: true });

      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const ghPort = await getFreePort();
      const ghBase = `http://127.0.0.1:${ghPort}`;
      const ghApi = createClient(`${ghBase}/api`);
      const ghBackend = startProcess("backend-github", process.execPath, ["server.js"], {
        env: {
          ...backendEnv,
          PORT: String(ghPort),
          SPARESHARE_PUBLIC_BASE_URL: ghBase,
          MONITORING_SCHEDULER_ENABLED: "false",
          GITHUB_APP_ID: APP_ID,
          GITHUB_APP_SLUG: "spareshare-fake",
          GITHUB_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).replace(/\n/g, "\\n"),
          GITHUB_CLIENT_ID: "Iv1.fakeclient",
          GITHUB_CLIENT_SECRET: "fake-client-secret",
          GITHUB_API_BASE_URL: fakeBase,
          GITHUB_WEB_BASE_URL: fakeBase,
        },
        cwd: BACKEND_DIR,
        logFile: path.join(TMP, "backend-github.log"),
      });

      const page = async (route) => {
        const response = await fetch(`${ghBase}/api${route}`, { redirect: "manual" });
        return { status: response.status, location: response.headers.get("location"), text: await response.text() };
      };
      const startFlow = async (token, body) => {
        const response = await ghApi("POST", "/github/install", { token, body });
        assertEqual(response.status, 200, `install status (${JSON.stringify(response.body)})`);
        return { url: new URL(response.body.installationUrl), flow: response.body.flow };
      };

      try {
        await waitFor("GitHub test backend to listen", async () => {
          try {
            return (await fetch(`${ghBase}/healthz`)).status === 200;
          } catch {
            return false;
          }
        }, 30000, 300);

        await check("an old database with a unique installation index is migrated", async () => {
          const indexes = await db().collection("githubinstallations").indexes();
          const single = indexes.find((index) => index.name === "installationId_1");
          assert(single && !single.unique, `installationId index must not be unique: ${JSON.stringify(single)}`);
          assert(indexes.some((index) => index.unique && index.key.userId === 1 && index.key.installationId === 1), "missing unique userId+installationId index");
        });

        await registerUser("Second Person", "second@example.test", "another strong pass");
        const second = await login("second@example.test", "another strong pass");
        ctx.secondToken = second.accessToken || second.tokens?.accessToken || second.token;
        assert(ctx.secondToken, `no access token in login data: ${Object.keys(second)}`);

        await check("Connect GitHub sends the user to GitHub sign-in with a one-time state", async () => {
          const { url, flow } = await startFlow(ctx.token);
          assertEqual(flow, "sign-in", "flow");
          assertEqual(url.origin + url.pathname, `${fakeBase}/login/oauth/authorize`, "authorize URL");
          assertEqual(url.searchParams.get("client_id"), "Iv1.fakeclient", "client id");
          assert(/^[a-f0-9]{64}$/.test(url.searchParams.get("state")), "state format");
          assert(!url.toString().includes("fake-client-secret"), "the client secret must never be in a URL");
          assertEqual(url.searchParams.get("prompt"), null, "no account chooser by default");
          const chooser = await startFlow(ctx.token, { selectAccount: true });
          assertEqual(chooser.url.searchParams.get("prompt"), "select_account", "account chooser");
          assertEqual((await ghApi("POST", "/github/install", {})).status, 401, "needs a signed-in user");
        });

        await check("the callback links every installation the GitHub account can reach", async () => {
          const { url } = await startFlow(ctx.token);
          const state = url.searchParams.get("state");
          const done = await page(`/github/callback?code=code-alice-1&state=${state}`);
          assertEqual(done.status, 200, `callback status: ${done.text.slice(0, 200)}`);
          assert(/GitHub connected/.test(done.text) && /Signed in as alice/.test(done.text), "success page");
          assert(done.text.includes("spareshare://github/connected"), "page offers the way back to the app");
          assert(!done.text.includes("user-token-alice"), "the user token must not reach the page");
          assertEqual(seen.secrets.at(-1), "fake-client-secret", "secret sent to GitHub only");

          const links = await db().collection("githubinstallations").find({ userId: oid(ctx.userId) }).toArray();
          assertEqual(links.map((link) => link.installationId).sort().join(","), "501,502", "linked installations (the other app's installation is ignored)");
          assert(links.every((link) => link.status === "active"), "links are active");
          assert(!JSON.stringify(links).includes("user-token"), "the user token is not stored");

          const replay = await page(`/github/callback?code=code-alice-1&state=${state}`);
          assertEqual(replay.status, 400, "a state works once");
          assert(/expired or was already used/.test(replay.text), "replay message");
        });

        await check("repositories from every connected account are listed", async () => {
          const response = await ghApi("GET", "/github/repositories", { token: ctx.token });
          assertEqual(response.status, 200, `status (${JSON.stringify(response.body)})`);
          assertEqual(response.body.repositories.map((repo) => repo.fullName).sort().join(","), "acme/api,alice/site", "repositories");
          assertEqual(response.body.accounts.map((account) => account.accountLogin).sort().join(","), "acme,alice", "accounts");
          const api2 = response.body.repositories.find((repo) => repo.fullName === "acme/api");
          assertEqual(api2.installationId, 502, "repository carries its installation");
          assertEqual(api2.accountLogin, "acme", "repository carries its account");
          const status = await ghApi("GET", "/github/status", { token: ctx.token });
          assertEqual(status.body.connected, true, "connected");
        });

        await check("a second SpareShare account can connect the same GitHub account", async () => {
          const before = await ghApi("GET", "/github/repositories", { token: ctx.secondToken });
          assertEqual(before.status, 404, "nothing before connecting");
          assertEqual(before.body.code, "GITHUB_NOT_CONNECTED", "code");
          const { url } = await startFlow(ctx.secondToken);
          const done = await page(`/github/callback?code=code-alice-1&state=${url.searchParams.get("state")}`);
          assertEqual(done.status, 200, `callback status: ${done.text.slice(0, 200)}`);
          const after = await ghApi("GET", "/github/repositories", { token: ctx.secondToken });
          assertEqual(after.body.count, 2, "second account sees the repositories");
          const first = await ghApi("GET", "/github/repositories", { token: ctx.token });
          assertEqual(first.body.count, 2, "first account keeps them");
        });

        await check("a GitHub account without the app continues to the install page", async () => {
          const { url } = await startFlow(ctx.token);
          const state = url.searchParams.get("state");
          const hop = await page(`/github/callback?code=code-bob-12&state=${state}`);
          assertEqual(hop.status, 302, `status: ${hop.text.slice(0, 200)}`);
          const next = new URL(hop.location);
          assertEqual(next.origin + next.pathname, `${fakeBase}/apps/spareshare-fake/installations/new`, "install page");
          const nextState = next.searchParams.get("state");
          assert(/^[a-f0-9]{64}$/.test(nextState) && nextState !== state, "a fresh state is issued");
        });

        await check("bad callbacks show a page and link nothing", async () => {
          const count = () => db().collection("githubinstallations").countDocuments({});
          const before = await count();
          const { url } = await startFlow(ctx.token);
          const wrongCode = await page(`/github/callback?code=not-a-real-code&state=${url.searchParams.get("state")}`);
          assertEqual(wrongCode.status, 400, "wrong code");
          assert(/GitHub was not connected/.test(wrongCode.text), "failure page");
          assertEqual((await page(`/github/callback?code=code-alice-1&state=${"0".repeat(64)}`)).status, 400, "unknown state");
          assertEqual((await page("/github/callback?code=code-alice-1&state=short")).status, 400, "malformed state");
          assertEqual((await page("/github/callback?error=access_denied&state=x")).status, 400, "cancelled");
          const script = await page(`/github/callback?code=${encodeURIComponent("<script>alert(1)</script>")}&state=${"0".repeat(64)}`);
          assert(!script.text.includes("<script>alert(1)"), "input is not echoed into the page");
          assertEqual(await count(), before, "nothing was linked");
        });

        await check("the install-only callback cannot take over a linked installation", async () => {
          // A third account with no GitHub sign-in proof tries to claim 501.
          await registerUser("Third Person", "third@example.test", "third strong pass 1");
          const third = await login("third@example.test", "third strong pass 1");
          const thirdToken = third.accessToken || third.tokens?.accessToken || third.token;
          const { url } = await startFlow(thirdToken);
          const claim = await page(`/github/setup?installation_id=501&setup_action=install&state=${url.searchParams.get("state")}`);
          assertEqual(claim.status, 409, `status: ${claim.text.slice(0, 200)}`);
          assertEqual((await ghApi("GET", "/github/repositories", { token: thirdToken })).status, 404, "nothing was linked");
        });

        await check("disconnecting a shared account only removes this user's link", async () => {
          const response = await ghApi("DELETE", "/github/disconnect?installationId=502", { token: ctx.secondToken });
          assertEqual(response.status, 200, `status (${JSON.stringify(response.body)})`);
          assertEqual(seen.deleted, undefined, "the app stays installed on GitHub for the other user");
          const mine = await ghApi("GET", "/github/repositories", { token: ctx.secondToken });
          assertEqual(mine.body.repositories.map((repo) => repo.fullName).join(","), "alice/site", "second account lost acme only");
          const first = await ghApi("GET", "/github/repositories", { token: ctx.token });
          assertEqual(first.body.count, 2, "first account is untouched");
          assertEqual((await ghApi("DELETE", "/github/disconnect?installationId=abc", { token: ctx.token })).status, 400, "bad id");
        });

        await check("an installation removed on GitHub drops out of the list", async () => {
          gone.add("502");
          const response = await ghApi("GET", "/github/repositories", { token: ctx.token });
          assertEqual(response.status, 200, `status (${JSON.stringify(response.body)})`);
          assertEqual(response.body.repositories.map((repo) => repo.fullName).join(","), "alice/site", "only the live account remains");
          const link = await db().collection("githubinstallations").findOne({ userId: oid(ctx.userId), installationId: 502 });
          assertEqual(link.status, "uninstalled", "link marked as removed");
        });
      } finally {
        await ghBackend.stop();
        await new Promise((resolve) => fakeGitHub.close(resolve));
        await db().collection("githubinstallations").deleteMany({});
      }
    }

    // ========================================================
    section("17. Deployment from a real public GitHub repository");
    // ========================================================

    if (enabled("github")) {
      await check("resolves, clones and runs a public GitHub repository", async () => {
        const probe = await fetch("https://api.github.com/repos/heroku/node-js-getting-started", { headers: { "User-Agent": "SpareShare-Tests" }, signal: AbortSignal.timeout(15000) }).catch(() => null);
        if (!probe || !probe.ok) return { skip: `api.github.com is not reachable from here (HTTP ${probe ? probe.status : "error"})` };

        const created = await api("POST", "/server", { token: ctx.token, body: { name: "GitHub App", repository: { repositoryUrl: "https://github.com/heroku/node-js-getting-started" }, deviceId: ctx.deviceB } });
        assertEqual(created.status, 201, `create status (${JSON.stringify(created.body)})`);
        const server = created.body.data.server;
        assertEqual(server.repository.provider, "github", "provider");
        assertEqual(server.repository.fullName, "heroku/node-js-getting-started", "full name");
        assert(server.repository.repositoryId > 0, "repository id was not resolved from GitHub");
        ctx.githubServerId = server._id;

        const queued = await deploy(server._id);
        const deployment = await waitDeployment(server._id, queued.deploymentId, 400000);
        assertEqual(deployment.status, "running", `status (error: ${deployment.error})`);
        assertEqual(deployment.detection.framework, "express", "framework");
        assert(/^[a-f0-9]{40}$/.test(deployment.source.commitSha), "commit SHA");
        const permanentId = created.body.data.permanentUrl.split("/s/")[1];
        await waitFor("the app to answer through the permanent URL", async () => (await through(permanentId, "/")).status === 200, 30000);
      });
    }

    // ========================================================
    section("18. Removal and cleanup");
    // ========================================================

    await check("unassigning a standby removes the app from that device", async () => {
      const response = await api("DELETE", `/server/${ctx.serverId}/devices/${ctx.deviceB}`, { token: ctx.token });
      assertEqual(response.status, 200, `status (${JSON.stringify(response.body)})`);
      await waitFor("device B to delete its copy", () => !fs.existsSync(path.join(agentHome("B"), "apps", ctx.serverId)), 30000);
      const active = await api("DELETE", `/server/${ctx.serverId}/devices/${ctx.deviceA}`, { token: ctx.token });
      assertEqual(active.status, 409, "the active device of a running server cannot be unassigned");
    });

    await check("deleting a server stops it on the device, retires the URL and frees the slug", async () => {
      const pid = JSON.parse((await through(ctx.permanentId, "/env")).text).pid;
      const response = await api("DELETE", `/server/${ctx.serverId}`, { token: ctx.token });
      assertEqual(response.status, 200, "delete status");
      await waitFor("the app process to stop", () => !isPidAlive(pid), 30000);
      await waitFor("the app directory to be removed", () => !fs.existsSync(path.join(agentHome("A"), "apps", ctx.serverId)), 30000);
      assertEqual((await through(ctx.permanentId, "/")).status, 404, "permanent URL after deletion");
      assertEqual((await api("GET", `/server/${ctx.serverId}`, { token: ctx.token })).status, 404, "server after deletion");
      const reuse = await api("POST", "/server", { token: ctx.token, body: { name: "Node App" } });
      assertEqual(reuse.status, 201, "slug reuse");
    });

    await check("no orphaned application processes are left behind", async () => {
      // Every process running from an agent's apps directory must belong
      // to a process group that the agent still tracks.
      await sleep(3000);
      const tracked = new Set();
      for (const name of Object.keys(agents)) {
        for (const entry of Object.values(agentState(name).servers || {})) {
          for (const info of [entry.app, entry.tunnel]) {
            if (info && Number.isInteger(info.pid)) tracked.add(info.pid);
          }
        }
      }
      const orphans = [];
      for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
        let cwd;
        let group;
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
          const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
        } catch {
          continue;
        }
        if (cwd.startsWith(path.join(TMP, "agent-")) && cwd.includes("/apps/") && !tracked.has(group)) {
          orphans.push(`${pid} (group ${group}) in ${cwd.replace(TMP, "")}`);
        }
      }
      assertEqual(orphans.join("; "), "", "orphaned processes");
    });

    await check("a removed device loses agent access", async () => {
      const removed = await api("DELETE", `/devices/${ctx.androidDeviceId}`, { token: ctx.token });
      assertEqual(removed.status, 200, "remove by public id");
      await api("POST", `/server/${ctx.staticServerId}/actions`, { token: ctx.token, body: { action: "stop" } });
      await waitFor("static server to stop", async () => (await overview(ctx.staticServerId)).server.status === "stopped", 30000);
      assertEqual((await api("DELETE", `/devices/${ctx.deviceC}`, { token: ctx.token })).status, 200, "remove device C");
      assertEqual((await api("GET", "/device-agent/config", { token: ctx.agentTokenC })).status, 401, "revoked agent token");
    });

    // ========================================================
    section("19. Agent distribution");
    // ========================================================

    await check("the backend serves the agent bundle with a matching checksum", async () => {
      const meta = await api("GET", "/device-agent/bundle/meta", { token: ctx.agentTokenA });
      assertEqual(meta.status, 200, "meta status");
      assertEqual(meta.body.data.version, "1.0.0", "version");
      const bundle = await fetch(`${base}/api/device-agent/bundle`, { headers: { Authorization: `Bearer ${ctx.agentTokenA}` } });
      const content = Buffer.from(await bundle.arrayBuffer());
      assertEqual(crypto.createHash("sha256").update(content).digest("hex"), meta.body.data.sha256, "checksum");
      assertEqual(content.length, fs.statSync(AGENT_BUNDLE).size, "size");
      assertEqual((await api("GET", "/device-agent/bundle/meta")).status, 401, "bundle requires agent authentication");
    });

    // ========================================================
    section("20. Mobile app service modules against the live API");
    // ========================================================

    // The app's TypeScript service modules are transpiled and run here
    // with the native pieces replaced: the keychain by an in-memory
    // store and NativeBridge.runDebianCommand by a local shell.
    const FRONTEND = path.join(BACKEND_DIR, "..", "frontend");
    const hasFrontend = fs.existsSync(path.join(FRONTEND, "node_modules", "typescript"));
    const keychain = { value: null };
    let refreshCalls = 0;

    const loadAppModule = (() => {
      if (!hasFrontend) return null;
      const ts = require(path.join(FRONTEND, "node_modules", "typescript"));
      const cache = new Map();

      const stubs = {
        "react-native-keychain": {
          setGenericPassword: async (username, password) => { keychain.value = { username, password }; return true; },
          getGenericPassword: async () => keychain.value || false,
          resetGenericPassword: async () => { keychain.value = null; return true; },
        },
        "react-native": {
          NativeModules: {
            NativeBridge: {
              runDebianCommand: async (command) => {
                const result = require("child_process").spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 120000 });
                return { output: `${result.stdout || ""}${result.stderr || ""}`, exitCode: result.status === null ? 1 : result.status };
              },
            },
          },
        },
      };

      const load = (file) => {
        if (cache.has(file)) return cache.get(file).exports;
        const module = { exports: {} };
        cache.set(file, module);
        const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
        }).outputText;
        const localRequire = (name) => {
          if (stubs[name]) return stubs[name];
          if (!name.startsWith(".")) return require(name);
          const resolved = path.resolve(path.dirname(file), `${name}.ts`);
          if (resolved.endsWith(path.join("services", "api.ts"))) return { __esModule: true, default: `${base}/api` };
          // Installs Debian packages on an arm64 phone. Not runnable here.
          if (resolved.endsWith(path.join("services", "bootstrapManager.ts"))) return { ensureRuntimeBootstrap: async () => "skipped" };
          return load(resolved);
        };
        new Function("module", "exports", "require", source)(module, module.exports, localRequire);
        return module.exports;
      };

      return (relative) => load(path.join(FRONTEND, "src", relative));
    })();

    const realFetch = global.fetch;
    global.fetch = (input, init) => {
      if (String(input).endsWith("/auth/refresh")) refreshCalls += 1;
      return realFetch(input, init);
    };

    await check("app client: login stores tokens, expired tokens are refreshed exactly once", async () => {
      if (!hasFrontend) return { skip: "frontend dependencies are not installed" };
      const authApi = loadAppModule("services/auth.api.ts");
      const client = loadAppModule("services/apiClient.ts");

      await authApi.loginWithPassword(email, password, "app-module-test");
      const stored = JSON.parse(keychain.value.password);
      assert(stored.sessionId, "session id was not stored");
      assert(stored.expiresAt - Date.now() < 16 * 60 * 1000, "the access token expiry must be the 15 minute token, not the 30 day session");
      assertEqual((await authApi.getCurrentUser()).email, email, "authenticated call");

      // Corrupt and expire the access token, then fire parallel requests.
      keychain.value.password = JSON.stringify({ ...stored, accessToken: "expired.invalid.token", expiresAt: Date.now() - 1000 });
      loadAppModule("services/authSession.ts"); // same cached module instance
      await loadAppModule("services/authSession.ts").saveTokens({ accessToken: "expired.invalid.token", refreshToken: stored.refreshToken, sessionId: stored.sessionId, accessTokenExpiresAt: Date.now() - 1000 });

      refreshCalls = 0;
      const responses = await Promise.all(Array.from({ length: 6 }, () => client.apiRequest("/auth/me")));
      assert(responses.every((response) => response.data.user.email === email), "a parallel request failed");
      assertEqual(refreshCalls, 1, "refresh requests for six parallel calls");
      ctx.appClient = client;
      ctx.appAuth = authApi;
    });

    await check("app client: a revoked session clears tokens and notifies the app", async () => {
      if (!hasFrontend) return { skip: "frontend dependencies are not installed" };
      let expired = 0;
      ctx.appClient.setSessionExpiredListener(() => { expired += 1; });
      const stored = JSON.parse(keychain.value.password);
      assertEqual((await api("POST", "/auth/logout", { token: stored.accessToken })).status, 200, "server-side revoke");
      let caught = null;
      try { await ctx.appClient.apiRequest("/auth/me"); } catch (error) { caught = error; }
      assert(caught && caught.status === 401, `expected an ApiError with status 401, got ${caught && caught.status}`);
      assertEqual(caught.name, "ApiError", "error type");
      assertEqual(expired, 1, "session-expired notifications");
      assertEqual(keychain.value, null, "tokens must be cleared");
      ctx.appClient.setSessionExpiredListener(null);
    });

    await check("app: KEY=value lines are parsed and validated", async () => {
      if (!hasFrontend) return { skip: "frontend dependencies are not installed" };
      const { parseEnvLines } = loadAppModule("utils/envLines.ts");
      const good = parseEnvLines('# comment\nA=1\n\nB="two words"\nC=\'x=y\'\nD=');
      assertEqual(good.error, null, "error");
      assertEqual(JSON.stringify(good.variables.map((item) => [item.key, item.value])), JSON.stringify([["A", "1"], ["B", "two words"], ["C", "x=y"], ["D", ""]]), "parsed");
      assert(/Line 2/.test(parseEnvLines("A=1\nnot a pair").error), "missing equals sign");
      assert(/reserved/.test(parseEnvLines("SPARESHARE_X=1").error), "reserved prefix");
      assert(/more than once/.test(parseEnvLines("A=1\nA=2").error), "duplicate");
      assert(/Line 1/.test(parseEnvLines("1BAD=x").error), "invalid name");
    });

    await check("app client: network failures become a clear ApiError", async () => {
      if (!hasFrontend) return { skip: "frontend dependencies are not installed" };
      global.fetch = () => Promise.reject(new TypeError("Network request failed"));
      let caught = null;
      try { await ctx.appClient.apiRequest("/auth/me", { auth: false }); } catch (error) { caught = error; } finally { global.fetch = realFetch; }
      assertEqual(caught && caught.code, "NETWORK_ERROR", "error code");
    });

    await check("app agent manager: installs, verifies, configures, starts and stops the agent", async () => {
      if (!hasFrontend) return { skip: "frontend dependencies are not installed" };
      if (typeof process.getuid !== "function" || process.getuid() !== 0) return { skip: "needs root: the app installs the agent under /root/spareshare" };
      if (fs.existsSync("/root/spareshare")) return { skip: "/root/spareshare already exists on this machine" };

      const manager = loadAppModule("services/agentManager.ts");
      await ctx.appAuth.loginWithPassword(email, password, "app-module-test");
      const created = await api("POST", "/devices", { token: ctx.token, body: { name: "App Managed Device" } });
      const deviceId = created.body.data.device.id;

      try {
        const before = await manager.getAgentStatus();
        assertEqual(before.installed, false, "installed before");

        const status = await manager.ensureAgentRunning(deviceId);
        assertEqual(status.installed, true, "installed");
        assertEqual(status.configured, true, "configured");
        assertEqual(status.running, true, "running");
        assertEqual(status.version, "1.0.0", "version");

        const installed = crypto.createHash("sha256").update(fs.readFileSync("/root/spareshare/spareshare-agent.js")).digest("hex");
        const expected = crypto.createHash("sha256").update(fs.readFileSync(AGENT_BUNDLE)).digest("hex");
        assertEqual(installed, expected, "installed agent checksum");
        assertEqual((fs.statSync("/root/spareshare/agent.json").mode & 0o777).toString(8), "600", "config file mode");

        await waitFor("the app-managed device to report online", async () =>
          (await api("GET", `/devices/${deviceId}`, { token: ctx.token })).body.data.device.status === "online", 30000);

        // A second call is a no-op: same process, no new token.
        const pid = JSON.parse(fs.readFileSync("/root/spareshare/agent.pid", "utf8")).pid;
        await manager.ensureAgentRunning(deviceId);
        assertEqual(JSON.parse(fs.readFileSync("/root/spareshare/agent.pid", "utf8")).pid, pid, "agent must not be restarted");

        await manager.stopAgent();
        await waitFor("the agent to stop", async () => !(await manager.getAgentStatus()).running, 15000);
      } finally {
        await loadAppModule("services/agentManager.ts").stopAgent().catch(() => {});
        await sleep(500);
        fs.rmSync("/root/spareshare", { recursive: true, force: true });
        global.fetch = realFetch;
      }
    });

    global.fetch = realFetch;

    await check("the backend shuts down cleanly on SIGTERM", async () => {
      await backend.stop("SIGTERM");
      assert(/HTTP server closed|Shutting down/.test(backend.tail(20)), `shutdown log missing: ${backend.tail(5)}`);
    });
  } finally {
    const failed = results.filter((item) => item.status === "FAIL");
    if (failed.length > 0 && backend) {
      console.log("\n--- backend log (tail) ---\n" + backend.tail(40));
      for (const [name, agent] of Object.entries(agents)) console.log(`\n--- agent ${name} log (tail) ---\n${agent.tail(25)}`);
    }
    await cleanup();
  }

  const count = (status) => results.filter((item) => item.status === status).length;
  console.log(`\n${"=".repeat(60)}\nRESULT: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped (${results.length} checks)`);
  for (const item of results.filter((entry) => entry.status !== "PASS")) {
    console.log(`  ${item.status}  [${item.section}] ${item.name}: ${item.detail}`);
  }

  fs.writeFileSync(path.join(BACKEND_DIR, "tests", "last-results.json"), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  process.exit(count("FAIL") > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error("Test run crashed:", error);
  process.exit(2);
});
