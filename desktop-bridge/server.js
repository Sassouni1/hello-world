const http = require("http");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const QRCode = require("qrcode");
const packageJson = require("./package.json");

const ROOT = __dirname;
const APP_ASSET_FILES = ["index.html", "app.js", "styles.css"].map((file) => path.join(ROOT, file));
const START_PORT = Number(process.env.PORT || 3001);
let PORT = START_PORT;
const HOST = process.env.HOST || "0.0.0.0";
const PACKAGE_NAME = packageJson.name || "codex-remote-bridge";
const BRIDGE_REPO_URL =
  process.env.BRIDGE_REPO_URL ||
  packageJson.repository?.url?.replace(/^git\+/, "").replace(/\.git$/, "") ||
  "https://github.com/YOUR_ACCOUNT/codex-remote-bridge";
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_CONFIG = path.join(CODEX_HOME, "config.toml");
const MODELS_CACHE = path.join(CODEX_HOME, "models_cache.json");
const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");
const SESSION_ROOT = path.join(CODEX_HOME, "sessions");
const ARCHIVE_ROOT = path.join(CODEX_HOME, "archived_sessions");
const BROWSER_SESSION_ROOT = path.join(CODEX_HOME, "browser", "sessions");
const BROWSER_USE_SOCKET_ROOT =
  process.platform === "win32" ? "\\\\.\\pipe\\codex-browser-use" : "/tmp/codex-browser-use";
const AUTOMATIONS_ROOT = path.join(CODEX_HOME, "automations");
const BRIDGE_STATE_ROOT = path.join(CODEX_HOME, "remote_bridge");
const BRIDGE_ACCOUNT_FILE = path.join(BRIDGE_STATE_ROOT, "account.json");
const BRIDGE_ACCOUNTS_ROOT = path.join(BRIDGE_STATE_ROOT, "accounts");
const BRIDGE_SAVED_ACCOUNTS_ROOT = path.join(BRIDGE_STATE_ROOT, "saved_accounts");
const BRIDGE_UPLOADS_ROOT = path.join(BRIDGE_STATE_ROOT, "uploads");
const BRIDGE_CLOUD_CONFIG_FILE = path.join(BRIDGE_STATE_ROOT, "cloud_config.json");
const DESKTOP_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const APP_SERVER_CONTROL_SOCKET = path.join(
  CODEX_HOME,
  "app-server-control",
  "app-server-control.sock",
);
const PAIRING_TTL_MS = 15 * 60 * 1000;
const OBSERVED_ACTIVE_FILE_MS = 120_000;
const OBSERVED_PENDING_USER_MS = 10 * 60_000;
const ACTIVE_MTIME_FALLBACK_MS = 8_000;
const CHAT_LIST_CACHE_MS = 1500;
const CHAT_DETAIL_CACHE_MS = 1000;
const TASK_LIST_CACHE_MS = Number(process.env.TASK_LIST_CACHE_MS || 1000);
const OBSERVED_TASK_SCAN_LIMIT = Number(process.env.OBSERVED_TASK_SCAN_LIMIT || 24);
const CHAT_DETAIL_TAIL_BYTES = Number(process.env.CHAT_DETAIL_TAIL_BYTES || 4 * 1024 * 1024);
const ACTIVE_SESSION_TAIL_BYTES = Number(
  process.env.ACTIVE_SESSION_TAIL_BYTES || 4 * 1024 * 1024,
);
const CLOUD_POLL_MS = Number(process.env.VLIX_CLOUD_POLL_MS || 1200);
const CLOUD_SESSION_SYNC_MS = Number(process.env.VLIX_CLOUD_SESSION_SYNC_MS || 15_000);
const CLOUD_AUTH_BACKOFF_MS = Number(process.env.VLIX_CLOUD_AUTH_BACKOFF_MS || 5 * 60_000);
const normalizePublicAppUrl = (value) => {
  const raw = String(value || "").trim() || "https://vlix1.lovable.app";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "https://vlix1.lovable.app";
  }
};
const PUBLIC_APP_URL = normalizePublicAppUrl(
  process.env.VLIX_PUBLIC_APP_URL || process.env.VLIX_APP_URL || "https://vlix1.lovable.app",
);

const tasks = new Map();
const pairings = new Map();
let chatListCache = { at: 0, chats: null };
const chatDetailCache = new Map();
const taskListCache = new Map();
let queueDrainTimer = null;
let cloudSyncState = {
  enabled: false,
  lastPollAt: null,
  lastError: "",
  deviceId: "",
  accountId: "",
};
let cloudSyncTimer = null;
let cloudSyncInFlight = false;
let cloudSyncBackoffUntil = 0;
let cloudSessionSyncAt = 0;
let cloudViteFrameSyncAt = 0;
const codexIabStatusCache = new Map();
const REMOTE_BROWSER_GLOBAL_KEY = "__global__";
const remoteBrowsersByChatId = new Map();

const createRemoteBrowserState = (key = REMOTE_BROWSER_GLOBAL_KEY) => ({
  key,
  browser: null,
  page: null,
  url: "",
  startedAt: null,
  lastFrameAt: null,
  lastDomAt: null,
  headless: false,
  logs: [],
});

const remoteBrowserKey = (sessionId = "") => String(sessionId || "").trim() || REMOTE_BROWSER_GLOBAL_KEY;

const remoteBrowserState = (sessionId = "", { create = true } = {}) => {
  const key = remoteBrowserKey(sessionId);
  let state = remoteBrowsersByChatId.get(key);
  if (!state && create) {
    state = createRemoteBrowserState(key);
    remoteBrowsersByChatId.set(key, state);
  }
  return state || null;
};

const rememberViteBrowserLog = (state, entry = {}) => {
  if (!state) return;
  state.logs.push({
    at: new Date().toISOString(),
    type: entry.type || "log",
    level: entry.level || entry.type || "log",
    text: compact(String(entry.text || entry.message || entry.url || ""), 260),
    url: entry.url || "",
  });
  if (state.logs.length > 80) state.logs.splice(0, state.logs.length - 80);
};

const attachViteBrowserPageEvents = (state, page) => {
  page.on("console", (message) => {
    rememberViteBrowserLog(state, { type: "console", level: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    rememberViteBrowserLog(state, { type: "pageerror", level: "error", text: error.message });
  });
  page.on("requestfailed", (request) => {
    rememberViteBrowserLog(state, {
      type: "network",
      level: "error",
      text: `${request.method()} ${request.url()} failed: ${request.failure()?.errorText || "request failed"}`,
      url: request.url(),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      rememberViteBrowserLog(state, {
        type: "network",
        level: "warn",
        text: `${response.status()} ${response.url()}`,
        url: response.url(),
      });
    }
  });
};

const closeViteBrowser = async (sessionId = "") => {
  const state = remoteBrowserState(sessionId, { create: false });
  if (!state) return;
  const browser = state.browser;
  state.browser = null;
  state.page = null;
  state.url = "";
  state.startedAt = null;
  state.lastFrameAt = null;
  state.lastDomAt = null;
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
};

const appAssetVersion = () => {
  const source = APP_ASSET_FILES.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${path.basename(file)}:${stat.size}:${Math.round(stat.mtimeMs)}`;
    } catch {
      return `${path.basename(file)}:missing`;
    }
  }).join("|");
  return crypto.createHash("sha1").update(source).digest("hex").slice(0, 12);
};

const send = (res, statusCode, payload, headers = {}) => {
  const isBuffer = Buffer.isBuffer(payload);
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": isBuffer ? "image/png" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(isBuffer ? payload : JSON.stringify(payload));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 24_000_000) {
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });

const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
};

const writeJsonFile = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
};

const readTextFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
};

const configTomlString = (source, key) => {
  const match = String(source || "").match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : "";
};

const setTomlString = (source, key, value) => {
  const line = `${key} = ${JSON.stringify(String(value))}`;
  if (new RegExp(`^${key}\\s*=`, "m").test(source))
    return source.replace(new RegExp(`^${key}\\s*=.*$`, "m"), line);
  return `${line}\n${source || ""}`;
};

const listAvailableModels = () => {
  const cache = readJsonFile(MODELS_CACHE);
  const models = Array.isArray(cache?.models) ? cache.models : [];
  return models
    .filter(
      (model) => model?.slug && model.visibility !== "hidden" && model.slug !== "codex-auto-review",
    )
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((model) => ({
      slug: model.slug,
      displayName: model.display_name || model.slug,
      shortName: model.slug.replace(/^gpt-/, "").replace("-codex", ""),
      defaultReasoningLevel: model.default_reasoning_level || "medium",
      supportedReasoningLevels: (model.supported_reasoning_levels || [])
        .map((item) => item.effort)
        .filter(Boolean),
    }));
};

const normalizeCodexSettings = (settings = {}) => {
  const models = listAvailableModels();
  const fallback = models[0] || {
    slug: "gpt-5.5",
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: ["medium"],
  };
  const selectedModel = models.find((model) => model.slug === settings.model) || fallback;
  const supported = selectedModel.supportedReasoningLevels?.length
    ? selectedModel.supportedReasoningLevels
    : ["medium"];
  const effort = supported.includes(settings.effort)
    ? settings.effort
    : selectedModel.defaultReasoningLevel || supported[0] || "medium";
  return {
    model: selectedModel.slug,
    effort,
    fullAccess: Boolean(settings.fullAccess),
  };
};

const readCodexSettings = () => {
  const source = readTextFile(CODEX_CONFIG);
  const settings = normalizeCodexSettings({
    model: configTomlString(source, "model"),
    effort: configTomlString(source, "model_reasoning_effort"),
    fullAccess:
      configTomlString(source, "approval_policy") === "never" &&
      configTomlString(source, "sandbox_mode") === "danger-full-access",
  });
  return { models: listAvailableModels(), selected: settings };
};

const writeCodexSettings = (next = {}) => {
  const current = readCodexSettings().selected;
  const requested = { ...current };
  if (next.model) requested.model = next.model;
  if (next.effort) requested.effort = next.effort;
  if (typeof next.fullAccess === "boolean") requested.fullAccess = next.fullAccess;
  const settings = normalizeCodexSettings(requested);
  let source = readTextFile(CODEX_CONFIG);
  source = setTomlString(source, "model", settings.model);
  source = setTomlString(source, "model_reasoning_effort", settings.effort);
  source = setTomlString(source, "approval_policy", settings.fullAccess ? "never" : "on-request");
  source = setTomlString(
    source,
    "sandbox_mode",
    settings.fullAccess ? "danger-full-access" : "workspace-write",
  );
  fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  fs.writeFileSync(CODEX_CONFIG, source);
  return readCodexSettings();
};

const normalizeIp = (value) => String(value || "").replace(/^::ffff:/, "");

const isLoopbackRequest = (req) => {
  const ip = normalizeIp(req.socket.remoteAddress);
  return ip === "::1" || ip === "localhost" || ip.startsWith("127.");
};

const parseCookies = (req) =>
  Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        const key = index >= 0 ? item.slice(0, index) : item;
        const value = index >= 0 ? item.slice(index + 1) : "";
        try {
          return [decodeURIComponent(key), decodeURIComponent(value)];
        } catch {
          return [key, value];
        }
      }),
  );

const pairingCookie = (token) =>
  `codex_pair=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${Math.round(PAIRING_TTL_MS / 1000)}`;

const clearPairingCookie = () => "codex_pair=; Path=/; SameSite=Lax; Max-Age=0";

const getPairingToken = (req, reqUrl) => {
  const header = req.headers["x-codex-pairing"];
  const cookieToken = parseCookies(req).codex_pair;
  return String(header || reqUrl.searchParams.get("pair") || cookieToken || "").trim();
};

const cleanupPairings = () => {
  const now = Date.now();
  for (const [token, pairing] of pairings.entries()) {
    if (pairing.expiresAtMs <= now) pairings.delete(token);
  }
};

const getValidPairing = (req, reqUrl) => {
  cleanupPairings();
  const token = getPairingToken(req, reqUrl);
  if (!token) return null;
  const pairing = pairings.get(token);
  if (!pairing || pairing.expiresAtMs <= Date.now()) {
    if (pairing) pairings.delete(token);
    return null;
  }
  pairing.lastSeenAt = new Date().toISOString();
  return pairing;
};

const revokePairingToken = (token, { allowClearAll = false } = {}) => {
  cleanupPairings();
  let revokedCount = 0;
  if (token) {
    const pairing = pairings.get(token);
    if (pairing?.accountId) {
      for (const [pairingToken, activePairing] of pairings.entries()) {
        if (activePairing.accountId === pairing.accountId) {
          pairings.delete(pairingToken);
          revokedCount += 1;
        }
      }
    } else if (pairings.delete(token)) {
      revokedCount = 1;
    }
  } else if (allowClearAll) {
    revokedCount = pairings.size;
    pairings.clear();
  }
  return {
    ok: true,
    revoked: revokedCount > 0,
    revokedCount,
    remainingPairings: pairings.size,
  };
};

const isPhoneAllowedApiPath = (method, pathname) => {
  if (method === "GET" && pathname === "/api/bridge/info") return true;
  if (method === "GET" && pathname === "/api/app-version") return true;
  if (method === "GET" && pathname === "/api/bridge/account") return true;
  if (method === "GET" && pathname === "/api/bridge/account/qr") return true;
  if (method === "POST" && pathname === "/api/bridge/disconnect") return true;
  if (method === "GET" && pathname === "/api/codex-settings") return true;
  if (method === "POST" && pathname === "/api/codex-settings") return true;
  if (method === "POST" && pathname === "/api/pairing/disconnect") return true;
  if (pathname.startsWith("/api/relay/")) return true;
  if (method === "GET" && pathname === "/api/chats") return true;
  if (method === "GET" && pathname === "/api/workspaces") return true;
  if (method === "GET" && pathname === "/api/browser-sessions") return true;
  if (method === "GET" && pathname === "/api/automations") return true;
  if (method === "GET" && pathname === "/api/tasks") return true;
  if (method === "GET" && pathname === "/api/attachment") return true;
  if (method === "GET" && /^\/api\/chats\/[^/]+$/.test(pathname)) return true;
  if (method === "GET" && /^\/api\/tasks\/[^/]+$/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/tasks\/[^/]+\/stop$/.test(pathname)) return true;
  if (method === "POST" && pathname === "/api/chats/send-new") return true;
  if (method === "POST" && /^\/api\/chats\/[^/]+\/send$/.test(pathname)) return true;
  if (method === "POST" && /^\/api\/chats\/[^/]+\/stop$/.test(pathname)) return true;
  return false;
};

const relayMeta = (auth) => ({
  via: "local-relay-simulator",
  account: publicBridgeAccount(accountFromAuth(auth)),
  desktopBridge: {
    online: Boolean(codexAppServer.child || codexAppServer.status.connected),
    mode: codexAppServer.status.mode,
    userAgent: codexAppServer.status.userAgent,
    error: codexAppServer.status.error,
  },
});

const authorizeApi = (req, reqUrl) => {
  if (isLoopbackRequest(req)) return { ok: true, local: true, pairing: null };
  const pairing = getValidPairing(req, reqUrl);
  if (!pairing)
    return {
      ok: false,
      local: false,
      pairing: null,
      reason: "Pair this phone from the desktop first.",
    };
  if (!isPhoneAllowedApiPath(req.method, reqUrl.pathname)) {
    return {
      ok: false,
      local: false,
      pairing,
      reason: "This paired phone can only read and send paired chats.",
    };
  }
  return { ok: true, local: false, pairing };
};

const getLanAddress = () => {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
};

const pairingOrigin = (req) => {
  const hostHeader = String(req.headers.host || `localhost:${PORT}`);
  const port = hostHeader.includes(":") ? hostHeader.split(":").pop() : String(PORT);
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${getLanAddress()}:${port}`;
};

const localOrigin = () => `http://localhost:${PORT}`;

const hostedAppOrigin = () => {
  try {
    return new URL(PUBLIC_APP_URL).origin;
  } catch {
    return "https://vlix1.lovable.app";
  }
};

const LOCAL_CLOUD_API_PATHS = new Set([
  "/api/bridge/info",
  "/api/cloud/status",
  "/api/cloud/connect",
  "/api/pairing/start",
  "/api/vite-browser/status",
  "/api/vite-browser/start",
  "/api/vite-browser/dom",
  "/api/vite-browser/screenshot",
  "/api/vite-browser/reload",
  "/api/vite-browser/input",
  "/api/vite-browser/stop",
  "/api/codex-browser/status",
  "/api/codex-browser/screenshot",
  "/api/codex-browser/input",
]);

const allowedLocalApiOrigins = () =>
  new Set([
    hostedAppOrigin(),
    "https://vlix1.lovable.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3002",
    "http://127.0.0.1:3002",
    localOrigin(),
    `http://127.0.0.1:${PORT}`,
  ]);

const isLoopbackOrigin = (origin) => {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
};

const localApiCorsHeaders = (req) => {
  const origin = String(req.headers.origin || "").trim();
  if (!origin || (!allowedLocalApiOrigins().has(origin) && !isLoopbackOrigin(origin))) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Private-Network",
  };
};

const sendLocalApi = (req, res, statusCode, payload, headers = {}) => {
  const corsHeaders = localApiCorsHeaders(req) || {};
  send(res, statusCode, payload, { ...corsHeaders, ...headers });
};

const sendLocalApiOptions = (req, res) => {
  const headers = localApiCorsHeaders(req);
  if (!headers) {
    send(res, 403, { error: "Origin is not allowed for local bridge setup." });
    return;
  }
  res.writeHead(204, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
};

const localCloudConnectPage = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Connecting Vlix</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0f0f0f;
      color: #f5f5f1;
      font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(460px, calc(100vw - 32px));
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 24px;
      background: #171717;
      padding: 24px;
      box-shadow: 0 24px 80px rgba(0,0,0,.38);
    }
    .brand { display:flex; align-items:center; gap:12px; font-weight:700; font-size:20px; }
    .mark { width:40px; height:40px; border-radius:14px; display:grid; place-items:center; color:#050505; background:linear-gradient(135deg,#67e8f9,#8b5cf6); }
    #status { margin-top: 22px; color: rgba(245,245,241,.7); }
    .spinner {
      width: 18px; height: 18px; border-radius: 999px; display:inline-block; vertical-align:-4px; margin-right:10px;
      border: 2px solid rgba(103,232,249,.25); border-top-color: #67e8f9; animation: spin .8s linear infinite;
    }
    pre { white-space: pre-wrap; word-break: break-word; margin: 18px 0 0; color: #fca5a5; font-size: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">V</div><div>Vlix desktop bridge</div></div>
    <div id="status"><span class="spinner"></span>Syncing this computer...</div>
    <pre id="error" hidden></pre>
  </main>
  <script>
    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");
    const params = new URLSearchParams(location.hash.slice(1));
    const setup = params.get("setup") || "";
    const returnUrl = params.get("return") || ${JSON.stringify(hostedAppUrl({ connected: "1", bridgePort: PORT }))};
    const fail = (message) => {
      statusEl.textContent = "Could not sync this computer.";
      errorEl.hidden = false;
      errorEl.textContent = message;
    };
    (async () => {
      if (!setup) {
        fail("Missing setup payload. Go back to Vlix and click Sync this computer again.");
        return;
      }
      try {
        const response = await fetch("/api/cloud/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setup })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Local bridge returned " + response.status);
        statusEl.innerHTML = "This computer is synced. Returning to Vlix...";
        setTimeout(() => location.replace(returnUrl), 550);
      } catch (error) {
        fail(error && error.message ? error.message : String(error));
      }
    })();
  </script>
</body>
</html>`;

const hostedAppUrl = (params = {}) => {
  const url = new URL(PUBLIC_APP_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
};

const hostedDesktopSetupUrl = () => hostedAppUrl({ desktop: "1", bridgePort: PORT });
const startupBrowserUrl = () =>
  process.env.VLIX_OPEN_LOCAL === "1" ? localOrigin() : hostedDesktopSetupUrl();

const sha256Hex = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

const bridgeAccountName = () => `${os.userInfo().username || "User"}'s Vlix Bridge`;

const publicBridgeAccount = (account) => {
  if (!account) return null;
  const integrationStatus =
    account.integrationStatus || (account.desktopDevice?.id ? "CONNECTED" : "NOT_INTEGRATED");
  return {
    accountId: account.accountId,
    displayName: account.displayName,
    integrationStatus,
    hasAccountQr: Boolean(account.accountQrToken),
    createdAt: account.createdAt,
    desktopDevice: account.desktopDevice || null,
    isolated: !account.legacyCodexAccess,
    sessionCount: Array.isArray(account.sessionIds) ? account.sessionIds.length : 0,
    workspaceCount: Array.isArray(account.workspacePaths) ? account.workspacePaths.length : 0,
    syncedAt: account.syncedAt || null,
  };
};

const safeAccountId = (accountId) => {
  const clean = String(accountId || "").trim();
  return /^acct_[A-Za-z0-9_-]{8,}$/.test(clean) ? clean : "";
};

const accountStorageFile = (accountId) => {
  const safe = safeAccountId(accountId);
  return safe ? path.join(BRIDGE_ACCOUNTS_ROOT, safe, "account.json") : null;
};

const uniqueStrings = (values) => [
  ...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean)),
];

const normalizeBridgeAccount = (account = {}) => {
  const createdAt = account.createdAt || new Date().toISOString();
  const desktopDevice = account.desktopDevice?.id
    ? {
        id: String(account.desktopDevice.id),
        name: account.desktopDevice.name || os.hostname() || "Desktop agent",
        createdAt: account.desktopDevice.createdAt || createdAt,
        lastSeenAt: account.desktopDevice.lastSeenAt || createdAt,
      }
    : null;
  const integrationStatus =
    account.integrationStatus || (desktopDevice ? "CONNECTED" : "NOT_INTEGRATED");
  return {
    ...account,
    accountId:
      safeAccountId(account.accountId) || `acct_${crypto.randomBytes(9).toString("base64url")}`,
    displayName: compact(account.displayName || bridgeAccountName(), 80) || bridgeAccountName(),
    integrationStatus,
    accountQrToken: account.accountQrToken || crypto.randomBytes(24).toString("base64url"),
    createdAt,
    desktopDevice,
    sessionIds: uniqueStrings(account.sessionIds),
    workspacePaths: uniqueStrings(account.workspacePaths).map((workspace) =>
      path.normalize(workspace),
    ),
    syncedAt: account.syncedAt || null,
    legacyCodexAccess: Boolean(account.legacyCodexAccess),
  };
};

const writeBridgeAccount = (account, options = {}) => {
  const normalized = normalizeBridgeAccount(account);
  if (options.makeActive !== false) writeJsonFile(BRIDGE_ACCOUNT_FILE, normalized);
  const accountFile = accountStorageFile(normalized.accountId);
  if (accountFile) writeJsonFile(accountFile, normalized);
  return normalized;
};

const readBridgeAccount = () => {
  const account = readJsonFile(BRIDGE_ACCOUNT_FILE);
  if (!account) return null;
  const normalized = normalizeBridgeAccount(account);
  if (JSON.stringify(account) !== JSON.stringify(normalized)) return writeBridgeAccount(normalized);
  const accountFile = accountStorageFile(normalized.accountId);
  if (accountFile && !fs.existsSync(accountFile)) writeJsonFile(accountFile, normalized);
  return normalized;
};

const readStoredBridgeAccountById = (accountId) => {
  const accountFile = accountStorageFile(accountId);
  const stored = accountFile ? readJsonFile(accountFile) : null;
  if (stored) {
    const normalized = normalizeBridgeAccount(stored);
    if (JSON.stringify(stored) !== JSON.stringify(normalized))
      writeBridgeAccount(normalized, { makeActive: false });
    return normalized;
  }

  const active = readBridgeAccount();
  if (active?.accountId === accountId) return active;
  return null;
};

const saveBridgeAccountSnapshot = (account) => {
  if (!account?.accountId) return;
  writeJsonFile(
    path.join(BRIDGE_SAVED_ACCOUNTS_ROOT, `${account.accountId}.json`),
    normalizeBridgeAccount(account),
  );
};

const createBridgeAccount = (displayName = bridgeAccountName(), options = {}) => {
  const createdAt = new Date().toISOString();
  const connectDesktop = options.connectDesktop !== false;
  const account = {
    accountId: `acct_${crypto.randomBytes(9).toString("base64url")}`,
    displayName: compact(displayName, 80) || bridgeAccountName(),
    integrationStatus: connectDesktop ? "CONNECTED" : "NOT_INTEGRATED",
    accountQrToken: crypto.randomBytes(24).toString("base64url"),
    createdAt,
    desktopDevice: connectDesktop
      ? {
          id: `desk_${crypto.randomBytes(9).toString("base64url")}`,
          name: os.hostname() || "Desktop agent",
          createdAt,
          lastSeenAt: createdAt,
        }
      : null,
    sessionIds: [],
    workspacePaths: [],
    syncedAt: null,
    legacyCodexAccess: Boolean(options.legacyCodexAccess),
  };
  return writeBridgeAccount(account, { makeActive: options.makeActive !== false });
};

const ensureBridgeAccount = () => {
  const account = readBridgeAccount();
  return account || createBridgeAccount();
};

const isBridgeAccountIntegrated = (account) =>
  Boolean(account?.desktopDevice?.id) && (account.integrationStatus || "CONNECTED") === "CONNECTED";

const accountFromAuth = (auth) => {
  if (auth?.pairing?.accountId) return readStoredBridgeAccountById(auth.pairing.accountId);
  return ensureBridgeAccount();
};

const ensureAccountQrToken = (account) => {
  if (!account) return null;
  if (!account.accountQrToken) {
    account.accountQrToken = crypto.randomBytes(24).toString("base64url");
  }
  const active = readJsonFile(BRIDGE_ACCOUNT_FILE);
  const normalized = writeBridgeAccount(account, {
    makeActive: active?.accountId === account.accountId,
  });
  Object.assign(account, normalized);
  return account.accountQrToken;
};

const accountQrUrl = (req, account) => {
  ensureAccountQrToken(account);
  return hostedAppUrl();
};

const createAccountQr = async (req, account = ensureBridgeAccount()) => {
  const url = accountQrUrl(req, account);
  const qr = await QRCode.toDataURL(url, {
    width: 220,
    margin: 2,
    color: { dark: "#111111", light: "#ffffff" },
  });
  return { account: publicBridgeAccount(account), url, qr };
};

const publicAccountFromSetupToken = (accountId, setupToken) => {
  const account = readStoredBridgeAccountById(accountId);
  if (!account || account.accountId !== accountId || account.accountQrToken !== setupToken)
    return null;
  return publicBridgeAccount(account);
};

const githubNpxTarget = () => {
  const match = BRIDGE_REPO_URL.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i);
  return match ? `github:${match[1]}` : BRIDGE_REPO_URL;
};

const bridgeInfo = (req, account = readBridgeAccount()) => ({
  name: PACKAGE_NAME,
  version: packageJson.version || "0.0.0",
  repoUrl: BRIDGE_REPO_URL,
  codexHome: CODEX_HOME,
  codexBinary: findCodexBinary(),
  codexBinaryExists: findCodexBinary() !== "codex" || Boolean(process.env.PATH),
  host: HOST,
  port: PORT,
  localUrl: localOrigin(),
  phoneUrl: PUBLIC_APP_URL,
  account: publicBridgeAccount(account),
  appServer: codexAppServer.status,
  cloud: {
    ...cloudSyncState,
    hasConfig: Boolean(cloudConfig()),
  },
  install: {
    npm: "npm create vlix@latest",
    github: `npx ${githubNpxTarget()}`,
    git: `git clone ${BRIDGE_REPO_URL} && cd ${path.basename(BRIDGE_REPO_URL)} && npm install && npm start`,
    codexPrompt: `Install and run Vlix from ${BRIDGE_REPO_URL}. Start it, open ${localOrigin()}, and walk me through pairing my phone.`,
  },
});

const openUrl = (url) => {
  const platform = process.platform;
  const macChromePaths = [
    "/Applications/Google Chrome.app",
    path.join(os.homedir(), "Applications", "Google Chrome.app"),
  ];
  const useChrome = platform === "darwin" && macChromePaths.some((item) => fs.existsSync(item));
  if (useChrome) {
    const child = spawn(
      "osascript",
      ["-e", `tell application "Google Chrome" to open location ${JSON.stringify(url)}`],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return;
  }
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args =
    platform === "win32"
      ? ["/c", "start", "", url]
      : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
};

const probeExistingBridge = (port) =>
  new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/api/bridge/info", timeout: 2500 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 12_000) req.destroy();
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(false);
            return;
          }
          try {
            const info = JSON.parse(body);
            resolve(info?.name === PACKAGE_NAME);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });

