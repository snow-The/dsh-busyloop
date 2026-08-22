import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Hono } from 'hono'
import yaml from 'js-yaml'
import { hostLlm } from './llm.ts'
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
          description: 'Optional system prompt for the sub-loop.',
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
        const key = loadKey(channel.keyEnv)
        if (!key) {
          return JSON.stringify({
            ok: false,
            error: `No ${channel.keyEnv} found (checked env and ${credentialsPath()})`,
          })
        }
        process.env[channel.keyEnv] = key

        try {
          const result = await runBusyLoop(llm, {
            provider: 'deepseek',
            model: channel.model,
            prompt: String(args.prompt),
            system: args.system ? String(args.system) : undefined,
            maxTurns: args.maxTurns ? Number(args.maxTurns) : undefined,
            maxTokens: args.maxTokens ? Number(args.maxTokens) : undefined,
            signal: exec?.signal,
            sessionId: 'busyloop-tools',
          })
          return JSON.stringify({
            ok: true,
            channel: channelKey,
            model: channel.model,
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
