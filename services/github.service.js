const jwt = require("jsonwebtoken");

const API_VERSION = "2026-03-10";

// GitHub addresses. They only change in the tests, which point them at a
// local stand-in for GitHub.
const API_BASE = (process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/+$/, "");
const WEB_BASE = (process.env.GITHUB_WEB_BASE_URL || "https://github.com").replace(/\/+$/, "");

const createAppJwt = () => {
  const appId = process.env.GITHUB_APP_ID;
  const rawPrivateKey = process.env.GITHUB_PRIVATE_KEY;

  if (!appId || !rawPrivateKey) {
    const error = new Error("GitHub App configuration is missing.");
    error.statusCode = 500;
    error.code = "GITHUB_CONFIG_MISSING";
    throw error;
  }

  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iat: now - 60,
      exp: now + 8 * 60,
      iss: appId,
    },
    privateKey,
    { algorithm: "RS256" }
  );
};

const createInstallationToken = async (
  installationId,
  repositoryIds
) => {
  const appJwt = createAppJwt();

  const body = {
    permissions: {
      contents: "read",
      metadata: "read",
    },
  };

  // Optionally restrict the token to specific repository IDs.
  if (repositoryIds?.length) {
    body.repository_ids = repositoryIds;
  }

  const response = await fetch(
    `${API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.message || "Failed to create GitHub installation token."
    );
    error.statusCode = response.status === 404 ? 404 : 502;
    error.code = "GITHUB_TOKEN_CREATION_FAILED";
    throw error;
  }

  return {
    token: data.token,
    expiresAt: data.expires_at,
  };
};

const listInstallationRepositories = async (installationId) => {
  const { token } = await createInstallationToken(installationId);

  const repositories = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `${API_BASE}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(
        data.message || "Failed to fetch GitHub repositories."
      );
      error.statusCode = 502;
      error.code = "GITHUB_REPOSITORIES_FETCH_FAILED";
      throw error;
    }

    repositories.push(
      ...data.repositories.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        owner: repo.owner.login,
      }))
    );

    if (repositories.length >= data.total_count) break;
    page++;
  }

  return repositories;
};



const getInstallationDetails = async (installationId) => {
  const appJwt = createAppJwt();

  const response = await fetch(
    `${API_BASE}/app/installations/${installationId}`,
    {
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
      },
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(
      data.message || "Failed to verify GitHub installation."
    );

    error.statusCode = response.status === 404 ? 400 : 502;
    error.code = "GITHUB_INSTALLATION_VERIFICATION_FAILED";

    throw error;
  }

  if (String(data.app_id) !== String(process.env.GITHUB_APP_ID)) {
    const error = new Error(
      "Installation does not belong to the configured GitHub App."
    );

    error.statusCode = 400;
    error.code = "GITHUB_APP_MISMATCH";

    throw error;
  }

  return {
    installationId: data.id,
    accountId: data.account?.id,
    accountLogin: data.account?.login,
    accountType: data.target_type,
    repositorySelection: data.repository_selection,
    permissions: {
      contents: data.permissions?.contents || "read",
      metadata: data.permissions?.metadata || "read",
    },
    suspendedAt: data.suspended_at || null,
  };
};


const uninstallGitHubInstallation = async (installationId) => {
  const appJwt = createAppJwt();

  const response = await fetch(
    `${API_BASE}/app/installations/${installationId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
      },
    }
  );

  // GitHub returns 204 No Content on successful uninstallation.
  if (response.status === 204) {
    return true;
  }

  const data = await response.json().catch(() => ({}));

  const error = new Error(
    data.message || "Failed to uninstall GitHub App installation."
  );

  error.statusCode = response.status === 404 ? 404 : 502;
  error.code = "GITHUB_UNINSTALL_FAILED";

  throw error;
};


const isGitHubAppConfigured = () =>
  Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY);

const mapRepository = (repo) => ({
  id: repo.id,
  name: repo.name,
  fullName: repo.full_name,
  private: Boolean(repo.private),
  defaultBranch: repo.default_branch,
  htmlUrl: repo.html_url,
  cloneUrl: repo.clone_url,
  owner: repo.owner?.login,
});

// Look up one repository through an installation. Returns null when the
// installation cannot see it.
const getInstallationRepository = async (installationId, fullName) => {
  const { token } = await createInstallationToken(installationId);

  const response = await fetch(`${API_BASE}/repos/${fullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 404 || response.status === 403) return null;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Failed to fetch the GitHub repository.");
    error.statusCode = 502;
    error.code = "GITHUB_REPOSITORY_FETCH_FAILED";
    throw error;
  }

  return mapRepository(data);
};

