#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { chromium } from "playwright-core";
import {
  AGENTS_FILE,
  APP_DIR,
  BRIDGE_PID_FILE,
  BRIDGE_STATE_FILE,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_AGENTS,
  DEFAULT_CONFIG,
  DEFAULT_PERMISSIONS,
  DEFAULT_SITES,
  DOWNLOADS_DIR,
  EVENTS_LOG_FILE,
  LOGS_DIR,
  PERMISSIONS_FILE,
  PROFILE_DIR,
  RUNTIME_DIR,
  SCREENSHOTS_DIR,
  SESSIONS_DIR,
  SITES_FILE,
  SOCKET_PATH,
  SPACES_DIR,
  SPACES_STATE_FILE,
  STATE_DIR,
  UPLOADS_DIR,
  ensureBaseDirs,
  isSubPath,
  mergeConfig,
  randomId,
  readJson,
  redact,
  safeHost,
  safeOrigin,
  sanitizePath,
  writeJsonAtomic
} from "./common.mjs";
import { lookupSecret, secretServiceDoctor } from "./secrets.mjs";

const VERSION = "0.1.0";
const START_LOCK_DIR = path.join(RUNTIME_DIR, "bridge.lock");
const DEFAULT_SPACE_IDS = ["codex", "claude", "deepseek", "hermes", "gemini", "opencode"];
const HIGH_RISK_RE = /(?:\b(pay|purchase|buy|checkout|place\s+order|send|publish|post|delete|remove|refund|transfer|withdraw|change\s+(?:password|security)|disable\s+2fa|confirm(?:ation)?|submit|finalize|sign\s+contract)\b|付款|購買|下單|結帳|發送|傳送|寄出|發布|刪除|移除|退款|轉帳|提款|修改密碼|安全設定|確認送出|正式提交|簽署)/i;
const MEDIUM_RISK_RE = /(?:\b(fill|upload|edit|save|create|update|login|log\s*in|sign\s*in|select|attach|apply)\b|填寫|上傳|編輯|儲存草稿|建立草稿|登入|選擇|附加)/i;
const SECRET_FIELD_RE = /(password|passwd|passcode|otp|one[-_ ]?time|token|api[-_ ]?key|secret|private[-_ ]?key|credit|card|cvv|cvc|security[-_ ]?code)/i;
const BATCH_METHODS = new Set([
  "navigate", "newTab", "snapshot", "click", "fill", "type", "select", "scroll", "wait",
  "getText", "getTitle", "getUrl", "screenshot", "upload", "download"
]);

class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

let config = { ...DEFAULT_CONFIG };
let permissions = { ...DEFAULT_PERMISSIONS };
let sites = structuredClone(DEFAULT_SITES);
let agents = structuredClone(DEFAULT_AGENTS);
let context = null;
let anchorPage = null;
let browserStarting = null;
let pageCreationQueue = Promise.resolve();
let browserMode = "headed";
let stopping = false;
let server = null;
let cdpPort = 0;
let freezeTimer = null;
let recoveringBrowser = false;
let ownsStartLock = false;
const spaces = new Map();
const pageMeta = new Map();
const logQueues = new Map();

function browserChildEnv() {
  const env = {
    ...process.env,
    CHROME_CONFIG_HOME: path.join(STATE_DIR, "chromium-config")
  };
  for (const key of Object.keys(env)) {
    if (/^(?:.*_)?(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE)$/i.test(key)) delete env[key];
  }
  return env;
}

function parseArgs(argv) {
  const result = { daemon: false, headless: false, foreground: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--daemon") result.daemon = true;
    else if (arg === "--headless") result.headless = true;
    else if (arg === "--headed") result.headless = false;
    else if (arg === "--foreground") result.foreground = true;
    else if (arg === "--cdp-port") result.cdpPort = Number(argv[++index] || 0);
  }
  return result;
}

async function loadConfiguration() {
  const fileConfig = await readJson(CONFIG_FILE, {});
  config = mergeConfig(DEFAULT_CONFIG, fileConfig);
  config.profileDir = fileConfig.profileDir || PROFILE_DIR;
  await assertDedicatedProfile(config.profileDir);
  const filePermissions = await readJson(PERMISSIONS_FILE, {});
  permissions = { ...DEFAULT_PERMISSIONS, ...filePermissions };
  sites = {
    ...structuredClone(DEFAULT_SITES),
    ...await readJson(SITES_FILE, {}),
    navigation: { ...DEFAULT_SITES.navigation, ...(await readJson(SITES_FILE, {})).navigation },
    credentials: { ...DEFAULT_SITES.credentials, ...(await readJson(SITES_FILE, {})).credentials }
  };
  agents = { ...structuredClone(DEFAULT_AGENTS), ...await readJson(AGENTS_FILE, {}) };
}

async function canonicalPath(candidate) {
  try { return await fsp.realpath(candidate); }
  catch { return path.resolve(candidate); }
}

async function assertDedicatedProfile(candidate) {
  const profilePath = await canonicalPath(candidate);
  const dailyRoots = [
    path.join(os.homedir(), ".config", "google-chrome"),
    path.join(os.homedir(), ".config", "google-chrome-beta"),
    path.join(os.homedir(), ".config", "google-chrome-unstable"),
    path.join(os.homedir(), ".config", "chromium")
  ];
  for (const root of dailyRoots) {
    const dailyPath = await canonicalPath(root);
    if (isSubPath(profilePath, dailyPath) || isSubPath(dailyPath, profilePath)) {
      throw new BridgeError("PROFILE_NOT_ISOLATED", `AI Browser profile must not overlap daily browser data: ${dailyPath}`);
    }
  }
  return profilePath;
}

function now() { return new Date().toISOString(); }

function spaceTemplate(id, descriptor = {}) {
  const agent = descriptor.agent || Object.entries(agents.spaces || {}).find(([, spaceId]) => spaceId === id)?.[0] || id;
  const requestedStatus = String(descriptor.status || "idle");
  const restoredStatus = ["idle", "waiting-user", "failed", "stopped"].includes(requestedStatus)
    ? requestedStatus
    : requestedStatus === "running" || requestedStatus === "starting" ? "failed" : "idle";
  const restoredPages = Array.isArray(descriptor.pages) ? descriptor.pages.map((item) => ({
    url: item.url,
    title: item.title || "",
    pageId: item.pageId || randomId("page")
  })).filter((item) => /^https?:\/\//i.test(item.url || "")) : [];
  return {
    id,
    agent,
    status: restoredStatus,
    task: descriptor.task ? redact(String(descriptor.task)).slice(0, 160) : null,
    createdAt: descriptor.createdAt || now(),
    updatedAt: now(),
    lastError: descriptor.lastError ? redact(String(descriptor.lastError)).slice(0, 500) : null,
    humanControlled: false,
    approval: null,
    pages: [],
    activePageId: descriptor.activePageId || null,
    restorablePages: [...restoredPages],
    lastKnownPages: [...restoredPages],
    lock: null
  };
}

function getOrCreateSpace(id, descriptor = {}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(id)) throw new BridgeError("INVALID_SPACE", "space id must be a simple stable identifier");
  if (!spaces.has(id)) spaces.set(id, spaceTemplate(id, descriptor));
  return spaces.get(id);
}

async function loadState() {
  const state = await readJson(SPACES_STATE_FILE, { spaces: [] });
  for (const descriptor of Array.isArray(state.spaces) ? state.spaces : []) getOrCreateSpace(descriptor.id, descriptor);
  for (const id of DEFAULT_SPACE_IDS) getOrCreateSpace(id);
}

function pageSummary(page, meta, activePageId) {
  return {
    pageId: meta.pageId,
    url: page.isClosed() ? "about:blank" : page.url(),
    title: meta.title || "",
    frozen: Boolean(meta.frozen),
    active: meta.pageId === activePageId,
    createdAt: meta.createdAt,
    lastUsedAt: meta.lastUsedAt
  };
}

