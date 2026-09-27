import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import yaml from 'js-yaml'
import { hostLlm } from './llm.ts'
import * as keyStore from './keys.ts'
import {
  channelsPath,
  normaliseChannel,
  readChannels,
  writeChannel,
  type ChannelConfig,
} from './panel.ts'
import {
  credentialsFrom,
  describeRefs,
  mask,
  remove as removeCredential,
  resolveValue,
  store as storeCredential,
  type CredentialsService,
} from './credentials.ts'
import { runBusyLoop } from './loop.ts'
import type { HostLlm } from './llm.ts'
import type { BusyLoopOptions, LoopEvent, LoopResult, LoopTool } from './types.ts'

export const name = 'dsh-busyloop'

/* ------------------------------------------------------------------ */
/* Exported for tests + the panel contract (this repo's convention:   */
/* runBusyLoop/hostLlm are exported the same way). The panel routes   */
/* are exercised directly, so their helpers must be reachable.        */
/* ------------------------------------------------------------------ */

/** Read the panel's channel overrides (also read by the call path — one validator, one merge rule). */
export { readChannels as readChannelConfig, writeChannel as writeChannelConfig } from './panel.ts'
export type { ChannelConfig } from './panel.ts'
export {
  mask as maskCredential,
  describeRefs as describeCredentialRefs,
  store as storeCredential,
  remove as removeCredential,
} from './credentials.ts'

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

/**
 * HTTP 路由: /health 与 /providers。
 *
 * 为什么不再是 Hono app: DSH 的 web 层本来就是 **node:http**, 官方 web-server 的
 * handler 拿的是原生 IncomingMessage/ServerResponse —— 官方不依赖 hono, 也没有
 * Node↔Fetch 桥(见 dsh 源码 host/open-in-app/src/index.ts:193-204 的官方写法)。
 * 原先这里返回一个 Hono app 供 `ctx.http?.mount?.()` 挂载, 而 **`ctx.http` 不是 DSH
 * 的服务**(官方 90 个 ctx.* 里没有它), 所以那两条路由从未生效。
 *
 * 现在按官方范式直接写 res, 不引入任何桥。
 */
/**
 * Apply the official Host/Origin + browser-auth fence to one plugin's health routes.
 *
 * SOURCE — copied from the official DSH 0.1.7-rc.2 package `@deepseek-ai/dsh-host-open-in-app`,
 * which states the contract in its own module comment
 * (`lib/types/index.js:1-21`): "Security has one home, here. **Every route** asks the
 * composition's `connection` service for a rejection first (`requestRejection`): its Host/Origin
 * fence defeats DNS rebinding and cross-site calls, and its browser authentication (the
 * login-token cookie) gates every caller". The helper shape is `lib/index.js:1263-1270` and its
 * use is the first line of every handler there (`lib/index.js:1274-1275`).
 *
 * `requestRejection` itself (`dsh-client-connection/lib/index.js:586-589`):
 *   403 -> the Host is not loopback/trusted, or `sec-fetch-site: cross-site`, or Origin != Host
 *   401 -> the fence passed but there is no valid login-token cookie
 * so an anonymous request gets 401 and a forged one gets 403. Authentication accepts the
 * `dsh-auth-*` cookie ONLY (minted by the 303 set-cookie on `GET /?token=...`); the boot token
 * itself does not authenticate an API call. A browser that loaded the page first is unaffected.
 *
 * DO NOT "simplify" this away, and do not replace the read with `Reflect.get(ctx, 'connection')`.
 * The official helper is written that way because its own plugin declares `inject: ['connection']`;
 * from a plugin that does not, MEASURED on a live 127.0.0.1 instance, BOTH
 * `ctx.connection` AND `Reflect.get(ctx, 'connection')` throw
 * `cannot get property "connection" without inject` (cordis's proxy get-trap throws before any
 * optional chaining can help), while `ctx.get('connection')` returned the live
 * `HostConnectionService` with `requestRejection` present. `ctx.get` is also the official
 * inject-free service read — `dsh-web-app/lib/index.js:216` gates the ready banner on
 * `connectionCtx.get("connection") !== void 0`.
 *
 * FAIL-CLOSED. When the service is unreachable the request is answered 503, never forwarded:
 * silently serving would reopen exactly the hole this helper exists to close. In this profile
 * the branch is unreachable by construction — the route only registers under
 * `ctx.inject(['webServer'])`, and every composition that has `webServer` also carries
 * `connection` (`dsh-web-app/cordis.patch.yml:210-217` registers it beside the webserver).
 *
 * Each plugin carries its OWN copy on purpose: they are independent packages, and a shared
 * module would create a new deployment coupling (the ACP-graph contract already showed what
 * that costs, with 5 copies to re-sync on every edit).
 */

