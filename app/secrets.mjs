import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = path.join(APP_DIR, "pyvenv", "bin", "python");
const HELPER = path.join(APP_DIR, "secret_service.py");
const SECRET_ENV = /(PASSWORD|TOKEN|SECRET|API[_-]?KEY|AUTH|COOKIE|CREDENTIAL)/i;

function safeEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SECRET_ENV.test(name))
  );
}

function helperError(message, code = "KEYRING_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function callHelper(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [HELPER], {
      cwd: APP_DIR,
      env: safeEnvironment(),
      stdio: ["pipe", "pipe", "ignore"]
    });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(reject, helperError("GNOME Secret Service helper timed out", "KEYRING_TIMEOUT"));
    }, 20000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("error", (error) => finish(reject, helperError("GNOME Secret Service helper failed", error.code || "KEYRING_ERROR")));
    child.on("close", (code) => {
      if (settled) return;
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch {
        finish(reject, helperError("GNOME Secret Service returned an invalid response"));
        return;
      }
      if (!result?.ok) {
        finish(reject, helperError(result?.error || "GNOME Secret Service operation failed", result?.code));
        return;
      }
      if (code !== 0) {
        finish(reject, helperError("GNOME Secret Service helper failed"));
        return;
      }
      finish(resolve, result);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export async function lookupSecret(credentialId) {
  const result = await callHelper({ op: "lookup", credentialId });
  return result.secret;
}

export async function storeSecret(credentialId, value, label = credentialId, host = "") {
  if (!credentialId || !value) throw helperError("credential id and secret are required", "INVALID_REQUEST");
  return await callHelper({ op: "store", credentialId, value, label, host });
}

export async function deleteSecret(credentialId) {
  return await callHelper({ op: "delete", credentialId });
}

export async function secretServiceDoctor() {
  try {
    return await callHelper({ op: "doctor" });
  } catch (error) {
    return { available: false, backend: "org.freedesktop.secrets", error: error.message, code: error.code };
  }
}
