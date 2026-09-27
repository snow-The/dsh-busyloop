import type { IncomingMessage, ServerResponse } from 'node:http';
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
export declare function registerHttpRoutes(deps: {
    llm?: Parameters<typeof hostLlm>[0];
    rejected?: (req: IncomingMessage, res: ServerResponse) => boolean;
}, register: (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => void): void;
/**
 * Resolve the credential for `keyEnv`, preferring the host service and falling back to the file.
 *
 * Async because `credentials.resolve` is, and the only call site is already inside the async tool
 * handler -- so nothing upstream has to change. Deliberately NOT cached: the service contract says
 * consumers "must not cache across operations", which is exactly the property we want (a rotation
 * takes effect on the next busyloop_run instead of the next DSH restart).
 */
export declare function resolveCredential(ctx: unknown, keyEnv: string, envOverride: string | undefined): Promise<{
    value: string;
    source: string;
} | undefined>;
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
    /** Official cordis service read that does NOT require declaring inject (throws on the proxy otherwise). */
    get?: (name: string) => unknown;
    inject?: (deps: string[], cb: (child: {
        webServer: {
            register: (route: {
                kind: 'exact' | 'prefix';
                path: string;
                handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
            }) => () => void;
        };
        effect?: (fn: () => unknown, label?: string) => unknown;
    }) => unknown) => unknown;
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
