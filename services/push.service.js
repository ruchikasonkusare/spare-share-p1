const jwt = require("jsonwebtoken");

// Firebase Cloud Messaging (HTTP v1). Requires a Firebase service account:
// FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY.
let cachedAccessToken = null;

const isPushConfigured = () =>
  Boolean(process.env.FCM_PROJECT_ID && process.env.FCM_CLIENT_EMAIL && process.env.FCM_PRIVATE_KEY);

const getAccessToken = async () => {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) {
    return cachedAccessToken.token;
  }

  const now = Math.floor(Date.now() / 1000);

  const assertion = jwt.sign(
    {
      iss: process.env.FCM_CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    process.env.FCM_PRIVATE_KEY.replace(/\\n/g, "\n"),
    { algorithm: "RS256" }
  );

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || `FCM token exchange failed (HTTP ${response.status}).`);
  }

  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };

  return cachedAccessToken.token;
};

// Returns { sent, invalidToken }. invalidToken tells the caller to forget
// a token FCM reports as unregistered.
const sendPush = async ({ token, title, body, data = {} }) => {
  if (!isPushConfigured()) {
    throw new Error("Push notifications are not configured.");
  }

  const accessToken = await getAccessToken();

  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) stringData[key] = String(value);
  }

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(process.env.FCM_PROJECT_ID)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: stringData,
          android: { priority: "high" },
        },
      }),
      signal: AbortSignal.timeout(15000),
    }
  );

  if (response.ok) return { sent: true, invalidToken: false };

  const failure = await response.json().catch(() => ({}));
  const status = failure.error && failure.error.status;

  if (response.status === 404 || status === "UNREGISTERED") {
    return { sent: false, invalidToken: true };
  }

  throw new Error((failure.error && failure.error.message) || `FCM send failed (HTTP ${response.status}).`);
};

module.exports = { isPushConfigured, sendPush };
