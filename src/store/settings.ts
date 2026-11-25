import { EventEmitter } from 'node:events';
import { kvGet, kvSet, logEvent } from './db.js';
import { cancelPending } from './replies.js';

export interface VoiceTuning {
  model: 'eleven_multilingual_v2' | 'eleven_flash_v2_5' | 'eleven_v3';
  /** 0.7 (slow) – 1.2 (fast). */
  speed: number;
  /** 0–1: higher = calmer, more even. */
  stability: number;
  /** 0–1: how closely to stick to your real voice (and its accent). */
  similarity: number;
  /** 0–1: exaggeration of the speaking style. 0 = neutral. */
  style: number;
}

export interface Autonomy {
  /** Sadness, tiredness, "me siento mal", a bad day. */
  feelings: boolean;
  /** Non-emergency physical symptoms. */
  health: boolean;
  /** She's upset with you. */
  conflicts: boolean;
  /** Plans with a date, money, promises. */
  plans: boolean;
}

export interface Settings {
  /** Master kill switch. */
  enabled: boolean;
  /** While in the future, the bot is paused. */
  pausedUntil: string | null;
  /** Seconds of silence from her before answering everything together. */
  debounceSec: [number, number];
  /** Extra random delay before starting to type. */
  replyDelaySec: [number, number];
  /** Local hours when replies wait until morning. null = always answer. */
  quietHours: [number, number] | null;
  /** After you write yourself, minutes the bot gives you to keep going before it steps in. */
  handBackMinutes: number;
  /** Answer her voice notes with a voice note in your voice. */
  voiceReplies: boolean;
  autonomy: Autonomy;
  voice: VoiceTuning;
  /** What the bot says when she doubts it's you, or asks straight out if it's a bot. It keeps answering after. */
  disclosure: { doubtText: string; directText: string };
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  pausedUntil: null,
  debounceSec: [8, 25],
  replyDelaySec: [5, 45],
  quietHours: null,
  handBackMinutes: 2,
  voiceReplies: true,
  autonomy: { feelings: true, health: true, conflicts: false, plans: false },
  // Warm and lively, close to your real voice.
  voice: { model: 'eleven_multilingual_v2', speed: 1.02, stability: 0.4, similarity: 0.85, style: 0.35 },
  disclosure: {
    doubtText:
      'Amor, te soy sincero: no soy Godoy, soy un reemplazo suyo para que no te quedes sin respuesta cuando él no puede contestar. Igual aquí sigo para acompañarte.',
    directText:
      'Sí, te soy sincero: soy un programa que Godoy configuró para responderte cuando él no puede contestar. Igual aquí sigo para acompañarte.',
  },
};

// ---------- validation ----------

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const range = (v: unknown, lo: number, hi: number, fallback: [number, number]): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2) return fallback;
  const a = num(v[0], lo, hi, fallback[0]);
  const b = num(v[1], lo, hi, fallback[1]);
  return a <= b ? [a, b] : [b, a];
};
const text = (v: unknown, fallback: string, max = 600) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback;

/** Turn anything (saved JSON, a panel request) into valid settings. Unknown keys are dropped. */
export function normalizeSettings(input: any, base: Settings = DEFAULT_SETTINGS): Settings {
  const i = input ?? {};
  const qh = i.quietHours;
  const models: VoiceTuning['model'][] = ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_v3'];
  return {
    enabled: bool(i.enabled, base.enabled),
    pausedUntil:
      i.pausedUntil === null ? null : typeof i.pausedUntil === 'string' && !Number.isNaN(Date.parse(i.pausedUntil)) ? i.pausedUntil : base.pausedUntil,
    debounceSec: range(i.debounceSec, 0, 600, base.debounceSec),
    replyDelaySec: range(i.replyDelaySec, 0, 1800, base.replyDelaySec),
    quietHours:
      qh === null
        ? null
        : Array.isArray(qh) && qh.length === 2 && Number(qh[0]) !== Number(qh[1])
          ? [num(qh[0], 0, 23, 1), num(qh[1], 0, 23, 7)].map(Math.round) as [number, number]
          : qh === undefined
            ? base.quietHours
            : null,
    handBackMinutes: num(i.handBackMinutes, 0, 120, base.handBackMinutes),
    voiceReplies: bool(i.voiceReplies, base.voiceReplies),
    autonomy: {
      feelings: bool(i.autonomy?.feelings, base.autonomy.feelings),
      health: bool(i.autonomy?.health, base.autonomy.health),
      conflicts: bool(i.autonomy?.conflicts, base.autonomy.conflicts),
      plans: bool(i.autonomy?.plans, base.autonomy.plans),
    },
    voice: {
      model: models.includes(i.voice?.model) ? i.voice.model : base.voice.model,
      speed: num(i.voice?.speed, 0.7, 1.2, base.voice.speed),
      stability: num(i.voice?.stability, 0, 1, base.voice.stability),
      similarity: num(i.voice?.similarity, 0, 1, base.voice.similarity),
      style: num(i.voice?.style, 0, 1, base.voice.style),
    },
    disclosure: {
      doubtText: text(i.disclosure?.doubtText, base.disclosure.doubtText),
      directText: text(i.disclosure?.directText, base.disclosure.directText),
    },
  };
}

