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
  /** Which sensitive topics the bot answers on its own (it always alerts you too). */
  autonomy: {
    /** Sadness, tiredness, "me siento mal", stress, a bad day. */
    feelings: boolean;
    /** She's upset with you, a complaint or an argument. */
    conflicts: boolean;
    /** Committing to plans with a date/time, money or promises. */
    plans: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: false, // starts OFF: turn it on from the panel once you're happy with the profile
  pausedUntil: null,
  debounceSec: [8, 25],
  replyDelaySec: [5, 45],
  quietHours: [1, 7],
  handBackMinutes: 2,
  autonomy: { feelings: true, conflicts: false, plans: false },
};

let cache: Settings | null = null;

export async function getSettings(): Promise<Settings> {
  if (!cache) {
    const saved = await kvGet<Partial<Settings>>('settings', {});
    // Old, slower defaults that were never customised → move to the faster ones.
    if (String(saved.debounceSec) === '20,60') delete saved.debounceSec;
    if (String(saved.replyDelaySec) === '10,120') delete saved.replyDelaySec;
    delete (saved as any).takeoverMinutes; // replaced by handBackMinutes (no more auto-pause)
    cache = { ...DEFAULT_SETTINGS, ...saved, autonomy: { ...DEFAULT_SETTINGS.autonomy, ...(saved.autonomy ?? {}) } };
  }
  return cache;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
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
