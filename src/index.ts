import { Hono } from 'hono'
import { hostLlm } from './llm.ts'
import { runBusyLoop } from './loop.ts'
import type { HostLlm } from './llm.ts'
import type { BusyLoopOptions, LoopEvent, LoopResult, LoopTool } from './types.ts'

export const name = 'dsh-busyloop'
export const description =
  'DSH agent-loop engine: host-LLM adapter (official ctx.llm channel) + lightweight loop skeleton. Capability layer — codex style is opt-in via dsh-busyloop-codexstyle.'

/** Standalone Hono app (mounted by apply() under /api/busyloop). */
export function createHonoApp(): Hono {
  const app = new Hono()
  app.get('/health', (c) => c.json({ ok: true, plugin: name, engine: true, hostLlm: true }))
  return app
}

/** Plugin entry: mount health endpoints. The engine itself is library API. */
export function apply(ctx: {
  http?: { mount?: (path: string, app: unknown) => unknown }
}): void {
  try {
    ctx.http?.mount?.('/api/busyloop', createHonoApp())
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
