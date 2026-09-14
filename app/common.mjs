import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";

export const HOME = os.homedir();
export const DATA_DIR = process.env.AI_BROWSER_DATA_DIR || path.join(HOME, ".local", "share", "ai-browser");
export const CONFIG_DIR = process.env.AI_BROWSER_CONFIG_DIR || path.join(HOME, ".config", "ai-browser");
export const APP_DIR = path.join(DATA_DIR, "app");
export const PROFILE_DIR = path.join(DATA_DIR, "profile");
export const SPACES_DIR = path.join(DATA_DIR, "spaces");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
export const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
export const STATE_DIR = path.join(DATA_DIR, "state");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const PERMISSIONS_FILE = path.join(CONFIG_DIR, "permissions.json");
export const SITES_FILE = path.join(CONFIG_DIR, "sites.json");
export const AGENTS_FILE = path.join(CONFIG_DIR, "agents.json");
export const SPACES_STATE_FILE = path.join(STATE_DIR, "spaces.json");
export const BRIDGE_STATE_FILE = path.join(STATE_DIR, "bridge.json");
export const BRIDGE_PID_FILE = path.join(STATE_DIR, "bridge.pid");
export const EVENTS_LOG_FILE = path.join(LOGS_DIR, "events.jsonl");

const runtimeBase = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR)
  ? path.join(process.env.XDG_RUNTIME_DIR, "ai-browser")
  : STATE_DIR;
export const RUNTIME_DIR = runtimeBase;
export const SOCKET_PATH = path.join(RUNTIME_DIR, "bridge.sock");

export const DEFAULT_CONFIG = {
  version: 1,
  chromeBinary: "/usr/bin/google-chrome",
  profileDir: PROFILE_DIR,
  mode: "headed",
  startMinimized: true,
  disableGpu: true,
  maxConcurrentSpaces: 3,
  maxPagesPerSpace: 8,
  idleFreezeMs: 10 * 60 * 1000,
  actionTimeoutMs: 15000,
  batchTimeoutMs: 30000,
  pageLoadTimeoutMs: 30000,
  maxSnapshotNodes: 180,
  maxSnapshotInteractive: 120,
  screenshotMaskPasswordFields: true,
  allowUnsafeEvaluate: false,
  credentialBackend: "gnome-keyring-secret-service",
  maxLogBytes: 10 * 1024 * 1024,
  logRotations: 5,
  cdpPort: 0
};

export const DEFAULT_PERMISSIONS = {
  defaultLevel: "LOW",
  mediumRequiresAudit: true,
  highRequiresHuman: true,
  rawSensitiveFillBlocked: true,
  evaluateAllowlist: ["documentMeta", "getText", "getAttribute", "count", "scrollIntoView"]
};

export const DEFAULT_SITES = {
  navigation: {
    mode: "open",
    allowHosts: ["example.com", "www.example.com", "httpbin.org", "www.httpbin.org", "localhost", "127.0.0.1"]
  },
  credentials: {
    entries: []
  },
  blockedHostKeywords: [
    "bank",
    "wallet",
    "exchange",
    "creditcard",
    "credit-card",
    "password-manager",
    "passwordmanager"
  ],
  blockedHosts: [
    "*.bank",
    "*.bank.*",
    "*.chase.com",
    "*.wellsfargo.com",
    "*.bankofamerica.com",
    "*.citibank.com",
    "*.usbank.com",
    "*.hsbc.*",
    "*.cathaybk.com.tw",
    "*.ctbcbank.com",
    "*.esunbank.com.tw",
    "*.fubon.com",
    "*.taishinbank.com.tw",
    "*.sinopac.com",
    "*.americanexpress.com",
    "*.capitalone.com",
    "*.discover.com",
    "*.1password.com",
    "*.bitwarden.com",
    "*.lastpass.com",
    "*.dashlane.com",
    "*.keepersecurity.com",
    "*.protonpass.com",
    "*.nordpass.com",
    "*.paypal.*",
    "*.stripe.com",
    "*.coinbase.com",
    "*.kraken.com",
    "*.binance.com",
    "*.bybit.com",
    "*.okx.com",
    "*.bitget.com",
    "*.metamask.io",
    "*.ledger.com",
    "*.trezor.io"
  ],
  highRiskHosts: [
    "*.bank",
    "*.bank.*",
    "*.chase.com",
    "*.wellsfargo.com",
    "*.bankofamerica.com",
    "*.citibank.com",
    "*.usbank.com",
    "*.hsbc.*",
    "*.cathaybk.com.tw",
    "*.ctbcbank.com",
    "*.esunbank.com.tw",
    "*.fubon.com",
    "*.taishinbank.com.tw",
    "*.sinopac.com",
    "*.americanexpress.com",
    "*.capitalone.com",
    "*.discover.com",
    "*.1password.com",
    "*.bitwarden.com",
    "*.lastpass.com",
    "*.dashlane.com",
    "*.keepersecurity.com",
    "*.protonpass.com",
    "*.nordpass.com",
    "*.paypal.*",
    "*.stripe.com",
    "*.coinbase.com",
    "*.kraken.com",
    "*.binance.com",
    "*.bybit.com",
    "*.okx.com",
    "*.bitget.com",
    "*.metamask.io",
    "*.ledger.com",
    "*.trezor.io"
  ]
};