const createCloudPairing = async (config, account = ensureBridgeAccount()) => {
  const token = crypto.randomBytes(24).toString("base64url");
  const phoneDeviceId = `phone_${crypto.randomBytes(9).toString("base64url")}`;
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + PAIRING_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();
  await cloudTable(config, "bridge_pairing_codes", "", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: {
      account_id: config.accountId,
      code_hash: sha256Hex(token),
      expires_at: expiresAt,
    },
  });
  const url = hostedAppUrl({ pair: token, phone: "1" });
  const qr = await QRCode.toDataURL(url, {
    width: 248,
    margin: 2,
    color: { dark: "#111111", light: "#ffffff" },
  });
  return {
    token,
    url,
    qr,
    cloud: true,
    accountId: config.accountId,
    account: publicBridgeAccount(account),
    desktopDeviceId:
      account.desktopDevice?.id || cloudSyncState.deviceId || stableCloudDeviceId(config.accountId),
    phoneDeviceId,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt,
    expiresAtMs,
    lastSeenAt: null,
  };
};

const createPairing = async (req, account = ensureBridgeAccount()) => {
  cleanupPairings();
  const config = cloudConfig();
  if (config) return createCloudPairing(config, account);
  if (process.env.VLIX_ALLOW_LAN_PAIRING !== "1") {
    throw new Error(
      "Phone pairing requires the cloud bridge. Run the VLIX_BRIDGE_SETUP command from the hosted Vlix website, then pair again.",
    );
  }

  const token = crypto.randomBytes(24).toString("base64url");
  const phoneDeviceId = `phone_${crypto.randomBytes(9).toString("base64url")}`;
  const createdAtMs = Date.now();
  const expiresAtMs = createdAtMs + PAIRING_TTL_MS;
  const url = `${pairingOrigin(req)}/?pair=${encodeURIComponent(token)}&phone=1`;
  const qr = await QRCode.toDataURL(url, {
    width: 248,
    margin: 2,
    color: { dark: "#111111", light: "#ffffff" },
  });
  const pairing = {
    token,
    url,
    qr,
    accountId: account.accountId,
    account: publicBridgeAccount(account),
    desktopDeviceId: account.desktopDevice.id,
    phoneDeviceId,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    lastSeenAt: null,
  };
  pairings.set(token, pairing);
  return pairing;
};

const integrationRequired = (account = readBridgeAccount()) => ({
  integrationRequired: true,
  account: publicBridgeAccount(account),
  codexBridge: codexAppServer.status,
  message: "This bridge account is not integrated with a desktop yet.",
});

const handleUnintegratedAccountRoute = (req, res, reqUrl, account) => {
  const base = integrationRequired(account);
  const pathname = reqUrl.pathname;
  const method = req.method;

  if (method === "GET" && pathname === "/api/chats") {
    send(res, 200, { ...base, chats: [], codexHome: CODEX_HOME });
    return true;
  }
  if (method === "GET" && pathname === "/api/browser-sessions") {
    send(res, 200, { ...base, sessions: [] });
    return true;
  }
  if (method === "GET" && pathname === "/api/automations") {
    send(res, 200, { ...base, automations: [] });
    return true;
  }
  if (method === "GET" && pathname === "/api/workspaces") {
    send(res, 200, { ...base, workspaces: [] });
    return true;
  }
  if (
    (method === "GET" && /^\/api\/chats\/[^/]+$/.test(pathname)) ||
    (method === "POST" && /^\/api\/chats\/[^/]+\/send$/.test(pathname)) ||
    (method === "POST" && pathname === "/api/chats/send-new")
  ) {
    send(res, 409, {
      ...base,
      error:
        "This fresh bridge account is not connected to a desktop bridge yet, so it cannot read or message chats.",
    });
    return true;
  }
  return false;
};

const safePath = (pathname) => {
  const rawPath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.normalize(path.join(ROOT, rawPath));
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
};

const readJsonl = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

const readJsonObjectLines = (source) =>
  String(source || "")
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const readFileTail = (filePath, bytes = 96 * 1024) => {
  if (!fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  const size = Math.min(stat.size, bytes);
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, size, stat.size - size);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const firstBreak = text.indexOf("\n");
  return stat.size > size && firstBreak >= 0 ? text.slice(firstBreak + 1) : text;
};

const readFirstJsonLine = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks = [];
    const chunkSize = 64 * 1024;
    const maxBytes = 2 * 1024 * 1024;
    let offset = 0;
    while (offset < maxBytes) {
      const buffer = Buffer.alloc(chunkSize);
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (!read) break;
      const newline = buffer.indexOf(10, 0);
      if (newline >= 0 && newline < read) {
        chunks.push(buffer.subarray(0, newline));
        break;
      }
      chunks.push(buffer.subarray(0, read));
      offset += read;
    }
    const firstLine = Buffer.concat(chunks).toString("utf8");
    return firstLine ? JSON.parse(firstLine) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
};

const readSessionRecords = (filePath, { tailBytes = CHAT_DETAIL_TAIL_BYTES } = {}) => {
  if (!fs.existsSync(filePath)) return { records: [], partial: false };
  const stat = fs.statSync(filePath);
  const partial = Boolean(tailBytes && stat.size > tailBytes);
  const source = partial ? readFileTail(filePath, tailBytes) : fs.readFileSync(filePath, "utf8");
  const records = readJsonObjectLines(source);
  if (partial) {
    const first = readFirstJsonLine(filePath);
    if (first?.type === "session_meta") records.unshift(first);
  }
  return { records, partial };
};

const readActiveSessionRecords = (filePath) =>
  readSessionRecords(filePath, { tailBytes: ACTIVE_SESSION_TAIL_BYTES }).records;

const walk = (dir, matcher, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, matcher, out);
    else if (matcher(full, entry.name)) out.push(full);
  }
  return out;
};

const sessionFiles = () => [
  ...walk(SESSION_ROOT, (_full, name) => name.endsWith(".jsonl")),
  ...walk(ARCHIVE_ROOT, (_full, name) => name.endsWith(".jsonl")),
];

const sessionFolder = (file) => {
  if (!file) return "unlinked";
  if (file.startsWith(SESSION_ROOT)) return path.dirname(path.relative(SESSION_ROOT, file));
  if (file.startsWith(ARCHIVE_ROOT))
    return `archived/${path.dirname(path.relative(ARCHIVE_ROOT, file))}`;
  return path.dirname(file);
};

const formatFolderLabel = (folder) => {
  if (!folder || folder === "." || folder === "unlinked") return "Unlinked";
  const parts = folder.split(path.sep).filter(Boolean);
  if (parts[0] === "archived") {
    const rest = parts.slice(1).filter((part) => part !== ".");
    return `Archived / ${rest.join(" / ") || "sessions"}`;
  }
  if (parts.length >= 3) return `${parts[0]} / ${parts[1]} / ${parts[2]}`;
  return parts.join(" / ");
};

const projectFromCwd = (cwd, folder) => {
  if (!cwd) {
    return {
      projectKey: folder || "codex-sessions",
      projectLabel: folder?.startsWith("archived") ? "Archived sessions" : "Sessions",
    };
  }

  const clean = path.normalize(cwd);
  const label = path.basename(clean) || clean;
  const parent = path.basename(path.dirname(clean));

  return {
    projectKey: clean,
    projectLabel: parent && parent !== "/" ? label : clean,
  };
};

const sessionFileById = () => {
  const map = new Map();
  for (const file of sessionFiles()) {
    const match = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (match) map.set(match[1], file);
  }
  return map;
};

const textFromContent = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part.text || part.input_text || part.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
};

const normalizeAttachment = (value, index = 0) => {
  if (!value) return null;
  if (typeof value === "string") {
    const src = value.startsWith("data:image/")
      ? value
      : `/api/attachment?path=${encodeURIComponent(value)}`;
    return { kind: "image", src, label: `Image ${index + 1}` };
  }
  const src =
    value.url ||
    value.image_url ||
    value.path ||
    value.file_path ||
    value.local_path ||
    value.data ||
    value.data_url ||
    "";
  if (!src) return null;
  return {
    kind: "image",
    src:
      String(src).startsWith("data:image/") || /^https?:\/\//i.test(String(src))
        ? String(src)
        : `/api/attachment?path=${encodeURIComponent(src)}`,
    label: value.name || value.file_name || value.label || `Image ${index + 1}`,
  };
};

const messageAttachmentsFromPayload = (payload = {}) =>
  [...(payload.images || []), ...(payload.local_images || [])]
    .map(normalizeAttachment)
    .filter(Boolean);

const messageAttachmentsFromContent = (content) =>
  (Array.isArray(content) ? content : [])
    .map((part, index) => {
      if (!part || typeof part === "string") return null;
      if (!String(part.type || "").includes("image") && !part.image_url && !part.path) return null;
      return normalizeAttachment(part.image_url || part.url || part.path || part, index);
    })
    .filter(Boolean);

const mergeAttachments = (current = [], next = []) => {
  const bySrc = new Map();
  for (const item of [...current, ...next]) {
    if (item?.src && !bySrc.has(item.src)) bySrc.set(item.src, item);
  }
  return [...bySrc.values()];
};

const stripPlainTextMarkdownFences = (text) =>
  String(text || "")
    .replace(/(^|\n)```(?:text|plaintext|txt)[ \t]*\n([\s\S]*?)\n```(?=\n|$)/gi, "$1$2")
    .replace(/(^|\n)``(?:text|plaintext|txt)[ \t]*\n([\s\S]*?)\n``(?=\n|$)/gi, "$1$2")
    .replace(/(^|\n)```(?:text|plaintext|txt)[ \t]*(?=\n|$)/gi, "$1")
    .replace(/(^|\n)``(?:text|plaintext|txt)[ \t]*(?=\n|$)/gi, "$1")
    .trim();

const stripImagePlaceholders = (text) =>
  String(text || "")
    .replace(/(^|\n)<image\b[^>]*>\s*<\/image>(?=\n|$)/gi, "$1")
    .replace(/(^|\n)<image\b[\s\S]*?<\/image>(?=\n|$)/gi, "$1")
    .trim();

const normalizeInboundAttachments = (attachments = []) =>
  (Array.isArray(attachments) ? attachments : [])
    .slice(0, 6)
    .map((item, index) => {
      const src = String(item?.src || item?.dataUrl || item?.data_url || "");
      if (!src.startsWith("data:image/") || src.length > 11_000_000) return null;
      return {
        kind: "image",
        src,
        label: String(item?.label || item?.name || `Image ${index + 1}`).slice(0, 120),
        type: String(item?.type || "").slice(0, 80),
        size: Number(item?.size || 0) || 0,
      };
    })
    .filter(Boolean);

const persistAttachmentFiles = (task) => {
  const localImages = [];
  if (!task.attachments?.length) return localImages;
  const taskDir = path.join(BRIDGE_UPLOADS_ROOT, task.id);
  fs.mkdirSync(taskDir, { recursive: true });
  task.attachments = task.attachments
    .map((attachment, index) => {
      const match = String(attachment.src || "").match(
        /^data:(image\/(?:png|jpe?g|gif|webp));base64,([\s\S]+)$/i,
      );
      if (!match) return attachment;
      const mime = match[1].toLowerCase();
      const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.split("/")[1];
      const filePath = path.join(taskDir, `image-${index + 1}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
      localImages.push(filePath);
      return { ...attachment, localPath: filePath };
    })
    .filter(Boolean);
  return localImages;
};

const compact = (text, max = 220) => {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}...`;
};

const compactBlock = (text, max = 1800) => {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 4).trimEnd()}\n...`;
};

const latestIso = (...values) => {
  let latest = 0;
  for (const value of values) {
    const time = Date.parse(value || "");
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest ? new Date(latest).toISOString() : "";
};

const isVisibleChatText = (text) => {
  const clean = String(text || "").trim();
  if (!clean) return false;
  return ![
    "<subagent_notification>",
    "<environment_context>",
    "<turn_aborted>",
    "# AGENTS.md instructions",
    "<permissions instructions>",
    "<collaboration_mode>",
  ].some((prefix) => clean.startsWith(prefix));
};

const stripInjectedUserContext = (text) => {
  const clean = String(text || "").trim();
  const requestMarker = "## My request for Codex:";
  const requestIndex = clean.lastIndexOf(requestMarker);
  if (requestIndex >= 0) return clean.slice(requestIndex + requestMarker.length).trim();
  return clean;
};

const visibleMessageText = (role, text) => {
  const clean = String(text || "").trim();
  const visible = role === "user" ? stripInjectedUserContext(clean) : clean;
  return stripImagePlaceholders(stripPlainTextMarkdownFences(visible));
};

const parseToolArguments = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const stripMarkdownShell = (text) =>
  String(text || "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .trim();

const isTurnTerminalEvent = (type) =>
  ["task_complete", "turn_aborted", "turn_completed", "turn_stopped", "turn_interrupted"].includes(
    type,
  );

const reasoningSummaryText = (summary) =>
  (Array.isArray(summary) ? summary : [])
    .map((item) => stripMarkdownShell(item.text || item.summary_text || ""))
    .filter(Boolean)
    .join("\n");

const durationMs = (duration = {}) => {
  if (!duration || typeof duration !== "object") return null;
  const secs = Number(duration.secs || 0);
  const nanos = Number(duration.nanos || 0);
  const ms = secs * 1000 + Math.round(nanos / 1_000_000);
  return Number.isFinite(ms) ? ms : null;
};

const contentItemsText = (items = []) =>
  (Array.isArray(items) ? items : [])
    .map((item) => item.text || item.inputText || item.outputText || "")
    .filter(Boolean)
    .join("\n");

const callEndMeta = (payload = {}) => ({
  status:
    payload.status ||
    (payload.success === false ? "failed" : payload.success === true ? "completed" : ""),
  exitCode: typeof payload.exit_code === "number" ? payload.exit_code : null,
  durationMs: durationMs(payload.duration),
});

const agentStatusKind = (status = {}) => {
  if (!status || typeof status !== "object") return "updated";
  if (status.completed) return "completed";
  if (status.failed || status.error) return "failed";
  if (status.running) return "running";
  if (status.queued || status.pending) return "queued";
  return "updated";
};

const agentStatusText = (status = {}) => {
  if (typeof status === "string") return status;
  if (!status || typeof status !== "object") return "";
  if (typeof status.completed === "string") return status.completed;
  if (typeof status.failed === "string") return status.failed;
  if (typeof status.error === "string") return status.error;
  if (typeof status.running === "string") return status.running;
  const entries = Object.entries(status).filter(
    ([, value]) => value !== null && value !== undefined && value !== false,
  );
  if (!entries.length) return "";
  return JSON.stringify(Object.fromEntries(entries), null, 2);
};

const agentDetails = ({ nickname, role, threadId, model, reasoningEffort, prompt }) =>
  [
    nickname ? `Agent: ${nickname}` : "",
    role ? `Role: ${role}` : "",
    threadId ? `Thread: ${threadId}` : "",
    model ? `Model: ${model}` : "",
    reasoningEffort ? `Reasoning: ${reasoningEffort}` : "",
    prompt ? "\nPrompt:" : "",
    prompt || "",
  ]
    .filter(Boolean)
    .join("\n");

const patchFileList = (patch) => {
  const files = [];
  const source = String(patch || "");
  for (const match of source.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm)) {
    files.push(match[1].trim());
  }
  return uniqueStrings(files);
};

const commandTarget = (cmd = "") => {
  const clean = String(cmd || "").trim();
  const sedMatch = clean.match(/\bsed\s+-n\s+['"][^'"]+['"]\s+(.+)$/);
  if (sedMatch) return sedMatch[1].trim().split(/\s+/).at(-1) || "";
  const catMatch = clean.match(/\b(?:cat|nl\s+-ba)\s+(.+)$/);
  if (catMatch) return catMatch[1].trim().split(/\s+/).at(-1) || "";
  const rgMatch = clean.match(/\brg\s+(?:-[^\s]+\s+)*['"]?([^'"\s][^'"]*?)['"]?(?:\s|$)/);
  if (rgMatch && !/^-/.test(rgMatch[1])) return rgMatch[1].trim();
  return "";
};

const summarizeToolCall = (payload = {}) => {
  const name = payload.name || "tool";
  const namespace = payload.namespace || "";
  const args = parseToolArguments(payload.arguments);
  const input = payload.input || args.input || args.patch || "";

  if (name === "apply_patch") {
    const files = patchFileList(input);
    return {
      kind: "edit",
      label: files.length === 1 ? "Edited file" : "Edited files",
      text: files.length ? files.join("\n") : "Applied patch",
      toolName: name,
      namespace,
      callId: payload.call_id || "",
    };
  }

  if (["exec_command", "shell_command"].includes(name)) {
    const cmd = args.cmd || args.command || name;
    const target = commandTarget(cmd);
    if (/\brg\s+--files\b|\bfind\b|\bls\b/.test(cmd)) {
      return {
        kind: "explore",
        label: "Explored files",
        text: compact(cmd, 320),
        toolName: name,
        namespace,
        callId: payload.call_id || "",
      };
    }
    if (/\brg\b|\bgrep\b/.test(cmd)) {
      return {
        kind: "search",
        label: target ? `Searched for ${target}` : "Searched code",
        text: compact(cmd, 320),
        toolName: name,
        namespace,
        callId: payload.call_id || "",
      };
    }
    if (/\b(sed|cat|nl)\b/.test(cmd)) {
      return {
        kind: "read",
        label: target ? `Read ${path.basename(target)}` : "Read file",
        text: compact(cmd, 320),
        toolName: name,
        namespace,
        callId: payload.call_id || "",
      };
    }
    return {
      kind: "command",
      label: "Ran command",
      text: compact(cmd, 320),
      toolName: name,
      namespace,
      callId: payload.call_id || "",
    };
  }

  if (name === "write_stdin") {
    return {
      kind: "command",
      label: "Updated running command",
      text: args.chars ? compact(args.chars, 180) : "Checked running command output",
      toolName: name,
      namespace,
      callId: payload.call_id || "",
    };
  }

  if (name === "js") {
    const title = args.title || "";
    const code = String(args.code || "");
    const isBrowserUse =
      /agent\.browser|tab\.playwright|domSnapshot|screenshot|get_visible_screenshot/.test(code);
    return {
      kind: isBrowserUse ? "browser" : "tool",
      label: title || (isBrowserUse ? "Used browser" : "Ran JavaScript"),
      text: compact(code, 320),
      toolName: name,
      namespace,
      callId: payload.call_id || "",
    };
  }

  if (name === "update_plan") {
    return {
      kind: "plan",
      label: "Updated plan",
      text: "",
      toolName: name,
      namespace,
      callId: payload.call_id || "",
    };
  }

  if (
    name.includes("browser") ||
    name.includes("playwright") ||
    ["get_app_state", "click", "type_text", "press_key", "set_value"].includes(name)
  ) {
    return {
      kind: "browser",
      label: "Used browser",
      text: compact(args.url || args.app || input || name, 220),
      toolName: name,
      namespace,
      callId: payload.call_id || "",
    };
  }

  return {
    kind: "tool",
    label: `Used ${name}`,
    text: compact(args.cmd || args.command || input || "", 220),
    toolName: name,
    namespace,
    callId: payload.call_id || "",
  };
};

const outputText = (payload = {}) => {
  const raw =
    typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output || "");
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.output === "string") return parsed.output;
    if (typeof parsed.text === "string") return parsed.text;
  } catch {
    return raw;
  }
  return raw;
};

