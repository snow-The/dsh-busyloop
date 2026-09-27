/**
 * Host-credential adapter for the busyloop settings panel.
 *
 * WHY THIS REPLACES THE PRIVATE KEY STORE. busyloop used to keep its own key file plus four tools
 * (`busyloop_key_add/list/remove/use`). That is a second credential system living beside the host's:
 * two places to rotate a key, two places to leak one, and a "which one is actually in use?" question
 * on every call. The host already owns this — `ctx.credentials` — with `resolve/describe/set/unset/
 * readRecord/listRecords`, per-operation resolution (so a rotation lands on the next call without a
 * restart), and the file it manages. busyloop now only NAMES a credential per channel; it never
 * stores one.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 *  1. NO SECRET EVER LEAVES THROUGH A LIST. `list()` returns names, source and a MASK; the raw value
 *     is only ever handed to the LLM call itself. The panel is a UI, not a key viewer, and a JSON
 *     response body ends up in logs, screenshots and chat transcripts.
 *
 *  2. EVERY READ IS PER OPERATION. The contract states resolution must not be cached, so `get()`
 *     asks the service each time. A cached key would quietly keep using a rotated-away credential.
 *
 * `ctx.get` (lazy, in a try/catch) is how the service is read, matching the rest of this plugin: a
 * bare `ctx.credentials` throws on cordis's proxy when inject does not declare it, and that throw
 * inside an `effect()` is swallowed silently — which is exactly how the routes here once ended up
 * never registering at all.
 */
/** The minimum of the host's credential service this plugin uses. */
export interface CredentialsService {
    resolve: (ref: string) => Promise<{
        value: string;
        source: string;
    } | undefined>;
    describe?: (ref: string) => Promise<{
        source?: string;
        masked?: string;
        present?: boolean;
    } | undefined>;
    set?: (ref: string, value: string) => Promise<void>;
    unset?: (ref: string) => Promise<void>;
    listRecords?: () => Promise<readonly unknown[]>;
    readRecord?: (key: unknown) => Promise<unknown>;
}
/** One credential as the panel is allowed to see it. */
export interface CredentialRow {
    /** The reference other code passes to `ctx.credentials.resolve`. */
    ref: string;
    /** Where the host says the value came from (file/env/record), when it says. */
    source?: string;
    /** Masked tail only — never the value. */
    masked?: string;
    /** True when the service could actually resolve it just now. */
    present: boolean;
}
/** Mask a secret for display: keep a short tail so two keys are distinguishable, never the head. */
export declare function mask(value: string): string;
/**
 * Read the credential service off the plugin context, or undefined when this host has none.
 * Lazy + guarded: the service is asked at each operation, and a throwing proxy is caught rather than
 * taking the route (or the whole effect) down with it.
 */
export declare function credentialsFrom(ctx: {
    get?: (name: string) => unknown;
} | undefined): CredentialsService | undefined;
/**
 * Resolve one reference to its VALUE. The only function here that returns a secret, and it is
 * deliberately separate from anything the HTTP layer can reach with a user-supplied ref it prints.
 */
export declare function resolveValue(service: CredentialsService | undefined, ref: string): Promise<{
    value: string;
    source: string;
} | undefined>;
/**
 * Describe a set of references for the panel: presence + source + mask, no values.
 *
 * `refs` is the set the panel cares about (the channels' keyEnv names and keyAlias values). Anything
 * the host can list is added as a candidate too, so the panel can offer a credential it did not know
 * about. A listing failure is not an error: the refs still resolve individually.
 */
export declare function describeRefs(service: CredentialsService | undefined, refs: readonly string[]): Promise<CredentialRow[]>;
/**
 * Store a new credential. This is the panel's "add a key" path, so the secret arrives from the UI and
 * goes straight into the host store — it is never written to this plugin's own files, never logged,
 * and never echoed back (the caller gets only the ref and a mask).
 */
export declare function store(service: CredentialsService | undefined, ref: string, value: string): Promise<{
    ok: true;
    ref: string;
    masked: string;
} | {
    ok: false;
    error: string;
}>;
/** Remove a credential. Mirrors `store`, and refuses to pretend success when the host cannot. */
export declare function remove(service: CredentialsService | undefined, ref: string): Promise<{
    ok: true;
    ref: string;
} | {
    ok: false;
    error: string;
}>;
