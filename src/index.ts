import { Hono } from 'hono'
import { hostLlm } from './llm.ts'
import { runBusyLoop } from './loop.ts'
import type { HostLlm } from './llm.ts'
import type { BusyLoopOptions, LoopEvent, LoopResult, LoopTool } from './types.ts'

export const name = 'dsh-busyloop'
export const description =
  'DSH agent-loop engine: host-LLM adapter (official ctx.llm channel) + lightweight loop skeleton. Capability layer — codex style is opt-in via dsh-busyloop-codexstyle.'

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

/** Plugin entry: mount health/providers endpoints. The engine itself is library API. */
export function apply(ctx: {
  http?: { mount?: (path: string, app: unknown) => unknown }
  llm?: Parameters<typeof hostLlm>[0]
}): void {
  try {
    ctx.http?.mount?.('/api/busyloop', createHonoApp({ llm: ctx.llm }))
  } catch {
    /* host without http mount: engine still usable as library */
  }
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
