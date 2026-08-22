import type { GenerateOptions, StreamChunk, LlmProviderInfo } from '@deepseek-ai/dsh-llm';
/**
 * The LLM channel busyloop speaks to. It is a thin passthrough of the official
 * host service `ctx.llm` (LlmRuntime) — no hand-rolled HTTP/SSE, no external
 * SDK. Providers are registered by the host's own adapter plugins
 * (dsh-llm-deepseek, dsh-llm-pi-ai, ...).
 */
export interface HostLlm {
    /** Stream one generation through the host's LLM runtime. */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** Providers currently registered in the host runtime. */
    listProviders(): LlmProviderInfo[];
    /** First registered provider id, if any. */
    defaultProvider(): string | undefined;
}
/** Shape of the host service we consume (structural, so tests can stub it). */
export interface LlmServiceLike {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    listProviders(): LlmProviderInfo[];
}
/** Wrap the host `ctx.llm` service as a {@link HostLlm}. */
export declare function hostLlm(service: LlmServiceLike): HostLlm;
