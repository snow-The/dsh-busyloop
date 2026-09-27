// src/index.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
import { homedir as homedir3 } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import { DeepSeekAdapter } from "@deepseek-ai/dsh-llm-deepseek";
import { defineTool } from "@deepseek-ai/dsh-tools";
import yaml from "js-yaml";

// src/llm.ts
function hostLlm(service) {
  return {
    stream: (options) => service.stream(options),
    listProviders: () => service.listProviders(),
    defaultProvider: () => {
      const first = service.listProviders()[0];
      if (!first) return void 0;
      return first.id ?? String(first);
    }
  };
}

// src/keys.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
var KEY_FILE = process.env.DSH_BUSYLOOP_KEYS ?? join(DSH_HOME, "busyloop-keys.json");
var ACTIVE_FILE = process.env.DSH_BUSYLOOP_ACTIVE ?? join(DSH_HOME, "busyloop-active.json");
function readStore() {
  try {
    if (!existsSync(KEY_FILE)) return [];
    const raw = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => e && typeof e.alias === "string" && typeof e.key === "string");
  } catch {
    return [];
  }
}
function maskKey(key) {
  if (key.length <= 10) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
function readActiveAlias() {
  try {
    if (!existsSync(ACTIVE_FILE)) return void 0;
    return JSON.parse(readFileSync(ACTIVE_FILE, "utf8"))?.alias;
  } catch {
    return void 0;
  }
}
function resolveEffectiveKey(loadEnvKey, keyEnv, channel) {
  const active = readActiveAlias();
  if (active) {
    const entry = readStore().find((e) => e.alias === active);
    if (entry && (!entry.channel || entry.channel === channel)) {
      return { key: entry.key, alias: entry.alias, masked: maskKey(entry.key), source: "session" };
    }
  }
  const envKey = loadEnvKey(keyEnv);
  if (envKey) return { key: envKey, masked: maskKey(envKey), source: "global" };
  return { source: "global" };
}

// src/panel.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
function channelsPath() {
  return process.env.DSH_BUSYLOOP_CHANNELS ?? join2(homedir2(), ".dsh", "busyloop-channels.json");
}
var posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : void 0;
var nonNegNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : void 0;
function normaliseChannel(raw) {
  if (raw === null || typeof raw !== "object") return void 0;
  const v = raw;
  if (typeof v.baseURL !== "string" || !v.baseURL.trim()) return void 0;
  if (typeof v.model !== "string" || !v.model.trim()) return void 0;
  if (typeof v.keyEnv !== "string" || !v.keyEnv.trim()) return void 0;
  const out = {
    baseURL: v.baseURL.trim(),
    model: v.model.trim(),
    keyEnv: v.keyEnv.trim()
  };
  if (typeof v.keyAlias === "string" && v.keyAlias.trim()) out.keyAlias = v.keyAlias.trim();
  const maxTokens = posNum(v.maxTokens);
  if (maxTokens !== void 0) out.maxTokens = maxTokens;
  const contextWindow = posNum(v.contextWindow);
  if (contextWindow !== void 0) out.contextWindow = contextWindow;
  const delayMs = nonNegNum(v.delayMs);
  if (delayMs !== void 0) out.delayMs = delayMs;
  const concurrency = posNum(v.concurrency);
  if (concurrency !== void 0) out.concurrency = Math.floor(concurrency);
  return out;
}
function readChannels() {
  const file = channelsPath();
  let text;
  try {
    text = readFileSync2(file, "utf8");
  } catch (err) {
    const code = err?.code;
    return code === "ENOENT" ? { channels: {} } : { channels: {}, error: `cannot read ${file}: ${String(code ?? err)}` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { channels: {}, error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { channels: {}, error: `${file} must contain a JSON object of channel name -> config` };
  }
  const channels = {};
  for (const [key, value] of Object.entries(raw)) {
    const channel = normaliseChannel(value);
    if (channel) channels[key] = channel;
  }
  return { channels };
}
function writeChannel(channelKey, patch) {
  if (!channelKey || typeof channelKey !== "string") return { ok: false, error: "channel key required" };
  const file = channelsPath();
  const existing = readChannels();
  if (existing.error && !existing.error.includes("ENOENT")) {
    return { ok: false, error: `refusing to write: ${existing.error}` };
  }
  const next = { ...existing.channels };
  if (patch.remove === true) {
    delete next[channelKey];
  } else {
    const merged = normaliseChannel({ ...next[channelKey] ?? {}, ...patch });
    if (merged) next[channelKey] = merged;
    else return { ok: false, error: `channel "${channelKey}" needs baseURL, model and keyEnv` };
  }
  try {
    mkdirSync2(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync2(tmp, `${JSON.stringify(next, null, 2)}
`, { mode: 384 });
    renameSync(tmp, file);
    return { ok: true, channels: next };
  } catch (err) {
    return { ok: false, error: `cannot write ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// src/credentials.ts
function mask(value) {
  if (typeof value !== "string" || value.length === 0) return "(empty)";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${"*".repeat(8)}${value.slice(-4)} (len ${value.length})`;
}
function credentialsFrom(ctx) {
  try {
    const service = typeof ctx?.get === "function" ? ctx.get("credentials") : void 0;
    if (service && typeof service.resolve === "function") {
      return service;
    }
    return void 0;
  } catch {
    return void 0;
  }
}
async function resolveValue(service, ref) {
  if (!service || typeof ref !== "string" || !ref) return void 0;
  try {
    const resolved = await service.resolve(ref);
    if (!resolved || typeof resolved.value !== "string" || !resolved.value) return void 0;
    return { value: resolved.value, source: String(resolved.source ?? "credentials") };
  } catch {
    return void 0;
  }
}
async function describeRefs(service, refs) {
  const wanted = [...new Set(refs.filter((r) => typeof r === "string" && r.length > 0))];
  const extra = /* @__PURE__ */ new Set();
  if (service?.listRecords) {
    try {
      const records = await service.listRecords();
      for (const record of records ?? []) {
        const name2 = typeof record === "string" ? record : record?.key ?? record?.name ?? record?.id;
        if (typeof name2 === "string" && name2) extra.add(name2);
      }
    } catch {
    }
  }
  const rows = [];
  for (const ref of [...wanted, ...[...extra].filter((e) => !wanted.includes(e))]) {
    const resolved = await resolveValue(service, ref);
    if (resolved) {
      rows.push({ ref, source: resolved.source, masked: mask(resolved.value), present: true });
      continue;
    }
    let source;
    if (service?.describe) {
      try {
        const info = await service.describe(ref);
        source = info?.source;
      } catch {
        source = void 0;
      }
    }
    rows.push({ ref, source, present: false });
  }
  return rows;
}
async function store(service, ref, value) {
  if (!service) return { ok: false, error: "this host exposes no credentials service" };
  if (typeof service.set !== "function") return { ok: false, error: "the credentials service cannot store values on this host" };
  if (typeof ref !== "string" || !ref.trim()) return { ok: false, error: "a credential name is required" };
  if (typeof value !== "string" || !value.trim()) return { ok: false, error: "a credential value is required" };
  try {
    await service.set(ref.trim(), value.trim());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const check = await resolveValue(service, ref.trim());
  if (!check) {
    return { ok: false, error: `stored "${ref.trim()}" but the service could not read it back` };
  }
  return { ok: true, ref: ref.trim(), masked: mask(check.value) };
}
async function remove(service, ref) {
  if (!service) return { ok: false, error: "this host exposes no credentials service" };
  if (typeof service.unset !== "function") return { ok: false, error: "the credentials service cannot remove values on this host" };
  if (typeof ref !== "string" || !ref.trim()) return { ok: false, error: "a credential name is required" };
  try {
    await service.unset(ref.trim());
    return { ok: true, ref: ref.trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// src/loop.ts
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
function textBlock(text) {
  return { type: "text", text };
}
function toolResultMessage(toolCallId, text, isError) {
  return {
    role: "user",
    content: [
      { type: "tool-result", toolCallId, content: [textBlock(text)], isError }
    ]
  };
}
function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function stringifyResult(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
async function runBusyLoop(llm, opts) {
  const maxTurns = opts.maxTurns ?? 8;
  const toolMap = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const messages = [
    { role: "user", content: [textBlock(opts.prompt)] }
  ];
  let turns = 0;
  let toolCalls = 0;
  let usage;
  let finish = "stop";
  for (let i = 0; i < maxTurns; i++) {
    turns = i + 1;
    await sleep(opts.delayMs ?? 0);
    const gen = {
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      messages,
      tools: (opts.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      })),
      reasoningEffort: opts.reasoningEffort,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      signal: opts.signal,
      sessionId: opts.sessionId
    };
    const asm = new BlockAssembler();
    for await (const chunk of llm.stream(gen)) asm.push(chunk);
    const msg = asm.message();
    usage = asm.usage;
    finish = asm.finish?.kind ?? "stop";
    messages.push(msg);
    const calls = msg.content.filter((b) => b.type === "tool-call");
    if (calls.length === 0) break;
    for (const call of calls) {
      const tool = toolMap.get(call.name);
      let text;
      let isError = false;
      if (!tool) {
        text = `unknown tool: ${call.name}`;
        isError = true;
      } else {
        try {
          let args = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
          }
          const result = await tool.execute(args, opts.signal);
          toolCalls++;
          text = stringifyResult(result);
        } catch (err) {
          text = `tool error: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
      }
      messages.push(toolResultMessage(call.id, text, isError));
      opts.onEvent?.({ type: "tool", name: call.name, ok: !isError });
    }
    opts.onEvent?.({ type: "turn", turn: turns + 1, toolCalls: calls.length });
  }
  const last = messages.at(-1);
  const output = last?.content.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
  opts.onEvent?.({ type: "done", turns });
  return { output, turns, toolCalls, usage, finish };
}

// src/index.ts
var name = "dsh-busyloop";
var inject = ["tools"];
var description = "DSH agent-loop engine: host-LLM adapter (official ctx.llm channel) + lightweight loop skeleton + agent tool busyloop_run (one-off tasks on a chosen channel \u2014 Volcano Ark plan API by default \u2014 main-model tokens untouched). Capability layer \u2014 codex style is opt-in via dsh-busyloop-codexstyle.";
function createRequestFence(ctx) {
  const resolveConnection = () => {
    const read = ctx?.get;
    if (typeof read !== "function") return void 0;
    try {
      const connection = read.call(ctx, "connection");
      return typeof connection?.requestRejection === "function" ? connection : void 0;
    } catch {
      return void 0;
    }
  };
  return (req, res) => {
    const connection = resolveConnection();
    if (connection === void 0) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "connection service unavailable: the Host/Origin fence cannot be applied" }));
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === void 0) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };
}
function registerHttpRoutes(deps, register) {
  const { rejected } = deps;
  const sendJson = (res, status, value) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const LIMIT = 64 * 1024;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = text ? JSON.parse(text) : {};
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
  const route = (method, run) => async (req, res) => {
    if (rejected ? rejected(req, res) : false) return;
    if (req.method !== method) {
      res.statusCode = 405;
      res.setHeader("allow", method);
      res.end();
      return;
    }
    let body = {};
    if (method !== "GET") {
      try {
        body = await readJson(req);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    try {
      await run(body, req, res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const fenceOf = () => rejected ?? (() => false);
  const getOnly = (reject, req, res, run) => {
    if (reject(req, res)) return;
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("allow", "GET");
      res.end();
      return;
    }
    run();
  };
  register("exact", "/api/busyloop/health", (req, res) => getOnly(fenceOf(), req, res, () => sendJson(res, 200, { ok: true, plugin: name, engine: true, hostLlm: true })));
  register("exact", "/api/busyloop/providers", (req, res) => getOnly(fenceOf(), req, res, () => {
    if (!deps.llm) {
      sendJson(res, 200, { providers: [] });
      return;
    }
    try {
      const providers = hostLlm(deps.llm).listProviders().map((p) => ({ id: p.id ?? String(p) }));
      sendJson(res, 200, { providers });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }));
  const creds = () => deps.credentials?.();
  const storedOverride = (key) => readChannels().channels[key];
  const channelRow = async (key) => {
    const overrides = readChannels();
    const builtin = deps.builtins?.()[key];
    const override = overrides.channels[key];
    const config = override ?? builtin;
    if (!config) return { key, present: false };
    const from = override ? builtin ? "override" : "file" : "builtin";
    let via;
    let masked;
    if (config.keyAlias) {
      const resolved = await resolveValue(creds(), config.keyAlias);
      if (resolved) {
        via = `alias:${config.keyAlias}`;
        masked = mask(resolved.value);
      }
    }
    if (via === void 0) {
      const resolved = await resolveValue(creds(), config.keyEnv);
      if (resolved) {
        via = `credential:${config.keyEnv}`;
        masked = mask(resolved.value);
      }
    }
    if (via === void 0 && typeof process.env[config.keyEnv] === "string" && process.env[config.keyEnv]) {
      via = `env:${config.keyEnv}`;
      masked = mask(String(process.env[config.keyEnv]));
    }
    return {
      key,
      present: true,
      from,
      editable: true,
      config,
      keyEnv: config.keyEnv,
      keyAlias: config.keyAlias ?? null,
      via: via ?? null,
      masked: masked ?? null,
      callable: via !== void 0
    };
  };
  register("exact", "/api/busyloop/channels", route("GET", async (_body, _req, res) => {
    const overrides = readChannels();
    const keys = [.../* @__PURE__ */ new Set([...Object.keys(deps.builtins?.() ?? {}), ...Object.keys(overrides.channels)])].sort();
    const channels = [];
    for (const key of keys) channels.push(await channelRow(key));
    sendJson(res, 200, {
      ok: true,
      channels,
      file: channelsPath(),
      fileError: overrides.error ?? null,
      credentialsAvailable: creds() !== void 0
    });
  }));
  register("exact", "/api/busyloop/channel", route("POST", async (body, _req, res) => {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) {
      sendJson(res, 400, { ok: false, error: "key is required" });
      return;
    }
    const remove2 = body.remove === true;
    if (remove2) {
      const result2 = writeChannel(key, { remove: true });
      if (!result2.ok) {
        sendJson(res, 400, { ok: false, error: result2.error });
        return;
      }
      sendJson(res, 200, { ok: true, key, removed: true, channel: await channelRow(key) });
      return;
    }
    const base = { ...storedOverride(key) ?? {}, ...(await channelRow(key)).config };
    const patch = {};
    for (const field of ["baseURL", "model", "keyEnv", "keyAlias"]) {
      if (typeof body[field] === "string") patch[field] = body[field].trim();
    }
    for (const field of ["maxTokens", "contextWindow", "delayMs", "concurrency"]) {
      if (body[field] === null) {
        patch[field] = void 0;
        continue;
      }
      if (body[field] !== void 0) {
        const n = Number(body[field]);
        if (Number.isFinite(n)) patch[field] = n;
      }
    }
    const result = writeChannel(key, { ...base, ...patch });
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(res, 200, { ok: true, key, removed: false, channel: await channelRow(key) });
  }));
  register("exact", "/api/busyloop/test", route("POST", async (body, _req, res) => {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) {
      sendJson(res, 400, { ok: false, error: "key is required" });
      return;
    }
    const row = await channelRow(key);
    if (row.present !== true) {
      sendJson(res, 404, { ok: false, error: `unknown channel "${key}"` });
      return;
    }
    const config = row.config;
    const ref = config.keyAlias ?? config.keyEnv;
    const resolved = await resolveValue(creds(), ref);
    const envName = config.keyEnv;
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, envName);
    const prevEnv = process.env[envName];
    if (resolved) process.env[envName] = resolved.value;
    try {
      const llm = deps.llm;
      if (!llm) {
        sendJson(res, 200, { ok: false, error: "this host exposes no llm service" });
        return;
      }
      const started = Date.now();
      const result = await runBusyLoop(hostLlm(llm), {
        provider: "deepseek",
        model: config.model,
        prompt: "Reply with exactly: ok",
        maxTurns: 1,
        maxTokens: 32,
        delayMs: 0
      });
      const trimmed = (result.output ?? "").trim();
      sendJson(res, 200, {
        ok: trimmed.length > 0,
        ms: Date.now() - started,
        model: config.model,
        baseURL: config.baseURL,
        via: row.via,
        turns: result.turns,
        finish: result.finish,
        preview: (result.output ?? "").slice(0, 200),
        error: trimmed.length > 0 ? null : `the call returned no text (finish=${result.finish})`
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (hadEnv) process.env[envName] = prevEnv;
      else delete process.env[envName];
    }
  }));
  register("exact", "/api/busyloop/credentials", route("GET", async (_body, _req, res) => {
    const overrides = readChannels();
    const refs = [];
    for (const config of [...Object.values(deps.builtins?.() ?? {}), ...Object.values(overrides.channels)]) {
      if (config.keyAlias) refs.push(config.keyAlias);
      if (config.keyEnv) refs.push(config.keyEnv);
    }
    const rows = await describeRefs(creds(), refs);
    sendJson(res, 200, { ok: true, credentials: rows, service: creds() !== void 0 });
  }));
  register("exact", "/api/busyloop/credential", route("POST", async (body, _req, res) => {
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    if (body.remove === true) {
      const result2 = await remove(creds(), ref);
      sendJson(res, result2.ok ? 200 : 400, result2);
      return;
    }
    const result = await store(creds(), ref, typeof body.value === "string" ? body.value : "");
    sendJson(res, result.ok ? 200 : 400, result);
  }));
}
var CHANNELS = {
  ark: {
    baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
    model: "deepseek-v4.1-flash",
    keyEnv: "ARK_API_KEY"
  },
  direct: {
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    keyEnv: "DEEPSEEK_API_KEY"
  }
};
function loadCustomChannels() {
  const { channels } = readChannels();
  const out = {};
  for (const [key, config] of Object.entries(channels)) {
    out[key] = {
      baseURL: config.baseURL,
      model: config.model,
      keyEnv: config.keyEnv,
      keyAlias: config.keyAlias,
      maxTokens: config.maxTokens,
      contextWindow: config.contextWindow,
      delayMs: config.delayMs,
      concurrency: config.concurrency
    };
  }
  return out;
}
function resolveChannel(channelKey, ctxLlm) {
  const custom = loadCustomChannels()[channelKey];
  if (custom) return custom;
  const builtin = CHANNELS[channelKey];
  if (builtin) return builtin;
  if (ctxLlm) {
    try {
      const providers = hostLlm(ctxLlm).listProviders();
      for (const p of providers) {
        const id = p?.id ?? String(p);
        if (id !== channelKey) continue;
        const anyP = p;
        const models = Array.isArray(anyP.models) ? anyP.models : [];
        const baseURL = String(anyP.baseURL ?? "");
        const model = String(anyP.model ?? models[0] ?? "");
        const keyEnv = String(anyP.keyEnv ?? anyP.apiKeyEnv ?? "");
        const win = Number(anyP.contextWindow) > 0 ? Number(anyP.contextWindow) : void 0;
        const firstModel = Array.isArray(anyP.models) ? anyP.models[0] : void 0;
        const modelWin = firstModel && Number(firstModel.contextWindow) > 0 ? Number(firstModel.contextWindow) : void 0;
        const pDelay = Number(anyP.delayMs) >= 0 ? Number(anyP.delayMs) : void 0;
        const pConc = Number(anyP.concurrency) > 0 ? Math.floor(Number(anyP.concurrency)) : void 0;
        if (baseURL && model && keyEnv) return { baseURL, model, keyEnv, contextWindow: win ?? modelWin, delayMs: pDelay, concurrency: pConc };
      }
    } catch {
    }
  }
  const available = Object.keys(CHANNELS).concat(Object.keys(loadCustomChannels()));
  throw new Error(
    `unknown channel "${channelKey}". Available channels: ${available.join(", ")} (custom channels: ~/.dsh/busyloop-channels.json)`
  );
}
function credentialsPath() {
  return `${join3(homedir3(), ".dsh", ".credentials.yaml")}`;
}
function loadKeyFromFile(keyEnv) {
  try {
    const creds = yaml.load(readFileSync3(credentialsPath(), "utf8"));
    return creds?.refs?.[keyEnv]?.value ?? creds?.refs?.[keyEnv] ?? creds?.[keyEnv];
  } catch {
    return void 0;
  }
}
function credentialsService(ctx) {
  const read = ctx?.get;
  if (typeof read !== "function") return void 0;
  try {
    const svc = read.call(ctx, "credentials");
    return svc && typeof svc.resolve === "function" ? svc : void 0;
  } catch {
    return void 0;
  }
}
async function resolveCredential(ctx, keyEnv, envOverride) {
  if (envOverride) return { value: envOverride, source: "env-override" };
  const svc = credentialsService(ctx);
  if (svc?.resolve) {
    try {
      const r = await svc.resolve(keyEnv);
      if (r && typeof r.value === "string" && r.value) return { value: r.value, source: "ctx.credentials" };
    } catch {
    }
  }
  const fromFile = loadKeyFromFile(keyEnv);
  return fromFile ? { value: fromFile, source: "file" } : void 0;
}
var runtimes = /* @__PURE__ */ new Map();
function getRuntime(channelKey, ctxLlm) {
  const channel = resolveChannel(channelKey, ctxLlm);
  let built = runtimes.get(channelKey);
  if (!built) {
    const ctx = new Context();
    const runtime = new LlmRuntime(ctx);
    const adapter = new DeepSeekAdapter({
      options: () => ({
        baseURL: channel.baseURL,
        apiKeyEnv: channel.keyEnv,
        defaults: {},
        maxTokens: channel.maxTokens ?? 2048,
        defaultContextWindow: 65536,
        models: [{ id: channel.model }],
        streamIdleTimeoutMs: 12e4,
        maxRequestFilesBytes: 0,
        maxInlineRequestImageBytes: 0,
        maxImagesPerRequest: 0,
        imageOffloadByteQuantum: 1,
        inlineImageOffloadByteQuantum: 1,
        imageOffloadCountQuantum: 1,
        filesApiTimeoutMs: 1e4
      }),
      resolveApiKey: async () => process.env[channel.keyEnv],
      resolveUserId: () => "dsh-busyloop"
    });
    ctx.llm.registerAdapter(["deepseek"], adapter);
    built = { llm: hostLlm(ctx.llm) };
    runtimes.set(channelKey, built);
  }
  return { llm: built.llm, channel };
}
var DISCIPLINE_SYSTEM = [
  "\u4F60\u662F\u6267\u884C\u5B50\u4EFB\u52A1\u7684 agent\u3002\u9075\u5B88\u4EE5\u4E0B\u5F00\u53D1\u7EAA\u5F8B(\u6E90\u81EA\u7ECF\u5178\u5DE5\u7A0B\u8457\u4F5C\u7684\u63D0\u70BC):",
  '1. \u547D\u540D\u8868\u8FBE\u610F\u56FE;\u51FD\u6570\u4FDD\u6301\u5355\u4E00\u804C\u8D23(\u8D85\u8FC7 ~20 \u884C\u6216\u80FD\u62C6\u51FA\u7B2C\u4E8C\u4E2A"\u505A"\u5B57\u5C31\u62C6);\u53C2\u6570 >2 \u9700\u7406\u7531\u3002',
  '2. \u6CE8\u91CA\u53EA\u5199"\u4E3A\u4EC0\u4E48",\u4E0D\u5199"\u4EC0\u4E48/\u600E\u4E48";\u4E0D\u4F20\u9012/\u4E0D\u8FD4\u56DE null;\u9519\u8BEF\u7528\u5F02\u5E38\u800C\u975E\u9519\u8BEF\u7801\u3002',
  "3. \u4EFB\u4F55\u884C\u4E3A\u53D8\u66F4\u5148\u5199/\u6539\u6D4B\u8BD5;\u6D4B\u8BD5\u65AD\u8A00\u884C\u4E3A,\u4E0D\u6D4B\u5B9E\u73B0\u7EC6\u8282\u3002",
  "4. \u91CD\u6784 = \u884C\u4E3A\u4E0D\u53D8\u7684\u7ED3\u6784\u8C03\u6574;\u5C0F\u6B65\u524D\u8FDB\u3001\u6BCF\u6B65\u53EF\u8FD0\u884C;\u529F\u80FD\u63D0\u4EA4\u4E0E\u91CD\u6784\u63D0\u4EA4\u5206\u79BB\u3002",
  "5. \u6D89\u53CA\u6570\u636E:\u6539 schema \u5FC5\u987B\u517C\u5BB9\u65E7\u6570\u636E(\u53CC\u5411\u517C\u5BB9);\u5199\u64CD\u4F5C\u9ED8\u8BA4\u9700\u5E42\u7B49(\u91CD\u590D/\u4E71\u5E8F\u662F\u5E38\u6001);\u5148\u4F30\u7B97\u8D1F\u8F7D\u518D\u5B9A\u65B9\u6848\u3002",
  "6. \u8BBE\u8BA1:\u5148\u6F84\u6E05\u9700\u6C42(\u529F\u80FD/\u975E\u529F\u80FD/\u89C4\u6A21/\u7EA6\u675F)\u518D\u51FA\u65B9\u6848;\u6BCF\u4E2A\u9009\u62E9\u663E\u5F0F\u6743\u8861;\u68C0\u67E5\u5355\u70B9\u6545\u969C\u4E0E\u964D\u7EA7\u8DEF\u5F84\u3002",
  "7. \u5148\u5B9A\u4E49\u4F53\u9A8C/\u884C\u4E3A\u76EE\u6807,\u518D\u5199\u5B9E\u73B0;\u539F\u578B\u5148\u884C;\u7B2C\u4E09\u6B21\u51FA\u73B0\u76F8\u540C\u7247\u6BB5\u624D\u62BD\u8C61,\u7981\u6B62\u590D\u5236\u7C98\u8D34\u53D8\u4F53\u3002",
  "8. \u5148\u6478\u6E05\u7ED3\u6784\u518D\u6DF1\u5165\u7EC6\u8282;\u5173\u952E\u63A8\u65AD\u8981\u9A8C\u8BC1;\u7ED3\u8BBA\u533A\u5206\u4E8B\u5B9E/\u63A8\u65AD/\u731C\u6D4B,\u4E0D\u628A\u731C\u6D4B\u5F53\u7ED3\u8BBA\u3002\u5927\u6587\u4EF6(>7000 \u884C\u6216 >256KB,1MB OCR \u2248 \u6709\u6548 256KB \u2248 7000 \u884C\u4EE3\u7801\u7B49\u4EF7)\u7981\u6B62 read \u6574\u8BFB:\u5148 grep \u63A2\u7ED3\u6784/\u5B9A\u4F4D,\u518D\u6309\u884C\u53F7\u8303\u56F4\u5206\u5757(300~800 \u884C)\u8BFB\u53D6;OCR \u5927\u6587\u4EF6\u6309\u7AE0\u8282\u5757\u62BD\u53D6;\u63D0\u53D6\u524D\u5148\u4F30\u7B97\u5168\u4E66 token \u9884\u7B97(\u884C\u6570\xD7\u5E73\u5747\u884C\u957F\xF73.7),\u8D85 256K \u7A97\u53E3\u65F6\u6309\u76EE\u6807\u7AE0\u8282\u63D0\u53D6\u3001\u7981\u6B62\u8D2A\u5168\u3002",
  "9. \u53EA\u901A\u8FC7\u53EF\u7528\u5DE5\u5177\u83B7\u5F97\u7ED3\u679C,\u4E0D\u81C6\u9020\u8F93\u51FA;\u5982\u5B9E\u6C47\u62A5\u6210\u529F\u4E0E\u5931\u8D25,\u4E0D\u63A9\u76D6\u9519\u8BEF\u3002"
].join("\n");
function sleep2(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveSystem(custom, discipline) {
  const customStr = typeof custom === "string" && custom.trim() ? custom : void 0;
  if (discipline === false) return customStr;
  if (customStr) return `${DISCIPLINE_SYSTEM}

${customStr}`;
  return DISCIPLINE_SYSTEM;
}
function readLlmService(ctx) {
  let candidate;
  try {
    candidate = typeof ctx?.get === "function" ? ctx.get("llm") : void 0;
  } catch {
    return void 0;
  }
  if (candidate && typeof candidate.listProviders === "function") {
    return candidate;
  }
  return void 0;
}
function registerBusyloopRun(ctx) {
  ctx.tools?.register(
    defineTool({
      name: "busyloop_run",
      description: "Run one one-off subagent loop on a cheap channel (default: Volcano Ark plan API with deepseek-v4.1-flash, billed to the ARK key \u2014 main-model tokens untouched). Returns the loop output plus turn/tool-call/usage stats. Use for disposable research, validation, formatting, or any task that does not need the main conversation context.",
      parameters: {
        prompt: {
          type: "string",
          description: "The task prompt for the sub-loop. Self-contained: it runs without access to this conversation.",
          required: true
        },
        channel: {
          type: "string",
          description: "Which LLM channel to use: ark (default) = Volcano Ark plan API (deepseek-v4.1-flash, ARK_API_KEY); direct = api.deepseek.com (deepseek-chat, DEEPSEEK_API_KEY); or any channel defined in ~/.dsh/busyloop-channels.json. Unknown channels error out listing the available ones."
        },
        system: {
          type: "string",
          description: "Optional system prompt for the sub-loop. When set, it is appended after the built-in discipline prompt (unless discipline is false)."
        },
        discipline: {
          type: "boolean",
          description: "Inject the built-in development-discipline system prompt (distilled from Clean Code/Refactoring/DDIA/SysDesign/game-design/reversing). Default true."
        },
        maxTurns: {
          type: "number",
          description: "Max loop turns before forced stop (default 8)."
        },
        maxTokens: {
          type: "number",
          description: "Max output tokens per generation (default 2048)."
        },
        reasoningEffort: {
          type: "string",
          enum: ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
          description: "Reasoning effort for this run (default: provider/channel default). Passed to the upstream API as reasoning_effort so the chat menu choice actually applies."
        },
        delayMs: {
          type: "number",
          description: "Throttle: ms to wait before EVERY LLM generation (per-turn pacing, anti rate-limit). Per-call value overrides the channel default; 0 = no delay. One router key can serve models with different limits \u2014 pass the right value for THIS model on the spot, nothing is hard-coded."
        },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Optional batch: array of task prompts, each runs its own full loop on the same channel/model/settings. Results come back as an array with per-task output/error. Without tasks, single-prompt mode (prompt) applies."
        },
        concurrency: {
          type: "number",
          description: "Batch concurrency: how many tasks run in parallel (default 1 = serial; channel config supplies the fallback). Combine with delayMs to pace a burst across the same key."
        }
      },
      output: {
        schema: { type: "string" },
        render: (_args, value) => [{ type: "text", text: value }]
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(args, exec) {
        const channelKey = String(args.channel ?? "ark");
        const usableLlm = readLlmService(ctx);
        let channel;
        try {
          channel = resolveChannel(channelKey, usableLlm);
        } catch (err) {
          return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        const { llm } = getRuntime(channelKey, usableLlm);
        let credential = channel.keyAlias ? await resolveCredential(ctx, channel.keyAlias, void 0) : void 0;
        if (!credential) {
          credential = await resolveCredential(ctx, channel.keyEnv, process.env[channel.keyEnv]);
        }
        const resolved = resolveEffectiveKey(
          () => credential?.value,
          channel.keyEnv,
          channelKey
        );
        const key = resolved.key;
        if (!key) {
          const tried = channel.keyAlias ? `"${channel.keyAlias}" (the channel's keyAlias), "${channel.keyEnv}", env ${channel.keyEnv}` : `"${channel.keyEnv}" and env ${channel.keyEnv}`;
          return JSON.stringify({
            ok: false,
            error: `No credential found for channel "${channelKey}": tried ${tried} via ctx.credentials, plus ${credentialsPath()} as a legacy fallback. Set one in the settings panel (Settings -> busyloop).`
          });
        }
        process.env[channel.keyEnv] = key;
        const keyUsed = resolved.alias ? `${resolved.alias}(${resolved.masked})` : resolved.masked ?? "unknown";
        const delayMs = args.delayMs !== void 0 && Number(args.delayMs) >= 0 ? Number(args.delayMs) : channel.delayMs ?? 0;
        const concurrency = args.concurrency !== void 0 && Number(args.concurrency) >= 1 ? Math.max(1, Math.floor(Number(args.concurrency))) : channel.concurrency ?? 1;
        const sysText = resolveSystem(args.system, args.discipline);
        const runOne = async (rawPrompt) => {
          let prompt = rawPrompt;
          let maxTokens = args.maxTokens ? Number(args.maxTokens) : void 0;
          let budgetNote;
          const win = channel.contextWindow;
          if (win && win > 0) {
            const inputEst = Math.ceil((rawPrompt.length + (sysText ?? "").length) / 3);
            if (inputEst > win * 0.85) {
              const keep = Math.floor(rawPrompt.length * 0.85);
              const head = Math.floor(keep * 0.5);
              prompt = rawPrompt.slice(0, head) + "\n\n...[truncated by busyloop window budget]...\n\n" + rawPrompt.slice(rawPrompt.length - (keep - head));
              budgetNote = `prompt truncated: ~${inputEst} tokens estimated vs ${win} window`;
            }
            const requested = maxTokens ?? channel.maxTokens ?? 2048;
            const headroom = win - Math.ceil(inputEst * 1.2) - 1024;
            if (requested > headroom) {
              const capped = Math.max(256, headroom);
              maxTokens = Math.min(requested, capped);
              budgetNote = budgetNote ? `${budgetNote}; ` : "";
              budgetNote += `maxTokens capped ${requested} -> ${maxTokens} (window ${win})`;
            }
          }
          try {
            const result = await runBusyLoop(llm, {
              provider: "deepseek",
              model: channel.model,
              prompt,
              system: sysText,
              maxTurns: args.maxTurns ? Number(args.maxTurns) : void 0,
              maxTokens,
              reasoningEffort: args.reasoningEffort ? String(args.reasoningEffort) : void 0,
              delayMs,
              signal: exec?.signal,
              sessionId: "busyloop-tools"
            });
            const note = !result.output && result.finish === "length" ? `empty output: maxTokens exhausted before any content \u2014 thinking models spend tokens on reasoning_content first; raise maxTokens (current: ${args.maxTokens ?? channel.maxTokens ?? 2048}) or switch to a non-thinking model` : void 0;
            return {
              ok: true,
              output: result.output,
              turns: result.turns,
              toolCalls: result.toolCalls,
              finish: result.finish,
              usage: result.usage ?? null,
              ...note ? { outputNote: note } : {},
              ...budgetNote ? { budgetNote } : {}
            };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        };
        const tasks = Array.isArray(args.tasks) && args.tasks.length > 0 ? args.tasks.map((t) => String(t)) : void 0;
        if (!tasks) {
          const r = await runOne(String(args.prompt));
          return JSON.stringify({ channel: channelKey, model: channel.model, key: keyUsed, ...r });
        }
        const results = [];
        let next = 0;
        const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
          while (next < tasks.length) {
            const i = next++;
            await sleep2(delayMs);
            const r = await runOne(tasks[i]);
            results[i] = { index: i, ...r };
          }
        });
        await Promise.all(workers);
        return JSON.stringify({
          ok: true,
          channel: channelKey,
          model: channel.model,
          key: keyUsed,
          batch: true,
          tasks: tasks.length,
          concurrency,
          delayMs,
          results
        });
      }
    })
  );
}
function apply(ctx) {
  ctx.inject?.(["webServer"], (webCtx) => {
    const register = (kind, path, handler) => {
      webCtx.webServer.register({ kind, path, handler });
    };
    const deps = {
      // Same verified reader the tool uses — one rule, one implementation (see readLlmService).
      // A getter, not a value: the service is resolved per request, so a host that registers `llm`
      // after this plugin mounts still works.
      get llm() {
        return readLlmService(ctx);
      },
      // The settings panel needs the credential service and the built-in channel table. Both are
      // read the same lazy, guarded way as `llm` above — a bare `ctx.credentials` would take the
      // whole effect down (and the throw would be swallowed), leaving the panel routes unregistered.
      credentials: () => credentialsFrom(ctx),
      builtins: () => CHANNELS
    };
    const rejected = createRequestFence(ctx);
    const mount = () => registerHttpRoutes({ ...deps, rejected }, register);
    if (typeof webCtx.effect === "function") webCtx.effect(mount, "dsh-busyloop: /api/busyloop/{health,providers,channels,test,credentials}");
    else mount();
  });
  registerBusyloopRun(ctx);
}
function createBusyLoop(ctx) {
  const llm = hostLlm(ctx.llm);
  return {
    llm,
    run: (opts) => runBusyLoop(llm, opts),
    health: () => ({ ok: true, plugin: name })
  };
}
export {
  DISCIPLINE_SYSTEM,
  apply,
  createBusyLoop,
  describeRefs as describeCredentialRefs,
  description,
  hostLlm,
  inject,
  mask as maskCredential,
  name,
  readChannels as readChannelConfig,
  readLlmService,
  registerHttpRoutes,
  remove as removeCredential,
  resolveCredential,
  runBusyLoop,
  store as storeCredential,
  writeChannel as writeChannelConfig
};