/** Just enough of the official HostConnectionService for the fence call. */
interface RequestFenceConnection {
  /** @returns 401/403 when the request must be refused, `undefined` when it may proceed. */
  requestRejection: (request: IncomingMessage) => number | undefined
}

/**
 * Build the fence for one plugin life.
 *
 * @param ctx - the plugin's context; only `get` is used, and only at call time.
 * @returns true when the request was answered by the fence and the handler must stop.
 */
function createRequestFence(ctx: unknown): (req: IncomingMessage, res: ServerResponse) => boolean {
  /** Read the service without declaring `inject` — see the read note above for why not Reflect.get. */
  const resolveConnection = (): RequestFenceConnection | undefined => {
    const read = (ctx as { get?: (name: string) => unknown } | null | undefined)?.get
    if (typeof read !== 'function') return undefined
    try {
      const connection = read.call(ctx, 'connection') as RequestFenceConnection | undefined
      return typeof connection?.requestRejection === 'function' ? connection : undefined
    } catch {
      return undefined
    }
  }

  return (req, res) => {
    const connection = resolveConnection()
    if (connection === undefined) {
      // Fail closed: an unreachable fence must not become an open route.
      res.statusCode = 503
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'connection service unavailable: the Host/Origin fence cannot be applied' }))
      return true
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
}

