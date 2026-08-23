/**
 * dsh-busyloop: per-session API key store.
 *
 * 目的:多人共用 dsh + bot 自动化时,每个人用自己的 key —— key 只存在于
 * busyloop 自己的 JSON 文件(不入 process.env、不入 ~/.dsh/.credentials.yaml),
 * 在聊天里通过 busyloop_key_use 选择,运行日志只显示 alias + 脱敏尾号。
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type KeyScope = 'chat' | 'subagent'

export interface KeyEntry {
  id: string
  alias: string
  key: string
  scope: KeyScope
  /** Optional channel this key is bound to (ark/direct/custom). Keys without a channel match any. */
  channel?: string
  createdAt: string
}

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const KEY_FILE = process.env.DSH_BUSYLOOP_KEYS ?? join(DSH_HOME, 'busyloop-keys.json')
const ACTIVE_FILE = process.env.DSH_BUSYLOOP_ACTIVE ?? join(DSH_HOME, 'busyloop-active.json')

function readStore(): KeyEntry[] {
  try {
    if (!existsSync(KEY_FILE)) return []
    const raw = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((e) => e && typeof e.alias === 'string' && typeof e.key === 'string')
  } catch {
    return []
  }
}

function writeStore(entries: KeyEntry[]): void {
  mkdirSync(DSH_HOME, { recursive: true })
  writeFileSync(KEY_FILE, JSON.stringify(entries, null, 2), 'utf8')
  try { chmodSync(KEY_FILE, 0o600) } catch { /* non-POSIX: best effort */ }
}

/** sk-abc123... -> sk-****c123 (前 4 后 4,绝不回显完整 key) */
export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

export function listKeys(): Array<Omit<KeyEntry, 'key'> & { masked: string; active: boolean }> {
  const entries = readStore()
  const active = readActiveAlias()
  return entries.map((e) => ({ id: e.id, alias: e.alias, scope: e.scope, channel: e.channel, createdAt: e.createdAt, masked: maskKey(e.key), active: e.alias === active }))
}

export function addKey(alias: string, key: string, scope: KeyScope, channel?: string): KeyEntry {
  const cleanAlias = alias.trim()
  const cleanKey = key.trim()
  const cleanChannel = channel?.trim() || undefined
  if (!cleanAlias) throw new Error('alias must not be empty')
  if (!cleanKey) throw new Error('key must not be empty')
  if (cleanKey.length < 8) throw new Error('key too short (min 8 chars)')
  const entries = readStore()
  if (entries.some((e) => e.alias === cleanAlias)) {
    const updated = entries.map((e) => (e.alias === cleanAlias ? { ...e, key: cleanKey, scope, channel: cleanChannel } : e))
    writeStore(updated)
    return updated.find((e) => e.alias === cleanAlias) as KeyEntry
  }
  const entry: KeyEntry = { id: randomUUID(), alias: cleanAlias, key: cleanKey, scope, channel: cleanChannel, createdAt: new Date().toISOString() }
  writeStore([...entries, entry])
  return entry
}

export function removeKey(alias: string): boolean {
  const entries = readStore()
  const next = entries.filter((e) => e.alias !== alias)
  if (next.length === entries.length) return false
  writeStore(next)
  if (readActiveAlias() === alias) clearActiveAlias()
  return true
}

function readActiveAlias(): string | undefined {
  try {
    if (!existsSync(ACTIVE_FILE)) return undefined
    return JSON.parse(readFileSync(ACTIVE_FILE, 'utf8'))?.alias
  } catch { return undefined }
}

function writeActiveAlias(alias: string): void {
  mkdirSync(DSH_HOME, { recursive: true })
  writeFileSync(ACTIVE_FILE, JSON.stringify({ alias }, null, 2), 'utf8')
  try { chmodSync(ACTIVE_FILE, 0o600) } catch { /* best effort */ }
}

function clearActiveAlias(): void {
  try { writeFileSync(ACTIVE_FILE, JSON.stringify({ alias: null }, null, 2), 'utf8') } catch { /* best effort */ }
}

/** 聊天内选择:把某个 chat-scope key 设为当前会话生效(仅影响后续 busyloop_run)。 */
export function useKey(alias: string): { ok: boolean; alias: string; masked: string } {
  const entry = readStore().find((e) => e.alias === alias)
  if (!entry) throw new Error(`no key registered under alias "${alias}"`)
  if (entry.scope !== 'chat') throw new Error(`key "${alias}" is scope=${entry.scope}; only chat-scope keys can be selected from the chat`)
  writeActiveAlias(alias)
  return { ok: true, alias: entry.alias, masked: maskKey(entry.key) }
}

export function activeKeyInfo(): { alias?: string; masked?: string } {
  const alias = readActiveAlias()
  if (!alias) return {}
  const entry = readStore().find((e) => e.alias === alias)
  if (!entry) return {}
  return { alias: entry.alias, masked: maskKey(entry.key) }
}

/**
 * 解析本次 busyloop_run 实际使用的 key:
 * 1) 当前会话选中的 chat-scope key(active alias)
 * 2) 回退:全局 env / credentials(由调用方提供 loadEnvKey)
 */
export function resolveEffectiveKey(
  loadEnvKey: (keyEnv: string) => string | undefined,
  keyEnv: string,
  channel?: string,
): { key?: string; alias?: string; masked?: string; source: 'session' | 'global' } {
  const active = readActiveAlias()
  if (active) {
    const entry = readStore().find((e) => e.alias === active)
    // A session key bound to another channel must NOT leak into this call:
    // it would hit the wrong endpoint with the wrong key (401 / misbill).
    if (entry && (!entry.channel || entry.channel === channel)) {
      return { key: entry.key, alias: entry.alias, masked: maskKey(entry.key), source: 'session' }
    }
  }
  const envKey = loadEnvKey(keyEnv)
  if (envKey) return { key: envKey, masked: maskKey(envKey), source: 'global' }
  return { source: 'global' }
}
