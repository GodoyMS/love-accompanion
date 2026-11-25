import { spawn } from 'node:child_process';
import type { VoiceTuning } from '../settings.js';

/**
 * Voice-note replies: ElevenLabs text-to-speech in your voice, converted with ffmpeg to the
 * exact format WhatsApp records voice notes in (Ogg/Opus, mono, 48 kHz), plus the little
 * waveform WhatsApp draws on the bubble.
 */

export const voiceId = () => process.env.ELEVENLABS_VOICE_ID ?? '';
export const voiceReady = () => !!(process.env.ELEVENLABS_API_KEY && voiceId());

/** Make chat text sound right when spoken: no emojis, no chat shorthand. */
export function speakable(text: string) {
  return text
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\b(q|k)\b/gi, 'que')
    .replace(/\bxq\b|\bpq\b/gi, 'porque')
    .replace(/\btb\b/gi, 'también')
    .replace(/\s*\/\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(x) || 0));

export async function tts(text: string, tuning?: VoiceTuning): Promise<Buffer> {
  const v = tuning ?? (await (await import('../settings.js')).getSettings()).voice;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId()}?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: process.env.TTS_MODEL ?? v.model,
      // Flash v2.5 can pin the language (keeps it Spanish, normalizes numbers the Spanish way).
      ...(v.model === 'eleven_flash_v2_5' ? { language_code: 'es' } : {}),
      voice_settings: {
        stability: clamp(v.stability, 0, 1),
        similarity_boost: clamp(v.similarity, 0, 1),
        style: clamp(v.style, 0, 1),
        speed: clamp(v.speed, 0.7, 1.2),
        use_speaker_boost: true,
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function ffmpeg(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.slice(0, 200)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

/** 64 bars, 0–100, like WhatsApp's own voice notes. */
export function waveformFromPcm(pcm: Buffer, bars = 64): Uint8Array {
  const samples = Math.floor(pcm.length / 2);
  const block = Math.max(1, Math.floor(samples / bars));
  const avg: number[] = [];
  for (let b = 0; b < bars; b++) {
    let sum = 0;
    for (let i = 0; i < block; i++) {
      const idx = (b * block + i) * 2;
      if (idx + 1 < pcm.length) sum += Math.abs(pcm.readInt16LE(idx));
    }
    avg.push(sum / block);
  }
  const max = Math.max(...avg, 1);
  return Uint8Array.from(avg.map((v) => Math.round((v / max) * 100)));
}

export async function toVoiceNote(audio: Buffer): Promise<{ ogg: Buffer; seconds: number; waveform: Uint8Array }> {
  const [ogg, pcm] = await Promise.all([
    ffmpeg(['-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], audio),
    ffmpeg(['-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], audio),
  ]);
  const seconds = Math.max(1, Math.round(pcm.length / 2 / 8000));
  return { ogg, seconds, waveform: waveformFromPcm(pcm) };
}

/** Text → WhatsApp-ready voice note. */
export async function makeVoiceNote(text: string) {
  return toVoiceNote(await tts(speakable(text)));
}
