#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  AGENTS_FILE,
  APP_DIR,
  BRIDGE_PID_FILE,
  CONFIG_DIR,
  DATA_DIR,
  DEFAULT_AGENTS,
  DEFAULT_CONFIG,
  DEFAULT_PERMISSIONS,
  DEFAULT_SITES,
  EVENTS_LOG_FILE,
  LOGS_DIR,
  PERMISSIONS_FILE,
  RUNTIME_DIR,
  SCREENSHOTS_DIR,
  SITES_FILE,
  SOCKET_PATH,
  UPLOADS_DIR,
  ensureBaseDirs,
  printJson,
  readJson,
  redact,
  request,
  waitForBridge,
  writeJsonAtomic
} from "./common.mjs";
import { secretServiceDoctor, storeSecret } from "./secrets.mjs";

const BRIDGE = path.join(APP_DIR, "bridge.mjs");
const MCP = path.join(APP_DIR, "mcp.mjs");
const BACKUP = path.join(APP_DIR, "backup.sh");
const RESTORE = path.join(APP_DIR, "restore.sh");
const SERVICE_NAME = "ai-browser.service";

const HELP = `ai-browser — persistent AI-agent Chromium bridge

Usage:
  ai-browser start [--headed|--headless] [--foreground]
  ai-browser stop
  ai-browser status
  ai-browser spaces
  ai-browser open <space> [url]
  ai-browser tab <space> [url]
  ai-browser headless <space> [url]
  ai-browser watch <space>
  ai-browser takeover <space>
  ai-browser release <space>
  ai-browser logs [space]
  ai-browser doctor
  ai-browser service enable|disable|status
  ai-browser confirm <space>
  ai-browser session-invalid <space> [reason]
  ai-browser snapshot <space>
  ai-browser navigate <space> <url>
  ai-browser screenshot <space> [filename]
  ai-browser batch <space> --file <json-file>
  ai-browser credential set <id> --host <host> [--label <label>]
  ai-browser credential doctor
  ai-browser backup --output <file>.gpg
  ai-browser restore <file>.gpg
  ai-browser mcp

The daemon uses a Unix socket and a separate Chrome profile under:
  ${DATA_DIR}
Sensitive values are never accepted in JSON configuration or operation logs.
`;

function hasHelp(args) { return args.includes("--help") || args.includes("-h"); }

function commandHelp(command) {
  const help = {
    start: "Usage: ai-browser start [--headed|--headless] [--foreground]\nStarts the isolated persistent Chrome and local bridge.",
    stop: "Usage: ai-browser stop\nStops the bridge, AI Browser Chrome process, and all AI Browser pages only.",
    status: "Usage: ai-browser status\nShows bridge health, policy, and Space state.",
    spaces: "Usage: ai-browser spaces\nLists stable Space IDs, pages, status, and task metadata.",
    open: "Usage: ai-browser open <space> [url]\nOpens or resumes one Space. Valid IDs: codex, claude, deepseek, hermes, gemini, opencode.",
    tab: "Usage: ai-browser tab <space> [url]\nOpens a new tab in the one shared AI Browser window, owned by the selected Space.",
    headless: "Usage: ai-browser headless <space> [url]\nStarts a headless daemon when none is running, or creates a background Space in the current daemon.",
    watch: "Usage: ai-browser watch <space>\nBrings one AI Browser window to the front for observation; it does not grant agent control.",
    takeover: "Usage: ai-browser takeover <space>\nPauses agent actions and gives the user control of one Space.",
    release: "Usage: ai-browser release <space>\nReleases human takeover and returns the Space to agent automation.",
    logs: "Usage: ai-browser logs [space]\nPrints sanitized operation events; values and secrets are omitted/redacted.",
    doctor: "Usage: ai-browser doctor\nChecks Chrome path, isolated profile, Unix socket, sandbox flag, and Secret Service.",
    service: "Usage: ai-browser service enable|disable|status\nManages the resource-limited systemd user service for continuous headed operation.",
    confirm: "Usage: ai-browser confirm <space>\nApproves exactly one pending HIGH-risk action in a Space.",
    snapshot: "Usage: ai-browser snapshot <space>\nReturns a compact Accessibility Tree and interactive element refs.",
    navigate: "Usage: ai-browser navigate <space> <url>\nNavigates through the bridge policy.",
    screenshot: "Usage: ai-browser screenshot <space> [filename]\nWrites a masked screenshot below screenshots/<space>/.",
    batch: "Usage: ai-browser batch <space> --file <json-file>\nRuns a bounded declarative batch; arbitrary JavaScript, filesystem, and subprocess APIs are unavailable.",
    credential: "Usage: ai-browser credential set <id> --host <host> [--label <label>]\nStores a secret in GNOME Keyring without putting its value in args, files, logs, or model context.",
    backup: "Usage: ai-browser backup --output <file>.gpg\nCreates an encrypted archive of the AI Browser data/config (not the Keyring contents).",
    restore: "Usage: ai-browser restore <file>.gpg\nRestores an encrypted archive after the bridge is stopped; existing paths are not overwritten without confirmation.",
    mcp: "Usage: ai-browser mcp\nRuns the trusted local stdio MCP server. Add this exact local command to an Agent only.",
  };
  return help[command] || HELP;
}

