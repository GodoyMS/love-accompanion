import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { speakable, toVoiceNote, waveformFromPcm } from '../src/engine/voice.ts';

test('speakable strips emojis and chat shorthand', () => {
  assert.equal(speakable('ay amor 🥹❤️ q pasó? xq no me dijiste, tb te extraño'), 'ay amor que pasó? porque no me dijiste, también te extraño');
});

test('waveform has 64 bars scaled to 100', () => {
  const pcm = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 5) * 3000 * (i / 8000)), i * 2);
  const w = waveformFromPcm(pcm);
  assert.equal(w.length, 64);
  assert.equal(Math.max(...w), 100);
  assert.ok(w[0] < w[63]);
});

test('mp3 becomes a WhatsApp voice note: ogg/opus mono 48k with duration', async () => {
  const mp3 = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-f', 'mp3', 'pipe:1']);
  const note = await toVoiceNote(mp3);
  assert.equal(note.ogg.subarray(0, 4).toString(), 'OggS');
  assert.equal(note.seconds, 3);
  assert.equal(note.waveform.length, 64);
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'csv=p=0', 'pipe:0'], { input: note.ogg }).toString().trim();
  assert.equal(probe, 'opus,48000,1');
});

test('tts sends the calm/neutral tuning to ElevenLabs', async () => {
  const { tts } = await import('../src/engine/voice.ts');
  process.env.ELEVENLABS_API_KEY = 'el';
  process.env.ELEVENLABS_VOICE_ID = 'VOICE';
  let seen: any;
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    seen = { url, body: JSON.parse(init.body), headers: init.headers };
    return new Response(new Uint8Array([1, 2, 3]));
  }) as any;
  try {
    await tts('hola', { model: 'eleven_flash_v2_5', speed: 0.5, stability: 0.65, similarity: 0.9, style: 0 });
  } finally {
    globalThis.fetch = real;
  }
  assert.match(seen.url, /\/v1\/text-to-speech\/VOICE\?output_format=mp3_44100_128$/);
  assert.equal(seen.headers['xi-api-key'], 'el');
  assert.equal(seen.body.model_id, 'eleven_flash_v2_5');
  assert.equal(seen.body.language_code, 'es');
  assert.deepEqual(seen.body.voice_settings, { stability: 0.65, similarity_boost: 0.9, style: 0, speed: 0.7, use_speaker_boost: true });
});
