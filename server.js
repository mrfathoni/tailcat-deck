import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = import.meta.dir, PUBLIC = path.join(ROOT, "public"), DATA = path.join(ROOT, "data", "hosts.json");
const TAILCAT = Bun.which("tailcat") || "tailcat", SSH = Bun.which("ssh") || "ssh";
const CONTROL = `/tmp/tailcat-deck-${process.getuid?.() ?? "user"}`;
const PORT = Number(process.env.PORT) || 4747, HOST = process.env.HOST || "127.0.0.1";
const MAX_COMMAND = 20000, MAX_OUTPUT = 2 * 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};
const SSH_OPTS = ["-oStrictHostKeyChecking=no", "-oUserKnownHostsFile=/dev/null", "-oLogLevel=ERROR", "-oBatchMode=yes", "-oRequestTTY=no", "-oConnectTimeout=10", "-oServerAliveInterval=10", "-oServerAliveCountMax=2"];

mkdirSync(CONTROL, { recursive: true, mode: 0o700 });
mkdirSync(path.dirname(DATA), { recursive: true, mode: 0o700 });

let hosts = [];
try {
  hosts = JSON.parse(readFileSync(DATA, "utf8")).hosts || [];
} catch {}

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const find = (key) => hosts.find((host) => host.key === key);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (error, status = 400) => json({ ok: false, error }, status);
const clean = (value, max = 64) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || min)));

function save() {
  writeFileSync(DATA, JSON.stringify({ version: 1, hosts }, null, 2) + "\n");
  chmodSync(DATA, 0o600);
}

function keyOf(params, lenient = false) {
  const raw = String(params.key || "").trim();
  const key = raw.match(/tc[A-Za-z0-9_-]{40,}/)?.[0] || raw;
  if (!key) throw new ApiError("A tailcat key is required.");
  if (!/^tc[A-Za-z0-9_-]{40,512}$/.test(key)) throw new ApiError(lenient ? "That does not look like a tailcat key. It should start with tc and be at least 40 characters." : "Invalid tailcat key.");
  return key;
}

function userOf(value) {
  const user = String(value || "").trim();
  if (!user) return "";
  if (!/^[A-Za-z_][A-Za-z0-9._-]{0,31}$/.test(user)) throw new ApiError("Invalid ssh user.");
  return user;
}

async function capture(proc, timeout) {
  let timedOut = false, truncated = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeout);
  const read = async (stream) => {
    const decoder = new TextDecoder();
    let text = "";
    try {
      for await (const chunk of stream) {
        if (text.length + chunk.length > MAX_OUTPUT) {
          truncated = true;
          proc.kill("SIGKILL");
          break;
        }
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
    } catch {}
    return text;
  };
  const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
  clearTimeout(timer);
  return { stdout, stderr, code: await proc.exited, timedOut, truncated };
}

const exec = (args, timeout = 15000) => capture(Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }), timeout);

async function parseKey(key) {
  const result = await exec([TAILCAT, "parse", key], 8000);
  if (result.code) throw new Error(clean(result.stderr, 400) || "tailcat parse rejected this key");
  return { serverPublic: JSON.parse(result.stdout).ServerPublic };
}

async function pingHost(key) {
  const checkedAt = Date.now();
  try {
    const result = await exec([TAILCAT, "ping", "--timeout=6s", key], 12000);
    const match = result.stdout.match(/pong in ([\d.]+)ms via (.+)/);
    if (!match) return { state: "offline", error: clean(result.stderr, 400) || "No pong. The server may be down, or the key may have changed.", checkedAt };
    const via = match[2].trim(), derp = /^DERP\(([^)]*)\)/i.exec(via);
    return { state: "online", latencyMs: Math.round(Number(match[1]) * 10) / 10, path: derp ? "derp" : "direct", via: derp ? derp[1] : via, checkedAt };
  } catch (error) {
    return { state: "offline", error: `tailcat is not available: ${error.message}`, checkedAt };
  }
}

function sshArgs(key, command, user) {
  const hash = createHash("sha256").update(`${key}|${user || ""}`).digest("hex").slice(0, 16);
  const args = [SSH, ...SSH_OPTS, "-o", `ProxyCommand=${TAILCAT} ${key} 22`];
  if (process.env.TCD_NO_MULTIPLEX !== "1") args.push("-oControlMaster=auto", `-oControlPath=${path.join(CONTROL, `cm-${hash}`)}`, "-oControlPersist=120");
  args.push(user ? `${user}@${key}` : key, command);
  return args;
}

