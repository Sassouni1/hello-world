const initialParams = new URLSearchParams(window.location.search);
const incomingPairToken = initialParams.get("pair");
const incomingPhoneMode = initialParams.get("phone") === "1";
const incomingAccountSetup = initialParams.get("account_setup") === "1";
const incomingAccountId = initialParams.get("account") || "";
const incomingSetupToken = initialParams.get("setupToken") || "";
const incomingDisconnected = initialParams.get("disconnected") === "1";

const replaceUrlWithoutPairToken = (params = new URLSearchParams(window.location.search)) => {
  params.delete("pair");
  const cleanUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", cleanUrl);
};

if (incomingPairToken) {
  localStorage.setItem("codexPairToken", incomingPairToken);
  localStorage.setItem("codexPhonePaired", "1");
  replaceUrlWithoutPairToken(initialParams);
}
if (incomingDisconnected) {
  localStorage.removeItem("codexPairToken");
  localStorage.removeItem("codexPhonePaired");
}
if (incomingPhoneMode && localStorage.getItem("codexPairToken")) {
  localStorage.setItem("codexPhonePaired", "1");
}

const state = {
  chats: [],
  browserSessions: [],
  automations: [],
  workspaces: [],
  models: [],
  selectedModel: "",
  selectedEffort: "medium",
  fullAccess: false,
  view: "chat",
  selectedChatId: null,
  isComposingNewChat: false,
  selectedWorkspace: "",
  currentTaskId: null,
  taskTimer: null,
  activeTaskTimer: null,
  activeTasks: [],
  chatPollTimer: null,
  chatEventSource: null,
  chatPollInFlight: false,
  streamingTaskId: null,
  selectedChatReadOnly: false,
  stoppingChatIds: new Set(),
  stoppingTaskIds: new Set(),
  sidebarWorkingChatIds: new Set(),
  sidebarWorkingInitialized: false,
  doneChatIds: new Set(),
  expandedProjects: new Set(),
  openWorkBlocks: new Set(),
  openWorkRows: new Set(),
  pendingAttachments: [],
  appVersion: "",
  pendingAppVersion: "",
  appVersionTimer: null,
  pairingToken: localStorage.getItem("codexPairToken") || "",
  phonePaired: Boolean(localStorage.getItem("codexPairToken")) && localStorage.getItem("codexPhonePaired") === "1",
  phonePairingExpiresAt: "",
  disconnected: false,
  integrationRequired: false,
  activeAccount: null,
};

const els = {
  refreshBtn: document.getElementById("refreshBtn"),
  desktopDisconnectBtn: document.getElementById("desktopDisconnectBtn"),
  setupBridgeBtn: document.getElementById("setupBridgeBtn"),
  pairPhoneBtn: document.getElementById("pairPhoneBtn"),
  mobileMenuBtn: document.getElementById("mobileMenuBtn"),
  mobileMenuClose: document.getElementById("mobileMenuClose"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  chatSearch: document.getElementById("chatSearch"),
  searchClearBtn: document.getElementById("searchClearBtn"),
  chatList: document.getElementById("chatList"),
  chatCount: document.getElementById("chatCount"),
  browserCount: document.getElementById("browserCount"),
  automationNav: document.getElementById("automationsNav"),
  automationNavCount: document.getElementById("automationNavCount"),
  selectedPath: document.getElementById("selectedPath"),
  bridgeStatus: document.getElementById("bridgeStatus"),
  threadTitle: document.getElementById("threadTitle"),
  taskStatus: document.getElementById("taskStatus"),
  phonePairBanner: document.getElementById("phonePairBanner"),
  phonePairTitle: document.getElementById("phonePairTitle"),
  phoneOpenChatsBtn: document.getElementById("phoneOpenChatsBtn"),
  phoneNewChatBtn: document.getElementById("phoneNewChatBtn"),
  phoneDisconnectBtn: document.getElementById("phoneDisconnectBtn"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  repoPicker: document.getElementById("repoPicker"),
  repoSelect: document.getElementById("repoSelect"),
  promptInput: document.getElementById("promptInput"),
  attachmentPreview: document.getElementById("attachmentPreview"),
  imageInput: document.getElementById("imageInput"),
  imageUploadBtn: document.getElementById("imageUploadBtn"),
  fullAuto: document.getElementById("fullAuto"),
  modelSelect: document.getElementById("modelSelect"),
  effortSelect: document.getElementById("effortSelect"),
  stopBtn: document.getElementById("stopBtn"),
  sendBtn: document.getElementById("sendBtn"),
  browserUrl: document.getElementById("browserUrl"),
  previewBtn: document.getElementById("previewBtn"),
  openBrowserBtn: document.getElementById("openBrowserBtn"),
  shotBtn: document.getElementById("shotBtn"),
  mobilePreviewInlineBtn: document.getElementById("mobilePreviewInlineBtn"),
  browserFrame: document.getElementById("browserFrame"),
  browserShot: document.getElementById("browserShot"),
  browserSessions: document.getElementById("browserSessions"),
  automationList: document.getElementById("automationList"),
  newChatBtn: document.getElementById("newChatBtn"),
  mobilePreviewBtn: document.getElementById("mobilePreviewBtn"),
  mobilePreview: document.getElementById("mobilePreview"),
  mobilePreviewClose: document.getElementById("mobilePreviewClose"),
  mobilePreviewFrame: document.getElementById("mobilePreviewFrame"),
  mobilePreviewTitle: document.getElementById("mobilePreviewTitle"),
  phoneStage: document.getElementById("phoneStage"),
  pairingModal: document.getElementById("pairingModal"),
  pairingClose: document.getElementById("pairingClose"),
  pairingQr: document.getElementById("pairingQr"),
  pairingLink: document.getElementById("pairingLink"),
  pairingExpiry: document.getElementById("pairingExpiry"),
  setupModal: document.getElementById("setupModal"),
  setupClose: document.getElementById("setupClose"),
  setupPairBtn: document.getElementById("setupPairBtn"),
  setupLocalUrl: document.getElementById("setupLocalUrl"),
  setupPhoneUrl: document.getElementById("setupPhoneUrl"),
  setupCodexBin: document.getElementById("setupCodexBin"),
  setupCodexHome: document.getElementById("setupCodexHome"),
  setupAccountTitle: document.getElementById("setupAccountTitle"),
  setupAccountMeta: document.getElementById("setupAccountMeta"),
  setupAccountName: document.getElementById("setupAccountName"),
  setupNewAccountBtn: document.getElementById("setupNewAccountBtn"),
  setupCreateAccountBtn: document.getElementById("setupCreateAccountBtn"),
  setupAccountQr: document.getElementById("setupAccountQr"),
  setupAccountQrLink: document.getElementById("setupAccountQrLink"),
  setupAccountQrStatus: document.getElementById("setupAccountQrStatus"),
  setupCodexPrompt: document.getElementById("setupCodexPrompt"),
  setupGithubCommand: document.getElementById("setupGithubCommand"),
  setupNpmCommand: document.getElementById("setupNpmCommand"),
  setupRepoLink: document.getElementById("setupRepoLink"),
};

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const syncViewportHeight = () => {
  const useVisualViewport =
    incomingPhoneMode || initialParams.has("mobileViewport") || window.matchMedia("(max-width: 760px)").matches;
  const visualHeight = window.visualViewport?.height || window.innerHeight;
  const height = useVisualViewport ? Math.min(window.innerHeight, visualHeight) : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
};

syncViewportHeight();

const formatDate = (value) => {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const formatRelative = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < minute) return "now";
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m`;
  if (diff < day) return `${Math.round(diff / hour)}h`;
  if (diff < week) return `${Math.round(diff / day)}d`;
  return `${Math.round(diff / week)}w`;
};

const formatDuration = (start, end = new Date().toISOString()) => {
  const startTime = Date.parse(start || "");
  const endTime = Date.parse(end || "");
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return "a moment";
  const seconds = Math.max(1, Math.round((endTime - startTime) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
};

const formatMs = (value) => {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  return `${Math.round(seconds)}s`;
};

const setStatus = (label, kind = "") => {
  els.taskStatus.textContent = label;
  els.taskStatus.className = `status-pill ${kind}`.trim();
};

const setBridgeStatus = (bridge) => {
  if (!bridge) {
    els.bridgeStatus.textContent = "Bridge idle";
    els.bridgeStatus.className = "status-pill bridge";
    return;
  }
  const label = bridge.connected
    ? bridge.mode === "desktop-proxy"
      ? "Agent synced"
      : "Bridge synced"
    : bridge.error
    ? "Bridge offline"
    : "Bridge idle";
  els.bridgeStatus.textContent = label;
  els.bridgeStatus.title = [bridge.userAgent, bridge.binary, bridge.error].filter(Boolean).join("\n");
  els.bridgeStatus.className = `status-pill bridge ${bridge.connected ? "complete" : bridge.error ? "failed" : ""}`.trim();
};

const effortLabels = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

const selectedModel = () => state.models.find((model) => model.slug === els.modelSelect.value) || state.models[0] || null;

const fullAccessEnabled = () => els.fullAuto.getAttribute("aria-pressed") === "true";

const setFullAccess = (enabled) => {
  state.fullAccess = Boolean(enabled);
  els.fullAuto.setAttribute("aria-pressed", state.fullAccess ? "true" : "false");
  els.fullAuto.classList.toggle("is-active", state.fullAccess);
};

const renderEffortOptions = () => {
  const model = selectedModel();
  const levels = model?.supportedReasoningLevels?.length ? model.supportedReasoningLevels : ["medium"];
  const current = levels.includes(state.selectedEffort) ? state.selectedEffort : model?.defaultReasoningLevel || levels[0] || "medium";
  els.effortSelect.innerHTML = levels
    .map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effortLabels[effort] || effort)}</option>`)
    .join("");
  els.effortSelect.value = current;
  state.selectedEffort = current;
};

const renderCodexSettings = (payload = {}) => {
  state.models = payload.models || [];
  state.selectedModel = payload.selected?.model || state.models[0]?.slug || "gpt-5.5";
  state.selectedEffort = payload.selected?.effort || "medium";
  setFullAccess(Boolean(payload.selected?.fullAccess));
  els.modelSelect.innerHTML = state.models
    .map((model) => `<option value="${escapeHtml(model.slug)}">${escapeHtml(model.shortName || model.displayName || model.slug)}</option>`)
    .join("");
  if (state.models.some((model) => model.slug === state.selectedModel)) els.modelSelect.value = state.selectedModel;
  renderEffortOptions();
};

