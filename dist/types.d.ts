import type { TokenUsage } from '@deepseek-ai/dsh-llm';
/** One tool the loop can dispatch. Schemas follow the official ToolSchema shape. */
export interface LoopTool {
    name: string;
    description: string;
    /** JSON Schema object for the arguments. */
    parameters: Record<string, unknown>;
    execute(args: unknown, signal?: AbortSignal): unknown | Promise<unknown>;
}
/** Options for one busy-loop run. */
export interface BusyLoopOptions {
    /** Registered provider route (see ctx.llm.listProviders()). */
    provider: string;
    /** Provider model id. */
    model: string;
    /** The task prompt for this run. */
    prompt: string;
    /** Optional system prompt text. */
    system?: string;
    /** Tools the model may call during the run. */
    tools?: LoopTool[];
    /** Max turns before forced stop (default 8). */
    maxTurns?: number;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    /**
     * Session identity stamped on every generation for request routing
     * (replay cursor separation, transport metadata).
     */
    sessionId?: string;
    /** Progress callback. */
    onEvent?: (ev: LoopEvent) => void;
}
export type LoopEvent = {
    type: 'turn';
    turn: number;
    toolCalls: number;
} | {
    type: 'tool';
    name: string;
    ok: boolean;
} | {
    type: 'done';
    turns: number;
};
/** Result of one busy-loop run. */
export interface LoopResult {
    /** Final assistant text (last text block of the last turn). */
    output: string;
    /** Turns actually executed. */
    turns: number;
    /** Successful tool invocations. */
    toolCalls: number;
    /** Token usage of the last generation, when reported. */
    usage?: TokenUsage;
    /** Finish reason of the last generation. */
    finish: string;
}
