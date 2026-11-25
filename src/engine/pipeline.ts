import type { WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { config } from '../config.js';
import { logEvent, q } from '../db.js';
import { canSend, cancelPending, getSettings, pauseFor, setEnabled } from '../settings.js';
import { quietHoursEnd, rand } from '../time.js';
import { wa, type Parsed } from '../wa/client.js';
import { buildContext } from './context.js';
import { decide } from './llm.js';

const log = pino({ level: config.logLevel });

let timer: NodeJS.Timeout | null = null;
let generating = false;
let rerun = false;
/** Raw WA messages of recent images, so we can show them to Claude. */
const rawById = new Map<string, WAMessage>();

export async function onPartnerMessage(p: Parsed, raw: WAMessage) {
  if (p.kind === 'image') {
    rawById.set(p.waId, raw);
    setTimeout(() => rawById.delete(p.waId), 30 * 60_000);
  }
  // She wrote again: anything queued but not yet sent is now stale — re-think with the full picture.
  await cancelPending('she wrote again');
  await scheduleThink();
}

async function scheduleThink() {
  const s = await getSettings();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void think(), rand(s.debounceSec[0], s.debounceSec[1]) * 1000);
}

async function think() {
  timer = null;
  if (generating) {
    rerun = true;
    return;
  }
  generating = true;
  try {
    if (!(await canSend())) return;
    const ctx = await buildContext();
    if (!ctx.pending.length) return;

    if (ctx.pending.some((m) => m.kind === 'audio')) {
      await handoff('mandó una nota de voz', ctx.pending.map((m) => m.body).join(' / '));
      return;
    }

    const images = (
      await Promise.all(
        ctx.pending
          .filter((m) => m.kind === 'image' && m.wa_id && rawById.has(m.wa_id))
          .slice(-3)
          .map((m) => wa.downloadImage(rawById.get(m.wa_id!)!)),
      )
    ).filter((x): x is NonNullable<typeof x> => !!x);

    const d = await decide(ctx, images);
    if (rerun) return; // she wrote while we were thinking; the next pass will handle everything

    // The switch may have been flipped while Claude was thinking.
    if (!(await canSend())) return;

    const s = await getSettings();
    const last = ctx.pending[ctx.pending.length - 1];
    let sendAt = new Date(Date.now() + rand(s.replyDelaySec[0], s.replyDelaySec[1]) * 1000);
    const wake = quietHoursEnd(sendAt, s.quietHours);
    if (wake) sendAt = new Date(wake.getTime() + rand(5, 40) * 60_000);

    const readKeys = JSON.stringify(ctx.pending.map((m) => m.raw_key).filter(Boolean));

    switch (d.action) {
      case 'reply': {
        await q(
          `insert into pending_replies (send_at, parts, read_keys, reason) values ($1, $2, $3, 'reply')`,
          [sendAt, JSON.stringify(d.messages), readKeys],
        );
        break;
      }
      case 'react':
        await q(
          `insert into pending_replies (send_at, parts, reaction, react_to, read_keys, reason)
           values ($1, '[]', $2, $3, $4, 'react')`,
          [sendAt, d.reaction, JSON.stringify(last.raw_key), readKeys],
        );
        break;
      case 'wait':
        await logEvent('wait', last.body.slice(0, 120));
        break;
      case 'handoff':
        await handoff(d.reason, ctx.pending.map((m) => m.body).join(' / '));
        break;
    }
  } catch (e) {
    log.error(e, 'think failed');
    await logEvent('error', String((e as Error).message ?? e));
  } finally {
    generating = false;
    if (rerun) {
      rerun = false;
      await scheduleThink();
    }
  }
}

async function handoff(reason: string, preview: string) {
  await logEvent('handoff', `${reason} — ${preview.slice(0, 200)}`);
  await wa.notifySelf(`No le respondí, te toca a ti: ${reason}\n\nElla: "${preview.slice(0, 300)}"`);
}

/** You wrote to her from your phone: step aside so two "you"s never talk over each other. */
export async function onManualReply(_p: Parsed) {
  if (timer) clearTimeout(timer);
  timer = null;
  const s = await getSettings();
  await pauseFor(s.takeoverMinutes, 'escribiste tú');
}

export async function onSelfCommand(text: string) {
  const [cmd, arg] = text.toLowerCase().split(/\s+/);
  switch (cmd) {
    case '/stop':
    case '/off':
      await setEnabled(false, 'whatsapp');
      if (timer) clearTimeout(timer);
      await wa.notifySelf('Apagado. No se envía nada más.');
      break;
    case '/start':
    case '/on':
      await setEnabled(true, 'whatsapp');
      await wa.notifySelf('Encendido.');
      break;
    case '/pause': {
      const min = Math.max(1, Number(arg) || 60);
      await pauseFor(min, 'comando /pause');
      await wa.notifySelf(`En pausa ${min} min.`);
      break;
    }
    case '/status': {
      const s = await getSettings();
      const pending = await q(`select count(*)::int n from pending_replies where status = 'pending'`);
      await wa.notifySelf(
        `${s.enabled ? 'Encendido' : 'Apagado'}${s.pausedUntil && new Date(s.pausedUntil) > new Date() ? `, en pausa hasta ${new Date(s.pausedUntil).toLocaleTimeString('es-PE', { timeZone: config.timezone })}` : ''}. En cola: ${pending.rows[0].n}.`,
      );
      break;
    }
  }
}

/** After a restart, pick up anything she sent in the last couple of hours that never got an answer. */
export async function resumeOnBoot() {
  const r = await q(
    `select count(*)::int n from messages
     where not from_me and ts > now() - interval '2 hours'
       and ts > coalesce((select max(ts) from messages where from_me), 'epoch')`,
  );
  const pending = await q(`select count(*)::int n from pending_replies where status = 'pending'`);
  if (r.rows[0].n > 0 && pending.rows[0].n === 0) await scheduleThink();
}

export { cancelPending };
