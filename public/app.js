
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const PRESETS = ["ls /", "whoami", "ps aux", "df -h", "uptime"];

const state = {
  hosts: [],
  selectedKey: null,
  filter: "",
  running: false,
  abort: null,
  keys: null,
  sessions: new Map(),
  consoleKey: null,
  historyIdx: -1,
  historyDraft: "",
  deleteArmed: false,
  deleteTimer: null,
  checkingAll: false,
  refreshing: new Set(),
};

init();

async function init() {
  initTheme();
  wireEvents();
  renderPresets();
  updateRunButton();

  await Promise.allSettled([loadHosts(), loadKeys()]);

  if (state.hosts.length) selectHost(state.hosts[0].key);
  else render();

  for (const host of state.hosts.filter((h) => !h.status || h.status.state === "unknown")) {
    quietPing(host);
  }

  setInterval(() => {
    const host = currentHost();
    if (host) $("#stat-seen").textContent = relTime(host.lastSeenAt || host.status?.checkedAt);
  }, 30000);
}


async function apiGet(act, extra = {}) {
  const query = new URLSearchParams({ act, ...extra });
  const response = await fetch(`/api?${query}`, { headers: { accept: "application/json" } });
  return readJson(response);
}

async function apiPost(act, params = {}, signal) {
  const { act_value, ...rest } = params;
  const query = new URLSearchParams({ act });
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const response = await fetch(`/api?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(act_value === undefined ? {} : { act_value }),
    signal,
  });
  return readJson(response);
}

async function readJson(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Server returned HTTP ${response.status}`);
  }
  if (!data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function loadHosts() {
  try {
    const data = await apiGet("hosts");
    state.hosts = Array.isArray(data.hosts) ? data.hosts : [];
    if (state.selectedKey && !state.hosts.some((h) => h.key === state.selectedKey)) {
      state.selectedKey = null;
    }
  } catch (error) {
    toast("Could not load hosts", error.message, "bad");
  }
}

async function loadKeys() {
  try {
    state.keys = await apiGet("keys");
  } catch {
    state.keys = null;
  }
  renderIdentity();
}


function render() {
  renderHostList();
  renderDetail();
}

function renderHostList() {
  const query = state.filter.trim().toLowerCase();
  const hosts = state.hosts.filter((host) => matches(host, query));

  $("#host-count").textContent = state.hosts.length
    ? `${state.hosts.length} host${state.hosts.length === 1 ? "" : "s"}`
    : "";

  $("#sidebar-empty").hidden = hosts.length > 0;
  $("#sidebar-empty").textContent = state.hosts.length ? "No hosts found." : "No hosts yet.";
  $("#host-list").innerHTML = hosts.map(hostRow).join("");
}

function matches(host, query) {
  if (!query) return true;
  return [host.name, host.key, host.identity?.user, host.identity?.hostname, host.identity?.os]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function hostRow(host) {
  const status = statusMeta(host);
  const latency = host.status?.latencyMs != null ? `${formatMs(host.status.latencyMs)} ms` : "";
  const path = host.status?.path ? (host.status.path === "derp" ? "DERP" : "direct") : "";
  const meta = [status.label, latency, path].filter(Boolean).join(" · ");

  return `<button class="host${host.key === state.selectedKey ? " active" : ""}" type="button" data-key="${escAttr(host.key)}">
    <div class="host-name">${esc(host.name)}</div>
    <div class="host-meta"><span class="dot ${status.dot}"></span>${esc(meta)}</div>
  </button>`;
}

function renderDetail() {
  const host = currentHost();

  $("#empty-view").hidden = Boolean(host);
  $("#host-view").hidden = !host;
  if (!host) return;

  if (!document.getElementById("name-input")) {
    $("#host-name").textContent = host.name;
  }

  $("#auto-name-btn").hidden = host.autoName || !host.identity;
  $("#host-key").textContent = shortKey(host.key);
  $("#host-key").title = host.key;

  const status = statusMeta(host);
  $("#stat-status").innerHTML = `<span class="dot ${status.dot}"></span>${status.label}`;
  $("#stat-path").textContent = host.status?.path
    ? host.status.path === "derp"
      ? `DERP${host.status.via ? ` (${host.status.via})` : ""}`
      : "direct"
    : "—";
  $("#stat-latency").textContent =
    host.status?.latencyMs != null ? `${formatMs(host.status.latencyMs)} ms` : "—";
  $("#stat-user").textContent = host.identity?.user || "—";
  $("#stat-kernel").textContent = host.identity?.kernel || "—";
  $("#stat-arch").textContent = host.identity?.arch || "—";
  $("#stat-os").textContent = host.identity?.os || "—";
  $("#stat-seen").textContent = relTime(host.lastSeenAt || host.status?.checkedAt);

  renderAlert(host);
  renderRefreshButton(host);
  renderDeleteButton();

  $("#console-host").textContent = host.identity
    ? `${host.identity.user}@${host.identity.hostname}`
    : shortKey(host.key);

  syncConsole(host);
}

function renderAlert(host) {
  const element = $("#host-alert");
  let text = "";
  let warn = false;

  if (host.status?.state === "offline" && host.status.error) {
    text = host.status.error;
  } else if (host.lastSshError) {
    text = host.lastSshError;
    warn = true;
  }

  if (!text) {
    element.hidden = true;
    element.textContent = "";
    return;
  }

  element.className = warn ? "alert warn" : "alert";
  element.textContent = text;
  element.hidden = false;
}

function renderRefreshButton(host) {
  const button = $("#refresh-btn");
  const busy = state.refreshing.has(host.key);
  button.disabled = busy;
  button.textContent = busy ? "Refreshing..." : "Refresh";
}

function renderDeleteButton() {
  const armed = state.deleteArmed && Boolean(currentHost());
  const button = $("#delete-btn");
  button.textContent = armed ? "Confirm delete" : "Delete";
}

function renderIdentity() {
  const info = state.keys;
  const key = $("#identity-key");
  const hint = $("#identity-hint");
  const copy = $("#copy-identity");

  if (!info) {
    key.textContent = "Could not load keys.";
    hint.textContent = "";
    $("#identity-keys").textContent = "";
    copy.disabled = true;
    return;
  }

  if (info.clientPublicKey) {
    key.textContent = info.clientPublicKey;
    hint.textContent = "Client modes use this key automatically.";
    copy.disabled = false;
  } else {
    key.textContent = "No client-default key";
    hint.innerHTML = `Create one with <code>tailcat genkey --client --key=client-default</code>`;
    copy.disabled = true;
  }

  $("#identity-keys").textContent = info.names?.length
    ? info.names.join(", ")
    : `No saved keys in ${info.dir}`;
}

function renderPresets() {
  $("#presets").innerHTML = PRESETS.map(
    (command) => `<button class="preset" type="button" data-cmd="${escAttr(command)}">${esc(command)}</button>`,
  ).join("");
}


function syncConsole(host) {
  if (state.consoleKey === host.key) return;
  state.consoleKey = host.key;
  const output = $("#console-out");
  output.replaceChildren(getSession(host));
  output.scrollTop = output.scrollHeight;
}

function getSession(host) {
  let session = state.sessions.get(host.key);

  if (!session) {
    session = document.createElement("div");
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.dataset.hint = "1";
    hint.textContent = "Run a command to start a shell.";
    session.appendChild(hint);
    state.sessions.set(host.key, session);
  }

  return session;
}

async function runCommand(raw) {
  const host = currentHost();
  if (!host || state.running) return;

  const command = String(raw || "").trim();
  if (!command) return;

  pushHistory(host, command);
  state.historyIdx = -1;
  $("#cmd-input").value = "";

  const session = getSession(host);
  session.querySelector("[data-hint]")?.remove();

  const prompt = document.createElement("div");
  prompt.className = "console-cmd";
  prompt.textContent = `$ ${command}`;
  session.appendChild(prompt);

  const output = document.createElement("pre");
  output.className = "console-output";
  session.appendChild(output);

  const meta = document.createElement("div");
  meta.className = "console-meta";
  meta.textContent = "running...";
  session.appendChild(meta);

  state.running = true;
  state.abort = new AbortController();
  updateRunButton();
  scrollConsole(true);

  const started = performance.now();
  let final = null;

  try {
    const query = new URLSearchParams({
      act: "shell",
      stream: "1",
      key: host.key,
      timeout: "60000",
    });

    const response = await fetch(`/api?${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ act_value: command }),
      signal: state.abort.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("The server returned an empty response.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.t === "o" || message.t === "e") {
          appendOutput(output, message.d, message.t === "e");
        } else if (message.t === "x") {
          final = message;
        }
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (error.name === "AbortError") {
      meta.textContent = "stopped";
      meta.className = "console-meta";
    } else {
      appendOutput(output, `${error.message || error}\n`, true);
      meta.textContent = "connection failed";
      meta.className = "console-meta error";
      toast("Command did not run", error.message || String(error), "bad");
    }
  } finally {
    state.running = false;
    state.abort = null;
    updateRunButton();

    if (final) {
      const milliseconds = final.ms ?? Math.round(performance.now() - started);
      const parts = [`exit ${final.code}`, `${milliseconds} ms`];
      if (final.timedOut) parts.push("timed out");
      if (final.truncated) parts.push("output truncated");
      meta.textContent = parts.join(" · ");
      meta.className = final.code === 0 && !final.timedOut ? "console-meta" : "console-meta error";
    } else if (meta.textContent === "running...") {
      meta.textContent = "connection closed";
      meta.className = "console-meta error";
    }

    if (!output.textContent) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "(no output)";
      output.appendChild(empty);
    }

    scrollConsole(true);
  }
}

function appendOutput(output, text, isError) {
  if (!text) return;
  const clean = stripAnsi(text);
  if (!clean) return;

  const container = $("#console-out");
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

  const span = document.createElement("span");
  if (isError) span.className = "stderr";
  span.textContent = clean;
  output.appendChild(span);

  if (nearBottom) container.scrollTop = container.scrollHeight;
}

function scrollConsole(force) {
  const output = $("#console-out");
  const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 60;
  if (force || nearBottom) output.scrollTop = output.scrollHeight;
}

function clearConsole() {
  const host = currentHost();
  if (!host) return;
  state.sessions.delete(host.key);
  state.consoleKey = null;
  syncConsole(host);
}

function updateRunButton() {
  const button = $("#run-btn");

  if (state.running) {
    button.textContent = "Stop";
    button.className = "btn btn-danger";
    button.type = "button";
  } else {
    button.textContent = "Run";
    button.className = "btn btn-primary";
    button.type = "submit";
  }
}

function stopRun() {
  state.abort?.abort();
}


function currentHost() {
  return state.hosts.find((host) => host.key === state.selectedKey) || null;
}

function selectHost(key) {
  if (!state.hosts.some((host) => host.key === key)) return;
  if (state.selectedKey !== key) {
    state.deleteArmed = false;
    state.historyIdx = -1;
  }
  state.selectedKey = key;
  render();
}

function mergeHost(host) {
  if (!host) return;
  const index = state.hosts.findIndex((item) => item.key === host.key);
  if (index >= 0) state.hosts[index] = host;
  else state.hosts.push(host);
}

async function refreshHost(key, options = {}) {
  const quiet = Boolean(options.quiet);
  if (state.refreshing.has(key)) return;

  const host = state.hosts.find((item) => item.key === key);
  if (!host) return;

  state.refreshing.add(key);
  host.status = { ...(host.status || {}), state: "checking" };
  render();

  try {
    const data = await apiPost("identify", { key }, AbortSignal.timeout(55000));
    if (data.host) mergeHost(data.host);
    else if (data.status) host.status = data.status;

    if (data.sshError) {
      toast("Host answered, SSH did not", data.sshError, "warn");
    } else if (!quiet) {
      const fresh = state.hosts.find((item) => item.key === key) || host;
      toast("Host refreshed", `${fresh.name} · ${formatMs(data.status?.latencyMs)} ms`, "ok");
    }
  } catch (error) {
    const target = state.hosts.find((item) => item.key === key);
    if (target) {
      target.status = { state: "offline", error: error.message, checkedAt: Date.now() };
    }
    if (!quiet) toast("Refresh failed", error.message, "bad");
  } finally {
    state.refreshing.delete(key);
    render();
  }
}

async function quietPing(host) {
  if (!host) return;
  host.status = { ...(host.status || {}), state: "checking" };
  renderHostList();

  try {
    const data = await apiPost("ping", { key: host.key });
    if (data.host) mergeHost(data.host);
    else host.status = data.status;
  } catch {
    host.status = { state: "offline", error: "Could not reach the tailcat CLI.", checkedAt: Date.now() };
  }

  render();
}

async function checkAll() {
  if (state.checkingAll) return;
  if (!state.hosts.length) {
    toast("Nothing to check", "Add a host first.", "warn");
    return;
  }

  state.checkingAll = true;
  setCheckAllBusy(true);

  for (const host of state.hosts) {
    host.status = { ...(host.status || {}), state: "checking" };
  }
  render();

  try {
    const data = await apiPost("checkall");
    if (Array.isArray(data.hosts)) state.hosts = data.hosts;
    const online = state.hosts.filter((host) => host.status?.state === "online").length;
    const total = state.hosts.length;
    toast(
      `${online} of ${total} online`,
      online === total ? "Every tunnel answered." : "Offline hosts keep their saved key.",
      online === total ? "ok" : "warn",
    );
  } catch (error) {
    toast("Check all failed", error.message, "bad");
  } finally {
    state.checkingAll = false;
    setCheckAllBusy(false);
    render();
  }
}

function setCheckAllBusy(busy) {
  const button = $("#check-all-btn");
  button.disabled = busy;
  button.textContent = busy ? "Checking..." : "Check all";
}

async function deleteSelected() {
  const host = currentHost();
  if (!host) return;

  if (!state.deleteArmed) {
    state.deleteArmed = true;
    renderDeleteButton();
    clearTimeout(state.deleteTimer);
    state.deleteTimer = setTimeout(() => {
      state.deleteArmed = false;
      renderDeleteButton();
    }, 3000);
    return;
  }

  clearTimeout(state.deleteTimer);
  state.deleteArmed = false;

  try {
    await apiPost("del", { key: host.key });
    state.hosts = state.hosts.filter((item) => item.key !== host.key);
    state.sessions.delete(host.key);
    state.consoleKey = null;
    state.selectedKey = state.hosts[0]?.key || null;
    render();
    toast("Host removed", host.name, "ok");
  } catch (error) {
    toast("Could not remove host", error.message, "bad");
    renderDeleteButton();
  }
}

async function useAutoName() {
  const host = currentHost();
  if (!host) return;

  try {
    const data = await apiPost("rename", { key: host.key, auto: "1" });
    mergeHost(data.host);
    render();
    toast("Auto name restored", data.host.name, "ok");
  } catch (error) {
    toast("Could not restore auto name", error.message, "bad");
  }
}


function beginRename() {
  const host = currentHost();
  if (!host || document.getElementById("name-input")) return;

  const title = $("#host-name");
  const input = document.createElement("input");
  input.id = "name-input";
  input.className = "input rename-input";
  input.value = host.name;
  input.spellcheck = false;
  title.replaceWith(input);
  input.focus();
  input.select();

  let done = false;

  const finish = async (save) => {
    if (done) return;
    done = true;

    const value = input.value.trim();
    const parent = input.parentElement;
    const next = input.nextSibling;
    input.remove();

    const newTitle = document.createElement("h1");
    newTitle.id = "host-name";
    parent?.insertBefore(newTitle, next);

    if (save && value && value !== host.name) {
      try {
        const data = await apiPost("rename", { key: host.key, act_value: value });
        mergeHost(data.host);
        toast("Host renamed", value, "ok");
      } catch (error) {
        toast("Rename failed", error.message, "bad");
      }
    }

    renderDetail();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });

  input.addEventListener("blur", () => finish(true));
}


function openAdd() {
  $("#add-form").reset();
  $("#add-error").hidden = true;
  $("#add-submit").disabled = false;
  $("#add-submit").textContent = "Add host";
  $("#add-dialog").showModal();
  setTimeout(() => $("#add-key").focus(), 30);
}

async function submitAdd(event) {
  event.preventDefault();

  const key = $("#add-key").value.trim();
  const name = $("#add-name").value.trim();
  const user = $("#add-user").value.trim();
  const errorBox = $("#add-error");
  const submit = $("#add-submit");

  errorBox.hidden = true;

  if (!key) {
    errorBox.textContent = "Paste a tailcat key first.";
    errorBox.hidden = false;
    return;
  }

  submit.disabled = true;
  submit.textContent = "Adding...";

  try {
    const data = await apiPost("add", { key, name, user });
    $("#add-dialog").close();

    if (data.existing) {
      mergeHost(data.host);
      selectHost(data.host.key);
      toast("Already added", "That key is already on the board.", "warn");
    } else {
      mergeHost(data.host);
      state.filter = "";
      $("#search").value = "";
      selectHost(data.host.key);
      toast("Host added", "Reading identity over SSH...", "ok");
      refreshHost(data.host.key, { quiet: true });
    }
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    submit.disabled = false;
    submit.textContent = "Add host";
  }
}

function openIdentity() {
  $("#identity-dialog").showModal();
  loadKeys();
}


function historyKey(host) {
  return `tcd.history.${host.nodeKey || host.name}`;
}

function getHistory(host) {
  try {
    const raw = localStorage.getItem(historyKey(host));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pushHistory(host, command) {
  try {
    const history = getHistory(host).filter((item) => item !== command);
    history.unshift(command);
    localStorage.setItem(historyKey(host), JSON.stringify(history.slice(0, 80)));
  } catch {
  }
}

function navigateHistory(direction) {
  const host = currentHost();
  if (!host) return;

  const history = getHistory(host);
  const input = $("#cmd-input");
  if (!history.length) return;

  if (direction < 0) {
    if (state.historyIdx === -1) {
      state.historyDraft = input.value;
      state.historyIdx = 0;
    } else {
      state.historyIdx = Math.min(state.historyIdx + 1, history.length - 1);
    }
    input.value = history[state.historyIdx];
  } else {
    if (state.historyIdx <= 0) {
      state.historyIdx = -1;
      input.value = state.historyDraft;
      return;
    }
    state.historyIdx -= 1;
    input.value = history[state.historyIdx];
  }

  requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
}


function initTheme() {
  const root = document.documentElement;
  const button = $("#theme-btn");

  const update = () => {
    const dark = root.getAttribute("data-theme") === "dark";
    button.textContent = dark ? "Light" : "Dark";
    button.title = dark ? "Switch to light mode" : "Switch to dark mode";
  };

  update();
  button.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("tcd.theme", next);
    } catch {
    }
    update();
  });
}


function wireEvents() {
  $("#check-all-btn").addEventListener("click", checkAll);
  $("#identity-btn").addEventListener("click", openIdentity);
  $("#add-btn").addEventListener("click", openAdd);
  $("#empty-add-btn").addEventListener("click", openAdd);
  $("#refresh-btn").addEventListener("click", () => {
    const host = currentHost();
    if (host) refreshHost(host.key);
  });
  $("#delete-btn").addEventListener("click", deleteSelected);
  $("#rename-btn").addEventListener("click", beginRename);
  $("#auto-name-btn").addEventListener("click", useAutoName);
  $("#clear-btn").addEventListener("click", clearConsole);

  $("#copy-key-btn").addEventListener("click", () => {
    const host = currentHost();
    if (host) copyText(host.key, "Host key copied");
  });

  $("#copy-identity").addEventListener("click", () => {
    if (state.keys?.clientPublicKey) copyText(state.keys.clientPublicKey, "Client key copied");
  });

  $("#search").addEventListener("input", (event) => {
    state.filter = event.target.value;
    renderHostList();
  });

  $("#host-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-key]");
    if (row) selectHost(row.dataset.key);
  });

  $("#presets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-cmd]");
    if (button && !state.running) runCommand(button.dataset.cmd);
  });

  $("#cmd-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.running) runCommand($("#cmd-input").value);
  });

  $("#run-btn").addEventListener("click", (event) => {
    if (state.running) {
      event.preventDefault();
      stopRun();
    }
  });

  $("#cmd-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      navigateHistory(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      navigateHistory(1);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      clearConsole();
    }
  });

  $("#cmd-input").addEventListener("input", () => {
    state.historyIdx = -1;
  });

  $("#add-form").addEventListener("submit", submitAdd);

  $("#add-key").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      $("#add-form").requestSubmit();
    }
  });

  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  $$("dialog [data-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });

  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === "INPUT" || tag === "TEXTAREA";
    const dialogOpen = Boolean(document.querySelector("dialog[open]"));

    if (!dialogOpen && !typing && (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"))) {
      event.preventDefault();
      $("#search").focus();
      $("#search").select();
    }
  });

  window.addEventListener("focus", () => {
    const host = currentHost();
    if (!host || state.running) return;
    const last = host.status?.checkedAt || 0;
    if (Date.now() - last > 180000) quietPing(host);
  });
}


function statusMeta(host) {
  const value = host.status?.state || "unknown";
  if (value === "online") return { label: "online", dot: "online" };
  if (value === "offline") return { label: "offline", dot: "offline" };
  if (value === "checking") return { label: "checking", dot: "checking" };
  return { label: "unchecked", dot: "unknown" };
}

function formatMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number < 10 ? number.toFixed(1) : String(Math.round(number));
}

function relTime(timestamp) {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortKey(key) {
  if (!key) return "";
  return key.length <= 24 ? key : `${key.slice(0, 10)}...${key.slice(-6)}`;
}

function stripAnsi(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r(?!\n)/g, "");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escAttr(value) {
  return esc(value);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, "", "ok");
    return;
  } catch {
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    toast(message, "", "ok");
  } catch {
    toast("Copy failed", "Select the key and copy it manually.", "warn");
  }
}

function toast(title, detail, kind = "ok") {
  const element = document.createElement("div");
  element.className = `toast ${kind === "ok" ? "" : kind}`.trim();
  element.innerHTML = `<strong></strong><span></span>`;
  element.querySelector("strong").textContent = title;
  element.querySelector("span").textContent = detail || "";

  $("#toasts").appendChild(element);
  setTimeout(() => element.remove(), 4000);
}
