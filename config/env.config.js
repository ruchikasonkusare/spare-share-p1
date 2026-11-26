// Central environment validation. Called once at startup so a bad
// configuration fails loudly instead of at the first request.
const PLACEHOLDER_SECRETS = new Set([
  "your-super-secret-jwt-key",
  "your-super-secret-refresh-key",
  "changeme",
  "secret",
]);

const validateEnvironment = () => {
  const errors = [];
  const warnings = [];
  const isProduction = process.env.NODE_ENV === "production";

  if (!process.env.MONGO_URI) errors.push("MONGO_URI is required.");

  const jwtSecret = process.env.JWT_SECRET || "";
  if (!jwtSecret) {
    errors.push("JWT_SECRET is required.");
  } else if (PLACEHOLDER_SECRETS.has(jwtSecret) || jwtSecret.length < 32) {
    (isProduction ? errors : warnings).push(
      "JWT_SECRET must be a random value of at least 32 characters."
    );
  }

  if (!/^[a-f0-9]{64}$/i.test(process.env.ENV_ENCRYPTION_KEY || "")) {
    (isProduction ? errors : warnings).push(
      "ENV_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Environment variables cannot be stored without it."
    );
  }

  const baseUrl = process.env.SPARESHARE_PUBLIC_BASE_URL;
  if (!baseUrl) {
    errors.push("SPARESHARE_PUBLIC_BASE_URL is required for permanent URLs.");
  } else {
    try {
      const parsed = new URL(baseUrl);
      if (isProduction && parsed.protocol !== "https:") {
        errors.push("SPARESHARE_PUBLIC_BASE_URL must use HTTPS in production.");
      }
    } catch {
      errors.push("SPARESHARE_PUBLIC_BASE_URL is not a valid URL.");
    }
  }

  if (isProduction && process.env.ALLOW_PRIVATE_DESTINATIONS === "true") {
    warnings.push("ALLOW_PRIVATE_DESTINATIONS is ignored in production.");
  }

  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
    warnings.push("GitHub App is not configured. Only public repositories by URL can be deployed.");
  }

  if (
    process.env.GITHUB_APP_ID &&
    Boolean(process.env.GITHUB_CLIENT_ID) !== Boolean(process.env.GITHUB_CLIENT_SECRET)
  ) {
    warnings.push("GitHub sign-in needs both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET. It stays off until both are set.");
  } else if (process.env.GITHUB_APP_ID && !process.env.GITHUB_CLIENT_ID) {
    warnings.push("GitHub sign-in is not configured. Connect GitHub only returns to SpareShare after a fresh installation.");
  }

  const driver = (process.env.BACKUP_STORAGE_DRIVER || "local").toLowerCase();
  if (!["local", "s3"].includes(driver)) {
    errors.push('BACKUP_STORAGE_DRIVER must be "local" or "s3".');
  }

  for (const warning of warnings) console.warn(`[SpareShare Config] WARNING: ${warning}`);

  if (errors.length > 0) {
    const error = new Error(`Invalid configuration:\n - ${errors.join("\n - ")}`);
    error.code = "INVALID_CONFIGURATION";
    throw error;
  }
};

module.exports = { validateEnvironment };
