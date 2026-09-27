import test from 'node:test'
import assert from 'node:assert/strict'

const { name, apply, registerHttpRoutes, createBusyLoop, hostLlm, runBusyLoop, inject, resolveCredential } =
  await import('../dist/index.js')

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

test('declares inject for every ctx service it reads (tools)', () => {
  // cordis lesson (0.1.6 crash): reading a REGISTERED service property off ctx
  // throws "cannot get property X without inject" — optional chaining does NOT
  // help (the proxy get trap throws). tools is the only registered service
  // this plugin reads, so it must be listed.
  assert.ok(Array.isArray(inject), 'inject must be an array')
  assert.ok(inject.includes('tools'), 'ctx.tools is read in apply — must be injected')
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

// 捕获 registerHttpRoutes 注册的路由, 并用假 req/res 调用它 —— 直接测我们自己的
// handler, 而不是 Hono 的 Request/Response 适配层。
function captureRoutes(deps) {
  const routes = new Map();
  // `deps` goes straight through: `rejected` is optional on the route helper now, so a caller that
  // supplies only { llm } (or nothing) still gets working routes. Before that fix every route threw
  // `rejected is not defined` on the first request -- see the fence note in src/index.ts.
  registerHttpRoutes(deps ?? {}, (kind, path, handler) => { routes.set(path, { kind, handler }); });
  const call = async (path, method = 'GET') => {
    const route = routes.get(path);
    if (!route) throw new Error('no route registered at ' + path);
    const res = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await route.handler({ method, url: path }, res);
    return res;
  };
  return { routes, call };
}

test('health endpoint responds 200 and apply mounts for real', async () => {
  const { call } = captureRoutes({});
  const res = await call('/api/busyloop/health');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(String(res.body));
  assert.equal(body.ok, true);
  assert.equal(body.plugin, 'dsh-busyloop');
  assert.equal(body.hostLlm, true);

  // apply 现在注册到官方 ctx.webServer —— 通过 ctx.inject 收依赖。
  // 直接读 ctx.webServer 会踩 cordis 的代理陷阱(见下面的 cordisCtx)。
  const registered = [];
  let effectLabel = null;
  apply({
    inject: (deps, cb) => {
      assert.deepEqual(deps, ['webServer']);
      return cb({ webServer: { register: (r) => { registered.push(r); return () => {}; } }, effect: (fn, label) => { effectLabel = label; fn(); } });
    },
  });
  const paths = registered.map((r) => r.path).sort();
  // The six panel routes are part of the surface now: the settings panel drives them, and they are
  // asserted separately in panel.test.mjs. This list is the "what does apply() mount" contract.
  assert.deepEqual(paths, [
    '/api/busyloop/channel',
    '/api/busyloop/channels',
    '/api/busyloop/credential',
    '/api/busyloop/credentials',
    '/api/busyloop/health',
    '/api/busyloop/providers',
    '/api/busyloop/test',
  ]);
  assert.match(String(effectLabel), /busyloop/);

  // 非 GET 必须 405(官方范式里的 method 检查)
  const notAllowed = await call('/api/busyloop/health', 'POST');
  assert.equal(notAllowed.statusCode, 405);
  assert.equal(notAllowed.headers['allow'], 'GET');

  // 没有 webServer 时不应抛错(引擎仍可作为库使用)
  apply({});
  assert.doesNotThrow(() => apply(cordisCtx({ extra: { tools: { register: () => {} } } })));
})

// 复刻 cordis 的 ctx 代理: 读一个已注册但**未声明 inject** 的服务时, get 陷阱先抛
// "cannot get property X without inject" —— 可选链 `ctx.webServer?.x` 挡不住。
// 这正是本次迁移踩到的坑: 在 apply 里直接读 ctx.webServer 会让整个插件激活失败。
function cordisCtx({ webServer, extra = {} } = {}) {
  let inInject = false;
  const target = {
    ...extra,
    inject: (deps, cb) => {
      if (!deps.includes('webServer') || !webServer) return undefined;
      const prev = inInject;
      inInject = true;
      try { return cb({ webServer, effect: extra.effect }); } finally { inInject = prev; }
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'webServer' && !inInject) throw new Error('cannot get property "webServer" without inject');
      return t[prop];
    },
  });
}

test('the cordis trap is real, and apply avoids it by using ctx.inject', () => {
  const ctx = cordisCtx({ webServer: { register: () => () => {} } });
  assert.throws(() => ctx.webServer, /without inject/);
  assert.doesNotThrow(() => apply(ctx));
})

