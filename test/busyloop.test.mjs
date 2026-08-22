import test from 'node:test'
import assert from 'node:assert/strict'

const { name, apply, createHonoApp, createBusyLoop, hostLlm, runBusyLoop } = await import('../dist/index.js')

/** Build a fake host LLM service that replays per-call chunk sequences. */
function fakeLlm(sequences) {
  let calls = 0
  const seenOptions = []
  const service = {
    listProviders: () => [{ id: 'deepseek', models: [] }],
    stream(options) {
      seenOptions.push(options)
      const seq = sequences[Math.min(calls, sequences.length - 1)]
      calls++
      return (async function* () {
        for (const chunk of seq) yield chunk
      })()
    },
  }
  return { service, seenOptions: () => seenOptions, calls: () => calls }
}

function toolCallChunks(callId, name, argsJson) {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argsJson } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const echoTool = {
  name: 'echo',
  description: 'echo the given text back',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  execute: async (args) => ({ echoed: args.text }),
}

test('exports name/apply/createBusyLoop', () => {
  assert.equal(name, 'dsh-busyloop')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof createBusyLoop, 'function')
})

test('multi-turn loop: tool call then final text', async () => {
  const { service } = fakeLlm([
    toolCallChunks('c1', 'echo', '{"text":"hi"}'),
    textChunks('echoed hi back'),
  ])
  const llm = hostLlm(service)
  const events = []
  const result = await runBusyLoop(llm, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    prompt: 'test task',
    tools: [echoTool],
    onEvent: (ev) => events.push(ev),
  })
  assert.equal(result.turns, 2)
  assert.equal(result.toolCalls, 1)
  assert.equal(result.output, 'echoed hi back')
  assert.equal(result.finish, 'stop')
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'echo' && e.ok))
})

test('tool receives parsed arguments and result is fed back', async () => {
  let received = null
  const tool = { ...echoTool, execute: async (args) => { received = args; return 'ok' } }
  const { service, seenOptions } = fakeLlm([
    toolCallChunks('c9', 'echo', '{"text":"hello world"}'),
    textChunks('done'),
  ])
  const result = await runBusyLoop(hostLlm(service), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    prompt: 'p',
    tools: [tool],
  })
  assert.deepEqual(received, { text: 'hello world' })
  assert.equal(result.output, 'done')
  // second call must include the tool result message
  const second = seenOptions()[1]
  assert.ok(second.messages.some((m) => JSON.stringify(m).includes('tool-result')))
})

test('no tools: single turn completes', async () => {
  const { service } = fakeLlm([textChunks('plain answer')])
  const result = await runBusyLoop(hostLlm(service), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    prompt: 'p',
  })
  assert.equal(result.turns, 1)
  assert.equal(result.toolCalls, 0)
  assert.equal(result.output, 'plain answer')
})

test('maxTurns truncates an endless tool loop', async () => {
  const { service } = fakeLlm([toolCallChunks('c1', 'echo', '{}')])
  const result = await runBusyLoop(hostLlm(service), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    prompt: 'p',
    tools: [echoTool],
    maxTurns: 3,
  })
  assert.equal(result.turns, 3)
  assert.ok(result.toolCalls >= 3)
})

test('unknown tool is reported as error, loop continues', async () => {
  const { service } = fakeLlm([
    toolCallChunks('c1', 'nope', '{}'),
    textChunks('recovered'),
  ])
  const events = []
  const result = await runBusyLoop(hostLlm(service), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    prompt: 'p',
    tools: [echoTool],
    onEvent: (ev) => events.push(ev),
  })
  assert.equal(result.turns, 2)
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'nope' && !e.ok))
})

test('tool throwing produces an error result, not a crash', async () => {
  const boom = {
    name: 'boom',
    description: 'always throws',
    parameters: {},
    execute: () => { throw new Error('kaboom') },
  }
  const { service } = fakeLlm([
    toolCallChunks('c1', 'boom', '{}'),
    textChunks('handled'),
  ])
  const result = await runBusyLoop(hostLlm(service), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    prompt: 'p',
    tools: [boom],
  })
  assert.equal(result.output, 'handled')
  assert.equal(result.turns, 2)
})

test('hostLlm passthrough and defaultProvider', () => {
  const { service } = fakeLlm([textChunks('x')])
  const llm = hostLlm(service)
  assert.equal(llm.defaultProvider(), 'deepseek')
  assert.equal(llm.listProviders().length, 1)
})

test('createBusyLoop binds llm and health', async () => {
  const { service } = fakeLlm([textChunks('via engine')])
  const engine = createBusyLoop({ llm: service })
  assert.deepEqual(engine.health(), { ok: true, plugin: 'dsh-busyloop' })
  const result = await engine.run({ provider: 'deepseek', model: 'deepseek-chat', prompt: 'p' })
  assert.equal(result.output, 'via engine')
})

test('health endpoint responds 200 and apply mounts', async () => {
  const app = createHonoApp()
  const res = await app.fetch(new Request('http://localhost/health'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-busyloop')
  assert.equal(body.hostLlm, true)

  let mounted = null
  apply({ http: { mount: (path, a) => { mounted = { path, a } } } })
  assert.equal(mounted.path, '/api/busyloop')
  const res2 = await mounted.a.fetch(new Request('http://localhost/health'))
  assert.equal(res2.status, 200)
})

test('sessionId is stamped on every generation', async () => {
  const { service, seenOptions } = fakeLlm([textChunks('ok')])
  await runBusyLoop(hostLlm(service), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    prompt: 'p',
    sessionId: 'sess-abc',
  })
  assert.equal(seenOptions()[0].sessionId, 'sess-abc')
})

test('providers endpoint lists host providers when llm service present', async () => {
  const { service } = fakeLlm([textChunks('x')])
  const app = createHonoApp({ llm: service })
  const res = await app.fetch(new Request('http://localhost/providers'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.providers, [{ id: 'deepseek' }])
})

test('providers endpoint degrades to empty list without llm service', async () => {
  const app = createHonoApp()
  const res = await app.fetch(new Request('http://localhost/providers'))
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).providers, [])
})

test('apply tolerates host without http mount', () => {
  apply({})
})

test('apply registers the busyloop_run agent tool when ctx.tools present', () => {
  const registered = []
  apply({ tools: { register: (def) => registered.push(def) } })
  const names = registered.map((d) => d.name)
  assert.deepEqual(names, ['busyloop_run'])
})

test('apply tolerates host without tool registry', () => {
  apply({ http: {} })
})

test('busyloop_run fails cleanly without a key (no API call)', async () => {
  const registered = []
  apply({ tools: { register: (def) => registered.push(def) } })
  const run = registered.find((d) => d.name === 'busyloop_run')

  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'bl-home-'))
  const prevHome = process.env.USERPROFILE
  const prevArk = process.env.ARK_API_KEY
  process.env.USERPROFILE = home
  delete process.env.ARK_API_KEY
  try {
    const raw = await run.execute({ prompt: 'Say hi' })
    const out = JSON.parse(raw)
    assert.equal(out.ok, false)
    assert.match(out.error, /No ARK_API_KEY found/)
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevHome
    if (prevArk === undefined) delete process.env.ARK_API_KEY
    else process.env.ARK_API_KEY = prevArk
    await rm(home, { recursive: true, force: true })
  }
})
