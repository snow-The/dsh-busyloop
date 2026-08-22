import { Hono } from 'hono';
import { hostLlm } from './llm.ts';
import type { HostLlm } from './llm.ts';
import type { BusyLoopOptions, LoopResult } from './types.ts';
export declare const name = "dsh-busyloop";
export declare const description = "DSH agent-loop engine: host-LLM adapter (official ctx.llm channel) + lightweight loop skeleton + agent tool busyloop_run (one-off tasks on a chosen channel \u2014 Volcano Ark plan API by default \u2014 main-model tokens untouched). Capability layer \u2014 codex style is opt-in via dsh-busyloop-codexstyle.";
/** Standalone Hono app (mounted by apply() under /api/busyloop). */
export declare function createHonoApp(deps?: {
    llm?: Parameters<typeof hostLlm>[0];
}): Hono;
/**
 * Plugin entry: mount health/providers endpoints + register the agent tool.
 * ctx.tools is optional — hosts without a tool registry still get the engine.
 */
export declare function apply(ctx: {
    http?: {
        mount?: (path: string, app: unknown) => unknown;
    };
    llm?: Parameters<typeof hostLlm>[0];
    tools?: {
        register: (def: unknown) => unknown;
    };
}): void;
/** Wrap the host ctx into a ready-to-use engine handle. */
export declare function createBusyLoop(ctx: {
    llm: Parameters<typeof hostLlm>[0];
}): {
    llm: HostLlm;
    run: (opts: BusyLoopOptions) => Promise<LoopResult>;
    health: () => {
        ok: boolean;
        plugin: string;
    };
};
export { hostLlm } from './llm.ts';
export { runBusyLoop } from './loop.ts';
export type { HostLlm, LlmServiceLike } from './llm.ts';
export type { BusyLoopOptions, LoopEvent, LoopResult, LoopTool } from './types.ts';
