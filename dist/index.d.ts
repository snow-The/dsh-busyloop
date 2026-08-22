import { Hono } from 'hono';
import { hostLlm } from './llm.ts';
import type { HostLlm } from './llm.ts';
import type { BusyLoopOptions, LoopResult } from './types.ts';
export declare const name = "dsh-busyloop";
/**
 * cordis rule (crash lesson, 0.1.6): reading a REGISTERED service property off
 * ctx (e.g. ctx.tools) THROWS "cannot get property X without inject" unless the
 * service is declared here — optional chaining does NOT help (the proxy get
 * trap throws). ctx.http/ctx.llm are intentionally NOT declared: on this host
 * they are absent (read yields undefined) or only reached in guarded callbacks.
 */
export declare const inject: string[];
export declare const description = "DSH agent-loop engine: host-LLM adapter (official ctx.llm channel) + lightweight loop skeleton + agent tool busyloop_run (one-off tasks on a chosen channel \u2014 Volcano Ark plan API by default \u2014 main-model tokens untouched). Capability layer \u2014 codex style is opt-in via dsh-busyloop-codexstyle.";
/** Standalone Hono app (mounted by apply() under /api/busyloop). */
export declare function createHonoApp(deps?: {
    llm?: Parameters<typeof hostLlm>[0];
}): Hono;
/**
 * Built-in discipline system prompt for sub-loops (distilled from classic
 * engineering books: Clean Code / Refactoring / DDIA / System Design
 * Interview / game-design practices / reverse-engineering methodology).
 * Injected by default; opt out with discipline:false or override with system.
 */
export declare const DISCIPLINE_SYSTEM: string;
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
