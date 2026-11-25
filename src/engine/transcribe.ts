/**
 * Voice-to-text for her voice notes and video notes.
 * Uses ElevenLabs if ELEVENLABS_API_KEY is set, otherwise OpenAI if OPENAI_API_KEY is set.
 */

export const sttProvider = (): 'elevenlabs' | 'openai' | null =>
  process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : process.env.OPENAI_API_KEY ? 'openai' : null;

export async function transcribe(audio: Buffer, mimetype: string): Promise<string | null> {
  const provider = sttProvider();
  if (!provider) return null;

  const type = mimetype.split(';')[0] || 'audio/ogg';
  const ext = type.includes('mp4') ? 'mp4' : type.includes('mpeg') ? 'mp3' : type.includes('webm') ? 'webm' : 'ogg';
  const file = new Blob([new Uint8Array(audio)], { type });
  const form = new FormData();
  let url: string;
  let headers: Record<string, string>;

  if (provider === 'elevenlabs') {
    url = 'https://api.elevenlabs.io/v1/speech-to-text';
    headers = { 'xi-api-key': process.env.ELEVENLABS_API_KEY! };
    form.append('model_id', process.env.STT_MODEL ?? 'scribe_v2');
    form.append('language_code', 'es');
    form.append('tag_audio_events', 'false');
  } else {
    url = 'https://api.openai.com/v1/audio/transcriptions';
    headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    form.append('model', process.env.STT_MODEL ?? 'gpt-transcribe');
    form.append('languages[]', 'es');
  }
  form.append('file', file, `voice.${ext}`);

  const res = await fetch(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}
