import { Hono } from 'hono';
import { hostLlm } from './llm.ts';
import type { HostLlm } from './llm.ts';
import type { BusyLoopOptions, LoopResult } from './types.ts';
export declare const name = "dsh-busyloop";
export declare const description = "DSH agent-loop engine: host-LLM adapter (official ctx.llm channel) + lightweight loop skeleton. Capability layer \u2014 codex style is opt-in via dsh-busyloop-codexstyle.";
/** Standalone Hono app (mounted by apply() under /api/busyloop). */
export declare function createHonoApp(deps?: {
    llm?: Parameters<typeof hostLlm>[0];
}): Hono;
/** Plugin entry: mount health/providers endpoints. The engine itself is library API. */
export declare function apply(ctx: {
    http?: {
        mount?: (path: string, app: unknown) => unknown;
    };
    llm?: Parameters<typeof hostLlm>[0];
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
