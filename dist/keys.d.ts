export type KeyScope = 'chat' | 'subagent';
export interface KeyEntry {
    id: string;
    alias: string;
    key: string;
    scope: KeyScope;
    createdAt: string;
}
/** sk-abc123... -> sk-****c123 (前 4 后 4,绝不回显完整 key) */
export declare function maskKey(key: string): string;
export declare function listKeys(): Array<Omit<KeyEntry, 'key'> & {
    masked: string;
    active: boolean;
}>;
export declare function addKey(alias: string, key: string, scope: KeyScope): KeyEntry;
export declare function removeKey(alias: string): boolean;
/** 聊天内选择:把某个 chat-scope key 设为当前会话生效(仅影响后续 busyloop_run)。 */
export declare function useKey(alias: string): {
    ok: boolean;
    alias: string;
    masked: string;
};
export declare function activeKeyInfo(): {
    alias?: string;
    masked?: string;
};
/**
 * 解析本次 busyloop_run 实际使用的 key:
 * 1) 当前会话选中的 chat-scope key(active alias)
 * 2) 回退:全局 env / credentials(由调用方提供 loadEnvKey)
 */
export declare function resolveEffectiveKey(loadEnvKey: (keyEnv: string) => string | undefined, keyEnv: string): {
    key?: string;
    alias?: string;
    masked?: string;
    source: 'session' | 'global';
};
