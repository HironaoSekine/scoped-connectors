"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  describeTokenStore,
  writeTokenRecord,
} = require("./token-store");
const {
  base64Url,
  createPkcePair,
  createState,
} = require("./_shared/oauth/pkce");
const { validateAuthorizationCallback: validateAuthorizationCallbackBase } = require("./_shared/oauth/callback");
const { postFormForJson } = require("./_shared/oauth/http");

const AUTH_URI = "https://slack.com/oauth/v2_user/authorize";
const TOKEN_URI = "https://slack.com/api/oauth.v2.user.access";
const SLACK_API_URI = "https://slack.com/api/";
const DEFAULT_CLIENT_ID = "6381386946.11807045760195";
const DEFAULT_REDIRECT_URI = "http://localhost:53682/slack/oauth/callback";
const DEFAULT_ALLOWED_TEAM_IDS = ["T06B7BCTU"];
const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "scoped-connectors",
  "slack",
  "config.json"
);
const READONLY_SCOPES = [
  "channels:history",
  "channels:read",
  "search:read.public",
  "users:read",
  "usergroups:read",
];
const OPTIONAL_SCOPES = ["chat:write"];
function requestedScopes(options = {}) {
  return options.write === true
    ? [...READONLY_SCOPES, ...OPTIONAL_SCOPES]
    : [...READONLY_SCOPES];
}
const USAGE = [
  "使い方: oauth-login.js [--write] [--config path] [--client-id <Slack Client ID>] [--redirect-uri URL]",
  "",
  "既定は読み取り専用です。--write 指定時だけ chat:write も要求します。",
  "既定では共有 Slack App の Client ID を使います。",
  `別 App を使う場合は ${DEFAULT_CONFIG_PATH} の client_id、SLACK_CLIENT_ID、または --client-id で上書きできます。`,
  "token 保存前に Slack workspace の team_id を allowed_team_ids と照合します。",
  "guest user (is_restricted / is_ultra_restricted) の token は保存できません。",
  "Slack token は macOS Keychain または Windows Credential Manager に保存します。",
  "",
].join("\n");

