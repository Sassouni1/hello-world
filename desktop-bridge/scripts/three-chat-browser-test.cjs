#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "../..");
const OUTPUT_DIR = path.join(ROOT, "output", "playwright");
const REPORT_PATH = path.join(ROOT, "output", "playwright-live-preview-three-chat-report.json");
const BASE_URL = process.env.VLIX_TEST_BASE || "http://127.0.0.1:3001";
const CHAT_TARGETS = [
  { label: "Study command IQ lab", match: /study command iq lab/i },
  { label: "Build Codex chat web app", match: /build codex chat web app/i },
  { label: "019df6c3-6b80-7af2-933d-2a2eff96c053", id: "019df6c3-6b80-7af2-933d-2a2eff96c053" },
];

const DUPLICATE_TITLE_BROWSER_GUARDS = [
  {
    title: "Build barber booking app",
    withBrowserId: "019dfa42-904d-7220-88be-58602ed0868b",
    withoutBrowserId: "019dfa45-c823-72d3-817b-896567eec09b",
  },
];

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const fetchWithTimeout = async (url, options = {}, timeoutMs = 3000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const ms = Date.now() - startedAt;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return { ok: response.ok, status: response.status, ms, body: await response.text() };
    }
    return { ok: response.ok, status: response.status, ms, body: await response.json() };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - startedAt, body: { error: error.message } };
  } finally {
    clearTimeout(timeout);
  }
};

const api = (pathname, options = {}, timeoutMs = 3000) => fetchWithTimeout(`${BASE_URL}${pathname}`, options, timeoutMs);

const postJson = (pathname, body, timeoutMs = 6000) =>
  api(
    pathname,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );

const chatsFromPayload = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.chats)) return payload.chats;
  if (Array.isArray(payload?.sessions)) return payload.sessions;
  return [];
};

const titleOf = (chat) => String(chat?.title || chat?.name || chat?.summary || chat?.id || "");

const idOf = (chat) =>
  String(chat?.id || chat?.sessionId || chat?.providerSessionId || chat?.provider_session_id || "");

const findChat = (chats, target) => {
  if (target.id) {
    const exact = chats.find((chat) => idOf(chat) === target.id || String(chat?.providerSessionId || "") === target.id);
    if (exact) return exact;
  }
  return chats.find((chat) => target.match?.test(titleOf(chat)) || target.match?.test(idOf(chat)));
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const startFixtureServer = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const chat = url.searchParams.get("chat") || "unknown";
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(`<!doctype html>
        <html>
          <head>
            <meta name="viewport" content="width=device-width,initial-scale=1" />
            <title>Vlix preview fixture - ${escapeHtml(chat)}</title>
            <style>
              body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #070909; color: #f4f4f0; font: 18px/1.45 system-ui, sans-serif; }
              main { width: min(760px, calc(100vw - 48px)); border: 1px solid #2d3333; border-radius: 24px; padding: 34px; background: #111414; box-shadow: 0 24px 80px rgba(0,0,0,.5); }
              h1 { margin: 0 0 12px; font-size: 34px; }
              code { color: #65d9ff; }
              button, input { border: 1px solid #384142; border-radius: 999px; padding: 14px 18px; background: #1d2222; color: #fff; font: inherit; }
              button { cursor: pointer; background: linear-gradient(135deg, #26d7ff, #8a6cff); color: #061011; font-weight: 700; }
              .row { display: flex; gap: 12px; margin-top: 24px; flex-wrap: wrap; }
            </style>
          </head>
          <body>
            <main>
              <h1>Playwright Live Preview</h1>
              <p>This is the isolated browser for <code>${escapeHtml(chat)}</code>.</p>
              <p id="count">Clicks: 0</p>
              <div class="row">
                <button id="countBtn" type="button">Click test</button>
                <input id="textBox" placeholder="Type test" />
              </div>
            </main>
            <script>
              let count = 0;
              document.getElementById("countBtn").addEventListener("click", () => {
                count += 1;
                document.getElementById("count").textContent = "Clicks: " + count;
              });
            </script>
          </body>
        </html>`);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });

const nodeIdForButton = (html) => {
  const direct = html.match(/<button[^>]*id="countBtn"[^>]*data-vlix-node-id="([^"]+)"/i);
  if (direct) return direct[1];
  const reverse = html.match(/<button[^>]*data-vlix-node-id="([^"]+)"[^>]*id="countBtn"/i);
  return reverse ? reverse[1] : "";
};

