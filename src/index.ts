import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Hono } from 'hono'
import yaml from 'js-yaml'
import { hostLlm } from './llm.ts'
import * as keyStore from './keys.ts'
import { runBusyLoop } from './loop.ts'
import type { HostLlm } from './llm.ts'
import type { BusyLoopOptions, LoopEvent, LoopResult, LoopTool } from './types.ts'

export const name = 'dsh-busyloop'
/**
 * cordis rule (crash lesson, 0.1.6): reading a REGISTERED service property off
 * ctx (e.g. ctx.tools) THROWS "cannot get property X without inject" unless the
 * service is declared here — optional chaining does NOT help (the proxy get
 * trap throws). ctx.http/ctx.llm are intentionally NOT declared: on this host
 * they are absent (read yields undefined) or only reached in guarded callbacks.
 */
export const inject = ['tools']
export const description =
  'DSH agent-loop engine: host-LLM adapter (official ctx.llm channel) + lightweight loop skeleton + agent tool busyloop_run (one-off tasks on a chosen channel — Volcano Ark plan API by default — main-model tokens untouched). Capability layer — codex style is opt-in via dsh-busyloop-codexstyle.'

/** Standalone Hono app (mounted by apply() under /api/busyloop). */
export function createHonoApp(deps?: { llm?: Parameters<typeof hostLlm>[0] }): Hono {
  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true, plugin: name, engine: true, hostLlm: true }))
  app.get('/providers', (c) => {
    if (!deps?.llm) return c.json({ providers: [] })
    try {
      const providers = hostLlm(deps.llm)
        .listProviders()
        .map((p) => ({ id: (p as unknown as { id?: string }).id ?? String(p) }))
      return c.json({ providers })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })
  return app
}

/* ------------------------------------------------------------------ */
/* Agent-facing tool: busyloop_run — one-off loops on a chosen channel */
/* ------------------------------------------------------------------ */

interface Channel {
  baseURL: string
  model: string
  keyEnv: string
}

const CHANNELS: Record<'ark' | 'direct', Channel> = {
  ark: {
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'deepseek-v4-flash',
    keyEnv: 'ARK_API_KEY',
  },
  direct: {
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
}

function credentialsPath(): string {
  return `${process.env.USERPROFILE ?? ''}\\.dsh\\.credentials.yaml`
}

function loadKey(keyEnv: string): string | undefined {
  // Env wins (test/debug override), then ~/.dsh/.credentials.yaml.
  if (process.env[keyEnv]) return process.env[keyEnv]
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const creds: any = yaml.load(readFileSync(credentialsPath(), 'utf8'))
    return creds?.refs?.[keyEnv]?.value ?? creds?.refs?.[keyEnv] ?? creds?.[keyEnv]
  } catch {
    return undefined
  }
}

// One shared runtime per channel, built on first use.
const runtimes = new Map<'ark' | 'direct', { llm: HostLlm }>()

