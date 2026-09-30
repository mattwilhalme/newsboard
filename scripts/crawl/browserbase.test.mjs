import test from 'node:test';
import assert from 'node:assert/strict';
import { apBrowserProvider, browserbaseConfig, withBrowserbaseAPPage, BrowserInfrastructureError } from '../../lib/browserbase.js';

const env = { BROWSERBASE_API_KEY: 'test-private-key' };

function fixture({ createStatus = 201, connectError = false, setupError = false, releaseStatus = 200, session = {} } = {}) {
  const calls = [], emulation = [];
  let closed = 0, detached = 0;
  const page = { setViewportSize: async size => calls.push({ viewport: size }) };
  const context = {
    pages: () => [page],
    newCDPSession: async () => ({
      send: async (method, body) => { if (setupError) throw Error('private setup data'); emulation.push({ method, body }); },
      detach: async () => { detached++; },
    }),
  };
  const browser = { contexts: () => [context], close: async () => { closed++; } };
  const options = {
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), headers: options.headers, redirect: options.redirect, signal: options.signal });
      const create = url.endsWith('/sessions');
      return Response.json(create ? { id: 'session-1', connectUrl: 'wss://connect.browserbase.com?secret=connection-key', ...session } : {}, { status: create ? createStatus : releaseStatus });
    },
    connect: async (url, options) => {
      calls.push({ connect: url, timeout: options.timeout });
      if (connectError) throw Error(`connection failed: ${url}`);
      return browser;
    },
  };
  return { options, calls, emulation, page, counts: () => ({ closed, detached }) };
}

test('AP uses the existing runtime by default and accepts an explicit diagnostic override', () => {
  assert.equal(apBrowserProvider({}), 'local');
  assert.equal(apBrowserProvider({ NEWSBOARD_AP_BROWSER_PROVIDER: 'browserbase' }), 'browserbase');
  assert.equal(apBrowserProvider({ NEWSBOARD_AP_BROWSER_PROVIDER: 'browserbase' }, 'local'), 'local');
  assert.throws(() => apBrowserProvider({ NEWSBOARD_AP_BROWSER_PROVIDER: 'other' }), BrowserInfrastructureError);
});

test('missing credentials and invalid proxy configuration fail before allocating a session', async () => {
  assert.throws(() => browserbaseConfig({}), /BROWSERBASE_API_KEY/);
  assert.throws(() => browserbaseConfig({ ...env, NEWSBOARD_AP_BROWSERBASE_PROXY: 'yes' }), /true or false/);
  let called = false;
  await assert.rejects(withBrowserbaseAPPage(() => {}, { env: {}, fetchImpl: async () => { called = true; } }), BrowserInfrastructureError);
  assert.equal(called, false);
});

test('a bounded AP session uses mobile emulation and explicitly releases the browser', async () => {
  const f = fixture();
  const result = await withBrowserbaseAPPage((page, meta) => {
    assert.equal(page, f.page);
    return { meta };
  }, f.options);
  const create = f.calls[0];
  assert.equal(create.headers['X-BB-API-Key'], env.BROWSERBASE_API_KEY);
  assert.equal(create.redirect, 'error');
  assert.ok(create.signal instanceof AbortSignal);
  assert.equal(create.body.timeout, 180);
  assert.equal(create.body.keepAlive, false);
  assert.equal(create.body.proxies, false);
  assert.equal(create.body.browserSettings.solveCaptchas, false);
  assert.equal(create.body.browserSettings.advancedStealth, false);
  assert.deepEqual(create.body.browserSettings.viewport, { width: 390, height: 844 });
  assert.equal(create.body.projectId, undefined);
  assert.equal(create.body.browserSettings.context, undefined);
  assert.deepEqual(f.emulation.map(c => c.method), ['Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setUserAgentOverride']);
  assert.equal(f.emulation[0].body.mobile, true);
  assert.equal(f.emulation[1].body.enabled, true);
  assert.equal(result.meta.browser_provider, 'browserbase');
  assert.equal(JSON.stringify(result).includes('connection-key'), false);
  assert.deepEqual(f.calls.at(-1).body, { status: 'REQUEST_RELEASE' });
  assert.deepEqual(f.counts(), { closed: 1, detached: 1 });
});

test('optional project, persistent profile and US proxy are explicit settings', async () => {
  const f = fixture();
  f.options.env = { ...env, BROWSERBASE_PROJECT_ID: 'project-1', BROWSERBASE_CONTEXT_ID: 'context-1', NEWSBOARD_AP_BROWSERBASE_PROXY: 'true' };
  await withBrowserbaseAPPage(() => {}, f.options);
  assert.equal(f.calls[0].body.projectId, 'project-1');
  assert.deepEqual(f.calls[0].body.browserSettings.context, { id: 'context-1', persist: true });
  assert.deepEqual(f.calls[0].body.proxies, [{ type: 'browserbase', geolocation: { country: 'US' } }]);
});

test('provider authentication and quota errors are infrastructure failures, with no retries', async () => {
  for (const createStatus of [401, 403, 429, 500]) {
    const f = fixture({ createStatus });
    await assert.rejects(withBrowserbaseAPPage(() => assert.fail('collector must not run'), f.options), error => error.code === 'NEWSBOARD_BROWSER_INFRASTRUCTURE' && error.message === `Browserbase API HTTP ${createStatus}`);
    assert.equal(f.calls.length, 1);
  }
});

test('connection and mobile setup failures release allocated sessions and redact connection secrets', async () => {
  for (const options of [{ connectError: true }, { setupError: true }, { session: { connectUrl: null } }]) {
    const f = fixture(options);
    await assert.rejects(withBrowserbaseAPPage(() => assert.fail('collector must not run'), f.options), error => error.code === 'NEWSBOARD_BROWSER_INFRASTRUCTURE' && !/connection-key|private setup/.test(error.message));
    assert.deepEqual(f.calls.at(-1).body, { status: 'REQUEST_RELEASE' });
  }
});

test('collector failures remain collector failures but always release the session', async () => {
  const f = fixture();
  const original = Error('AP extraction failed');
  await assert.rejects(withBrowserbaseAPPage(() => { throw original; }, f.options), error => error === original);
  assert.deepEqual(f.calls.at(-1).body, { status: 'REQUEST_RELEASE' });
  assert.equal(f.counts().closed, 1);
});

test('network and invalid JSON responses are sanitized infrastructure failures', async () => {
  for (const fetchImpl of [async () => { throw Error('test-private-key'); }, async () => new Response('invalid', { status: 201 })]) {
    await assert.rejects(withBrowserbaseAPPage(() => {}, { env, fetchImpl }), error => error.code === 'NEWSBOARD_BROWSER_INFRASTRUCTURE' && !error.message.includes('test-private-key'));
  }
});

test('a release error does not discard collected data and the browser still closes', async t => {
  const f = fixture({ releaseStatus: 500 });
  const warnings = [];
  t.mock.method(console, 'warn', text => warnings.push(text));
  assert.equal(await withBrowserbaseAPPage(() => 'valid result', f.options), 'valid result');
  assert.equal(f.counts().closed, 1);
  assert.deepEqual(warnings, ['Browserbase session release failed: Browserbase API HTTP 500']);
});