const uiSnapshot = async (page, label, expectedLabel = "") =>
  page.evaluate(({ snapshotLabel, expectedLabel }) => {
    const frame = document.querySelector("#browserFrame");
    const shot = document.querySelector("#browserShot");
    const selected = document.querySelector(".chat-card.is-active");
    const srcdoc = frame?.getAttribute("srcdoc") || "";
    return {
      label: snapshotLabel,
      selected: selected?.textContent?.replace(/\s+/g, " ").trim() || "",
      liveStatus: document.querySelector("#browserLiveStatus")?.textContent?.trim() || "",
      browserUrl: document.querySelector("#browserUrl")?.value || "",
      frameHidden: Boolean(frame?.hidden),
      frameSrc: frame?.getAttribute("src") || "",
      frameSrcdocLength: srcdoc.length,
      frameHasSelectedFixture: Boolean(expectedLabel && srcdoc.includes(expectedLabel)),
      shotHidden: Boolean(shot?.hidden),
      shotSrcPrefix: (shot?.getAttribute("src") || "").slice(0, 64),
    };
  }, { snapshotLabel: label, expectedLabel });

const clickChat = async (page, chat) => {
  const title = titleOf(chat);
  const id = idOf(chat);
  await page.waitForSelector(".chat-card", { timeout: 8000 }).catch(() => {});
  let row = page.locator(`.chat-card[data-id="${id}"]`).first();
  if ((await row.count()) === 0 && title) {
    await page.fill("#chatSearch", title).catch(() => {});
    await page.waitForTimeout(250);
    row = page.locator(".chat-card").filter({ hasText: title }).first();
  }
  if ((await row.count()) === 0 && id) {
    await page.fill("#chatSearch", id).catch(() => {});
    await page.waitForTimeout(250);
    row = page.locator(`.chat-card[data-id="${id}"]`).first();
  }
  if ((await row.count()) === 0) throw new Error(`Could not find chat row for ${title || id}`);
  await row.click({ timeout: 5000 });
};

const waitForTargetPreview = async (page, target) => {
  await page.waitForFunction(
    ({ expectedUrl, expectedLabel }) => {
      const status = document.querySelector("#browserLiveStatus")?.textContent || "";
      const url = document.querySelector("#browserUrl")?.value || "";
      const srcdoc = document.querySelector("#browserFrame")?.getAttribute("srcdoc") || "";
      const shot = document.querySelector("#browserShot");
      const shotVisible = Boolean(shot && !shot.hidden && shot.getAttribute("src"));
      return (
        status.includes("Playwright Live Preview") &&
        url === expectedUrl &&
        (shotVisible || srcdoc.includes(expectedLabel))
      );
    },
    { expectedUrl: target.url, expectedLabel: target.label },
    { timeout: 7000 },
  );
};

const waitForNoPreview = async (page) => {
  await page.waitForFunction(
    () => {
      const status = document.querySelector("#browserLiveStatus")?.textContent || "";
      const url = document.querySelector("#browserUrl")?.value || "";
      const frame = document.querySelector("#browserFrame");
      const shot = document.querySelector("#browserShot");
      return (
        /No Playwright target is tied to this chat yet|No Playwright Live Preview/i.test(status) &&
        !url &&
        (!frame || frame.hidden) &&
        (!shot || shot.hidden || !shot.getAttribute("src"))
      );
    },
    {},
    { timeout: 7000 },
  );
};

const dismissSetupOverlay = async (page) => {
  await page.evaluate(() => {
    const setup = document.querySelector("#setupModal");
    if (setup) {
      setup.setAttribute("hidden", "");
      setup.style.display = "none";
      setup.style.pointerEvents = "none";
    }
    document.body.classList.remove("is-setup-open");
  });
};

