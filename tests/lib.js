// Test support: an SMTP sink, a Git remote served over HTTP, process
// helpers and a tiny assertion harness. Nothing here is loaded by the
// application.
const fs = require("fs");
const net = require("net");
const http = require("http");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// ------------------------------------------------------------
// Results
// ------------------------------------------------------------

const results = [];
let currentSection = "";

const section = (name) => {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
};

const check = async (name, fn) => {
  const started = Date.now();
  try {
    const outcome = await fn();
    if (outcome && outcome.skip) {
      results.push({ section: currentSection, name, status: "SKIP", detail: outcome.skip });
      console.log(`  SKIP  ${name} (${outcome.skip})`);
      return false;
    }
    results.push({ section: currentSection, name, status: "PASS", ms: Date.now() - started });
    console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
    return true;
  } catch (error) {
    results.push({ section: currentSection, name, status: "FAIL", detail: error.message });
    console.log(`  FAIL  ${name}\n        ${String(error.message).split("\n").join("\n        ")}`);
    return false;
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message || "Assertion failed");
};

const assertEqual = (actual, expected, label = "value") => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const waitFor = async (description, fn, timeoutMs = 30000, intervalMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}${lastError ? ` (${lastError.message})` : ""}`);
};

// ------------------------------------------------------------
// SMTP sink: accepts mail over real SMTP and keeps it in memory.
// ------------------------------------------------------------

const startSmtpSink = async () => {
  const messages = [];
  const port = await getFreePort();

  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { to: [], data: "" };
    let authStage = 0;

    socket.setEncoding("utf8");
    socket.write("220 sink ESMTP\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk;

      while (true) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(current);
          current = { to: [], data: "" };
          socket.write("250 queued\r\n");
          continue;
        }

        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const upper = line.toUpperCase();

        if (authStage > 0) {
          authStage -= 1;
          socket.write(authStage > 0 ? "334 UGFzc3dvcmQ6\r\n" : "235 ok\r\n");
        } else if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          socket.write("250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
        } else if (upper.startsWith("AUTH PLAIN")) {
          socket.write("235 ok\r\n");
        } else if (upper.startsWith("AUTH LOGIN")) {
          authStage = 2;
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (upper.startsWith("MAIL FROM")) {
          socket.write("250 ok\r\n");
        } else if (upper.startsWith("RCPT TO")) {
          current.to.push(line.slice(8).replace(/[<>\s]/g, "").toLowerCase());
          socket.write("250 ok\r\n");
        } else if (upper === "DATA") {
          inData = true;
          socket.write("354 go\r\n");
        } else if (upper === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });

    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  // Undo quoted-printable so the body can be searched.
  const decode = (data) =>
    data.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return {
    port,
    messages,
    latestFor: (email) => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].to.includes(email.toLowerCase())) return decode(messages[index].data);
      }
      return null;
    },
    allFor: (email) =>
      messages.filter((message) => message.to.includes(email.toLowerCase())).map((message) => decode(message.data)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

// ------------------------------------------------------------
// Git remote: bare repositories served over plain HTTP.
// ------------------------------------------------------------

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "SpareShare Tests",
      GIT_AUTHOR_EMAIL: "tests@spareshare.invalid",
      GIT_COMMITTER_NAME: "SpareShare Tests",
      GIT_COMMITTER_EMAIL: "tests@spareshare.invalid",
    },
  }).toString().trim();

const createGitRemote = async (root) => {
  const workRoot = path.join(root, "work");
  const bareRoot = path.join(root, "remotes");
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(bareRoot, { recursive: true });

  const port = await getFreePort();

  const server = http.createServer((req, res) => {
    const target = path.resolve(bareRoot, `.${decodeURIComponent(req.url.split("?")[0])}`);
    if (!target.startsWith(bareRoot + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.stat(target, (error, stat) => {
      if (error || !stat.isFile()) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Length": stat.size });
      return fs.createReadStream(target).pipe(res);
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const publish = (name) => {
    const work = path.join(workRoot, name);
    const bare = path.join(bareRoot, `${name}.git`);
    fs.rmSync(bare, { recursive: true, force: true });
    git(workRoot, "clone", "--quiet", "--bare", work, bare);
    git(bare, "update-server-info");
  };

  // Write files, commit and publish. Returns the commit SHA.
  const commit = (name, files, message) => {
    const work = path.join(workRoot, name);
    const isNew = !fs.existsSync(work);
    if (isNew) {
      fs.mkdirSync(work, { recursive: true });
      git(work, "init", "--quiet", "--initial-branch=main");
    }
    for (const [file, content] of Object.entries(files)) {
      const destination = path.join(work, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", message);
    publish(name);
    return git(work, "rev-parse", "HEAD");
  };

  return {
    url: (name) => `http://127.0.0.1:${port}/${name}.git`,
    commit,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

// ------------------------------------------------------------
// Child processes
// ------------------------------------------------------------

const startProcess = (name, command, args, { env, cwd, logFile }) => {
  const output = fs.openSync(logFile, "a");
  const child = spawn(command, args, { env, cwd, stdio: ["ignore", output, output] });
  fs.closeSync(output);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  return {
    name,
    child,
    pid: child.pid,
    logFile,
    isRunning: () => !exited,
    tail: (lines = 30) => {
      try {
        return fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-lines).join("\n");
      } catch {
        return "";
      }
    },
    stop: async (signal = "SIGTERM") => {
      if (exited) return;
      child.kill(signal);
      const deadline = Date.now() + 8000;
      while (!exited && Date.now() < deadline) await sleep(100);
      if (!exited) child.kill("SIGKILL");
    },
  };
};

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    // A zombie still answers signal 0.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
};

// ------------------------------------------------------------
// HTTP client
// ------------------------------------------------------------

const createClient = (baseUrl) => async (method, route, { token, body, headers = {}, raw = false } = {}) => {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body !== undefined && typeof body !== "string" ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const text = await response.text();
  let parsed = text;
  if (!raw) {
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
  }

  return { status: response.status, body: parsed, headers: response.headers, text };
};

module.exports = {
  sleep,
  getFreePort,
  results,
  section,
  check,
  assert,
  assertEqual,
  waitFor,
  startSmtpSink,
  createGitRemote,
  startProcess,
  isPidAlive,
  createClient,
};