function printHelp(command) { process.stdout.write(`${commandHelp(command)}\n`); }

async function bridgeIsRunning() {
  try { await request("health", {}, 800); return true; } catch { return false; }
}

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:.*_)?(?:API[_-]?KEY|TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE)$/i.test(key)) delete env[key];
  }
  return env;
}

async function systemctlUser(args, allowFailure = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn("systemctl", ["--user", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizedEnv()
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 || allowFailure) resolve({ code: code ?? 1, stdout, stderr });
      else reject(new Error(redact(stderr.trim() || `systemctl exited with ${code}`)));
    });
  });
}

async function serviceEnabled() {
  return (await systemctlUser(["is-enabled", SERVICE_NAME], true)).code === 0;
}

async function startDaemon(headless = false, foreground = false) {
  await ensureBaseDirs();
  if (await bridgeIsRunning()) return { alreadyRunning: true, ...(await request("health")) };
  if (!headless && !foreground && await serviceEnabled()) {
    await systemctlUser(["start", SERVICE_NAME]);
    let health = await waitForBridge(20000);
    const browserDeadline = Date.now() + 20000;
    while (!health.browserReady && Date.now() < browserDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { health = await request("health", {}, 1000); } catch {}
    }
    if (!health.browserReady) throw new Error("AI Browser service started but Chromium was not ready within 20 seconds");
    return { started: true, managedBy: "systemd-user", ...health };
  }
  const args = [BRIDGE, "--daemon", headless ? "--headless" : "--headed"];
  const child = spawn(process.execPath, args, {
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    env: sanitizedEnv()
  });
  if (!foreground) child.unref();
  let health = await waitForBridge(20000);
  const browserDeadline = Date.now() + 20000;
  while (!health.browserReady && Date.now() < browserDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { health = await request("health", {}, 1000); } catch {}
  }
  if (!health.browserReady) throw new Error("AI Browser bridge started but Chromium was not ready within 20 seconds");
  return { started: true, ...health };
}

async function manageService(subcommand) {
  if (subcommand === "enable") {
    await stopDaemon();
    await systemctlUser(["daemon-reload"]);
    await systemctlUser(["enable", "--now", SERVICE_NAME]);
    let health = await waitForBridge(20000);
    const browserDeadline = Date.now() + 20000;
    while (!health.browserReady && Date.now() < browserDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { health = await request("health", {}, 1000); } catch {}
    }
    if (!health.browserReady) throw new Error("AI Browser service started but Chromium was not ready within 20 seconds");
    return { enabled: true, active: true, managedBy: "systemd-user", ...health };
  }
  if (subcommand === "disable") {
    await stopDaemon();
    await systemctlUser(["disable", "--now", SERVICE_NAME]);
    return { enabled: false, active: false };
  }
  if (subcommand === "status") {
    const enabled = await serviceEnabled();
    const active = (await systemctlUser(["is-active", SERVICE_NAME], true)).code === 0;
    return { enabled, active, bridgeRunning: await bridgeIsRunning() };
  }
  throw new Error("service subcommand must be enable, disable, or status");
}

async function stopDaemon() {
  if (!(await bridgeIsRunning())) {
    await fsp.rm(SOCKET_PATH, { force: true }).catch(() => {});
    await fsp.rm(BRIDGE_PID_FILE, { force: true }).catch(() => {});
    return { stopped: false, message: "bridge was not running" };
  }
  const result = await request("stopAll", {}, 30000);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && await bridgeIsRunning()) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return result;
}