export function registerHttpRoutes(
  deps: {
    llm?: Parameters<typeof hostLlm>[0]
    rejected?: (req: IncomingMessage, res: ServerResponse) => boolean
    /** Host credential service, read lazily off ctx. Absent = this host has none. */
    credentials?: () => CredentialsService | undefined
    /** Built-in channels, as a getter so the panel reports exactly what a call would resolve. */
    builtins?: () => Record<string, Channel>
  },
  register: (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => void,
): void {
  const { rejected } = deps
  const sendJson = (res: ServerResponse, status: number, value: unknown): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(value))
  }
  /** Read a JSON request body with a hard cap, so a large or hostile body cannot be buffered. */
  const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      const LIMIT = 64 * 1024
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > LIMIT) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          const parsed = text ? JSON.parse(text) : {}
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { reject(new Error('body must be a JSON object')); return }
          resolve(parsed as Record<string, unknown>)
        } catch (err) { reject(err as Error) }
      })
      req.on('error', reject)
    })
  /** One handler shape for every panel route: fence first, then method check, then work. */
  const route = (
    method: 'GET' | 'POST' | 'DELETE',
    run: (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ) => async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (rejected ? rejected(req, res) : false) return
    if (req.method !== method) {
      res.statusCode = 405
      res.setHeader('allow', method)
      res.end()
      return
    }
    let body: Record<string, unknown> = {}
    if (method !== 'GET') {
      try { body = await readJson(req) } catch (err) {
        sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
        return
      }
    }
    try { await run(body, req, res) } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  /**
   * The fence, resolvable at call time.
   *
   * `deps.rejected` was a REQUIRED field of a destructured parameter that the callers do not supply,
   * so every route threw `rejected is not defined` the moment it was hit -- a crash on the first
   * request, not a wrong status code. The bundler even renamed the local parameter to `rejected2` to
   * avoid a shadowing conflict, which is the tell: there was no outer binding to shadow.
   *
   * It is optional now and falls back to a fence that ADMITS, so `registerHttpRoutes(deps, reg)`
   * works for a caller that supplies only what it needs, while an explicit `deps.rejected` still
   * overrides. A route that cannot resolve a fence must not be the difference between working and
   * throwing -- see `createRequestFence` for the fail-closed path used by the plugin itself.
   */
  const fenceOf = (): ((req: IncomingMessage, res: ServerResponse) => boolean) =>
    rejected ?? (() => false)
  const getOnly = (reject: (req: IncomingMessage, res: ServerResponse) => boolean, req: IncomingMessage, res: ServerResponse, run: () => void): void => {
    if (reject(req, res)) return
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('allow', 'GET')
      res.end()
      return
    }
    run()
  }

  register('exact', '/api/busyloop/health', (req, res) => getOnly(fenceOf(), req, res, () =>
    sendJson(res, 200, { ok: true, plugin: name, engine: true, hostLlm: true })))

  register('exact', '/api/busyloop/providers', (req, res) => getOnly(fenceOf(), req, res, () => {
    if (!deps.llm) { sendJson(res, 200, { providers: [] }); return }
    try {
      const providers = hostLlm(deps.llm)
        .listProviders()
        .map((p) => ({ id: (p as unknown as { id?: string }).id ?? String(p) }))
      sendJson(res, 200, { providers })
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
    }
  }))

  /* ------------------------------------------------------------------ */
  /* Settings-panel routes                                              */
  /*                                                                    */
  /* The panel exists so a channel is configured in ONE place, and so   */
  /* the "which key?" question is answered by the HOST credential store */
  /* instead of a private key file. Every route below:                  */
  /*   - passes the fence first (it can read live credentials)          */
  /*   - returns NO secret: masked tails and presence flags only        */
  /* ------------------------------------------------------------------ */

  const creds = (): CredentialsService | undefined => deps.credentials?.()

  /** The stored override for one channel, if any — merged into edits so no field is lost. */
  const storedOverride = (key: string): ChannelConfig | undefined => readChannels().channels[key]

  /**
   * The row the panel renders for one channel: merged config (panel override > built-in), where it
   * came from, and WHICH credential would answer a call right now.
   *
   * This is what replaces "which key file is it using?": the same precedence the call path uses is
   * evaluated here and reported, including the case where nothing resolves at all.
   */
  const channelRow = async (key: string): Promise<Record<string, unknown>> => {
    const overrides = readChannels()
    const builtin = deps.builtins?.()[key]
    const override = overrides.channels[key]
    const config = override ?? builtin
    if (!config) return { key, present: false }
    const from = override ? (builtin ? 'override' : 'file') : 'builtin'

    // Precedence, identical to the call path: keyAlias (host record) -> keyEnv (host ref / env).
    let via: string | undefined
    let masked: string | undefined
    if (config.keyAlias) {
      const resolved = await resolveValue(creds(), config.keyAlias)
      if (resolved) { via = `alias:${config.keyAlias}`; masked = mask(resolved.value) }
    }
    if (via === undefined) {
      const resolved = await resolveValue(creds(), config.keyEnv)
      if (resolved) { via = `credential:${config.keyEnv}`; masked = mask(resolved.value) }
    }
    if (via === undefined && typeof process.env[config.keyEnv] === 'string' && process.env[config.keyEnv]) {
      // The call path writes the resolved key back into process.env, so an env-only key is live.
      via = `env:${config.keyEnv}`
      masked = mask(String(process.env[config.keyEnv]))
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
      callable: via !== undefined,
    }
  }

  register('exact', '/api/busyloop/channels', route('GET', async (_body, _req, res) => {
    const overrides = readChannels()
    const keys = [...new Set([...Object.keys(deps.builtins?.() ?? {}), ...Object.keys(overrides.channels)])].sort()
    const channels: Record<string, unknown>[] = []
    for (const key of keys) channels.push(await channelRow(key))
    sendJson(res, 200, {
      ok: true,
      channels,
      file: channelsPath(),
      fileError: overrides.error ?? null,
      credentialsAvailable: creds() !== undefined,
    })
  }))

  register('exact', '/api/busyloop/channel', route('POST', async (body, _req, res) => {
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!key) { sendJson(res, 400, { ok: false, error: 'key is required' }); return }
    const remove = body.remove === true
    if (remove) {
      const result = writeChannel(key, { remove: true })
      if (!result.ok) { sendJson(res, 400, { ok: false, error: result.error }); return }
      sendJson(res, 200, { ok: true, key, removed: true, channel: await channelRow(key) })
      return
    }
    // An edit MERGES with what is stored plus what is currently effective, so the panel may send
    // only the changed fields without dropping baseURL/model/keyEnv.
    const base = { ...(storedOverride(key) ?? {}), ...((await channelRow(key)).config as object | undefined) }
    const patch: Record<string, unknown> = {}
    for (const field of ['baseURL', 'model', 'keyEnv', 'keyAlias'] as const) {
      if (typeof body[field] === 'string') patch[field] = (body[field] as string).trim()
    }
    for (const field of ['maxTokens', 'contextWindow', 'delayMs', 'concurrency'] as const) {
      if (body[field] === null) { patch[field] = undefined; continue }
      if (body[field] !== undefined) {
        const n = Number(body[field])
        if (Number.isFinite(n)) patch[field] = n
      }
    }
    const result = writeChannel(key, { ...base, ...patch } as Partial<ChannelConfig>)
    if (!result.ok) { sendJson(res, 400, { ok: false, error: result.error }); return }
    sendJson(res, 200, { ok: true, key, removed: false, channel: await channelRow(key) })
  }))

  register('exact', '/api/busyloop/test', route('POST', async (body, _req, res) => {
    const key = typeof body.key === 'string' ? body.key.trim() : ''
    if (!key) { sendJson(res, 400, { ok: false, error: 'key is required' }); return }
    const row = await channelRow(key)
    if (row.present !== true) { sendJson(res, 404, { ok: false, error: `unknown channel "${key}"` }); return }
    const config = row.config as ChannelConfig
    // Resolve for THIS call only. The value goes into the env var the llm adapter reads for the
    // duration of the request, then the previous state is restored, so a test never leaves a key
    // resident in the process (and never clobbers one the user had set).
    const ref = config.keyAlias ?? config.keyEnv
    const resolved = await resolveValue(creds(), ref)
    const envName = config.keyEnv
    const hadEnv = Object.prototype.hasOwnProperty.call(process.env, envName)
    const prevEnv = process.env[envName]
    if (resolved) process.env[envName] = resolved.value
    try {
      const llm = deps.llm
      if (!llm) { sendJson(res, 200, { ok: false, error: 'this host exposes no llm service' }); return }
      const started = Date.now()
      // One real turn through the SAME path the tool uses (runBusyLoop over ctx.llm), with a tiny
      // budget and no pacing delay: the point is to prove the channel answers, not to generate.
      const result = await runBusyLoop(hostLlm(llm), {
        provider: 'deepseek',
        model: config.model,
        prompt: 'Reply with exactly: ok',
        maxTurns: 1,
        maxTokens: 32,
        delayMs: 0,
      })
      const trimmed = (result.output ?? '').trim()
      sendJson(res, 200, {
        ok: trimmed.length > 0,
        ms: Date.now() - started,
        model: config.model,
        baseURL: config.baseURL,
        via: row.via,
        turns: result.turns,
        finish: result.finish,
        preview: (result.output ?? '').slice(0, 200),
        error: trimmed.length > 0 ? null : `the call returned no text (finish=${result.finish})`,
      })
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (hadEnv) process.env[envName] = prevEnv
      else delete process.env[envName]
    }
  }))

  register('exact', '/api/busyloop/credentials', route('GET', async (_body, _req, res) => {
    const overrides = readChannels()
    const refs: string[] = []
    for (const config of [...Object.values(deps.builtins?.() ?? {}), ...Object.values(overrides.channels)]) {
      if (config.keyAlias) refs.push(config.keyAlias)
      if (config.keyEnv) refs.push(config.keyEnv)
    }
    const rows = await describeRefs(creds(), refs)
    sendJson(res, 200, { ok: true, credentials: rows, service: creds() !== undefined })
  }))

  register('exact', '/api/busyloop/credential', route('POST', async (body, _req, res) => {
    const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
    if (body.remove === true) {
      const result = await removeCredential(creds(), ref)
      sendJson(res, result.ok ? 200 : 400, result)
      return
    }
    const result = await storeCredential(creds(), ref, typeof body.value === 'string' ? body.value : '')
    sendJson(res, result.ok ? 200 : 400, result)
  }))
}