const saveCodexSettings = async () => {
  if (!els.modelSelect.value) return;
  const payload = await api("/api/codex-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: els.modelSelect.value,
      effort: els.effortSelect.value,
      fullAccess: fullAccessEnabled(),
    }),
  });
  renderCodexSettings(payload);
  setStatus("Settings saved", "complete");
};

const promptMinHeight = () => (window.matchMedia("(max-width: 760px)").matches ? 42 : 34);

const promptMaxHeight = () => (window.matchMedia("(max-width: 760px)").matches ? 126 : 156);

const syncPromptSize = () => {
  const minHeight = promptMinHeight();
  const hasRepoPicker = !els.repoPicker.hidden;
  const hasAttachments = state.pendingAttachments.length > 0;
  const hasPrompt = Boolean(els.promptInput.value);
  if (!hasRepoPicker && !hasPrompt && !hasAttachments) {
    els.composer.classList.remove("is-expanded");
    els.promptInput.style.height = `${minHeight}px`;
    return;
  }
  els.promptInput.style.height = "auto";
  const nextHeight = Math.min(promptMaxHeight(), Math.max(minHeight, els.promptInput.scrollHeight));
  els.promptInput.style.height = `${nextHeight}px`;
  els.composer.classList.toggle(
    "is-expanded",
    hasRepoPicker || hasAttachments || els.promptInput.value.includes("\n") || nextHeight > minHeight + 8
  );
};

const setDesktopBridgeAction = (mode) => {
  const isConnect = mode === "connect";
  els.desktopDisconnectBtn.textContent = isConnect ? "Connect desktop agent" : "Disconnect bridge";
  els.desktopDisconnectBtn.classList.toggle("danger-btn", !isConnect);
  els.desktopDisconnectBtn.dataset.action = isConnect ? "connect" : "disconnect";
};

const connectDesktopBridge = async () => {
  els.desktopDisconnectBtn.disabled = true;
  setStatus("Checking desktop agent", "running");
  els.bridgeStatus.textContent = "Checking bridge";
  els.bridgeStatus.className = "status-pill bridge running";
  try {
    const payload = await api("/api/bridge/connect", { method: "POST" });
    state.activeAccount = payload.account || state.activeAccount;
    state.integrationRequired = false;
    setDesktopBridgeAction("disconnect");
    setBridgeStatus(payload.codexBridge);
    setStatus(`Synced ${payload.account?.sessionCount || 0} chats`, "complete");
    await refresh();
  } catch (error) {
    setStatus(error.message, "failed");
    els.bridgeStatus.textContent = "Bridge offline";
    els.bridgeStatus.className = "status-pill bridge failed";
  } finally {
    els.desktopDisconnectBtn.disabled = false;
  }
};

const setPhonePaired = (paired, expiresAt = "", account = null) => {
  state.phonePaired = paired;
  if (paired) state.disconnected = false;
  state.phonePairingExpiresAt = paired ? expiresAt || state.phonePairingExpiresAt : "";
  document.body.classList.toggle("is-phone-session", paired);
  els.phonePairBanner.hidden = !paired;
  if (paired) {
    const accountName = account?.displayName || "Desktop bridge";
    els.phonePairTitle.textContent = `${accountName} connected`;
    const token = state.pairingToken || localStorage.getItem("codexPairToken") || "";
    els.phoneDisconnectBtn.href = `/disconnect-phone${token ? `?pair=${encodeURIComponent(token)}` : ""}`;
  }
};

const renderDisconnected = (message = "Disconnected from this Mac. Scan a fresh QR to reconnect.") => {
  state.disconnected = true;
  stopChatPolling();
  stopActiveTaskPolling();
  state.chats = [];
  state.browserSessions = [];
  state.automations = [];
  state.workspaces = [];
  state.selectedChatId = null;
  state.currentTaskId = null;
  if (state.taskTimer) clearInterval(state.taskTimer);
  state.taskTimer = null;
  setPhonePaired(false);
  renderChats();
  renderBrowserSessions();
  renderAutomations();
  renderWorkspaces();
  showRepoPicker(false);
  els.threadTitle.textContent = "Disconnected";
  els.selectedPath.textContent = "No paired bridge";
  els.promptInput.value = "";
  syncPromptSize();
  els.promptInput.disabled = true;
  els.sendBtn.disabled = true;
  setStatus("Disconnected", "failed");
  els.messages.innerHTML = `
    <section class="automation-view empty">
      <p class="eyebrow">Phone bridge</p>
      <h3>Disconnected</h3>
      <p>${escapeHtml(message)}</p>
    </section>
  `;
};

const closeMobileDrawer = () => {
  document.body.classList.remove("is-drawer-open");
  els.drawerBackdrop.hidden = true;
};

const openMobileDrawer = () => {
  document.body.classList.add("is-drawer-open");
  els.drawerBackdrop.hidden = false;
};

const api = async (url, options) => {
  const headers = { ...(options?.headers || {}) };
  if (state.pairingToken) headers["X-Codex-Pairing"] = state.pairingToken;
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.blob();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload;
};

const filteredChats = () => {
  const q = els.chatSearch.value.trim().toLowerCase();
  if (!q) return state.chats;
  return state.chats.filter((chat) =>
    [chat.title, chat.cwd, chat.id, chat.folderLabel].some((value) => String(value || "").toLowerCase().includes(q))
  );
};

const isRunningTask = (task) => task?.status === "running";
const isQueuedTask = (task) => task?.status === "queued";
const isTrackedTask = (task) => isRunningTask(task) || isQueuedTask(task);

const latestTimestamp = (...values) => {
  let latest = "";
  let latestMs = 0;
  for (const value of values) {
    const ms = Date.parse(value || "");
    if (!Number.isFinite(ms) || ms <= latestMs) continue;
    latest = value;
    latestMs = ms;
  }
  return latest;
};

const chatActivityAt = (chat) => chat.activityAt || chat.updatedAt || chat.latestEventAt || chat.fileUpdatedAt || "";

const activeTaskForChat = (chatId) =>
  state.activeTasks.find((task) => isRunningTask(task) && task.sessionId && task.sessionId === chatId) || null;

const chatIsStopping = (chatId) => state.stoppingChatIds.has(chatId);

const chatIsWorking = (chat) => !chatIsStopping(chat.id) && Boolean(activeTaskForChat(chat.id) || chat.observedWorking);

const chatHasDoneBadge = (chat) => !chatIsWorking(chat) && state.doneChatIds.has(chat.id);

const syncSidebarDoneBadges = () => {
  const currentWorking = new Set(state.chats.filter(chatIsWorking).map((chat) => chat.id));
  if (state.sidebarWorkingInitialized) {
    for (const id of state.sidebarWorkingChatIds) {
      if (!currentWorking.has(id) && !state.stoppingChatIds.has(id)) state.doneChatIds.add(id);
    }
  }
  for (const id of currentWorking) state.doneChatIds.delete(id);
  state.sidebarWorkingChatIds = currentWorking;
  state.sidebarWorkingInitialized = true;
};

const selectedActiveTask = () => {
  if (state.selectedChatId && chatIsStopping(state.selectedChatId)) return null;
  if (state.selectedChatId) return activeTaskForChat(state.selectedChatId);
  if (state.currentTaskId && state.stoppingTaskIds.has(state.currentTaskId)) return null;
  return state.activeTasks.find((task) => isRunningTask(task) && task.id === state.currentTaskId) || null;
};

const mergeActiveTask = (task) => {
  if (!task?.id) return;
  state.activeTasks = state.activeTasks.filter((item) => item.id !== task.id);
  if (isTrackedTask(task)) state.activeTasks.unshift(task);
};

const removeActiveTask = (taskId) => {
  if (!taskId) return;
  state.activeTasks = state.activeTasks.filter((task) => task.id !== taskId);
};

const reconcileChatsWithActiveTasks = (tasks = []) => {
  const activeBySession = new Map();
  for (const task of tasks) {
    if (!isTrackedTask(task) || !task.sessionId) continue;
    const existing = activeBySession.get(task.sessionId);
    if (!existing || new Date(task.updatedAt || task.startedAt || 0) > new Date(existing.updatedAt || existing.startedAt || 0)) {
      activeBySession.set(task.sessionId, task);
    }
  }

  const activeSessionIds = new Set(activeBySession.keys());
  let changed = false;
  state.chats = state.chats.map((chat) => {
    const task = activeBySession.get(chat.id);
    if (task) {
      const activityAt = latestTimestamp(chat.activityAt, chat.updatedAt, chat.latestEventAt, task.updatedAt, task.startedAt);
      if (!chat.observedWorking || activityAt !== chat.activityAt) changed = true;
      return {
        ...chat,
        observedWorking: true,
        activityAt: activityAt || chat.activityAt,
        latestEventAt: latestTimestamp(chat.latestEventAt, task.updatedAt, task.startedAt) || chat.latestEventAt,
        fileUpdatedAt: latestTimestamp(chat.fileUpdatedAt, task.updatedAt, task.startedAt) || chat.fileUpdatedAt,
      };
    }
    if (chat.observedWorking) {
      changed = true;
      return { ...chat, observedWorking: false };
    }
    return chat;
  });

  return {
    changed,
    unknownActive: [...activeSessionIds].some((id) => !state.chats.some((chat) => chat.id === id)),
  };
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

const stripInjectedUserContext = (role, text) => {
  const clean = String(text || "").trim();
  if (clean.startsWith("<turn_aborted>")) return "";
  if (role !== "user") return stripImagePlaceholders(stripPlainTextMarkdownFences(clean));
  const requestMarker = "## My request for Codex:";
  const requestIndex = clean.lastIndexOf(requestMarker);
  const visible = requestIndex >= 0 ? clean.slice(requestIndex + requestMarker.length).trim() : clean;
  return stripImagePlaceholders(stripPlainTextMarkdownFences(visible));
};

const lastRenderedMessageRole = () => els.messages.querySelector(".message:last-of-type")?.dataset.role || "";

const isNearMessageBottom = () => els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 140;

const sourceLabel = (source) => {
  if (source === "bridge") return "Codex via bridge";
  if (source === "desktop") return "Desktop Codex";
  return "";
};

const renderMessageHtml = (message, previousRole = "", options = {}) => {
  const role = message.role === "user" ? "user" : "assistant";
  const text = stripInjectedUserContext(role, message.text);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const source = sourceLabel(message.source);
  if (!text && !attachments.length) return "";
  const changedRole = previousRole && previousRole !== role;
  const streamAttr = options.streamTaskId ? ` data-streaming-task="${escapeHtml(options.streamTaskId)}"` : "";
  return `
    <article class="message ${role}${changedRole ? " is-role-switch" : ""}${options.streaming ? " is-streaming" : ""}" data-role="${role}"${streamAttr}>
      <div class="message-content">
        <div class="role">
          <span>${role === "user" ? "You" : "Assistant"}</span>
          ${source ? `<small>${escapeHtml(source)}</small>` : ""}
          ${message.status ? `<small>${escapeHtml(message.status)}</small>` : ""}
          <span>${escapeHtml(formatDate(message.timestamp))}</span>
        </div>
        ${text ? `<pre>${escapeHtml(text)}</pre>` : ""}
        ${renderAttachmentsHtml(attachments)}
      </div>
    </article>
  `;
};

const renderAttachmentsHtml = (attachments = []) => {
  const images = attachments.filter((item) => item?.kind === "image" && item.src);
  if (!images.length) return "";
  const multiple = images.length > 1;
  const attachmentClass = `message-attachments ${multiple ? "is-grid" : "is-single"} count-${Math.min(images.length, 6)}`;
  return `
    <div class="${attachmentClass}">
      ${images
        .map(
          (image) => `
            <a class="message-attachment" href="${escapeHtml(image.src)}" target="_blank" rel="noreferrer">
              <img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.label || "Attached image")}" loading="lazy" />
            </a>
          `
        )
        .join("")}
    </div>
  `;
};

const readFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "image"}.`));
    reader.readAsDataURL(file);
  });

const renderPendingAttachments = () => {
  const attachments = state.pendingAttachments;
  els.attachmentPreview.hidden = !attachments.length;
  els.attachmentPreview.innerHTML = attachments
    .map(
      (item, index) => `
        <div class="pending-attachment">
          <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.label || `Image ${index + 1}`)}" />
          <button type="button" data-remove-attachment="${index}" aria-label="Remove ${escapeHtml(item.label || "image")}">×</button>
        </div>
      `
    )
    .join("");
};

const clearPendingAttachments = () => {
  state.pendingAttachments = [];
  els.imageInput.value = "";
  renderPendingAttachments();
  syncPromptSize();
};

const addPendingImages = async (files) => {
  const imageFiles = [...files].filter((file) => file.type.startsWith("image/"));
  if (!imageFiles.length) return;
  const remaining = Math.max(0, 6 - state.pendingAttachments.length);
  if (!remaining) {
    setStatus("Image limit reached", "failed");
    return;
  }
  const accepted = imageFiles.slice(0, remaining);
  const safeFiles = accepted.filter((file) => file.size <= 8_000_000);
  if (safeFiles.length !== accepted.length) setStatus("Images must be under 8 MB", "failed");
  const next = await Promise.all(
    safeFiles.map(async (file, index) => ({
      kind: "image",
      src: await readFileAsDataUrl(file),
      label: file.name || `Image ${state.pendingAttachments.length + index + 1}`,
      type: file.type || "image/*",
      size: file.size || 0,
    }))
  );
  state.pendingAttachments = [...state.pendingAttachments, ...next];
  renderPendingAttachments();
  syncPromptSize();
};

const renderTimelineEventHtml = (item) => {
  if ((item.kind || "event") === "work-block") return renderWorkBlockHtml(item);
  const kind = item.kind || "event";
  const text = String(item.text || "").trim();
  const canExpand = Boolean(text);
  return `
    <article class="timeline-event ${escapeHtml(kind)}" data-role="event">
      <div class="event-rule"></div>
      <${canExpand ? "details" : "div"} class="event-card">
        <${canExpand ? "summary" : "div"} class="event-label">
          <span aria-hidden="true"></span>
          <strong>${escapeHtml(item.label || "Assistant activity")}</strong>
          <em>${escapeHtml(formatDate(item.timestamp))}</em>
        </${canExpand ? "summary" : "div"}>
        ${text ? `<pre>${escapeHtml(text)}</pre>` : ""}
      </${canExpand ? "details" : "div"}>
    </article>
  `;
};

const plural = (count, label) => `${count} ${label}${count === 1 ? "" : "s"}`;
const pluralWord = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const workEventType = (event) => {
  const kind = event.kind || "";
  if (kind === "read") return "read";
  if (kind === "search") return "search";
  if (kind === "explore") return "explore";
  if (kind === "edit") return "edit";
  if (kind === "command") return "command";
  if (kind === "browser") return "browser";
  if (kind === "plan") return "plan";
  if (kind === "agent") return "agent";
  if (kind === "agent-result") return "agentResult";
  if (kind === "reasoning") return "thinking";
  if (kind === "command-output" || kind === "tool-output") return "output";
  if (kind === "error") return "error";
  return "tool";
};

const summarizeWorkBlock = (events = []) => {
  const counts = events.reduce(
    (acc, event) => {
      const type = workEventType(event);
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    },
    {
      read: 0,
      search: 0,
      explore: 0,
      edit: 0,
      command: 0,
      browser: 0,
      plan: 0,
      agent: 0,
      agentResult: 0,
      thinking: 0,
      output: 0,
      tool: 0,
      error: 0,
    }
  );

  const parts = [];
  const explored = counts.read + counts.explore;
  if (explored) parts.push(`Explored ${pluralWord(explored, "file")}`);
  if (counts.search) parts.push(pluralWord(counts.search, "search", "searches"));
  if (counts.edit) parts.push(`${counts.edit === 1 ? "made" : "made"} ${pluralWord(counts.edit, "edit")}`);
  if (counts.command) parts.push(`${counts.command === 1 ? "ran" : "ran"} ${pluralWord(counts.command, "command")}`);
  if (counts.browser) parts.push(`${counts.browser === 1 ? "used" : "used"} ${pluralWord(counts.browser, "browser action")}`);
  if (counts.plan) parts.push(`${counts.plan === 1 ? "updated" : "updated"} ${pluralWord(counts.plan, "plan")}`);
  if (counts.agent) parts.push(`spawned ${pluralWord(counts.agent, "agent")}`);
  if (!counts.agent && counts.agentResult) parts.push(pluralWord(counts.agentResult, "agent report"));
  if (counts.tool) parts.push(`${counts.tool === 1 ? "used" : "used"} ${pluralWord(counts.tool, "tool")}`);
  if (!parts.length && counts.thinking) parts.push("Thinking");
  if (!parts.length && counts.output) parts.push(pluralWord(counts.output, "result"));
  if (counts.error) parts.push(pluralWord(counts.error, "error"));
  return parts.join(", ") || "Assistant activity";
};

const compactWorkRows = (events = []) => {
  const rows = [];
  const byCallId = new Map();
  const byAgentId = new Map();
  for (const event of events.filter((item) => item.kind !== "task" || item.status !== "started")) {
    if (event.kind === "command-output" || event.kind === "tool-output") {
      const parent = event.callId ? byCallId.get(event.callId) : null;
      if (parent) {
        parent.outputs.push(event);
      } else {
        rows.push({ ...event, outputs: [] });
      }
      continue;
    }
    if (event.kind === "agent-result") {
      const parent = event.agentId ? byAgentId.get(event.agentId) : null;
      if (parent) {
        parent.outputs.push(event);
        parent.status = event.status || parent.status;
      } else {
        rows.push({ ...event, outputs: [] });
      }
      continue;
    }
    const row = { ...event, outputs: [] };
    rows.push(row);
    if (row.callId) byCallId.set(row.callId, row);
    if (row.kind === "agent" && row.agentId) byAgentId.set(row.agentId, row);
  }
  return rows;
};

const workRowDetailsText = (event) =>
  [
    String(event.details || event.text || "").trim(),
    ...(event.outputs || [])
      .map((output) => {
        const body = String(output.details || output.text || "").trim();
        const label = String(output.label || "").trim();
        if (!body) return "";
        return label ? `${label}\n${body}` : body;
      })
      .filter(Boolean),
  ]
    .filter(Boolean)
    .join("\n\n");

const workBlockDomId = (item) =>
  [state.selectedChatId || "chat", item.events?.find((event) => event.turnId)?.turnId || item.startedAt || item.timestamp || ""].join("|");

const workRowDomId = (blockId, event) =>
  [blockId, event.callId || "", event.kind || "event", event.timestamp || "", event.label || ""].join("|");

const renderWorkEventRow = (event, blockId) => {
  const text = String(event.text || "").trim();
  const detailsText = workRowDetailsText(event);
  const canExpand = Boolean(detailsText);
  const rowId = workRowDomId(blockId, event);
  const openAttr = canExpand && state.openWorkRows.has(rowId) ? " open" : "";
  const meta = [
    event.agentRole || "",
    event.agentId ? `thread ${String(event.agentId).slice(0, 8)}` : "",
    event.kind === "agent" || event.kind === "agent-result" ? "" : event.toolName,
    event.status,
    typeof event.exitCode === "number" ? `exit ${event.exitCode}` : "",
    formatMs(event.durationMs),
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <li class="work-event-row ${escapeHtml(event.kind || "event")}">
      <${canExpand ? "details" : "div"} class="work-event-detail"${canExpand ? ` data-work-row="${escapeHtml(rowId)}"${openAttr}` : ""}>
        <${canExpand ? "summary" : "div"} class="work-event-summary">
          <div>
            <strong>${escapeHtml(event.label || "Activity")}</strong>
            ${text ? `<small>${escapeHtml(text)}</small>` : ""}
            ${meta ? `<span class="work-event-meta">${escapeHtml(meta)}</span>` : ""}
          </div>
          <em>${escapeHtml(formatDate(event.timestamp))}</em>
        </${canExpand ? "summary" : "div"}>
        ${canExpand ? `<pre>${escapeHtml(detailsText)}</pre>` : ""}
      </${canExpand ? "details" : "div"}>
    </li>
  `;
};