const summarizeToolOutput = (payload = {}, toolName = "tool", meta = {}) => {
  const text = compactBlock(outputText(payload), toolName === "exec_command" ? 2200 : 1600);
  const isCommand = ["exec_command", "shell_command", "write_stdin"].includes(toolName);
  const status = meta.status || "";
  const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : null;
  const failed = status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
  if (isCommand) {
    return {
      kind: "command-output",
      label: failed ? "Command failed" : text ? "Command output" : "Command finished",
      text,
      toolName,
      status,
      exitCode,
      durationMs: meta.durationMs ?? null,
      callId: payload.call_id || "",
    };
  }
  if (toolName === "apply_patch") {
    return {
      kind: "tool-output",
      label: failed ? "Patch failed" : text ? "Patch result" : "Patch applied",
      text,
      toolName,
      status,
      exitCode,
      durationMs: meta.durationMs ?? null,
      callId: payload.call_id || "",
    };
  }
  return {
    kind: "tool-output",
    label: failed ? "Tool failed" : text ? "Tool output" : "Tool finished",
    text,
    toolName,
    status,
    exitCode,
    durationMs: meta.durationMs ?? null,
    callId: payload.call_id || "",
  };
};

const parseSessionMessages = (filePath) => {
  const messages = [];
  const timeline = [];
  let meta = {};
  const callNames = new Map();
  const callEnds = new Map();
  const seenMessages = new Map();
  const seenEvents = new Set();
  const seenAgentResults = new Set();
  const turnSources = new Map();
  let currentTurnId = "";
  let lastTimelineKind = "";

  const sourceForTurn = () => turnSources.get(currentTurnId) || "";
  const userMessageSource = (text) =>
    /# In app browser:|<app-context>|<environment_context>|# Files mentioned by the user:/i.test(
      String(text || ""),
    )
      ? "desktop"
      : "bridge";

  const addMessage = (
    role,
    text,
    timestamp,
    phase = null,
    attachments = [],
    source = sourceForTurn(),
  ) => {
    const clean = visibleMessageText(role, text);
    const visibleAttachments = mergeAttachments([], attachments);
    if (!isVisibleChatText(clean) && !visibleAttachments.length) return;
    const second = Math.floor(Date.parse(timestamp || "") / 1000) || messages.length;
    const key = `${role}|${second}|${clean}`;
    const existing = seenMessages.get(key);
    if (existing) {
      existing.attachments = mergeAttachments(existing.attachments, visibleAttachments);
      if (!existing.source && source) existing.source = source;
      return;
    }
    const message = {
      id: `${timestamp}-${messages.length}`,
      kind: "message",
      role,
      phase,
      timestamp,
      text: clean,
      attachments: visibleAttachments,
      source,
    };
    seenMessages.set(key, message);
    messages.push(message);
    timeline.push(message);
    lastTimelineKind = "message";
  };

  const addTimelineEvent = (event) => {
    const kind = event.kind || "event";
    const key = `${kind}|${event.status || ""}|${event.callId || ""}|${event.timestamp || ""}|${event.label || ""}|${event.text || ""}`;
    if (seenEvents.has(key)) return false;
    seenEvents.add(key);
    timeline.push({
      id: `${event.timestamp}-${timeline.length}`,
      source: sourceForTurn(),
      ...event,
    });
    lastTimelineKind = kind;
    return true;
  };

  const addAgentResultEvent = ({ timestamp, callId, threadId, nickname, role, status }) => {
    const body = agentStatusText(status);
    const statusKind = agentStatusKind(status);
    const resultKey = `${threadId || nickname || callId}|${statusKind}|${body}`;
    if (seenAgentResults.has(resultKey)) return;
    seenAgentResults.add(resultKey);
    addTimelineEvent({
      kind: "agent-result",
      status: statusKind,
      timestamp,
      label: nickname ? `${nickname} report` : "Agent report",
      text: body ? compact(body, 280) : statusKind,
      details: body,
      toolName: "agent",
      callId: callId || "",
      agentId: threadId || "",
      agentNickname: nickname || "",
      agentRole: role || "",
    });
  };

  const { records, partial } = readSessionRecords(filePath);
  if (partial) {
    addTimelineEvent({
      kind: "history",
      timestamp: records.find((record) => record.timestamp)?.timestamp || "",
      label: "Earlier items hidden",
      text: "This local session file is very large, so the bridge is showing the latest part of the thread for a fast live view.",
    });
  }
  const outputCallIds = new Set(
    records
      .filter(
        (item) =>
          item.type === "response_item" &&
          ["function_call_output", "custom_tool_call_output"].includes(item.payload?.type),
      )
      .map((item) => item.payload?.call_id)
      .filter(Boolean),
  );

  for (const item of records) {
    if (item.type === "session_meta") {
      meta = item.payload || {};
      continue;
    }

    if (item.type === "compacted") {
      addTimelineEvent({
        kind: "compact",
        timestamp: item.timestamp,
        label: "Context compacted",
        text: "Older conversation history was compacted so the session could continue.",
      });
      continue;
    }

    if (item.type === "turn_context") {
      currentTurnId = item.payload?.turn_id || currentTurnId;
      const developerText =
        item.payload?.developer_instructions ||
        item.payload?.collaboration_mode?.settings?.developer_instructions ||
        "";
      if (
        currentTurnId &&
        /Codex desktop context|In app browser|app-context/i.test(String(developerText))
      ) {
        turnSources.set(currentTurnId, "desktop");
      }
      continue;
    }

    if (item.type === "event_msg") {
      const payload = item.payload || {};
      if (payload.type === "task_started") {
        currentTurnId = payload.turn_id || currentTurnId;
        addTimelineEvent({
          kind: "task",
          status: "started",
          timestamp: item.timestamp,
          label: "Started working",
          text: "",
          turnId: payload.turn_id || "",
        });
      } else if (payload.type === "task_complete") {
        currentTurnId = payload.turn_id || currentTurnId;
        addTimelineEvent({
          kind: "task",
          status: "complete",
          timestamp: item.timestamp,
          label: "Finished",
          text: compactBlock(payload.last_agent_message || "", 1200),
          turnId: payload.turn_id || "",
        });
      } else if (payload.type === "turn_aborted") {
        currentTurnId = payload.turn_id || currentTurnId;
        addTimelineEvent({
          kind: "task",
          status: "aborted",
          timestamp: item.timestamp,
          label: "Stopped",
          text: payload.reason || "Turn stopped before completion.",
          turnId: payload.turn_id || "",
        });
      } else if (payload.type === "error") {
        addTimelineEvent({
          kind: "error",
          timestamp: item.timestamp,
          label: "Error",
          text: payload.message || "",
        });
      } else if (payload.type === "collab_agent_spawn_end") {
        addTimelineEvent({
          kind: "agent",
          status: payload.status || "started",
          timestamp: item.timestamp,
          label: payload.new_agent_nickname || "Agent",
          text: compact(payload.prompt || "", 280),
          details: agentDetails({
            nickname: payload.new_agent_nickname || "",
            role: payload.new_agent_role || "",
            threadId: payload.new_thread_id || "",
            model: payload.model || "",
            reasoningEffort: payload.reasoning_effort || "",
            prompt: payload.prompt || "",
          }),
          toolName: "agent",
          callId: payload.call_id || "",
          agentId: payload.new_thread_id || "",
          agentNickname: payload.new_agent_nickname || "",
          agentRole: payload.new_agent_role || "",
          model: payload.model || "",
          reasoningEffort: payload.reasoning_effort || "",
        });
      } else if (payload.type === "collab_waiting_end") {
        const agentStatuses = Array.isArray(payload.agent_statuses)
          ? payload.agent_statuses
          : Object.entries(payload.statuses || {}).map(([thread_id, status]) => ({
              thread_id,
              status,
            }));
        for (const agent of agentStatuses) {
          addAgentResultEvent({
            timestamp: item.timestamp,
            callId: payload.call_id || "",
            threadId: agent.thread_id || "",
            nickname: agent.agent_nickname || "",
            role: agent.agent_role || "",
            status: agent.status || {},
          });
        }
      } else if (payload.type === "collab_close_end") {
        addAgentResultEvent({
          timestamp: item.timestamp,
          callId: payload.call_id || "",
          threadId: payload.receiver_thread_id || "",
          nickname: payload.receiver_agent_nickname || "",
          role: payload.receiver_agent_role || "",
          status: payload.status || {},
        });
      } else if (payload.type === "agent_message") {
        addMessage(
          "assistant",
          payload.message || "",
          item.timestamp,
          payload.phase || "commentary",
        );
      } else if (payload.type === "user_message") {
        const inferredSource = userMessageSource(payload.message || "");
        if (currentTurnId) turnSources.set(currentTurnId, inferredSource);
        addMessage(
          "user",
          payload.message || "",
          item.timestamp,
          null,
          messageAttachmentsFromPayload(payload),
          inferredSource,
        );
      } else if (payload.type === "agent_reasoning" && payload.text) {
        addTimelineEvent({
          kind: "reasoning",
          timestamp: item.timestamp,
          label: "Thinking",
          text: compactBlock(stripMarkdownShell(payload.text), 1200),
        });
      } else if (
        [
          "exec_command_end",
          "mcp_tool_call_end",
          "patch_apply_end",
          "dynamic_tool_call_response",
        ].includes(payload.type)
      ) {
        const callId = payload.call_id || payload.callId || "";
        if (callId) callEnds.set(callId, callEndMeta(payload));
        if (callId && !outputCallIds.has(callId)) {
          const toolName =
            payload.tool ||
            payload.invocation?.tool ||
            (payload.type === "patch_apply_end" ? "apply_patch" : "tool");
          const text =
            payload.aggregated_output ||
            payload.formatted_output ||
            payload.stdout ||
            payload.stderr ||
            contentItemsText(payload.content_items) ||
            "";
          addTimelineEvent({
            kind: payload.type === "exec_command_end" ? "command-output" : "tool-output",
            timestamp: item.timestamp,
            label:
              payload.success === false || payload.status === "failed"
                ? "Tool failed"
                : "Tool finished",
            text: compactBlock(text, 1600),
            toolName,
            status: callEnds.get(callId)?.status || "",
            exitCode: callEnds.get(callId)?.exitCode ?? null,
            durationMs: callEnds.get(callId)?.durationMs ?? null,
            callId,
          });
        }
      } else if (payload.type === "dynamic_tool_call_request") {
        const callId = payload.callId || payload.call_id || "";
        if (callId && !outputCallIds.has(callId)) {
          addTimelineEvent({
            kind: "tool",
            timestamp: item.timestamp,
            label: `Used ${payload.tool || "tool"}`,
            text: compact(JSON.stringify(payload.arguments || {}), 260),
            toolName: payload.tool || "tool",
            namespace: payload.namespace || "",
            callId,
          });
        }
      } else if (payload.type === "web_search_end") {
        const callId = payload.call_id || "";
        if (callId && !outputCallIds.has(callId)) {
          addTimelineEvent({
            kind: "search",
            timestamp: item.timestamp,
            label: "Searched web",
            text: compact(payload.query || payload.action?.query || "", 320),
            toolName: "web_search",
            callId,
          });
        }
      }
      continue;
    }

    if (item.type !== "response_item") continue;
    const payload = item.payload || {};

    if (payload.type === "reasoning") {
      const text = reasoningSummaryText(payload.summary);
      if (text || lastTimelineKind !== "reasoning") {
        addTimelineEvent({
          kind: "reasoning",
          timestamp: item.timestamp,
          label: "Thinking",
          text: text ? compactBlock(text, 1200) : "",
        });
      }
      continue;
    }

    if (["function_call", "custom_tool_call"].includes(payload.type)) {
      if (payload.call_id) callNames.set(payload.call_id, payload.name || "tool");
      if (["spawn_agent", "wait_agent", "close_agent", "send_input"].includes(payload.name))
        continue;
      const summary = summarizeToolCall(payload);
      addTimelineEvent({
        timestamp: item.timestamp,
        ...summary,
      });
      continue;
    }

    if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const toolName = callNames.get(payload.call_id) || "tool";
      if (["spawn_agent", "wait_agent", "close_agent", "send_input"].includes(toolName)) continue;
      const summary = summarizeToolOutput(payload, toolName, callEnds.get(payload.call_id) || {});
      addTimelineEvent({
        timestamp: item.timestamp,
        ...summary,
      });
      continue;
    }

    if (payload.type === "web_search_call") {
      const query = payload.action?.query || payload.action?.queries?.[0] || "";
      addTimelineEvent({
        kind: "search",
        timestamp: item.timestamp,
        label: "Searched web",
        text: compact(query, 320),
        toolName: "web_search",
        callId: payload.call_id || "",
      });
      continue;
    }

    if (payload.type === "tool_search_call") {
      const query = payload.arguments?.query || "";
      if (payload.call_id) callNames.set(payload.call_id, "tool_search");
      addTimelineEvent({
        kind: "search",
        timestamp: item.timestamp,
        label: "Searched tools",
        text: compact(query, 320),
        toolName: "tool_search",
        callId: payload.call_id || "",
      });
      continue;
    }

    if (payload.type === "tool_search_output") {
      const tools = (payload.tools || [])
        .flatMap((group) => group.tools || group.name || [])
        .map((tool) => (typeof tool === "string" ? tool : tool.name))
        .filter(Boolean);
      addTimelineEvent({
        kind: "tool-output",
        timestamp: item.timestamp,
        label: "Tool search results",
        text: compactBlock(tools.join("\n"), 1200),
        toolName: "tool_search",
        callId: payload.call_id || "",
      });
      continue;
    }

    if (payload.type !== "message") continue;
    if (!["user", "assistant"].includes(payload.role)) continue;

    addMessage(
      payload.role,
      textFromContent(payload.content),
      item.timestamp,
      payload.phase || null,
      messageAttachmentsFromContent(payload.content),
    );
  }

  return { meta, messages, timeline };
};

const publicSessionMeta = (meta = {}) => ({
  id: meta.id || "",
  timestamp: meta.timestamp || "",
  cwd: meta.cwd || "",
  originator: meta.originator || "",
  cliVersion: meta.cli_version || "",
  source: meta.source || "",
  modelProvider: meta.model_provider || "",
  threadName: meta.thread_name || "",
});

const parseSessionSummary = (filePath) => {
  let meta = {};
  try {
    const first = readFirstJsonLine(filePath);
    if (first?.type === "session_meta") meta = first.payload || {};
    const firstChunk = readFileTail(filePath, 8192);
    const cwdMatch = firstChunk.match(/"cwd":"([^"]+)"/);
    if (!meta.cwd && cwdMatch) meta.cwd = cwdMatch[1].replaceAll("\\/", "/");
  } catch {
    meta = {};
  }

  const tailItems = readJsonObjectLines(readFileTail(filePath));
  let preview = "";
  let messageCount = 0;
  let lastRole = "";
  let lastMessageAt = "";
  let latestEventAt = "";
  let lastTaskStartedAt = "";
  let lastTaskCompleteAt = "";
  let latestMessagePhase = "";

  for (const item of tailItems) {
    if (item.timestamp) latestEventAt = item.timestamp;
    if (item.type === "event_msg") {
      const payload = item.payload || {};
      if (payload.type === "task_started") lastTaskStartedAt = item.timestamp || lastTaskStartedAt;
      if (isTurnTerminalEvent(payload.type))
        lastTaskCompleteAt = item.timestamp || lastTaskCompleteAt;
    }
    if (item.type !== "response_item") continue;
    const payload = item.payload || {};
    if (payload.type !== "message") continue;
    if (!["user", "assistant"].includes(payload.role)) continue;
    const text = visibleMessageText(payload.role, textFromContent(payload.content));
    if (!isVisibleChatText(text)) continue;
    messageCount += 1;
    preview = text;
    lastRole = payload.role;
    lastMessageAt = item.timestamp || lastMessageAt;
    latestMessagePhase = payload.phase || "";
  }

  const stat = fs.statSync(filePath);
  const now = Date.now();
  const lastMessageMs = Date.parse(lastMessageAt || "") || stat.mtimeMs;
  const latestEventMs = Date.parse(latestEventAt || "") || stat.mtimeMs;
  const startedMs = Date.parse(lastTaskStartedAt || "") || 0;
  const completedMs = Date.parse(lastTaskCompleteAt || "") || 0;
  const hasRecentActivity = now - latestEventMs <= OBSERVED_ACTIVE_FILE_MS;
  const hasRecentMessage = now - lastMessageMs <= OBSERVED_ACTIVE_FILE_MS;
  const tailParseIncomplete = !tailItems.length && now - stat.mtimeMs <= ACTIVE_MTIME_FALLBACK_MS;
  const observedToolActivity =
    latestEventMs > lastMessageMs && completedMs < lastMessageMs && hasRecentActivity;
  const observedCommentaryRunning =
    lastRole === "assistant" &&
    latestMessagePhase === "commentary" &&
    completedMs < lastMessageMs &&
    hasRecentMessage;
  const observedTurnRunning =
    (startedMs > completedMs || observedToolActivity || observedCommentaryRunning) &&
    hasRecentActivity;
  const observedPendingUser =
    lastRole === "user" &&
    completedMs < lastMessageMs &&
    now - lastMessageMs <= OBSERVED_PENDING_USER_MS;
  const observedWorking = observedTurnRunning || observedPendingUser || tailParseIncomplete;

  return {
    meta,
    parentThreadId: meta.source?.subagent?.thread_spawn?.parent_thread_id || "",
    agentNickname: meta.agent_nickname || meta.source?.subagent?.thread_spawn?.agent_nickname || "",
    agentRole: meta.agent_role || meta.source?.subagent?.thread_spawn?.agent_role || "",
    messageCount,
    preview: compact(preview),
    lastRole,
    lastMessageAt,
    latestEventAt,
    lastTaskStartedAt,
    lastTaskCompleteAt,
    fileUpdatedAt: stat.mtime.toISOString(),
    observedWorking,
  };
};

const sessionIsActivelyWorking = (sessionId) => {
  const file = sessionFileById().get(String(sessionId || ""));
  if (!file || !fs.existsSync(file)) return false;
  let lastTaskStartedAt = "";
  let lastTaskCompleteAt = "";
  let lastRole = "";
  let lastMessageAt = "";
  let latestMessagePhase = "";
  let latestEventAt = "";

  for (const item of readActiveSessionRecords(file)) {
    if (item.timestamp) latestEventAt = item.timestamp;
    const payload = item.payload || {};
    if (item.type === "event_msg") {
      if (payload.type === "task_started") lastTaskStartedAt = item.timestamp || lastTaskStartedAt;
      if (isTurnTerminalEvent(payload.type))
        lastTaskCompleteAt = item.timestamp || lastTaskCompleteAt;
      if (payload.type === "user_message") {
        lastRole = "user";
        lastMessageAt = item.timestamp || lastMessageAt;
        latestMessagePhase = "";
      }
      if (payload.type === "agent_message") {
        lastRole = "assistant";
        lastMessageAt = item.timestamp || lastMessageAt;
        latestMessagePhase = payload.phase || "";
      }
      continue;
    }
    if (item.type !== "response_item" || payload.type !== "message") continue;
    if (!["user", "assistant"].includes(payload.role)) continue;
    const text = visibleMessageText(payload.role, textFromContent(payload.content));
    if (!isVisibleChatText(text)) continue;
    lastRole = payload.role;
    lastMessageAt = item.timestamp || lastMessageAt;
    latestMessagePhase = payload.phase || "";
  }

  const now = Date.now();
  const latestEventMs = Date.parse(latestEventAt || "") || fs.statSync(file).mtimeMs;
  const lastMessageMs = Date.parse(lastMessageAt || "") || 0;
  const startedMs = Date.parse(lastTaskStartedAt || "") || 0;
  const completedMs = Date.parse(lastTaskCompleteAt || "") || 0;
  const hasRecentActivity = now - latestEventMs <= OBSERVED_ACTIVE_FILE_MS;
  const hasRecentMessage = lastMessageMs > 0 && now - lastMessageMs <= OBSERVED_ACTIVE_FILE_MS;
  const hasRunningBridgeTask = [...tasks.values()].some(
    (task) => task.sessionId === sessionId && task.status === "running",
  );
  const explicitTurnRunning = startedMs > completedMs;
  const pendingUser =
    lastRole === "user" &&
    completedMs < lastMessageMs &&
    now - lastMessageMs <= OBSERVED_PENDING_USER_MS;
  const toolActivityRunning =
    latestEventMs > lastMessageMs && completedMs < lastMessageMs && hasRecentActivity;
  const commentaryRunning =
    lastRole === "assistant" &&
    latestMessagePhase === "commentary" &&
    completedMs < lastMessageMs &&
    hasRecentMessage;
  return (
    hasRunningBridgeTask ||
    ((explicitTurnRunning || pendingUser || toolActivityRunning || commentaryRunning) &&
      hasRecentActivity)
  );
};