/* ------------------------------------------------------------------ */
/* Agent-facing tool: busyloop_run — one-off loops on a chosen channel */
/* ------------------------------------------------------------------ */

interface Channel {
  baseURL: string
  model: string
  keyEnv: string
  /**
   * Host credential this channel should use, instead of relying on `keyEnv` alone.
   *
   * This is what replaces the removed private key store: a channel NAMES a credential held by the
   * host (`ctx.credentials`) rather than busyloop keeping a key of its own. It is set by the settings
   * panel; absent means "resolve `keyEnv` through the host, then the environment, as before".
   */
  keyAlias?: string
  /** Optional per-channel output budget. Thinking models (kimi-k3, o-series, gpt-5.6-*) spend tokens in reasoning_content first — raise this when output comes back empty. Default 2048. */
  maxTokens?: number
  /** Optional context window in tokens (e.g. 262144 for 256K, 1000000 for 1M). When set, busyloop_run auto-budgets: truncates oversized prompts and caps maxTokens so every call stays inside the window (and its pricing tier). Provider-registered info takes precedence over this fallback; absent = unlimited. */
  contextWindow?: number
  /** Channel-level default pacing: ms to wait before every LLM generation. Per-call delayMs overrides; absent = no delay. */
  delayMs?: number
  /** Channel-level default concurrency for batch runs (tasks). Per-call concurrency overrides; absent = 1 (serial). */
  concurrency?: number
}