const renderWorkBlockHtml = (item) => {
  const events = item.events || [];
  const startedAt = item.startedAt || events[0]?.timestamp || item.timestamp;
  const endedAt = item.endedAt || events.at(-1)?.timestamp || startedAt;
  const duration = formatDuration(startedAt, item.working ? new Date().toISOString() : endedAt);
  const title = item.working ? `Working for ${duration}` : `Worked for ${duration}`;
  const summary = summarizeWorkBlock(events);
  const visibleEvents = compactWorkRows(events).slice(-36);
  const source = sourceLabel(events.find((event) => event.source)?.source || item.source);
  const blockId = workBlockDomId(item, summary);
  const openAttr = state.openWorkBlocks.has(blockId) ? " open" : "";
  return `
    <article class="timeline-event work-block ${item.working ? "is-working" : "is-done"}" data-role="event">
      <details class="event-card work-card" data-work-block="${escapeHtml(blockId)}"${openAttr}>
        <summary class="event-label">
          <span aria-hidden="true"></span>
          <strong>${escapeHtml(title)}</strong>
          <b>${escapeHtml(summary)}</b>
          ${source ? `<small>${escapeHtml(source)}</small>` : ""}
        </summary>
        <ol class="work-event-list">
          ${visibleEvents.length ? visibleEvents.map((event) => renderWorkEventRow(event, blockId)).join("") : '<li class="work-event-row"><div><strong>Starting</strong></div></li>'}
        </ol>
      </details>
    </article>
  `;
};

const bindWorkDisclosureState = () => {
  for (const detail of els.messages.querySelectorAll(".work-card[data-work-block]")) {
    detail.addEventListener("toggle", () => {
      const id = detail.dataset.workBlock;
      if (!id) return;
      if (detail.open) state.openWorkBlocks.add(id);
      else state.openWorkBlocks.delete(id);
    });
  }
  for (const detail of els.messages.querySelectorAll(".work-event-detail[data-work-row]")) {
    detail.addEventListener("toggle", () => {
      const id = detail.dataset.workRow;
      if (!id) return;
      if (detail.open) state.openWorkRows.add(id);
      else state.openWorkRows.delete(id);
    });
  }
};

const compactActivityText = (activity) => {
  const lines = [];
  if (activity.files.size) {
    lines.push("Files:");
    lines.push(...[...activity.files].slice(0, 12));
  }
  if (activity.commands.length) {
    if (lines.length) lines.push("");
    lines.push("Commands:");
    lines.push(...activity.commands.slice(0, 10));
  }
  if (activity.notes.length) {
    if (lines.length) lines.push("");
    lines.push(...activity.notes.slice(0, 6));
  }
  return lines.join("\n");
};

const collapseTimeline = (items) => {
  const feed = [];
  let block = null;
  const selectedTask = activeTaskForChat(state.selectedChatId);

  const startBlock = (item) => ({
    kind: "work-block",
    timestamp: item.timestamp,
    startedAt: item.timestamp,
    endedAt: item.timestamp,
    events: [],
    working: false,
  });

  const visibleBlockEvents = (events = []) => events.filter((event) => (event.kind || "") !== "task");

  const flushBlock = (isFinal = false) => {
    if (!block) return;
    const visibleEvents = visibleBlockEvents(block.events);
    const hasFinished = block.events.some((event) => event.kind === "task" && ["complete", "aborted"].includes(event.status));
    const hasStarted = block.events.some((event) => event.kind === "task" && event.status === "started");
    if (!visibleEvents.length) {
      if (selectedTask && !hasFinished && (hasStarted || isFinal)) {
        block.events.push({
          kind: "reasoning",
          timestamp: block.startedAt || selectedTask.startedAt || new Date().toISOString(),
          label: "Thinking",
          text: "",
        });
      } else {
        block = null;
        return;
      }
    }
    if (!visibleBlockEvents(block.events).length) {
      block = null;
      return;
    }
    const last = block.events.at(-1);
    block.endedAt = last?.timestamp || block.endedAt || block.startedAt;
    block.working = Boolean(selectedTask && !hasFinished && (hasStarted || isFinal));
    feed.push(block);
    block = null;
  };

  for (const item of items || []) {
    const kind = item.kind || "message";
    if (kind === "message") {
      if (item.role === "user") {
        feed.push(item);
        flushBlock();
        continue;
      }
      flushBlock();
      feed.push(item);
      continue;
    }

    if (kind === "compact") {
      flushBlock();
      feed.push(item);
      continue;
    }

    if (kind === "task" && item.status === "started" && visibleBlockEvents(block?.events).length) flushBlock();
    if (kind === "task" && !block) {
      if (item.status !== "started") continue;
      block = startBlock(item);
    }
    block ||= startBlock(item);
    block.events.push(item);
    block.endedAt = item.timestamp || block.endedAt;
    if (kind === "task" && ["complete", "aborted"].includes(item.status)) {
      flushBlock();
    }
  }
  flushBlock(true);

  const maxItems = 280;
  if (feed.length <= maxItems) return feed;
  const tail = feed.slice(-maxItems);
  const feedItemKey = (item) => [item.kind || "message", item.id || "", item.timestamp || "", item.role || "", item.label || ""].join("|");
  const tailKeys = new Set(tail.map(feedItemKey));
  const latestUserContext = [...feed]
    .reverse()
    .find((item) => item.kind === "message" && (item.role === "user" || item.attachments?.length));
  const pinned = latestUserContext && !tailKeys.has(feedItemKey(latestUserContext)) ? [latestUserContext] : [];
  return [
    {
      kind: "history",
      label: `${feed.length - maxItems - pinned.length} earlier items hidden`,
      timestamp: tail[0]?.timestamp || "",
      text: "The local session is very large. Showing the latest part of the thread so the view stays usable.",
    },
    ...pinned,
    ...tail,
  ];
};

const renderChats = () => {
  const chats = filteredChats();
  const isSearching = Boolean(els.chatSearch.value.trim());
  els.chatCount.textContent = isSearching ? `${chats.length}/${state.chats.length}` : state.chats.length;
  els.searchClearBtn.hidden = !isSearching;

  if (!chats.length) {
    els.chatList.innerHTML = '<div class="empty-state">No matching sessions.</div>';
    return;
  }

  const chatRowHtml = (chat) => {
    const task = activeTaskForChat(chat.id);
    const working = chatIsWorking(chat);
    const done = chatHasDoneBadge(chat);
    const stopLabel = `Stop ${chat.title || "running chat"}`;
    return `
    <div class="chat-card ${chat.id === state.selectedChatId ? "is-active" : ""} ${working ? "is-working" : ""} ${done ? "is-done" : ""}" data-id="${escapeHtml(chat.id)}" role="button" tabindex="0"${working ? ' title="Working"' : done ? ' title="Done"' : ""}>
      <strong>${escapeHtml(chat.title)}</strong>
      <div class="chat-meta">
        <time>${escapeHtml(formatDate(chatActivityAt(chat)))}</time>
        ${
          working
            ? `<span class="chat-working" aria-label="Working"><span class="observer-spinner" aria-hidden="true"></span></span><button class="chat-stop" data-stop-id="${escapeHtml(chat.id)}" type="button" aria-label="${escapeHtml(stopLabel)}">Stop</button>`
            : done
            ? `<span class="chat-done-dot" aria-label="Done"></span>`
            : `<span>${escapeHtml(formatRelative(chatActivityAt(chat)))}</span>`
        }
      </div>
    </div>
  `;
  };

  const groups = [];
  for (const chat of chats) {
    const key = chat.projectKey || chat.projectLabel || chat.folderLabel || "Sessions";
    const label = chat.projectLabel || chat.folderLabel || "Sessions";
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = { key, label, chats: [] };
      groups.push(group);
    }
    group.chats.push(chat);
  }

  const collapsedLimit = 9;
  const recentRows = isSearching
    ? ""
    : `
      <section class="project-group recent-group">
        <div class="folder-row"><span class="folder-icon">▱</span><span>Recent chats</span></div>
        ${[...state.chats]
          .sort((a, b) => new Date(chatActivityAt(b) || 0) - new Date(chatActivityAt(a) || 0))
          .slice(0, 10)
          .map(chatRowHtml)
          .join("")}
      </section>
    `;
  els.chatList.innerHTML =
    recentRows +
    groups
    .map((group) => {
      const expanded = state.expandedProjects.has(group.key) || isSearching;
      const selectedInGroup = group.chats.findIndex((chat) => chat.id === state.selectedChatId);
      const limit = selectedInGroup >= collapsedLimit && !expanded ? selectedInGroup + 1 : collapsedLimit;
      const visibleChats = expanded ? group.chats : group.chats.slice(0, limit);
      const hiddenCount = Math.max(0, group.chats.length - visibleChats.length);
      const rows = visibleChats.map(chatRowHtml).join("");
      const showMore =
        group.chats.length > collapsedLimit && !isSearching
          ? `<button class="show-more-row" data-project="${escapeHtml(group.key)}" type="button">${expanded ? "Show less" : `Show more ${hiddenCount ? `(${hiddenCount})` : ""}`}</button>`
          : "";
      return `
        <section class="project-group">
          <div class="folder-row"><span class="folder-icon">▱</span><span>${escapeHtml(group.label)}</span></div>
          ${rows}
          ${showMore}
        </section>
      `;
    })
    .join("");

  for (const card of els.chatList.querySelectorAll(".chat-card")) {
    card.addEventListener("click", (event) => {
      if (event.target.closest(".chat-stop")) return;
      selectChat(card.dataset.id);
    });
    card.addEventListener("keydown", (event) => {
      if (event.target.closest(".chat-stop")) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectChat(card.dataset.id);
    });
  }
  for (const button of els.chatList.querySelectorAll(".chat-stop")) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      stopChatTurn(button.dataset.stopId);
    });
  }
  for (const button of els.chatList.querySelectorAll(".show-more-row")) {
    button.addEventListener("click", () => {
      const key = button.dataset.project;
      if (state.expandedProjects.has(key)) state.expandedProjects.delete(key);
      else state.expandedProjects.add(key);
      renderChats();
    });
  }
};