async function runShell(key, command, user, timeout) {
  const started = Date.now();
  const result = await capture(Bun.spawn(sshArgs(key, command, user), { stdin: "ignore", stdout: "pipe", stderr: "pipe" }), timeout);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, durationMs: Date.now() - started, timedOut: result.timedOut, truncated: result.truncated };
}

const IDENTIFY = 'echo "TC_OK:1"; echo "TC_USER:$(whoami)"; echo "TC_HOST:$(uname -n)"; echo "TC_KERNEL:$(uname -r)"; echo "TC_ARCH:$(uname -m)"; echo "TC_OS:$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"';

async function identifyHost(key, user) {
  const result = await runShell(key, IDENTIFY, user, 25000);
  if (result.timedOut) throw new Error("SSH timed out while reading the host identity");
  if (result.exitCode === 255) throw new Error(clean(result.stderr, 400) || "SSH connection failed");
  const fields = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^TC_([A-Z]+):(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  if (fields.OK !== "1" || !fields.USER) throw new Error(clean(result.stderr, 400) || "This host answers pings but does not offer an SSH shell");
  const identity = { user: clean(fields.USER) || "unknown", hostname: clean(fields.HOST, 128) || "host", kernel: clean(fields.KERNEL, 128), arch: clean(fields.ARCH, 32), os: clean(fields.OS, 128) || undefined, at: Date.now() };
  return { identity, name: clean(`${identity.user}@${identity.hostname}`) };
}

function keyInfo() {
  const dir = path.join(homedir(), ".config", "tailcat", "keys");
  let names = [], clientPublicKey;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".private.json")).map((name) => name.replace(".private.json", "")).sort();
  } catch {}
  try {
    clientPublicKey = JSON.parse(readFileSync(path.join(dir, "client-default.private.json"), "utf8"))?.Public?.ServerPublic;
  } catch {}
  return { dir, names, clientPublicKey };
}

const handlers = {
  list: () => json({ ok: true, hosts, now: Date.now() }),
  keys: () => json({ ok: true, ...keyInfo() }),

  async add(params) {
    const key = keyOf(params, true), existing = find(key);
    if (existing) return json({ ok: true, host: existing, existing: true });
    let parsed;
    try {
      parsed = await parseKey(key);
    } catch (error) {
      throw new ApiError(`That key did not parse: ${error.message}`);
    }
    const name = clean(params.name), user = userOf(params.user);
    const host = { key, name: name || `host-${key.slice(-4)}`, autoName: !name, user: user || undefined, nodeKey: parsed.serverPublic, status: { state: "unknown" }, addedAt: Date.now() };
    hosts.push(host);
    save();
    return json({ ok: true, host });
  },

  async del(params) {
    const key = keyOf(params), before = hosts.length;
    hosts = hosts.filter((host) => host.key !== key);
    if (hosts.length !== before) save();
    return json({ ok: true, removed: hosts.length !== before });
  },

  async rename(params) {
    const host = find(keyOf(params));
    if (!host) throw new ApiError("Unknown host.", 404);
    if (params.auto === "1") {
      host.autoName = true;
      if (host.identity) host.name = clean(`${host.identity.user}@${host.identity.hostname}`) || host.name;
    } else {
      const name = clean(params.act_value || params.name);
      if (!name) throw new ApiError("A name is required.");
      host.name = name;
      host.autoName = false;
    }
    save();
    return json({ ok: true, host });
  },

  async ping(params) {
    const key = keyOf(params), status = await pingHost(key), host = find(key);
    if (host) {
      host.status = status;
      if (status.state === "online") host.lastSeenAt = Date.now();
      save();
    }
    return json({ ok: true, key, status, host: host || null });
  },

  async checkall() {
    await Promise.all(hosts.map(async (host) => {
      host.status = await pingHost(host.key);
      if (host.status.state === "online") host.lastSeenAt = Date.now();
    }));
    save();
    return json({ ok: true, hosts });
  },

  async identify(params) {
    const key = keyOf(params), host = find(key), status = await pingHost(key);
    if (status.state !== "online") {
      if (host) {
        host.status = status;
        host.lastSshError = undefined;
        save();
      }
      return json({ ok: true, status, host: host || null, sshError: "Host did not answer. Start its tailcat server and check the key." });
    }
    try {
      const { identity, name } = await identifyHost(key, host?.user);
      if (host) {
        host.identity = identity;
        host.lastSeenAt = Date.now();
        host.lastSshError = undefined;
        if (host.autoName) host.name = name;
        host.status = status;
        save();
      }
      return json({ ok: true, status, identity, name, host: host || null });
    } catch (error) {
      const message = clean(error.message || error, 400);
      if (host) {
        host.lastSshError = message;
        host.status = status;
        save();
      }
      return json({ ok: true, status, host: host || null, sshError: message });
    }
  },

  async shell(params, request) {
    const key = keyOf(params, true), command = String(params.act_value ?? params.cmd ?? params.command ?? "");
    if (!command.trim()) throw new ApiError("act_value is required: the remote command to run.");
    if (command.length > MAX_COMMAND || command.includes("\0")) throw new ApiError("Invalid command.");
    const host = find(key), timeout = clamp(Number(params.timeout) || 60000, 1000, 300000);
    if (params.stream === "1" || params.stream === "true") return streamShell(request, key, command, host?.user, timeout);
    const result = await runShell(key, command, host?.user, timeout);
    if (host) {
      if (result.exitCode !== 255) host.lastSeenAt = Date.now();
      save();
    }
    return json({ ok: true, key, ...result });
  },
};

