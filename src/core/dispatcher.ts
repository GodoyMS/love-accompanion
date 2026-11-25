import { kvSet, logEvent } from '../store/db.js';
import * as messages from '../store/messages.js';
import * as replies from '../store/replies.js';
import { canSend, getSettings, pauseFor } from '../store/settings.js';
import { notifyOnce } from './notify.js';
import { ports } from './ports.js';

const MAX_ATTEMPTS = 3;

/** Why a reply must not go out (or stop going out) right now. */
async function blocker(createdAt: Date): Promise<string | null> {
  if (!(await canSend())) return 'switched off or paused';
  if (await messages.herMessageSince(createdAt)) return 'she wrote again';
  if (await messages.manualMessageSince(createdAt)) return 'you answered yourself';
  return null;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * Sends queued replies like a person would: opens the chat, reads, types (or records), sends.
 *
 * Invariants:
 * - A reply is claimed atomically, so it is sent at most once.
 * - Before anything visible, and between parts, it re-checks: switch, pause, her new
 *   messages, your manual messages. Any of them stops it.
 * - If sending fails before anything reached her, it retries (up to 3 times); if part of it
 *   was already delivered, it's closed as sent (never re-sent).
 */
export class Dispatcher {
  private interval: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  private offline: NodeJS.Timeout | null = null;

  start(everyMs = 3_000) {
    this.interval = setInterval(() => void this.tick(), everyMs);
  }

  /** Stop taking new work and wait for the reply in progress (graceful shutdown). */
  async stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.busy) await this.busy;
  }

  /** Process every reply that is due now (tests and manual triggers). */
  async drain() {
    for (let i = 0; i < 50; i++) {
      if (this.busy) await this.busy;
      const did = await this.tick();
      if (!did) break;
    }
  }

  /** Returns true if it handled a reply. */
  async tick(): Promise<boolean> {
    if (this.busy || !ports.messenger.connected) return false;
    let handled = false;
    this.busy = (async () => {
      const job = await replies.claimDue();
      if (!job) return;
      handled = true;
      await this.deliver(job);
    })()
      .catch((e) => console.log('[send] tick failed:', (e as Error)?.message))
      .finally(() => {
        this.busy = null;
      });
    await this.busy;
    return handled;
  }

  private async deliver(job: replies.Reply) {
    const m = ports.messenger;
    const { clock } = ports;
    let delivered = 0;
    try {
      const stop = await blocker(job.created_at);
      if (stop) return replies.finish(job.id, 'cancelled', stop);

      if (this.offline) clearTimeout(this.offline);
      await m.presence('available');
      await clock.sleep(clock.rand(1_000, 4_000));
      await m.markRead(job.read_keys ?? []);
      await clock.sleep(clock.rand(1_500, 5_000));

      if (job.kind === 'react') {
        const stop2 = await blocker(job.created_at);
        if (stop2) return replies.finish(job.id, 'cancelled', stop2);
        const id = await m.react(job.react_to, job.reaction!);
        await messages.insertBotMessage(id, 'reaction', `[reacción ${job.reaction}]`);
        delivered++;
      } else if (job.kind === 'voice' && job.voice) {
        const secs = job.voice_seconds ?? 1;
        await m.presence('recording');
        await clock.sleep(Math.min(45_000, secs * 1000 + clock.rand(500, 2_000)));
        const stop2 = await blocker(job.created_at);
        if (stop2) {
          await m.presence('paused');
          return replies.finish(job.id, 'cancelled', stop2);
        }
        const id = await m.sendVoice(job.voice, secs, job.voice_waveform ? new Uint8Array(job.voice_waveform) : undefined);
        await messages.insertBotMessage(id, 'audio', `[nota de voz ${mmss(secs)}] «${job.parts.join(' ')}»`);
        delivered++;
      } else {
        for (const [i, part] of job.parts.entries()) {
          const stopN = await blocker(job.created_at);
          if (stopN) {
            await m.presence('paused');
            return replies.finish(job.id, i === 0 ? 'cancelled' : 'sent', `${stopN} (after ${i} part(s))`);
          }
          await m.presence('composing');
          await clock.sleep(Math.min(14_000, Math.max(1_500, part.length * clock.rand(55, 95))));
          const stopT = await blocker(job.created_at);
          if (stopT) {
            await m.presence('paused');
            return replies.finish(job.id, i === 0 ? 'cancelled' : 'sent', `${stopT} (after ${i} part(s))`);
          }
          const id = await m.sendText(part);
          await messages.insertBotMessage(id, 'text', part);
          delivered++;
          if (i < job.parts.length - 1) await clock.sleep(clock.rand(700, 2_500));
        }
      }

      await m.presence('paused').catch(() => {});
      await replies.finish(job.id, 'sent');
      await logEvent('sent', `${job.kind}: ${job.parts.join(' | ') || job.reaction}`);
      console.log(`[send] ${job.kind} delivered (${delivered} message(s))`);

      if (job.kind === 'disclose') {
        await kvSet('disclosed_at', clock.now());
        await pauseFor((await getSettings()).disclosure.pauseHours * 60, 'le dijo que no eras tú');
      }
      this.offline = setTimeout(() => void m.presence('unavailable').catch(() => {}), clock.rand(15_000, 60_000));
      this.offline.unref?.();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      console.log(`[send] failed (attempt ${job.attempts}): ${msg}`);
      await logEvent('error', `send: ${msg}`);
      if (delivered > 0) {
        // Part of it already reached her: never resend.
        await replies.finish(job.id, 'sent', `partially delivered (${delivered}); then: ${msg}`);
      } else if (job.attempts < MAX_ATTEMPTS) {
        await replies.retryLater(job.id, 15 * job.attempts, `retry after: ${msg}`);
      } else {
        await replies.finish(job.id, 'failed', msg);
        await notifyOnce('send-failed', 15, `No pude enviarle una respuesta después de ${MAX_ATTEMPTS} intentos: ${msg.slice(0, 200)}`);
      }
    }
  }
}

export const dispatcher = new Dispatcher();