export const DEFAULT_AGENTS = {
  spaces: {
    codex: "codex",
    claude: "claude",
    deepseek: "deepseek",
    hermes: "hermes",
    gemini: "gemini",
    opencode: "opencode"
  },
  allowedAgents: ["codex", "claude", "deepseek", "hermes", "gemini", "opencode", "operator"]
};

export async function ensureBaseDirs() {
  const dirs = [
    DATA_DIR, CONFIG_DIR, APP_DIR, PROFILE_DIR, SPACES_DIR, SESSIONS_DIR,
    DOWNLOADS_DIR, SCREENSHOTS_DIR, LOGS_DIR, STATE_DIR, UPLOADS_DIR, RUNTIME_DIR
  ];
  for (const dir of dirs) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(dir, 0o700); } catch {}
  }
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fsp.chmod(temp, mode);
  await fsp.rename(temp, file);
  try { await fsp.chmod(file, mode); } catch {}
}

export function mergeConfig(base, override) {
  return { ...base, ...(override || {}) };
}

export function redact(value, key = "") {
  const sensitiveKey = /(authorization|cookie|set-cookie|password|passwd|passphrase|token|jwt|session|assertion|api[_-]?key|client[_-]?secret|credential|private[_-]?key)/i.test(key);
  if (sensitiveKey) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(/:\/\/([^:/@\s]+):([^@\s]+)@/g, "://$1:[REDACTED]@")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED_API_KEY]")
      .replace(/([?&](?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|jwt|session|sid|assertion|api[_-]?key|key|client[_-]?secret|secret|password|passcode|code|auth)=)[^&#\s]*/gi, "$1[REDACTED]")
      .replace(/(["']?(?:authorization|cookie|set-cookie|password|passwd|passphrase|access[_-]?token|id[_-]?token|refresh[_-]?token|token|jwt|session|assertion|api[_-]?key|client[_-]?secret|secret|credential)["']?\s*[:=]\s*["']?)[^"'\s,;}&]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) result[childKey] = redact(childValue, childKey);
    return result;
  }
  return value;
}

export function safeOrigin(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin;
  } catch {
    return "about:blank";
  }
}

export function safeHost(rawUrl) {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return ""; }
}

export function sanitizePath(value, fallback = "item") {
  const base = path.basename(String(value || fallback)).replace(/[^A-Za-z0-9._-]/g, "_");
  return base.slice(0, 180) || fallback;
}

export function isSubPath(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

export function randomId(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

export async function request(method, params = {}, timeoutMs = 20000) {
  const body = JSON.stringify({ method, params });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new Error(`bridge request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: "/rpc",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data || "{}");
          if (res.statusCode >= 400 || parsed.error) {
            const error = new Error(parsed.error?.message || parsed.message || `bridge returned HTTP ${res.statusCode}`);
            Object.assign(error, parsed.error || {});
            reject(error);
          } else resolve(parsed.result ?? parsed);
        } catch (error) {
          reject(new Error(`invalid bridge response: ${error.message}`));
        }
      });
    });
    req.on("error", (error) => { clearTimeout(timer); reject(error); });
    req.end(body);
  });
}

export async function waitForBridge(timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try { return await request("health", {}, 1000); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 150)); }
  }
  throw lastError || new Error("bridge did not become ready");
}

export async function removeIfSocket(file) {
  try { await fsp.unlink(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
