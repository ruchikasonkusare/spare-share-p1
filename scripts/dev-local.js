// Local development runner. Needs no MongoDB account and no mail account.
//
//   npm run dev:local
//
// It starts a private MongoDB replica set on this computer, keeps its data in
// backend/.devdata, starts a mail catcher that prints every mail (and the
// login code inside it) in this window, then starts the normal backend.
//
// Not for production. Mail never leaves this computer.
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, ".devdata");
const MONGO_DIR = path.join(DATA_DIR, "mongo");
const MONGO_PORT = Number(process.env.DEV_MONGO_PORT || 27027);
const MAIL_PORT = Number(process.env.DEV_MAIL_PORT || 2525);

const decodeQuotedPrintable = (data) =>
  data
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

const printMail = (to, raw) => {
  const subjectMatch = raw.match(/^Subject:\s*(.*)$/im);
  const body = decodeQuotedPrintable(raw.slice(raw.indexOf("\r\n\r\n") + 4))
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
  const code = body.match(/(?<![#\d])\d{6}(?!\d)/);

  console.log("");
  console.log("==================== MAIL ====================");
  console.log(`To:      ${to.join(", ")}`);
  console.log(`Subject: ${subjectMatch ? subjectMatch[1] : "(none)"}`);
  if (code) console.log(`CODE:    ${code[0]}`);
  console.log("==============================================");
  console.log("");
};

const startMailCatcher = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = "";
      let inData = false;
      let recipients = [];
      let authStage = 0;

      socket.setEncoding("utf8");
      socket.write("220 dev-mail ESMTP\r\n");
      socket.on("error", () => {});

      socket.on("data", (chunk) => {
        buffer += chunk;

        while (true) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            printMail(recipients, buffer.slice(0, end));
            buffer = buffer.slice(end + 5);
            inData = false;
            recipients = [];
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
            socket.write("250-dev-mail\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
          } else if (upper.startsWith("AUTH PLAIN")) {
            socket.write("235 ok\r\n");
          } else if (upper.startsWith("AUTH LOGIN")) {
            authStage = 2;
            socket.write("334 VXNlcm5hbWU6\r\n");
          } else if (upper.startsWith("RCPT TO")) {
            recipients.push(line.slice(8).replace(/[<>\s]/g, "").toLowerCase());
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
    });

    server.once("error", reject);
    server.listen(MAIL_PORT, "127.0.0.1", () => resolve(server));
  });

const main = async () => {
  let MongoMemoryReplSet;
  try {
    ({ MongoMemoryReplSet } = require("mongodb-memory-server"));
  } catch {
    console.error("mongodb-memory-server is missing. Run: npm install");
    process.exit(1);
  }

  fs.mkdirSync(MONGO_DIR, { recursive: true });

  console.log("[dev] Starting local MongoDB. The first run downloads MongoDB and can take a few minutes.");
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger", name: "sparesharedev" },
    instanceOpts: [{ port: MONGO_PORT, dbPath: MONGO_DIR }],
  });
  console.log(`[dev] MongoDB ready on port ${MONGO_PORT}. Data folder: ${MONGO_DIR}`);

  await startMailCatcher();
  console.log(`[dev] Mail catcher ready on port ${MAIL_PORT}. Login codes are printed in this window.`);

  const port = process.env.DEV_PORT || "5000";

  // Set before the backend loads .env. Values already in the environment win.
  Object.assign(process.env, {
    NODE_ENV: "development",
    PORT: port,
    MONGO_URI: replSet.getUri("spare-share-dev"),
    MAIL_CONFIG: "smtp",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(MAIL_PORT),
    SMTP_USER: "dev",
    SMTP_PASSWORD: "dev",
    EMAIL_FROM: "SpareShare Dev <dev@localhost>",
    SPARESHARE_PUBLIC_BASE_URL: process.env.DEV_PUBLIC_BASE_URL || `http://localhost:${port}`,
    BACKUP_STORAGE_DRIVER: "local",
    BACKUP_LOCAL_DIR: path.join(DATA_DIR, "backups"),
    MONITORING_SCHEDULER_ENABLED: process.env.MONITORING_SCHEDULER_ENABLED || "true",
  });

  const stop = async () => {
    try {
      await replSet.stop({ doCleanup: false });
    } catch {
      // The process is ending anyway.
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  process.chdir(ROOT);
  require(path.join(ROOT, "server.js"));
};

main().catch((error) => {
  console.error("[dev] Could not start:", error.message);
  process.exit(1);
});
