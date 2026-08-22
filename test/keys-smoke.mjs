import { addKey, listKeys, maskKey, removeKey, useKey, activeKeyInfo, resolveEffectiveKey } from '../src/keys'
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1) } console.log('PASS:', msg) }
// mask
assert(maskKey('sk-abc12345xyz') === 'sk-a****5xyz', 'maskKey 前4后4')
assert(maskKey('shortkey') === 'sh****', 'maskKey 短 key')
// add + list 脱敏
const e = addKey('alice-ark', 'sk-alice-secret-key-001', 'chat')
assert(e.alias === 'alice-ark', 'addKey chat')
addKey('bot-sub', 'sk-bot-subagent-key-002', 'subagent')
const list = listKeys()
assert(list.length === 2, 'listKeys 2 entries')
assert(list[0].masked.includes('****'), 'list 脱敏')
assert(!JSON.stringify(list).includes('secret'), 'list 不含完整 key')
// use + active
const used = useKey('alice-ark')
assert(used.ok && used.masked.includes('****'), 'useKey 成功+脱敏')
const active = activeKeyInfo()
assert(active.alias === 'alice-ark', 'active alias')
// resolve 优先级:session key > env
const envLoad = () => 'sk-env-global-key-003'
const r1 = resolveEffectiveKey(envLoad, 'ARK_API_KEY')
assert(r1.source === 'session' && r1.alias === 'alice-ark', 'resolve 优先 session key')
// remove 后回退 env
removeKey('alice-ark')
const r2 = resolveEffectiveKey(envLoad, 'ARK_API_KEY')
assert(r2.source === 'global' && r2.key === 'sk-env-global-key-003', 'remove 后回退 env')
// 清理
removeKey('bot-sub')
console.log('ALL KEY-STORE TESTS PASSED')