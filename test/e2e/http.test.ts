import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { db, replies, reset, settings } from './harness.ts';

const { buildServer } = await import('../../src/app/server.ts');
const app = await buildServer();
let cookie = '';

before(async () => {
  await reset();
});
after(async () => {
  await app.close();
  await db.pool.end();
});

const call = (method: string, url: string, body?: unknown, ip = '1.1.1.1') =>
  app.inject({ method: method as any, url, payload: body as any, headers: cookie ? { cookie } : {}, remoteAddress: ip });

test('everything under /api needs a session', async () => {
  for (const [m, u] of [['GET', '/api/status'], ['POST', '/api/switch'], ['PUT', '/api/settings'], ['GET', '/api/messages']]) {
    assert.equal((await call(m, u, {})).statusCode, 401, `${m} ${u}`);
  }
  assert.equal((await call('GET', '/healthz')).statusCode, 200);
});

test('wrong passwords are throttled per IP; your IP still gets in', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/login', { password: 'no' }, '6.6.6.6')).statusCode, 401);
  assert.equal((await call('POST', '/api/login', { password: 'no' }, '6.6.6.6')).statusCode, 429);
  const ok = await call('POST', '/api/login', { password: process.env.ADMIN_PASSWORD }, '2.2.2.2');
  assert.equal(ok.statusCode, 200);
  cookie = String(ok.headers['set-cookie']).split(';')[0];
});

test('a forged session cookie is rejected', async () => {
  const saved = cookie;
  cookie = `la_session=${Date.now() + 1e9}.deadbeef`;
  assert.equal((await call('GET', '/api/status')).statusCode, 401);
  cookie = saved;
});

test('status reports the bot state', async () => {
  const r = await call('GET', '/api/status');
  assert.equal(r.statusCode, 200);
  const s = r.json();
  assert.equal(s.settings.enabled, true);
  assert.equal(s.paused, false);
  assert.ok(Array.isArray(s.pending));
});

test('switch, pause and resume go through the audited transitions', async () => {
  await call('POST', '/api/switch', { enabled: false });
  assert.equal((await settings.reloadSettings()).enabled, false);
  await call('POST', '/api/switch', { enabled: true });
  await call('POST', '/api/pause', { minutes: 30 });
  assert.ok(settings.isPaused(await settings.reloadSettings()));
  await call('POST', '/api/resume');
  assert.ok(!settings.isPaused(await settings.reloadSettings()));
  const ev = (await db.q(`select type, detail from events where type in ('enabled','disabled','paused','resumed') order by id`)).rows;
  assert.deepEqual(ev.map((e: any) => `${e.type}:${e.detail}`), ['disabled:panel', 'enabled:panel', 'paused:30 min — panel', 'resumed:panel']);
});

test('settings: validated, and can\'t flip the switch or pause through this endpoint', async () => {
  const r = await call('PUT', '/api/settings', { enabled: false, pausedUntil: '2099-01-01T00:00:00Z', debounceSec: [50, 2], quietHours: [4, 0], voice: { speed: 5 } });
  assert.equal(r.statusCode, 200);
  const s = await settings.reloadSettings();
  assert.equal(s.enabled, true);
  assert.equal(s.pausedUntil, null);
  assert.deepEqual(s.debounceSec, [2, 50]);
  assert.deepEqual(s.quietHours, [4, 0]); // 4am→midnight wraps; valid
  assert.equal(s.voice.speed, 1.2);
});

test('queue: cancel one, send now, cancel all; bad ids rejected', async () => {
  const a = await replies.enqueue({ kind: 'reply', sendAt: new Date(Date.now() + 3600_000), parts: ['a'] });
  const b = await replies.enqueue({ kind: 'reply', sendAt: new Date(Date.now() + 3600_000), parts: ['b'] });
  await replies.enqueue({ kind: 'reply', sendAt: new Date(Date.now() + 3600_000), parts: ['c'] });
  assert.equal((await call('DELETE', `/api/pending/${a}`)).statusCode, 200);
  assert.equal((await call('POST', `/api/pending/${b}/now`)).statusCode, 200);
  assert.equal((await call('DELETE', '/api/pending/abc')).statusCode, 400);
  const rows = (await db.q(`select status, send_at <= now() as due from pending_replies order by id`)).rows;
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[1].due, true);
  assert.equal((await call('DELETE', '/api/pending')).json().cancelled, 2);
});

test('memories and profile', async () => {
  assert.equal((await call('POST', '/api/memories', { fact: '  ' })).statusCode, 400);
  assert.equal((await call('POST', '/api/memories', { fact: 'Le gusta el ceviche' })).statusCode, 200);
  assert.equal((await call('GET', '/api/memories')).json()[0].fact, 'Le gusta el ceviche');
  await call('PUT', '/api/profile', { profile: '# Yo\n- Liam' });
  assert.equal((await call('GET', '/api/profile')).json().profile, '# Yo\n- Liam');
});