const latestActiveTurnForSession = (sessionId) => {
  const file = sessionFileById().get(String(sessionId || ""));
  if (!file || !fs.existsSync(file)) return null;
  let active = null;
  for (const item of readActiveSessionRecords(file)) {
    if (item.type !== "event_msg") continue;
    const payload = item.payload || {};
    if (payload.type === "task_started" && payload.turn_id) {
      active = {
        threadId: String(sessionId),
        turnId: payload.turn_id,
        startedAt: item.timestamp || "",
      };
      continue;
    }
    if (
      active &&
      isTurnTerminalEvent(payload.type) &&
      (!payload.turn_id || payload.turn_id === active.turnId)
    ) {
      active = null;
    }
  }
  return active;
};

const listChats = () => {
  const paths = sessionFileById();
  const indexedById = new Map();
  for (const row of readJsonl(SESSION_INDEX).filter((row) => row.id)) {
    const existing = indexedById.get(row.id);
    if (existing && new Date(existing.updatedAt || 0) >= new Date(row.updated_at || 0)) continue;
    indexedById.set(row.id, {
      id: row.id,
      title: compact(row.thread_name || row.id, 96),
      updatedAt: row.updated_at || null,
      file: paths.get(row.id) || null,
    });
  }
  const indexed = [...indexedById.values()];

  const seen = new Set(indexed.map((row) => row.id));
  for (const [id, file] of paths.entries()) {
    if (seen.has(id)) continue;
    const { meta, messages } = parseSessionMessages(file);
    indexed.push({
      id,
      title: compact(meta.thread_name || messages.find((m) => m.role === "user")?.text || id, 96),
      updatedAt: fs.statSync(file).mtime.toISOString(),
      file,
    });
  }

  const enriched = indexed.map((chat) => {
    let messageCount = null;
    let preview = "";
    let cwd = "";
    const folder = sessionFolder(chat.file);
    if (chat.file && fs.existsSync(chat.file)) {
      const summary = parseSessionSummary(chat.file);
      messageCount = summary.messageCount;
      cwd = summary.meta.cwd || "";
      preview = summary.preview;
      chat.activityAt = latestIso(
        chat.updatedAt,
        summary.latestEventAt,
        summary.lastMessageAt,
        summary.fileUpdatedAt,
      );
      if (chat.activityAt && new Date(chat.activityAt) > new Date(chat.updatedAt || 0))
        chat.updatedAt = chat.activityAt;
      chat.lastRole = summary.lastRole;
      chat.lastMessageAt = summary.lastMessageAt;
      chat.latestEventAt = summary.latestEventAt;
      chat.lastTaskStartedAt = summary.lastTaskStartedAt;
      chat.lastTaskCompleteAt = summary.lastTaskCompleteAt;
      chat.fileUpdatedAt = summary.fileUpdatedAt;
      chat.observedWorking = summary.observedWorking;
      chat.parentThreadId = summary.parentThreadId;
      chat.agentNickname = summary.agentNickname;
      chat.agentRole = summary.agentRole;
    }
    return {
      ...chat,
      messageCount,
      preview,
      cwd,
      folder,
      folderLabel: formatFolderLabel(folder),
      ...projectFromCwd(cwd, folder),
    };
  });

  const visibleChats = enriched.filter(
    (chat) =>
      !chat.parentThreadId &&
      (chat.messageCount > 0 || chat.observedWorking || chat.preview || chat.title !== chat.id),
  );

  const latestByProject = new Map();
  for (const chat of visibleChats) {
    const current = latestByProject.get(chat.projectKey) || 0;
    latestByProject.set(
      chat.projectKey,
      Math.max(current, new Date(chat.activityAt || chat.updatedAt || 0).getTime()),
    );
  }

  return visibleChats.sort((a, b) => {
    const archivedA = a.folder.startsWith("archived") ? 1 : 0;
    const archivedB = b.folder.startsWith("archived") ? 1 : 0;
    if (archivedA !== archivedB) return archivedA - archivedB;
    const projectTime =
      (latestByProject.get(b.projectKey) || 0) - (latestByProject.get(a.projectKey) || 0);
    if (projectTime !== 0) return projectTime;
    const projectCompare = a.projectLabel.localeCompare(b.projectLabel);
    if (projectCompare !== 0) return projectCompare;
    return new Date(b.activityAt || b.updatedAt || 0) - new Date(a.activityAt || a.updatedAt || 0);
  });
};

const listChatsCached = ({ force = false } = {}) => {
  const now = Date.now();
  if (!force && chatListCache.chats && now - chatListCache.at <= CHAT_LIST_CACHE_MS)
    return chatListCache.chats;
  const chats = listChats();
  chatListCache = { at: now, chats };
  return chats;
};

const getIndexedChat = (id) => {
  const paths = sessionFileById();
  const indexRow = readJsonl(SESSION_INDEX).find((row) => row.id === id);
  const file = paths.get(id);
  if (!file) return null;
  const stat = fs.statSync(file);
  const cacheKey = String(id || "");
  const cached = chatDetailCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    Date.now() - cached.at <= CHAT_DETAIL_CACHE_MS
  ) {
    return cached.chat;
  }
  const parsed = parseSessionMessages(file);
  const summary = parseSessionSummary(file);
  const chat = {
    id,
    title: compact(
      indexRow?.thread_name ||
        parsed.meta.thread_name ||
        parsed.messages.find((m) => m.role === "user")?.text ||
        id,
      96,
    ),
    updatedAt: indexRow?.updated_at || stat.mtime.toISOString(),
    file,
    folder: sessionFolder(file),
    folderLabel: formatFolderLabel(sessionFolder(file)),
    ...projectFromCwd(parsed.meta.cwd || "", sessionFolder(file)),
    messageCount: parsed.messages.length,
    preview: compact(
      [...parsed.messages].reverse().find((m) => m.role === "assistant" || m.role === "user")
        ?.text || "",
    ),
    cwd: parsed.meta.cwd || "",
    observedWorking: summary.observedWorking,
    parsed,
  };
  chatDetailCache.set(cacheKey, { at: Date.now(), mtimeMs: stat.mtimeMs, size: stat.size, chat });
  if (chatDetailCache.size > 24) {
    const oldest = [...chatDetailCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) chatDetailCache.delete(oldest);
  }
  return chat;
};

