import type { WAMessage } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { kvGet, logEvent } from '../store/db.js';
import * as messages from '../store/messages.js';
import * as replies from '../store/replies.js';
import { canSend, getSettings, settingsEvents, type Settings } from '../store/settings.js';
import { buildContext } from './context.js';
import { notify, notifyOnce } from './notify.js';
import { NoAnswer, ports, type Decision, type DecideInput, type VoiceNote } from './ports.js';
import { quietHoursEnd } from './time.js';

/** What the WhatsApp adapter hands us for each message. */
export interface Incoming {
  waId: string;
  fromMe: boolean;
  kind: string;
  body: string;
  ts: Date;
  key: any;
  hasVisual: boolean;
}

const preview = (turns: { body: string }[]) => turns.map((t) => t.body).join(' / ').slice(0, 300);
const hhmm = (d: Date) => d.toLocaleTimeString('es-PE', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit' });

/**
 * The conversation with her. Owns the "think" cycle:
 *   her message → wait until she stops typing → ask Claude → queue the reply (the Dispatcher sends it).
 *
 * Invariants:
 * - At most one think runs at a time; anything arriving mid-think triggers one more pass.
 * - A decision made before her (or your) latest message is thrown away, never queued.
 * - Every new message from her cancels replies that haven't started sending.
 */
export class Conversation {
  private timer: NodeJS.Timeout | null = null;
  private thinking: Promise<void> | null = null;
  private again = false;
  /** Bumped by anything that makes an in-flight decision stale. */
  private version = 0;
  /** Raw WhatsApp messages with media, kept briefly so Claude can look at them. */
  private raws = new Map<string, WAMessage>();

  constructor() {
    settingsEvents.on('ready', () => void this.kick('switched on'));
  }

  // ---------- inbound ----------

  async onIncoming(m: Incoming, raw: WAMessage) {
    console.log(`[in] message from her (${m.kind})`);
    this.version++;
    if (m.hasVisual) {
      this.raws.set(m.waId, raw);
      setTimeout(() => this.raws.delete(m.waId), 30 * 60_000).unref?.();
    }
    await replies.cancelPending('she wrote again');
    if (m.kind === 'audio' || m.kind === 'video') {
      this.clearTimer(); // don't think before we know what she said
      await this.transcribe(m, raw);
    }
    await this.schedule();
  }

  /** She edited or deleted a message. */
  async onChanged() {
    console.log('[in] she edited/deleted a message');
    this.version++;
    const n = await replies.cancelPending('she edited/deleted a message');
    if (n || (await messages.unanswered()).length) await this.schedule();
  }

  /** She called and nobody picked up. */
  async onMissedCall(isVideo: boolean) {
    console.log(`[in] missed ${isVideo ? 'video ' : ''}call`);
    await messages.insertSynthetic('call', `[llamada ${isVideo ? 'de video ' : ''}perdida]`);
    this.version++;
    await replies.cancelPending('missed call');
    await this.schedule();
  }

  /** You wrote to her yourself: whatever the bot had queued is stale. The bot stays on. */
  async onManual() {
    this.clearTimer();
    this.version++;
    const n = await replies.cancelPending('you answered yourself');
    console.log(`[manual] you wrote to her${n ? `, dropped ${n} queued` : ''}`);
    await logEvent('manual', n ? `cancelled ${n}` : undefined);
  }

  /** Re-check for unanswered messages (after switching on, resuming, or a restart). */
  async kick(why: string, withinHours = 12) {
    const pending = await messages.unanswered();
    const recent = pending.filter((t) => ports.clock.now() - new Date(t.received_at).getTime() < withinHours * 3600_000);
    if (!recent.length || (await replies.countPending()) > 0) return;
    console.log(`[kick] ${recent.length} unanswered (${why})`);
    await this.schedule();
  }

  // ---------- think cycle ----------

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async schedule() {
    const s = await getSettings();
    this.clearTimer();
    const ms = ports.clock.rand(s.debounceSec[0], s.debounceSec[1]) * 1000;
    this.timer = setTimeout(() => void this.run(), ms);
  }

  private async run() {
    this.timer = null;
    if (this.thinking) {
      this.again = true;
      return;
    }
    this.thinking = this.think().finally(() => {
      this.thinking = null;
      if (this.again) {
        this.again = false;
        void this.schedule();
      }
    });
    await this.thinking;
  }

  /** Resolves when nothing is scheduled or running (used by tests and shutdown). */
  async idle() {
    for (let i = 0; i < 200 && (this.timer || this.thinking); i++) {
      if (this.thinking) await this.thinking;
      else await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async think() {
    try {
      if (!(await canSend())) return;
      if (!ports.brain.ready()) {
        console.log('[think] skipped: ANTHROPIC_API_KEY missing');
        return;
      }
      const ctx = await buildContext();
      if (!ctx.pending.length) return;

      const s = await getSettings();
      const version = this.version;
      const last = ctx.pending[ctx.pending.length - 1];
      const input: DecideInput = {
        ctx,
        images: await this.visuals(ctx.pending),
        autonomy: s.autonomy,
        voice: s.voiceReplies && ports.speech.canSpeak() && last.kind === 'audio',
        disclosed: await this.disclosed(),
      };

      console.log(`[think] ${ctx.pending.length} unanswered, asking Claude${input.voice ? ' (voice)' : ''}`);
      const d = await this.decide(input);
      console.log(`[think] decision: ${d.action}`);

      if (version !== this.version || this.again) {
        console.log('[think] discarded: the conversation moved on meanwhile');
        return;
      }
      if (!(await canSend())) return;

      await this.act(d, input, s);
    } catch (e) {
      console.log('[think] failed:', (e as Error)?.stack ?? e);
      await logEvent('error', `think: ${(e as Error)?.message}`);
      await notifyOnce('think-error', 15, `No pude generar la respuesta: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
  }

  /** The bot never leaves her unanswered: one retry insisting on a reply; only two failures reach you. */
  private async decide(input: DecideInput): Promise<Decision> {
    try {
      return await ports.brain.decide(input);
    } catch (e) {
      if (!(e instanceof NoAnswer)) throw e;
      console.log(`[think] no usable answer (${e.message}), retrying`);
    }
    try {
      return await ports.brain.decide({ ...input, hint: 'Tienes que responderle tú sí o sí con "reply", con cariño y sin inventar nada.' });
    } catch (e) {
      if (e instanceof NoAnswer) return { action: 'handoff', reason: e.message };
      throw e;
    }
  }

  /**
   * When to send: her pace, your hand-back window, and sleep hours if on.
   * An emergency skips all of that and goes out within seconds.
   */
  private async sendTime(s: Settings, urgent = false): Promise<{ at: Date; parkedBySleep: boolean }> {
    const now = ports.clock.now();
    if (urgent) return { at: new Date(now + ports.clock.rand(3, 10) * 1000), parkedBySleep: false };
    let at = now + ports.clock.rand(s.replyDelaySec[0], s.replyDelaySec[1]) * 1000;
    const manual = await messages.lastManualAt();
    if (manual) {
      const handBack = manual.getTime() + s.handBackMinutes * 60_000 + ports.clock.rand(5, 30) * 1000;
      if (handBack > at) {
        at = handBack;
        console.log('[think] you were active recently: giving you the first chance');
      }
    }
    const wake = quietHoursEnd(new Date(at), s.quietHours);
    if (wake) return { at: new Date(wake.getTime() + ports.clock.rand(5, 40) * 60_000), parkedBySleep: true };
    return { at: new Date(at), parkedBySleep: false };
  }

  private async act(d: Decision, input: DecideInput, s: Settings) {
    const { pending } = input.ctx;
    const last = pending[pending.length - 1];
    const readKeys = pending.map((t) => t.raw_key).filter(Boolean);

    switch (d.action) {
      case 'wait':
        await logEvent('wait', last.body.slice(0, 120));
        return;

      case 'handoff':
        // Only reached when the model failed twice.
        await logEvent('handoff', `${d.reason} — ${preview(pending)}`);
        await notifyOnce('handoff', 10, `No pude generar una respuesta (falló dos veces): ${d.reason}\n\nElla: "${preview(pending)}"`);
        return;

      case 'disclose': {
        const text = d.direct ? s.disclosure.directText : s.disclosure.doubtText;
        const { at } = await this.sendTime({ ...s, quietHours: null });
        await replies.enqueue({ kind: 'disclose', sendAt: at, parts: [text], readKeys });
        await logEvent('disclose', d.reason);
        await notify(
          `Ella ${d.direct ? 'preguntó si es un bot' : 'dudó de que fueras tú'}: "${preview(pending)}"\n\nLe voy a decir: "${text}"\n\nSigo respondiéndole normalmente. Si quieres que pare, mándame /stop o /pause.`,
        );
        return;
      }

      case 'react': {
        const { at, parkedBySleep } = await this.sendTime(s);
        await replies.enqueue({ kind: 'react', sendAt: at, reaction: d.reaction, reactTo: last.raw_key, readKeys });
        if (parkedBySleep) await this.tellParked(at);
        console.log(`[think] reaction queued for ${at.toISOString()}`);
        return;
      }

      case 'reply': {
        const urgent = !!d.urgent;
        let { at, parkedBySleep } = await this.sendTime(s, urgent);
        let voice: VoiceNote | null = null;
        if (input.voice) {
          try {
            voice = await ports.speech.speak(d.messages.join(' '));
            console.log(`[voice] ${voice.seconds}s note ready`);
            const minAt = ports.clock.now() + (voice.seconds + ports.clock.rand(3, 10)) * 1000; // time to "record" it
            if (at.getTime() < minAt) at = new Date(minAt);
          } catch (e) {
            console.log('[voice] failed, sending text:', (e as Error)?.message);
            await logEvent('error', `voice: ${(e as Error)?.message}`);
          }
        }
        await replies.enqueue(
          voice
            ? { kind: 'voice', sendAt: at, parts: [d.messages.join(' ')], readKeys, voice }
            : { kind: 'reply', sendAt: at, parts: d.messages, readKeys },
        );
        console.log(`[think] ${voice ? 'voice note' : `${d.messages.length} message(s)`} queued for ${at.toISOString()}`);
        if (parkedBySleep) await this.tellParked(at);
        // Delicate-but-normal topics only go to the panel log. Only a real emergency pings you
        // (once per 30 min); the bot keeps answering her meanwhile.
        if (d.alert || urgent) await logEvent(urgent ? 'urgent' : 'alert', d.alert || 'emergencia');
        if (urgent) {
          await notifyOnce(
            'urgent',
            30,
            `Emergencia, ya le estoy respondiendo yo: ${d.alert || 'ver chat'}\n\nElla: "${preview(pending)}"\nLe respondo: "${d.messages.join(' / ')}"\n\nSigo acompañándola. Solo te aviso por si quieres intervenir.`,
          );
        }
        return;
      }
    }
  }

  /** Visible in the panel ("Enviar ya"); no WhatsApp ping, you're asleep. */
  private async tellParked(at: Date) {
    await logEvent('deferred', `horas de sueño, sale a las ${hhmm(at)}`);
  }

  // ---------- helpers ----------

  private async transcribe(m: Incoming, raw: WAMessage) {
    if (!ports.speech.canTranscribe()) return;
    try {
      const media = await ports.messenger.mediaOf(raw);
      if (!media || media.seconds > 300) return;
      const text = await ports.speech.transcribe(media.data, media.mimetype);
      if (!text) return;
      await messages.updateBody(m.waId, `${m.body} «${text}»`);
      console.log(`[stt] transcribed ${media.seconds}s`);
    } catch (e) {
      console.log('[stt] failed:', (e as Error)?.message);
      await logEvent('error', `stt: ${(e as Error)?.message}`);
    }
  }

  private async visuals(pending: messages.Turn[]) {
    const raws = pending.filter((t) => t.wa_id && this.raws.has(t.wa_id)).slice(-4);
    const out = await Promise.all(raws.map((t) => ports.messenger.visualOf(this.raws.get(t.wa_id!)!).catch(() => null)));
    return out.filter((x): x is NonNullable<typeof x> => !!x);
  }

  /** She was told a stand-in answers (within the last day). */
  private async disclosed() {
    const at = await kvGet<number>('disclosed_at', 0);
    return ports.clock.now() - at < 24 * 3600_000;
  }
}

export const conversation = new Conversation();
