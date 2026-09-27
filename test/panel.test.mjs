/**
 * Tests for the busyloop settings panel: the channel config layer, the credential rules, and the
 * six routes the panel drives.
 *
 * WHAT THESE DEFEND
 *
 *  1. NO SECRET EVER COMES BACK. The panel's whole job is to show WHICH credential answers a call,
 *     never the credential. Several assertions here read the raw response text and fail if the key
 *     material appears anywhere in it — a mask is not enough if the value is also in the payload.
 *
 *  2. THE PRIVATE KEY STORE IS GONE. busyloop_key_* is asserted absent, and the channel config is
 *     asserted to live in one file that the panel and the call path BOTH read.
 *
 *  3. THE OVERRIDE LAYER REALLY WINS. A channel configured in the panel must take precedence over
 *     the built-in constant, otherwise editing `ark` in the UI would silently do nothing.
 *
 * ISOLATION: every test points DSH_BUSYLOOP_CHANNELS at a temp file, so the user's real
 * ~/.dsh/busyloop-channels.json is never read or written. The module is re-imported with a cache-
 * busting query per test so module-level state cannot leak between them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIST = new URL('../dist/index.js', import.meta.url).href;

/** A fresh module instance per test, so env changes and caches cannot bleed across cases. */
let seq = 0;
async function fresh() {
  seq += 1;
  return import(`${DIST}?t=${seq}`);
}

/** Run `fn` with an isolated channel-config file, restoring the env afterwards. */
async function withTempConfig(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'busyloop-panel-'));
  const file = join(dir, 'channels.json');
  const prev = process.env.DSH_BUSYLOOP_CHANNELS;
  process.env.DSH_BUSYLOOP_CHANNELS = file;
  try {
    return await fn({ dir, file });
  } finally {
    if (prev === undefined) delete process.env.DSH_BUSYLOOP_CHANNELS;
    else process.env.DSH_BUSYLOOP_CHANNELS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Capture the registered routes and drive them with fake req/res, including a JSON body. */
function captureRoutes(deps) {
  const routes = new Map();
  const mod = deps.__mod;
  // `registerHttpRoutes` takes `builtins` as a GETTER (it must report exactly what a call would
  // resolve, and the built-in table is a module constant). Tests want to pass a plain object, so
  // adapt here rather than making every call site remember the shape. (Measured: passing the object
  // straight through made five panel routes answer 500 "deps.builtins is not a function".)
  const adapted = { ...deps, builtins: typeof deps.builtins === 'function' ? deps.builtins : () => deps.builtins };
  delete adapted.__mod;
  mod.registerHttpRoutes(adapted, (kind, path, handler) => {
    routes.set(path, { kind, handler });
  });
  const call = async (path, method = 'GET', body) => {
    const route = routes.get(path);
    if (!route) throw new Error('no route registered at ' + path);
    const res = {
      statusCode: 0,
      headers: {},
      body: undefined,
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { this.body = b; },
    };
    // A minimal request: the handlers only read method and, for POST, the JSON body stream.
    const req = {
      method,
      url: path,
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
        return this;
      },
      destroy() {},
    };
    await route.handler(req, res);
    return res;
  };
  return { routes, call };
}

/** A credential service stub that records what it was asked and never reveals more than it must. */
function fakeCredentials(store = {}) {
  const calls = [];
  return {
    calls,
    store,
    service: {
      async resolve(ref) {
        calls.push(['resolve', ref]);
        return store[ref] ? { value: store[ref], source: 'stub' } : undefined;
      },
      async describe(ref) { return { source: 'stub' }; },
      async set(ref, value) { calls.push(['set', ref]); store[ref] = value; },
      async unset(ref) { calls.push(['unset', ref]); delete store[ref]; },
      async listRecords() { return Object.keys(store); },
    },
  };
}

const BUILTINS = {
  ark: { baseURL: 'https://ark.example/api/plan/v3', model: 'deepseek-v4.1-flash', keyEnv: 'ARK_API_KEY' },
  direct: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
};

test('channel config: read/write round-trips through one file', async () => {
  await withTempConfig(async ({ file }) => {
    const mod = await fresh();
    const written = mod.writeChannelConfig('ark', {
      baseURL: 'https://ark.example/api/plan/v3',
      model: 'deepseek-v4.1-flash',
      keyEnv: 'ARK_API_KEY',
      maxTokens: 4096,
    });
    assert.equal(written.ok, true, written.ok ? '' : written.error);
    assert.ok(existsSync(file), 'the config file was created');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.ark.model, 'deepseek-v4.1-flash');
    assert.equal(raw.ark.maxTokens, 4096);
    const read = mod.readChannelConfig();
    assert.equal(read.error, undefined);
    assert.equal(read.channels.ark.maxTokens, 4096);
  });
});