// ---------- persistence ----------

const VERSION = 6;
const OLD_DOUBT = 'Amor, te soy sincero: no soy Godoy, soy un reemplazo suyo para que no te quedes sin respuesta cuando él no puede contestar. Ya le aviso para que te escriba él.';
const OLD_DIRECT = 'Sí, te soy sincero: soy un programa que Godoy configuró para responderte cuando él no puede contestar. Ya le aviso para que te escriba él.';
let cache: Settings | null = null;

/** Fired after the bot becomes able to send again (enabled or resumed). */
export const settingsEvents = new EventEmitter();

/** One-time upgrades of settings saved by older versions. Run once at boot. */
export async function migrateSettings() {
  const saved = await kvGet<any>('settings', null);
  if (!saved) return;
  const v = saved._v ?? 0;
  if (v >= VERSION) return;
  if (v < 2) {
    if (String(saved.debounceSec) === '20,60') delete saved.debounceSec;
    if (String(saved.replyDelaySec) === '10,120') delete saved.replyDelaySec;
    delete saved.takeoverMinutes;
  }
  if (v < 4) saved.quietHours = null; // you asked for always-on
  // The calm/neutral voice sounded flat: more energy and expression (keeps your model).
  if (v < 5 && saved.voice) saved.voice = { ...saved.voice, speed: 1.02, stability: 0.4, similarity: 0.85, style: 0.35 };
  if (v < 6 && saved.disclosure) {
    // No more pause after telling her; drop the "ya le aviso" promise from the old default texts.
    delete saved.disclosure.pauseHours;
    if (saved.disclosure.doubtText === OLD_DOUBT) saved.disclosure.doubtText = DEFAULT_SETTINGS.disclosure.doubtText;
    if (saved.disclosure.directText === OLD_DIRECT) saved.disclosure.directText = DEFAULT_SETTINGS.disclosure.directText;
  }
  await kvSet('settings', { ...normalizeSettings(saved), _v: VERSION });
  cache = null;
}

export async function getSettings(): Promise<Settings> {
  if (!cache) cache = normalizeSettings(await kvGet<any>('settings', {}));
  return cache;
}

/** Fresh from the DB (used right before anything visible). */
export async function reloadSettings() {
  cache = null;
  return getSettings();
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await reloadSettings();
  const next = normalizeSettings({ ...current, ...patch }, current);
  await kvSet('settings', { ...next, _v: VERSION });
  cache = next;
  return next;
}

export const isPaused = (s: Settings) => !!s.pausedUntil && Date.parse(s.pausedUntil) > Date.now();

/** True only when the bot may send right now. Always read fresh. */
export async function canSend(): Promise<boolean> {
  const s = await reloadSettings();
  return s.enabled && !isPaused(s);
}

// ---------- state transitions (all logged with who did it) ----------

export async function setEnabled(enabled: boolean, by: string) {
  await updateSettings({ enabled, pausedUntil: null });
  if (!enabled) await cancelPending(`switched off (${by})`);
  await logEvent(enabled ? 'enabled' : 'disabled', by);
  console.log(`[state] ${enabled ? 'enabled' : 'disabled'} by ${by}`);
  if (enabled) settingsEvents.emit('ready');
}

export async function pauseFor(minutes: number, by: string) {
  const until = new Date(Date.now() + minutes * 60_000).toISOString();
  await updateSettings({ pausedUntil: until });
  await cancelPending(`paused (${by})`);
  await logEvent('paused', `${minutes} min — ${by}`);
  console.log(`[state] paused ${minutes} min by ${by}`);
}

export async function resume(by: string) {
  await updateSettings({ pausedUntil: null });
  await logEvent('resumed', by);
  console.log(`[state] resumed by ${by}`);
  settingsEvents.emit('ready');
}