const main = async () => {
  ensureDir(OUTPUT_DIR);
  const fixture = await startFixtureServer();
  const report = {
    baseUrl: BASE_URL,
    fixtureUrl: fixture.url,
    generatedAt: new Date().toISOString(),
    endpoints: {},
    targets: [],
    ui: [],
    failures: [],
  };

  try {
    report.endpoints.bridgeInfo = await api("/api/bridge/info", {}, 3000);
    if (!report.endpoints.bridgeInfo.ok || report.endpoints.bridgeInfo.ms > 1000) {
      report.failures.push(`/api/bridge/info unhealthy: ${report.endpoints.bridgeInfo.status} in ${report.endpoints.bridgeInfo.ms}ms`);
    }

    const chatsResponse = await api("/api/chats", {}, 5000);
    const chats = chatsFromPayload(chatsResponse.body);
    if (!chats.length) report.failures.push("No chats returned from /api/chats.");

    const targets = CHAT_TARGETS.map((target) => {
      const chat = findChat(chats, target);
      if (!chat) {
        report.failures.push(`Missing chat target: ${target.label}`);
        return null;
      }
      return { ...target, chat, id: idOf(chat), title: titleOf(chat) };
    }).filter(Boolean);

    for (const target of targets) {
      await postJson("/api/vite-browser/stop", { chatId: target.id }, 3000).catch(() => {});
    }

    let noFallbackChat = null;
    for (const chat of chats) {
      const id = idOf(chat);
      if (!id || targets.some((target) => target.id === id)) continue;
      const status = await api(`/api/vite-browser/status?chatId=${encodeURIComponent(id)}`, {}, 3000);
      const body = status.body || {};
      if (!body.active && !body.detectedUrl && !(body.availableViteTargets || []).length) {
        noFallbackChat = { chat, id, title: titleOf(chat) };
        report.noFallbackChat = noFallbackChat;
        break;
      }
    }

    for (const target of targets) {
      const encodedLabel = encodeURIComponent(target.label);
      const url = `${fixture.url}/?chat=${encodedLabel}`;
      target.url = url;
      const start = await postJson("/api/vite-browser/start", { chatId: target.id, url }, 9000);
      const status = await api(`/api/vite-browser/status?chatId=${encodeURIComponent(target.id)}`, {}, 3000);
      const dom = await api(`/api/vite-browser/dom?chatId=${encodeURIComponent(target.id)}&t=${Date.now()}`, {}, 5000);
      const nodeId = nodeIdForButton(dom.body?.mirror?.html || "");
      const click = nodeId
        ? await postJson("/api/vite-browser/input", { chatId: target.id, type: "click", nodeId }, 4000)
        : { ok: false, status: 0, ms: 0, body: { error: "No count button node id found." } };
      const afterClick = await api(`/api/vite-browser/dom?chatId=${encodeURIComponent(target.id)}&t=${Date.now()}`, {}, 5000);

      report.targets.push({
        label: target.label,
        id: target.id,
        title: target.title,
        url,
        startMs: start.ms,
        start: start.body,
        statusMs: status.ms,
        status: status.body,
        domMs: dom.ms,
        domOk: Boolean(dom.body?.mirror?.html?.includes(target.label)),
        nodeId,
        clickOk: click.ok,
        afterClickOk: Boolean(afterClick.body?.mirror?.html?.includes("Clicks: 1")),
      });

      if (!start.ok || start.body?.kind !== "playwright-live-preview" || start.body?.mode !== "preview") {
        report.failures.push(`${target.label} did not start a Playwright Live Preview.`);
      }
      if (!status.ok || status.body?.kind !== "playwright-live-preview" || !status.body?.active) {
        report.failures.push(`${target.label} status is not active Playwright Live Preview.`);
      }
      if (status.ms > 3000) report.failures.push(`${target.label} /api/vite-browser/status exceeded 3s.`);
      if (!dom.body?.mirror?.html?.includes(target.label)) {
        report.failures.push(`${target.label} DOM mirror did not show the chat-specific fixture.`);
      }
      if (!nodeId || !click.ok || !afterClick.body?.mirror?.html?.includes("Clicks: 1")) {
        report.failures.push(`${target.label} Playwright preview did not accept click input.`);
      }
    }

    if (noFallbackChat) {
      const noFallbackStatus = await api(`/api/vite-browser/status?chatId=${encodeURIComponent(noFallbackChat.id)}`, {}, 3000);
      report.noFallbackStatus = noFallbackStatus.body;
      const leakedUrl = targets.find((target) => {
        const text = JSON.stringify(noFallbackStatus.body || {});
        return text.includes(target.url);
      });
      if (noFallbackStatus.body?.active || noFallbackStatus.body?.detectedUrl || (noFallbackStatus.body?.availableViteTargets || []).length) {
        report.failures.push(`${noFallbackChat.title} unexpectedly inherited a browser target.`);
      }
      if (leakedUrl) {
        report.failures.push(`${noFallbackChat.title} leaked ${leakedUrl.label}'s preview URL.`);
      }
    } else {
      report.failures.push("Could not find an unrelated no-target chat for fallback leakage testing.");
    }

    report.duplicateTitleGuards = [];
    for (const guard of DUPLICATE_TITLE_BROWSER_GUARDS) {
      const withBrowser = chats.find((chat) => idOf(chat) === guard.withBrowserId);
      const withoutBrowser = chats.find((chat) => idOf(chat) === guard.withoutBrowserId);
      if (!withBrowser || !withoutBrowser) continue;
      const withStatus = await api(`/api/vite-browser/status?chatId=${encodeURIComponent(guard.withBrowserId)}`, {}, 3000);
      const withoutStatus = await api(`/api/vite-browser/status?chatId=${encodeURIComponent(guard.withoutBrowserId)}`, {}, 3000);
      report.duplicateTitleGuards.push({
        title: guard.title,
        withBrowserId: guard.withBrowserId,
        withoutBrowserId: guard.withoutBrowserId,
        checked: Boolean(withStatus.body?.detectedUrl || (withStatus.body?.availableViteTargets || []).length),
        withBrowser: {
          mode: withStatus.body?.mode,
          detectedUrl: withStatus.body?.detectedUrl,
          choices: (withStatus.body?.availableViteTargets || []).length,
        },
        withoutBrowser: {
          mode: withoutStatus.body?.mode,
          detectedUrl: withoutStatus.body?.detectedUrl,
          choices: (withoutStatus.body?.availableViteTargets || []).length,
        },
      });
      if (withoutStatus.body?.detectedUrl || (withoutStatus.body?.availableViteTargets || []).length) {
        report.failures.push(`${guard.title} duplicate row without browser inherited another row's target.`);
      }
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    try {
      await page.goto(`${BASE_URL}/?v=playwright-live-preview-test`, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);
      await dismissSetupOverlay(page);
      await page.locator("#browserViewBtn").click({ timeout: 2000 }).catch(() => {
        return page.evaluate(() => document.body.classList.add("is-browser-view"));
      });

      for (const pass of ["first", "second", "after-switch"]) {
        for (const target of targets) {
          await clickChat(page, target.chat);
          await waitForTargetPreview(page, target);
          const snap = await uiSnapshot(page, `${pass}:${target.label}`, target.label);
          report.ui.push(snap);
          if (!snap.liveStatus.includes("Playwright Live Preview")) {
            report.failures.push(`${snap.label} UI did not label Playwright Live Preview.`);
          }
          if (snap.browserUrl !== target.url || !snap.liveStatus.includes(target.url)) {
            report.failures.push(`${snap.label} UI showed ${snap.browserUrl || "no URL"} instead of ${target.url}.`);
          }
          if (snap.shotHidden && !snap.frameHasSelectedFixture) {
            report.failures.push(`${snap.label} UI did not show a live screenshot or DOM mirror.`);
          }
          if (/Real mirror|Codex in-app|remote test/i.test(snap.liveStatus)) {
            report.failures.push(`${snap.label} UI still contains old mirror language.`);
          }
          if (/localhost:3001|127\.0\.0\.1:3001/.test(snap.frameSrc) || /localhost:3001|127\.0\.0\.1:3001/.test(snap.browserUrl)) {
            report.failures.push(`${snap.label} is pointing the preview back at the Vlix bridge.`);
          }
        }
        if (noFallbackChat) {
          await clickChat(page, noFallbackChat.chat);
          await waitForNoPreview(page);
          const snap = await uiSnapshot(page, `${pass}:no-fallback:${noFallbackChat.title}`);
          report.ui.push(snap);
          if (snap.browserUrl || !snap.shotHidden || !snap.frameHidden) {
            report.failures.push(`${snap.label} borrowed another chat's preview instead of staying empty.`);
          }
        }
      }

      await page.screenshot({ path: path.join(OUTPUT_DIR, "playwright-live-preview-three-chat.png"), fullPage: true });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);
      await dismissSetupOverlay(page);
      await page.locator("#browserViewBtn").click({ timeout: 2000 }).catch(() => {
        return page.evaluate(() => document.body.classList.add("is-browser-view"));
      });
      for (const target of targets) {
        await clickChat(page, target.chat);
        await waitForTargetPreview(page, target);
        const snap = await uiSnapshot(page, `after-reload:${target.label}`, target.label);
        report.ui.push(snap);
        if (snap.browserUrl !== target.url || !snap.liveStatus.includes(target.url)) {
          report.failures.push(`${snap.label} UI showed ${snap.browserUrl || "no URL"} instead of ${target.url}.`);
        }
        if (snap.shotHidden && !snap.frameHasSelectedFixture) {
          report.failures.push(`${snap.label} UI did not show a live screenshot or DOM mirror after reload.`);
        }
      }
      if (noFallbackChat) {
        await clickChat(page, noFallbackChat.chat);
        await waitForNoPreview(page);
        const snap = await uiSnapshot(page, `after-reload:no-fallback:${noFallbackChat.title}`);
        report.ui.push(snap);
        if (snap.browserUrl || !snap.shotHidden || !snap.frameHidden) {
          report.failures.push(`${snap.label} borrowed another chat's preview after reload.`);
        }
      }
      await page.screenshot({ path: path.join(OUTPUT_DIR, "playwright-live-preview-after-reload.png"), fullPage: true });
    } finally {
      await browser.close();
    }

    for (const target of targets) {
      await postJson("/api/vite-browser/stop", { chatId: target.id }, 3000).catch(() => {});
    }
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Report: ${REPORT_PATH}`);
  if (report.failures.length) {
    console.error(report.failures.join("\n"));
    process.exit(1);
  }
  console.log("Playwright Live Preview three-chat test passed.");
};

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
