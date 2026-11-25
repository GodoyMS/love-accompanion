import pino from 'pino';
import { config } from '../config.js';
import { logEvent, pool, q } from '../db.js';
import { canSend } from '../settings.js';
import { rand, sleep } from '../time.js';
import { wa } from '../wa/client.js';

const log = pino({ level: config.logLevel });
let busy = false;
let offlineTimer: NodeJS.Timeout | null = null;

/** Rough human typing time for a message on a phone. */
const typingMs = (text: string) => Math.min(14_000, Math.max(1_500, text.length * rand(55, 95)));

export function startSender() {
  setInterval(() => void tick(), 4_000);
}

async function claimNext() {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await client.query(
      `select * from pending_replies
       where status = 'pending' and send_at <= now()
       order by send_at limit 1 for update skip locked`,
    );
    if (!r.rowCount) {
      await client.query('commit');
      return null;
    }
    await client.query(`update pending_replies set status = 'sending' where id = $1`, [r.rows[0].id]);
    await client.query('commit');
    return r.rows[0];
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

async function finish(id: number, status: 'sent' | 'cancelled', reason?: string) {
  await q(`update pending_replies set status = $2, reason = coalesce($3, reason) where id = $1`, [id, status, reason ?? null]);
}

async function tick() {
  if (busy || !wa.connected) return;
  busy = true;
  try {
    const job = await claimNext();
    if (!job) return;

    // Checked right before doing anything visible: the kill switch always wins.
    if (!(await canSend())) return finish(job.id, 'cancelled', 'switch off at send time');

    if (offlineTimer) clearTimeout(offlineTimer);
    await wa.presence('available');
    await sleep(rand(1_000, 4_000));
    await wa.markRead(job.read_keys ?? []);
    await sleep(rand(1_500, 6_000));

    if (job.reaction) {
      if (!(await canSend())) return finish(job.id, 'cancelled', 'switch off at send time');
      await wa.react(job.react_to, job.reaction);
      await q(
        `insert into messages (from_me, sent_by, kind, body, ts) values (true, 'bot', 'reaction', $1, now())`,
        [`[reacción ${job.reaction}]`],
      );
    }

    const parts: string[] = job.parts ?? [];
    for (let i = 0; i < parts.length; i++) {
      if (!(await canSend())) return finish(job.id, 'cancelled', `switch off after ${i} part(s)`);
      await wa.presence('composing');
      await sleep(typingMs(parts[i]));
      if (!(await canSend())) {
        await wa.presence('paused');
        return finish(job.id, 'cancelled', `switch off after ${i} part(s)`);
      }
      const waId = await wa.sendText(parts[i]);
      await q(
        `insert into messages (wa_id, from_me, sent_by, kind, body, ts, source)
         values ($1, true, 'bot', 'text', $2, now(), 'live') on conflict (wa_id) do nothing`,
        [waId, parts[i]],
      );
      if (i < parts.length - 1) await sleep(rand(700, 2_500));
    }
    await wa.presence('paused');
    await finish(job.id, 'sent');
    await logEvent('sent', parts.join(' | ') || job.reaction);

    // Go "offline" a little later, like closing the app.
    offlineTimer = setTimeout(() => void wa.presence('unavailable').catch(() => {}), rand(15_000, 60_000));
  } catch (e) {
    log.error(e, 'send failed');
    await logEvent('error', `send: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}

/** Anything stuck in "sending" from a crash is not retried (better to miss than double-send). */
export async function recoverStuck() {
  await q(`update pending_replies set status = 'cancelled', reason = 'interrupted' where status = 'sending'`);
}