function getRuntime(channelKey: keyof typeof CHANNELS): { llm: HostLlm; channel: Channel } {
  const channel = CHANNELS[channelKey]
  let built = runtimes.get(channelKey)
  if (!built) {
    const ctx = new Context()
    const runtime = new LlmRuntime(ctx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new DeepSeekAdapter({
      options: () => ({
        baseURL: channel.baseURL,
        apiKeyEnv: channel.keyEnv,
        defaults: {},
        maxTokens: 2048,
        defaultContextWindow: 65536,
        models: [{ id: channel.model }],
        streamIdleTimeoutMs: 120000,
        maxRequestFilesBytes: 0,
        maxInlineRequestImageBytes: 0,
        maxImagesPerRequest: 0,
        imageOffloadByteQuantum: 1,
        inlineImageOffloadByteQuantum: 1,
        imageOffloadCountQuantum: 1,
        filesApiTimeoutMs: 10000,
      }),
      resolveApiKey: async () => process.env[channel.keyEnv],
      resolveUserId: () => 'dsh-busyloop',
    } as never)
    ctx.llm.registerAdapter(['deepseek'], adapter)
    built = { llm: hostLlm(ctx.llm) }
    runtimes.set(channelKey, built)
  }
  return { llm: built.llm, channel }
}

/**
 * Built-in discipline system prompt for sub-loops (distilled from classic
 * engineering books: Clean Code / Refactoring / DDIA / System Design
 * Interview / game-design practices / reverse-engineering methodology).
 * Injected by default; opt out with discipline:false or override with system.
 */
export const DISCIPLINE_SYSTEM = [
  '你是执行子任务的 agent。遵守以下开发纪律(源自经典工程著作的提炼):',
  '1. 命名表达意图;函数保持单一职责(超过 ~20 行或能拆出第二个"做"字就拆);参数 >2 需理由。',
  '2. 注释只写"为什么",不写"什么/怎么";不传递/不返回 null;错误用异常而非错误码。',
  '3. 任何行为变更先写/改测试;测试断言行为,不测实现细节。',
  '4. 重构 = 行为不变的结构调整;小步前进、每步可运行;功能提交与重构提交分离。',
  '5. 涉及数据:改 schema 必须兼容旧数据(双向兼容);写操作默认需幂等(重复/乱序是常态);先估算负载再定方案。',
  '6. 设计:先澄清需求(功能/非功能/规模/约束)再出方案;每个选择显式权衡;检查单点故障与降级路径。',
  '7. 先定义体验/行为目标,再写实现;原型先行;第三次出现相同片段才抽象,禁止复制粘贴变体。',
  '8. 先摸清结构再深入细节;关键推断要验证;结论区分事实/推断/猜测,不把猜测当结论。大文件(>7000 行或 >256KB,1MB OCR ≈ 有效 256KB ≈ 7000 行代码等价)禁止 read 整读:先 grep 探结构/定位,再按行号范围分块(300~800 行)读取;OCR 大文件按章节块抽取;提取前先估算全书 token 预算(行数×平均行长÷3.7),超 256K 窗口时按目标章节提取、禁止贪全。',
  '9. 只通过可用工具获得结果,不臆造输出;如实汇报成功与失败,不掩盖错误。',
].join('\n')

/** Merge the caller's system prompt with the built-in discipline prompt. */
function resolveSystem(custom: unknown, discipline: unknown): string | undefined {
  const customStr = typeof custom === 'string' && custom.trim() ? custom : undefined
  if (discipline === false) return customStr
  if (customStr) return `${DISCIPLINE_SYSTEM}\n\n${customStr}`
  return DISCIPLINE_SYSTEM
}

function registerBusyloopRun(ctx: { tools?: { register: (def: unknown) => unknown } }): void {
  ctx.tools?.register(
    defineTool({
      name: 'busyloop_run',
      description:
        'Run one one-off subagent loop on a cheap channel (default: Volcano Ark plan API with deepseek-v4-flash, billed to the ARK key — main-model tokens untouched). Returns the loop output plus turn/tool-call/usage stats. Use for disposable research, validation, formatting, or any task that does not need the main conversation context.',
      parameters: {
        prompt: {
          type: 'string',
          description: 'The task prompt for the sub-loop. Self-contained: it runs without access to this conversation.',
          required: true,
        },
        channel: {
          type: 'string',
          description: 'Which LLM channel to use. ark (default) = Volcano Ark plan API, deepseek-v4-flash, ARK_API_KEY; direct = api.deepseek.com, deepseek-chat, DEEPSEEK_API_KEY.',
        },
        system: {
          type: 'string',
          description: 'Optional system prompt for the sub-loop. When set, it is appended after the built-in discipline prompt (unless discipline is false).',
        },
        discipline: {
          type: 'boolean',
          description: 'Inject the built-in development-discipline system prompt (distilled from Clean Code/Refactoring/DDIA/SysDesign/game-design/reversing). Default true.',
        },
        maxTurns: {
          type: 'number',
          description: 'Max loop turns before forced stop (default 8).',
        },
        maxTokens: {
          type: 'number',
          description: 'Max output tokens per generation (default 2048).',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(args: any, exec: any) {
        const channelKey: 'ark' | 'direct' = args.channel === 'direct' ? 'direct' : 'ark'
        const { llm, channel } = getRuntime(channelKey)
        const resolved = keyStore.resolveEffectiveKey(loadKey, channel.keyEnv)
        const key = resolved.key
        if (!key) {
          return JSON.stringify({
            ok: false,
            error: `No ${channel.keyEnv} found (checked session keys, env and ${credentialsPath()})`,
          })
        }
        process.env[channel.keyEnv] = key
        const keyUsed = resolved.alias ? `${resolved.alias}(${resolved.masked})` : resolved.masked ?? 'unknown'

        try {
          const result = await runBusyLoop(llm, {
            provider: 'deepseek',
            model: channel.model,
            prompt: String(args.prompt),
            system: resolveSystem(args.system, args.discipline),
            maxTurns: args.maxTurns ? Number(args.maxTurns) : undefined,
            maxTokens: args.maxTokens ? Number(args.maxTokens) : undefined,
            signal: exec?.signal,
            sessionId: 'busyloop-tools',
          })
          return JSON.stringify({
            ok: true,
            channel: channelKey,
            model: channel.model,
            key: keyUsed,
            output: result.output,
            turns: result.turns,
            toolCalls: result.toolCalls,
            finish: result.finish,
            usage: result.usage ?? null,
          })
        } catch (err) {
          return JSON.stringify({
            ok: false,
            channel: channelKey,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    }),
  )
}

function registerKeyTools(ctx: { tools?: { register: (def: unknown) => unknown } }): void {
  // NOTE: register is a class method using `this.layers` — must keep `this` bound.
  const reg = ctx.tools?.register?.bind(ctx.tools)
  if (!reg) return
  reg(defineTool({
    name: 'busyloop_key_add',
    description: 'Register a per-session API key for busyloop_run (stored in ~/.dsh/busyloop-keys.json, 0600; NEVER written to env or global credentials). chat scope = selectable from this chat; subagent scope = reserved for subagent loops. Returns masked alias only.',
    parameters: {
      alias: { type: 'string', description: 'Short label, e.g. alice-ark', required: true },
      key: { type: 'string', description: 'The API key (min 8 chars)', required: true },
      scope: { type: 'string', description: 'chat (default) or subagent' },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(args: any) {
      try {
        const scope = args.scope === 'subagent' ? 'subagent' : 'chat'
        const entry = keyStore.addKey(String(args.alias), String(args.key), scope)
        return JSON.stringify({ ok: true, alias: entry.alias, scope: entry.scope, masked: keyStore.maskKey(entry.key) })
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))
  reg(defineTool({
    name: 'busyloop_key_list',
    description: 'List registered busyloop keys: alias + masked tail only (never the full key). Marks the currently active chat-scope key.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    async execute() {
      return JSON.stringify({ ok: true, keys: keyStore.listKeys() })
    },
  }))
  reg(defineTool({
    name: 'busyloop_key_remove',
    description: 'Remove a registered busyloop key by alias.',
    parameters: {
      alias: { type: 'string', description: 'Alias of the key to remove', required: true },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(args: any) {
      const removed = keyStore.removeKey(String(args.alias))
      return JSON.stringify({ ok: removed, removed: removed ? String(args.alias) : null })
    },
  }))
  reg(defineTool({
    name: 'busyloop_key_use',
    description: 'Select a chat-scope busyloop key for THIS conversation: subsequent busyloop_run calls bill to it. Only chat-scope keys can be selected. Shows masked tail.',
    parameters: {
      alias: { type: 'string', description: 'Alias of the chat-scope key to activate', required: true },
    },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async execute(args: any) {
      try {
        const info = keyStore.useKey(String(args.alias))
        return JSON.stringify({ ...info })
      } catch (err) {
        return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }))
}

/**
 * Plugin entry: mount health/providers endpoints + register the agent tool.
 * ctx.tools is optional — hosts without a tool registry still get the engine.
 */
export function apply(ctx: {
  http?: { mount?: (path: string, app: unknown) => unknown }
  llm?: Parameters<typeof hostLlm>[0]
  tools?: { register: (def: unknown) => unknown }
}): void {
  try {
    ctx.http?.mount?.('/api/busyloop', createHonoApp({ llm: ctx.llm }))
  } catch {
    /* host without http mount: engine still usable as library */
  }
  registerBusyloopRun(ctx)
  registerKeyTools(ctx)
}

/** Wrap the host ctx into a ready-to-use engine handle. */
export function createBusyLoop(ctx: {
  llm: Parameters<typeof hostLlm>[0]
}): {
  llm: HostLlm
  run: (opts: BusyLoopOptions) => Promise<LoopResult>
  health: () => { ok: boolean; plugin: string }
} {
  const llm = hostLlm(ctx.llm)
  return {
    llm,
    run: (opts) => runBusyLoop(llm, opts),
    health: () => ({ ok: true, plugin: name }),
  }
}

export { hostLlm } from './llm.ts'
export { runBusyLoop } from './loop.ts'
export type { HostLlm, LlmServiceLike } from './llm.ts'
export type { BusyLoopOptions, LoopEvent, LoopResult, LoopTool } from './types.ts'