const CHANNELS: Record<'ark' | 'direct', Channel> = {
  ark: {
    baseURL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    model: 'deepseek-v4.1-flash',
    keyEnv: 'ARK_API_KEY',
  },
  direct: {
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
}

/**
 * P3: user-defined channels — ~/.dsh/busyloop-channels.json
 *   { "momotale": { "baseURL": "https://router.momotale.com/v1", "model": "kimi-k3", "keyEnv": "MOMOTALE_API_KEY" } }
 * No code change needed to add a new provider.
 *
 * The parsing lives in `panel.ts` (`readChannels`) because the settings panel reads the same file:
 * one validator, one merge rule, one place to change. This function only narrows the panel-facing
 * `ChannelConfig` to the internal `Channel` shape.
 */
function loadCustomChannels(): Record<string, Channel> {
  const { channels } = readChannels()
  const out: Record<string, Channel> = {}
  for (const [key, config] of Object.entries(channels)) {
    out[key] = {
      baseURL: config.baseURL,
      model: config.model,
      keyEnv: config.keyEnv,
      keyAlias: config.keyAlias,
      maxTokens: config.maxTokens,
      contextWindow: config.contextWindow,
      delayMs: config.delayMs,
      concurrency: config.concurrency,
    }
  }
  return out
}

/** P1: resolve a channel by name — panel override → builtin → host-registered providers. Throws with the available list otherwise. */
function resolveChannel(channelKey: string, ctxLlm?: Parameters<typeof hostLlm>[0]): Channel {
  // The override layer wins over the built-ins: the settings panel writes here, so a user can
  // retarget `ark` or `direct` without patching the constants above. `normaliseChannel` has already
  // validated it, so a malformed entry never reaches a call.
  const custom = loadCustomChannels()[channelKey]
  if (custom) return custom
  const builtin = CHANNELS[channelKey as 'ark' | 'direct']
  if (builtin) return builtin
  if (ctxLlm) {
    try {
      const providers = hostLlm(ctxLlm).listProviders() as unknown[]
      for (const p of providers) {
        const id = (p as { id?: string })?.id ?? String(p)
        if (id !== channelKey) continue
        const anyP = p as Record<string, unknown>
        const models = Array.isArray(anyP.models) ? anyP.models : []
        const baseURL = String(anyP.baseURL ?? '')
        const model = String(anyP.model ?? (models[0] as { id?: string } | string | undefined) ?? '')
        const keyEnv = String(anyP.keyEnv ?? anyP.apiKeyEnv ?? '')
        const win = Number(anyP.contextWindow) > 0 ? Number(anyP.contextWindow) : undefined
        const firstModel = Array.isArray(anyP.models) ? anyP.models[0] as Record<string, unknown> | undefined : undefined
        const modelWin = firstModel && Number((firstModel as Record<string, unknown>).contextWindow) > 0 ? Number((firstModel as Record<string, unknown>).contextWindow) : undefined
        const pDelay = Number(anyP.delayMs) >= 0 ? Number(anyP.delayMs) : undefined
        const pConc = Number(anyP.concurrency) > 0 ? Math.floor(Number(anyP.concurrency)) : undefined
        if (baseURL && model && keyEnv) return { baseURL, model, keyEnv, contextWindow: win ?? modelWin, delayMs: pDelay, concurrency: pConc }
      }
    } catch {
      /* provider probe failed — fall through to the explicit error */
    }
  }
  const available = Object.keys(CHANNELS).concat(Object.keys(loadCustomChannels()))
  throw new Error(
    `unknown channel "${channelKey}". Available channels: ${available.join(', ')} (custom channels: ~/.dsh/busyloop-channels.json)`
  )
}

function credentialsPath(): string {
  return `${join(homedir(), '.dsh', '.credentials.yaml')}`
}

/**
 * Read a credential the WRONG way: straight off disk.
 *
 * Kept only as a fallback for a host that composes no `credentials` service. The right path is
 * `resolveCredential` below, for three reasons the service's own contract states:
 *   - the value is owned by a provider, not by this plugin's idea of a file location;
 *   - resolution is PER OPERATION, so a rotated credential reaches the next call without a restart
 *     (reading the file bakes in whatever was on disk when the plugin loaded);
 *   - the plugin stops touching secret material on disk at all.
 */
function loadKeyFromFile(keyEnv: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const creds: any = yaml.load(readFileSync(credentialsPath(), 'utf8'))
    return creds?.refs?.[keyEnv]?.value ?? creds?.refs?.[keyEnv] ?? creds?.[keyEnv]
  } catch {
    return undefined
  }
}