const parseTomlAllowedOrigins = (source) => {
  const match = source.match(/allowed\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

const listBrowserSessions = () => {
  if (!fs.existsSync(BROWSER_SESSION_ROOT)) return [];
  return fs
    .readdirSync(BROWSER_SESSION_ROOT)
    .filter((name) => name.endsWith(".toml"))
    .map((name) => {
      const id = name.replace(/\.toml$/, "");
      const file = path.join(BROWSER_SESSION_ROOT, name);
      return {
        id,
        file,
        updatedAt: fs.statSync(file).mtime.toISOString(),
        allowedOrigins: parseTomlAllowedOrigins(fs.readFileSync(file, "utf8")),
      };
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
};

const tomlString = (source, key) => {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match ? match[1] : "";
};

const tomlArray = (source, key) => {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
};

const listAutomations = () => {
  if (!fs.existsSync(AUTOMATIONS_ROOT)) return [];
  return fs
    .readdirSync(AUTOMATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const id = entry.name;
      const dir = path.join(AUTOMATIONS_ROOT, id);
      const file = path.join(dir, "automation.toml");
      if (!fs.existsSync(file)) return null;
      const source = fs.readFileSync(file, "utf8");
      return {
        id,
        file,
        name: tomlString(source, "name") || id,
        kind: tomlString(source, "kind") || "automation",
        status: tomlString(source, "status") || "UNKNOWN",
        prompt: compact(tomlString(source, "prompt"), 120),
        rrule: tomlString(source, "rrule"),
        destination: tomlString(source, "destination"),
        cwds: tomlArray(source, "cwds"),
        updatedAt: fs.statSync(file).mtime.toISOString(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const active = Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE");
      if (active !== 0) return active;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
};

const listWorkspaces = () => {
  const seen = new Set();
  const workspaces = [];

  const addWorkspace = (cwd, label) => {
    if (!cwd) return;
    const clean = path.normalize(cwd);
    if (seen.has(clean) || !fs.existsSync(clean) || !fs.statSync(clean).isDirectory()) return;
    seen.add(clean);
    workspaces.push({
      cwd: clean,
      label: label || path.basename(clean) || clean,
    });
  };

  addWorkspace(ROOT, path.basename(ROOT) || ROOT);
  for (const chat of listChatsCached()) {
    addWorkspace(chat.cwd, chat.projectLabel);
  }

  return workspaces.sort((a, b) => a.label.localeCompare(b.label));
};

const accountCanAccessChat = (account, chatId) => {
  if (!isBridgeAccountIntegrated(account)) return false;
  if (account.legacyCodexAccess) return true;
  return uniqueStrings(account.sessionIds).includes(String(chatId || ""));
};

const listChatsForAccount = (account, options = {}) => {
  if (!isBridgeAccountIntegrated(account)) return [];
  const chats = listChatsCached(options);
  if (account.legacyCodexAccess) return chats;
  const allowed = new Set(uniqueStrings(account.sessionIds));
  return chats.filter((chat) => allowed.has(chat.id));
};

const listBrowserSessionsForAccount = (account) => {
  if (!isBridgeAccountIntegrated(account)) return [];
  return account.legacyCodexAccess ? listBrowserSessions() : [];
};

const listAutomationsForAccount = (account) => {
  if (!isBridgeAccountIntegrated(account)) return [];
  return account.legacyCodexAccess ? listAutomations() : [];
};

const publicTask = (task) => ({
  id: task.id,
  sessionId: task.sessionId || null,
  turnId: task.turnId || null,
  cwd: task.cwd || "",
  status: task.status,
  queued: task.status === "queued",
  queuedAt: task.queuedAt || null,
  startedAt: task.startedAt,
  endedAt: task.endedAt,
  updatedAt: task.output.at(-1)?.at || task.endedAt || task.startedAt,
  finalMessage: task.finalMessage || "",
  error: task.error || "",
  model: task.model || "",
  effort: task.effort || "",
  fullAuto: Boolean(task.fullAuto),
  observed: Boolean(task.observed),
});

const recentSessionFilesForAccount = (account, limit = OBSERVED_TASK_SCAN_LIMIT) => {
  if (!isBridgeAccountIntegrated(account)) return [];
  const allowed = account.legacyCodexAccess ? null : new Set(uniqueStrings(account.sessionIds));
  return [...sessionFileById().entries()]
    .filter(([sessionId]) => !allowed || allowed.has(sessionId))
    .map(([sessionId, file]) => {
      try {
        const stat = fs.statSync(file);
        return { sessionId, file, mtimeMs: stat.mtimeMs, updatedAt: stat.mtime.toISOString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, limit));
};

const reconcileTaskFromSessionFile = (task) => {
  if (!task || task.status !== "running" || !task.sessionId) return task;
  const file = sessionFileById().get(task.sessionId);
  if (!file || !fs.existsSync(file)) return task;
  const startedMs = Date.parse(task.startedAt || "") || 0;
  const records = readActiveSessionRecords(file);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const item = records[index];
    const payload = item.payload || {};
    if (item.type !== "event_msg" || !isTurnTerminalEvent(payload.type)) continue;
    const eventMs = Date.parse(item.timestamp || "") || 0;
    if (startedMs && eventMs < startedMs) break;
    if (task.turnId && payload.turn_id !== task.turnId) continue;
    task.status = "complete";
    task.exitCode = 0;
    task.endedAt = item.timestamp || new Date().toISOString();
    task.finalMessage = payload.last_agent_message || task.finalMessage;
    codexAppServer.untrack(task);
    task.waitResolve?.();
    break;
  }
  return task;
};

const listActiveTasksForAccount = (account) => {
  if (!isBridgeAccountIntegrated(account)) return [];
  const cacheKey = account.accountId || "active";
  const cached = taskListCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= TASK_LIST_CACHE_MS) return cached.tasks;
  const active = [...tasks.values()]
    .map(reconcileTaskFromSessionFile)
    .filter((task) => task.status === "running" || task.status === "queued")
    .filter((task) => {
      if (account.legacyCodexAccess) return true;
      if (task.accountId && task.accountId === account.accountId) return true;
      return task.sessionId && accountCanAccessChat(account, task.sessionId);
    })
    .map(publicTask);
  const activeSessionIds = new Set(
    active
      .filter((task) => task.status === "running")
      .map((task) => task.sessionId)
      .filter(Boolean),
  );
  const observed = recentSessionFilesForAccount(account)
    .filter(({ sessionId }) => !activeSessionIds.has(sessionId))
    .map(({ sessionId, file, updatedAt }) => {
      const summary = parseSessionSummary(file);
      if (!summary.observedWorking) return null;
      return {
        id: `observed-${sessionId}`,
        sessionId,
        turnId: null,
        cwd: summary.meta?.cwd || "",
        status: "running",
        startedAt: summary.lastMessageAt || summary.fileUpdatedAt || updatedAt,
        endedAt: null,
        updatedAt: summary.fileUpdatedAt || updatedAt,
        finalMessage: "",
        error: "",
        model: "",
        effort: "",
        fullAuto: false,
        observed: true,
      };
    })
    .filter(Boolean);
  const result = [...active, ...observed].sort(
    (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0),
  );
  taskListCache.set(cacheKey, { at: Date.now(), tasks: result });
  if (taskListCache.size > 8) {
    const oldest = [...taskListCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) taskListCache.delete(oldest);
  }
  return result;
};

const accountPrivateWorkspace = (account) => {
  const accountFile = accountStorageFile(account?.accountId);
  const workspace = accountFile
    ? path.join(path.dirname(accountFile), "workspace")
    : path.join(BRIDGE_STATE_ROOT, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return workspace;
};

const isAccountPrivateChat = (account, chat) => {
  if (!chat?.cwd) return false;
  const workspace = path.normalize(accountPrivateWorkspace(account));
  const cwd = path.normalize(chat.cwd);
  return cwd === workspace || cwd.startsWith(`${workspace}${path.sep}`);
};

const workspaceSummary = (cwd, options = {}) => {
  const clean = path.normalize(cwd);
  return {
    cwd: clean,
    label: options.label || path.basename(clean) || clean,
    private: Boolean(options.private),
  };
};

const syncBridgeAccountFromCodex = (account) => {
  if (!isBridgeAccountIntegrated(account)) return account;
  if (account.legacyCodexAccess) {
    const synced = { ...account, syncedAt: new Date().toISOString() };
    return writeBridgeAccount(synced, {
      makeActive: readJsonFile(BRIDGE_ACCOUNT_FILE)?.accountId === account.accountId,
    });
  }

  const chats = listChats();
  const sessionIds = uniqueStrings([...account.sessionIds, ...chats.map((chat) => chat.id)]);
  const workspacePaths = uniqueStrings([
    ...account.workspacePaths,
    ...chats
      .map((chat) => chat.cwd)
      .filter((cwd) => cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()),
  ]);
  const synced = {
    ...account,
    sessionIds,
    workspacePaths,
    syncedAt: new Date().toISOString(),
  };
  return writeBridgeAccount(synced, {
    makeActive: readJsonFile(BRIDGE_ACCOUNT_FILE)?.accountId === account.accountId,
  });
};

const listWorkspacesForAccount = (account) => {
  if (!isBridgeAccountIntegrated(account)) return [];
  if (account.legacyCodexAccess) return listWorkspaces();

  const workspacePaths = uniqueStrings(account.workspacePaths).filter(
    (cwd) => cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory(),
  );
  if (!workspacePaths.length)
    return [
      workspaceSummary(accountPrivateWorkspace(account), {
        label: "Private workspace",
        private: true,
      }),
    ];

  return workspacePaths
    .map((cwd) => workspaceSummary(cwd))
    .sort((a, b) => a.label.localeCompare(b.label));
};

const linkSessionToAccount = (accountId, sessionId) => {
  if (!accountId || !sessionId) return;
  const account = readStoredBridgeAccountById(accountId);
  if (!account) return;
  const sessionIds = uniqueStrings([...account.sessionIds, sessionId]);
  if (sessionIds.length === account.sessionIds.length) return;
  const active = readJsonFile(BRIDGE_ACCOUNT_FILE);
  writeBridgeAccount(
    { ...account, sessionIds },
    { makeActive: active?.accountId === account.accountId },
  );
};

const disconnectBridgeAccount = () => {
  const account = ensureBridgeAccount();
  const disconnected = {
    ...account,
    integrationStatus: "NOT_INTEGRATED",
    desktopDevice: null,
    sessionIds: [],
    workspacePaths: [],
    syncedAt: new Date().toISOString(),
    legacyCodexAccess: false,
  };
  pairings.clear();
  return writeBridgeAccount(disconnected);
};

const connectBridgeAccount = () => {
  const account = ensureBridgeAccount();
  const now = new Date().toISOString();
  const connected = {
    ...account,
    integrationStatus: "CONNECTED",
    desktopDevice: account.desktopDevice?.id
      ? { ...account.desktopDevice, lastSeenAt: now }
      : {
          id: `desk_${crypto.randomBytes(9).toString("base64url")}`,
          name: os.hostname() || "Desktop agent",
          createdAt: now,
          lastSeenAt: now,
        },
    legacyCodexAccess: false,
  };
  return writeBridgeAccount(connected);
};

const validWorkspace = (cwd) => {
  if (!cwd) return ROOT;
  const clean = path.normalize(String(cwd));
  return fs.existsSync(clean) && fs.statSync(clean).isDirectory() ? clean : ROOT;
};

const findCodexBinary = () => {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  if (fs.existsSync(DESKTOP_CODEX_BIN)) return DESKTOP_CODEX_BIN;
  return "codex";
};

class CodexAppServerClient {
  constructor() {
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.threadTasks = new Map();
    this.turnTasks = new Map();
    this.status = {
      connected: false,
      mode: "stopped",
      binary: findCodexBinary(),
      userAgent: "",
      error: "",
    };
  }

  async ensure() {
    if (this.ready) return this.ready;
    this.ready = this.start().catch((error) => {
      this.ready = null;
      this.status.connected = false;
      this.status.error = error.message;
      throw error;
    });
    return this.ready;
  }

  async start() {
    const binary = findCodexBinary();
    const useProxy = fs.existsSync(APP_SERVER_CONTROL_SOCKET);
    const args = useProxy ? ["app-server", "proxy"] : ["app-server"];
    this.status = {
      connected: false,
      mode: useProxy ? "desktop-proxy" : "local-app-server",
      binary,
      userAgent: "",
      error: "",
    };

    this.child = spawn(binary, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (/Error:|error|failed/i.test(text)) this.status.error = compact(text, 500);
    });
    this.child.on("error", (error) => {
      this.failAll(error);
    });
    this.child.on("close", (code) => {
      const error = new Error(`Desktop agent exited with code ${code}.`);
      this.status.connected = false;
      this.status.error = error.message;
      this.child = null;
      this.ready = null;
      this.failAll(error);
    });

    const init = await this.request("initialize", {
      clientInfo: { name: "vlix", title: "Vlix", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    this.status.connected = true;
    this.status.userAgent = init.userAgent || "";
    this.status.error = "";
    return this;
  }

  handleStdout(chunk) {
    this.buffer += String(chunk);
    let lineBreak = this.buffer.indexOf("\n");
    while (lineBreak >= 0) {
      const line = this.buffer.slice(0, lineBreak);
      this.buffer = this.buffer.slice(lineBreak + 1);
      if (line.trim()) this.handleMessage(line);
      lineBreak = this.buffer.indexOf("\n");
    }
  }

  handleMessage(line) {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(message, "result") ||
      Object.prototype.hasOwnProperty.call(message, "error")
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.id && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.method) this.handleNotification(message);
  }

  request(method, params, timeoutMs = 60_000) {
    if (!this.child?.stdin?.writable)
      return Promise.reject(new Error("Desktop agent is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Desktop agent request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    if (this.child?.stdin?.writable)
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  failAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const task of new Set([...this.threadTasks.values(), ...this.turnTasks.values()])) {
      if (task.status === "running") {
        task.status = "failed";
        task.error = task.error || error.message;
        task.endedAt = new Date().toISOString();
        task.waitResolve?.();
      }
    }
    this.threadTasks.clear();
    this.turnTasks.clear();
  }

  taskFor(threadId, turnId) {
    if (threadId && turnId && this.turnTasks.has(`${threadId}:${turnId}`)) {
      return this.turnTasks.get(`${threadId}:${turnId}`);
    }
    return threadId ? this.threadTasks.get(threadId) : null;
  }

  trackThread(task) {
    if (task.sessionId) this.threadTasks.set(task.sessionId, task);
  }

  trackTurn(task) {
    if (task.sessionId && task.turnId) this.turnTasks.set(`${task.sessionId}:${task.turnId}`, task);
  }

  untrack(task) {
    if (task.sessionId) this.threadTasks.delete(task.sessionId);
    if (task.sessionId && task.turnId) this.turnTasks.delete(`${task.sessionId}:${task.turnId}`);
  }

  appendTaskEvent(task, kind, data) {
    task.output.push({ kind, at: new Date().toISOString(), data });
    if (task.output.length > 600) task.output.splice(0, task.output.length - 600);
  }

  handleServerRequest(message) {
    const params = message.params || {};
    const task = this.taskFor(params.threadId, params.turnId);
    const allow = Boolean(task?.fullAuto);

    if (task) this.appendTaskEvent(task, "request", { method: message.method, params });

    if (message.method === "item/commandExecution/requestApproval") {
      this.respond(message.id, { decision: allow ? "accept" : "decline" });
      if (task && !allow)
        task.error =
          "The assistant requested command approval. Turn on Full access to allow command execution from this web app.";
      return;
    }

    if (message.method === "item/fileChange/requestApproval") {
      this.respond(message.id, { decision: allow ? "accept" : "decline" });
      if (task && !allow)
        task.error =
          "The assistant requested file-change approval. Turn on Full access to allow file edits from this web app.";
      return;
    }

    if (message.method === "item/tool/requestUserInput") {
      this.respond(message.id, { answers: {} });
      return;
    }

    if (message.method === "item/tool/call") {
      this.respond(message.id, { contentItems: [], success: false });
      return;
    }

    this.respond(message.id, {});
  }

  handleNotification(message) {
    const params = message.params || {};
    const task = this.taskFor(params.threadId || params.conversationId, params.turnId || params.id);
    if (!task) return;

    this.appendTaskEvent(task, "notification", message);

    if (message.method === "item/agentMessage/delta") {
      task.finalMessage += params.delta || "";
      return;
    }

    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      task.finalMessage = params.item.text || task.finalMessage;
      return;
    }

    if (message.method === "error") {
      task.error = params.error?.message || params.message || task.error;
      return;
    }

    if (message.method === "turn/completed") {
      const status = params.turn?.status;
      task.status = status === "completed" ? "complete" : "failed";
      task.exitCode = status === "completed" ? 0 : 1;
      task.error = params.turn?.error?.message || task.error;
      task.endedAt = new Date().toISOString();
      this.untrack(task);
      task.waitResolve?.();
    }
  }

  async interruptTurn(threadId, turnId) {
    await this.ensure();
    return this.request("turn/interrupt", { threadId, turnId }, 20_000);
  }

  waitForTask(task, timeoutMs = 2 * 60 * 60 * 1000) {
    if (task.status !== "running") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (task.status === "running") {
          task.status = "failed";
          task.error = "Assistant turn timed out.";
          task.endedAt = new Date().toISOString();
          this.untrack(task);
        }
        resolve();
      }, timeoutMs);
      task.waitResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

const codexAppServer = new CodexAppServerClient();

const createCodexTask = (sessionId, prompt, options = {}, status = "running") => {
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const requestedSettings = { ...readCodexSettings().selected };
  if (options.model) requestedSettings.model = options.model;
  if (options.effort) requestedSettings.effort = options.effort;
  if (typeof options.fullAuto === "boolean") requestedSettings.fullAccess = options.fullAuto;
  const codexSettings = normalizeCodexSettings(requestedSettings);
  return {
    id,
    sessionId,
    turnId: null,
    prompt,
    attachments: normalizeInboundAttachments(options.attachments),
    accountId: options.accountId || null,
    cwd: validWorkspace(options.cwd),
    fullAuto: Boolean(codexSettings.fullAccess),
    model: codexSettings.model,
    effort: codexSettings.effort,
    backend: "app-server",
    status,
    queuedAt: status === "queued" ? now : null,
    startedAt: now,
    endedAt: null,
    exitCode: null,
    output: [],
    finalMessage: "",
    error: "",
  };
};

const runTaskAsync = (task) => {
  runCodexAppServerTask(task).catch((error) => {
    task.status = "failed";
    task.error = error.message || "Assistant task failed.";
    task.endedAt = new Date().toISOString();
    task.waitResolve?.();
  });
};

const startCodexTask = (sessionId, prompt, options = {}) => {
  const task = createCodexTask(sessionId, prompt, options, "running");
  tasks.set(task.id, task);
  runTaskAsync(task);
  return task;
};

const taskBlocksSession = (candidate) =>
  [...tasks.values()].some(
    (task) =>
      task !== candidate &&
      task.status === "running" &&
      task.sessionId &&
      task.sessionId === candidate.sessionId,
  );

const drainQueuedTasks = () => {
  for (const task of tasks.values()) {
    if (task.status !== "queued") continue;
    if (!task.sessionId) continue;
    if (taskBlocksSession(task) || sessionIsActivelyWorking(task.sessionId)) continue;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    codexAppServer.appendTaskEvent(task, "queue", { message: "Queued follow-up started." });
    runTaskAsync(task);
  }
};

const scheduleQueueDrain = () => {
  if (queueDrainTimer) return;
  queueDrainTimer = setInterval(drainQueuedTasks, 900);
};

const queueCodexTask = (sessionId, prompt, options = {}) => {
  const task = createCodexTask(sessionId, prompt, options, "queued");
  codexAppServer.appendTaskEvent(task, "queue", {
    message: "Queued until the current desktop turn finishes.",
  });
  tasks.set(task.id, task);
  scheduleQueueDrain();
  return task;
};

scheduleQueueDrain();

const interruptTask = async (task) => {
  if (!task) throw new Error("Task not found.");
  if (task.status === "queued") {
    task.status = "interrupted";
    task.error = "Queued message cancelled.";
    task.endedAt = new Date().toISOString();
    return { stopped: true, status: task.status };
  }
  if (task.status !== "running") return { stopped: false, status: task.status };
  if (!task.sessionId || !task.turnId)
    throw new Error("This running task does not have an interruptable turn yet.");
  await codexAppServer.interruptTurn(task.sessionId, task.turnId);
  task.status = "interrupted";
  task.error = "Turn interrupted.";
  task.endedAt = new Date().toISOString();
  codexAppServer.untrack(task);
  task.waitResolve?.();
  return { stopped: true, status: task.status };
};

const interruptObservedSession = async (sessionId) => {
  const active = latestActiveTurnForSession(sessionId);
  if (!active?.turnId) throw new Error("No active interruptable turn was found for this chat.");
  await codexAppServer.interruptTurn(active.threadId, active.turnId);
  return { stopped: true, sessionId, turnId: active.turnId };
};

const runCodexAppServerTask = async (task) => {
  const client = await codexAppServer.ensure();
  const modelOverrides = { model: task.model, reasoningEffort: task.effort };
  const sessionOverrides = {
    ...modelOverrides,
    ...(task.fullAuto ? { approvalPolicy: "never", sandbox: "danger-full-access" } : {}),
  };

  if (task.sessionId) {
    const resumed = await client.request(
      "thread/resume",
      {
        threadId: task.sessionId,
        persistExtendedHistory: true,
        ...sessionOverrides,
      },
      90_000,
    );
    task.cwd = resumed.cwd || task.cwd;
  } else {
    const started = await client.request(
      "thread/start",
      {
        cwd: task.cwd,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        ...sessionOverrides,
      },
      90_000,
    );
    task.sessionId = started.thread.id;
    task.file = started.thread.path || null;
  }
  linkSessionToAccount(task.accountId, task.sessionId);

  client.trackThread(task);
  const localImages = persistAttachmentFiles(task);
  const turnOverrides = {
    ...modelOverrides,
    ...(task.fullAuto
      ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
      : {}),
  };
  const turnInput = [
    {
      type: "text",
      text: task.prompt || (localImages.length ? "Please review the attached image." : ""),
      text_elements: [],
    },
    ...localImages.map((filePath) => ({ type: "localImage", path: filePath })),
  ];
  const startedTurn = await client.request(
    "turn/start",
    {
      threadId: task.sessionId,
      input: turnInput,
      ...turnOverrides,
    },
    90_000,
  );
  task.turnId = startedTurn.turn.id;
  client.trackTurn(task);
  await client.waitForTask(task);
};

const decodeBridgeSetup = (raw) => {
  if (!raw) return null;
  const text = String(raw).trim();
  const candidates = [text];
  try {
    candidates.push(Buffer.from(text, "base64").toString("utf8"));
  } catch {}
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed?.supabaseUrl &&
        parsed?.supabaseAnonKey &&
        parsed?.accessToken &&
        parsed?.accountId
      )
        return parsed;
    } catch {}
  }
  return null;
};

const cloudConfigValue = (value) => String(value || "").trim();

const cloudUserIdFromAccessToken = (token) => {
  try {
    const [, payload] = String(token || "").split(".");
    if (!payload) return "";
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return cloudConfigValue(parsed?.sub);
  } catch {
    return "";
  }
};

const mergeCloudConfig = (...sources) => {
  const config = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of [
      "supabaseUrl",
      "supabaseAnonKey",
      "accessToken",
      "refreshToken",
      "accountId",
      "userId",
    ]) {
      const value = cloudConfigValue(source[key]);
      if (value) config[key] = value;
    }
  }
  if (!config.userId) config.userId = cloudUserIdFromAccessToken(config.accessToken);
  return config;
};

const hasCompleteCloudConfig = (config) =>
  Boolean(
    config?.supabaseUrl &&
      config?.supabaseAnonKey &&
      config?.accessToken &&
      config?.accountId,
  );

const readSavedCloudConfig = () => {
  const saved = readJsonFile(BRIDGE_CLOUD_CONFIG_FILE);
  const config = mergeCloudConfig(saved);
  return hasCompleteCloudConfig(config) ? config : null;
};

const saveCloudConfig = (config) => {
  if (!hasCompleteCloudConfig(config)) return;
  writeJsonFile(BRIDGE_CLOUD_CONFIG_FILE, {
    ...mergeCloudConfig(config),
    savedAt: new Date().toISOString(),
  });
  try {
    fs.chmodSync(BRIDGE_CLOUD_CONFIG_FILE, 0o600);
  } catch {}
};

const cloudConfig = () => {
  const setup = decodeBridgeSetup(process.env.VLIX_BRIDGE_SETUP);
  const saved = readSavedCloudConfig();
  const envConfig = {
    supabaseUrl: process.env.VLIX_SUPABASE_URL,
    supabaseAnonKey: process.env.VLIX_SUPABASE_ANON_KEY,
    accessToken: process.env.VLIX_SUPABASE_ACCESS_TOKEN,
    refreshToken: process.env.VLIX_SUPABASE_REFRESH_TOKEN,
    accountId: process.env.VLIX_ACCOUNT_ID,
    userId: process.env.VLIX_USER_ID,
  };
  const config = mergeCloudConfig(setup ? null : saved, setup, envConfig);
  if (!hasCompleteCloudConfig(config)) return null;
  if (setup || Object.values(envConfig).some(cloudConfigValue)) saveCloudConfig(config);
  return config;
};

const cloudConfigFromConnectPayload = (body = {}) => {
  const setup = decodeBridgeSetup(body.setup || body.payload || body.VLIX_BRIDGE_SETUP);
  const config = mergeCloudConfig(setup, body.config, body);
  return hasCompleteCloudConfig(config) ? config : null;
};

const cloudHeaders = (config, extra = {}) => ({
  apikey: config.supabaseAnonKey,
  Authorization: `Bearer ${config.accessToken}`,
  "Content-Type": "application/json",
  ...extra,
});

const cloudUrl = (config, path) => `${config.supabaseUrl.replace(/\/$/, "")}${path}`;

const parseCloudPayload = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const refreshCloudSession = async (config) => {
  if (!config.refreshToken) return false;
  const response = await fetch(cloudUrl(config, "/auth/v1/token?grant_type=refresh_token"), {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: config.refreshToken }),
  });
  if (!response.ok) return false;
  const payload = await response.json();
  if (!payload?.access_token) return false;
  config.accessToken = payload.access_token;
  config.refreshToken = payload.refresh_token || config.refreshToken;
  saveCloudConfig(config);
  return true;
};

const cloudRequest = async (config, path, options = {}) => {
  const response = await fetch(cloudUrl(config, path), {
    method: options.method || "GET",
    headers: cloudHeaders(config, options.headers),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const payload = parseCloudPayload(text);
  if (!response.ok) {
    if (response.status === 401 && !options.retried && (await refreshCloudSession(config))) {
      return cloudRequest(config, path, { ...options, retried: true });
    }
    const message =
      payload?.message || payload?.error_description || payload?.error || response.statusText;
    throw new Error(`Cloud sync ${response.status}: ${message}`);
  }
  return payload;
};

const cloudTable = (config, table, query = "", options = {}) =>
  cloudRequest(config, `/rest/v1/${table}${query ? `?${query}` : ""}`, options);

const stableCloudDeviceId = (accountId = "") => {
  const raw = process.env.VLIX_DEVICE_ID;
  if (raw && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return raw;
  }
  const hash = crypto
    .createHash("sha1")
    .update(`${accountId}|${os.hostname()}|${CODEX_HOME}`)
    .digest("hex")
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
};

const cloudUpsertDevice = async (config) => {
  const now = new Date().toISOString();
  const deviceId = stableCloudDeviceId(config.accountId);
  const rows = await cloudTable(config, "bridge_devices", "on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: {
      id: deviceId,
      account_id: config.accountId,
      device_name: os.hostname() || "Desktop bridge",
      platform: `${os.platform()} ${os.release()}`,
      status: "online",
      paired_at: now,
      last_seen_at: now,
    },
  });
  cloudSyncState.deviceId = rows?.[0]?.id || deviceId;
  cloudSyncState.accountId = config.accountId;
  return cloudSyncState.deviceId;
};

const cloudSelectSingle = async (config, table, query) => {
  const rows = await cloudTable(config, table, `${query}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
};

const cloudClaimCommand = async (config, command, deviceId) => {
  const rows = await cloudTable(
    config,
    "bridge_commands",
    `id=eq.${encodeURIComponent(command.id)}&status=eq.queued`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: {
        status: "claimed",
        claimed_by_device_id: deviceId,
        claimed_at: new Date().toISOString(),
      },
    },
  );
  return Array.isArray(rows) ? rows[0] || null : null;
};

const cloudUpdateCommand = (config, commandId, body) =>
  cloudTable(config, "bridge_commands", `id=eq.${encodeURIComponent(commandId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body,
  });

const cloudUpdateSession = (config, sessionId, body) =>
  cloudTable(config, "bridge_sessions", `id=eq.${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body,
  });

const cloudInsertMessage = (config, body) =>
  cloudTable(config, "bridge_messages", "", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body,
  });

const cloudUpsertSessions = (config, rows) =>
  cloudTable(config, "bridge_sessions", "on_conflict=account_id,provider,provider_session_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: rows,
  });

const cloudUpsertMessages = (config, rows) =>
  cloudTable(
    config,
    "bridge_messages",
    "on_conflict=account_id,session_id,provider_message_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: rows,
    },
  );

const chunksOf = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

const syncLocalSessionsToCloud = async (config, account, options = {}) => {
  const chats = listChatsForAccount(account, { force: true }).slice(0, options.limit || 240);
  if (!chats.length) return { sessions: 0, messages: 0 };
  const sessionRows = chats.map((chat) => ({
    account_id: config.accountId,
    provider: "codex",
    provider_session_id: chat.id,
    title: compact(chat.title || chat.preview || chat.id, 90) || "Untitled chat",
    workspace_path: chat.cwd || null,
    status: chat.observedWorking ? "working" : "idle",
    activity_at: chat.activityAt || chat.updatedAt || new Date().toISOString(),
    updated_at: chat.activityAt || chat.updatedAt || new Date().toISOString(),
    metadata: {
      localAccountId: account.accountId,
      folder: chat.folder || "",
      folderLabel: chat.folderLabel || "",
      projectKey: chat.projectKey || "",
      projectLabel: chat.projectLabel || "",
      messageCount: chat.messageCount || 0,
    },
  }));

  const upserted = [];
  for (const chunk of chunksOf(sessionRows, 80)) {
    const rows = await cloudUpsertSessions(config, chunk);
    if (Array.isArray(rows)) upserted.push(...rows);
  }

  const cloudSessionByProviderId = new Map(
    upserted.map((row) => [String(row.provider_session_id || ""), row]),
  );
  const messageRows = [];
  for (const chat of chats.slice(0, options.messageChatLimit || 36)) {
    const cloudSession = cloudSessionByProviderId.get(chat.id);
    if (!cloudSession?.id) continue;
    const indexed = getIndexedChat(chat.id);
    const messages = indexed?.parsed?.messages || [];
    for (const message of messages.slice(-(options.messagesPerChat || 60))) {
      if (!["user", "assistant", "system", "tool", "event"].includes(message.role)) continue;
      messageRows.push({
        account_id: config.accountId,
        session_id: cloudSession.id,
        role: message.role,
        body: message.text || "",
        event_type: null,
        event_payload: {
          source: message.source || "desktop",
          phase: message.phase || null,
        },
        attachments: [],
        provider_message_id: `codex:${chat.id}:${message.id}`,
        created_at: message.timestamp || chat.activityAt || new Date().toISOString(),
      });
    }
  }

  for (const chunk of chunksOf(messageRows, 200)) {
    try {
      await cloudUpsertMessages(config, chunk);
    } catch (error) {
      console.warn(`Vlix cloud message history sync skipped: ${error.message}`);
      break;
    }
  }
  return { sessions: chats.length, messages: messageRows.length };
};

const storageObjectUrl = (config, bucket, objectPath) =>
  cloudUrl(
    config,
    `/storage/v1/object/${encodeURIComponent(bucket)}/${String(objectPath).split("/").map(encodeURIComponent).join("/")}`,
  );

const cloudStorageUpload = async (config, bucket, objectPath, buffer, contentType) => {
  const response = await fetch(storageObjectUrl(config, bucket, objectPath), {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!response.ok) {
    if (response.status === 401 && (await refreshCloudSession(config))) {
      return cloudStorageUpload(config, bucket, objectPath, buffer, contentType);
    }
    const text = await response.text();
    const payload = parseCloudPayload(text);
    throw new Error(
      `Cloud storage ${response.status}: ${payload?.message || payload?.error || response.statusText}`,
    );
  }
  return response;
};

const cloudViteFramePath = (config) => {
  const userSegment = config.userId || "desktop";
  return `${userSegment}/${config.accountId}/vite-browser/latest.jpg`;
};

const cloudViteDomPath = (config) => {
  const userSegment = config.userId || "desktop";
  return `${userSegment}/${config.accountId}/vite-browser/latest-dom.json`;
};

const uploadLatestViteFrameToCloud = async (config, sessionId = "") => {
  const state = remoteBrowserState(sessionId, { create: false });
  if (!state?.page) return null;
  const image = await state.page.screenshot({
    type: "jpeg",
    quality: 58,
    fullPage: false,
  });
  state.lastFrameAt = new Date().toISOString();
  const pathName = cloudViteFramePath(config);
  await cloudStorageUpload(config, "bridge-attachments", pathName, image, "image/jpeg");
  cloudViteFrameSyncAt = Date.now();
  return {
    bucket: "bridge-attachments",
    path: pathName,
    type: "image/jpeg",
    size: image.length,
    updatedAt: state.lastFrameAt,
  };
};

const uploadLatestViteDomToCloud = async (config, sessionId = "") => {
  const state = remoteBrowserState(sessionId, { create: false });
  if (!state?.page) return null;
  const mirror = await captureViteDomSnapshot(sessionId);
  const body = Buffer.from(JSON.stringify(mirror), "utf8");
  const pathName = cloudViteDomPath(config);
  await cloudStorageUpload(config, "bridge-attachments", pathName, body, "application/json");
  return {
    bucket: "bridge-attachments",
    path: pathName,
    type: "application/json",
    size: body.length,
    updatedAt: mirror.capturedAt,
    nodeCount: mirror.nodeCount,
  };
};

const uploadLatestViteMirrorToCloud = async (config, sessionId = "") => {
  const state = remoteBrowserState(sessionId, { create: false });
  if (!state?.page) return null;
  const result = {};
  try {
    result.dom = await uploadLatestViteDomToCloud(config, sessionId);
  } catch (error) {
    console.warn(`Vlix cloud Vite DOM sync skipped: ${error.message}`);
  }
  try {
    result.frame = await uploadLatestViteFrameToCloud(config, sessionId);
  } catch (error) {
    console.warn(`Vlix cloud Vite frame sync skipped: ${error.message}`);
  }
  return result.dom || result.frame ? result : null;
};

const downloadCloudAttachments = async (config, attachments = []) => {
  const result = [];
  for (const attachment of Array.isArray(attachments) ? attachments.slice(0, 6) : []) {
    if (!attachment?.bucket || !attachment?.path) continue;
    const response = await fetch(storageObjectUrl(config, attachment.bucket, attachment.path), {
      headers: cloudHeaders(config),
    });
    if (!response.ok) continue;
    const mime =
      attachment.type || response.headers.get("content-type") || "application/octet-stream";
    if (!String(mime).startsWith("image/")) continue;
    const buffer = Buffer.from(await response.arrayBuffer());
    result.push({
      kind: "image",
      src: `data:${mime};base64,${buffer.toString("base64")}`,
      label: attachment.name || "Cloud image",
      type: mime,
      size: buffer.length,
    });
  }
  return result;
};

const commandSessionThreadId = (sessionRow) => {
  const providerId = String(sessionRow?.provider_session_id || "");
  if (!providerId || providerId.startsWith("web-")) return null;
  return providerId;
};

const completeCloudMessageCommand = async (config, command, sessionRow) => {
  const body = String(command.body || "").trim();
  const attachments = await downloadCloudAttachments(config, command.attachments);
  const task = startCodexTask(commandSessionThreadId(sessionRow), body, {
    accountId: config.accountId,
    attachments,
    fullAuto: true,
    cwd: sessionRow?.workspace_path || undefined,
  });
  await codexAppServer.waitForTask(task);
  const now = new Date().toISOString();
  const ok = task.status === "complete";
  await cloudUpdateSession(config, sessionRow.id, {
    provider_session_id: task.sessionId || sessionRow.provider_session_id,
    status: ok ? "done" : "error",
    activity_at: now,
    updated_at: now,
    metadata: {
      ...(sessionRow.metadata &&
      typeof sessionRow.metadata === "object" &&
      !Array.isArray(sessionRow.metadata)
        ? sessionRow.metadata
        : {}),
      localTaskId: task.id,
      turnId: task.turnId,
      outputCount: task.output.length,
    },
  });
  await cloudInsertMessage(config, {
    account_id: command.account_id,
    session_id: sessionRow.id,
    role: ok ? "assistant" : "event",
    body: ok ? task.finalMessage || "Done." : task.error || "Desktop assistant failed.",
    event_type: ok ? null : "error",
    event_payload: ok ? {} : { taskId: task.id, error: task.error },
    attachments: [],
  });
  await cloudUpdateCommand(config, command.id, {
    status: ok ? "completed" : "failed",
    error: ok ? null : task.error || "Desktop assistant failed.",
    completed_at: now,
  });
};

const completeCloudStopCommand = async (config, command, sessionRow) => {
  const providerId = commandSessionThreadId(sessionRow);
  if (!providerId) throw new Error("No desktop session id is available to stop yet.");
  await interruptObservedSession(providerId);
  const now = new Date().toISOString();
  await cloudUpdateSession(config, sessionRow.id, {
    status: "idle",
    activity_at: now,
    updated_at: now,
  });
  await cloudUpdateCommand(config, command.id, {
    status: "completed",
    completed_at: now,
    error: null,
  });
};

const completeCloudBrowserCommand = async (config, command, sessionRow = null) => {
  const body =
    typeof command.body === "string" && command.body.trim()
      ? JSON.parse(command.body)
      : {};
  const action = String(body.action || body.type || "start");
  const browserSessionId =
    body.chatId || commandSessionThreadId(sessionRow) || command.session_id || REMOTE_BROWSER_GLOBAL_KEY;
  const state = remoteBrowserState(browserSessionId);
  if (action === "start") {
    await ensureViteBrowser(body.url || (await detectViteUrl(browserSessionId)) || "http://localhost:5173", browserSessionId);
  } else if (action === "reload") {
    if (body.url || !state.page) {
      await ensureViteBrowser(body.url || state.url || (await detectViteUrl(browserSessionId)) || "http://localhost:5173", browserSessionId);
    } else {
      await state.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      rememberViteBrowserLog(state, { type: "browser", level: "info", text: "Reloaded Playwright Live Preview from phone" });
    }
  } else if (action === "stop") {
    await closeViteBrowser(browserSessionId);
  } else if (["click", "scroll", "type", "press"].includes(action)) {
    await applyViteBrowserInput({ ...body, type: action, chatId: browserSessionId });
  } else {
    throw new Error(`Unsupported browser action: ${action}`);
  }
  const updatedState = remoteBrowserState(browserSessionId, { create: false });
  const frame = updatedState?.page ? await uploadLatestViteMirrorToCloud(config, browserSessionId) : null;
  await cloudUpdateCommand(config, command.id, {
    status: "completed",
    completed_at: new Date().toISOString(),
    error: null,
  });
  return frame;
};

const processCloudCommand = async (config, command) => {
  const sessionRow = command.session_id
    ? await cloudSelectSingle(
        config,
        "bridge_sessions",
        `id=eq.${encodeURIComponent(command.session_id)}&account_id=eq.${encodeURIComponent(config.accountId)}`,
      )
    : null;
  if (command.kind === "browser") return completeCloudBrowserCommand(config, command, sessionRow);
  if (command.kind !== "sync" && !sessionRow)
    throw new Error("Cloud command does not reference an available session.");
  if (command.kind === "message") return completeCloudMessageCommand(config, command, sessionRow);
  if (command.kind === "stop") return completeCloudStopCommand(config, command, sessionRow);
  if (command.kind === "sync") {
    await cloudUpdateCommand(config, command.id, {
      status: "completed",
      completed_at: new Date().toISOString(),
      error: null,
    });
    return;
  }
  throw new Error(`Unsupported cloud command: ${command.kind}`);
};

const pollCloudCommands = async (config) => {
  const deviceId = await cloudUpsertDevice(config);
  let account = readBridgeAccount();
  if (!isBridgeAccountIntegrated(account)) {
    await codexAppServer.ensure();
    account = connectBridgeAccount();
  }
  if (Date.now() - cloudSessionSyncAt > CLOUD_SESSION_SYNC_MS) {
    cloudSessionSyncAt = Date.now();
    account = syncBridgeAccountFromCodex(account);
    await syncLocalSessionsToCloud(config, account);
  }
  cloudSyncState.enabled = true;
  cloudSyncState.lastPollAt = new Date().toISOString();
  const commands = await cloudTable(
    config,
    "bridge_commands",
    `account_id=eq.${encodeURIComponent(config.accountId)}&status=eq.queued&order=created_at.asc&limit=3`,
  );
  for (const command of Array.isArray(commands) ? commands : []) {
    const claimed = await cloudClaimCommand(config, command, deviceId);
    if (!claimed) continue;
    try {
      await processCloudCommand(config, claimed);
    } catch (error) {
      await cloudUpdateCommand(config, claimed.id, {
        status: "failed",
        error: error.message || "Cloud command failed.",
        completed_at: new Date().toISOString(),
      });
    }
  }
  const globalRemoteBrowser = remoteBrowserState(REMOTE_BROWSER_GLOBAL_KEY, { create: false });
  if (globalRemoteBrowser?.page && Date.now() - cloudViteFrameSyncAt > 1000) {
    try {
      await uploadLatestViteMirrorToCloud(config, REMOTE_BROWSER_GLOBAL_KEY);
    } catch (error) {
      console.warn(`Vlix cloud Vite mirror sync skipped: ${error.message}`);
    }
  }
};

const startCloudSync = () => {
  if (cloudSyncTimer) {
    clearInterval(cloudSyncTimer);
    cloudSyncTimer = null;
  }
  const config = cloudConfig();
  if (!config) {
    cloudSyncState = {
      enabled: false,
      lastPollAt: null,
      lastError: "",
      deviceId: "",
      accountId: "",
    };
    console.log("Vlix cloud sync disabled. Paste VLIX_BRIDGE_SETUP to connect Supabase.");
    return;
  }
  cloudSyncState = {
    enabled: true,
    lastPollAt: null,
    lastError: "",
    deviceId: "",
    accountId: config.accountId,
  };
  console.log(`Vlix cloud sync enabled for account ${config.accountId}.`);
  const tick = async () => {
    if (cloudSyncInFlight) return;
    if (Date.now() < cloudSyncBackoffUntil) return;
    cloudSyncInFlight = true;
    try {
      await pollCloudCommands(config);
      cloudSyncState.lastError = "";
    } catch (error) {
      cloudSyncState.lastError = error.message || "Cloud sync failed.";
      if (/401|JWT expired|invalid jwt|refresh/i.test(cloudSyncState.lastError)) {
        cloudSyncBackoffUntil = Date.now() + CLOUD_AUTH_BACKOFF_MS;
      }
      console.warn(`Vlix cloud sync: ${cloudSyncState.lastError}`);
    } finally {
      cloudSyncInFlight = false;
    }
  };
  tick();
  cloudSyncTimer = setInterval(tick, CLOUD_POLL_MS);
};

const normalizeBrowserTarget = (value) => {
  const raw = String(value || "").trim() || "http://localhost:5173";
  const withProtocol = /^https?:\/\//i.test(raw)
    ? raw
    : /^(localhost|127\.|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+:\d+)/i.test(raw)
      ? `http://${raw}`
      : `https://${raw}`;
  const parsed = new URL(withProtocol);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error("Provide an http(s) URL.");
  return parsed.toString();
};

let recentCodexViteUrlCache = { at: 0, url: "" };

const fetchTextWithTimeout = (target, timeoutMs = 650) =>
  new Promise((resolve) => {
    let settled = false;
    const parsed = new URL(target);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        timeout: timeoutMs,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 32_000) req.destroy();
          if (!settled && body.length > 8_000) {
            settled = true;
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 400,
              status: response.statusCode,
              body,
            });
            req.destroy();
          }
        });
        response.on("end", () => {
          if (!settled) {
            settled = true;
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 400,
              status: response.statusCode,
              body,
            });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, status: 0, body: "" });
      }
    });
  });

