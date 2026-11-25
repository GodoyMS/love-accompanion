import { kvGet, kvSet, q, logEvent } from './db.js';

export interface Settings {
  /** Master kill switch. false = the bot never sends anything. */
  enabled: boolean;
  /** ISO date; while in the future the bot is paused (only via panel or /pause). */
  pausedUntil: string | null;
  /** Seconds of silence from her before we consider her "done typing". */
  debounceSec: [number, number];
  /** Extra random delay before starting to type, in seconds. */
  replyDelaySec: [number, number];
  /** Local hours when "you" are asleep, e.g. [0, 7] = midnight to 7am. */
  quietHours: [number, number] | null;
  /**
   * When you write to her yourself, the bot stays ON but gives you this many minutes:
   * it only answers her if you've been silent that long and she's still waiting.
   */
  handBackMinutes: number;
  /** Answer her voice notes with a voice note in your voice (needs ELEVENLABS_VOICE_ID). */
  voiceReplies: boolean;
  /** Which sensitive topics the bot answers on its own (it always alerts you too). */
  autonomy: {
    /** Sadness, tiredness, "me siento mal", stress, a bad day. */
    feelings: boolean;
    /** Physical symptoms (stomach ache, fever, "creo que tengo dengue"), non-emergency. */
    health: boolean;
    /** She's upset with you, a complaint or an argument. */
    conflicts: boolean;
    /** Committing to plans with a date/time, money or promises. */
    plans: boolean;
  };
  /** How your ElevenLabs voice sounds. */
  voice: VoiceTuning;
}

export interface VoiceTuning {
  model: 'eleven_multilingual_v2' | 'eleven_flash_v2_5' | 'eleven_v3';
  /** 0.7 (slow) – 1.2 (fast). */
  speed: number;
  /** 0–1: higher = calmer, more even; lower = more expressive. */
  stability: number;
  /** 0–1: how closely to stick to your real voice (and its accent). */
  similarity: number;
  /** 0–1: exaggeration of the speaking style. 0 = neutral. */
  style: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false, // starts OFF: turn it on from the panel once you're happy with the profile
  pausedUntil: null,
  debounceSec: [8, 25],
  replyDelaySec: [5, 45],
  quietHours: null, // off by default: always there for her. Turn on in Ajustes if you want "sleep" hours.
  handBackMinutes: 2,
  voiceReplies: true,
  autonomy: { feelings: true, health: true, conflicts: false, plans: false },
  // Calm, unhurried, neutral: slower than default, steady, close to your real voice, no dramatization.
  voice: { model: 'eleven_multilingual_v2', speed: 0.9, stability: 0.65, similarity: 0.9, style: 0 },
};

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (!cache) {
    const saved = await kvGet<Partial<Settings> & { _v?: number }>('settings', {});
    // One-time upgrades of settings saved by older versions (persisted, so your later choices stick).
    if ((saved._v ?? 0) < 2 && Object.keys(saved).length) {
      if (String(saved.debounceSec) === '20,60') delete saved.debounceSec; // old slow defaults
      if (String(saved.replyDelaySec) === '10,120') delete saved.replyDelaySec;
      delete (saved as any).takeoverMinutes; // replaced by handBackMinutes (no more auto-pause)
      saved._v = 2;
    }
    if ((saved._v ?? 0) < 3 && Object.keys(saved).length) {
      // Sleep hours were on by default before; you asked for "always there", so start from off.
      saved.quietHours = null;
      saved._v = 3;
    }
    if ((saved._v ?? 0) < 4 && Object.keys(saved).length) {
      // You asked for fully autonomous, always-on replies: sleep hours off.
      saved.quietHours = null;
      saved._v = 4;
      await kvSet('settings', saved);
    }
    cache = {
      ...DEFAULT_SETTINGS,
      ...saved,
      autonomy: { ...DEFAULT_SETTINGS.autonomy, ...(saved.autonomy ?? {}) },
      voice: { ...DEFAULT_SETTINGS.voice, ...(saved.voice ?? {}) },
    };
  }
  return cache;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch, _v: 4 };
  await kvSet('settings', next);
  cache = next;
  return next;
}

/** True only when the bot is allowed to send right now. Always read fresh from the DB. */
export async function canSend(): Promise<boolean> {
  cache = null;
  const s = await getSettings();
  if (!s.enabled) return false;
  if (s.pausedUntil && new Date(s.pausedUntil).getTime() > Date.now()) return false;
  return true;
}

export async function cancelPending(reason: string) {
  const r = await q(
    `update pending_replies set status = 'cancelled', reason = $1
     where status in ('pending') returning id`,
    [reason],
  );
  return r.rowCount ?? 0;
}

export async function setEnabled(enabled: boolean, by: string) {
  await updateSettings({ enabled, pausedUntil: null });
  if (!enabled) await cancelPending(`kill switch (${by})`);
  await logEvent(enabled ? 'enabled' : 'disabled', by);
}

export async function pauseFor(minutes: number, why: string) {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await updateSettings({ pausedUntil: until });
  await cancelPending(`paused: ${why}`);
  await logEvent('paused', `${minutes} min — ${why}`);
}