/** The official credential read, without declaring `inject` (ctx.get is the inject-free form). */
function credentialsService(ctx: unknown): { resolve?: (ref: unknown) => Promise<{ value?: string } | undefined> } | undefined {
  const read = (ctx as { get?: (name: string) => unknown } | null | undefined)?.get
  if (typeof read !== 'function') return undefined
  try {
    const svc = read.call(ctx, 'credentials') as { resolve?: unknown } | undefined
    return svc && typeof svc.resolve === 'function' ? (svc as never) : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the credential for `keyEnv`, preferring the host service and falling back to the file.
 *
 * Async because `credentials.resolve` is, and the only call site is already inside the async tool
 * handler -- so nothing upstream has to change. Deliberately NOT cached: the service contract says
 * consumers "must not cache across operations", which is exactly the property we want (a rotation
 * takes effect on the next busyloop_run instead of the next DSH restart).
 */
export async function resolveCredential(
  ctx: unknown,
  keyEnv: string,
  envOverride: string | undefined,
): Promise<{ value: string; source: string } | undefined> {  if (envOverride) return { value: envOverride, source: 'env-override' }
  const svc = credentialsService(ctx)
  if (svc?.resolve) {
    try {
      const r = await svc.resolve(keyEnv)
      if (r && typeof r.value === 'string' && r.value) return { value: r.value, source: 'ctx.credentials' }
    } catch {
      /* a name outside the reference grammar, or a provider that cannot answer: fall through */
    }
  }
  const fromFile = loadKeyFromFile(keyEnv)
  return fromFile ? { value: fromFile, source: 'file' } : undefined
}

// One shared runtime per channel, built on first use.
const runtimes = new Map<string, { llm: HostLlm }>()

function getRuntime(channelKey: string, ctxLlm?: Parameters<typeof hostLlm>[0]): { llm: HostLlm; channel: Channel } {
  const channel = resolveChannel(channelKey, ctxLlm)
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
        maxTokens: channel.maxTokens ?? 2048,
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

function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Merge the caller's system prompt with the built-in discipline prompt. */
function resolveSystem(custom: unknown, discipline: unknown): string | undefined {
  const customStr = typeof custom === 'string' && custom.trim() ? custom : undefined
  if (discipline === false) return customStr
  if (customStr) return `${DISCIPLINE_SYSTEM}\n\n${customStr}`
  return DISCIPLINE_SYSTEM
}

function registerBusyloopRun(ctx: { tools?: { register: (def: unknown) => unknown }; llm?: Parameters<typeof hostLlm>[0] }): void {
  ctx.tools?.register(
    defineTool({
      name: 'busyloop_run',
      description:
        'Run one one-off subagent loop on a cheap channel (default: Volcano Ark plan API with deepseek-v4.1-flash, billed to the ARK key — main-model tokens untouched). Returns the loop output plus turn/tool-call/usage stats. Use for disposable research, validation, formatting, or any task that does not need the main conversation context.',
      parameters: {
        prompt: {
          type: 'string',
          description: 'The task prompt for the sub-loop. Self-contained: it runs without access to this conversation.',
          required: true,
        },
        channel: {
          type: 'string',
          description: 'Which LLM channel to use: ark (default) = Volcano Ark plan API (deepseek-v4.1-flash, ARK_API_KEY); direct = api.deepseek.com (deepseek-chat, DEEPSEEK_API_KEY); or any channel defined in ~/.dsh/busyloop-channels.json. Unknown channels error out listing the available ones.',
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
        reasoningEffort: {
          type: 'string',
          enum: ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'],
          description: 'Reasoning effort for this run (default: provider/channel default). Passed to the upstream API as reasoning_effort so the chat menu choice actually applies.',
        },
        delayMs: {
          type: 'number',
          description: 'Throttle: ms to wait before EVERY LLM generation (per-turn pacing, anti rate-limit). Per-call value overrides the channel default; 0 = no delay. One router key can serve models with different limits — pass the right value for THIS model on the spot, nothing is hard-coded.',
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional batch: array of task prompts, each runs its own full loop on the same channel/model/settings. Results come back as an array with per-task output/error. Without tasks, single-prompt mode (prompt) applies.',
        },
        concurrency: {
          type: 'number',
          description: 'Batch concurrency: how many tasks run in parallel (default 1 = serial; channel config supplies the fallback). Combine with delayMs to pace a burst across the same key.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(args: any, exec: any) {
        const channelKey = String(args.channel ?? 'ark')
        // cordis proxy rule: reading an undeclared service property THROWS at
        // runtime even when the type is optional — guard the host-llm probe.
        let llmCtx: Parameters<typeof hostLlm>[0] | undefined
        try {
          const maybe = (ctx as { llm?: Parameters<typeof hostLlm>[0] }).llm
          // cordis proxy: bare property access does NOT throw — only touching
          // the proxy does. Probe the method so a missing service degrades to
          // undefined instead of blowing up later.
          if (maybe && typeof (maybe as { listProviders?: unknown }).listProviders === 'function') {
            llmCtx = maybe
          }
        } catch {
          llmCtx = undefined // host without the llm service: custom channels still work
        }
        let channel: Channel
        try {
          channel = resolveChannel(channelKey, llmCtx)
        } catch (err) {
          return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
        const { llm } = getRuntime(channelKey, llmCtx)
        // Credential precedence, and the panel reports the very same order (see channelRow):
        //   1. channel.keyAlias — the host credential this channel NAMES (set in the settings panel)
        //   2. channel.keyEnv   — the host credential / environment variable for that name
        //   3. the legacy key file — only for a host with no credentials service, so an existing
        //      ~/.dsh/busyloop-keys.json keeps working instead of breaking on upgrade.
        // Resolved BEFORE the sync key resolver is called, so `keys.ts` keeps its synchronous
        // contract and this one call site absorbs the await. The service is asked per operation, so a
        // rotated credential lands on the next call with no restart.
        let credential = channel.keyAlias ? await resolveCredential(ctx, channel.keyAlias, undefined) : undefined
        if (!credential) {
          credential = await resolveCredential(ctx, channel.keyEnv, process.env[channel.keyEnv])
        }
        const resolved = keyStore.resolveEffectiveKey(
          () => credential?.value,
          channel.keyEnv,
          channelKey,
        )
        const key = resolved.key
        if (!key) {
          const tried = channel.keyAlias
            ? `"${channel.keyAlias}" (the channel's keyAlias), "${channel.keyEnv}", env ${channel.keyEnv}`
            : `"${channel.keyEnv}" and env ${channel.keyEnv}`
          return JSON.stringify({
            ok: false,
            error: `No credential found for channel "${channelKey}": tried ${tried} via ctx.credentials, plus ${credentialsPath()} as a legacy fallback. Set one in the settings panel (Settings -> busyloop).`,
          })
        }
        process.env[channel.keyEnv] = key
        const keyUsed = resolved.alias ? `${resolved.alias}(${resolved.masked})` : resolved.masked ?? 'unknown'

        // 0.1.26 dynamic pacing/concurrency: per-call args > channel config > builtin defaults.
        // Nothing is hard-coded: the caller adjusts on the spot, per model.
        const delayMs =
          args.delayMs !== undefined && Number(args.delayMs) >= 0
            ? Number(args.delayMs)
            : (channel.delayMs ?? 0)
        const concurrency =
          args.concurrency !== undefined && Number(args.concurrency) >= 1
            ? Math.max(1, Math.floor(Number(args.concurrency)))
            : (channel.concurrency ?? 1)
        const sysText = resolveSystem(args.system, args.discipline)

        // Run one prompt through the loop, with the adaptive window budget
        // (0.1.24: provider contextWindow > channel fallback > unlimited).
        const runOne = async (rawPrompt: string) => {
          let prompt = rawPrompt
          let maxTokens = args.maxTokens ? Number(args.maxTokens) : undefined
          let budgetNote: string | undefined
          const win = channel.contextWindow
          if (win && win > 0) {
            const inputEst = Math.ceil((rawPrompt.length + (sysText ?? '').length) / 3)
            if (inputEst > win * 0.85) {
              const keep = Math.floor(rawPrompt.length * 0.85)
              const head = Math.floor(keep * 0.5)
              prompt =
                rawPrompt.slice(0, head) +
                '\n\n...[truncated by busyloop window budget]...\n\n' +
                rawPrompt.slice(rawPrompt.length - (keep - head))
              budgetNote = `prompt truncated: ~${inputEst} tokens estimated vs ${win} window`
            }
            const requested = maxTokens ?? channel.maxTokens ?? 2048
            const headroom = win - Math.ceil(inputEst * 1.2) - 1024
            if (requested > headroom) {
              const capped = Math.max(256, headroom)
              maxTokens = Math.min(requested, capped)
              budgetNote = budgetNote ? `${budgetNote}; ` : ''
              budgetNote += `maxTokens capped ${requested} -> ${maxTokens} (window ${win})`
            }
          }
          try {
            const result = await runBusyLoop(llm, {
              provider: 'deepseek',
              model: channel.model,
              prompt,
              system: sysText,
              maxTurns: args.maxTurns ? Number(args.maxTurns) : undefined,
              maxTokens,
              reasoningEffort: args.reasoningEffort ? String(args.reasoningEffort) : undefined,
              delayMs,
              signal: exec?.signal,
              sessionId: 'busyloop-tools',
            })
            const note =
              !result.output && result.finish === 'length'
                ? `empty output: maxTokens exhausted before any content — thinking models spend tokens on reasoning_content first; raise maxTokens (current: ${args.maxTokens ?? channel.maxTokens ?? 2048}) or switch to a non-thinking model`
                : undefined
            return {
              ok: true,
              output: result.output,
              turns: result.turns,
              toolCalls: result.toolCalls,
              finish: result.finish,
              usage: result.usage ?? null,
              ...(note ? { outputNote: note } : {}),
              ...(budgetNote ? { budgetNote } : {}),
            }
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) }
          }
        }

        const tasks = Array.isArray(args.tasks) && args.tasks.length > 0
          ? args.tasks.map((t: unknown) => String(t))
          : undefined
        if (!tasks) {
          const r = await runOne(String(args.prompt))
          return JSON.stringify({ channel: channelKey, model: channel.model, key: keyUsed, ...r })
        }
        // Batch mode: bounded pool + per-task start spacing (delayMs) so a
        // burst never slams the same router key at once. A failed task is
        // reported per-item, it does not abort the batch.
        const results: unknown[] = []
        let next = 0
        const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
          while (next < tasks.length) {
            const i = next++
            await sleep(delayMs)
            const r = await runOne(tasks[i])
            results[i] = { index: i, ...r }
          }
        })
        await Promise.all(workers)
        return JSON.stringify({
          ok: true,
          channel: channelKey,
          model: channel.model,
          key: keyUsed,
          batch: true,
          tasks: tasks.length,
          concurrency,
          delayMs,
          results,
        })
      },
    }),
  )
}
/**
 * Plugin entry: mount health/providers endpoints + register the agent tool.
 * ctx.tools is optional — hosts without a tool registry still get the engine.
 */
export function apply(ctx: {
  /** Official cordis service read that does NOT require declaring inject (throws on the proxy otherwise). */
  get?: (name: string) => unknown
  inject?: (deps: string[], cb: (child: {
    webServer: { register: (route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => () => void }
    effect?: (fn: () => unknown, label?: string) => unknown
  }) => unknown) => unknown
  llm?: Parameters<typeof hostLlm>[0]
  tools?: { register: (def: unknown) => unknown }
}): void {
  // HTTP: 注册到官方 ctx.webServer。
  //
  // **不能**直接读 `ctx.webServer` —— cordis 的 ctx 是代理, 读一个已注册但未声明 inject
  // 的服务会抛 "cannot get property ... without inject", 可选链挡不住(get 陷阱先抛);
  // 结果是整个插件激活失败, 而不只是路由不注册。官方写法 (client/connection/src/index.ts:139-159):
  //   ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => webCtx.webServer.register(route), 'label'))
  // 没有 webServer 的 profile 里回调不执行, 插件其余部分照常加载。
  // (原先用 `ctx.http?.mount?.()` —— ctx.http 不是 DSH 服务, 那两条路由从未生效。)
  ctx.inject?.(['webServer'], (webCtx) => {
    const register = (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
      webCtx.webServer.register({ kind, path, handler })
    }
    // llm 必须惰性 + 无 inject 地读: `ctx.llm` 会踩同一个代理陷阱
    // ("cannot get property llm without inject") —— 而且那一下抛在 effect() 里会被**静默吞掉**,
    // 结果是路由一个都不注册(实测 /api/busyloop/* 一直落到 /api 前缀围栏, 返回 401)。
    // ctx.get 是官方"不声明 inject 也能读服务"的入口, getter 让 deps.llm 每次请求现取。
    const deps = {
      get llm(): Parameters<typeof hostLlm>[0] | undefined {
        try {
          return (typeof ctx.get === 'function' ? ctx.get('llm') : undefined) as Parameters<typeof hostLlm>[0] | undefined
        } catch { return undefined }
      },
      // The settings panel needs the credential service and the built-in channel table. Both are
      // read the same lazy, guarded way as `llm` above — a bare `ctx.credentials` would take the
      // whole effect down (and the throw would be swallowed), leaving the panel routes unregistered.
      credentials: (): CredentialsService | undefined => credentialsFrom(ctx),
      builtins: (): Record<string, Channel> => CHANNELS,
    }
    // Built here, not inside registerHttpRoutes: that function receives `deps`, not the ctx,
    // and the fence must read the live connection service from the plugin context.
    const rejected = createRequestFence(ctx)
    const mount = (): void => registerHttpRoutes({ ...deps, rejected }, register)
    if (typeof webCtx.effect === 'function') webCtx.effect(mount, 'dsh-busyloop: /api/busyloop/{health,providers,channels,test,credentials}')
    else mount()
  })
  registerBusyloopRun(ctx)
  // NOTE: `registerKeyTools` used to run here. Those four tools (busyloop_key_add/list/remove/use)
  // were removed on purpose: busyloop must not keep a second credential store beside the host's.
  // Selecting a key is now done in the settings panel, which drives `ctx.credentials`.
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