const withTimeout = (promise, timeoutMs, fallback) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });

const cleanDetectedUrl = (value) => {
  const raw = String(value || "")
    .trim()
    .split(/\\n|\\r|\n|\r|\s+##\s+|["'<>]/)[0]
    .replace(/`/g, "")
    .replace(/[)`\].,;]+$/g, "");
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/i.test(parsed.protocol)) return "";
    if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) return "";
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    return parsed.toString();
  } catch {
    return "";
  }
};

const urlOrigin = (value) => {
  const url = cleanDetectedUrl(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
};

const browserUseFrame = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  if (os.endianness() === "LE") header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
};

const parseBrowserUseFrames = (buffer) => {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length =
      os.endianness() === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (buffer.length - offset < 4 + length) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString("utf8")));
    offset += 4 + length;
  }
  return { messages, remaining: buffer.subarray(offset) };
};

const browserUseSockets = () => {
  if (process.platform === "win32") return [];
  try {
    return fs
      .readdirSync(BROWSER_USE_SOCKET_ROOT)
      .filter((name) => name.endsWith(".sock"))
      .map((name) => {
        const socketPath = path.join(BROWSER_USE_SOCKET_ROOT, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(socketPath).mtimeMs;
        } catch {}
        return { socketPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((item) => item.socketPath);
  } catch {
    return [];
  }
};

const createBrowserUseClient = (socketPath) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Browser Use socket connect timed out."));
    }, 350);
    let pendingData = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const fail = (error) => {
      for (const { reject: rejectRequest, timer } of pending.values()) {
        clearTimeout(timer);
        rejectRequest(error);
      }
      pending.clear();
    };
    socket.on("data", (chunk) => {
      pendingData = Buffer.concat([pendingData, chunk]);
      let parsed;
      try {
        parsed = parseBrowserUseFrames(pendingData);
      } catch (error) {
        fail(error);
        socket.destroy();
        return;
      }
      pendingData = parsed.remaining;
      for (const message of parsed.messages) {
        if (message.id == null) continue;
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message || "Browser Use error."));
        else request.resolve(message.result);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(connectTimer);
      fail(error);
      reject(error);
    });
    socket.on("close", () => fail(new Error("Browser Use socket closed.")));
    socket.on("connect", () => {
      clearTimeout(connectTimer);
      resolve({
        request(method, params = {}, timeoutMs = 2500) {
          const id = nextId++;
          return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`${method} timed out.`));
            }, timeoutMs);
            pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
            socket.write(browserUseFrame({ jsonrpc: "2.0", method, params, id }));
          });
        },
        close() {
          socket.destroy();
        },
      });
    });
  });

const latestTurnIdsForSession = (sessionId, limit = 8) => {
  const file = sessionFileById().get(String(sessionId || ""));
  if (!file || !fs.existsSync(file)) return [];
  const { records } = readSessionRecords(file, { tailBytes: 2 * 1024 * 1024 });
  const turnIds = [];
  const seen = new Set();
  for (const item of records.slice().reverse()) {
    const payload = item.payload || {};
    const turnId = payload.turn_id || payload.turnId || item.turn_id || "";
    if (!turnId || seen.has(turnId)) continue;
    seen.add(turnId);
    turnIds.push(turnId);
    if (turnIds.length >= limit) break;
  }
  return turnIds;
};

const openCodexIabForSession = async (sessionId, options = {}) => {
  const chatId = String(sessionId || "");
  if (!chatId) return null;
  const startedAt = Date.now();
  const deadlineMs = Number(options.deadlineMs) || 1800;
  const deadlineAt = startedAt + deadlineMs;
  const sockets = browserUseSockets().slice(0, Number(options.socketLimit) || 16);
  const turnIds = latestTurnIdsForSession(chatId, Number(options.turnLimit) || 2);
  for (const socketPath of sockets) {
    for (const turnId of turnIds) {
      if (Date.now() >= deadlineAt) return null;
      let client = null;
      try {
        client = await createBrowserUseClient(socketPath);
        const sessionParams = { session_id: chatId, turn_id: turnId };
        const info = await client.request("getInfo", sessionParams, Math.max(250, Math.min(650, deadlineAt - Date.now())));
        if (info?.type !== "iab" || info.metadata?.codexSessionId !== chatId) {
          client.close();
          continue;
        }
        const tabs = await client.request("getTabs", sessionParams, Math.max(300, Math.min(800, deadlineAt - Date.now())));
        const tab = (Array.isArray(tabs) ? tabs : []).find((item) => item.active) || tabs?.[0];
        if (!tab) {
          client.close();
          continue;
        }
        return {
          client,
          sessionParams,
          socketPath,
          info,
          tabs,
          tab,
          turnId,
        };
      } catch {
        if (client) client.close();
      }
    }
  }
  return null;
};

const safeCodexIabStatus = async (sessionId = "") => {
  const chatId = String(sessionId || "");
  const cached = codexIabStatusCache.get(chatId);
  if (cached && Date.now() - cached.at < 2500) return cached.value;
  const turnIds = latestTurnIdsForSession(chatId, 2);
  const socketCount = browserUseSockets().length;
  const iab = await openCodexIabForSession(chatId, { deadlineMs: 3500, socketLimit: 16, turnLimit: 2 });
  if (!iab) {
    const diagnosis = turnIds.length
      ? await diagnoseCodexIabForSession(chatId, {
          deadlineMs: 2500,
          socketLimit: 16,
          turnLimit: 2,
        })
      : null;
    const matchedPipe = diagnosis?.attempts?.find(
      (attempt) => attempt.matchedSessionId === chatId || (attempt.ok && attempt.url),
    );
    const matchedNoTab = diagnosis?.attempts?.find(
      (attempt) => attempt.matchedSessionId === chatId && !attempt.url,
    );
    const value = {
      active: false,
      socketCount,
      turnIdsChecked: turnIds.length,
      pipeMatched: Boolean(matchedPipe || matchedNoTab),
      reason: matchedNoTab
        ? `Matched a real Codex browser pipe, but no accessible browser tab is exposed yet${
            matchedNoTab.error ? ` (${matchedNoTab.error})` : ""
          }.`
        : turnIds.length
          ? "No matching Codex browser socket accepted this chat."
          : "No turn id found.",
    };
    codexIabStatusCache.set(chatId, { at: Date.now(), value });
    return value;
  }
  try {
    const value = {
      active: true,
      kind: "codex-iab",
      name: iab.info.name,
      version: iab.info.version,
      url: iab.tab.url || "",
      title: iab.tab.title || "",
      tabId: iab.tab.id,
      tabs: (iab.tabs || []).map((tab) => ({
        id: tab.id,
        active: Boolean(tab.active),
        title: tab.title || "",
        url: tab.url || "",
      })),
      turnId: iab.turnId,
      sessionId: String(sessionId || ""),
      socketCount,
    };
    codexIabStatusCache.set(chatId, { at: Date.now(), value });
    return value;
  } finally {
    iab.client.close();
  }
};

const diagnoseCodexIabForSession = async (sessionId = "", options = {}) => {
  const chatId = String(sessionId || "");
  const sockets = browserUseSockets().slice(0, Number(options.socketLimit) || 16);
  const turnIds = latestTurnIdsForSession(chatId, Number(options.turnLimit) || 4);
  const attempts = [];
  const startedAt = Date.now();
  const deadlineAt = startedAt + (Number(options.deadlineMs) || 3500);
  for (const socketPath of sockets) {
    for (const turnId of turnIds) {
      if (Date.now() >= deadlineAt) break;
      let client = null;
      const attempt = {
        socket: path.basename(socketPath),
        turnId,
        ok: false,
        type: "",
        matchedSessionId: "",
        title: "",
        url: "",
        error: "",
      };
      try {
        client = await createBrowserUseClient(socketPath);
        const info = await client.request(
          "getInfo",
          { session_id: chatId, turn_id: turnId },
          Math.max(250, Math.min(650, deadlineAt - Date.now())),
        );
        attempt.ok = true;
        attempt.type = info?.type || "";
        attempt.matchedSessionId = info?.metadata?.codexSessionId || "";
        attempt.title = info?.name || "";
        if (info?.metadata?.codexSessionId === chatId) {
          const tabs = await client.request(
            "getTabs",
            { session_id: chatId, turn_id: turnId },
            Math.max(250, Math.min(650, deadlineAt - Date.now())),
          );
          const tab = (Array.isArray(tabs) ? tabs : []).find((item) => item.active) || tabs?.[0];
          attempt.url = tab?.url || "";
          attempt.title = tab?.title || attempt.title;
        }
      } catch (error) {
        attempt.error = error.message || "Browser Use socket rejected this chat/turn.";
      } finally {
        if (client) client.close();
      }
      attempts.push(attempt);
    }
  }
  return {
    chatId,
    socketCount: browserUseSockets().length,
    socketsChecked: sockets.length,
    turnIds,
    attempts,
    elapsedMs: Date.now() - startedAt,
  };
};

const executeCodexIabCdp = async (iab, method, commandParams = {}, timeoutMs = 3500) =>
  iab.client.request(
    "executeCdp",
    {
      ...iab.sessionParams,
      target: { tabId: Number(iab.tab.id) },
      method,
      commandParams,
    },
    timeoutMs,
  );

const captureCodexIabScreenshot = async (sessionId = "") => {
  const iab = await openCodexIabForSession(sessionId);
  if (!iab) throw new Error("No real Codex browser is exposed for this chat right now.");
  try {
    await iab.client.request("attach", { ...iab.sessionParams, tabId: Number(iab.tab.id) }, 1500);
    const metrics = await executeCodexIabCdp(iab, "Page.getLayoutMetrics", {}, 2500);
    const viewport = metrics?.cssVisualViewport || {
      pageX: 0,
      pageY: 0,
      clientWidth: 1280,
      clientHeight: 820,
    };
    const shot = await executeCodexIabCdp(
      iab,
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 72,
        clip: {
          x: Number(viewport.pageX) || 0,
          y: Number(viewport.pageY) || 0,
          width: Math.min(Number(viewport.clientWidth) || 1280, 1800),
          height: Math.min(Number(viewport.clientHeight) || 820, 1400),
          scale: 1,
        },
      },
      8000,
    );
    if (!shot?.data) throw new Error("Codex browser returned no screenshot data.");
    return {
      image: Buffer.from(shot.data, "base64"),
      meta: {
        active: true,
        kind: "codex-iab",
        url: iab.tab.url || "",
        title: iab.tab.title || "",
        tabId: iab.tab.id,
        turnId: iab.turnId,
        capturedAt: new Date().toISOString(),
      },
    };
  } finally {
    try {
      await iab.client.request("detach", { ...iab.sessionParams, tabId: Number(iab.tab.id) }, 800);
    } catch {}
    iab.client.close();
  }
};

const applyCodexIabInput = async (sessionId = "", input = {}) => {
  const iab = await openCodexIabForSession(sessionId);
  if (!iab) throw new Error("No real Codex browser is exposed for this chat right now.");
  try {
    if (!urlOrigin(iab.tab.url || "")) {
      throw new Error("Real browser control is limited to local app URLs.");
    }
    await iab.client.request("attach", { ...iab.sessionParams, tabId: Number(iab.tab.id) }, 1500);
    const metrics = await executeCodexIabCdp(iab, "Page.getLayoutMetrics", {}, 2500);
    const viewport = metrics?.cssVisualViewport || { clientWidth: 1280, clientHeight: 820 };
    const width = Number(viewport.clientWidth) || 1280;
    const height = Number(viewport.clientHeight) || 820;
    const x = Math.round(Math.max(0, Math.min(1, Number(input.xRatio) || 0.5)) * width);
    const y = Math.round(Math.max(0, Math.min(1, Number(input.yRatio) || 0.5)) * height);
    const type = String(input.type || "").trim();
    if (type === "click") {
      await executeCodexIabCdp(iab, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
      });
      await executeCodexIabCdp(iab, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await executeCodexIabCdp(iab, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    } else if (type === "scroll") {
      await executeCodexIabCdp(iab, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: Number(input.deltaX) || 0,
        deltaY: Number(input.deltaY) || 0,
      });
    } else if (type === "type") {
      const text = String(input.text || "");
      if (text) await executeCodexIabCdp(iab, "Input.insertText", { text });
    } else if (type === "press") {
      const key = String(input.key || "Enter");
      const code = key === "Enter" ? "Enter" : key;
      const windowsVirtualKeyCode = key === "Enter" ? 13 : 0;
      await executeCodexIabCdp(iab, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode,
      });
      await executeCodexIabCdp(iab, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode,
      });
    } else {
      throw new Error("Unsupported real browser input.");
    }
    return safeCodexIabStatus(sessionId);
  } finally {
    try {
      await iab.client.request("detach", { ...iab.sessionParams, tabId: Number(iab.tab.id) }, 800);
    } catch {}
    iab.client.close();
  }
};

const browserSessionForChat = (sessionId) =>
  listBrowserSessions().find((session) => session.id === String(sessionId || "")) || null;

const urlIsAllowedForBrowserSession = (url, allowedOrigins = []) => {
  if (!allowedOrigins.length) return true;
  const origin = urlOrigin(url);
  return Boolean(origin && allowedOrigins.includes(origin));
};

const isLikelyAppRoute = (value) => {
  const url = cleanDetectedUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || "/";
    if (
      pathname === "/@vite/client" ||
      pathname.startsWith("/node_modules/") ||
      pathname.startsWith("/src/") ||
      pathname.startsWith("/api/") ||
      pathname.startsWith("/jarvis-browser-api/")
    )
      return false;
    if (/\.(?:tsx?|jsx?|css|map|json|png|jpe?g|gif|webp|svg|ico|woff2?)$/i.test(pathname))
      return false;
    return true;
  } catch {
    return false;
  }
};

const isReachableViteUrl = async (target) => {
  const url = cleanDetectedUrl(target);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const probe = await fetchTextWithTimeout(`${origin}/@vite/client`, 450);
    return probe.ok && /vite/i.test(probe.body);
  } catch {
    return false;
  }
};

const isVlixBridgeOrigin = (target) => {
  const url = cleanDetectedUrl(target);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname) && port === PORT;
  } catch {
    return false;
  }
};

const looksLikeVlixShellHtml = (html = "") =>
  /<title[^>]*>\s*Vlix\s*\|\s*Command local AI agents from anywhere\s*<\/title>/i.test(String(html)) ||
  /Vlix local console mirror|Command IQ Console/i.test(String(html));

const isVlixSelfViteTarget = async (target) => {
  const url = cleanDetectedUrl(target);
  if (!url) return true;
  if (isVlixBridgeOrigin(url)) return true;
  const parsed = new URL(url);
  const originPage = await fetchTextWithTimeout(`${parsed.protocol}//${parsed.host}/`, 500);
  if (originPage.ok && looksLikeVlixShellHtml(originPage.body)) return true;
  const page = await fetchTextWithTimeout(url, 500);
  return page.ok && looksLikeVlixShellHtml(page.body);
};