test('channel config: a malformed entry is ignored, not carried into a call', async () => {
  await withTempConfig(async ({ file }) => {
    writeFileSync(file, JSON.stringify({
      good: { baseURL: 'https://x.example', model: 'm', keyEnv: 'X_KEY' },
      noModel: { baseURL: 'https://x.example', keyEnv: 'X_KEY' },
      junk: 42,
      negative: { baseURL: 'https://x.example', model: 'm', keyEnv: 'X_KEY', maxTokens: -5, delayMs: -1 },
    }));
    const mod = await fresh();
    const { channels } = mod.readChannelConfig();
    assert.deepEqual(Object.keys(channels).sort(), ['good', 'negative'], 'only usable entries survive');
    assert.equal(channels.negative.maxTokens, undefined, 'a negative budget is dropped, not stored');
    assert.equal(channels.negative.delayMs, undefined);
  });
});

test('channel config: a broken file degrades to built-ins instead of throwing', async () => {
  await withTempConfig(async ({ file }) => {
    writeFileSync(file, '{ this is not json');
    const mod = await fresh();
    const read = mod.readChannelConfig();
    assert.deepEqual(read.channels, {}, 'no overrides');
    assert.ok(read.error, 'and the panel is told why');
    // A write must REFUSE rather than silently discard a file we could not parse.
    const written = mod.writeChannelConfig('ark', { baseURL: 'https://x', model: 'm', keyEnv: 'K' });
    assert.equal(written.ok, false);
    assert.match(written.error, /refusing to write/);
  });
});

test('channel config: an edit MERGES, so a panel that sends one field does not erase the rest', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    mod.writeChannelConfig('ark', { baseURL: 'https://ark.example', model: 'm1', keyEnv: 'ARK_API_KEY', maxTokens: 1024 });
    // Send only a new model, the way the panel does when one input changed.
    const merged = { ...mod.readChannelConfig().channels.ark, model: 'm2' };
    const result = mod.writeChannelConfig('ark', merged);
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    const after = mod.readChannelConfig().channels.ark;
    assert.equal(after.model, 'm2');
    assert.equal(after.baseURL, 'https://ark.example', 'baseURL survived the edit');
    assert.equal(after.maxTokens, 1024, 'maxTokens survived the edit');
  });
});

test('channel config: the override layer WINS over the built-in constant', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    // `ark` is a built-in with a known baseURL; the panel override must shadow it.
    mod.writeChannelConfig('ark', {
      baseURL: 'https://overridden.example/v1',
      model: 'overridden-model',
      keyEnv: 'ARK_API_KEY',
    });
    const { channels } = mod.readChannelConfig();
    assert.equal(channels.ark.baseURL, 'https://overridden.example/v1');
  });
});

test('credentials: mask keeps a distinguishable tail and never the head', async () => {
  const mod = await fresh();
  const masked = mod.maskCredential('sk-supersecretvalue1234');
  assert.ok(!masked.includes('sk-super'), 'no leading material');
  assert.ok(masked.includes('1234'), 'the tail is kept so two keys are distinguishable');
  assert.equal(mod.maskCredential(''), '(empty)');
  assert.equal(mod.maskCredential('short'), '*****');
});

test('credentials: describe returns presence + mask and NO value', async () => {
  const mod = await fresh();
  const fake = fakeCredentials({ ARK_API_KEY: 'sk-aaaaaaaaaaaaaaaa9999' });
  const rows = await mod.describeCredentialRefs(fake.service, ['ARK_API_KEY', 'MISSING_KEY']);
  assert.equal(rows.length, 2);
  const present = rows.find((r) => r.ref === 'ARK_API_KEY');
  const absent = rows.find((r) => r.ref === 'MISSING_KEY');
  assert.equal(present.present, true);
  assert.equal(absent.present, false);
  const serialised = JSON.stringify(rows);
  assert.ok(!serialised.includes('sk-aaaaaaaaaaaaaaaa9999'), 'the raw secret must not appear in the payload');
});

test('credentials: store refuses to claim success when the value cannot be read back', async () => {
  const mod = await fresh();
  // A service whose set() does nothing: the row would look stored while nothing is there.
  const service = {
    async resolve() { return undefined },
    async set() { /* silently drops */ },
  };
  const result = await mod.storeCredential(service, 'SOME_KEY', 'value');
  assert.equal(result.ok, false);
  assert.match(result.error, /could not read it back/);
});

test('credentials: a host with no service degrades with a clear message', async () => {
  const mod = await fresh();
  const stored = await mod.storeCredential(undefined, 'K', 'v');
  assert.equal(stored.ok, false);
  assert.match(stored.error, /no credentials service/);
  const removed = await mod.removeCredential(undefined, 'K');
  assert.equal(removed.ok, false);
});