const renderMessages = (items, options = {}) => {
  const shouldStick = options.stickToBottom ?? isNearMessageBottom();
  const visibleItems = collapseTimeline(items)
    .map((item) => {
      if ((item.kind || "message") !== "message") return item;
      return {
        ...item,
        role: item.role === "user" ? "user" : "assistant",
        text: stripInjectedUserContext(item.role, item.text),
      };
    })
    .filter((item) => (item.kind || "message") !== "message" || item.text);

  if (!visibleItems.length) {
    els.messages.innerHTML = '<div class="empty-state">This session has no visible user or assistant messages yet.</div>';
    syncObservedChatActivity();
    return;
  }

  let previousRole = "";
  els.messages.innerHTML = visibleItems
    .map((item) => {
      if ((item.kind || "message") !== "message") return renderTimelineEventHtml(item);
      const html = renderMessageHtml(item, previousRole);
      previousRole = item.role;
      return html;
    })
    .join("");
  bindWorkDisclosureState();
  syncObservedChatActivity();
  if (shouldStick) els.messages.scrollTop = els.messages.scrollHeight;
};

const upsertStreamingMessage = (task) => {
  const text = String(task?.finalMessage || "").trim();
  if (!text) return;
  const shouldStick = isNearMessageBottom();
  const selector = `[data-streaming-task="${CSS.escape(task.id)}"]`;
  const existing = els.messages.querySelector(selector);
  if (existing) {
    existing.querySelector("pre").textContent = text;
  } else {
    els.messages.insertAdjacentHTML(
      "beforeend",
      renderMessageHtml(
        { role: "assistant", timestamp: new Date().toISOString(), text },
        lastRenderedMessageRole(),
        { streaming: true, streamTaskId: task.id }
      )
    );
  }
  if (shouldStick) els.messages.scrollTop = els.messages.scrollHeight;
};

const syncObservedChatActivity = () => {
  if (state.selectedChatId && chatIsStopping(state.selectedChatId)) {
    setStatus("Stopping", "running");
    return;
  }
  const task = selectedActiveTask();
  const shouldStick = isNearMessageBottom();
  if (!task || state.view !== "chat") {
    const selectedChat = state.selectedChatId ? state.chats.find((chat) => chat.id === state.selectedChatId) : null;
    const selectedWorking = selectedChat ? chatIsWorking(selectedChat) : false;
    if (state.selectedChatReadOnly && selectedWorking) {
      setStatus("Working", "running");
    } else {
      if (state.selectedChatReadOnly && state.view === "chat") setComposerReadOnly(false);
      if (!state.currentTaskId) setStatus("Idle");
    }
    return;
  }
  if (task.finalMessage) upsertStreamingMessage(task);
  if (!state.selectedChatId || task.sessionId === state.selectedChatId || task.id === state.currentTaskId) {
    setComposerReadOnly(true);
  }
  setStatus("Working", "running");
  if (shouldStick) els.messages.scrollTop = els.messages.scrollHeight;
};

const setComposerReadOnly = (readOnly) => {
  state.selectedChatReadOnly = Boolean(readOnly);
  if (readOnly) {
    els.composer.classList.add("is-queueing");
    els.promptInput.disabled = false;
    els.sendBtn.disabled = false;
    els.imageUploadBtn.disabled = false;
    els.imageInput.disabled = false;
    els.promptInput.placeholder = "Queue a follow-up...";
    els.sendBtn.textContent = "Queue";
    els.stopBtn.hidden = false;
    els.stopBtn.disabled = false;
    return;
  }
  els.composer.classList.remove("is-queueing");
  els.promptInput.disabled = false;
  els.sendBtn.disabled = false;
  els.imageUploadBtn.disabled = false;
  els.imageInput.disabled = false;
  els.promptInput.placeholder = "Message...";
  els.sendBtn.textContent = "Send";
  els.stopBtn.hidden = true;
  els.stopBtn.disabled = false;
};

const hasComposerDraft = () => Boolean((els.promptInput?.value || "").trim() || state.pendingAttachments.length);

const handleAppVersion = (version) => {
  if (!version) return;
  if (!state.appVersion) {
    state.appVersion = version;
    return;
  }
  if (version === state.appVersion) return;
  state.pendingAppVersion = version;
  if (hasComposerDraft()) {
    setStatus("UI update ready", "running");
    return;
  }
  setStatus("Updating UI", "running");
  window.setTimeout(() => window.location.reload(), 150);
};

const loadAppVersion = async () => {
  try {
    const payload = await api("/api/app-version");
    handleAppVersion(payload.version);
  } catch (error) {
    console.warn(error.message);
  }
};

const startAppVersionPolling = () => {
  if (state.appVersionTimer) return;
  state.appVersionTimer = setInterval(loadAppVersion, 2000);
  loadAppVersion();
};

const loadActiveTasks = async () => {
  if (state.integrationRequired || state.disconnected) return;
  try {
    const payload = await api("/api/tasks");
    handleAppVersion(payload.appVersion);
    state.activeTasks = payload.tasks || [];
    const reconciliation = reconcileChatsWithActiveTasks(state.activeTasks);
    if (reconciliation.unknownActive) {
      const chatPayload = await api("/api/chats");
      state.chats = chatPayload.chats || state.chats;
      reconcileChatsWithActiveTasks(state.activeTasks);
    }
    syncSidebarDoneBadges();
    renderChats();
    syncObservedChatActivity();
  } catch (error) {
    console.warn(error.message);
  }
};

const startActiveTaskPolling = () => {
  if (state.activeTaskTimer) return;
  state.activeTaskTimer = setInterval(loadActiveTasks, 700);
  loadActiveTasks();
};

const stopActiveTaskPolling = () => {
  if (state.activeTaskTimer) clearInterval(state.activeTaskTimer);
  state.activeTaskTimer = null;
  state.activeTasks = [];
};

const stopChatPolling = () => {
  if (state.chatPollTimer) clearInterval(state.chatPollTimer);
  state.chatPollTimer = null;
  if (state.chatEventSource) state.chatEventSource.close();
  state.chatEventSource = null;
};

const renderChatPayload = (payload, options = {}) => {
  if (!payload?.chat || state.selectedChatId !== payload.chat.id) return false;
  const shouldStick = options.stickToBottom ?? isNearMessageBottom();
  state.chats = state.chats.map((chat) => (chat.id === payload.chat.id ? { ...chat, ...payload.chat } : chat));
  els.threadTitle.textContent = payload.chat.title;
  const chatCwd = payload.meta.cwd || payload.chat.cwd || "";
  els.selectedPath.textContent = chatCwd.includes("/.codex/remote_bridge/accounts/")
    ? "Private workspace"
    : chatCwd || payload.chat.id;
  renderMessages(payload.timeline || payload.messages || [], { stickToBottom: shouldStick });
  setComposerReadOnly(Boolean(!chatIsStopping(payload.chat.id) && (payload.chat.observedWorking || activeTaskForChat(payload.chat.id))));
  showRepoPicker(false);
  syncObservedChatActivity();
  renderChats();
  return true;
};