const extractCurrentUrlMentions = (text) => {
  const urls = [];
  const source = String(text || "");
  for (const match of source.matchAll(/Current URL:\s*(https?:\/\/[^\s"'<>]+)/gi)) {
    const clean = cleanDetectedUrl(match[1]);
    if (clean) urls.push(clean);
  }
  for (const match of source.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+\/[^\s"'<>]*/gi)) {
    const clean = cleanDetectedUrl(match[0]);
    if (clean) urls.push(clean);
  }
  return urls;
};

const extractLocalUrlMentions = (text) => {
  const urls = [];
  const source = String(text || "");
  for (const match of source.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/[^\s"'<>)]*)?/gi)) {
    const clean = cleanDetectedUrl(match[0]);
    if (clean) urls.push(clean);
  }
  return urls;
};

const selectedChatViteTarget = async (sessionId) => {
  const chatId = String(sessionId || "");
  if (!chatId) return null;
  const browserSession = browserSessionForChat(chatId);
  const allowedOrigins = browserSession?.allowedOrigins || [];
  const candidates = [];
  const seen = new Set();

  const addCandidate = (url, source, score) => {
    const clean = cleanDetectedUrl(url);
    if (!clean || seen.has(clean)) return;
    if (!urlIsAllowedForBrowserSession(clean, allowedOrigins)) return;
    if (!isLikelyAppRoute(clean)) return;
    seen.add(clean);
    candidates.push({ url: clean, source, score });
  };

  const file = sessionFileById().get(chatId);
  if (file && fs.existsSync(file)) {
    const { records } = readSessionRecords(file, { tailBytes: 512 * 1024 });
    for (const item of records.slice().reverse()) {
      const payload = item.payload || {};
      let text = "";
      if (item.type === "response_item" && payload.type === "message") {
        text = textFromContent(payload.content);
      } else if (item.type === "event_msg") {
        text = [payload.message, payload.text, payload.output, payload.url].filter(Boolean).join("\n");
      } else if (item.type === "response_item" && payload.type?.includes("function")) {
        text = JSON.stringify(payload);
      }
      if (!text) continue;
      for (const url of extractCurrentUrlMentions(text).reverse()) addCandidate(url, "current-url", 120);
      for (const url of extractLocalUrlMentions(text).reverse()) addCandidate(url, "session-url", 60);
    }
  }

  for (const origin of allowedOrigins) addCandidate(origin, "browser-session-origin", 40);

  const reachable = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score).slice(0, 6)) {
    const isVite = await withTimeout(isReachableViteUrl(candidate.url), 650, false);
    if (isVite && (await withTimeout(isVlixSelfViteTarget(candidate.url), 650, true))) continue;
    if (isVite) reachable.push({ ...candidate, isVite });
  }

  reachable.sort((a, b) => b.score - a.score);
  const target = reachable[0] || null;
  return {
    chatId,
    targetUrl: target?.url || "",
    source: target?.source || "",
    allowedOrigins,
    browserSession: browserSession
      ? { id: browserSession.id, updatedAt: browserSession.updatedAt, allowedOrigins }
      : null,
    candidates: reachable.slice(0, 8),
  };
};

const recentCodexViteUrl = async () => {
  if (Date.now() - recentCodexViteUrlCache.at < 5000) return recentCodexViteUrlCache.url;
  recentCodexViteUrlCache = { at: Date.now(), url: "" };
  const files = sessionFiles()
    .map((file) => {
      try {
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 25);

  for (const { file } of files) {
    const { records } = readSessionRecords(file, { tailBytes: 160 * 1024 });
    for (const item of records.slice().reverse()) {
      const payload = item.payload || {};
      if (item.type !== "response_item" || payload.type !== "message") continue;
      for (const url of extractCurrentUrlMentions(textFromContent(payload.content)).reverse()) {
        if (
          (await withTimeout(isReachableViteUrl(url), 900, false)) &&
          !(await withTimeout(isVlixSelfViteTarget(url), 900, true))
        ) {
          recentCodexViteUrlCache = { at: Date.now(), url };
          return url;
        }
      }
    }
  }
  return "";
};

const detectViteUrl = async (sessionId = "") => {
  if (sessionId) {
    const selectedTarget = await selectedChatViteTarget(sessionId);
    return selectedTarget?.targetUrl || "";
  }
  const recent = await recentCodexViteUrl();
  if (recent) return recent;
  const ports = [8081, 8082, 5173, 5174, 5175, 5176, 4173, 3000, 8080];
  for (const port of ports) {
    const candidate = `http://localhost:${port}`;
    const probe = await fetchTextWithTimeout(`${candidate}/@vite/client`);
    if (probe.ok && /vite/i.test(probe.body)) return candidate;
  }
  return "";
};

const decodeHtmlText = (value = "") =>
  String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const titleFromHtml = (html = "") => {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlText(match[1].replace(/\s+/g, " ").trim()) : "";
};

const liveViteTargets = async (sessionId = "", selectedOverride = null) => {
  const selected = selectedOverride || (sessionId ? await selectedChatViteTarget(sessionId) : null);
  const candidates = [];
  const seen = new Set();
  const addCandidate = (url, source, score) => {
    const clean = cleanDetectedUrl(url);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    candidates.push({ url: clean, source, score });
  };

  for (const candidate of selected?.candidates || []) {
    addCandidate(candidate.url, candidate.source || "selected-chat", candidate.score || 120);
  }
  if (sessionId) return candidates.sort((a, b) => b.score - a.score).slice(0, 8);

  const recent = await recentCodexViteUrl();
  if (recent) addCandidate(recent, "recent-codex-url", 90);

  for (const session of listBrowserSessions()) {
    for (const origin of session.allowedOrigins || []) addCandidate(origin, "browser-session-origin", 50);
  }

  const ports = [5173, 8081, 8082, 5174, 5175, 5176, 4173, 3000, 8080];
  for (const port of ports) {
    addCandidate(`http://127.0.0.1:${port}`, "live-port", 30);
    addCandidate(`http://localhost:${port}`, "live-port", 25);
  }

  const live = [];
  const probeCandidates = candidates.sort((a, b) => b.score - a.score).slice(0, 14);
  const probed = await Promise.all(
    probeCandidates.map(async (candidate) => {
      if (!(await withTimeout(isReachableViteUrl(candidate.url), 900, false))) return null;
      const page = await withTimeout(fetchTextWithTimeout(candidate.url, 500), 750, { ok: false, body: "" });
      const title = page.ok ? titleFromHtml(page.body) : "";
      if (looksLikeVlixShellHtml(page.body)) return null;
      let score = candidate.score;
      if (/vlix|command local ai/i.test(title)) score += 45;
      if (/lovable app/i.test(title)) score -= 25;
      return {
        ...candidate,
        score,
        title,
      };
    })
  );
  live.push(...probed.filter(Boolean));

  live.sort((a, b) => b.score - a.score);
  return live.slice(0, 12);
};

const livePreviewChoices = async (sessionId = "", selectedOverride = null) => {
  const selectedTargets = await liveViteTargets(sessionId, selectedOverride);
  if (sessionId) return selectedTargets;
  return selectedTargets;
};

const remoteBrowserPublicState = async (state) => {
  if (!state) {
    return {
      active: false,
      url: "",
      title: "",
      startedAt: null,
      lastFrameAt: null,
      lastDomAt: null,
      headless: false,
      logs: [],
    };
  }
  let title = "";
  if (state.page && !state.page.isClosed()) {
    title = await withTimeout(state.page.title(), 600, "");
  }
  return {
    active: Boolean(state.browser && state.page && !state.page.isClosed()),
    url: state.url,
    title,
    startedAt: state.startedAt,
    lastFrameAt: state.lastFrameAt,
    lastDomAt: state.lastDomAt,
    headless: state.headless,
    logs: state.logs.slice(-16),
  };
};

const viteBrowserStatus = async (sessionId = "") => {
  const debugStatus = /^(1|true|yes)$/i.test(String(process.env.VLIX_DEBUG_BROWSER_STATUS || ""));
  const startedAt = Date.now();
  const mark = (label) => {
    if (debugStatus) console.log(`[vite-status] ${label} ${Date.now()}`);
  };
  mark("start");
  const state = remoteBrowserState(sessionId, { create: false });
  const remote = await remoteBrowserPublicState(state);
  mark("title");
  const selectedBrowser = sessionId ? await selectedChatViteTarget(sessionId) : null;
  mark("selected");
  const detectedUrl = selectedBrowser?.targetUrl || "";
  mark("detected");
  const availableViteTargets = await livePreviewChoices(sessionId, selectedBrowser);
  mark("available");
  const mode = remote.active ? "preview" : "none";
  let reason = sessionId ? "No Playwright Live Preview is running for this chat." : "No chat selected.";
  if (remote.active) {
    reason = "Playwright Live Preview is running for this chat.";
  } else if (detectedUrl) {
    reason = "Live Preview target found. Open preview to control it.";
  } else if (sessionId) {
    reason = "No Playwright target is tied to this chat yet.";
  }
  return {
    ok: true,
    mode,
    kind: mode === "preview" ? "playwright-live-preview" : "no-browser",
    reason,
    active: remote.active,
    url: remote.url,
    title: remote.title,
    startedAt: remote.startedAt,
    lastFrameAt: remote.lastFrameAt,
    lastDomAt: remote.lastDomAt,
    headless: remote.headless,
    detectedUrl,
    selectedBrowser,
    codexIab: { active: false, reason: "Codex in-app browser mirroring is disabled for this UI path." },
    availableViteTargets,
    health: {
      mode,
      reason,
      responseMs: Date.now() - startedAt,
      selectedChatId: sessionId,
      remoteKey: remoteBrowserKey(sessionId),
    },
    logs: remote.logs,
  };
};

const ensureViteBrowser = async (target, sessionId = "") => {
  const url = normalizeBrowserTarget(target || (await detectViteUrl(sessionId)));
  if (isVlixBridgeOrigin(url)) throw new Error("Refusing to mirror the Vlix bridge into itself.");
  if (await withTimeout(isVlixSelfViteTarget(url), 900, true)) {
    throw new Error("Refusing to show the Vlix console inside Live Preview.");
  }
  const state = remoteBrowserState(sessionId);
  const { chromium } = require("playwright");
  if (!state.browser) {
    const visibleBrowser = /^(1|true|yes)$/i.test(String(process.env.VLIX_VISIBLE_BROWSER || ""));
    state.browser = await chromium.launch({
      headless: !visibleBrowser,
      args: visibleBrowser ? ["--window-size=1280,820"] : [],
    });
    state.headless = !visibleBrowser;
    rememberViteBrowserLog(state, {
      type: "browser",
      level: "info",
      text: visibleBrowser ? "Started visible Playwright Live Preview" : "Started headless Playwright Live Preview",
    });
    state.startedAt = new Date().toISOString();
  }
  if (!state.page || state.page.isClosed()) {
    state.page = await state.browser.newPage({ viewport: { width: 1280, height: 820 } });
    attachViteBrowserPageEvents(state, state.page);
  }
  await state.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  state.url = url;
  rememberViteBrowserLog(state, { type: "browser", level: "info", text: `Opened ${url}` });
  return viteBrowserStatus(sessionId);
};

const requireVitePage = (sessionId = "") => {
  const state = remoteBrowserState(sessionId, { create: false });
  if (!state?.page || state.page.isClosed()) throw new Error("Start Playwright Live Preview first.");
  return { state, page: state.page };
};

const captureViteDomSnapshot = async (sessionId = "") => {
  const { state, page } = requireVitePage(sessionId);
  const snapshot = await page.evaluate(() => {
    const interactiveSelector = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[tabindex]",
      "[contenteditable='true']",
    ].join(",");
    const liveNodes = Array.from(document.querySelectorAll(interactiveSelector));
    liveNodes.forEach((node, index) => {
      if (!node.getAttribute("data-vlix-node-id")) {
        node.setAttribute("data-vlix-node-id", `vlix-${index + 1}`);
      }
    });

    const clone = document.documentElement.cloneNode(true);
    const sourceInputs = Array.from(document.documentElement.querySelectorAll("input, textarea, select"));
    const clonedInputs = Array.from(clone.querySelectorAll("input, textarea, select"));
    clonedInputs.forEach((node, index) => {
      const source = sourceInputs[index];
      if (!source) return;
      if (node.tagName === "TEXTAREA") node.textContent = source.value || "";
      if (node.tagName === "SELECT") {
        Array.from(node.options || []).forEach((option) => {
          option.toggleAttribute("selected", option.value === source.value);
        });
      }
      if (node.tagName === "INPUT") {
        const type = String(node.getAttribute("type") || "").toLowerCase();
        if (type === "checkbox" || type === "radio") {
          node.toggleAttribute("checked", Boolean(source.checked));
        } else {
          node.setAttribute("value", source.value || "");
        }
      }
    });
    clone.querySelectorAll("script").forEach((node) => node.remove());
    clone.querySelectorAll("*").forEach((node) => {
      for (const attribute of Array.from(node.attributes || [])) {
        if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
      }
    });

    let head = clone.querySelector("head");
    if (!head) {
      head = document.createElement("head");
      clone.insertBefore(head, clone.firstChild);
    }
    const base = document.createElement("base");
    base.href = location.href;
    head.prepend(base);

    const mirrorStyle = document.createElement("style");
    mirrorStyle.textContent = `
      html, body { min-height: 100%; }
      body { margin: 0; cursor: default; }
      [data-vlix-node-id] { cursor: pointer; }
      [data-vlix-node-id]:hover { outline: 2px solid rgba(45, 212, 255, .72); outline-offset: 2px; }
      * { -webkit-tap-highlight-color: rgba(45, 212, 255, .22); }
    `;
    head.appendChild(mirrorStyle);

    const body = clone.querySelector("body") || clone;
    const bridgeScript = document.createElement("script");
    bridgeScript.textContent = `
      (() => {
        const send = (payload) => parent.postMessage({ source: "vlix-vite-dom", ...payload }, "*");
        const ratios = (event) => {
          const rect = document.documentElement.getBoundingClientRect();
          return {
            xRatio: rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0.5,
            yRatio: rect.height ? Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) : 0.5
          };
        };
        const nodeId = (event) => event.target?.closest?.("[data-vlix-node-id]")?.getAttribute("data-vlix-node-id") || "";
        document.addEventListener("click", (event) => {
          send({ type: "click", nodeId: nodeId(event), ...ratios(event) });
          event.preventDefault();
          event.stopPropagation();
        }, true);
        document.addEventListener("submit", (event) => {
          event.preventDefault();
          event.stopPropagation();
        }, true);
        document.addEventListener("wheel", (event) => {
          send({ type: "scroll", nodeId: nodeId(event), deltaX: event.deltaX, deltaY: event.deltaY, ...ratios(event) });
        }, { passive: true, capture: true });
        document.addEventListener("keydown", (event) => {
          const id = nodeId(event);
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
            send({ type: "type", nodeId: id, text: event.key });
          } else if (["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
            send({ type: "press", nodeId: id, key: event.key });
          }
        }, true);
      })();
    `;
    body.appendChild(bridgeScript);

    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      capturedAt: new Date().toISOString(),
      nodeCount: liveNodes.length,
      html: `<!doctype html>\n${clone.outerHTML}`,
    };
  });
  state.lastDomAt = snapshot.capturedAt;
  return snapshot;
};

const applyViteBrowserInput = async (input = {}) => {
  const chatId = input.chatId || "";
  const { state, page } = requireVitePage(chatId);
  const type = String(input.type || "").trim();
  const viewport = page.viewportSize() || { width: 1280, height: 820 };
  const nodeId = String(input.nodeId || "").replace(/[^\w:-]/g, "");
  if (type === "click") {
    let clickedNode = false;
    if (nodeId) {
      try {
        await page.locator(`[data-vlix-node-id="${nodeId}"]`).first().click({
          timeout: 1200,
          button: input.button === "right" ? "right" : "left",
          clickCount: Number(input.clickCount) || 1,
        });
        clickedNode = true;
        rememberViteBrowserLog(state, { type: "input", level: "info", text: `Clicked DOM node ${nodeId}` });
      } catch {}
    }
    if (!clickedNode) {
      const xRatio = Math.max(0, Math.min(1, Number(input.xRatio)));
      const yRatio = Math.max(0, Math.min(1, Number(input.yRatio)));
      const x = Math.round(xRatio * viewport.width);
      const y = Math.round(yRatio * viewport.height);
      await page.mouse.click(x, y, {
        button: input.button === "right" ? "right" : "left",
        clickCount: Number(input.clickCount) || 1,
      });
      rememberViteBrowserLog(state, { type: "input", level: "info", text: `Clicked ${x}, ${y}` });
    }
  } else if (type === "scroll") {
    if (nodeId) {
      try {
        await page.locator(`[data-vlix-node-id="${nodeId}"]`).first().hover({ timeout: 800 });
      } catch {}
    }
    await page.mouse.wheel(Number(input.deltaX) || 0, Number(input.deltaY) || 0);
    rememberViteBrowserLog(state, {
      type: "input",
      level: "info",
      text: `Scrolled ${Number(input.deltaX) || 0}, ${Number(input.deltaY) || 0}`,
    });
  } else if (type === "type") {
    const text = String(input.text || "");
    if (nodeId) {
      try {
        await page.locator(`[data-vlix-node-id="${nodeId}"]`).first().focus({ timeout: 800 });
      } catch {}
    }
    if (text) await page.keyboard.type(text, { delay: 8 });
    rememberViteBrowserLog(state, { type: "input", level: "info", text: `Typed ${text.length} chars` });
  } else if (type === "press") {
    const key = String(input.key || "").trim();
    if (!key) throw new Error("Provide a key to press.");
    if (nodeId) {
      try {
        await page.locator(`[data-vlix-node-id="${nodeId}"]`).first().focus({ timeout: 800 });
      } catch {}
    }
    await page.keyboard.press(key);
    rememberViteBrowserLog(state, { type: "input", level: "info", text: `Pressed ${key}` });
  } else {
    throw new Error("Unsupported Vite browser input.");
  }
  return viteBrowserStatus(chatId);
};

const handleCodexBrowserApi = async (req, res, reqUrl) => {
  if (!isLoopbackRequest(req)) {
    sendLocalApi(req, res, 403, {
      error: "Real Codex browser attach is only available on this computer.",
    });
    return true;
  }
  if (req.headers.origin && !localApiCorsHeaders(req)) {
    send(res, 403, { error: "Origin is not allowed for local browser control." });
    return true;
  }

  const chatId = reqUrl.searchParams.get("chatId") || "";

  if (req.method === "GET" && reqUrl.pathname === "/api/codex-browser/status") {
    const codexIab = await safeCodexIabStatus(chatId);
    const debug =
      reqUrl.searchParams.get("debug") === "1"
        ? await diagnoseCodexIabForSession(chatId, { deadlineMs: 4000, socketLimit: 16 })
        : null;
    sendLocalApi(req, res, 200, { ok: true, codexIab, debug });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/codex-browser/screenshot") {
    try {
      const { image, meta } = await captureCodexIabScreenshot(chatId);
      const corsHeaders = localApiCorsHeaders(req) || {};
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "image/jpeg",
        "X-Vlix-Browser-Meta": Buffer.from(JSON.stringify(meta)).toString("base64"),
        ...corsHeaders,
      });
      res.end(image);
    } catch (error) {
      sendLocalApi(req, res, 409, { error: error.message || "Real Codex browser is not ready." });
    }
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/codex-browser/input") {
    const body = await readBody(req);
    try {
      sendLocalApi(req, res, 200, {
        ok: true,
        codexIab: await applyCodexIabInput(body.chatId || chatId, body),
      });
    } catch (error) {
      sendLocalApi(req, res, 409, { error: error.message || "Real browser input failed." });
    }
    return true;
  }

  return false;
};

const handleViteBrowserApi = async (req, res, reqUrl) => {
  if (!isLoopbackRequest(req)) {
    sendLocalApi(req, res, 403, {
      error: "Vite browser control is only available on this computer.",
    });
    return true;
  }
  if (req.headers.origin && !localApiCorsHeaders(req)) {
    send(res, 403, { error: "Origin is not allowed for local browser control." });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/vite-browser/status") {
    sendLocalApi(req, res, 200, await viteBrowserStatus(reqUrl.searchParams.get("chatId") || ""));
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/vite-browser/dom") {
    const chatId = reqUrl.searchParams.get("chatId") || "";
    const state = remoteBrowserState(chatId, { create: false });
    if (!state?.page || state.page.isClosed()) {
      sendLocalApi(req, res, 409, {
        error: "No Playwright Live Preview is running for this selected chat.",
        mode: "none",
        reason: "Open preview to start a per-chat Playwright browser.",
      });
      return true;
    }
    try {
      const status = await viteBrowserStatus(chatId);
      const mirror = await captureViteDomSnapshot(chatId);
      sendLocalApi(req, res, 200, { ...status, mirror });
    } catch (error) {
      sendLocalApi(req, res, 500, { error: error.message || "DOM mirror failed." });
    }
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/vite-browser/start") {
    const body = await readBody(req);
    const chatId = body.chatId || "";
    const explicitTarget = body.url || "";
    const target = explicitTarget || (await detectViteUrl(chatId));
    if (!target) {
      const selectedBrowser = chatId ? await selectedChatViteTarget(chatId) : null;
      const availableViteTargets = await livePreviewChoices(chatId, selectedBrowser);
      sendLocalApi(req, res, 409, {
        error: chatId
          ? "The selected chat does not have its own reachable browser target."
          : "No reachable Vite browser was detected.",
        selectedBrowser,
        availableViteTargets,
        mode: "none",
        reason: chatId
          ? "No Playwright target is tied to this chat yet."
          : "No reachable local browser target was detected yet.",
      });
      return true;
    }
    sendLocalApi(req, res, 200, await ensureViteBrowser(target, chatId));
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/vite-browser/reload") {
    const body = await readBody(req);
    const chatId = body.chatId || "";
    const state = remoteBrowserState(chatId, { create: false });
    if (!state?.page || state.page.isClosed()) {
      const explicitTarget = body.url || "";
      const target = explicitTarget || (await detectViteUrl(chatId));
      if (!target) {
        const selectedBrowser = chatId ? await selectedChatViteTarget(chatId) : null;
        const availableViteTargets = await livePreviewChoices(chatId, selectedBrowser);
        sendLocalApi(req, res, 409, {
          error: chatId
            ? "The selected chat does not have its own reachable browser target."
            : "No reachable Vite browser was detected.",
          selectedBrowser,
          availableViteTargets,
          mode: "none",
          reason: chatId
            ? "No Playwright target is tied to this chat yet."
            : "No reachable local browser target was detected yet.",
        });
        return true;
      }
      sendLocalApi(req, res, 200, await ensureViteBrowser(target, chatId));
      return true;
    }
    if (body.url) {
      sendLocalApi(req, res, 200, await ensureViteBrowser(body.url, chatId));
      return true;
    }
    await state.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    rememberViteBrowserLog(state, { type: "browser", level: "info", text: "Reloaded Playwright Live Preview" });
    sendLocalApi(req, res, 200, await viteBrowserStatus(chatId));
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/vite-browser/input") {
    const body = await readBody(req);
    try {
      sendLocalApi(req, res, 200, await applyViteBrowserInput(body));
    } catch (error) {
      sendLocalApi(req, res, 409, { error: error.message || "Input failed." });
    }
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/vite-browser/stop") {
    const body = await readBody(req);
    const chatId = body.chatId || reqUrl.searchParams.get("chatId") || "";
    await closeViteBrowser(chatId);
    sendLocalApi(req, res, 200, await viteBrowserStatus(chatId));
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/vite-browser/screenshot") {
    const chatId = reqUrl.searchParams.get("chatId") || "";
    const state = remoteBrowserState(chatId, { create: false });
    if (!state?.page || state.page.isClosed()) {
      sendLocalApi(req, res, 409, {
        error: "No Playwright Live Preview is running for this selected chat.",
        mode: "none",
        reason: "Open preview to start a per-chat Playwright browser.",
      });
      return true;
    }
    try {
      const image = await state.page.screenshot({
        type: "jpeg",
        quality: 62,
        fullPage: false,
      });
      state.lastFrameAt = new Date().toISOString();
      const corsHeaders = localApiCorsHeaders(req) || {};
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "image/jpeg",
        ...corsHeaders,
      });
      res.end(image);
    } catch (error) {
      sendLocalApi(req, res, 500, { error: error.message || "Screenshot failed." });
    }
    return true;
  }

  return false;
};

