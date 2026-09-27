/** One channel's configuration, as the panel sees it. */
export interface ChannelConfig {
    baseURL: string;
    model: string;
    keyEnv: string;
    /** Host credential record (or alias) this channel should use. Absent = fall back to `keyEnv`. */
    keyAlias?: string;
    maxTokens?: number;
    contextWindow?: number;
    delayMs?: number;
    concurrency?: number;
}
/** The name of the file the panel writes. Exported for tests and for the panel's own display. */
export declare function channelsPath(): string;
/**
 * Validate one raw entry into a ChannelConfig, or undefined when it is not usable.
 *
 * A channel without baseURL/model/keyEnv cannot be called, so it is rejected rather than stored as
 * a half-configured row the panel would then display as if it worked.
 */
export declare function normaliseChannel(raw: unknown): ChannelConfig | undefined;
/**
 * Read the override map. Never throws: an unreadable or malformed file means "no overrides", which
 * is exactly the built-in behaviour, so a broken file degrades instead of breaking every call.
 */
export declare function readChannels(): {
    channels: Record<string, ChannelConfig>;
    error?: string;
};
/**
 * Merge one patch into the file and write it back atomically.
 *
 * Read-modify-write over the whole file on purpose: a panel that knows 3 of your 5 channels must not
 * delete the other 2. A patch whose values are all undefined/empty REMOVES the override, which is
 * how the panel offers "reset to built-in" without deleting keys by hand.
 */
export declare function writeChannel(channelKey: string, patch: Partial<ChannelConfig> & {
    remove?: boolean;
}): {
    ok: true;
    channels: Record<string, ChannelConfig>;
} | {
    ok: false;
    error: string;
};
/** Remove a temp file left behind by a failed write. Best effort, used by tests. */
export declare function cleanupTemp(file: string): void;
