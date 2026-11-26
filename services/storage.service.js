const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");

const { createError } = require("../utils/errors");

// Object storage for runtime archives and backups.
//
// The S3 client is created on first use. The API must start, and every
// feature that does not need object storage must work, when the B2/S3
// variables are absent.
const REQUIRED_S3_ENV = [
  "B2_REGION",
  "B2_ENDPOINT",
  "B2_ACCESS_KEY_ID",
  "B2_SECRET_ACCESS_KEY",
  "B2_BUCKET_NAME",
];

let s3Client = null;

const isS3Configured = () => REQUIRED_S3_ENV.every((name) => Boolean(process.env[name]));

const getS3 = () => {
  const missing = REQUIRED_S3_ENV.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw createError(
      `Object storage is not configured. Missing: ${missing.join(", ")}.`,
      503,
      "STORAGE_NOT_CONFIGURED"
    );
  }

  if (!s3Client) {
    const { S3Client } = require("@aws-sdk/client-s3");
    s3Client = new S3Client({
      region: process.env.B2_REGION,
      endpoint: process.env.B2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.B2_ACCESS_KEY_ID,
        secretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
      },
    });
  }

  return s3Client;
};

const backupBucket = () => process.env.B2_BACKUP_BUCKET_NAME || process.env.B2_BUCKET_NAME;

const generateDownloadUrl = async ({ objectKey, filename, expiresIn = 900, bucket }) => {
  if (!objectKey) throw new Error("Object key is required.");

  const { GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

  const command = new GetObjectCommand({
    Bucket: bucket || process.env.B2_BUCKET_NAME,
    Key: objectKey,
    ...(filename
      ? { ResponseContentDisposition: `attachment; filename="${String(filename).replace(/"/g, "")}"` }
      : {}),
  });

  return getSignedUrl(getS3(), command, { expiresIn });
};

const generateUploadUrl = async ({ objectKey, expiresIn = 3600, bucket }) => {
  const { PutObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

  const command = new PutObjectCommand({
    Bucket: bucket || process.env.B2_BUCKET_NAME,
    Key: objectKey,
    ContentType: "application/gzip",
  });

  return getSignedUrl(getS3(), command, { expiresIn });
};

const getObjectSize = async ({ objectKey, bucket }) => {
  const { HeadObjectCommand } = require("@aws-sdk/client-s3");
  const result = await getS3().send(
    new HeadObjectCommand({ Bucket: bucket || process.env.B2_BUCKET_NAME, Key: objectKey })
  );
  return Number(result.ContentLength || 0);
};

const deleteObject = async ({ objectKey, bucket }) => {
  const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
  await getS3().send(
    new DeleteObjectCommand({ Bucket: bucket || process.env.B2_BUCKET_NAME, Key: objectKey })
  );
};

// ------------------------------------------------------------
// Local driver: backups are stored on the API server's disk.
// Suitable for a single instance with a persistent volume.
// ------------------------------------------------------------

const localRoot = () =>
  path.resolve(process.env.BACKUP_LOCAL_DIR || path.join(__dirname, "..", "storage", "backups"));

const resolveLocalPath = (key) => {
  const root = localRoot();
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw createError("Invalid storage key.", 400, "INVALID_STORAGE_KEY");
  }
  return resolved;
};

// Streams an upload to disk with a hard size cap, returning size and hash.
const writeLocalObject = async ({ key, stream, maxBytes }) => {
  const target = resolveLocalPath(key);
  const temporary = `${target}.${crypto.randomBytes(6).toString("hex")}.part`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;

  const meter = new Transform({
    transform(chunk, encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        return callback(createError("Backup exceeds the maximum allowed size.", 413, "BACKUP_TOO_LARGE"));
      }
      hash.update(chunk);
      return callback(null, chunk);
    },
  });

  try {
    await pipeline(stream, meter, fs.createWriteStream(temporary, { mode: 0o600 }));
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }

  return { sizeBytes, sha256: hash.digest("hex") };
};

const openLocalObject = async (key) => {
  const target = resolveLocalPath(key);
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw createError("Stored object was not found.", 404, "STORED_OBJECT_NOT_FOUND");
  }
  return { stream: fs.createReadStream(target), sizeBytes: stat.size };
};

const deleteLocalObject = async (key) => {
  await fs.promises.rm(resolveLocalPath(key), { force: true });
};

module.exports = {
  isS3Configured,
  backupBucket,
  generateDownloadUrl,
  generateUploadUrl,
  getObjectSize,
  deleteObject,
  writeLocalObject,
  openLocalObject,
  deleteLocalObject,
};
