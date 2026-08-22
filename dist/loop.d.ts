import type { HostLlm } from './llm.ts';
import type { BusyLoopOptions, LoopResult } from './types.ts';
/**
 * Run the busy loop: generate → assemble (official BlockAssembler) → execute
 * tool calls → feed results back → repeat until the model stops calling tools
 * or `maxTurns` is reached. LLM access goes exclusively through the host
 * `ctx.llm` channel; tools are injected by the caller.
 */
export declare function runBusyLoop(llm: HostLlm, opts: BusyLoopOptions): Promise<LoopResult>;
