// dsh-busyloop client — the channel settings panel.
//
// WHY A PANEL. busyloop used to be configured by four tools and its own key file, which meant the
// answer to "which key is this channel using?" lived in three places (env, a private JSON file, and
// a per-session selection) and none of them was visible. The panel makes ONE screen the answer:
// every channel, where its config came from, and WHICH credential would answer a call right now.
//
// The key half is deliberately a thin shell over the HOST credential store — the panel can add or
// remove a credential, and name one per channel, but busyloop keeps no key of its own. Values are
// never read back into this UI: the server returns a mask, and the panel only ever posts a new one.
//
// Structure mirrors @snow-the/dsh-session-handoff's settings panel (same slot, same apiGet/apiPost
// shape over a host route prefix, same locale-namespace wiring), so the two behave alike.
window.__ModuleLoader__.load({
  id: '@snow-the/dsh-busyloop',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const jsx = require('react/jsx-runtime');
    const React = require('react');
    const useState = React.useState;
    const useEffect = React.useEffect;

    const NS = 'dsh-busyloop';
    const ROUTE_PREFIX = '/api/busyloop';

    async function apiGet(path) {
      const response = await fetch(ROUTE_PREFIX + path);
      return response.json();
    }
    async function apiPost(path, body) {
      const response = await fetch(ROUTE_PREFIX + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return response.json();
    }

    const DICTIONARIES = {
      zh: {
        nav: 'busyloop',
        title: 'busyloop 通道',
        intro: 'busyloop_run 在选定通道上跑一次性循环，不占用主模型 token。密钥来自宿主凭据（ctx.credentials），busyloop 不再自带密钥文件。',
        channels: '通道',
        credentials: '宿主凭据',
        loading: '加载中…',
        reload: '刷新',
        file: '配置文件',
        credService: '凭据服务',
        available: '可用',
        unavailable: '不可用',
        colChannel: '通道',
        colModel: '模型',
        colKey: '密钥来源',
        colFrom: '配置来源',
        fromBuiltin: '内置',
        fromOverride: '面板覆盖',
        fromFile: '配置文件',
        callable: '可调用',
        notCallable: '缺密钥',
        edit: '编辑',
        close: '收起',
        save: '保存',
        resetToBuiltin: '删除覆盖（恢复内置）',
        cancel: '取消',
        test: '测试连通',
        testing: '测试中…',
        testOk: '连通',
        testFail: '失败',
        baseURL: 'baseURL',
        model: 'model',
        keyEnv: 'keyEnv（环境变量 / 凭据名）',
        keyAlias: 'keyAlias（宿主凭据名，留空则用 keyEnv）',
        maxTokens: 'maxTokens',
        contextWindow: 'contextWindow',
        delayMs: 'delayMs',
        concurrency: 'concurrency',
        addCred: '新增凭据',
        credName: '凭据名（如 ARK_API_KEY）',
        credValue: '凭据值',
        add: '写入宿主凭据',
        removeCred: '删除',
        confirmRemove: '确认删除',
        saved: '已保存',
        removed: '已删除',
        noCreds: '宿主凭据服务不可用，或还没有凭据。',
        maskNote: '只显示掩码尾部；明文永不返回此界面。',
        none: '（无）',
        missing: '未配置',
        restartHint: '改完通道后新调用立即生效；密钥轮换下一次调用即生效，无需重启。',
      },
      en: {
        nav: 'busyloop',
        title: 'busyloop channels',
        intro: 'busyloop_run runs one-off loops on a chosen channel without spending main-model tokens. Credentials come from the host store (ctx.credentials); busyloop keeps no key file of its own.',
        channels: 'Channels',
        credentials: 'Host credentials',
        loading: 'Loading…',
        reload: 'Reload',
        file: 'Config file',
        credService: 'Credential service',
        available: 'available',
        unavailable: 'unavailable',
        colChannel: 'Channel',
        colModel: 'Model',
        colKey: 'Key source',
        colFrom: 'Config from',
        fromBuiltin: 'built-in',
        fromOverride: 'panel override',
        fromFile: 'config file',
        callable: 'callable',
        notCallable: 'no key',
        edit: 'Edit',
        close: 'Close',
        save: 'Save',
        resetToBuiltin: 'Remove override (restore built-in)',
        cancel: 'Cancel',
        test: 'Test connection',
        testing: 'Testing…',
        testOk: 'reachable',
        testFail: 'failed',
        baseURL: 'baseURL',
        model: 'model',
        keyEnv: 'keyEnv (env var / credential name)',
        keyAlias: 'keyAlias (host credential name; empty = use keyEnv)',
        maxTokens: 'maxTokens',
        contextWindow: 'contextWindow',
        delayMs: 'delayMs',
        concurrency: 'concurrency',
        addCred: 'Add credential',
        credName: 'Credential name (e.g. ARK_API_KEY)',
        credValue: 'Credential value',
        add: 'Store in host credentials',
        removeCred: 'Remove',
        confirmRemove: 'Confirm removal',
        saved: 'Saved',
        removed: 'Removed',
        noCreds: 'The host credential service is unavailable, or no credentials exist yet.',
        maskNote: 'Only a masked tail is shown; the value is never returned to this UI.',
        none: '(none)',
        missing: 'not configured',
        restartHint: 'Channel edits apply to the next call; a rotated credential applies on the next call with no restart.',
      },
    };

    const CSS = [
      '.dsh-bl{display:flex;flex-direction:column;gap:14px;font-size:12px;color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-bl__h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dsh-bl__h strong{font-size:13px}',
      '.dsh-bl__muted{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;line-height:16px}',
      '.dsh-bl__card{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px}',
      '.dsh-bl__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsh-bl__grow{flex:1;min-width:0}',
      '.dsh-bl__btn{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;line-height:1.6}',
      '.dsh-bl__btn:hover{background:var(--dsw-alias-fill-l1,rgba(128,128,128,.12))}',
      '.dsh-bl__btn[disabled]{opacity:.5;cursor:default}',
      '.dsh-bl__btn--danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e55) 45%,transparent);color:var(--dsw-alias-state-error-primary,#e55)}',
      '.dsh-bl__grid{display:grid;grid-template-columns:minmax(90px,140px) minmax(0,1fr);gap:6px 10px;align-items:center}',
      '.dsh-bl__grid label{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px}',
      '.dsh-bl__input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-module-platform,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:6px;color:inherit;font:inherit;padding:4px 7px}',
      '.dsh-bl__tag{display:inline-flex;align-items:center;gap:4px;border-radius:5px;padding:1px 6px;font-size:10px;line-height:16px;background:var(--dsw-alias-fill-l2,rgba(128,128,128,.16))}',
      '.dsh-bl__tag--ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3a3) 18%,transparent);color:var(--dsw-alias-state-success-primary,#3a3)}',
      '.dsh-bl__tag--bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e55) 16%,transparent);color:var(--dsw-alias-state-error-primary,#e55)}',
      '.dsh-bl__mono{font-family:var(--dsw-font-mono,monospace)}',
      '.dsh-bl__list{display:flex;flex-direction:column;gap:6px}',
      '.dsh-bl__item{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:6px 8px}',
      '.dsh-bl__err{color:var(--dsw-alias-state-error-primary,#e55);font-size:11px;word-break:break-word}',
    ].join('');

    let cssInjected = false;
    function ensureCss() {
      if (cssInjected || typeof document === 'undefined') return;
      const tagId = '@snow-the/dsh-busyloop/panel.css';
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@snow-the/dsh-busyloop';
        tag.dataset.pluginCss = tagId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      }
      cssInjected = true;
    }

    /** Render a masked credential or a "not configured" note. Values never travel to this UI. */
    function keyCell(row, t) {
      if (row.via) {
        return jsx.jsxs('span', { className: 'dsh-bl__row', children: [
          jsx.jsx('span', { className: 'dsh-bl__tag dsh-bl__tag--ok', children: t('callable') }),
          jsx.jsx('span', { className: 'dsh-bl__mono', children: row.via }),
          row.masked ? jsx.jsx('span', { className: 'dsh-bl__muted', children: row.masked }) : null,
        ] });
      }
      return jsx.jsxs('span', { className: 'dsh-bl__row', children: [
        jsx.jsx('span', { className: 'dsh-bl__tag dsh-bl__tag--bad', children: t('notCallable') }),
        jsx.jsx('span', { className: 'dsh-bl__muted', children: t('missing') }),
      ] });
    }

    function BusyloopSettingsSection() {
      ensureCss();
      const t = BusyloopSettingsSection.t;
      const [data, setData] = useState(null);
      const [creds, setCreds] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [editing, setEditing] = useState(null);
      const [draft, setDraft] = useState({});
      const [testing, setTesting] = useState(null);
      const [testResult, setTestResult] = useState({});
      const [newCred, setNewCred] = useState({ ref: '', value: '' });
      const [busy, setBusy] = useState(false);

      async function load() {
        setError(null);
        try {
          const [channels, credentials] = await Promise.all([
            apiGet('/channels'),
            apiGet('/credentials'),
          ]);
          if (channels && channels.ok === false) setError(channels.error || 'load failed');
          setData(channels);
          setCreds(credentials);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
        }
      }

      useEffect(function () { load(); }, []);

      function beginEdit(row) {
        setEditing(row.key);
        setDraft({
          baseURL: row.config.baseURL || '',
          model: row.config.model || '',
          keyEnv: row.config.keyEnv || '',
          keyAlias: row.keyAlias || '',
          maxTokens: row.config.maxTokens == null ? '' : String(row.config.maxTokens),
          contextWindow: row.config.contextWindow == null ? '' : String(row.config.contextWindow),
          delayMs: row.config.delayMs == null ? '' : String(row.config.delayMs),
          concurrency: row.config.concurrency == null ? '' : String(row.config.concurrency),
        });
        setNotice(null);
        setTestResult({});
      }

      async function save(key) {
        setBusy(true);
        setError(null);
        try {
          const body = { key: key };
          for (const field of ['baseURL', 'model', 'keyEnv', 'keyAlias']) {
            body[field] = String(draft[field] || '').trim();
          }
          // Numeric fields: empty string means "clear it", so send null rather than NaN.
          for (const field of ['maxTokens', 'contextWindow', 'delayMs', 'concurrency']) {
            const raw = String(draft[field] || '').trim();
            body[field] = raw === '' ? null : Number(raw);
          }
          const result = await apiPost('/channel', body);
          if (!result || result.ok !== true) { setError((result && result.error) || 'save failed'); return; }
          setNotice(t('saved'));
          setEditing(null);
          await load();
        } finally {
          setBusy(false);
        }
      }

      async function removeOverride(key) {
        setBusy(true);
        try {
          const result = await apiPost('/channel', { key: key, remove: true });
          if (!result || result.ok !== true) { setError((result && result.error) || 'remove failed'); return; }
          setNotice(t('removed'));
          setEditing(null);
          await load();
        } finally {
          setBusy(false);
        }
      }

      async function runTest(key) {
        setTesting(key);
        setTestResult({});
        try {
          const result = await apiPost('/test', { key: key });
          setTestResult({ key: key, result: result });
        } catch (err) {
          setTestResult({ key: key, result: { ok: false, error: String(err && err.message ? err.message : err) } });
        } finally {
          setTesting(null);
        }
      }

      async function addCredential() {
        if (!newCred.ref.trim() || !newCred.value.trim()) return;
        setBusy(true);
        setError(null);
        try {
          const result = await apiPost('/credential', { ref: newCred.ref.trim(), value: newCred.value });
          if (!result || result.ok !== true) { setError((result && result.error) || 'store failed'); return; }
          // Clear the input immediately: the value must not linger in component state.
          setNewCred({ ref: '', value: '' });
          setNotice(t('saved'));
          await load();
        } finally {
          setBusy(false);
        }
      }

      async function removeCredential(ref) {
        setBusy(true);
        try {
          const result = await apiPost('/credential', { ref: ref, remove: true });
          if (!result || result.ok !== true) { setError((result && result.error) || 'remove failed'); return; }
          await load();
        } finally {
          setBusy(false);
        }
      }

      const rows = (data && Array.isArray(data.channels)) ? data.channels : null;

      function numberField(label, field) {
        return jsx.jsxs(React.Fragment, { children: [
          jsx.jsx('label', { children: label }),
          jsx.jsx('input', {
            className: 'dsh-bl__input',
            value: draft[field],
            onChange: function (e) { setDraft(Object.assign({}, draft, { [field]: e.target.value })); },
          }),
        ] });
      }

      return jsx.jsxs('div', { className: 'dsh-bl', children: [
        jsx.jsxs('div', { className: 'dsh-bl__h', children: [
          jsx.jsx('strong', { children: t('title') }),
          jsx.jsx('button', { className: 'dsh-bl__btn', disabled: busy, onClick: load, children: t('reload') }),
          data && data.file ? jsx.jsx('span', { className: 'dsh-bl__muted', children: t('file') + ': ' + data.file }) : null,
          data ? jsx.jsx('span', { className: 'dsh-bl__muted', children: t('credService') + ': ' + (data.credentialsAvailable ? t('available') : t('unavailable')) }) : null,
        ] }),
        jsx.jsx('div', { className: 'dsh-bl__muted', children: t('intro') }),
        error ? jsx.jsx('div', { className: 'dsh-bl__err', children: error }) : null,
        notice ? jsx.jsx('div', { className: 'dsh-bl__muted', children: notice }) : null,
        data && data.fileError ? jsx.jsx('div', { className: 'dsh-bl__err', children: data.fileError }) : null,

        jsx.jsx('div', { className: 'dsh-bl__card', children: [
          jsx.jsx('strong', { children: t('channels') }),
          rows === null
            ? jsx.jsx('div', { className: 'dsh-bl__muted', children: t('loading') })
            : jsx.jsxs('div', { className: 'dsh-bl__list', children: rows.map(function (row) {
                if (!row.present) return null;
                const isEditing = editing === row.key;
                const tr = testResult && testResult.key === row.key ? testResult.result : null;
                return jsx.jsxs('div', { className: 'dsh-bl__item', style: { flexDirection: 'column', alignItems: 'stretch' }, children: [
                  jsx.jsxs('div', { className: 'dsh-bl__row', children: [
                    jsx.jsx('span', { className: 'dsh-bl__mono dsh-bl__grow', children: row.key }),
                    jsx.jsx('span', { className: 'dsh-bl__tag', children: t('colFrom') + ': ' + (row.from === 'builtin' ? t('fromBuiltin') : row.from === 'override' ? t('fromOverride') : t('fromFile')) }),
                    keyCell(row, t),
                    jsx.jsx('button', {
                      className: 'dsh-bl__btn',
                      disabled: testing === row.key,
                      onClick: function () { runTest(row.key); },
                      children: testing === row.key ? t('testing') : t('test'),
                    }),
                    jsx.jsx('button', {
                      className: 'dsh-bl__btn',
                      onClick: function () { isEditing ? setEditing(null) : beginEdit(row); },
                      children: isEditing ? t('close') : t('edit'),
                    }),
                  ] }),
                  jsx.jsxs('div', { className: 'dsh-bl__muted dsh-bl__mono', children: [
                    t('colModel') + ': ' + row.config.model + '  ·  ' + row.config.baseURL + '  ·  keyEnv: ' + row.keyEnv + (row.keyAlias ? '  ·  keyAlias: ' + row.keyAlias : ''),
                  ] }),
                  tr ? jsx.jsx('div', { className: tr.ok ? 'dsh-bl__muted' : 'dsh-bl__err', children:
                    (tr.ok ? t('testOk') : t('testFail')) +
                    (tr.ms != null ? ' (' + tr.ms + 'ms)' : '') +
                    (tr.via ? ' via ' + tr.via : '') +
                    (tr.error ? ' — ' + tr.error : '') +
                    (tr.preview ? ' — ' + JSON.stringify(tr.preview) : '')
                  }) : null,
                  isEditing ? jsx.jsxs('div', { className: 'dsh-bl__grid', children: [
                    jsx.jsx('label', { children: t('baseURL') }),
                    jsx.jsx('input', { className: 'dsh-bl__input', value: draft.baseURL, onChange: function (e) { setDraft(Object.assign({}, draft, { baseURL: e.target.value })); } }),
                    jsx.jsx('label', { children: t('model') }),
                    jsx.jsx('input', { className: 'dsh-bl__input', value: draft.model, onChange: function (e) { setDraft(Object.assign({}, draft, { model: e.target.value })); } }),
                    jsx.jsx('label', { children: t('keyEnv') }),
                    jsx.jsx('input', { className: 'dsh-bl__input', value: draft.keyEnv, onChange: function (e) { setDraft(Object.assign({}, draft, { keyEnv: e.target.value })); } }),
                    jsx.jsx('label', { children: t('keyAlias') }),
                    jsx.jsx('input', { className: 'dsh-bl__input', value: draft.keyAlias, onChange: function (e) { setDraft(Object.assign({}, draft, { keyAlias: e.target.value })); } }),
                    numberField(t('maxTokens'), 'maxTokens'),
                    numberField(t('contextWindow'), 'contextWindow'),
                    numberField(t('delayMs'), 'delayMs'),
                    numberField(t('concurrency'), 'concurrency'),
                  ] }) : null,
                  isEditing ? jsx.jsxs('div', { className: 'dsh-bl__row', children: [
                    jsx.jsx('button', { className: 'dsh-bl__btn', disabled: busy, onClick: function () { save(row.key); }, children: t('save') }),
                    jsx.jsx('button', { className: 'dsh-bl__btn', onClick: function () { setEditing(null); }, children: t('cancel') }),
                    jsx.jsx('button', { className: 'dsh-bl__btn dsh-bl__btn--danger', disabled: busy, onClick: function () { removeOverride(row.key); }, children: t('resetToBuiltin') }),
                  ] }) : null,
                ] });
              }) }),
        ] }),

        jsx.jsx('div', { className: 'dsh-bl__card', children: [
          jsx.jsxs('div', { className: 'dsh-bl__h', children: [
            jsx.jsx('strong', { children: t('credentials') }),
            jsx.jsx('span', { className: 'dsh-bl__muted', children: t('maskNote') }),
          ] }),
          creds === null
            ? jsx.jsx('div', { className: 'dsh-bl__muted', children: t('loading') })
            : (Array.isArray(creds.credentials) && creds.credentials.length
                ? jsx.jsxs('div', { className: 'dsh-bl__list', children: creds.credentials.map(function (c) {
                    return jsx.jsxs('div', { className: 'dsh-bl__item', children: [
                      jsx.jsx('span', { className: 'dsh-bl__mono dsh-bl__grow', children: c.ref }),
                      jsx.jsx('span', { className: c.present ? 'dsh-bl__tag dsh-bl__tag--ok' : 'dsh-bl__tag dsh-bl__tag--bad', children: c.present ? t('available') : t('missing') }),
                      c.masked ? jsx.jsx('span', { className: 'dsh-bl__muted', children: c.masked }) : null,
                      c.source ? jsx.jsx('span', { className: 'dsh-bl__muted', children: c.source }) : null,
                      c.present ? jsx.jsx('button', { className: 'dsh-bl__btn dsh-bl__btn--danger', disabled: busy, onClick: function () { removeCredential(c.ref); }, children: t('removeCred') }) : null,
                    ] }, c.ref);
                  }) })
                : jsx.jsx('div', { className: 'dsh-bl__muted', children: t('noCreds') })),
          jsx.jsxs('div', { className: 'dsh-bl__grid', children: [
            jsx.jsx('label', { children: t('credName') }),
            jsx.jsx('input', {
              className: 'dsh-bl__input',
              value: newCred.ref,
              placeholder: 'ARK_API_KEY',
              onChange: function (e) { setNewCred(Object.assign({}, newCred, { ref: e.target.value })); },
            }),
            jsx.jsx('label', { children: t('credValue') }),
            jsx.jsx('input', {
              className: 'dsh-bl__input',
              type: 'password',
              value: newCred.value,
              autoComplete: 'off',
              onChange: function (e) { setNewCred(Object.assign({}, newCred, { value: e.target.value })); },
            }),
          ] }),
          jsx.jsx('div', { className: 'dsh-bl__row', children:
            jsx.jsx('button', {
              className: 'dsh-bl__btn',
              disabled: busy || !newCred.ref.trim() || !newCred.value.trim(),
              onClick: addCredential,
              children: t('addCred'),
            }) }),
        ] }),

        jsx.jsx('div', { className: 'dsh-bl__muted', children: t('restartHint') }),
      ] });
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, DICTIONARIES);
      }, 'dsh-busyloop: dictionaries');

      const t = ctx.locale.bind(NS);
      BusyloopSettingsSection.t = t;

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: '@snow-the/dsh-busyloop',
          order: 61,
          label: function () { return t('nav'); },
          locale: NS,
          inject: function () { return {}; },
        }, BusyloopSettingsSection);
      });
    }

    exports.NS = NS;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
