import { kvGet, kvSet } from '../store/db.js';
import { ports } from './ports.js';

/** Message to your own chat. Never throws: an alert must not break the flow that raised it. */
export async function notify(text: string) {
  try {
    await ports.messenger.notifySelf(text);
  } catch (e) {
    console.log('[notify] failed:', (e as Error)?.message);
  }
}

/** Same, but at most once per `minutes` for a given key (no alert storms). */
export async function notifyOnce(key: string, minutes: number, text: string) {
  const last = await kvGet<number>(`notified:${key}`, 0);
  if (ports.clock.now() - last < minutes * 60_000) return false;
  await kvSet(`notified:${key}`, ports.clock.now());
  await notify(text);
  return true;
}