async function tailFile(file, lines = 160) {
  try {
    const content = await fsp.readFile(file, "utf8");
    const tail = content.split("\n").filter(Boolean).slice(-lines).join("\n");
    process.stdout.write(`${redact(tail)}${tail ? "\n" : ""}`);
  } catch (error) {
    if (error.code === "ENOENT") process.stdout.write("(no log yet)\n");
    else throw error;
  }
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readSecretPrompt(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("credential set requires an interactive terminal");
  process.stderr.write(prompt);
  return await new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\n" || char === "\r") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          reject(new Error("credential entry cancelled"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function credentialSet(args) {
  const id = args[0];
  const host = optionValue(args, "--host");
  const label = optionValue(args, "--label") || id;
  if (!id || !host) throw new Error("credential set requires <id> and --host <host>");
  let value = await readSecretPrompt(`Secret for ${id} (input hidden): `);
  await storeSecret(id, value, label, host);
  value = "";
  const current = await readJson(SITES_FILE, DEFAULT_SITES);
  const next = {
    ...DEFAULT_SITES,
    ...current,
    credentials: { ...(current.credentials || {}), entries: [...(current.credentials?.entries || []).filter((entry) => entry.id !== id), { id, hosts: [host], label }] }
  };
  await writeJsonAtomic(SITES_FILE, next, 0o600);
  process.stdout.write(`Stored credentialRef '${id}' in GNOME Keyring; value was not written to disk or logs.\n`);
}

async function runScript(script, args) {
  await new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args], { stdio: "inherit", env: sanitizedEnv() });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(script)} failed (${code ?? signal})`)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return printHelp();
  const command = args.shift() || "help";
  if (command === "help" || hasHelp(args)) return printHelp(command === "help" ? undefined : command);
  if (command === "start") return printJson(await startDaemon(args.includes("--headless"), args.includes("--foreground")));
  if (command === "stop") return printJson(await stopDaemon());
  if (command === "status") { await startDaemon(false); return printJson(await request("status")); }
  if (command === "spaces") { await startDaemon(false); return printJson(await request("listSpaces")); }
  if (command === "doctor") { await startDaemon(false); return printJson(await request("doctor")); }
  if (command === "service") return printJson(await manageService(args[0]));
  if (command === "open") {
    const space = args[0];
    if (!space) throw new Error("open requires a space");
    await startDaemon(false);
    return printJson(await request("open", { space, url: args[1], agent: "operator" }));
  }
  if (command === "tab") {
    const space = args[0];
    if (!space) throw new Error("tab requires a space");
    await startDaemon(false);
    return printJson(await request("newTab", { space, url: args[1], agent: "operator" }));
  }
  if (command === "headless") {
    const space = args[0];
    if (!space) throw new Error("headless requires a space");
    const running = await bridgeIsRunning();
    await startDaemon(!running);
    return printJson(await request("open", { space, url: args[1], agent: "operator", background: true }));
  }
  if (["watch", "takeover", "release", "confirm"].includes(command)) {
    const space = args[0];
    if (!space) throw new Error(`${command} requires a space`);
    await startDaemon(false);
    return printJson(await request(command, { space, agent: "operator" }));
  }
  if (command === "session-invalid") {
    const space = args[0];
    if (!space) throw new Error("session-invalid requires a space");
    await startDaemon(false);
    return printJson(await request("sessionInvalid", { space, reason: args.slice(1).join(" ") || "manual test" }));
  }
  if (command === "logs") {
    const space = args[0];
    return await tailFile(space ? path.join(LOGS_DIR, `${space.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`) : EVENTS_LOG_FILE);
  }
  if (command === "snapshot") {
    if (!args[0]) throw new Error("snapshot requires a space");
    await startDaemon(false);
    return printJson(await request("snapshot", { space: args[0], agent: "operator" }));
  }
  if (command === "navigate") {
    if (!args[0] || !args[1]) throw new Error("navigate requires <space> <url>");
    await startDaemon(false);
    return printJson(await request("navigate", { space: args[0], url: args[1], agent: "operator" }));
  }
  if (command === "screenshot") {
    if (!args[0]) throw new Error("screenshot requires a space");
    await startDaemon(false);
    return printJson(await request("screenshot", { space: args[0], filename: args[1], agent: "operator" }));
  }
  if (command === "batch") {
    const space = args[0];
    const file = optionValue(args, "--file");
    if (!space || !file) throw new Error("batch requires <space> --file <json-file>");
    const steps = JSON.parse(await fsp.readFile(path.resolve(file), "utf8"));
    await startDaemon(false);
    return printJson(await request("batch", { space, steps: Array.isArray(steps) ? steps : steps.steps, agent: "operator", timeoutMs: 30000 }));
  }
  if (command === "credential") {
    const sub = args.shift();
    if (sub === "doctor") return printJson(await secretServiceDoctor());
    if (sub === "set") return await credentialSet(args);
    throw new Error("credential subcommand must be set or doctor");
  }
  if (command === "backup") {
    const output = optionValue(args, "--output");
    if (!output) throw new Error("backup requires --output <file>.gpg");
    if (await bridgeIsRunning()) throw new Error("stop the bridge before backup so the profile is consistent");
    return await runScript(BACKUP, [path.resolve(output)]);
  }
  if (command === "restore") {
    if (!args[0]) throw new Error("restore requires an encrypted archive");
    if (await bridgeIsRunning()) throw new Error("stop the bridge before restore");
    return await runScript(RESTORE, [path.resolve(args[0])]);
  }
  if (command === "mcp") {
    const child = spawn(process.execPath, [MCP], { stdio: "inherit", env: sanitizedEnv() });
    child.on("exit", (code) => { process.exitCode = code ?? 1; });
    return;
  }
  throw new Error(`unknown command '${command}'`);
}

main().catch((error) => {
  process.stderr.write(`ai-browser: ${redact(error?.message || String(error))}\n`);
  process.exitCode = 1;
});
