#!/usr/bin/env node

import readline from "node:readline";
import path from "node:path";
import { spawn } from "node:child_process";
import { APP_DIR, request, redact, waitForBridge } from "./common.mjs";

const CLI = path.join(APP_DIR, "cli.mjs");

const tools = [
  ["browser_list_spaces", "List AI Browser Spaces and their sanitized status.", { type: "object", properties: {} }],
  ["browser_status", "Return bridge health, safety policy, and Space state.", { type: "object", properties: {} }],
  ["browser_open", "Open or resume a Space. DeepSeek Harness must use deepseek.", { type: "object", required: ["space"], properties: { space: { type: "string" }, url: { type: "string" } } }],
  ["browser_new_tab", "Open a new tab in the one shared AI Browser window; the tab remains owned by this Space.", { type: "object", required: ["space"], properties: { space: { type: "string" }, url: { type: "string" } } }],
  ["browser_navigate", "Navigate one Space through the configured host policy.", { type: "object", required: ["space", "url"], properties: { space: { type: "string" }, url: { type: "string" } } }],
  ["browser_snapshot", "Return a compact Accessibility Tree and interactive refs.", { type: "object", required: ["space"], properties: { space: { type: "string" }, pageId: { type: "string" } } }],
  ["browser_click", "Click an element ref. HIGH-risk final actions stop for human confirmation.", { type: "object", required: ["space", "ref"], properties: { space: { type: "string" }, ref: { type: "string" }, risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] } } }],
  ["browser_fill", "Fill a non-sensitive field or use a configured credentialRef. Never send raw passwords/tokens.", { type: "object", required: ["space", "ref"], properties: { space: { type: "string" }, ref: { type: "string" }, value: { type: "string" }, credentialRef: { type: "string" }, risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] } } }],
  ["browser_type", "Type into a non-sensitive element ref.", { type: "object", required: ["space", "ref", "text"], properties: { space: { type: "string" }, ref: { type: "string" }, text: { type: "string" } } }],
  ["browser_select", "Select an option by ref.", { type: "object", required: ["space", "ref", "value"], properties: { space: { type: "string" }, ref: { type: "string" }, value: { type: "string" } } }],
  ["browser_scroll", "Scroll or bring an element into view.", { type: "object", required: ["space"], properties: { space: { type: "string" }, ref: { type: "string" }, amount: { type: "number" } } }],
  ["browser_wait", "Wait for a URL, text, load state, or bounded milliseconds.", { type: "object", required: ["space"], properties: { space: { type: "string" }, url: { type: "string" }, text: { type: "string" }, state: { type: "string" }, timeoutMs: { type: "number" } } }],
  ["browser_get_text", "Read bounded page/element text; output is sanitized and never logged.", { type: "object", required: ["space"], properties: { space: { type: "string" }, ref: { type: "string" }, selector: { type: "string" } } }],
  ["browser_get_title", "Get the current page title.", { type: "object", required: ["space"], properties: { space: { type: "string" } } }],
  ["browser_get_url", "Get the current page URL.", { type: "object", required: ["space"], properties: { space: { type: "string" } } }],
  ["browser_screenshot", "Capture a masked screenshot below the AI Browser screenshot directory.", { type: "object", required: ["space"], properties: { space: { type: "string" }, filename: { type: "string" }, fullPage: { type: "boolean" } } }],
  ["browser_batch", "Run a bounded declarative batch. No arbitrary JS, filesystem, or subprocess APIs are exposed.", { type: "object", required: ["space", "steps"], properties: { space: { type: "string" }, steps: { type: "array", maxItems: 40, items: { type: "object" } }, timeoutMs: { type: "number" } } }],
  ["browser_takeover", "Pause one Space for human takeover.", { type: "object", required: ["space"], properties: { space: { type: "string" } } }],
  ["browser_release", "Release human takeover for one Space.", { type: "object", required: ["space"], properties: { space: { type: "string" } } }],
  ["browser_stop_space", "Stop and close one Space's pages without touching daily Chrome.", { type: "object", required: ["space"], properties: { space: { type: "string" } } }]
];

const mapping = {
  browser_list_spaces: "listSpaces",
  browser_status: "status",
  browser_open: "open",
  browser_new_tab: "newTab",
  browser_navigate: "navigate",
  browser_snapshot: "snapshot",
  browser_click: "click",
  browser_fill: "fill",
  browser_type: "type",
  browser_select: "select",
  browser_scroll: "scroll",
  browser_wait: "wait",
  browser_get_text: "getText",
  browser_get_title: "getTitle",
  browser_get_url: "getUrl",
  browser_screenshot: "screenshot",
  browser_batch: "batch",
  browser_takeover: "takeover",
  browser_release: "release",
  browser_stop_space: "stop"
};

async function ensureBridge() {
  try { await waitForBridge(800); return; } catch {}
  const child = spawn(process.execPath, [CLI, "start"], { stdio: "ignore", detached: true, env: process.env });
  child.unref();
  await waitForBridge(20000);
}

function toolSchema(name, description, inputSchema) {
  return { name, description, inputSchema };
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message: redact(message) } };
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    return response(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "ai-browser-bridge", version: "0.1.0" },
      instructions: "Operator directive: use this trusted local AI Browser for all web viewing and interaction. Stay in the assigned Agent Space, use fresh Accessibility Snapshot refs, never use daily Chrome or desktop input, and stop for login, HIGH-risk confirmation, or human takeover."
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "ping") return response(id, {});
  if (method === "tools/list") return response(id, { tools: tools.map((item) => toolSchema(...item)) });
  if (method !== "tools/call") return errorResponse(id, -32601, `method '${method}' is not supported`);
  const toolName = params.name;
  if (!mapping[toolName]) return errorResponse(id, -32602, `unknown tool '${toolName}'`);
  await ensureBridge();
  try {
    const callParams = { ...(params.arguments || {}) };
    if (callParams.space) {
      const assignedAgent = process.env.AI_BROWSER_AGENT || callParams.agent || (callParams.space === "deepseek" ? "deepseek" : "");
      if (!assignedAgent) throw new Error("trusted MCP server requires AI_BROWSER_AGENT=<codex|claude|deepseek|hermes|gemini|opencode>");
      callParams.agent = assignedAgent;
    }
    const result = await request(mapping[toolName], callParams, 40000);
    return response(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
  } catch (error) {
    return response(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ code: error.code || "ERROR", message: redact(error.message), details: redact(error.details || {}) }, null, 2) }] });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  void (async () => {
    let message;
    try { message = JSON.parse(line); }
    catch { process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, "invalid JSON"))}\n`); return; }
    const result = await handle(message).catch((error) => errorResponse(message.id ?? null, -32000, error.message));
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  })();
});