function spaceSummary(space) {
  const pageItems = space.pages.filter((page) => !page.isClosed()).map((page) => pageSummary(page, pageMeta.get(page), space.activePageId));
  return {
    id: space.id,
    agent: space.agent,
    status: space.status,
    task: space.task,
    pages: pageItems,
    pageCount: pageItems.length,
    activePageId: space.activePageId,
    activeUrl: pageItems.find((page) => page.active)?.url || pageItems[0]?.url || null,
    humanControlled: space.humanControlled,
    pendingApproval: space.approval ? {
      id: space.approval.id,
      reason: space.approval.reason,
      createdAt: space.approval.createdAt
    } : null,
    lastError: space.lastError,
    updatedAt: space.updatedAt
  };
}

async function persistState() {
  const serialized = [...spaces.values()].map((space) => {
    const livePages = space.pages.filter((page) => !page.isClosed()).map((page) => {
      const meta = pageMeta.get(page);
      return {
        pageId: meta.pageId,
        url: page.url(),
        title: meta.title || ""
      };
    });
    if (livePages.length) space.lastKnownPages = livePages;
    const recoverablePages = livePages.length
      ? livePages
      : space.status === "stopped" ? [] : (space.lastKnownPages || space.restorablePages || []);
    const persistedStatus = ["idle", "waiting-user", "failed", "stopped"].includes(space.status)
      ? space.status
      : "failed";
    return {
      id: space.id,
      agent: space.agent,
      status: persistedStatus,
      task: space.task ? redact(String(space.task)).slice(0, 160) : null,
      createdAt: space.createdAt,
      activePageId: space.activePageId,
      lastError: space.lastError ? redact(String(space.lastError)).slice(0, 500) : null,
      pages: recoverablePages
    };
  });
  await writeJsonAtomic(SPACES_STATE_FILE, { version: 1, updatedAt: now(), spaces: serialized });
  for (const space of spaces.values()) {
    const session = serialized.find((item) => item.id === space.id);
    if (session) await writeJsonAtomic(path.join(SESSIONS_DIR, `${space.id}.json`), session);
  }
}

async function writeBridgeState() {
  await writeJsonAtomic(BRIDGE_STATE_FILE, {
    version: VERSION,
    pid: process.pid,
    socket: SOCKET_PATH,
    mode: browserMode,
    profileDir: path.resolve(config.profileDir),
    cdpPort,
    startedAt: bridgeStartedAt,
    chromeBinary: config.chromeBinary,
    sandbox: "enabled"
  });
  await fsp.writeFile(BRIDGE_PID_FILE, `${process.pid}\n`, { mode: 0o600 });
  try { await fsp.chmod(BRIDGE_PID_FILE, 0o600); } catch {}
}

const bridgeStartedAt = now();

function logSafe(event, details = {}) {
  const line = JSON.stringify(redact({
    timestamp: now(),
    event,
    ...details
  })) + "\n";
  enqueueLog(EVENTS_LOG_FILE, line);
  if (details.spaceId) {
    const file = path.join(LOGS_DIR, `${sanitizePath(details.spaceId)}.jsonl`);
    enqueueLog(file, line);
  }
}

function enqueueLog(file, line) {
  const previous = logQueues.get(file) || Promise.resolve();
  const next = previous.then(async () => {
    const limit = Math.max(64 * 1024, Number(config.maxLogBytes || 10 * 1024 * 1024));
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch {}
    if (size + Buffer.byteLength(line) > limit) {
      const rotations = Math.max(1, Math.min(20, Number(config.logRotations || 5)));
      await fsp.rm(`${file}.${rotations}`, { force: true }).catch(() => {});
      for (let index = rotations - 1; index >= 1; index -= 1) {
        await fsp.rename(`${file}.${index}`, `${file}.${index + 1}`).catch(() => {});
      }
      await fsp.rename(file, `${file}.1`).catch(() => {});
    }
    await fsp.appendFile(file, line, { mode: 0o600 });
    await fsp.chmod(file, 0o600).catch(() => {});
  }).catch(() => {});
  logQueues.set(file, next);
}

function taskLabel(value, fallback) {
  if (!value) return fallback;
  return redact(String(value).replace(/\s+/g, " ")).slice(0, 160);
}

