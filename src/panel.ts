/**
 * Channel configuration for the busyloop settings panel.
 *
 * THREE LAYERS, one file. The panel needs to edit the BUILT-IN channels too (a user who wants to
 * point `ark` at a different model should not have to patch a source constant), so
 * ~/.dsh/busyloop-channels.json is read as an OVERRIDE map rather than as "the custom channels":
 *
 *   1. panel overrides    ~/.dsh/busyloop-channels.json   <- wins, written by the panel
 *   2. built-in           CHANNELS in index.ts (ark, direct)
 *   3. host-registered    ctx.llm.listProviders()         <- last resort, in index.ts
 *
 * The file is the same one `loadCustomChannels` already read, so an existing hand-written entry
 * (e.g. a "momotale" router channel) keeps working unchanged: it is simply an override for a
 * channel that has no built-in.
 *
 * Writes are read-modify-write over the WHOLE file so a panel edit cannot drop a channel the panel
 * does not know about, and they go through a temp file + rename so a crash mid-write cannot leave a
 * truncated config (the old content survives).
 *
 * `keyAlias` is what replaces the removed private key store: instead of holding a key of its own,
 * a channel NAMES a host credential. Resolution order per channel is therefore
 *     keyAlias (host credential record)  ->  keyEnv (env var / ctx.credentials ref)  ->  legacy file
 * and the panel shows which of those actually answered.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One channel's configuration, as the panel sees it. */
export interface ChannelConfig {
  baseURL: string
  model: string
  keyEnv: string
  /** Host credential record (or alias) this channel should use. Absent = fall back to `keyEnv`. */
  keyAlias?: string
  maxTokens?: number
  contextWindow?: number
  delayMs?: number
  concurrency?: number
}

/** The name of the file the panel writes. Exported for tests and for the panel's own display. */
export function channelsPath(): string {
  return process.env.DSH_BUSYLOOP_CHANNELS ?? join(homedir(), '.dsh', 'busyloop-channels.json')
}

/** Positive-number guard: a bad value must be dropped, not carried through as NaN. */
const posNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined

const nonNegNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

/**
 * Validate one raw entry into a ChannelConfig, or undefined when it is not usable.
 *
 * A channel without baseURL/model/keyEnv cannot be called, so it is rejected rather than stored as
 * a half-configured row the panel would then display as if it worked.
 */
export function normaliseChannel(raw: unknown): ChannelConfig | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  if (typeof v.baseURL !== 'string' || !v.baseURL.trim()) return undefined
  if (typeof v.model !== 'string' || !v.model.trim()) return undefined
  if (typeof v.keyEnv !== 'string' || !v.keyEnv.trim()) return undefined
  const out: ChannelConfig = {
    baseURL: v.baseURL.trim(),
    model: v.model.trim(),
    keyEnv: v.keyEnv.trim(),
  }
  if (typeof v.keyAlias === 'string' && v.keyAlias.trim()) out.keyAlias = v.keyAlias.trim()
  const maxTokens = posNum(v.maxTokens)
  if (maxTokens !== undefined) out.maxTokens = maxTokens
  const contextWindow = posNum(v.contextWindow)
  if (contextWindow !== undefined) out.contextWindow = contextWindow
  const delayMs = nonNegNum(v.delayMs)
  if (delayMs !== undefined) out.delayMs = delayMs
  const concurrency = posNum(v.concurrency)
  if (concurrency !== undefined) out.concurrency = Math.floor(concurrency)
  return out
}

/**
 * Read the override map. Never throws: an unreadable or malformed file means "no overrides", which
 * is exactly the built-in behaviour, so a broken file degrades instead of breaking every call.
 */
export function readChannels(): { channels: Record<string, ChannelConfig>; error?: string } {
  const file = channelsPath()
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as { code?: string })?.code
    // Absent is normal (no overrides yet); anything else is worth surfacing to the panel.
    return code === 'ENOENT' ? { channels: {} } : { channels: {}, error: `cannot read ${file}: ${String(code ?? err)}` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { channels: {}, error: `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { channels: {}, error: `${file} must contain a JSON object of channel name -> config` }
  }
  const channels: Record<string, ChannelConfig> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const channel = normaliseChannel(value)
    if (channel) channels[key] = channel
  }
  return { channels }
}

/**
 * Merge one patch into the file and write it back atomically.
 *
 * Read-modify-write over the whole file on purpose: a panel that knows 3 of your 5 channels must not
 * delete the other 2. A patch whose values are all undefined/empty REMOVES the override, which is
 * how the panel offers "reset to built-in" without deleting keys by hand.
 */
export function writeChannel(
  channelKey: string,
  patch: Partial<ChannelConfig> & { remove?: boolean },
): { ok: true; channels: Record<string, ChannelConfig> } | { ok: false; error: string } {
  if (!channelKey || typeof channelKey !== 'string') return { ok: false, error: 'channel key required' }
  const file = channelsPath()
  const existing = readChannels()
  if (existing.error && !existing.error.includes('ENOENT')) {
    // Refuse to overwrite a file we could not parse: writing would silently discard it.
    return { ok: false, error: `refusing to write: ${existing.error}` }
  }
  const next: Record<string, ChannelConfig> = { ...existing.channels }

  if (patch.remove === true) {
    delete next[channelKey]
  } else {
    const merged = normaliseChannel({ ...(next[channelKey] ?? {}), ...patch })
    // A patch that omits baseURL/model/keyEnv must MERGE with what is there, not fail validation;
    // so an incomplete result means the stored entry is what the caller wanted to keep.
    if (merged) next[channelKey] = merged
    else return { ok: false, error: `channel "${channelKey}" needs baseURL, model and keyEnv` }
  }

  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
    return { ok: true, channels: next }
  } catch (err) {
    return { ok: false, error: `cannot write ${file}: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Remove a temp file left behind by a failed write. Best effort, used by tests. */
export function cleanupTemp(file: string): void {
  try { unlinkSync(file) } catch { /* nothing to clean */ }
}