const handleScreenshot = async (req, res, reqUrl) => {
  const target = reqUrl.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    send(res, 400, { error: "Provide an http(s) URL." });
    return;
  }

  try {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(700);
    const image = await page.screenshot({ type: "png", fullPage: false });
    await browser.close();
    send(res, 200, image);
  } catch (error) {
    send(res, 500, { error: error.message || "Screenshot failed." });
  }
};

const launchVisibleBrowser = async (req, res) => {
  const body = await readBody(req);
  const target = body.url;
  if (!target || !/^https?:\/\//i.test(target)) {
    send(res, 400, { error: "Provide an http(s) URL." });
    return;
  }

  const script = `
    const { chromium } = require("playwright");
    (async () => {
      const browser = await chromium.launch({ headless: false });
      const page = await browser.newPage();
      await page.goto(${JSON.stringify(target)}, { waitUntil: "domcontentloaded" });
      setInterval(() => {}, 1000);
    })().catch((error) => { console.error(error); process.exit(1); });
  `;

  const child = spawn(process.execPath, ["-e", script], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  send(res, 200, { ok: true, message: "Visible Chromium launched.", url: target });
};

const routeApi = async (req, res, reqUrl) => {
  if (req.method === "OPTIONS" && LOCAL_CLOUD_API_PATHS.has(reqUrl.pathname)) {
    sendLocalApiOptions(req, res);
    return true;
  }

  if (reqUrl.pathname.startsWith("/api/vite-browser/")) {
    return handleViteBrowserApi(req, res, reqUrl);
  }

  if (reqUrl.pathname.startsWith("/api/codex-browser/")) {
    return handleCodexBrowserApi(req, res, reqUrl);
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/app-version") {
    send(res, 200, { version: appAssetVersion() });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/cloud/status") {
    sendLocalApi(req, res, 200, { cloud: { ...cloudSyncState, hasConfig: Boolean(cloudConfig()) } });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/bridge/info") {
    sendLocalApi(req, res, 200, bridgeInfo(req, readBridgeAccount()));
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/cloud/connect") {
    if (!isLoopbackRequest(req)) {
      sendLocalApi(req, res, 403, { error: "Cloud setup can only be accepted by this computer." });
      return true;
    }
    if (req.headers.origin && !localApiCorsHeaders(req)) {
      send(res, 403, { error: "Origin is not allowed for local bridge setup." });
      return true;
    }
    const body = await readBody(req);
    const config = cloudConfigFromConnectPayload(body);
    if (!config) {
      sendLocalApi(req, res, 400, {
        error: "Provide a valid VLIX_BRIDGE_SETUP payload or cloud config.",
      });
      return true;
    }
    let syncedAccount;
    try {
      await codexAppServer.ensure();
      syncedAccount = syncBridgeAccountFromCodex(connectBridgeAccount());
      await cloudUpsertDevice(config);
      await syncLocalSessionsToCloud(config, syncedAccount, {
        limit: 240,
        messageChatLimit: 36,
        messagesPerChat: 60,
      });
      cloudSessionSyncAt = Date.now();
    } catch (error) {
      cloudSyncState = {
        enabled: false,
        lastPollAt: null,
        lastError: error.message || "Could not connect cloud bridge.",
        deviceId: "",
        accountId: config.accountId || "",
      };
      sendLocalApi(req, res, 502, {
        ok: false,
        error: cloudSyncState.lastError,
        cloud: { ...cloudSyncState, hasConfig: false },
      });
      return true;
    }
    saveCloudConfig(config);
    startCloudSync();
    sendLocalApi(req, res, 200, {
      ok: true,
      cloud: { ...cloudSyncState, hasConfig: true },
      account: publicBridgeAccount(syncedAccount),
      info: bridgeInfo(req, syncedAccount),
    });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/bridge/account/public") {
    const account = publicAccountFromSetupToken(
      reqUrl.searchParams.get("account") || "",
      reqUrl.searchParams.get("setupToken") || "",
    );
    if (!account) {
      send(res, 401, { ok: false, error: "Account QR is invalid or expired." });
      return true;
    }
    send(res, 200, { ok: true, account });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/pairing/start") {
    if (!isLoopbackRequest(req)) {
      sendLocalApi(req, res, 403, { error: "Start phone pairing from the desktop console." });
      return true;
    }
    const account = ensureBridgeAccount();
    if (!isBridgeAccountIntegrated(account)) {
      sendLocalApi(req, res, 409, {
        error:
          "This bridge account is not integrated with a desktop yet. Save it as a test account, then connect a desktop bridge before pairing a phone.",
        account: publicBridgeAccount(account),
      });
      return true;
    }
    const syncedAccount = syncBridgeAccountFromCodex(account);
    let pairing;
    try {
      pairing = await createPairing(req, syncedAccount);
    } catch (error) {
      sendLocalApi(req, res, 409, { error: error.message || "Phone pairing is unavailable." });
      return true;
    }
    sendLocalApi(req, res, 200, {
      token: pairing.token,
      url: pairing.url,
      qr: pairing.qr,
      account: pairing.account,
      phoneDeviceId: pairing.phoneDeviceId,
      expiresAt: pairing.expiresAt,
      expiresInSeconds: Math.round(PAIRING_TTL_MS / 1000),
    });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/pairing/validate") {
    const pairing = getValidPairing(req, reqUrl);
    if (!pairing) {
      send(res, 401, { ok: false, error: "Pairing expired or missing." });
      return true;
    }
    const account = readStoredBridgeAccountById(pairing.accountId);
    if (!account) {
      send(res, 404, { ok: false, error: "Bridge account was not found." });
      return true;
    }
    send(res, 200, {
      ok: true,
      account: publicBridgeAccount(account),
      desktopDeviceId: pairing.desktopDeviceId,
      phoneDeviceId: pairing.phoneDeviceId,
      expiresAt: pairing.expiresAt,
    });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/pairing/disconnect") {
    const token = getPairingToken(req, reqUrl);
    const result = revokePairingToken(token, { allowClearAll: isLoopbackRequest(req) });
    console.log(
      `Phone pairing disconnect: token=${token ? token.slice(0, 8) : "none"} revoked=${result.revokedCount} remaining=${result.remainingPairings}`,
    );
    send(res, 200, result, { "Set-Cookie": clearPairingCookie() });
    return true;
  }

  const auth = authorizeApi(req, reqUrl);
  if (!auth.ok) {
    send(res, 403, { error: auth.reason || "Not authorized." });
    return true;
  }
  const account = accountFromAuth(auth);

  if (req.method === "GET" && reqUrl.pathname === "/api/codex-settings") {
    send(res, 200, readCodexSettings());
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/codex-settings") {
    const body = await readBody(req);
    send(
      res,
      200,
      writeCodexSettings({
        model: body.model,
        effort: body.effort,
        fullAccess: Boolean(body.fullAccess),
      }),
    );
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/bridge/info") {
    sendLocalApi(req, res, 200, bridgeInfo(req, account));
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/bridge/account") {
    send(res, 200, { account: publicBridgeAccount(account) });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/bridge/account/qr") {
    if (!auth.local) {
      send(res, 403, { error: "Account QR can only be generated from the desktop." });
      return true;
    }
    send(res, 200, await createAccountQr(req));
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/attachment") {
    const requested = String(reqUrl.searchParams.get("path") || "");
    const filePath = path.resolve(requested);
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".gif"
            ? "image/gif"
            : ext === ".webp"
              ? "image/webp"
              : "";
    if (!contentType || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      send(res, 404, { error: "Image attachment was not found." });
      return true;
    }
    res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/bridge/sync") {
    if (!auth.local) {
      send(res, 403, { error: "Bridge sync can only be started from the desktop bridge." });
      return true;
    }
    const syncedAccount = syncBridgeAccountFromCodex(account);
    send(res, 200, {
      account: publicBridgeAccount(syncedAccount),
      chats: listChatsForAccount(syncedAccount),
      workspaces: listWorkspacesForAccount(syncedAccount),
    });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/bridge/account/new") {
    if (!auth.local) {
      send(res, 403, { error: "Bridge accounts can only be created from the desktop." });
      return true;
    }
    const body = await readBody(req);
    const previous = readBridgeAccount();
    if (previous) saveBridgeAccountSnapshot(previous);
    const displayName =
      String(body.displayName || "").trim() ||
      `Private Vlix Bridge ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", minute: "2-digit", hour: "numeric" }).format(new Date())}`;
    const nextAccount = createBridgeAccount(displayName, {
      connectDesktop: false,
      legacyCodexAccess: false,
    });
    send(res, 200, {
      account: publicBridgeAccount(nextAccount),
      previousAccount: publicBridgeAccount(previous),
    });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/bridge/account") {
    if (!auth.local) {
      send(res, 403, { error: "Bridge account can only be created from the desktop." });
      return true;
    }
    const body = await readBody(req);
    const existing = readBridgeAccount();
    const displayName = String(
      body.displayName || existing?.displayName || bridgeAccountName(),
    ).trim();
    const account = existing || createBridgeAccount(displayName);
    if (existing && displayName && displayName !== existing.displayName) {
      account.displayName = compact(displayName, 80);
      if (account.desktopDevice) account.desktopDevice.lastSeenAt = new Date().toISOString();
      writeBridgeAccount(account);
    }
    send(res, 200, { account: publicBridgeAccount(account) });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/bridge/connect") {
    if (!auth.local) {
      send(res, 403, { error: "Desktop bridge can only be connected from this computer." });
      return true;
    }
    try {
      await codexAppServer.ensure();
    } catch (error) {
      console.error(`Desktop bridge connect failed: ${error.message}`);
      send(res, 502, {
        ok: false,
        error: `Could not reach the desktop agent: ${error.message}`,
        account: publicBridgeAccount(readBridgeAccount()),
        codexBridge: codexAppServer.status,
      });
      return true;
    }
    const connected = connectBridgeAccount();
    const synced = syncBridgeAccountFromCodex(connected);
    console.log(
      `Desktop bridge connected: account=${synced.accountId} sessions=${synced.sessionIds.length} mode=${codexAppServer.status.mode}`,
    );
    send(res, 200, {
      ok: true,
      account: publicBridgeAccount(synced),
      chats: listChatsForAccount(synced),
      workspaces: listWorkspacesForAccount(synced),
      codexBridge: codexAppServer.status,
      preflight: {
        binary: codexAppServer.status.binary,
        mode: codexAppServer.status.mode,
        userAgent: codexAppServer.status.userAgent,
      },
    });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/bridge/disconnect") {
    if (!auth.local) {
      send(res, 403, { error: "Desktop bridge can only be disconnected from this computer." });
      return true;
    }
    const disconnected = disconnectBridgeAccount();
    console.log(`Desktop bridge disconnected: account=${disconnected.accountId}`);
    send(
      res,
      200,
      { ok: true, account: publicBridgeAccount(disconnected) },
      { "Set-Cookie": clearPairingCookie() },
    );
    return true;
  }

  if (!account) {
    send(res, 404, { error: "Bridge account was not found." });
    return true;
  }

  if (
    !isBridgeAccountIntegrated(account) &&
    handleUnintegratedAccountRoute(req, res, reqUrl, account)
  ) {
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/chats") {
    await codexAppServer.ensure().catch(() => null);
    const liveAccount = syncBridgeAccountFromCodex(account);
    send(res, 200, {
      chats: listChatsForAccount(liveAccount, { force: true }),
      account: publicBridgeAccount(liveAccount),
      codexHome: CODEX_HOME,
      codexBridge: codexAppServer.status,
    });
    return true;
  }

  const chatMatch = reqUrl.pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (req.method === "GET" && chatMatch) {
    const id = decodeURIComponent(chatMatch[1]);
    if (!accountCanAccessChat(account, id)) {
      send(res, 404, { error: "Chat is not available for this bridge account." });
      return true;
    }
    const chat = getIndexedChat(id);
    if (!chat?.file) {
      send(res, 404, { error: "Chat session file was not found." });
      return true;
    }
    const { parsed, ...chatSummary } = chat;
    send(res, 200, {
      chat: chatSummary,
      meta: publicSessionMeta(parsed.meta),
      messages: parsed.messages,
      timeline: parsed.timeline || parsed.messages,
    });
    return true;
  }

  const chatEventsMatch = reqUrl.pathname.match(/^\/api\/chats\/([^/]+)\/events$/);
  if (req.method === "GET" && chatEventsMatch) {
    const id = decodeURIComponent(chatEventsMatch[1]);
    if (!accountCanAccessChat(account, id)) {
      res.writeHead(404, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        `event: error\ndata: ${JSON.stringify({ error: "Chat is not available for this bridge account." })}\n\n`,
      );
      return true;
    }
    const chatFile = sessionFileById().get(id);
    if (!chatFile) {
      res.writeHead(404, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        `event: error\ndata: ${JSON.stringify({ error: "Chat session file was not found." })}\n\n`,
      );
      return true;
    }

    res.writeHead(200, {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendChanged = () => {
      if (!fs.existsSync(chatFile)) return;
      const stat = fs.statSync(chatFile);
      res.write(`event: changed\n`);
      res.write(`data: ${JSON.stringify({ chatId: id, updatedAt: stat.mtime.toISOString() })}\n\n`);
    };

    let closed = false;
    const watcher = () => {
      if (!closed) sendChanged();
    };
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: ping ${Date.now()}\n\n`);
    }, 15_000);
    sendChanged();
    fs.watchFile(chatFile, { interval: 250 }, watcher);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      fs.unwatchFile(chatFile, watcher);
    });
    return true;
  }

  const sendMatch = reqUrl.pathname.match(/^\/api\/chats\/([^/]+)\/send$/);
  if (req.method === "POST" && sendMatch) {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    const attachments = normalizeInboundAttachments(body.attachments);
    if (!message && !attachments.length) {
      send(res, 400, { error: "Message or image is required." });
      return true;
    }
    const sessionId = decodeURIComponent(sendMatch[1]);
    if (!accountCanAccessChat(account, sessionId)) {
      send(res, 404, { error: "Chat is not available for this bridge account." });
      return true;
    }
    const chat = getIndexedChat(sessionId);
    if (chat?.observedWorking || sessionIsActivelyWorking(sessionId)) {
      const task = queueCodexTask(sessionId, message, {
        accountId: account.accountId,
        attachments,
        fullAuto: Boolean(body.fullAuto),
        model: body.model,
        effort: body.effort,
      });
      send(res, 202, { taskId: task.id, queued: true, task: publicTask(task) });
      return true;
    }
    const task = startCodexTask(sessionId, message, {
      accountId: account.accountId,
      attachments,
      fullAuto: Boolean(body.fullAuto),
      model: body.model,
      effort: body.effort,
    });
    send(res, 202, { taskId: task.id, task: publicTask(task) });
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/chats/send-new") {
    const body = await readBody(req);
    const message = String(body.message || "").trim();
    const attachments = normalizeInboundAttachments(body.attachments);
    if (!message && !attachments.length) {
      send(res, 400, { error: "Message or image is required." });
      return true;
    }
    const cwd = account.legacyCodexAccess ? body.cwd : accountPrivateWorkspace(account);
    const task = startCodexTask(null, message, {
      accountId: account.accountId,
      attachments,
      fullAuto: Boolean(body.fullAuto),
      model: body.model,
      effort: body.effort,
      cwd,
    });
    send(res, 202, { taskId: task.id, task: publicTask(task) });
    return true;
  }

  const taskMatch = reqUrl.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const task = tasks.get(decodeURIComponent(taskMatch[1]));
    if (
      !task ||
      (task.accountId && task.accountId !== account.accountId && !account.legacyCodexAccess)
    )
      send(res, 404, { error: "Task not found." });
    else send(res, 200, { task: publicTask(task) });
    return true;
  }

  const taskStopMatch = reqUrl.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
  if (req.method === "POST" && taskStopMatch) {
    const task = tasks.get(decodeURIComponent(taskStopMatch[1]));
    if (
      !task ||
      (task.accountId && task.accountId !== account.accountId && !account.legacyCodexAccess)
    ) {
      send(res, 404, { error: "Task not found." });
      return true;
    }
    const result = await interruptTask(task);
    send(res, 200, { ...result, task: publicTask(task) });
    return true;
  }

  const chatStopMatch = reqUrl.pathname.match(/^\/api\/chats\/([^/]+)\/stop$/);
  if (req.method === "POST" && chatStopMatch) {
    const sessionId = decodeURIComponent(chatStopMatch[1]);
    if (!accountCanAccessChat(account, sessionId)) {
      send(res, 404, { error: "Chat is not available for this bridge account." });
      return true;
    }
    const task = [...tasks.values()].find(
      (item) => item.status === "running" && item.sessionId === sessionId,
    );
    const result = task ? await interruptTask(task) : await interruptObservedSession(sessionId);
    send(res, 200, result);
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/browser-sessions") {
    send(res, 200, {
      sessions: listBrowserSessionsForAccount(account),
      account: publicBridgeAccount(account),
    });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/automations") {
    send(res, 200, {
      automations: listAutomationsForAccount(account),
      account: publicBridgeAccount(account),
    });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/workspaces") {
    send(res, 200, {
      workspaces: listWorkspacesForAccount(account),
      account: publicBridgeAccount(account),
    });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/tasks") {
    send(res, 200, {
      tasks: listActiveTasksForAccount(account),
      account: publicBridgeAccount(account),
      appVersion: appAssetVersion(),
    });
    return true;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/browser-screenshot") {
    await handleScreenshot(req, res, reqUrl);
    return true;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/browser-open") {
    await launchVisibleBrowser(req, res);
    return true;
  }

  return false;
};

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (reqUrl.pathname.startsWith("/api/") && (await routeApi(req, res, reqUrl))) return;
  } catch (error) {
    send(res, 500, { error: error.message || "Unexpected server error." });
    return;
  }

  if (reqUrl.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/disconnect-phone") {
    const token = getPairingToken(req, reqUrl);
    const result = revokePairingToken(token);
    console.log(
      `Phone pairing disconnect page: token=${token ? token.slice(0, 8) : "none"} revoked=${result.revokedCount} remaining=${result.remainingPairings}`,
    );
    res.writeHead(303, {
      "Cache-Control": "no-store",
      Location: "/?phone=1&disconnected=1",
      "Set-Cookie": clearPairingCookie(),
    });
    res.end();
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/cloud-connect") {
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(localCloudConnectPage());
    return;
  }

  const filePath = safePath(reqUrl.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".json"
            ? "application/json; charset=utf-8"
            : ext === ".svg"
              ? "image/svg+xml"
              : ext === ".png"
                ? "image/png"
                : "text/plain; charset=utf-8";

  const headers = { "Cache-Control": "no-store", "Content-Type": contentType };
  const incomingPair = String(reqUrl.searchParams.get("pair") || "").trim();
  if (ext === ".html" && incomingPair) {
    headers["Set-Cookie"] = pairingCookie(incomingPair);
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
});

const startServer = () => {
  server.listen(PORT, HOST, () => {
    const url = localOrigin();
    const setupUrl = hostedDesktopSetupUrl();
    const browserUrl = startupBrowserUrl();
    console.log(`Vlix Bridge listening on ${url}`);
    console.log(`Hosted Vlix app available at ${setupUrl}`);
    console.log(`Opening ${browserUrl === url ? "local Command IQ Console" : "hosted Vlix setup"} at ${browserUrl}`);
    startCloudSync();
    if (process.env.OPEN_ON_START === "1") {
      try {
        openUrl(browserUrl);
      } catch (error) {
        console.warn(`Unable to open browser automatically: ${error.message}`);
      }
    }
  });
};

server.on("error", async (error) => {
  if (error.code !== "EADDRINUSE") {
    console.error(error);
    process.exit(1);
  }

  const url = localOrigin();
  if (await probeExistingBridge(PORT)) {
    const setupUrl = hostedDesktopSetupUrl();
    const browserUrl = startupBrowserUrl();
    console.log(`Vlix Bridge is already running on ${url}`);
    console.log(`Hosted Vlix app available at ${setupUrl}`);
    console.log(`Opening ${browserUrl === url ? "local Command IQ Console" : "hosted Vlix setup"} at ${browserUrl}`);
    try {
      openUrl(browserUrl);
    } catch (error) {
      console.warn(`Unable to open browser automatically: ${error.message}`);
    }
    process.exit(0);
  }

  if (PORT < START_PORT + 20) {
    const occupiedPort = PORT;
    PORT += 1;
    console.warn(`Port ${occupiedPort} is already in use; trying ${PORT} instead.`);
    startServer();
    return;
  }

  console.error(`No free port found from ${START_PORT} to ${PORT}.`);
  process.exit(1);
});

startServer();
