// src/index.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
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
import { randomUUID } from "node:crypto";
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
function writeStore(entries) {
  mkdirSync(DSH_HOME, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify(entries, null, 2), "utf8");
  try {
    chmodSync(KEY_FILE, 384);
  } catch {
  }
}
function maskKey(key) {
  if (key.length <= 10) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
function listKeys() {
  const entries = readStore();
  const active = readActiveAlias();
  return entries.map((e) => ({ id: e.id, alias: e.alias, scope: e.scope, channel: e.channel, createdAt: e.createdAt, masked: maskKey(e.key), active: e.alias === active }));
}
function addKey(alias, key, scope, channel) {
  const cleanAlias = alias.trim();
  const cleanKey = key.trim();
  const cleanChannel = channel?.trim() || void 0;
  if (!cleanAlias) throw new Error("alias must not be empty");
  if (!cleanKey) throw new Error("key must not be empty");
  if (cleanKey.length < 8) throw new Error("key too short (min 8 chars)");
  const entries = readStore();
  if (entries.some((e) => e.alias === cleanAlias)) {
    const updated = entries.map((e) => e.alias === cleanAlias ? { ...e, key: cleanKey, scope, channel: cleanChannel } : e);
    writeStore(updated);
    return updated.find((e) => e.alias === cleanAlias);
  }
  const entry = { id: randomUUID(), alias: cleanAlias, key: cleanKey, scope, channel: cleanChannel, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeStore([...entries, entry]);
  return entry;
}
function removeKey(alias) {
  const entries = readStore();
  const next = entries.filter((e) => e.alias !== alias);
  if (next.length === entries.length) return false;
  writeStore(next);
  if (readActiveAlias() === alias) clearActiveAlias();
  return true;
}
function readActiveAlias() {
  try {
    if (!existsSync(ACTIVE_FILE)) return void 0;
    return JSON.parse(readFileSync(ACTIVE_FILE, "utf8"))?.alias;
  } catch {
    return void 0;
  }
}
function writeActiveAlias(alias) {
  mkdirSync(DSH_HOME, { recursive: true });
  writeFileSync(ACTIVE_FILE, JSON.stringify({ alias }, null, 2), "utf8");
  try {
    chmodSync(ACTIVE_FILE, 384);
  } catch {
  }
}
function clearActiveAlias() {
  try {
    writeFileSync(ACTIVE_FILE, JSON.stringify({ alias: null }, null, 2), "utf8");
  } catch {
  }
}
function useKey(alias) {
  const entry = readStore().find((e) => e.alias === alias);
  if (!entry) throw new Error(`no key registered under alias "${alias}"`);
  if (entry.scope !== "chat") throw new Error(`key "${alias}" is scope=${entry.scope}; only chat-scope keys can be selected from the chat`);
  writeActiveAlias(alias);
  return { ok: true, alias: entry.alias, masked: maskKey(entry.key) };
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
}
var CHANNELS = {
  ark: {
    baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
    model: "deepseek-v4-flash",
    keyEnv: "ARK_API_KEY"
  },
  direct: {
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    keyEnv: "DEEPSEEK_API_KEY"
  }
};
function loadCustomChannels() {
  try {
    const file = process.env.DSH_BUSYLOOP_CHANNELS ?? join2(homedir2(), ".dsh", "busyloop-channels.json");
    const raw = JSON.parse(readFileSync2(file, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (v && typeof v.baseURL === "string" && typeof v.model === "string" && typeof v.keyEnv === "string") {
        out[k] = {
          baseURL: v.baseURL,
          model: v.model,
          keyEnv: v.keyEnv,
          maxTokens: typeof v.maxTokens === "number" && v.maxTokens > 0 ? v.maxTokens : void 0,
          contextWindow: typeof v.contextWindow === "number" && v.contextWindow > 0 ? v.contextWindow : void 0,
          delayMs: typeof v.delayMs === "number" && v.delayMs >= 0 ? v.delayMs : void 0,
          concurrency: typeof v.concurrency === "number" && v.concurrency > 0 ? Math.floor(v.concurrency) : void 0
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}
function resolveChannel(channelKey, ctxLlm) {
  const builtin = CHANNELS[channelKey];
  if (builtin) return builtin;
  const custom = loadCustomChannels()[channelKey];
  if (custom) return custom;
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
  return `${join2(homedir2(), ".dsh", ".credentials.yaml")}`;
}
function loadKeyFromFile(keyEnv) {
  try {
    const creds = yaml.load(readFileSync2(credentialsPath(), "utf8"));
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
function registerBusyloopRun(ctx) {
  ctx.tools?.register(
    defineTool({
      name: "busyloop_run",
      description: "Run one one-off subagent loop on a cheap channel (default: Volcano Ark plan API with deepseek-v4-flash, billed to the ARK key \u2014 main-model tokens untouched). Returns the loop output plus turn/tool-call/usage stats. Use for disposable research, validation, formatting, or any task that does not need the main conversation context.",
      parameters: {
        prompt: {
          type: "string",
          description: "The task prompt for the sub-loop. Self-contained: it runs without access to this conversation.",
          required: true
        },
        channel: {
          type: "string",
          description: "Which LLM channel to use: ark (default) = Volcano Ark plan API (deepseek-v4-flash, ARK_API_KEY); direct = api.deepseek.com (deepseek-chat, DEEPSEEK_API_KEY); or any channel defined in ~/.dsh/busyloop-channels.json. Unknown channels error out listing the available ones."
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
        let llmCtx;
        try {
          const maybe = ctx.llm;
          if (maybe && typeof maybe.listProviders === "function") {
            llmCtx = maybe;
          }
        } catch {
          llmCtx = void 0;
        }
        let channel;
        try {
          channel = resolveChannel(channelKey, llmCtx);
        } catch (err) {
          return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        const { llm } = getRuntime(channelKey, llmCtx);
        const credential = await resolveCredential(ctx, channel.keyEnv, process.env[channel.keyEnv]);
        const resolved = resolveEffectiveKey(
          () => credential?.value,
          channel.keyEnv,
          channelKey
        );
        const key = resolved.key;
        if (!key) {
          return JSON.stringify({
            ok: false,
            error: `No ${channel.keyEnv} found for channel "${channelKey}" (checked session keys, env, ctx.credentials and ${credentialsPath()})`
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
function registerKeyTools(ctx) {
  const reg = ctx.tools?.register?.bind(ctx.tools);
  if (!reg) return;
  reg(defineTool({
    name: "busyloop_key_add",
    description: "Register a per-session API key for busyloop_run (stored in ~/.dsh/busyloop-keys.json, 0600; NEVER written to env or global credentials). chat scope = selectable from this chat; subagent scope = reserved for subagent loops. Returns masked alias only.",
    parameters: {
      alias: { type: "string", description: "Short label, e.g. alice-ark", required: true },
      key: { type: "string", description: "The API key (min 8 chars)", required: true },
      scope: { type: "string", description: "chat (default) or subagent" },
      channel: { type: "string", description: "Optional channel this key is bound to (ark/direct/custom name). When set, busyloop_run only uses this key for that channel \u2014 wrong-channel keys never leak into a call." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(args) {
      try {
        const scope = args.scope === "subagent" ? "subagent" : "chat";
        const entry = addKey(String(args.alias), String(args.key), scope, args.channel ? String(args.channel) : void 0);
        return JSON.stringify({ ok: true, alias: entry.alias, scope: entry.scope, masked: maskKey(entry.key) });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }));
  reg(defineTool({
    name: "busyloop_key_list",
    description: "List registered busyloop keys: alias + masked tail only (never the full key). Marks the currently active chat-scope key.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    async execute() {
      return JSON.stringify({ ok: true, keys: listKeys() });
    }
  }));
  reg(defineTool({
    name: "busyloop_key_remove",
    description: "Remove a registered busyloop key by alias.",
    parameters: {
      alias: { type: "string", description: "Alias of the key to remove", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(args) {
      const removed = removeKey(String(args.alias));
      return JSON.stringify({ ok: removed, removed: removed ? String(args.alias) : null });
    }
  }));
  reg(defineTool({
    name: "busyloop_key_use",
    description: "Select a chat-scope busyloop key for THIS conversation: subsequent busyloop_run calls bill to it. Only chat-scope keys can be selected. Shows masked tail.",
    parameters: {
      alias: { type: "string", description: "Alias of the chat-scope key to activate", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(args) {
      try {
        const info = useKey(String(args.alias));
        return JSON.stringify({ ...info });
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }));
}
function apply(ctx) {
  ctx.inject?.(["webServer"], (webCtx) => {
    const register = (kind, path, handler) => {
      webCtx.webServer.register({ kind, path, handler });
    };
    const deps = {
      get llm() {
        try {
          return typeof ctx.get === "function" ? ctx.get("llm") : void 0;
        } catch {
          return void 0;
        }
      }
    };
    const rejected = createRequestFence(ctx);
    const mount = () => registerHttpRoutes({ ...deps, rejected }, register);
    if (typeof webCtx.effect === "function") webCtx.effect(mount, "dsh-busyloop: /api/busyloop/{health,providers}");
    else mount();
  });
  registerBusyloopRun(ctx);
  registerKeyTools(ctx);
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
  description,
  hostLlm,
  inject,
  name,
  registerHttpRoutes,
  resolveCredential,
  runBusyLoop
};