function globHostMatch(host, pattern) {
  const normalizedHost = String(host || "").toLowerCase();
  const normalizedPattern = String(pattern || "").toLowerCase().trim();
  if (!normalizedPattern) return false;
  if (normalizedPattern.includes("*")) {
    const candidates = normalizedPattern.startsWith("*.")
      ? [normalizedPattern, normalizedPattern.slice(2)]
      : [normalizedPattern];
    return candidates.some((candidate) => {
      const expression = new RegExp(`^${candidate.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
      return expression.test(normalizedHost);
    });
  }
  return normalizedHost === normalizedPattern;
}

function matchesAnyHost(host, patterns = []) {
  return patterns.some((pattern) => globHostMatch(host, pattern));
}

function isBlockedHost(host) {
  const normalized = String(host || "").toLowerCase();
  return matchesAnyHost(normalized, sites.blockedHosts || []) || (sites.blockedHostKeywords || []).some((keyword) => normalized.includes(String(keyword).toLowerCase()));
}
function isHighRiskHost(host) { return matchesAnyHost(host, sites.highRiskHosts || []); }

function assertSafeNavigation(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new BridgeError("INVALID_URL", "navigation requires an absolute http(s) URL"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new BridgeError("UNSUPPORTED_URL", "only http(s) navigation is allowed");
  const host = parsed.hostname.toLowerCase();
  if (isBlockedHost(host)) throw new BridgeError("BLOCKED_HOST", `navigation blocked by policy for host ${host}`);
  const allowHosts = sites.navigation?.allowHosts || [];
  if (sites.navigation?.mode === "allowlist" && !matchesAnyHost(host, allowHosts)) {
    throw new BridgeError("NAVIGATION_NOT_ALLOWED", `host ${host} is not on the navigation allowlist`);
  }
  return parsed.toString();
}

function credentialEntry(credentialId, host) {
  const entry = (sites.credentials?.entries || []).find((item) => item.id === credentialId);
  if (!entry) throw new BridgeError("CREDENTIAL_NOT_ALLOWED", `credentialRef '${credentialId}' is not configured in sites.json`);
  const allowedHosts = Array.isArray(entry.hosts) ? entry.hosts : (entry.host ? [entry.host] : []);
  const normalizedHost = String(host || "").toLowerCase();
  const baseHost = normalizedHost.startsWith("www.") ? normalizedHost.slice(4) : normalizedHost;
  const hostAllowed = matchesAnyHost(normalizedHost, allowedHosts)
    || (baseHost !== normalizedHost && matchesAnyHost(baseHost, allowedHosts));
  if (!hostAllowed) throw new BridgeError("CREDENTIAL_DOMAIN_MISMATCH", `credentialRef '${credentialId}' is not allowed for ${host}`);
  if (isBlockedHost(host) || isHighRiskHost(host)) throw new BridgeError("CREDENTIAL_HOST_BLOCKED", `credential use is blocked for ${host}`);
  return entry;
}

function currentHost(page) { return safeHost(page.url()); }

function sameUrl(left, right) {
  try { return new URL(left).href === new URL(right).href; }
  catch { return left === right; }
}

function activeSpaceCount() {
  return [...spaces.values()].filter((space) => ["running", "waiting-user", "starting"].includes(space.status)).length;
}

function assertCaller(space, params = {}, method = "") {
  const caller = params.agent || params.caller;
  if (space.humanControlled && caller && caller !== "operator") {
    throw new BridgeError("HUMAN_TAKEOVER", `space '${space.id}' is under human takeover`);
  }
  if (space.status === "waiting-user" && caller && caller !== "operator" && method !== "stop") {
    throw new BridgeError("WAITING_USER", `space '${space.id}' is waiting for the user`);
  }
  if (!caller || caller === "operator") return;
  const allowed = agents.allowedAgents || Object.keys(agents.spaces || {});
  if (!allowed.includes(caller)) throw new BridgeError("AGENT_NOT_ALLOWED", `unknown agent '${caller}'`);
  const assigned = agents.spaces?.[caller];
  if (assigned && assigned !== space.id) throw new BridgeError("SPACE_OWNERSHIP", `agent '${caller}' cannot use space '${space.id}'`);
}

function riskForText(text = "", requested) {
  const inferred = HIGH_RISK_RE.test(text) ? "HIGH" : MEDIUM_RISK_RE.test(text) ? "MEDIUM" : "LOW";
  const requestedRisk = requested && ["LOW", "MEDIUM", "HIGH"].includes(String(requested).toUpperCase())
    ? String(requested).toUpperCase()
    : "LOW";
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  return rank[requestedRisk] > rank[inferred] ? requestedRisk : inferred;
}

function actionDescription(method, page, text = "") {
  const host = currentHost(page) || "about:blank";
  return `${method} on ${host}${text ? ` (${String(text).replace(/\s+/g, " ").slice(0, 100)})` : ""}`;
}

function approvalTarget(space, method, page, params = {}) {
  return {
    method,
    pageId: pageMeta.get(page)?.pageId || null,
    ref: params.ref || null,
    url: page.url(),
    host: currentHost(page)
  };
}

function sameApprovalTarget(left, right) {
  return Boolean(left && right
    && left.method === right.method
    && left.pageId === right.pageId
    && left.ref === right.ref
    && left.url === right.url
    && left.host === right.host);
}

function requireApproval(space, method, page, text, requestedRisk, params = {}) {
  const risk = riskForText(text, requestedRisk);
  if (risk !== "HIGH" || !permissions.highRequiresHuman) return risk;
  const target = approvalTarget(space, method, page, params);
  if (space.approval?.approvedOnce && sameApprovalTarget(space.approval.target, target)) {
    space.approval = null;
    return risk;
  }
  if (space.approval?.approvedOnce) space.approval = null;
  const id = randomId("approval");
  const reason = actionDescription(method, page, text);
  space.approval = { id, reason, createdAt: now(), approvedOnce: false, target };
  space.status = "waiting-user";
  space.updatedAt = now();
  logSafe("high_risk_waiting_user", { spaceId: space.id, method, risk, host: currentHost(page) });
  throw new BridgeError("CONFIRMATION_REQUIRED", "high-risk action is stopped before final submission; ask the user to run 'ai-browser confirm <space>'", { approvalId: id, reason, risk });
}

async function chooseCdpPort(preferred = 0) {
  if (preferred > 0) return preferred;
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(0));
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function observeMutations(page) {
  await page.evaluate(() => {
    if (window.__aiBrowserMutationObserverInstalled) return;
    window.__aiBrowserMutation = Number(window.__aiBrowserMutation || 0);
    const root = document.documentElement || document;
    const observer = new MutationObserver(() => { window.__aiBrowserMutation += 1; });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__aiBrowserMutationObserverInstalled = true;
  }).catch(() => {});
}

async function mutationVersion(page) {
  return await page.evaluate(() => Number(window.__aiBrowserMutation || 0)).catch(() => 0);
}

async function invalidateRefs(page) {
  const meta = pageMeta.get(page);
  if (!meta) return;
  meta.refs.clear();
  meta.snapshotMutation = null;
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("[data-ai-browser-ref]")) node.removeAttribute("data-ai-browser-ref");
  }).catch(() => {});
}

function attachPage(page, spaceId, pageId = randomId("page")) {
  if (pageMeta.has(page)) return pageMeta.get(page);
  const meta = {
    spaceId,
    pageId,
    createdAt: now(),
    lastUsedAt: Date.now(),
    title: "",
    frozen: false,
    refs: new Map(),
    snapshotMutation: null,
    refEpoch: 0
  };
  pageMeta.set(page, meta);
  page.setDefaultTimeout(config.actionTimeoutMs);
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    meta.refs.clear();
    meta.snapshotMutation = null;
    meta.frozen = false;
    meta.lastUsedAt = Date.now();
    const space = spaces.get(spaceId);
    if (space) {
      space.updatedAt = now();
      const host = currentHost(page);
      if (isBlockedHost(host)) {
        void page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
        space.lastError = `blocked navigation to ${host}`;
        logSafe("blocked_navigation", { spaceId, host });
      }
      void persistState().catch(() => {});
    }
  });
  page.on("popup", (popup) => {
    const space = spaces.get(spaceId);
    if (!space) return;
    if (space.pages.length >= config.maxPagesPerSpace) {
      void popup.close().catch(() => {});
      return;
    }
    attachPage(popup, spaceId);
    space.pages.push(popup);
    space.activePageId = pageMeta.get(popup).pageId;
    void persistState().catch(() => {});
  });
  page.on("crash", () => {
    const space = spaces.get(spaceId);
    if (space) {
      space.status = "failed";
      space.lastError = "Chromium reported a crashed page";
      space.updatedAt = now();
      logSafe("page_crashed", { spaceId, pageId: meta.pageId });
      void persistState().catch(() => {});
    }
  });
  page.on("close", () => {
    pageMeta.delete(page);
    const space = spaces.get(spaceId);
    if (space) {
      space.pages = space.pages.filter((item) => item !== page);
      if (space.activePageId === meta.pageId) space.activePageId = pageMeta.get(space.pages[0])?.pageId || null;
      space.updatedAt = now();
      void persistState().catch(() => {});
    }
  });
  return meta;
}

async function thaw(page) {
  const meta = pageMeta.get(page);
  if (!meta?.frozen) return;
  const session = await context.newCDPSession(page);
  try { await session.send("Page.setWebLifecycleState", { state: "active" }); } finally { await session.detach().catch(() => {}); }
  meta.frozen = false;
  meta.lastUsedAt = Date.now();
}

async function createPageInWindowUnlocked(spaceId, requestedUrl = "about:blank", pageId) {
  if (!context) await ensureBrowser();
  const space = getOrCreateSpace(spaceId);
  if (space.pages.filter((page) => !page.isClosed()).length >= config.maxPagesPerSpace) {
    throw new BridgeError("PAGE_LIMIT", `space '${spaceId}' already has ${config.maxPagesPerSpace} pages`);
  }
  // Playwright/Chrome starts a persistent context with one blank page. Reuse
  // that page for the first real Space so the user never gets an extra blank
  // window. Additional Spaces still receive independent browser windows.
  let page = anchorPage && !anchorPage.isClosed() && !pageMeta.has(anchorPage)
    ? anchorPage
    : null;
  if (page) {
    anchorPage = null;
  } else if (!context.browser()?.newBrowserCDPSession) {
    page = await context.newPage();
  } else {
    try {
      const browserSession = await context.browser().newBrowserCDPSession();
      const pageEvent = context.waitForEvent("page", { timeout: 4000 });
      // Keep one headed AI Browser window; each Space owns separate tabs.
      await browserSession.send("Target.createTarget", { url: "about:blank", newWindow: false });
      page = await pageEvent;
      await browserSession.detach().catch(() => {});
    } catch {
      page = await context.newPage();
    }
  }
  const meta = attachPage(page, spaceId, pageId);
  space.pages.push(page);
  space.activePageId = meta.pageId;
  if (requestedUrl && requestedUrl !== "about:blank") {
    if (!sameUrl(page.url(), requestedUrl)) await navigatePage(space, page, requestedUrl);
    else await page.waitForLoadState("domcontentloaded", { timeout: config.pageLoadTimeoutMs }).catch(() => {});
  }
  return page;
}

async function createPageInWindow(spaceId, requestedUrl = "about:blank", pageId) {
  const task = pageCreationQueue.then(() => createPageInWindowUnlocked(spaceId, requestedUrl, pageId));
  pageCreationQueue = task.catch(() => {});
  return await task;
}

async function ensureBrowser() {
  if (context) return context;
  if (browserStarting) return await browserStarting;
  browserStarting = launchBrowser();
  try { return await browserStarting; }
  finally { browserStarting = null; }
}

async function launchBrowser() {
  if (context) return context;
  if (!fs.existsSync(config.chromeBinary)) throw new BridgeError("CHROME_NOT_FOUND", `Chrome binary not found: ${config.chromeBinary}`);
  await fsp.mkdir(config.profileDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(path.join(STATE_DIR, "chromium-config"), { recursive: true, mode: 0o700 });
  try { await fsp.chmod(config.profileDir, 0o700); } catch {}
  // Playwright uses its own CDP-compatible pipe transport. Adding a second
  // --remote-debugging-port beside Playwright's pipe makes Chrome exit on
  // some Chrome/Playwright combinations, so the bridge intentionally keeps
  // CDP private to the bridge process.
  cdpPort = 0;
  browserMode = config.mode === "headless" ? "headless" : "headed";
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--password-store=gnome-libsecret",
    "--disable-background-networking",
    "--ozone-platform=wayland"
  ];
  if (browserMode === "headed" && config.startMinimized) args.push("--start-minimized");
  if (config.disableGpu) args.push("--disable-gpu");
  context = await chromium.launchPersistentContext(config.profileDir, {
    executablePath: config.chromeBinary,
    headless: browserMode === "headless",
    chromiumSandbox: true,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    acceptDownloads: true,
    downloadsPath: DOWNLOADS_DIR,
    timeout: config.actionTimeoutMs,
    env: browserChildEnv(),
    args
  });
  await context.addInitScript({ content: `(() => { window.__aiBrowserMutation = 0; })();` });
  context.on("page", (page) => {
    if (!pageMeta.has(page)) {
      const known = [...spaces.values()].find((space) => space.pages.length && space.activePageId && space.pages.at(-1) === page);
      if (known) attachPage(page, known.id);
    }
  });
  context.on("close", () => {
    context = null;
    anchorPage = null;
    if (stopping) {
      logSafe("chromium_stopped", {});
      return;
    }
    for (const space of spaces.values()) {
      const recoverable = space.status !== "stopped" && (space.lastKnownPages || []).length > 0;
      if (recoverable) {
        space.restorablePages = [...space.lastKnownPages];
        space.status = "failed";
        space.lastError = "Chromium context closed; automatic page recovery pending";
        space.updatedAt = now();
      }
    }
    logSafe("chromium_closed", {});
    void persistState().catch(() => {});
    setTimeout(() => { void recoverAfterBrowserCrash(); }, 2000).unref();
  });
  const initialPages = context.pages();
  anchorPage = initialPages[0] || await context.newPage();
  for (const page of initialPages.slice(1)) await page.close().catch(() => {});
  await writeBridgeState();
  logSafe("chromium_started", { mode: browserMode, chromeBinary: config.chromeBinary, sandbox: "enabled" });
  return context;
}

async function recoverAfterBrowserCrash() {
  if (stopping || recoveringBrowser) return;
  recoveringBrowser = true;
  try {
    await ensureBrowser();
    for (const space of spaces.values()) {
      if (space.status !== "failed" || !(space.restorablePages || []).length) continue;
      const descriptors = [...space.restorablePages].slice(0, Number(config.maxPagesPerSpace || 8));
      space.restorablePages = [];
      space.pages = space.pages.filter((page) => !page.isClosed());
      try {
        for (const descriptor of descriptors) {
          await createPageInWindow(space.id, descriptor.url, descriptor.pageId);
        }
        space.status = "idle";
        space.task = null;
        space.lastError = null;
        space.updatedAt = now();
        logSafe("space_recovered", { spaceId: space.id, pages: descriptors.length });
      } catch (error) {
        space.status = "failed";
        space.lastError = redact(error.message || String(error));
        space.restorablePages = descriptors;
        logSafe("space_recovery_failed", { spaceId: space.id, message: space.lastError });
      }
    }
    await persistState();
  } catch (error) {
    logSafe("chromium_restart_failed", { message: error.message });
  } finally {
    recoveringBrowser = false;
  }
}

async function restorePageIfNeeded(space) {
  const restorable = space.restorablePages?.shift();
  if (!restorable) return createPageInWindow(space.id, "about:blank");
  return createPageInWindow(space.id, restorable.url, restorable.pageId);
}

async function getPage(space, params = {}, create = true) {
  await ensureBrowser();
  let page = null;
  if (params.pageId) page = space.pages.find((item) => pageMeta.get(item)?.pageId === params.pageId && !item.isClosed());
  if (!page && space.activePageId) page = space.pages.find((item) => pageMeta.get(item)?.pageId === space.activePageId && !item.isClosed());
  if (!page) page = space.pages.find((item) => !item.isClosed());
  if (!page && create) page = await restorePageIfNeeded(space);
  if (!page) throw new BridgeError("NO_PAGE", `space '${space.id}' has no open page`);
  const meta = pageMeta.get(page) || attachPage(page, space.id);
  space.activePageId = meta.pageId;
  meta.lastUsedAt = Date.now();
  await thaw(page);
  await observeMutations(page);
  return page;
}

async function navigatePage(space, page, rawUrl, params = {}) {
  const url = assertSafeNavigation(rawUrl);
  if (space.approval) {
    logSafe("approval_invalidated", { spaceId: space.id, approvalId: space.approval.id, reason: "navigation" });
    space.approval = null;
  }
  await thaw(page);
  const timeout = Math.max(250, Math.min(Number(config.pageLoadTimeoutMs), Number(params.timeoutMs || config.pageLoadTimeoutMs)));
  await page.goto(url, { waitUntil: "domcontentloaded", timeout });
  await observeMutations(page);
  const meta = pageMeta.get(page);
  if (meta) meta.title = await page.title().catch(() => "");
  space.updatedAt = now();
  logSafe("navigate", { spaceId: space.id, pageId: meta?.pageId, origin: safeOrigin(page.url()) });
  return { url: page.url(), title: meta?.title || "" };
}

async function axTree(page) {
  const session = await context.newCDPSession(page);
  try {
    const response = await session.send("Accessibility.getFullAXTree");
    const nodes = [];
    for (const node of response.nodes || []) {
      if (node.ignored) continue;
      const role = node.role?.value || "generic";
      const name = node.name?.value || "";
      if (!name && ["generic", "none", "rootWebArea"].includes(role)) continue;
      const item = { role, name: redact(String(name).slice(0, 220)) };
      if (node.checked?.value !== undefined) item.checked = node.checked.value;
      if (node.disabled?.value !== undefined) item.disabled = node.disabled.value;
      nodes.push(item);
      if (nodes.length >= Number(config.maxSnapshotNodes || 180)) break;
    }
    return nodes;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function snapshotPage(space, page) {
  await thaw(page);
  await observeMutations(page);
  const meta = pageMeta.get(page);
  const tokenPrefix = `aib-${randomId("ref")}`;
  const interactive = await page.evaluate(({ tokenPrefix, limit }) => {
    const selector = "a,button,input,textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[contenteditable=true]";
    const visible = (node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const label = (node) => {
      const aria = node.getAttribute("aria-label");
      if (aria) return aria;
      const labelledBy = node.getAttribute("aria-labelledby");
      if (labelledBy) return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
      if (node.labels?.length) return Array.from(node.labels).map((item) => item.innerText).join(" ").trim();
      return (node.innerText || node.textContent || node.getAttribute("placeholder") || node.getAttribute("title") || "").replace(/\s+/g, " ").trim();
    };
    const roleFor = (node) => {
      const explicit = node.getAttribute("role");
      if (explicit) return explicit;
      const tag = node.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return "combobox";
      if (tag === "input") {
        if (["checkbox", "radio", "submit", "button", "file"].includes(node.type)) return node.type;
        return "textbox";
      }
      return "interactive";
    };
    const nodes = [];
    let index = 0;
    for (const node of document.querySelectorAll(selector)) {
      if (!visible(node) || index >= limit) continue;
      const ref = `e${index + 1}`;
      const token = `${tokenPrefix}-${index + 1}`;
      node.setAttribute("data-ai-browser-ref", token);
      const type = node.getAttribute("type") || "";
      const item = {
        ref,
        role: roleFor(node),
        name: type === "password" ? "password field" : label(node).slice(0, 180),
        type,
        disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
        checked: node.checked === true ? true : undefined
      };
      if (node.tagName.toLowerCase() === "a" && node.href) {
        try { item.href = new URL(node.href).origin + new URL(node.href).pathname; } catch {}
      }
      nodes.push(item);
      index += 1;
    }
    return nodes;
  }, { tokenPrefix, limit: Number(config.maxSnapshotInteractive || 120) });
  meta.refs.clear();
  for (const item of interactive) meta.refs.set(item.ref, { token: `${tokenPrefix}-${Number(item.ref.slice(1))}` });
  await new Promise((resolve) => setTimeout(resolve, 0));
  meta.snapshotMutation = await mutationVersion(page);
  meta.refEpoch += 1;
  meta.title = await page.title().catch(() => meta.title || "");
  logSafe("snapshot", { spaceId: space.id, pageId: meta.pageId, origin: safeOrigin(page.url()), refs: interactive.length });
  return {
    spaceId: space.id,
    pageId: meta.pageId,
    refEpoch: meta.refEpoch,
    url: page.url(),
    title: meta.title,
    refs: interactive,
    accessibilityTree: await axTree(page),
    note: "Refs expire after navigation or DOM changes; take a new snapshot before continuing."
  };
}

async function locatorForRef(page, ref) {
  const meta = pageMeta.get(page);
  if (!meta?.refs.has(ref)) throw new BridgeError("STALE_REF", `element ref '${ref}' is missing; take a fresh snapshot`);
  const currentMutation = await mutationVersion(page);
  if (meta.snapshotMutation !== null && currentMutation !== meta.snapshotMutation) {
    await invalidateRefs(page);
    throw new BridgeError("STALE_REF", `element ref '${ref}' expired because the DOM changed; take a fresh snapshot`);
  }
  const token = meta.refs.get(ref).token.replace(/"/g, "\\\"");
  const locator = page.locator(`[data-ai-browser-ref="${token}"]`).first();
  if (await locator.count() !== 1) {
    await invalidateRefs(page);
    throw new BridgeError("STALE_REF", `element ref '${ref}' is no longer present; take a fresh snapshot`);
  }
  return locator;
}

async function elementInfo(page, ref) {
  const locator = await locatorForRef(page, ref);
  return await locator.evaluate((node) => ({
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute("type") || "",
    name: node.getAttribute("name") || "",
    autocomplete: node.getAttribute("autocomplete") || "",
    ariaLabel: node.getAttribute("aria-label") || ""
  }));
}

async function rawValueAllowed(page, ref, value) {
  const info = await elementInfo(page, ref);
  const sensitive = SECRET_FIELD_RE.test(`${info.type} ${info.name} ${info.autocomplete} ${info.ariaLabel}`);
  if (sensitive && permissions.rawSensitiveFillBlocked) {
    throw new BridgeError("SENSITIVE_VALUE_REQUIRES_CREDENTIAL_REF", "sensitive fields must use credentialRef; raw password/token values are disabled");
  }
  return value;
}

async function fillPage(space, page, params) {
  const ref = params.ref;
  if (!ref) throw new BridgeError("MISSING_REF", "fill requires ref");
  const info = await elementInfo(page, ref);
  const label = `${info.type} ${info.name} ${info.autocomplete} ${info.ariaLabel}`;
  const risk = requireApproval(space, "fill", page, label, params.risk, params);
  if (params.credentialRef) {
    const host = currentHost(page);
    const entry = credentialEntry(params.credentialRef, host);
    let secret = await lookupSecret(params.credentialRef);
    try {
      const locator = await locatorForRef(page, ref);
      await locator.fill(secret, { timeout: config.actionTimeoutMs });
      await locator.evaluate((node) => node.setAttribute("data-ai-browser-sensitive", "true")).catch(() => {});
    } finally {
      secret = "";
    }
    logSafe("fill_credential", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, credentialRef: params.credentialRef, host, risk, label: entry.label || params.credentialRef });
  } else {
    const value = await rawValueAllowed(page, ref, String(params.value ?? ""));
    const locator = await locatorForRef(page, ref);
    await locator.fill(value, { timeout: config.actionTimeoutMs });
    logSafe("fill", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, risk, field: label });
  }
  await invalidateRefs(page);
  return { ok: true, sensitiveValueReturned: false };
}

async function clickPage(space, page, params) {
  const locator = await locatorForRef(page, params.ref);
  const text = await locator.evaluate((node) => {
    const type = (node.getAttribute("type") || "").toLowerCase();
    const safeValue = ["button", "submit", "reset"].includes(type) ? (node.value || "") : "";
    return [
      node.innerText || node.textContent || "",
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      node.getAttribute("name") || "",
      node.getAttribute("id") || "",
      node.getAttribute("class") || "",
      node.getAttribute("data-action") || "",
      node.getAttribute("formaction") || "",
      safeValue
    ].join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
  }).catch(() => "");
  const risk = requireApproval(space, "click", page, text, params.risk, params);
  await locator.click({ timeout: config.actionTimeoutMs, noWaitAfter: false });
  await invalidateRefs(page);
  logSafe("click", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, risk, label: text.slice(0, 120), host: currentHost(page) });
  return { ok: true, risk };
}

async function typePage(space, page, params) {
  const ref = params.ref;
  const info = await elementInfo(page, ref);
  if (SECRET_FIELD_RE.test(`${info.type} ${info.name} ${info.autocomplete} ${info.ariaLabel}`) && permissions.rawSensitiveFillBlocked) {
    throw new BridgeError("SENSITIVE_VALUE_REQUIRES_CREDENTIAL_REF", "sensitive fields must use credentialRef; use fill with credentialRef");
  }
  const risk = requireApproval(space, "type", page, info.name || info.type, params.risk, params);
  const locator = await locatorForRef(page, ref);
  await locator.pressSequentially(String(params.text ?? ""), { timeout: config.actionTimeoutMs });
  await invalidateRefs(page);
  logSafe("type", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, risk, field: info.name || info.type });
  return { ok: true, risk };
}

async function selectPage(space, page, params) {
  const risk = requireApproval(space, "select", page, String(params.value ?? ""), params.risk, params);
  const locator = await locatorForRef(page, params.ref);
  const selected = await locator.selectOption(params.value ?? params.values, { timeout: config.actionTimeoutMs });
  await invalidateRefs(page);
  logSafe("select", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, risk, selectedCount: selected.length });
  return { selected, risk };
}

async function scrollPage(space, page, params) {
  const amount = Math.max(-5000, Math.min(5000, Number(params.amount ?? 600)));
  if (params.ref) {
    const locator = await locatorForRef(page, params.ref);
    await locator.scrollIntoViewIfNeeded({ timeout: config.actionTimeoutMs });
  } else {
    await page.mouse.wheel(0, amount);
  }
  await invalidateRefs(page);
  logSafe("scroll", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, amount });
  return { ok: true };
}

async function waitPage(space, page, params, signal) {
  const timeout = Math.max(0, Math.min(30000, Number(params.timeoutMs ?? config.actionTimeoutMs)));
  if (signal?.aborted) throw new BridgeError("TIMEOUT", "operation was cancelled before wait");
  if (params.url) await page.waitForURL(params.url, { timeout });
  else if (params.text) await page.getByText(String(params.text), { exact: false }).first().waitFor({ state: "visible", timeout });
  else if (params.state) await page.waitForLoadState(params.state, { timeout });
  else await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.min(timeout || 0, 30000));
    const abort = () => {
      clearTimeout(timer);
      reject(new BridgeError("TIMEOUT", "wait was cancelled because the operation timed out"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  await invalidateRefs(page);
  logSafe("wait", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, condition: params.url ? "url" : params.text ? "text" : params.state || "time" });
  return { ok: true, url: page.url() };
}

function sanitizedText(text) {
  return redact(String(text || "")).slice(0, 12000);
}

async function getTextPage(space, page, params) {
  let text;
  if (params.ref) text = await (await locatorForRef(page, params.ref)).innerText({ timeout: config.actionTimeoutMs });
  else if (!params.selector || params.selector === "body") text = await page.locator("body").innerText({ timeout: config.actionTimeoutMs });
  else text = await page.locator(params.selector).first().innerText({ timeout: config.actionTimeoutMs });
  logSafe("get_text", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, chars: String(text).length });
  return { text: sanitizedText(text) };
}

async function getTitlePage(space, page) {
  const title = await page.title().catch(() => "");
  pageMeta.get(page).title = title;
  return { title };
}

async function screenshotPage(space, page, params) {
  const spaceDir = path.join(SCREENSHOTS_DIR, sanitizePath(space.id));
  await fsp.mkdir(spaceDir, { recursive: true, mode: 0o700 });
  let filename = sanitizePath(params.filename || `${Date.now()}.png`);
  if (/\.webp$/i.test(filename)) throw new BridgeError("UNSUPPORTED_SCREENSHOT_FORMAT", "screenshots support png, jpeg, or jpg; webp is not supported by this bridge");
  if (!/\.(png|jpeg|jpg)$/i.test(filename)) filename += ".png";
  const output = path.join(spaceDir, filename);
  if (!isSubPath(output, spaceDir)) throw new BridgeError("INVALID_PATH", "screenshot path is outside the space screenshot directory");
  const sensitiveSelector = [
    '[data-ai-browser-sensitive="true"]',
    'input[type="password"]',
    'input[autocomplete*="password" i]',
    'input[autocomplete="one-time-code" i]',
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[name*="passcode" i]',
    'input[id*="passcode" i]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="token" i]',
    'input[id*="token" i]',
    'input[name*="secret" i]',
    'input[id*="secret" i]',
    'input[name*="cvv" i]',
    'input[name*="cvc" i]'
  ].join(",");
  const mask = config.screenshotMaskPasswordFields ? [page.locator(sensitiveSelector)] : [];
  await page.screenshot({
    path: output,
    fullPage: Boolean(params.fullPage),
    type: filename.endsWith(".png") ? "png" : "jpeg",
    mask,
    maskColor: "#000000"
  });
  await fsp.chmod(output, 0o600).catch(() => {});
  logSafe("screenshot", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, filename, maskedPasswordFields: Boolean(config.screenshotMaskPasswordFields) });
  return { path: output, maskedPasswordFields: Boolean(config.screenshotMaskPasswordFields) };
}

async function uploadPage(space, page, params) {
  const rawPath = path.resolve(String(params.path || ""));
  const roots = [UPLOADS_DIR, ...(Array.isArray(config.allowedUploadRoots) ? config.allowedUploadRoots : [])].map((item) => path.resolve(item));
  let realPath;
  try { realPath = await fsp.realpath(rawPath); } catch { throw new BridgeError("UPLOAD_NOT_FOUND", "upload file does not exist"); }
  if (!roots.some((root) => isSubPath(realPath, root))) throw new BridgeError("UPLOAD_PATH_BLOCKED", "upload must be staged under the AI Browser uploads directory or an explicitly configured upload root");
  const locator = await locatorForRef(page, params.ref);
  const risk = requireApproval(space, "upload", page, path.basename(realPath), params.risk, params);
  await locator.setInputFiles(realPath, { timeout: config.actionTimeoutMs });
  await invalidateRefs(page);
  logSafe("upload", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, filename: sanitizePath(realPath), risk });
  return { ok: true, filename: sanitizePath(realPath), risk };
}

async function downloadPage(space, page, params) {
  const locator = await locatorForRef(page, params.ref);
  const text = await locator.innerText().catch(() => "download");
  const risk = requireApproval(space, "download", page, text, params.risk, params);
  const downloadPromise = page.waitForEvent("download", { timeout: config.actionTimeoutMs });
  await locator.click({ timeout: config.actionTimeoutMs });
  const download = await downloadPromise;
  const spaceDir = path.join(DOWNLOADS_DIR, sanitizePath(space.id));
  await fsp.mkdir(spaceDir, { recursive: true, mode: 0o700 });
  const filename = sanitizePath(download.suggestedFilename() || `${Date.now()}.download`);
  const output = path.join(spaceDir, filename);
  await download.saveAs(output);
  await fsp.chmod(output, 0o600).catch(() => {});
  await invalidateRefs(page);
  logSafe("download", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, filename, risk });
  return { path: output, filename, risk };
}

async function evaluatePage(space, page, params) {
  if (config.allowUnsafeEvaluate) throw new BridgeError("UNSAFE_EVALUATE_DISABLED_IN_MVP", "unsafe JavaScript evaluation is intentionally not enabled");
  const operation = String(params.operation || params.op || "");
  if (!(permissions.evaluateAllowlist || []).includes(operation)) throw new BridgeError("EVALUATE_NOT_ALLOWED", `evaluate operation '${operation}' is not in the safe allowlist`);
  let result;
  if (operation === "documentMeta") result = { title: await page.title(), url: page.url() };
  else if (operation === "getText") result = await getTextPage(space, page, params);
  else if (operation === "count") result = { count: await page.locator(String(params.selector || "body")).count() };
  else if (operation === "getAttribute") {
    const allowed = new Set(["aria-label", "role", "title", "name", "type", "placeholder", "disabled"]);
    if (!allowed.has(params.name)) throw new BridgeError("EVALUATE_NOT_ALLOWED", `attribute '${params.name}' is not allowed`);
    const locator = await locatorForRef(page, params.ref);
    result = { value: await locator.getAttribute(params.name) };
  } else if (operation === "scrollIntoView") {
    const locator = await locatorForRef(page, params.ref);
    await locator.scrollIntoViewIfNeeded({ timeout: config.actionTimeoutMs });
    result = { ok: true };
  }
  logSafe("evaluate_safe", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId, operation });
  return result;
}

async function markSessionInvalid(space, params = {}) {
  space.status = "waiting-user";
  space.task = "session-invalid: waiting for manual login or re-authentication";
  space.lastError = null;
  space.updatedAt = now();
  space.approval = null;
  logSafe("session_invalid_waiting_user", { spaceId: space.id, reason: String(params.reason || "session invalid").slice(0, 120) });
  await persistState();
  return { status: space.status, message: "manual login/2FA/CAPTCHA may be completed in the AI Browser window; no password was requested from the agent" };
}

async function internalOperation(method, space, params, signal) {
  if (signal?.aborted) throw new BridgeError("TIMEOUT", `${method} was cancelled before it started`);
  if (method === "open" || method === "createSpace") {
    const page = await getPage(space, params, true);
    if (params.url && !sameUrl(params.url, page.url())) await navigatePage(space, page, params.url);
    return spaceSummary(space);
  }
  if (method === "newTab") {
    await createPageInWindow(space.id, params.url || "about:blank");
    return spaceSummary(space);
  }
  if (method === "stop") return await stopSpace(space, params);
  if (method === "takeover") {
    const page = await getPage(space, params, true);
    space.humanControlled = true;
    space.status = "waiting-user";
    await page.bringToFront().catch(() => {});
    logSafe("takeover", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId });
    return { status: space.status, message: "human takeover enabled; agent actions are paused" };
  }
  if (method === "watch") {
    const page = await getPage(space, params, true);
    await page.bringToFront().catch(() => {});
    logSafe("watch", { spaceId: space.id, pageId: pageMeta.get(page)?.pageId });
    return { status: space.status, pageId: pageMeta.get(page)?.pageId, url: page.url(), message: "AI Browser window brought forward for observation" };
  }
  if (method === "release") {
    space.humanControlled = false;
    space.status = "idle";
    space.task = null;
    space.approval = null;
    space.lastError = null;
    logSafe("release", { spaceId: space.id });
    return spaceSummary(space);
  }
  if (method === "confirm") {
    if ((params.agent || params.caller) !== "operator") throw new BridgeError("OPERATOR_REQUIRED", "only the local operator may confirm a high-risk action");
    if (!space.approval) throw new BridgeError("NO_PENDING_APPROVAL", `space '${space.id}' has no pending high-risk action`);
    space.approval.approvedOnce = true;
    space.status = "idle";
    space.task = null;
    logSafe("human_confirmed_once", { spaceId: space.id, approvalId: space.approval.id });
    return { confirmed: true, approvalId: space.approval.id, nextHighRiskAction: "one action only" };
  }
  if (method === "sessionInvalid") return markSessionInvalid(space, params);

  const page = await getPage(space, params, true);
  if (method === "navigate") return await navigatePage(space, page, params.url, params);
  if (method === "snapshot") return await snapshotPage(space, page);
  if (method === "click") return await clickPage(space, page, params);
  if (method === "fill") return await fillPage(space, page, params);
  if (method === "type") return await typePage(space, page, params);
  if (method === "select") return await selectPage(space, page, params);
  if (method === "scroll") return await scrollPage(space, page, params);
  if (method === "wait") return await waitPage(space, page, params, signal);
  if (method === "getText") return await getTextPage(space, page, params);
  if (method === "getTitle") return await getTitlePage(space, page);
  if (method === "getUrl") return { url: page.url() };
  if (method === "screenshot" || method === "capture") return await screenshotPage(space, page, params);
  if (method === "upload") return await uploadPage(space, page, params);
  if (method === "download") return await downloadPage(space, page, params);
  if (method === "evaluate") return await evaluatePage(space, page, params);
  throw new BridgeError("UNKNOWN_METHOD", `unknown bridge method '${method}'`);
}

async function runBatch(space, params, signal) {
  if (!Array.isArray(params.steps) || params.steps.length === 0) throw new BridgeError("INVALID_BATCH", "batch requires a non-empty steps array");
  if (params.steps.length > 40) throw new BridgeError("BATCH_TOO_LARGE", "batch is limited to 40 steps");
  const deadline = Date.now() + Math.max(100, Math.min(Number(params.timeoutMs || config.batchTimeoutMs), Number(config.batchTimeoutMs)));
  const results = [];
  for (const [index, step] of params.steps.entries()) {
    const method = String(step?.method || step?.op || "");
    if (!BATCH_METHODS.has(method)) throw new BridgeError("BATCH_METHOD_NOT_ALLOWED", `batch step ${index + 1} '${method}' is not allowed`);
    const remaining = deadline - Date.now();
    if (signal?.aborted || remaining <= 0) throw new BridgeError("TIMEOUT", `batch timed out before step ${index + 1} (${method})`, { step: index + 1, method });
    try {
      const requestedStepTimeout = Number(step.timeoutMs || remaining);
      const result = await internalOperation(method, space, {
        ...step,
        space: space.id,
        timeoutMs: Math.max(1, Math.min(requestedStepTimeout, remaining))
      }, signal);
      results.push({ step: index + 1, method, result });
    } catch (error) {
      if (error instanceof BridgeError && error.details?.step) throw error;
      throw new BridgeError(
        error.code || "BATCH_STEP_FAILED",
        `batch step ${index + 1} (${method}) failed: ${redact(error.message || String(error))}`,
        { ...(error.details || {}), step: index + 1, method }
      );
    }
  }
  logSafe("batch_complete", { spaceId: space.id, steps: params.steps.length });
  return { results };
}

async function withSpaceAction(space, params, fn, method) {
  assertCaller(space, params, method);
  if (space.lock) throw new BridgeError("SPACE_BUSY", `space '${space.id}' is already locked by another task`, { lock: { method: space.lock.method, startedAt: space.lock.startedAt } });
  const active = activeSpaceCount();
  if (space.status === "idle" && active >= Number(config.maxConcurrentSpaces || 3)) {
    throw new BridgeError("CONCURRENCY_LIMIT", `maximum concurrent spaces (${config.maxConcurrentSpaces}) is active`);
  }
  const lockId = randomId("lock");
  space.lock = { id: lockId, method, startedAt: now() };
  space.status = "running";
  space.task = taskLabel(params.task, method);
  space.updatedAt = now();
  const controller = new AbortController();
  const timeoutMs = Math.max(100, Number(params.timeoutMs || (method === "batch" ? config.batchTimeoutMs : config.actionTimeoutMs)));
  let timeoutHandle;
  const operation = Promise.resolve().then(() => fn(controller.signal));
  try {
    const result = await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new BridgeError("TIMEOUT", `${method} exceeded its timeout`));
        }, timeoutMs);
      })
    ]);
    if (space.status === "running" && !space.humanControlled && !space.approval) {
      space.status = "idle";
      space.task = null;
    }
    space.lastError = null;
    if (result && typeof result === "object" && result.id === space.id) {
      result.status = space.status;
      result.task = space.task;
      result.lastError = space.lastError;
    }
    return result;
  } catch (error) {
    const safeError = error instanceof BridgeError ? error : new BridgeError("BROWSER_ERROR", redact(error.message || String(error)));
    if (safeError.code === "TIMEOUT") {
      controller.abort();
      if ((space.lastKnownPages || []).length) space.restorablePages = [...space.lastKnownPages];
      const activePage = space.pages.find((page) => pageMeta.get(page)?.pageId === space.activePageId && !page.isClosed());
      if (activePage) await activePage.close().catch(() => {});
      await Promise.race([
        operation.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000))
      ]);
    }
    space.lastError = safeError.message;
    if (safeError.code === "CONFIRMATION_REQUIRED" || safeError.code === "KEYRING_LOCKED" || safeError.code === "CREDENTIAL_NOT_FOUND" || safeError.code === "SESSION_INVALID") space.status = "waiting-user";
    else if (space.status !== "stopped") space.status = "failed";
    logSafe("operation_error", { spaceId: space.id, method, code: safeError.code, message: safeError.message });
    throw safeError;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (space.lock?.id === lockId) space.lock = null;
    space.updatedAt = now();
    await persistState().catch(() => {});
  }
}

async function stopSpace(space, params = {}) {
  for (const page of [...space.pages]) await page.close().catch(() => {});
  space.pages = [];
  space.activePageId = null;
  space.restorablePages = [];
  space.lastKnownPages = [];
  space.status = "stopped";
  space.task = null;
  space.humanControlled = false;
  space.approval = null;
  space.lastError = null;
  space.updatedAt = now();
  logSafe("space_stopped", { spaceId: space.id });
  await persistState();
  return spaceSummary(space);
}

async function freezeIdlePages() {
  if (!context || !config.idleFreezeMs) return;
  const cutoff = Date.now() - Number(config.idleFreezeMs);
  for (const space of spaces.values()) {
    const active = space.activePageId;
    for (const page of space.pages) {
      const meta = pageMeta.get(page);
      const activeInUse = meta?.pageId === active && (space.status !== "idle" || space.humanControlled);
      if (!meta || page.isClosed() || activeInUse || meta.frozen || meta.lastUsedAt > cutoff) continue;
      try {
        const session = await context.newCDPSession(page);
        await session.send("Page.setWebLifecycleState", { state: "frozen" });
        await session.detach();
        meta.frozen = true;
        logSafe("page_frozen", { spaceId: space.id, pageId: meta.pageId });
      } catch {}
    }
  }
}

async function doctorResult() {
  const keyring = await secretServiceDoctor();
  let chromeVersion = null;
  if (context) {
    try { chromeVersion = context.browser()?.version() || null; } catch { chromeVersion = null; }
  }
  return {
    version: VERSION,
    node: process.version,
    chromeBinary: config.chromeBinary,
    chromeBinaryExists: fs.existsSync(config.chromeBinary),
    chromeVersion,
    profileDir: path.resolve(config.profileDir),
    profileDistinctFromDailyChrome: true,
    socket: SOCKET_PATH,
    socketMode: fs.existsSync(SOCKET_PATH) ? (await fsp.stat(SOCKET_PATH)).mode & 0o777 : null,
    mode: browserMode,
    cdpPort,
    sandbox: "enabled (no --no-sandbox)",
    maxConcurrentSpaces: config.maxConcurrentSpaces,
    maxPagesPerSpace: config.maxPagesPerSpace,
    keyring,
    configFiles: { CONFIG_FILE, PERMISSIONS_FILE, SITES_FILE, AGENTS_FILE },
    dataDirs: { profile: PROFILE_DIR, spaces: SPACES_DIR, sessions: SESSIONS_DIR, downloads: DOWNLOADS_DIR, screenshots: SCREENSHOTS_DIR, logs: LOGS_DIR, state: STATE_DIR }
  };
}

async function dispatch(method, params = {}) {
  await loadConfiguration();
  if (method === "health") return { ok: true, version: VERSION, pid: process.pid, mode: browserMode, socket: SOCKET_PATH, browserReady: Boolean(context) };
  if (method === "doctor") return await doctorResult();
  if (method === "status") {
    return { ...await doctorResult(), spaces: [...spaces.values()].map(spaceSummary) };
  }
  if (method === "listSpaces" || method === "spaces") return { spaces: [...spaces.values()].map(spaceSummary) };
  if (method === "stopAll") {
    stopping = true;
    for (const space of spaces.values()) await stopSpace(space, params);
    setTimeout(() => { void shutdown().finally(() => process.exit(0)); }, 50).unref();
    return { stopped: true };
  }
  const id = String(params.space || params.spaceId || "");
  if (!id) throw new BridgeError("MISSING_SPACE", `${method} requires space`);
  const space = getOrCreateSpace(id);
  if (["open", "createSpace", "newTab", "stop", "watch", "takeover", "release", "confirm", "sessionInvalid", "navigate", "snapshot", "click", "fill", "type", "select", "scroll", "wait", "getText", "getTitle", "getUrl", "screenshot", "capture", "upload", "download", "evaluate", "batch"].includes(method)) {
    if (method === "batch") {
      return await withSpaceAction(space, params, (signal) => runBatch(space, params, signal), method);
    }
    return await withSpaceAction(space, params, (signal) => internalOperation(method, space, params, signal), method);
  }
  throw new BridgeError("UNKNOWN_METHOD", `unknown bridge method '${method}'`);
}

async function readRequestBody(request) {
  return await new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) request.destroy(new BridgeError("REQUEST_TOO_LARGE", "request body exceeds 4 MiB"));
    });
    request.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new BridgeError("INVALID_JSON", "request body is not valid JSON")); }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function handleHttp(request, response) {
  if (request.method !== "POST" || request.url !== "/rpc") {
    if (request.method === "GET" && request.url === "/health") return sendJson(response, 200, { ok: true, version: VERSION, pid: process.pid, mode: browserMode, browserReady: Boolean(context) });
    return sendJson(response, 404, { error: { code: "NOT_FOUND", message: "use POST /rpc" } });
  }
  try {
    const payload = await readRequestBody(request);
    const result = await dispatch(payload.method, payload.params || {});
    sendJson(response, 200, { result });
  } catch (error) {
    const safeError = error instanceof BridgeError ? error : new BridgeError("INTERNAL_ERROR", redact(error?.message || String(error)));
    sendJson(response, 400, { error: { code: safeError.code || "ERROR", message: safeError.message, details: redact(safeError.details || {}) } });
  }
}

async function startServer() {
  await ensureBaseDirs();
  await fsp.rm(SOCKET_PATH, { force: true }).catch(() => {});
  server = http.createServer((request, response) => { void handleHttp(request, response); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => { server.off("error", reject); resolve(); });
  });
  try { await fsp.chmod(SOCKET_PATH, 0o600); } catch {}
  await writeBridgeState();
  freezeTimer = setInterval(() => { void freezeIdlePages(); }, 60000);
  freezeTimer.unref();
}

async function cleanupAtomicTemps() {
  for (const directory of [SPACES_DIR, SESSIONS_DIR, STATE_DIR]) {
    let entries = [];
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { continue; }
    await Promise.all(entries
      .filter((entry) => entry.isFile() && /\.tmp-\d+-[a-f0-9]+$/i.test(entry.name))
      .map((entry) => fsp.rm(path.join(directory, entry.name), { force: true }).catch(() => {})));
  }
}

async function bridgePidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const command = await fsp.readFile(`/proc/${pid}/cmdline`, "utf8");
    return command.includes(path.join(APP_DIR, "bridge.mjs"));
  } catch { return false; }
}

async function acquireStartLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.mkdir(START_LOCK_DIR, { mode: 0o700 });
      await fsp.writeFile(path.join(START_LOCK_DIR, "pid"), `${process.pid}\n`, { mode: 0o600 });
      ownsStartLock = true;
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let ownerPid = 0;
      let ageMs = 0;
      try { ownerPid = Number((await fsp.readFile(path.join(START_LOCK_DIR, "pid"), "utf8")).trim()); } catch {}
      try { ageMs = Date.now() - (await fsp.stat(START_LOCK_DIR)).mtimeMs; } catch {}
      if (await bridgePidIsAlive(ownerPid) || ageMs < 30000) {
        throw new BridgeError("BRIDGE_ALREADY_RUNNING", "another AI Browser bridge is running or starting");
      }
      await fsp.rm(START_LOCK_DIR, { recursive: true, force: true });
    }
  }
  throw new BridgeError("BRIDGE_LOCK_FAILED", "could not acquire the AI Browser startup lock");
}

async function releaseStartLock() {
  if (!ownsStartLock) return;
  ownsStartLock = false;
  await fsp.rm(START_LOCK_DIR, { recursive: true, force: true }).catch(() => {});
}

async function shutdown() {
  if (freezeTimer) clearInterval(freezeTimer);
  await persistState().catch(() => {});
  const contextToClose = context;
  context = null;
  if (contextToClose) await Promise.race([
    contextToClose.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (server) await Promise.race([
    new Promise((resolve) => server.close(() => resolve())),
    new Promise((resolve) => setTimeout(resolve, 1000))
  ]);
  await fsp.rm(SOCKET_PATH, { force: true }).catch(() => {});
  await fsp.rm(BRIDGE_PID_FILE, { force: true }).catch(() => {});
  await fsp.rm(BRIDGE_STATE_FILE, { force: true }).catch(() => {});
  await releaseStartLock();
}

async function main() {
  process.umask(0o077);
  const args = parseArgs(process.argv.slice(2));
  if (!args.daemon) {
    process.stderr.write("ai-browser bridge must be started with --daemon\n");
    process.exitCode = 2;
    return;
  }
  await ensureBaseDirs();
  await acquireStartLock();
  await cleanupAtomicTemps();
  await loadConfiguration();
  if (args.cdpPort) config.cdpPort = args.cdpPort;
  if (args.headless) config.mode = "headless";
  await loadState();
  await startServer();
  await ensureBrowser();
  process.on("SIGTERM", () => { stopping = true; void shutdown().finally(() => process.exit(0)); });
  process.on("SIGINT", () => { stopping = true; void shutdown().finally(() => process.exit(0)); });
  process.on("uncaughtException", (error) => logSafe("uncaught_exception", { message: error.message }));
  process.on("unhandledRejection", (error) => logSafe("unhandled_rejection", { message: error?.message || String(error) }));
}

if (import.meta.url === `file://${process.argv[1]}`) void main().catch(async (error) => {
  await releaseStartLock();
  process.stderr.write(`${redact(error?.stack || error?.message || String(error))}\n`);
  process.exitCode = 1;
});

export { dispatch, shutdown };