// Look up a public repository without credentials.
const getPublicRepository = async (fullName) => {
  const response = await fetch(`${API_BASE}/repos/${fullName}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "SpareShare",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 404) return null;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Failed to fetch the GitHub repository.");
    error.statusCode = 502;
    error.code = "GITHUB_REPOSITORY_FETCH_FAILED";
    throw error;
  }

  return data.private ? null : mapRepository(data);
};

// Short-lived, read-only token limited to one repository. Handed to an
// authenticated device agent for a single clone and never stored.
const createRepositoryCloneToken = async (installationId, repositoryId) => {
  return createInstallationToken(installationId, [repositoryId]);
};

// ---------------------------------------------------------------
// GitHub sign-in (user authorisation)
//
// Installing the app proves nothing about who is at the keyboard, and
// GitHub does not send the user back when the app is already installed.
// Signing in does both: GitHub always returns to us, and the user token
// lists exactly the installations that person can reach. The token is
// used once and never stored.
// ---------------------------------------------------------------

const isGitHubSignInConfigured = () =>
  Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

const githubError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const buildAuthorizeUrl = (state, { selectAccount = false } = {}) => {
  const url = new URL(`${WEB_BASE}/login/oauth/authorize`);
  url.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
  url.searchParams.set("state", state);
  // Lets the person choose which GitHub account to use when the browser
  // is already signed in to one.
  if (selectAccount) url.searchParams.set("prompt", "select_account");
  return url.toString();
};

const buildInstallUrl = (state) => {
  const url = new URL(
    `${WEB_BASE}/apps/${encodeURIComponent(process.env.GITHUB_APP_SLUG)}/installations/new`
  );
  url.searchParams.set("state", state);
  return url.toString();
};

const exchangeCodeForUserToken = async (code) => {
  const response = await fetch(`${WEB_BASE}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw githubError(
      data.error_description || "GitHub did not accept the sign-in. Please try again.",
      400,
      "GITHUB_SIGN_IN_FAILED"
    );
  }

  return data.access_token;
};

const userHeaders = (userToken) => ({
  Authorization: `Bearer ${userToken}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": API_VERSION,
});

const getGitHubUser = async (userToken) => {
  const response = await fetch(`${API_BASE}/user`, { headers: userHeaders(userToken) });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.login) {
    throw githubError("GitHub did not return the signed-in account.", 502, "GITHUB_USER_FETCH_FAILED");
  }

  return { id: data.id, login: data.login };
};

// Installations of this app that the signed-in GitHub user can reach.
const listUserInstallations = async (userToken) => {
  const installations = [];
  let page = 1;

  while (page <= 10) {
    const response = await fetch(
      `${API_BASE}/user/installations?per_page=100&page=${page}`,
      { headers: userHeaders(userToken) }
    );
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !Array.isArray(data.installations)) {
      throw githubError(
        data.message || "GitHub did not return the installations for this account.",
        502,
        "GITHUB_INSTALLATIONS_FETCH_FAILED"
      );
    }

    for (const item of data.installations) {
      if (String(item.app_id) !== String(process.env.GITHUB_APP_ID)) continue;
      installations.push({
        installationId: item.id,
        accountId: item.account?.id,
        accountLogin: item.account?.login,
        accountType: item.target_type,
        repositorySelection: item.repository_selection,
        permissions: {
          contents: item.permissions?.contents || "read",
          metadata: item.permissions?.metadata || "read",
        },
        suspendedAt: item.suspended_at || null,
      });
    }

    if (data.installations.length < 100) break;
    page++;
  }

  return installations;
};


module.exports = {
  isGitHubSignInConfigured,
  buildAuthorizeUrl,
  buildInstallUrl,
  exchangeCodeForUserToken,
  getGitHubUser,
  listUserInstallations,
  isGitHubAppConfigured,
  getInstallationRepository,
  getPublicRepository,
  createRepositoryCloneToken,
  createAppJwt,
  createInstallationToken,
  listInstallationRepositories,
  getInstallationDetails,
  uninstallGitHubInstallation,
};