const loadSelectedChat = async (id, options = {}) => {
  if (!id) return false;
  if (state.chatPollInFlight && options.silent) return false;
  const shouldStick = options.stickToBottom ?? isNearMessageBottom();
  state.chatPollInFlight = true;
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(id)}`);
    if (!renderChatPayload(payload, { stickToBottom: shouldStick })) return false;
    if (!options.silent && !state.currentTaskId && !state.selectedChatReadOnly) setStatus("Idle");
    return true;
  } catch (error) {
    if (!options.silent) {
      els.messages.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      setStatus("Failed", "failed");
    } else {
      console.warn(error.message);
    }
    return false;
  } finally {
    state.chatPollInFlight = false;
  }
};

const startChatPolling = () => {
  stopChatPolling();
  if (state.selectedChatId && typeof EventSource !== "undefined") {
    const source = new EventSource(`/api/chats/${encodeURIComponent(state.selectedChatId)}/events`);
    state.chatEventSource = source;
    source.addEventListener("snapshot", (event) => {
      if (source !== state.chatEventSource) return;
      try {
        renderChatPayload(JSON.parse(event.data), { stickToBottom: isNearMessageBottom() });
      } catch (error) {
        console.warn(error.message);
      }
    });
    source.addEventListener("changed", () => {
      if (source !== state.chatEventSource || !state.selectedChatId) return;
      loadSelectedChat(state.selectedChatId, { silent: true, stickToBottom: isNearMessageBottom() });
    });
    source.addEventListener("error", () => {
      if (source !== state.chatEventSource) return;
      source.close();
      state.chatEventSource = null;
    });
  }
  state.chatPollTimer = setInterval(() => {
    if (!state.selectedChatId || state.view !== "chat" || state.integrationRequired || state.disconnected) return;
    loadSelectedChat(state.selectedChatId, { silent: true, stickToBottom: isNearMessageBottom() });
  }, state.chatEventSource ? 3000 : 850);
};

const renderWorkspaces = () => {
  const current = state.selectedWorkspace || els.repoSelect.value;
  els.repoSelect.innerHTML = state.workspaces
    .map(
      (workspace) => `
        <option value="${escapeHtml(workspace.cwd)}">${escapeHtml(workspace.private ? workspace.label : `${workspace.label} - ${workspace.cwd}`)}</option>
      `
    )
    .join("");
  const fallback = state.workspaces[0]?.cwd || "";
  state.selectedWorkspace = state.workspaces.some((workspace) => workspace.cwd === current) ? current : fallback;
  els.repoSelect.value = state.selectedWorkspace;
};

const selectedWorkspaceLabel = () => {
  const workspace = state.workspaces.find((item) => item.cwd === state.selectedWorkspace) || state.workspaces[0];
  return workspace?.label || "Private workspace";
};

const showRepoPicker = (show) => {
  els.repoPicker.hidden = !show;
  syncPromptSize();
};

const renderAutomationsView = () => {
  state.view = "automations";
  state.selectedChatId = null;
  stopChatPolling();
  els.automationNav.classList.add("is-active");
  renderChats();
  els.threadTitle.textContent = "Automations";
  els.selectedPath.textContent = "Automations";
  els.promptInput.disabled = true;
  els.sendBtn.disabled = true;
  showRepoPicker(false);
  setStatus("Idle");
  closeMobileDrawer();

  if (!state.automations.length) {
    els.messages.innerHTML = `
      <section class="automation-view empty">
        <p class="eyebrow">Agents</p>
        <h3>No automations yet</h3>
        <p>Automations created by connected assistants will appear here.</p>
      </section>
    `;
    return;
  }

  els.messages.innerHTML = `
    <section class="automation-view">
      ${state.automations
        .map(
          (automation) => `
            <article class="automation-card">
              <header>
                <div>
                  <strong>${escapeHtml(automation.name)}</strong>
                  <span>${escapeHtml([automation.kind, automation.status].filter(Boolean).join(" · "))}</span>
                </div>
                <em>${escapeHtml(formatRelative(automation.updatedAt))}</em>
              </header>
              ${automation.prompt ? `<p>${escapeHtml(automation.prompt)}</p>` : ""}
              ${automation.rrule ? `<code>${escapeHtml(automation.rrule)}</code>` : ""}
              ${(automation.cwds || []).length ? `<small>${automation.cwds.map(escapeHtml).join("<br>")}</small>` : ""}
            </article>
          `
        )
        .join("")}
    </section>
  `;
};

const renderIntegrationRequired = (payload = {}) => {
  state.integrationRequired = true;
  stopChatPolling();
  stopActiveTaskPolling();
  state.activeAccount = payload.account || state.activeAccount;
  state.chats = [];
  state.browserSessions = [];
  state.automations = [];
  state.workspaces = [];
  state.selectedChatId = null;
  els.automationNav.classList.remove("is-active");
  renderChats();
  renderBrowserSessions();
  renderAutomations();
  renderWorkspaces();
  setBridgeStatus(payload.codexBridge);
  els.bridgeStatus.textContent = "Not connected";
  els.bridgeStatus.className = "status-pill bridge failed";
  setDesktopBridgeAction("connect");
  setStatus("Not integrated", "failed");
  showRepoPicker(false);
  els.threadTitle.textContent = state.activeAccount?.displayName || "Fresh account";
  els.selectedPath.textContent = state.activeAccount?.accountId || "Not integrated";
  els.promptInput.disabled = true;
  els.sendBtn.disabled = true;
  els.messages.innerHTML = `
    <section class="automation-view empty">
      <p class="eyebrow">Bridge account</p>
      <h3>Not integrated yet</h3>
      <p>This account is fresh. It cannot read local chats until a desktop bridge is connected to it.</p>
      <p><code>${escapeHtml(state.activeAccount?.accountId || "no account")}</code></p>
      <button class="primary-btn" id="connectBridgeBtn" type="button">Connect desktop agent</button>
    </section>
  `;
};

const selectChat = async (id) => {
  state.view = "chat";
  state.doneChatIds.delete(id);
  state.selectedChatId = id;
  state.isComposingNewChat = false;
  stopChatPolling();
  els.automationNav.classList.remove("is-active");
  closeMobileDrawer();
  renderChats();
  const pendingChat = state.chats.find((chat) => chat.id === id);
  const pendingWorking = pendingChat ? chatIsWorking(pendingChat) : false;
  els.threadTitle.textContent = pendingChat?.title || "Loading";
  els.selectedPath.textContent = pendingChat?.cwd || id;
  setComposerReadOnly(pendingWorking);
  if (!pendingWorking) {
    els.promptInput.disabled = true;
    els.sendBtn.disabled = true;
  }
  setStatus(pendingWorking ? "Working" : "Loading", pendingWorking ? "running" : "");

  const loaded = await loadSelectedChat(id, { stickToBottom: true });
  if (loaded) startChatPolling();
};

const startNewChat = () => {
  state.view = "chat";
  state.selectedChatId = null;
  state.isComposingNewChat = true;
  stopChatPolling();
  els.automationNav.classList.remove("is-active");
  closeMobileDrawer();
  renderChats();
  els.threadTitle.textContent = "New chat";
  renderWorkspaces();
  const isPrivateWorkspace = Boolean(state.workspaces.find((workspace) => workspace.cwd === state.selectedWorkspace)?.private);
  const hasSyncedWorkspace = state.workspaces.some((workspace) => !workspace.private);
  showRepoPicker(hasSyncedWorkspace && state.workspaces.length > 1);
  els.selectedPath.textContent = selectedWorkspaceLabel();
  els.messages.innerHTML = '<div class="empty-state">Send a prompt to start a private session through this paired Mac.</div>';
  setComposerReadOnly(false);
  syncPromptSize();
  els.promptInput.focus();
  setStatus("Idle");
};

const refresh = async () => {
  if (incomingPhoneMode && !state.pairingToken && !state.phonePaired) {
    renderDisconnected();
    return;
  }
  setStatus("Refreshing");
  const [chatPayload, browserPayload, automationPayload, workspacePayload, settingsPayload] = await Promise.all([
    api("/api/chats"),
    api("/api/browser-sessions"),
    api("/api/automations"),
    api("/api/workspaces"),
    api("/api/codex-settings"),
  ]);
  state.chats = chatPayload.chats || [];
  state.browserSessions = browserPayload.sessions || [];
  state.automations = automationPayload.automations || [];
  state.workspaces = workspacePayload.workspaces || [];
  renderCodexSettings(settingsPayload);
  if (chatPayload.integrationRequired || browserPayload.integrationRequired || automationPayload.integrationRequired || workspacePayload.integrationRequired) {
    renderIntegrationRequired(chatPayload);
    return;
  }
  state.integrationRequired = false;
  startActiveTaskPolling();
  state.activeAccount = chatPayload.account || state.activeAccount;
  setDesktopBridgeAction("disconnect");
  setBridgeStatus(chatPayload.codexBridge);
  renderWorkspaces();
  renderChats();
  renderBrowserSessions();
  renderAutomations();
  if (state.view === "automations") {
    renderAutomationsView();
    return;
  }
  if (state.phonePaired && !state.selectedChatId && !state.chats.length) {
    startNewChat();
    return;
  }
  if (state.isComposingNewChat && !state.selectedChatId && state.view === "chat") {
    return;
  }
  if (!state.selectedChatId && state.chats[0]) {
    const firstUsefulChat = state.chats.find(chatIsWorking) || state.chats[0];
    await selectChat(firstUsefulChat.id);
  } else if (state.selectedChatId) {
    await selectChat(state.selectedChatId);
  } else {
    els.threadTitle.textContent = state.activeAccount?.displayName || "No chats yet";
    els.selectedPath.textContent = state.activeAccount?.accountId || "No bridge account selected";
    els.messages.innerHTML = '<div class="empty-state">This bridge account has no chats yet. Choose New chat to start its first private session.</div>';
    els.promptInput.disabled = true;
    els.sendBtn.disabled = true;
    showRepoPicker(false);
    setStatus("Idle");
  }
};

const validatePhonePairing = async () => {
  if (!state.pairingToken || !localStorage.getItem("codexPhonePaired")) return true;
  try {
    const payload = await api("/api/pairing/validate");
    setPhonePaired(Boolean(payload.ok), payload.expiresAt || "", payload.account || null);
    return Boolean(payload.ok);
  } catch {
    localStorage.removeItem("codexPairToken");
    localStorage.removeItem("codexPhonePaired");
    state.pairingToken = "";
    renderDisconnected("Pairing expired or was revoked. Open the bridge on the computer, click Pair phone, then scan a fresh QR.");
    return false;
  }
};

const disconnectPhone = async (event) => {
  event?.preventDefault();
  const token = state.pairingToken || localStorage.getItem("codexPairToken") || "";
  const endpoint = token ? `/api/pairing/disconnect?pair=${encodeURIComponent(token)}` : "/api/pairing/disconnect";
  els.phoneDisconnectBtn.disabled = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      cache: "no-store",
      headers: token ? { "X-Codex-Pairing": token } : {},
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : {};
    if (!response.ok) throw new Error(payload.error || `Disconnect failed with ${response.status}`);
    console.info("Phone pairing disconnected", payload);
  } catch (error) {
    // Clear local access even if the token was already gone on the bridge.
    console.warn(error.message || "Phone pairing disconnect failed; local access cleared.");
  } finally {
    localStorage.removeItem("codexPairToken");
    localStorage.removeItem("codexPhonePaired");
    state.pairingToken = "";
    replaceUrlWithoutPairToken();
    els.phoneDisconnectBtn.disabled = false;
    renderDisconnected();
  }
};

const pollTask = async () => {
  if (!state.currentTaskId) return;
  let task = null;
  try {
    ({ task } = await api(`/api/tasks/${encodeURIComponent(state.currentTaskId)}`));
  } catch (error) {
    if (state.taskTimer) clearInterval(state.taskTimer);
    state.taskTimer = null;
    removeActiveTask(state.currentTaskId);
    state.currentTaskId = null;
    state.streamingTaskId = null;
    if (!state.selectedChatReadOnly) setComposerReadOnly(false);
    setStatus(state.selectedChatReadOnly ? "Desktop assistant is working" : "Idle", state.selectedChatReadOnly ? "running" : "");
    return;
  }
  mergeActiveTask(task);
  if (!state.selectedChatId && task.sessionId) {
    state.selectedChatId = task.sessionId;
    startChatPolling();
  }
  if (task.finalMessage) upsertStreamingMessage(task);
  renderChats();
  syncObservedChatActivity();
  setStatus(task.status === "queued" ? "Queued" : task.status === "running" ? "Running" : task.status, task.status);

  if (task.status === "queued" || task.status === "running") return;

  clearInterval(state.taskTimer);
  state.taskTimer = null;
  removeActiveTask(task.id);
  state.currentTaskId = null;
  state.streamingTaskId = null;
  els.promptInput.disabled = false;
  els.sendBtn.disabled = false;
  if (task.status === "failed") {
    els.messages.insertAdjacentHTML(
      "beforeend",
      renderMessageHtml(
        { role: "assistant", timestamp: new Date().toISOString(), text: task.error || "The assistant exited with an error." },
        lastRenderedMessageRole()
      )
    );
  }
  renderChats();
  syncObservedChatActivity();
  await refresh();
};

const sendPrompt = async (event) => {
  event.preventDefault();
  const queueing = Boolean(state.selectedChatId && state.selectedChatReadOnly);
  const sendingNewChat = !state.selectedChatId;
  const message = els.promptInput.value.trim();
  const attachments = state.pendingAttachments.map((item) => ({ ...item }));
  if (!message && !attachments.length) return;

  els.promptInput.value = "";
  clearPendingAttachments();
  els.promptInput.disabled = true;
  els.sendBtn.disabled = true;

  setStatus(queueing ? "Queueing" : "Running", "running");
  try {
    const endpoint = state.selectedChatId
      ? `/api/chats/${encodeURIComponent(state.selectedChatId)}/send`
      : "/api/chats/send-new";
    const payload = await api(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        attachments,
        fullAuto: fullAccessEnabled(),
        model: els.modelSelect.value,
        effort: els.effortSelect.value,
        cwd: state.selectedChatId ? undefined : els.repoSelect.value,
      }),
    });
    state.isComposingNewChat = false;
    els.messages.insertAdjacentHTML(
      "beforeend",
      renderMessageHtml(
        { role: "user", timestamp: new Date().toISOString(), text: message, attachments, status: payload.queued ? "Queued" : "" },
        lastRenderedMessageRole()
      )
    );
    els.messages.scrollTop = els.messages.scrollHeight;
    state.currentTaskId = payload.taskId;
    state.streamingTaskId = payload.taskId;
    mergeActiveTask(payload.task);
    renderChats();
    syncObservedChatActivity();
    state.taskTimer = setInterval(pollTask, 2000);
    await pollTask();
  } catch (error) {
    state.isComposingNewChat = sendingNewChat;
    els.promptInput.disabled = false;
    els.sendBtn.disabled = false;
    state.pendingAttachments = attachments;
    renderPendingAttachments();
    syncPromptSize();
    setStatus("Failed", "failed");
    els.messages.insertAdjacentHTML(
      "beforeend",
      renderMessageHtml({ role: "assistant", timestamp: new Date().toISOString(), text: error.message }, lastRenderedMessageRole())
    );
  }
};

const stopChatTurn = async (chatId) => {
  const task = chatId
    ? activeTaskForChat(chatId)
    : state.activeTasks.find((item) => item.id === state.currentTaskId && isRunningTask(item)) || null;
  const effectiveChatId = chatId || task?.sessionId || "";
  if (!effectiveChatId && !task?.id) return;
  const isSelected = !state.selectedChatId || effectiveChatId === state.selectedChatId || task?.id === state.currentTaskId;
  if (effectiveChatId) state.stoppingChatIds.add(effectiveChatId);
  if (task?.id) state.stoppingTaskIds.add(task.id);
  if (task?.id === state.currentTaskId && state.taskTimer) {
    clearInterval(state.taskTimer);
    state.taskTimer = null;
  }
  const rowStopButtons = effectiveChatId
    ? [...els.chatList.querySelectorAll(`.chat-stop[data-stop-id="${CSS.escape(effectiveChatId)}"]`)]
    : [];
  rowStopButtons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Stopping";
  });
  els.stopBtn.disabled = true;
  if (isSelected) setComposerReadOnly(false);
  setStatus("Stopping", "running");
  renderChats();
  try {
    const endpoint = task?.id && !task.observed
      ? `/api/tasks/${encodeURIComponent(task.id)}/stop`
      : `/api/chats/${encodeURIComponent(effectiveChatId)}/stop`;
    await api(endpoint, { method: "POST" });
    setStatus("Stopped", "complete");
    if (effectiveChatId) state.stoppingChatIds.delete(effectiveChatId);
    if (task?.id) {
      state.stoppingTaskIds.delete(task.id);
      removeActiveTask(task.id);
      if (state.currentTaskId === task.id) state.currentTaskId = null;
      if (state.streamingTaskId === task.id) state.streamingTaskId = null;
    }
    await loadActiveTasks();
    if (isSelected && effectiveChatId) await loadSelectedChat(effectiveChatId, { silent: true, stickToBottom: true });
  } catch (error) {
    if (effectiveChatId) state.stoppingChatIds.delete(effectiveChatId);
    if (task?.id) state.stoppingTaskIds.delete(task.id);
    if (isSelected) setComposerReadOnly(Boolean(effectiveChatId && activeTaskForChat(effectiveChatId)));
    setStatus("Stop failed", "failed");
    els.messages.insertAdjacentHTML(
      "beforeend",
      renderMessageHtml({ role: "assistant", timestamp: new Date().toISOString(), text: error.message }, lastRenderedMessageRole())
    );
  } finally {
    els.stopBtn.disabled = false;
    rowStopButtons.forEach((button) => {
      button.disabled = false;
      button.textContent = "Stop";
    });
    syncObservedChatActivity();
    renderChats();
  }
};

const stopCurrentTurn = async () => stopChatTurn(state.selectedChatId);

const renderBrowserSessions = () => {
  els.browserCount.textContent = state.browserSessions.length;
  if (!state.browserSessions.length) {
    els.browserSessions.innerHTML = '<div class="empty-state">No browser session files found.</div>';
    return;
  }

  els.browserSessions.innerHTML = state.browserSessions
    .map(
      (session) => `
        <article class="browser-session">
          <strong>${escapeHtml(session.id)}</strong>
          <div class="origin-list">
            ${(session.allowedOrigins || []).map((origin) => `<span title="${escapeHtml(origin)}">${escapeHtml(origin)}</span>`).join("") || "<span>No origins recorded</span>"}
          </div>
        </article>
      `
    )
    .join("");
};

const renderAutomations = () => {
  els.automationNavCount.textContent = state.automations.length;
  if (!state.automations.length) {
    els.automationList.innerHTML = '<div class="empty-state">No automations configured.</div>';
    return;
  }

  els.automationList.innerHTML = state.automations
    .map(
      (automation) => `
        <article class="automation-row">
          <div>
            <strong>${escapeHtml(automation.name)}</strong>
            <span>${escapeHtml([automation.kind, automation.status].filter(Boolean).join(" · "))}</span>
          </div>
          ${automation.rrule ? `<code>${escapeHtml(automation.rrule)}</code>` : ""}
        </article>
      `
    )
    .join("");
};

const normalizeUrl = () => {
  let url = els.browserUrl.value.trim();
  if (!url) url = "https://example.com";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  els.browserUrl.value = url;
  return url;
};

const showFramePreview = () => {
  const url = normalizeUrl();
  els.browserShot.hidden = true;
  els.browserFrame.hidden = false;
  els.browserFrame.src = url;
  return url;
};

const captureScreenshot = async (options = {}) => {
  const url = normalizeUrl();
  els.shotBtn.disabled = true;
  try {
    const response = await fetch(`/api/browser-screenshot?url=${encodeURIComponent(url)}`);
    if (!response.ok) {
      const payload = await response.json();
      throw new Error(payload.error || "Screenshot failed.");
    }
    const blob = await response.blob();
    els.browserShot.src = URL.createObjectURL(blob);
    els.browserShot.hidden = false;
    els.browserFrame.hidden = true;
  } catch (error) {
    if (!options.silent) alert(error.message);
    else console.warn(error.message);
  } finally {
    els.shotBtn.disabled = false;
  }
};

const loadFrame = () => {
  showFramePreview();
  captureScreenshot({ silent: true });
};

const openVisibleBrowser = async () => {
  try {
    await api("/api/browser-open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: normalizeUrl() }),
    });
  } catch (error) {
    alert(error.message);
  }
};

const setMobilePreviewSize = (size) => {
  const [width, height] = size.split("x").map(Number);
  els.mobilePreviewFrame.style.width = `${width}px`;
  els.mobilePreviewFrame.style.height = `${height}px`;
  els.mobilePreviewTitle.textContent = `${width} × ${height}`;
  for (const button of els.mobilePreview.querySelectorAll("[data-mobile-size]")) {
    button.classList.toggle("is-active", button.dataset.mobileSize === size);
  }
  requestAnimationFrame(() => {
    const stage = els.phoneStage.getBoundingClientRect();
    const scale = Math.min(stage.width / width, stage.height / height, 1);
    els.mobilePreviewFrame.style.transform = `scale(${scale})`;
  });
};

const openMobilePreview = () => {
  els.mobilePreview.hidden = false;
  const url = new URL(window.location.href);
  url.searchParams.set("mobileViewport", "1");
  url.searchParams.set("previewReload", Date.now().toString());
  els.mobilePreviewFrame.src = url.toString();
  setMobilePreviewSize("390x844");
};

const closeMobilePreview = () => {
  els.mobilePreview.hidden = true;
};

const openPairing = async () => {
  els.pairingModal.hidden = false;
  els.pairingQr.removeAttribute("src");
  els.pairingLink.href = "#";
  els.pairingExpiry.textContent = "Creating secure pairing...";
  try {
    const pairing = await api("/api/pairing/start", { method: "POST" });
    els.pairingQr.src = pairing.qr;
    els.pairingLink.href = pairing.url;
    els.pairingLink.title = pairing.url;
    els.pairingLink.textContent = "Open hosted pairing link";
    els.pairingExpiry.textContent = `Expires ${formatDate(pairing.expiresAt)}`;
  } catch (error) {
    els.pairingQr.removeAttribute("src");
    els.pairingLink.href = "#";
    els.pairingLink.textContent = "Pairing unavailable";
    els.pairingExpiry.textContent = error.message;
  }
};

const closePairing = () => {
  els.pairingModal.hidden = true;
};

const renderBridgeInfo = (info) => {
  if (!info) return;
  const account = info.account;
  els.setupAccountTitle.textContent = account?.displayName || "Not created yet";
  els.setupAccountMeta.textContent = account
    ? `${account.accountId} · ${account.integrationStatus || "CONNECTED"} · ${account.desktopDevice?.name || "no desktop"}`
    : "Create this first, then phones use the hosted website to reach this desktop.";
  els.setupAccountName.value = account?.displayName || "";
  els.setupCreateAccountBtn.textContent = account ? "Update" : "Create";
  els.setupLocalUrl.textContent = info.localUrl || "http://localhost:3001";
  els.setupPhoneUrl.textContent = info.phoneUrl || "Unavailable";
  els.setupCodexBin.textContent = info.codexBinary ? "Detected" : "Not detected";
  els.setupCodexHome.textContent = info.codexHome ? "Local bridge data" : "Not detected";
  els.setupCodexPrompt.textContent = info.install?.codexPrompt || "";
  els.setupGithubCommand.textContent = info.install?.github || "";
  els.setupNpmCommand.textContent = info.install?.npm || "";
  els.setupRepoLink.href = info.repoUrl || "#";
};

const renderAccountQr = (payload) => {
  if (!payload?.qr) {
    els.setupAccountQr.removeAttribute("src");
    els.setupAccountQrLink.href = "#";
    els.setupAccountQrStatus.textContent = "No account QR";
    return;
  }
  els.setupAccountQr.src = payload.qr;
  els.setupAccountQrLink.href = payload.url;
  els.setupAccountQrLink.title = payload.url;
  els.setupAccountQrStatus.textContent = "Hosted Vlix URL";
};

const loadAccountQr = async () => {
  const payload = await api("/api/bridge/account/qr");
  renderAccountQr(payload);
  return payload;
};

const loadBridgeInfo = async () => {
  const info = await api("/api/bridge/info");
  renderBridgeInfo(info);
  if (info.account) {
    loadAccountQr().catch(() => renderAccountQr(null));
  } else {
    renderAccountQr(null);
  }
  return info;
};

const createBridgeAccount = async () => {
  els.setupCreateAccountBtn.disabled = true;
  try {
    const payload = await api("/api/bridge/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: els.setupAccountName.value.trim() }),
    });
    const info = await loadBridgeInfo();
    renderBridgeInfo({ ...info, account: payload.account || info.account });
  } catch (error) {
    els.setupAccountMeta.textContent = error.message;
  } finally {
    els.setupCreateAccountBtn.disabled = false;
  }
};

const createNewBridgeAccount = async () => {
  els.setupNewAccountBtn.disabled = true;
  els.setupCreateAccountBtn.disabled = true;
  try {
    const payload = await api("/api/bridge/account/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: els.setupAccountName.value.trim() }),
    });
    const info = await loadBridgeInfo();
    renderBridgeInfo({ ...info, account: payload.account || info.account });
    await loadAccountQr();
    await refresh();
  } catch (error) {
    els.setupAccountMeta.textContent = error.message;
  } finally {
    els.setupNewAccountBtn.disabled = false;
    els.setupCreateAccountBtn.disabled = false;
  }
};

const disconnectDesktopBridge = async () => {
  els.desktopDisconnectBtn.disabled = true;
  try {
    localStorage.removeItem("codexPairToken");
    localStorage.removeItem("codexPhonePaired");
    state.pairingToken = "";
    state.phonePaired = false;
    const payload = await api("/api/bridge/disconnect", { method: "POST" });
    renderIntegrationRequired({ account: payload.account, message: "This bridge account is not integrated with a desktop yet." });
  } catch (error) {
    setStatus(error.message, "failed");
  } finally {
    els.desktopDisconnectBtn.disabled = false;
  }
};

const handleDesktopBridgeAction = () => {
  if (els.desktopDisconnectBtn.dataset.action === "connect" || state.integrationRequired) {
    connectDesktopBridge();
    return;
  }
  disconnectDesktopBridge();
};

const openSetup = async () => {
  els.setupModal.hidden = false;
  localStorage.setItem("bridgeOnboardingSeen", "1");
  try {
    await loadBridgeInfo();
  } catch (error) {
    els.setupCodexPrompt.textContent = error.message;
    els.setupGithubCommand.textContent = "";
    els.setupNpmCommand.textContent = "";
  }
};

const closeSetup = () => {
  els.setupModal.hidden = true;
};

const showAccountSetupPreview = async () => {
  try {
    const params = new URLSearchParams({ account: incomingAccountId, setupToken: incomingSetupToken });
    const payload = await fetch(`/api/bridge/account/public?${params}`);
    const body = await payload.json();
    if (!payload.ok) throw new Error(body.error || "Account QR is invalid.");
    renderIntegrationRequired({
      account: body.account,
      message: "This is a bridge account QR. Connect the desktop bridge before pairing phones to chats.",
    });
  } catch (error) {
    els.messages.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    setStatus("Invalid QR", "failed");
  }
};

const copyFromTarget = async (targetId, button) => {
  const target = document.getElementById(targetId);
  const text = target?.textContent?.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 900);
};

els.refreshBtn.addEventListener("click", refresh);
els.desktopDisconnectBtn.addEventListener("click", handleDesktopBridgeAction);
els.setupBridgeBtn.addEventListener("click", openSetup);
els.pairPhoneBtn.addEventListener("click", openPairing);
els.pairingClose.addEventListener("click", closePairing);
els.pairingModal.addEventListener("click", (event) => {
  if (event.target === els.pairingModal) closePairing();
});
els.phoneOpenChatsBtn.addEventListener("click", openMobileDrawer);
els.phoneNewChatBtn.addEventListener("click", startNewChat);
els.phoneDisconnectBtn.addEventListener("click", disconnectPhone);
els.messages.addEventListener("click", (event) => {
  if (event.target.closest("#connectBridgeBtn")) connectDesktopBridge();
});
els.setupClose.addEventListener("click", closeSetup);
els.setupNewAccountBtn.addEventListener("click", createNewBridgeAccount);
els.setupCreateAccountBtn.addEventListener("click", createBridgeAccount);
els.setupPairBtn.addEventListener("click", () => {
  closeSetup();
  openPairing();
});
els.setupModal.addEventListener("click", (event) => {
  if (event.target === els.setupModal) closeSetup();
});
for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", () => copyFromTarget(button.dataset.copyTarget, button));
}
els.mobileMenuBtn.addEventListener("click", openMobileDrawer);
els.mobileMenuClose.addEventListener("click", closeMobileDrawer);
els.drawerBackdrop.addEventListener("click", closeMobileDrawer);
els.newChatBtn.addEventListener("click", startNewChat);
els.automationNav.addEventListener("click", renderAutomationsView);
els.chatSearch.addEventListener("input", renderChats);
els.chatSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.chatSearch.value) {
    els.chatSearch.value = "";
    renderChats();
  }
});
els.searchClearBtn.addEventListener("click", () => {
  els.chatSearch.value = "";
  renderChats();
  els.chatSearch.focus();
});
els.fullAuto.addEventListener("click", async () => {
  setFullAccess(!fullAccessEnabled());
  try {
    await saveCodexSettings();
  } catch (error) {
    setStatus(error.message, "failed");
    setFullAccess(!fullAccessEnabled());
  }
});
els.modelSelect.addEventListener("change", async () => {
  state.selectedModel = els.modelSelect.value;
  renderEffortOptions();
  try {
    await saveCodexSettings();
  } catch (error) {
    setStatus(error.message, "failed");
  }
});
els.effortSelect.addEventListener("change", async () => {
  state.selectedEffort = els.effortSelect.value;
  try {
    await saveCodexSettings();
  } catch (error) {
    setStatus(error.message, "failed");
  }
});
els.repoSelect.addEventListener("change", () => {
  state.selectedWorkspace = els.repoSelect.value;
  if (!state.selectedChatId && state.view === "chat") {
    els.selectedPath.textContent = selectedWorkspaceLabel();
  }
});
els.imageUploadBtn.addEventListener("click", () => els.imageInput.click());
els.imageInput.addEventListener("change", async () => {
  try {
    await addPendingImages(els.imageInput.files || []);
  } catch (error) {
    setStatus(error.message, "failed");
  } finally {
    els.imageInput.value = "";
  }
});
els.attachmentPreview.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-attachment]");
  if (!button) return;
  state.pendingAttachments.splice(Number(button.dataset.removeAttachment), 1);
  renderPendingAttachments();
  syncPromptSize();
});
els.promptInput.addEventListener("paste", async (event) => {
  const imageFiles = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
  if (!imageFiles.length) return;
  event.preventDefault();
  try {
    await addPendingImages(imageFiles);
  } catch (error) {
    setStatus(error.message, "failed");
  }
});
els.promptInput.addEventListener("input", syncPromptSize);
els.composer.addEventListener("submit", sendPrompt);
els.stopBtn.addEventListener("click", stopCurrentTurn);
els.previewBtn.addEventListener("click", loadFrame);
els.shotBtn.addEventListener("click", () => captureScreenshot());
els.openBrowserBtn.addEventListener("click", openVisibleBrowser);
els.mobilePreviewBtn.addEventListener("click", openMobilePreview);
els.mobilePreviewInlineBtn.addEventListener("click", openMobilePreview);
els.mobilePreviewClose.addEventListener("click", closeMobilePreview);
els.mobilePreview.addEventListener("click", (event) => {
  if (event.target === els.mobilePreview) closeMobilePreview();
});
for (const button of els.mobilePreview.querySelectorAll("[data-mobile-size]")) {
  button.addEventListener("click", () => setMobilePreviewSize(button.dataset.mobileSize));
}
window.addEventListener("resize", () => {
  syncViewportHeight();
  syncPromptSize();
  if (!els.mobilePreview.hidden) {
    const active = els.mobilePreview.querySelector("[data-mobile-size].is-active")?.dataset.mobileSize || "390x844";
    setMobilePreviewSize(active);
  }
});
window.visualViewport?.addEventListener("resize", syncViewportHeight);

els.browserUrl.value = "https://example.com";
showFramePreview();
captureScreenshot({ silent: true });
setPhonePaired(state.phonePaired);
syncPromptSize();
startAppVersionPolling();
if (incomingAccountSetup && incomingAccountId && incomingSetupToken && !incomingPairToken) {
  showAccountSetupPreview();
} else if (incomingDisconnected) {
  renderDisconnected();
} else {
  validatePhonePairing()
    .then((shouldRefresh) => (shouldRefresh ? refresh() : null))
    .catch((error) => {
      if (state.disconnected) {
        renderDisconnected();
        return;
      }
      if (incomingPhoneMode) {
        renderDisconnected("Pairing expired or was revoked. Open the bridge on the computer, click Pair phone, then scan a fresh QR.");
        return;
      }
      els.messages.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      setStatus("Failed", "failed");
    });
}

if (!incomingPairToken && !incomingPhoneMode && !incomingAccountSetup && !initialParams.has("mobileViewport") && !localStorage.getItem("bridgeOnboardingSeen")) {
  setTimeout(openSetup, 400);
}
