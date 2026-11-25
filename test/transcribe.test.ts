import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { sttProvider, transcribe } from '../src/adapters/stt.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function capture(text: string) {
  const seen: { url?: string; headers?: any; form?: FormData } = {};
  globalThis.fetch = (async (url: string, init: any) => {
    Object.assign(seen, { url, headers: init.headers, form: init.body });
    return new Response(JSON.stringify({ text }), { status: 200 });
  }) as any;
  return seen;
}

test('no key, no transcription', async () => {
  assert.equal(sttProvider(), null);
  assert.equal(await transcribe(Buffer.from('x'), 'audio/ogg; codecs=opus'), null);
});

test('elevenlabs request', async () => {
  process.env.ELEVENLABS_API_KEY = 'el';
  const seen = capture(' hola amor ');
  assert.equal(await transcribe(Buffer.from('x'), 'audio/ogg; codecs=opus'), 'hola amor');
  assert.equal(seen.url, 'https://api.elevenlabs.io/v1/speech-to-text');
  assert.equal(seen.headers['xi-api-key'], 'el');
  assert.equal(seen.form!.get('model_id'), 'scribe_v2');
  assert.equal(seen.form!.get('language_code'), 'es');
  assert.equal((seen.form!.get('file') as File).name, 'voice.ogg');
});

test('openai request', async () => {
  process.env.OPENAI_API_KEY = 'oa';
  const seen = capture('qué tal');
  assert.equal(await transcribe(Buffer.from('x'), 'video/mp4'), 'qué tal');
  assert.equal(seen.url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(seen.headers.Authorization, 'Bearer oa');
  assert.equal(seen.form!.get('model'), 'gpt-transcribe');
  assert.equal((seen.form!.get('file') as File).name, 'voice.mp4');
});

test('elevenlabs wins when both keys are set; errors surface', async () => {
  process.env.ELEVENLABS_API_KEY = 'el';
  process.env.OPENAI_API_KEY = 'oa';
  assert.equal(sttProvider(), 'elevenlabs');
  globalThis.fetch = (async () => new Response('bad key', { status: 401 })) as any;
  await assert.rejects(transcribe(Buffer.from('x'), 'audio/ogg'), /elevenlabs 401/);
});