// 实测回归: busyloop 的 apply 早于 webServer 提供, ctx.inject 的回调**稍后**才触发;
// 回调里一旦读 `ctx.llm`(未声明 inject 的已注册服务), 代理就抛, 而这个抛发生在
// webCtx.effect() 里会被**静默吞掉** —— 路由一个都不注册, 请求落到 /api 前缀围栏返回 401。
// 所以 llm 必须经 ctx.get 惰性读取。这个测试用一个"读 llm 就抛"的 ctx 复刻该场景。
test('apply still registers routes when reading ctx.llm would throw', () => {
  const registered = [];
  let effectLabel = null;
  const services = { llm: { fake: true } };
  const ctx = new Proxy(
    {
      inject: (deps, cb) => cb({
        webServer: { register: (r) => { registered.push(r); return () => {}; } },
        effect: (fn, label) => { effectLabel = label; fn(); },
      }),
      get: (name) => services[name],
    },
    {
      get(t, prop) {
        if (prop === 'llm' && !('__insideGet' in t)) {
          throw new Error('cannot get property "llm" without inject');
        }
        return t[prop];
      },
    },
  );
  assert.throws(() => ctx.llm, /without inject/);
  assert.doesNotThrow(() => apply(ctx));
  assert.deepEqual(registered.map((r) => r.path).sort(), [
    '/api/busyloop/channel',
    '/api/busyloop/channels',
    '/api/busyloop/credential',
    '/api/busyloop/credentials',
    '/api/busyloop/health',
    '/api/busyloop/providers',
    '/api/busyloop/test',
  ]);
  assert.match(String(effectLabel), /busyloop/);
});

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
  const { call } = captureRoutes({ llm: service });
  const res = await call('/api/busyloop/providers');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(String(res.body)).providers, [{ id: 'deepseek' }])
})

test('providers endpoint degrades to empty list without llm service', async () => {
  const { call } = captureRoutes({});
  const res = await call('/api/busyloop/providers');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(String(res.body)).providers, [])
})

test('apply tolerates host without http mount', () => {
  apply({})
})

test('apply registers ONLY busyloop_run — the four key tools are gone by design', () => {
  const registered = []
  apply({ tools: { register: (def) => registered.push(def) } })
  const names = registered.map((d) => d.name)
  // The key tools were removed deliberately: busyloop must not keep a second credential store
  // beside the host's. Selecting a credential now happens in the settings panel, which drives
  // ctx.credentials. This assertion is the guard against them creeping back.
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
    // The message now names the channel AND each reference that was tried, because "which key is
    // missing" was previously guesswork: it must still say no credential was found, and must point
    // at the one place that can fix it (the settings panel).
    assert.match(out.error, /No credential found for channel "ark"/)
    assert.match(out.error, /ARK_API_KEY/)
    assert.match(out.error, /settings panel/)
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevHome
    if (prevArk === undefined) delete process.env.ARK_API_KEY
    else process.env.ARK_API_KEY = prevArk
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// credential resolution: the host service first, the file only as a fallback
// ---------------------------------------------------------------------------

test('resolveCredential prefers ctx.credentials and never reads the file when it answers', async () => {
  // A fake service is enough to pin the precedence, and it keeps the test away from the real
  // ~/.dsh/.credentials.yaml (which holds live keys).
  const calls = []
  const ctx = {
    get: (n) => (n === 'credentials'
      ? { resolve: async (ref) => { calls.push(ref); return { value: 'from-service', source: 'user-env' } } }
      : undefined),
  }
  const got = await resolveCredential(ctx, 'SOME_KEY', undefined)
  assert.equal(got.value, 'from-service')
  assert.equal(got.source, 'ctx.credentials')
  assert.deepEqual(calls, ['SOME_KEY'], 'the ref passed to the service is the env-var name')
})

test('resolveCredential: an explicit env override wins over the service', async () => {
  let touched = false
  const ctx = { get: () => ({ resolve: async () => { touched = true; return { value: 'from-service' } } }) }
  const got = await resolveCredential(ctx, 'SOME_KEY', 'from-override')
  assert.equal(got.value, 'from-override')
  assert.equal(got.source, 'env-override')
  assert.equal(touched, false, 'the service must not be consulted when an override is present')
})

test('resolveCredential falls back to the file, and degrades when the service throws', async () => {
  // Point HOME at a throwaway dir so the fallback reads a file WE control, never the real one.
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'busyloop-cred-'))
  const prevHome = process.env.USERPROFILE
  const prevHomePosix = process.env.HOME
  try {
    process.env.USERPROFILE = home
    process.env.HOME = home
    await mkdir(join(home, '.dsh'), { recursive: true })
    await writeFile(join(home, '.dsh', '.credentials.yaml'), 'refs:\n  FILE_KEY: file-value\n', 'utf8')

    // service throws (e.g. a name outside the reference grammar) -> must fall through, not throw
    const throwing = { get: () => ({ resolve: async () => { throw new Error('not a reference') } }) }
    const got = await resolveCredential(throwing, 'FILE_KEY', undefined)
    assert.equal(got.value, 'file-value')
    assert.equal(got.source, 'file')

    // no service at all -> same fallback
    const got2 = await resolveCredential({}, 'FILE_KEY', undefined)
    assert.equal(got2.value, 'file-value')

    // neither -> undefined, and it must NOT invent a value
    const missing = await resolveCredential({}, 'ABSENT_KEY', undefined)
    assert.equal(missing, undefined)
  } finally {
    if (prevHome === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = prevHome
    if (prevHomePosix === undefined) delete process.env.HOME
    else process.env.HOME = prevHomePosix
    await rm(home, { recursive: true, force: true })
  }
})
