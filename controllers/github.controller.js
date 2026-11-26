const crypto = require("crypto");

const GitHubOAuthState = require("../models/githubOAuthState.model");
const GitHubInstallation = require("../models/githubInstallation.model");
const Server = require("../models/server.model");
const { createDeployment } = require("../services/deployment.service");

const {
  getInstallationDetails,
  listInstallationRepositories,
  uninstallGitHubInstallation,
  isGitHubSignInConfigured,
  buildAuthorizeUrl,
  buildInstallUrl,
  exchangeCodeForUserToken,
  getGitHubUser,
  listUserInstallations,
} = require("../services/github.service");

const createError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};


const MOBILE_DEEP_LINK = "spareshare://github/connected";

const hashState = (state) =>
  crypto.createHash("sha256").update(state).digest("hex");

const issueState = async (userId) => {
  const state = GitHubOAuthState.generateState();
  await GitHubOAuthState.create({
    stateHash: hashState(state),
    userId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return state;
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

// The page GitHub lands on is opened in the phone's browser, so the
// outcome is shown as a page, not as JSON.
const sendResultPage = (res, { ok, title, lines, statusCode = 200 }) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });

  const paragraphs = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const opener = ok
    ? `<a class="button" href="${MOBILE_DEEP_LINK}">Open SpareShare</a>
       <script>
         window.addEventListener("load", function () {
           setTimeout(function () { window.location.href = "${MOBILE_DEEP_LINK}"; }, 400);
         });
       </script>`
    : "";

  return res.status(statusCode).type("html").send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(title)} | SpareShare</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; background: #f5f7fb; font-family: Arial, sans-serif; color: #172033; }
      .container { width: 100%; max-width: 420px; padding: 36px 26px; background: white; border-radius: 18px; text-align: center; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06); }
      .mark { width: 64px; height: 64px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 34px; }
      .ok { background: #dcfce7; color: #15803d; }
      .bad { background: #fee2e2; color: #b91c1c; }
      h1 { font-size: 24px; margin-bottom: 12px; }
      p { color: #64748b; line-height: 1.6; font-size: 15px; }
      .button { display: block; margin-top: 25px; padding: 15px; border-radius: 10px; background: #172554; color: white; text-decoration: none; font-weight: bold; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="mark ${ok ? "ok" : "bad"}">${ok ? "&#10003;" : "!"}</div>
      <h1>${escapeHtml(title)}</h1>
      ${paragraphs}
      ${opener}
    </div>
  </body>
</html>`);
};

const sendFailurePage = (res, error) =>
  sendResultPage(res, {
    ok: false,
    title: "GitHub was not connected",
    lines: [
      error.statusCode && error.statusCode < 500
        ? error.message
        : "Something went wrong while talking to GitHub.",
      "Go back to the SpareShare app and press Connect GitHub again.",
    ],
    statusCode: error.statusCode && error.statusCode < 500 ? error.statusCode : 502,
  });

const saveInstallationLink = (userId, details) =>
  GitHubInstallation.findOneAndUpdate(
    { userId, installationId: details.installationId },
    {
      $set: {
        accountId: details.accountId,
        accountLogin: details.accountLogin,
        accountType: details.accountType,
        repositorySelection: details.repositorySelection,
        permissions: details.permissions,
        status: details.suspendedAt ? "suspended" : "active",
        lastSyncedAt: new Date(),
      },
      $setOnInsert: {
        userId,
        installationId: details.installationId,
        installedAt: new Date(),
      },
    },
    { upsert: true, new: true, runValidators: true }
  );


// Generate a secure GitHub App installation URL.
const startGitHubInstallation = async (req, res, next) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      throw createError(
        "Authentication required.",
        401,
        "AUTHENTICATION_REQUIRED"
      );
    }

    const appSlug = process.env.GITHUB_APP_SLUG;

    if (!appSlug) {
      throw createError(
        "GitHub App configuration is missing.",
        500,
        "GITHUB_CONFIG_MISSING"
      );
    }

    const state = await issueState(userId);

    // With sign-in configured the user goes to GitHub's sign-in page,
    // which always comes back to us. Without it, the older install page
    // is used, which only comes back after a fresh installation.
    const installationUrl = isGitHubSignInConfigured()
      ? buildAuthorizeUrl(state, {
          selectAccount: req.body?.selectAccount === true,
        })
      : buildInstallUrl(state);

    return res.status(200).json({
      success: true,
      message: "GitHub installation URL generated.",
      installationUrl,
      flow: isGitHubSignInConfigured() ? "sign-in" : "install",
      expiresInSeconds: 600,
    });
  } catch (error) {
    next(error);
  }
};


// GitHub returns here after the user signs in. Every installation of
// the app that the signed-in GitHub account can reach is linked to the
// SpareShare account that started the flow.
const completeGitHubSignIn = async (req, res) => {
  try {
    const { code, state, error: githubRefusal } = req.query;

    if (githubRefusal) {
      throw createError("GitHub sign-in was cancelled.", 400, "GITHUB_SIGN_IN_CANCELLED");
    }

    if (
      typeof code !== "string" ||
      !/^[A-Za-z0-9_-]{8,200}$/.test(code) ||
      typeof state !== "string" ||
      !/^[a-f0-9]{64}$/.test(state)
    ) {
      throw createError(
        "This GitHub link is not valid. Start again from the SpareShare app.",
        400,
        "INVALID_GITHUB_CALLBACK"
      );
    }

    if (!isGitHubSignInConfigured()) {
      throw createError("GitHub sign-in is not set up on this server.", 400, "GITHUB_SIGN_IN_NOT_CONFIGURED");
    }

    const savedState = await GitHubOAuthState.findOneAndDelete({
      stateHash: hashState(state),
      expiresAt: { $gt: new Date() },
    });

    if (!savedState) {
      throw createError(
        "This GitHub link has expired or was already used.",
        400,
        "INVALID_OR_EXPIRED_GITHUB_STATE"
      );
    }

    const userToken = await exchangeCodeForUserToken(code);
    const [githubUser, installations] = await Promise.all([
      getGitHubUser(userToken),
      listUserInstallations(userToken),
    ]);

    // Signed in, but the app is not installed on anything this account
    // can reach yet: continue to the install page with a fresh state.
    if (installations.length === 0) {
      const nextState = await issueState(savedState.userId);
      return res.redirect(302, buildInstallUrl(nextState));
    }

    for (const details of installations) {
      await saveInstallationLink(savedState.userId, details);
    }

    const accounts = [...new Set(installations.map((item) => item.accountLogin))];

    return sendResultPage(res, {
      ok: true,
      title: "GitHub connected",
      lines: [
        `Signed in as ${githubUser.login}. Repositories from ${accounts.join(", ")} are now available.`,
        "Go back to the SpareShare app. The list updates by itself.",
      ],
    });
  } catch (error) {
    console.error(`[GitHub] Sign-in callback failed: ${error.message}`);
    return sendFailurePage(res, error);
  }
};


// Complete GitHub installation and return the user to SpareShare.
const completeGitHubInstallation = async (req, res) => {
  try {
    const {
      installation_id,
      setup_action,
      state,
    } = req.query;

    // When the app asks for sign-in during installation, GitHub adds a
    // code. That path proves who the user is, so it is preferred.
    if (typeof req.query.code === "string" && isGitHubSignInConfigured()) {
      return completeGitHubSignIn(req, res);
    }

    if (
      typeof installation_id !== "string" ||
      !/^\d+$/.test(installation_id) ||
      !["install", "update"].includes(setup_action) ||
      typeof state !== "string" ||
      !/^[a-f0-9]{64}$/.test(state)
    ) {
      throw createError(
        "Invalid GitHub installation callback.",
        400,
        "INVALID_GITHUB_CALLBACK"
      );
    }

    const stateHash = hashState(state);

    const savedState = await GitHubOAuthState.findOneAndDelete({
      stateHash,
      expiresAt: { $gt: new Date() },
    });

    if (!savedState) {
      throw createError(
        "GitHub connection state is invalid, expired, or already used. Please try again.",
        400,
        "INVALID_OR_EXPIRED_GITHUB_STATE"
      );
    }

    const installationId = Number(installation_id);

    const details = await getInstallationDetails(installationId);

    if (
      !details.accountId ||
      !details.accountLogin ||
      !details.accountType ||
      !details.repositorySelection
    ) {
      throw createError(
        "GitHub returned incomplete installation details.",
        502,
        "INVALID_GITHUB_INSTALLATION_DETAILS"
      );
    }

    // This path cannot prove who installed the app, so an installation
    // that already belongs to someone else is never handed over here.
    // Signing in with GitHub is the way to share one.
    const linkedElsewhere = await GitHubInstallation.exists({
      installationId,
      userId: { $ne: savedState.userId },
      status: { $ne: "uninstalled" },
    });

    if (linkedElsewhere) {
      throw createError(
        "This GitHub installation is already connected to another SpareShare account.",
        409,
        "GITHUB_INSTALLATION_ALREADY_LINKED"
      );
    }

    await saveInstallationLink(savedState.userId, { ...details, installationId });

    return sendResultPage(res, {
      ok: true,
      title: "GitHub connected",
      lines: [
        `Repositories from ${details.accountLogin} are now available.`,
        "Go back to the SpareShare app. The list updates by itself.",
      ],
    });
  } catch (error) {
    console.error(`[GitHub] Installation callback failed: ${error.message}`);
    return sendFailurePage(res, error);
  }
};


// Handle GitHub App lifecycle webhooks.
const handleGitHubWebhook = async (req, res, next) => {
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const signature = req.get("x-hub-signature-256");

    if (!secret) {
      throw createError(
        "GitHub webhook secret is not configured.",
        500,
        "GITHUB_WEBHOOK_CONFIG_MISSING"
      );
    }

    if (!Buffer.isBuffer(req.rawBody) || !signature) {
      throw createError(
        "Missing raw webhook body or signature.",
        401,
        "GITHUB_WEBHOOK_SIGNATURE_MISSING"
      );
    }

    const expectedSignature =
      "sha256=" +
      crypto
        .createHmac("sha256", secret)
        .update(req.rawBody)
        .digest("hex");

    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(
        receivedBuffer,
        expectedBuffer
      )
    ) {
      throw createError(
        "Invalid GitHub webhook signature.",
        401,
        "GITHUB_WEBHOOK_SIGNATURE_INVALID"
      );
    }

    const event = req.get("x-github-event");
    const payload = req.body;

    if (event === "ping") {
      return res.status(200).json({
        success: true,
        message: "GitHub webhook ping received.",
      });
    }

    // Auto-deploy: a push to the tracked branch of a server with
    // repository.autoDeploy enabled starts a deployment.
    if (event === "push") {
      const repositoryId = payload?.repository?.id;
      const ref = typeof payload?.ref === "string" ? payload.ref : "";
      const commitSha = typeof payload?.after === "string" ? payload.after : "";

      if (
        !Number.isSafeInteger(repositoryId) ||
        !ref.startsWith("refs/heads/") ||
        payload?.deleted === true ||
        !/^[a-f0-9]{40}$/i.test(commitSha)
      ) {
        return res.status(200).json({
          success: true,
          message: "Push verified; nothing to deploy.",
        });
      }

      const branch = ref.slice("refs/heads/".length);

      const servers = await Server.find({
        "repository.repositoryId": repositoryId,
        "repository.branch": branch,
        "repository.autoDeploy": true,
        isActive: true,
        status: { $ne: "deleted" },
      }).limit(20);

      let started = 0;

      for (const server of servers) {
        try {
          const result = await createDeployment({
            server,
            trigger: "webhook",
            branch,
            commitSha,
            // GitHub redelivers webhooks. The delivery id makes that a no-op.
            idempotencyKey: `gh:${req.get("x-github-delivery") || commitSha}`.slice(0, 100),
          });
          if (result.created) started += 1;
        } catch (deployError) {
          console.error(
            `[GitHub Webhook] Auto-deploy skipped for server ${server._id}: ${deployError.message}`
          );
        }
      }

      return res.status(200).json({
        success: true,
        message: `Push verified; ${started} deployment(s) started.`,
      });
    }

    if (event !== "installation") {
      return res.status(200).json({
        success: true,
        message: "Webhook verified; event not handled.",
      });
    }

    const installation = payload?.installation;
    const installationId = installation?.id;
    const action = payload?.action;

    if (
      !Number.isSafeInteger(installationId) ||
      installationId <= 0
    ) {
      throw createError(
        "Invalid installation ID in webhook payload.",
        400,
        "INVALID_GITHUB_INSTALLATION_ID"
      );
    }

    let update;

    switch (action) {
      case "deleted":
        update = {
          status: "uninstalled",
        };
        break;

      case "suspend":
        update = {
          status: "suspended",
        };
        break;

      case "unsuspend":
        update = {
          status: "active",
        };
        break;

      case "created":
      case "updated":
      case "new_permissions_accepted":
        update = {
          accountId: installation.account?.id,
          accountLogin: installation.account?.login,
          accountType: installation.target_type,
          repositorySelection: installation.repository_selection,
          permissions: {
            contents: installation.permissions?.contents || "read",
            metadata: installation.permissions?.metadata || "read",
          },
          status: installation.suspended_at ? "suspended" : "active",
          lastSyncedAt: new Date(),
        };
        break;

      default:
        return res.status(200).json({
          success: true,
          message: "Installation event verified; action not handled.",
        });
    }

    const result = await GitHubInstallation.updateMany(
      { installationId },
      { $set: update },
      { runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: result.matchedCount
        ? "GitHub installation synchronized."
        : "Webhook verified; installation is not linked yet.",
    });
  } catch (error) {
    next(error);
  }
};


// Get all GitHub installations connected to the logged-in user.
const getGitHubConnectionStatus = async (req, res, next) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      throw createError(
        "Authentication required.",
        401,
        "AUTHENTICATION_REQUIRED"
      );
    }

    const installations = await GitHubInstallation.find({
      userId,
    })
      .select(
        "installationId accountId accountLogin accountType repositorySelection status permissions installedAt lastSyncedAt"
      )
      .sort({ installedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      connected: installations.some(
        (installation) => installation.status === "active"
      ),
      installations,
    });
  } catch (error) {
    next(error);
  }
};


// Get repositories accessible through a user's GitHub installation.
const getGitHubRepositories = async (req, res, next) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      throw createError(
        "Authentication required.",
        401,
        "AUTHENTICATION_REQUIRED"
      );
    }

    const installations = await GitHubInstallation.find({ userId, status: "active" })
      .sort({ lastSyncedAt: -1 });

    if (installations.length === 0) {
      throw createError(
        "GitHub is not connected. Connect GitHub to list your repositories.",
        404,
        "GITHUB_NOT_CONNECTED"
      );
    }

    // Every connected GitHub account contributes its repositories. One
    // account failing does not hide the others.
    const repositories = [];
    const accounts = [];
    let firstError = null;

    for (const installation of installations) {
      try {
        const found = await listInstallationRepositories(installation.installationId);
        accounts.push({
          installationId: installation.installationId,
          accountLogin: installation.accountLogin,
          accountType: installation.accountType,
          repositoryCount: found.length,
        });
        for (const repo of found) {
          repositories.push({
            ...repo,
            installationId: installation.installationId,
            accountLogin: installation.accountLogin,
          });
        }
      } catch (error) {
        firstError = firstError || error;
        // GitHub no longer knows this installation: the app was removed
        // there while our webhook was unreachable.
        if (error.statusCode === 404) {
          await GitHubInstallation.updateMany(
            { installationId: installation.installationId },
            { $set: { status: "uninstalled", lastSyncedAt: new Date() } }
          );
        }
      }
    }

    if (accounts.length === 0) {
      if (firstError && firstError.statusCode === 404) {
        throw createError(
          "GitHub is not connected. Connect GitHub to list your repositories.",
          404,
          "GITHUB_NOT_CONNECTED"
        );
      }
      throw firstError;
    }

    return res.status(200).json({
      success: true,
      installation: accounts[0],
      accounts,
      count: repositories.length,
      repositories,
    });
  } catch (error) {
    next(error);
  }
};


// Disconnect and uninstall a GitHub App installation.
const disconnectGitHub = async (req, res, next) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      throw createError(
        "Authentication required.",
        401,
        "AUTHENTICATION_REQUIRED"
      );
    }

    const requested = req.query.installationId;

    if (requested !== undefined && !/^\d{1,15}$/.test(String(requested))) {
      throw createError(
        "Invalid GitHub installation ID.",
        400,
        "INVALID_INSTALLATION_ID"
      );
    }

    const installation = await GitHubInstallation.findOne({
      userId,
      status: "active",
      ...(requested !== undefined ? { installationId: Number(requested) } : {}),
    }).sort({ lastSyncedAt: -1 });

    if (!installation) {
      throw createError(
        "GitHub installation not found for this account.",
        404,
        "GITHUB_INSTALLATION_NOT_FOUND"
      );
    }

    const installationId = installation.installationId;

    // Someone else also uses this installation: only our link goes. The
    // app stays installed on GitHub for them.
    const sharedWithOthers = await GitHubInstallation.exists({
      installationId,
      userId: { $ne: userId },
      status: "active",
    });

    if (sharedWithOthers) {
      await GitHubInstallation.deleteOne({ _id: installation._id });
      return res.status(200).json({
        success: true,
        message: "GitHub account disconnected from SpareShare.",
        installationId,
      });
    }

    await uninstallGitHubInstallation(installationId);

    installation.status = "uninstalled";
    installation.lastSyncedAt = new Date();

    await installation.save();

    return res.status(200).json({
      success: true,
      message: "GitHub App successfully disconnected.",
      installationId: installation.installationId,
    });
  } catch (error) {
    next(error);
  }
};


module.exports = {
  completeGitHubSignIn,
  startGitHubInstallation,
  completeGitHubInstallation,
  handleGitHubWebhook,
  getGitHubConnectionStatus,
  getGitHubRepositories,
  disconnectGitHub,
};