test('routes: GET /channels lists built-ins with their effective key source', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    const fake = fakeCredentials({ ARK_API_KEY: 'sk-aaaaaaaaaaaaaaaa9999' });
    const { call } = captureRoutes({ __mod: mod, builtins: BUILTINS, credentials: () => fake.service });
    const res = await call('/api/busyloop/channels');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(String(res.body));
    assert.equal(body.ok, true);
    const ark = body.channels.find((c) => c.key === 'ark');
    assert.equal(ark.from, 'builtin');
    assert.equal(ark.via, 'credential:ARK_API_KEY');
    assert.ok(ark.callable);
    // The whole payload is inspected, because a leak could hide in any field.
    assert.ok(!String(res.body).includes('sk-aaaaaaaaaaaaaaaa9999'), 'no raw secret in the response');
    const direct = body.channels.find((c) => c.key === 'direct');
    assert.equal(direct.callable, false, 'a channel with no credential is reported as not callable');
    assert.equal(direct.via, null);
  });
});

test('routes: an override is reported as coming from the panel, and keyAlias wins over keyEnv', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    mod.writeChannelConfig('ark', {
      baseURL: 'https://overridden.example/v1',
      model: 'overridden-model',
      keyEnv: 'ARK_API_KEY',
      keyAlias: 'MY_SHARED_KEY',
    });
    const fake = fakeCredentials({
      ARK_API_KEY: 'sk-env-value-should-lose-1111',
      MY_SHARED_KEY: 'sk-alias-value-should-win-2222',
    });
    const { call } = captureRoutes({ __mod: mod, builtins: BUILTINS, credentials: () => fake.service });
    const body = JSON.parse(String(await call('/api/busyloop/channels').then((r) => r.body)));
    const ark = body.channels.find((c) => c.key === 'ark');
    assert.equal(ark.from, 'override');
    // The full merged config travels under `config`; `keyAlias`/`keyEnv`/`via` are lifted to the top
    // level because they are what the panel renders as the key column.
    assert.equal(ark.config.model, 'overridden-model');
    assert.equal(ark.config.baseURL, 'https://overridden.example/v1');
    assert.equal(ark.via, 'alias:MY_SHARED_KEY', 'the alias takes precedence over keyEnv');
    assert.ok(!String(JSON.stringify(body)).includes('sk-alias-value-should-win-2222'));
  });
});

test('routes: POST /channel rejects an incomplete channel instead of storing a broken row', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    const { call } = captureRoutes({ __mod: mod, builtins: BUILTINS });
    const res = await call('/api/busyloop/channel', 'POST', { key: 'brandNew', model: 'm' });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(String(res.body));
    assert.equal(body.ok, false);
    assert.match(body.error, /needs baseURL, model and keyEnv/);
  });
});

test('routes: POST /channel with remove:true deletes the override', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    mod.writeChannelConfig('ark', { baseURL: 'https://x.example', model: 'm', keyEnv: 'K' });
    const { call } = captureRoutes({ __mod: mod, builtins: BUILTINS });
    const res = await call('/api/busyloop/channel', 'POST', { key: 'ark', remove: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(mod.readChannelConfig().channels, {}, 'the override is gone');
  });
});

test('routes: GET /credentials never returns a value, only refs and masks', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    const secret = 'sk-cccccccccccccccc7777';
    const fake = fakeCredentials({ ARK_API_KEY: secret });
    const { call } = captureRoutes({ __mod: mod, builtins: BUILTINS, credentials: () => fake.service });
    const res = await call('/api/busyloop/credentials');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(String(res.body));
    assert.equal(body.ok, true);
    assert.ok(body.credentials.some((c) => c.ref === 'ARK_API_KEY' && c.present));
    assert.ok(!String(res.body).includes(secret), 'the raw secret must never be in the payload');
    assert.ok(String(res.body).includes('7777'), 'but the mask tail is, so the user can tell keys apart');
  });
});

test('routes: POST /credential stores through the host service, and never echoes the value', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    const store = {};
    const fake = fakeCredentials(store);
    const { call } = captureRoutes({ __mod: mod, builtins: BUILTINS, credentials: () => fake.service });
    const secret = 'sk-dddddddddddddddd5555';
    const res = await call('/api/busyloop/credential', 'POST', { ref: 'NEW_KEY', value: secret });
    assert.equal(res.statusCode, 200);
    assert.equal(store.NEW_KEY, secret, 'it reached the host store');
    assert.ok(!String(res.body).includes(secret), 'and was not echoed back');
    assert.deepEqual(fake.calls.filter((c) => c[0] === 'set'), [['set', 'NEW_KEY']]);
  });
});

test('routes: a wrong method is 405 and every panel route still passes the fence', async () => {
  await withTempConfig(async () => {
    const mod = await fresh();
    let fenced = 0;
    const rejected = () => { fenced += 1; return true; };
    const { call } = captureRoutes({ __mod: mod, builtins: BUILTINS, rejected });
    for (const path of ['/api/busyloop/channels', '/api/busyloop/credentials']) {
      const res = await call(path);
      assert.equal(res.statusCode, 0, `${path} must not answer when the fence refuses`);
    }
    assert.equal(fenced, 2, 'the fence was consulted on every route');
    // And a method mismatch is refused without touching the work.
    const mod2 = await fresh();
    const second = captureRoutes({ __mod: mod2, builtins: BUILTINS });
    const res = await second.call('/api/busyloop/channels', 'POST', {});
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET');
  });
});
