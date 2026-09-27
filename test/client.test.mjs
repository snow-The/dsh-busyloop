/**
 * Execute the busyloop CLIENT bundle against a fake host.
 *
 * WHY THIS EXISTS. A static scan of client.js cannot tell "the slot registration is absent" from
 * "the slot registration exists but can never run" — mutations that wrap it in `if (false)`, or that
 * rename the loader id, both left a string-matching checker green. Measured: 2 of 5 client mutations
 * slipped through. The only honest check is to RUN the bundle and observe what the host would see.
 *
 * That is cheap here because client.js is a hand-written bundle with no build step: it is plain
 * browser JavaScript that only needs `window.__ModuleLoader__`, a `require`, and a ctx. So the whole
 * client contract is executable in Node:
 *
 *   - the loader receives exactly one load() with the id the PACKAGE declares
 *   - the factory returns { apply, inject } (the host checks apply; a throw here is a dead plugin)
 *   - inject names the client services the panel needs ('slots', 'locale')
 *   - apply() registers dictionaries AND claims the settings.section slot, with a stable id
 *   - the registered component really is a function (the host renders it)
 *
 * A factory that throws is the failure mode this is built to catch: it is silent in the browser —
 * the panel simply never appears.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const CLIENT = new URL('../client.js', import.meta.url);

/** Load client.js exactly the way the browser shell does, and return what it registered. */
function loadBundle() {
  const code = readFileSync(CLIENT, 'utf8');
  const loads = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { loads.push(entry); },
    },
  };
  // `document` is touched by the CSS injector; a minimal stub is enough and keeps the module honest.
  const head = { appendChild() {}, querySelector: () => null };
  globalThis.document = { head, createElement: () => ({ dataset: {}, style: {} }) };
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, channels: [], credentials: [] }) });
  try {
    // The bundle is an ES module by extension only in Node's eyes; run it as a script in this scope.
    // eslint-disable-next-line no-new-func
    new Function(code)();
    assert.equal(loads.length, 1, 'the bundle must call load() exactly once');
    const entry = loads[0];
    const require = (spec) => {
      if (spec === 'react/jsx-runtime') {
        // jsx/jsxs return a plain descriptor so the component tree can be built without a renderer.
        return {
          jsx: (type, props) => ({ type, props }),
          jsxs: (type, props) => ({ type, props }),
          Fragment: Symbol('Fragment'),
        };
      }
      if (spec === 'react') {
        return {
          useState: (initial) => [initial, () => {}],
          useEffect: () => {},
          Fragment: Symbol('Fragment'),
          createElement: (type, props) => ({ type, props }),
        };
      }
      throw new Error(`unexpected require: ${spec}`);
    };
    const exports = entry.factory(require);
    return { entry, exports };
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
  }
}

test('the bundle loads under the id the package declares', () => {
  const { entry } = loadBundle();
  assert.equal(entry.id, '@snow-the/dsh-busyloop');
});

test('the factory returns apply + inject, and inject names the services the panel uses', () => {
  const { exports } = loadBundle();
  assert.equal(typeof exports.apply, 'function', 'a factory that throws here is a silently dead panel');
  assert.deepEqual([...exports.inject].sort(), ['locale', 'slots']);
});

test('apply() registers dictionaries AND claims the settings.section slot', () => {
  const { exports } = loadBundle();
  const registered = [];
  const effects = [];
  const locale = {
    register: (ns, dicts) => { registered.push({ ns, dicts }); return () => {}; },
    bind: () => (key) => key,
    subscribe: () => () => {},
  };
  const slots = {
    inject(name, cb) { registered.push({ slotInject: name }); return cb(); },
    register(meta, component) { registered.push({ slot: meta, component }); return () => {}; },
  };
  const ctx = {
    locale,
    slots,
    effect(fn, label) { effects.push(label); return fn(); },
  };
  assert.doesNotThrow(() => exports.apply(ctx));

  const dicts = registered.find((r) => r.ns);
  assert.ok(dicts, 'registers a locale namespace so the panel can be labelled');
  assert.ok(dicts.dicts.zh && dicts.dicts.en, 'both dictionaries exist');

  assert.ok(registered.some((r) => r.slotInject === 'settings.section'), 'injects into settings.section');

  const claim = registered.find((r) => r.slot && r.slot.name === 'settings.section');
  assert.ok(claim, 'the slot is actually registered, not merely injected into');
  assert.equal(claim.slot.id, '@snow-the/dsh-busyloop', 'stable id, so the host can dedupe');
  assert.equal(typeof claim.slot.label, 'function', 'the nav label is a function (it is translated)');
  assert.equal(typeof claim.component, 'function', 'the host renders this component');
});

test('the panel component renders without a live host (no throw, sensible skeleton)', () => {
  const { exports } = loadBundle();
  let component = null;
  const ctx = {
    locale: { register: () => () => {}, bind: () => (k) => k, subscribe: () => () => {} },
    slots: {
      inject: (name, cb) => cb(),
      register: (meta, comp) => { component = comp; return () => {}; },
    },
    effect: (fn) => fn(),
  };
  exports.apply(ctx);
  assert.ok(component, 'captured the component');
  // First render: data is still null, so it must render the loading state rather than dereferencing it.
  assert.doesNotThrow(() => component({}), 'the first render must tolerate data === null');
});
