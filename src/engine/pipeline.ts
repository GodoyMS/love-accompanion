import type { WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { config, missingConfig } from '../config.js';
import { kvGet, kvSet, logEvent, q } from '../db.js';
import { canSend, cancelPending, getSettings, pauseFor, setEnabled } from '../settings.js';
import { quietHoursEnd, rand } from '../time.js';
import { wa, type Parsed } from '../wa/client.js';
import { buildContext } from './context.js';
import { decide } from './llm.js';
import { sttProvider, transcribe } from './transcribe.js';
import { makeVoiceNote, voiceReady } from './voice.js';

const log = pino({ level: config.logLevel });

let timer: NodeJS.Timeout | null = null;
let generating = false;
let rerun = false;
/** Bumped on every message from her; a reply computed for an older value is stale. */
let inboxVersion = 0;
/** Raw WA messages of recent images, so we can show them to Claude. */
const rawById = new Map<string, WAMessage>();

export async function onPartnerMessage(p: Parsed, raw: WAMessage) {
  if (p.hasVisual) {
    rawById.set(p.waId, raw);
    setTimeout(() => rawById.delete(p.waId), 30 * 60_000);
  }
  // She wrote again: anything queued but not yet sent is now stale — re-think with the full picture.
  console.log(`[in] message from partner (${p.kind})`);
  inboxVersion++;
  await cancelPending('she wrote again');
  if (p.kind === 'audio' || p.kind === 'video') {
    // Hold any pending think until we know what she said.
    if (timer) clearTimeout(timer);
    timer = null;
    await transcribeInto(p, raw);
  }
  await scheduleThink();
}

/** Turn her voice note / video note into text so the bot can answer what she actually said. */
async function transcribeInto(p: Parsed, raw: WAMessage) {
  if (!sttProvider()) return;
  const media = await wa.mediaOf(raw);
  if (!media || media.seconds > 300) return; // skip long videos
  try {
    const t0 = Date.now();
    const text = await transcribe(media.data, media.mimetype);
    if (!text) return;
    await q(`update messages set body = $2 where wa_id = $1`, [p.waId, `${p.body} «${text}»`]);
    console.log(`[stt] transcribed ${media.seconds}s in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log('[stt] failed:', (e as Error)?.message);
    await logEvent('error', `stt: ${(e as Error)?.message}`);
  }
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
    if (!(await canSend()) || missingConfig.length) return;
    const ctx = await buildContext();
    if (!ctx.pending.length) return;

    // Photos, stickers, video thumbnails and link previews she just sent (last 4).
    const images = (
      await Promise.all(
        ctx.pending
          .filter((m) => m.wa_id && rawById.has(m.wa_id))
          .slice(-4)
          .map((m) => wa.visualOf(rawById.get(m.wa_id!)!)),
      )
    ).filter((x): x is NonNullable<typeof x> => !!x);

    console.log(`[think] ${ctx.pending.length} unanswered message(s), asking Claude`);
    const version = inboxVersion;
    const st = await getSettings();
    // She spoke to you → answer by voice (if enabled and your ElevenLabs voice is set up).
    const lastIn = ctx.pending[ctx.pending.length - 1];
    const byVoice = st.voiceReplies && voiceReady() && lastIn?.kind === 'audio';
    const d = await decide(ctx, images, st.autonomy, undefined, byVoice);
    console.log(`[think] decision: ${d.action}`);
    // She wrote while we were thinking: drop this answer, the next pass sees everything.
    if (rerun || version !== inboxVersion) {
      console.log('[think] discarded: she wrote again meanwhile');
      return;
    }

    // The switch may have been flipped while Claude was thinking.
    if (!(await canSend())) return;

    const s = await getSettings();
    const last = ctx.pending[ctx.pending.length - 1];
    let sendAt = new Date(Date.now() + rand(s.replyDelaySec[0], s.replyDelaySec[1]) * 1000);
    // You're chatting with her yourself: give you room. The bot only steps in if you go quiet
    // and she's still waiting; if you answer first, the sender drops this reply.
    const lastManual = await lastManualMessageAt();
    if (lastManual) {
      const handBack = new Date(lastManual.getTime() + s.handBackMinutes * 60_000 + rand(5, 30) * 1000);
      if (handBack > sendAt) {
        sendAt = handBack;
        console.log('[think] you were active recently, waiting for you first');
      }
    }
    const wake = quietHoursEnd(sendAt, s.quietHours);
    if (wake) {
      sendAt = new Date(wake.getTime() + rand(5, 40) * 60_000);
      const at = sendAt.toLocaleTimeString('es-PE', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
      console.log('[think] deferred by sleep hours');
      // Never hold a reply silently: tell you, so you can send it now from the panel or answer yourself.
      if (d.action === 'reply' || d.action === 'react') {
        await wa.notifySelf(`Son tus horas de sueño (Ajustes), así que dejé su respuesta para las ${at}. Si quieres que salga ya, toca "Enviar ya" en el panel o desactiva las horas de sueño.`);
      }
    }

    if (d.action === 'reply' || d.action === 'react') console.log(`[think] scheduled for ${sendAt.toISOString()}`);
    const readKeys = JSON.stringify(ctx.pending.map((m) => m.raw_key).filter(Boolean));

    switch (d.action) {
      case 'reply': {
        let voice: Awaited<ReturnType<typeof makeVoiceNote>> | null = null;
        if (byVoice) {
          try {
            const t0 = Date.now();
            voice = await makeVoiceNote(d.messages.join(' '));
            console.log(`[voice] generated ${voice.seconds}s voice note in ${Date.now() - t0}ms`);
            // A person needs at least as long as the note to record it.
            const minAt = Date.now() + (voice.seconds + rand(3, 10)) * 1000;
            if (sendAt.getTime() < minAt) sendAt = new Date(minAt);
          } catch (e) {
            console.log('[voice] failed, sending text instead:', (e as Error)?.message);
            await logEvent('error', `voice: ${(e as Error)?.message}`);
          }
        }
        await q(
          `insert into pending_replies (send_at, parts, read_keys, reason, voice, voice_seconds, voice_waveform)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            sendAt,
            JSON.stringify(voice ? [d.messages.join(' ')] : d.messages),
            readKeys,
            voice ? 'voice' : 'reply',
            voice?.ogg ?? null,
            voice?.seconds ?? null,
            voice ? Buffer.from(voice.waveform) : null,
          ],
        );
        if (d.alert) {
          await logEvent('alert', d.alert);
          // One heads-up per topic is enough: don't ping you on every follow-up message.
          const last = await kvGet<number>('last_alert_at', 0);
          if (Date.now() - last > 30 * 60_000) {
            await kvSet('last_alert_at', Date.now());
            const at = sendAt.toLocaleTimeString('es-PE', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });
            await wa.notifySelf(
              `Tema delicado, lo estoy llevando yo: ${d.alert}\n\nElla: "${ctx.pending.map((m) => m.body).join(' / ').slice(0, 300)}"\nVoy a responder a las ${at}: "${d.messages.join(' / ')}"\n\nSi le escribes tú antes, no envío nada y te dejo llevar la conversación mientras estés activo. No te vuelvo a avisar de esto en 30 min.`,
            );
          }
        }
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
      case 'disclose': {
        // Tell her the truth (it isn't you), in text, then step aside until you decide.
        const text = d.direct ? st.disclosure.directText : st.disclosure.doubtText;
        const at = new Date(Date.now() + rand(st.replyDelaySec[0], st.replyDelaySec[1]) * 1000);
        await q(
          `insert into pending_replies (send_at, parts, read_keys, reason) values ($1, $2, $3, 'disclose')`,
          [at, JSON.stringify([text]), readKeys],
        );
        await logEvent('disclose', d.reason);
        await wa.notifySelf(
          `Ella ${d.direct ? 'preguntó si es un bot' : 'dudó de que fueras tú'}: "${ctx.pending.map((m) => m.body).join(' / ').slice(0, 300)}"\n\nLe voy a decir: "${text}"\n\nDespués quedo en pausa ${st.disclosure.pauseHours} h. Escríbele tú; cuando quieras que vuelva, mándame /start.`,
        );
        break;
      }
    }
  } catch (e) {
    console.log('[think] failed:', (e as Error)?.stack ?? e);
    // Tell you right away instead of failing silently.
    await wa.notifySelf(`No pude generar la respuesta: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
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
  // She keeps writing while you haven't answered yet: one alert is enough for 10 min.
  const last = await kvGet<number>('last_handoff_at', 0);
  if (Date.now() - last < 10 * 60_000) {
    console.log('[think] handoff again, alert already sent recently');
    return;
  }
  await kvSet('last_handoff_at', Date.now());
  await wa.notifySelf(`No le respondí, te toca a ti: ${reason}\n\nElla: "${preview.slice(0, 300)}"`);
}

/** She edited or deleted a message: re-think with the corrected conversation. */
export async function onPartnerChanged() {
  console.log('[in] she edited or deleted a message');
  inboxVersion++;
  const n = await cancelPending('she edited/deleted a message');
  const unanswered = await q(
    `select 1 from messages where not from_me and kind <> 'reaction'
       and ts > coalesce((select max(ts) from messages where from_me), 'epoch') limit 1`,
  );
  if (n || unanswered.rowCount) await scheduleThink();
}

/** She called and nobody picked up: it goes into the chat so the bot can text her back. */
export async function onMissedCall(isVideo: boolean) {
  console.log(`[in] missed ${isVideo ? 'video ' : ''}call`);
  await q(
    `insert into messages (wa_id, from_me, sent_by, kind, body, ts, source) values ($1, false, 'human', 'call', $2, now(), 'live')`,
    [`call-${Date.now()}`, `[llamada ${isVideo ? 'de video ' : ''}perdida]`],
  );
  inboxVersion++;
  await cancelPending('missed call');
  await scheduleThink();
}

/**
 * You wrote to her from your phone. The bot stays ON: whatever it had queued is now stale
 * (you answered), so drop it; her next message gets the usual treatment, with the
 * hand-back window giving you the first chance to answer.
 */
export async function onManualReply(_p: Parsed) {
  if (timer) clearTimeout(timer);
  timer = null;
  inboxVersion++; // anything being generated right now is for a conversation you already took over
  const n = await cancelPending('you answered yourself');
  console.log(`[manual] you wrote to her${n ? `, dropped ${n} queued reply(ies)` : ''}`);
  await logEvent('manual', n ? `cancelled ${n}` : undefined);
}

async function lastManualMessageAt(): Promise<Date | null> {
  const r = await q(
    `select max(ts) as t from messages where from_me and sent_by = 'human' and source = 'live' and ts > now() - interval '1 hour'`,
  );
  return r.rows[0]?.t ? new Date(r.rows[0].t) : null;
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
  // Replies parked for "sleep hours" that are now turned off: send them soon instead of hours later.
  const s0 = await getSettings();
  console.log(`[boot] bot ${s0.enabled ? 'ON' : 'OFF'}, sleep hours: ${s0.quietHours ? s0.quietHours.join('-') + 'h' : 'off'}, timing: wait ${s0.debounceSec.join('-')}s + ${s0.replyDelaySec.join('-')}s`);
  if (!s0.quietHours) {
    const r = await q(
      `update pending_replies set send_at = now() + (random() * interval '40 seconds') + interval '5 seconds'
       where status = 'pending' and send_at > now() + interval '10 minutes'`,
    );
    if (r.rowCount) console.log(`[boot] brought forward ${r.rowCount} reply(ies) parked for sleep hours`);
  }
  // Older versions auto-paused when you typed; lift that kind of pause (never a manual one).
  const lastPause = await q(`select detail from events where type = 'paused' order by ts desc limit 1`);
  if (String(lastPause.rows[0]?.detail ?? '').includes('escribiste tú')) {
    const { updateSettings } = await import('../settings.js');
    await updateSettings({ pausedUntil: null });
    console.log('[boot] lifted the old auto-pause');
  }
  const r = await q(
    `select count(*)::int n from messages
     where not from_me and ts > now() - interval '2 hours'
       and ts > coalesce((select max(ts) from messages where from_me), 'epoch')`,
  );
  const pending = await q(`select count(*)::int n from pending_replies where status = 'pending'`);
  if (r.rows[0].n > 0 && pending.rows[0].n === 0) await scheduleThink();
}

export { cancelPending };