function loadConfigFile(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Slack login config を読み取れません: ${configPath}`);
  }
}

function applyDefaults(parsed, config = {}, env = process.env) {
  const allowedTeamIds = normalizeTeamIds(
    parsed.allowedTeamIds ||
    env.SLACK_ALLOWED_TEAM_IDS ||
    config.allowed_team_ids ||
    DEFAULT_ALLOWED_TEAM_IDS
  );

  return {
    ...parsed,
    clientId: parsed.clientId || env.SLACK_CLIENT_ID || config.client_id || DEFAULT_CLIENT_ID,
    redirectUri:
      parsed.redirectUri ||
      env.SLACK_REDIRECT_URI ||
      config.redirect_uri ||
      DEFAULT_REDIRECT_URI,
    allowedTeamIds,
  };
}

function normalizeTeamIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((id) => String(id).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((id) => id.trim()).filter(Boolean);
  }
  throw new Error("allowed_team_ids は配列またはカンマ区切り文字列で指定してください。");
}

function parseArgs(args, env = process.env, configLoader = loadConfigFile) {
  const parsed = {
    configPath: env.SLACK_CONFIG_PATH || DEFAULT_CONFIG_PATH,
    clientId: "",
    redirectUri: "",
    help: false,
    write: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--config") {
      if (!args[i + 1]) throw new Error("--config には JSON path を指定してください。");
      parsed.configPath = args[++i];
    } else if (arg === "--client-id") {
      if (!args[i + 1]) throw new Error("--client-id には Slack Client ID を指定してください。");
      parsed.clientId = args[++i];
    } else if (arg === "--redirect-uri") {
      if (!args[i + 1]) throw new Error("--redirect-uri には URL を指定してください。");
      parsed.redirectUri = args[++i];
    } else if (arg === "--write") {
      parsed.write = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }

  if (parsed.help) return applyDefaults(parsed, {}, env);
  return applyDefaults(parsed, configLoader(parsed.configPath), env);
}

function validateOptions(options) {
  if (!options.clientId) {
    throw new Error(
      `Slack Client ID が必要です。${options.configPath} の client_id、SLACK_CLIENT_ID、または --client-id を指定してください。`
    );
  }
  if (!options.allowedTeamIds || options.allowedTeamIds.length === 0) {
    throw new Error(
      `Slack workspace の allowed_team_ids が必要です。${options.configPath} の allowed_team_ids または SLACK_ALLOWED_TEAM_IDS を指定してください。`
    );
  }
  const redirect = new URL(options.redirectUri);
  if (redirect.protocol !== "http:") {
    throw new Error("slack-auth の redirect URI は http である必要があります。");
  }
  if (!["localhost", "127.0.0.1"].includes(redirect.hostname)) {
    throw new Error("slack-auth の redirect URI は localhost または 127.0.0.1 を指定してください。");
  }
  if (!redirect.port) {
    throw new Error("redirect URI には固定 port を含めてください。");
  }
}

function extractGrantedScopes(tokenResponse = {}) {
  const scopeValue =
    tokenResponse.scope ||
    (tokenResponse.authed_user && tokenResponse.authed_user.scope) ||
    "";
  const rawScopes = Array.isArray(scopeValue) ? scopeValue : String(scopeValue).split(/[,\s]+/);
  return new Set(rawScopes.map((scope) => String(scope).trim()).filter(Boolean));
}

function getMissingRequiredScopes(grantedScopes, requiredScopes = READONLY_SCOPES) {
  return requiredScopes.filter((scope) => !grantedScopes.has(scope));
}

function validateGrantedScopes(tokenResponse, requiredScopes = READONLY_SCOPES) {
  const grantedScopes = extractGrantedScopes(tokenResponse);
  const missingScopes = getMissingRequiredScopes(grantedScopes, requiredScopes);
  const unexpected = [...grantedScopes].filter((scope) => !requiredScopes.includes(scope));
  if (unexpected.length) {
    throw new Error(
      `Slack token response に要求していない scope が含まれています: ${unexpected.join(", ")}。新しい token は保存していません。既存の保存済み token は変更されません。Slack 側の既存認可を取り消して再認証するか、別 App の --client-id を指定してください。slack-auth clear だけでは Slack 側の権限は取り消せません。`
    );
  }
  if (missingScopes.length === 0) return;

  if (grantedScopes.size === 0) {
    throw new Error(
      "Slack token response に scope が含まれていません。Slack App を再インストールしてから slack-auth で再ログインしてください。"
    );
  }
  throw new Error(
    `Slack token response に必要な scope が不足しています: ${missingScopes.join(", ")}。Slack App を再インストールしてから slack-auth で再ログインしてください。`
  );
}

function buildAuthorizeUrl(options, pkce, state) {
  const url = new URL(AUTH_URI);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", requestedScopes(options).join(","));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url;
}

function createCallbackServer(redirectUri) {
  const redirect = new URL(redirectUri);
  const host = redirect.hostname === "localhost" ? "127.0.0.1" : redirect.hostname;
  const port = Number(redirect.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("redirect URI の port が不正です。");
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve({ server, callbackPath: redirect.pathname });
    });
  });
}

function validateAuthorizationCallback(args) {
  return validateAuthorizationCallbackBase({
    ...args,
    errorResponseBody: "Slack authorization failed. You can close this tab.",
    invalidResponseBody: "Invalid authorization response. You can close this tab.",
  });
}

async function waitForAuthorization(options) {
  const pkce = createPkcePair();
  const state = createState();
  const authUrl = buildAuthorizeUrl(options, pkce, state);
  const { server, callbackPath } = await createCallbackServer(options.redirectUri);

  process.stdout.write(
    [
      options.write === true
        ? "次の URL をブラウザで開いて Slack の読み取り権限と投稿権限を許可してください:"
        : "次の URL をブラウザで開いて Slack の読み取り権限を許可してください:",
      authUrl.toString(),
      "",
    ].join("\n")
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("認可待ちがタイムアウトしました。"));
    }, 10 * 60 * 1000);

    server.on("request", (req, res) => {
      const url = new URL(req.url, options.redirectUri);
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      clearTimeout(timeout);
      let authorizedCode;
      try {
        authorizedCode = validateAuthorizationCallback({
          error,
          code,
          returnedState,
          expectedState: state,
        });
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(err.responseBody || "Invalid authorization response. You can close this tab.");
        server.close();
        reject(err);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Slack authorization completed. You can close this tab.");
      server.close();
      resolve({ code: authorizedCode, codeVerifier: pkce.verifier, redirectUri: options.redirectUri });
    });
  });
}

async function exchangeCodeForToken(options, authorization, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: options.clientId,
    code: authorization.code,
    code_verifier: authorization.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: authorization.redirectUri,
  });

  const { response, data } = await postFormForJson(TOKEN_URI, body, fetchImpl);
  if (!response.ok || !data.ok) {
    const message = data.error_description || data.error || `HTTP ${response.status || "unknown"}`;
    throw new Error(`Slack token 取得に失敗しました: ${message}`);
  }
  if (!data.access_token) {
    throw new Error("Slack token response に access_token が含まれていません。");
  }
  if (!data.refresh_token) {
    throw new Error("Slack token response に refresh_token が含まれていません。PKCE と token rotation の設定を確認してください。");
  }
  return data;
}

async function fetchSlackApiWithToken(method, accessToken, params = {}, fetchImpl = fetch) {
  const body = new URLSearchParams(params);
  const response = await fetchImpl(new URL(method, SLACK_API_URI), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const message = data.error_description || data.error || `HTTP ${response.status || "unknown"}`;
    throw new Error(`Slack API ${method} が失敗しました: ${message}`);
  }
  return data;
}

async function verifyTokenAuthorization(options, tokenResponse, fetchImpl = fetch) {
  const auth = await fetchSlackApiWithToken("auth.test", tokenResponse.access_token, {}, fetchImpl);
  if (!auth.team_id) {
    throw new Error("Slack auth.test response に team_id が含まれていません。");
  }
  if (!options.allowedTeamIds.includes(auth.team_id)) {
    throw new Error(`許可されていない Slack workspace です: ${auth.team_id}`);
  }

  const userId =
    auth.user_id ||
    (tokenResponse.authed_user && tokenResponse.authed_user.id);
  if (!userId) {
    throw new Error("Slack 認証ユーザー ID を確認できません。");
  }
  const userInfo = await fetchSlackApiWithToken(
    "users.info",
    tokenResponse.access_token,
    { user: userId },
    fetchImpl
  );
  const user = userInfo.user || null;
  if (user && (user.is_restricted || user.is_ultra_restricted)) {
    throw new Error("Slack guest user はこのプラグインでは許可されていません。");
  }

  return {
    team_id: auth.team_id,
    team_name: auth.team || (tokenResponse.team && tokenResponse.team.name) || "",
    authed_user_id:
      auth.user_id ||
      (tokenResponse.authed_user && tokenResponse.authed_user.id) ||
      "",
    url: auth.url || "",
    user,
  };
}

function buildTokenRecord(options, data, now = Date.now(), verification = {}) {
  const scope =
    data.scope ||
    (data.authed_user && data.authed_user.scope) ||
    READONLY_SCOPES.join(",");
  const expiresAt = data.expires_in ? now + data.expires_in * 1000 : 0;

  return {
    version: 1,
    client_id: options.clientId,
    team_id: verification.team_id || (data.team && data.team.id ? data.team.id : ""),
    team_name: verification.team_name || (data.team && data.team.name ? data.team.name : ""),
    authed_user_id:
      verification.authed_user_id ||
      (data.authed_user && data.authed_user.id ? data.authed_user.id : ""),
    scope,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
    token_type: data.token_type || "user",
  };
}

async function login(options) {
  validateOptions(options);
  const authorization = await waitForAuthorization(options);
  const tokenResponse = await exchangeCodeForToken(options, authorization);
  validateGrantedScopes(tokenResponse, requestedScopes(options));
  const verification = await verifyTokenAuthorization(options, tokenResponse);
  const record = buildTokenRecord(options, tokenResponse, Date.now(), verification);
  await writeTokenRecord(record);
  return {
    store: describeTokenStore(),
    team: record.team_name || record.team_id || "unknown",
    authedUserId: record.authed_user_id || "unknown",
    scope: record.scope,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(USAGE);
      return;
    }
  } catch (err) {
    process.stderr.write(`エラー: ${err.message}\n${USAGE}`);
    process.exit(1);
  }

  try {
    const result = await login(options);
    process.stdout.write("Slack token を保存しました。\n");
    process.stdout.write(`store: ${result.store}\n`);
    process.stdout.write(`workspace: ${result.team}\n`);
    process.stdout.write(`user: ${result.authedUserId}\n`);
    process.stdout.write(`scope: ${result.scope}\n`);
  } catch (err) {
    process.stderr.write(`エラー: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`エラー: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  AUTH_URI,
  TOKEN_URI,
  SLACK_API_URI,
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
  DEFAULT_ALLOWED_TEAM_IDS,
  DEFAULT_CONFIG_PATH,
  READONLY_SCOPES,
  OPTIONAL_SCOPES,
  requestedScopes,
  USAGE,
  loadConfigFile,
  applyDefaults,
  normalizeTeamIds,
  parseArgs,
  validateOptions,
  extractGrantedScopes,
  getMissingRequiredScopes,
  validateGrantedScopes,
  base64Url,
  createPkcePair,
  buildAuthorizeUrl,
  validateAuthorizationCallback,
  exchangeCodeForToken,
  fetchSlackApiWithToken,
  verifyTokenAuthorization,
  buildTokenRecord,
  login,
};
