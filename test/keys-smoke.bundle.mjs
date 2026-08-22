// src/keys.ts
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
var KEY_FILE = process.env.DSH_BUSYLOOP_KEYS ?? join(DSH_HOME, "busyloop-keys.json");
var ACTIVE_FILE = process.env.DSH_BUSYLOOP_ACTIVE ?? join(DSH_HOME, "busyloop-active.json");
function readStore() {
  try {
    if (!existsSync(KEY_FILE)) return [];
    const raw = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e2) => e2 && typeof e2.alias === "string" && typeof e2.key === "string");
  } catch {
    return [];
  }
}
function writeStore(entries) {
  mkdirSync(DSH_HOME, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify(entries, null, 2), "utf8");
  try {
    chmodSync(KEY_FILE, 384);
  } catch {
  }
}
function maskKey(key) {
  if (key.length <= 10) return `${key.slice(0, 2)}****`;
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}
function listKeys() {
  const entries = readStore();
  const active2 = readActiveAlias();
  return entries.map((e2) => ({ id: e2.id, alias: e2.alias, scope: e2.scope, createdAt: e2.createdAt, masked: maskKey(e2.key), active: e2.alias === active2 }));
}
function addKey(alias, key, scope) {
  const cleanAlias = alias.trim();
  const cleanKey = key.trim();
  if (!cleanAlias) throw new Error("alias must not be empty");
  if (!cleanKey) throw new Error("key must not be empty");
  if (cleanKey.length < 8) throw new Error("key too short (min 8 chars)");
  const entries = readStore();
  if (entries.some((e2) => e2.alias === cleanAlias)) {
    const updated = entries.map((e2) => e2.alias === cleanAlias ? { ...e2, key: cleanKey, scope } : e2);
    writeStore(updated);
    return updated.find((e2) => e2.alias === cleanAlias);
  }
  const entry = { id: randomUUID(), alias: cleanAlias, key: cleanKey, scope, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  writeStore([...entries, entry]);
  return entry;
}
function removeKey(alias) {
  const entries = readStore();
  const next = entries.filter((e2) => e2.alias !== alias);
  if (next.length === entries.length) return false;
  writeStore(next);
  if (readActiveAlias() === alias) clearActiveAlias();
  return true;
}
function readActiveAlias() {
  try {
    if (!existsSync(ACTIVE_FILE)) return void 0;
    return JSON.parse(readFileSync(ACTIVE_FILE, "utf8"))?.alias;
  } catch {
    return void 0;
  }
}
function writeActiveAlias(alias) {
  mkdirSync(DSH_HOME, { recursive: true });
  writeFileSync(ACTIVE_FILE, JSON.stringify({ alias }, null, 2), "utf8");
  try {
    chmodSync(ACTIVE_FILE, 384);
  } catch {
  }
}
function clearActiveAlias() {
  try {
    writeFileSync(ACTIVE_FILE, JSON.stringify({ alias: null }, null, 2), "utf8");
  } catch {
  }
}
function useKey(alias) {
  const entry = readStore().find((e2) => e2.alias === alias);
  if (!entry) throw new Error(`no key registered under alias "${alias}"`);
  if (entry.scope !== "chat") throw new Error(`key "${alias}" is scope=${entry.scope}; only chat-scope keys can be selected from the chat`);
  writeActiveAlias(alias);
  return { ok: true, alias: entry.alias, masked: maskKey(entry.key) };
}
function activeKeyInfo() {
  const alias = readActiveAlias();
  if (!alias) return {};
  const entry = readStore().find((e2) => e2.alias === alias);
  if (!entry) return {};
  return { alias: entry.alias, masked: maskKey(entry.key) };
}
function resolveEffectiveKey(loadEnvKey, keyEnv) {
  const active2 = readActiveAlias();
  if (active2) {
    const entry = readStore().find((e2) => e2.alias === active2);
    if (entry) return { key: entry.key, alias: entry.alias, masked: maskKey(entry.key), source: "session" };
  }
  const envKey = loadEnvKey(keyEnv);
  if (envKey) return { key: envKey, masked: maskKey(envKey), source: "global" };
  return { source: "global" };
}

// test/keys-smoke.mjs
var assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("PASS:", msg);
};
assert(maskKey("sk-abc12345xyz") === "sk-a****5xyz", "maskKey \u524D4\u540E4");
assert(maskKey("shortkey") === "sh****", "maskKey \u77ED key");
var e = addKey("alice-ark", "sk-alice-secret-key-001", "chat");
assert(e.alias === "alice-ark", "addKey chat");
addKey("bot-sub", "sk-bot-subagent-key-002", "subagent");
var list = listKeys();
assert(list.length === 2, "listKeys 2 entries");
assert(list[0].masked.includes("****"), "list \u8131\u654F");
assert(!JSON.stringify(list).includes("secret"), "list \u4E0D\u542B\u5B8C\u6574 key");
var used = useKey("alice-ark");
assert(used.ok && used.masked.includes("****"), "useKey \u6210\u529F+\u8131\u654F");
var active = activeKeyInfo();
assert(active.alias === "alice-ark", "active alias");
var envLoad = () => "sk-env-global-key-003";
var r1 = resolveEffectiveKey(envLoad, "ARK_API_KEY");
assert(r1.source === "session" && r1.alias === "alice-ark", "resolve \u4F18\u5148 session key");
removeKey("alice-ark");
var r2 = resolveEffectiveKey(envLoad, "ARK_API_KEY");
assert(r2.source === "global" && r2.key === "sk-env-global-key-003", "remove \u540E\u56DE\u9000 env");
removeKey("bot-sub");
console.log("ALL KEY-STORE TESTS PASSED");