handlers.hosts = handlers.list;
handlers.identity = handlers.keys;
handlers.check = handlers.ping;
handlers.refresh = handlers.detect = handlers.identify;
handlers.exec = handlers.run = handlers.shell;

async function api(request, url) {
  const params = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try {
      const body = await request.json();
      Object.assign(params, Object.fromEntries(Object.entries(body || {}).map(([key, value]) => [key, String(value)])));
    } catch {}
  }
  try {
    return await (handlers[(params.act || "").toLowerCase()] || handlers.list)(params, request);
  } catch (error) {
    console.error(error);
    return fail(error.message || "internal error", error.status || 500);
  }
}

function streamShell(request, key, command, user, timeout) {
  const proc = Bun.spawn(sshArgs(key, command, user), { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const encoder = new TextEncoder();
  const started = Date.now();
  let closed = false, timedOut = false, truncated = false, bytes = 0, controller;
  const send = (message) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(JSON.stringify(message) + "\n"));
    } catch {
      closed = true;
    }
  };
  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);
      const abort = () => proc.kill("SIGKILL");
      request.signal.addEventListener("abort", abort, { once: true });
      const pump = async (readable, tag) => {
        const decoder = new TextDecoder();
        try {
          for await (const chunk of readable) {
            if (closed) break;
            bytes += chunk.byteLength;
            if (bytes > MAX_OUTPUT) {
              truncated = true;
              send({ t: "e", d: "\n[output limit reached]\n" });
              proc.kill("SIGKILL");
              break;
            }
            const text = decoder.decode(chunk, { stream: true });
            if (text) send({ t: tag, d: text });
          }
          const tail = decoder.decode();
          if (tail) send({ t: tag, d: tail });
        } catch {}
      };
      (async () => {
        try {
          await Promise.all([pump(proc.stdout, "o"), pump(proc.stderr, "e")]);
          send({ t: "x", code: await proc.exited, ms: Date.now() - started, timedOut, truncated });
        } finally {
          clearTimeout(timer);
          request.signal.removeEventListener("abort", abort);
          closed = true;
          try {
            ctrl.close();
          } catch {}
        }
      })();
    },
    cancel() {
      closed = true;
      proc.kill("SIGKILL");
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}

async function staticFile(pathname) {
  const name = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!name || name.includes("..")) return new Response("not found", { status: 404 });
  const file = Bun.file(path.join(PUBLIC, name));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file, { headers: { "content-type": TYPES[path.extname(name)] || "application/octet-stream", "cache-control": "no-store", ...SECURITY } });
}

if (!["127.0.0.1", "localhost", "::1"].includes(HOST) && process.env.TCD_ALLOW_REMOTE !== "1") {
  console.error(`Refusing to bind to ${HOST}. Set TCD_ALLOW_REMOTE=1 to override.`);
  process.exit(1);
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api") return api(request, url);
    if (url.pathname === "/health") return new Response("ok\n");
    return staticFile(url.pathname);
  },
});

console.log(`tailcat deck ${server.url}`);
console.log(`${hosts.length} host(s)`);

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
