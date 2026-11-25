import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { config, partnerPnJid } from '../../config.js';
import type { Incoming } from '../../core/conversation.js';
import type { Messenger, Presence, Visual } from '../../core/ports.js';
import { kvGet, kvSet, logEvent } from '../../store/db.js';
import { insertMessage, isBotMessage, updateBody } from '../../store/messages.js';
import { usePgAuthState } from './auth.js';
import { describe } from './describe.js';

/** What the adapter reports to the core. */
export interface InboundHandler {
  onIncoming(m: Incoming, raw: WAMessage): Promise<void>;
  /** She edited or deleted a message. */
  onChanged(): Promise<void>;
  /** She called and nobody picked up. */
  onMissedCall(isVideo: boolean): Promise<void>;
  /** You wrote to her from your phone. */
  onManual(m: Incoming): Promise<void>;
  /** You wrote a /command in your own chat. */
  onCommand(text: string): Promise<void>;
}

const log = pino({ level: config.logLevel === 'debug' ? 'debug' : 'warn' });

/** WA_BROWSER lets us switch the identity we present to WhatsApp without a code change. */
function pickBrowser(): [string, string, string] {
  switch ((process.env.WA_BROWSER ?? 'mac-chrome').toLowerCase()) {
    case 'mac-desktop':
      return Browsers.macOS('Desktop');
    case 'ubuntu-chrome':
      return Browsers.ubuntu('Chrome');
    case 'windows-chrome':
      return Browsers.windows('Chrome');
    default:
      return Browsers.macOS('Chrome'); // Baileys' own default, the most tested combination
  }
}

class WhatsApp implements Messenger {
  sock: WASocket | null = null;
  qrDataUrl: string | null = null;
  connected = false;
  me: { pn: string | null; lid: string | null } = { pn: null, lid: null };
  private partnerJids = new Set<string>(partnerPnJid ? [partnerPnJid] : []);
  /** Ids of messages the bot sent, so we can tell them apart from you typing on your phone. */
  private botIds = new Set<string>();
  private sentCache = new Map<string, proto.IMessage>();
  private handler!: InboundHandler;
  private stopping = false;
  private retries = 0;
  lastStatus = 'iniciando…';

  async start(handler: InboundHandler) {
    this.handler = handler;
    // The learned LID belongs to whichever number was configured when it was learned.
    const saved = await kvGet<{ pn: string; lid: string } | string | null>('partner_lid', null);
    if (saved && typeof saved === 'object' && saved.pn === partnerPnJid) this.partnerJids.add(saved.lid);
    await this.connect();
  }

  private async connect() {
    const { state, saveCreds, clear } = await usePgAuthState();
    const latest = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8_000)),
    ]).catch((e) => {
      console.log('[wa] could not fetch latest WA version, using bundled one:', e?.message);
      return { version: undefined as any };
    });
    const version = latest.version;
    console.log(`[wa] connecting (registered=${!!state.creds.registered}, version=${version?.join('.') ?? 'bundled'}, browser=${pickBrowser().join('/')})`);
    this.lastStatus = 'conectando…';

    const sock = makeWASocket({
      version,
      auth: state,
      logger: log as any,
      browser: pickBrowser(),
      markOnlineOnConnect: false, // keep your phone getting notifications and don't look "always online"
      syncFullHistory: true,
      getMessage: async (key) => (key.id ? this.sentCache.get(key.id) : undefined),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
        this.lastStatus = 'esperando que escanees el QR';
        console.log('[wa] new QR available in the panel');
      }
      if (u.connection === 'open') {
        this.connected = true;
        this.retries = 0;
        this.qrDataUrl = null;
        this.me = {
          pn: sock.user?.id ? jidNormalizedUser(sock.user.id) : null,
          lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
        };
        this.lastStatus = 'conectado';
        console.log(`[wa] connected as ${this.me.pn}`);
        await this.learnPartnerLid();
        await logEvent('wa_connected', this.me.pn ?? undefined);
      }
      if (u.connection === 'close') {
        this.connected = false;
        const err = u.lastDisconnect?.error as any;
        const code = err?.output?.statusCode;
        const reason = `${code ?? '?'} ${err?.message ?? ''}`.trim();
        this.lastStatus = `desconectado: ${reason}`;
        console.log(`[wa] connection closed: ${reason}`);
        await logEvent('wa_closed', reason);
        if (this.stopping) return;
        if (code === DisconnectReason.loggedOut) {
          await clear();
          this.me = { pn: null, lid: null };
        }
        if (code === DisconnectReason.connectionReplaced) {
          // Another instance took over the session (e.g. an overlapping deploy). Don't fight it.
          return;
        }
        this.qrDataUrl = null;
        this.retries++;
        const wait =
          code === DisconnectReason.restartRequired || code === DisconnectReason.loggedOut
            ? 500
            : Math.min(60_000, 2_000 * 2 ** Math.min(this.retries, 5));
        console.log(`[wa] reconnecting in ${Math.round(wait / 1000)}s`);
        setTimeout(
          () =>
            this.connect().catch((e) => {
              console.log('[wa] connect failed:', e?.message ?? e);
              this.lastStatus = `error: ${e?.message ?? e}`;
            }),
          wait,
        );
      }
    });

    sock.ev.on('messaging-history.set', async ({ messages, lidPnMappings }) => {
      for (const m of lidPnMappings ?? []) {
        if (jidNormalizedUser(m.pn) === partnerPnJid) await this.rememberPartnerLid(m.lid);
      }
      let n = 0;
      for (const raw of messages) {
        if (!this.isPartnerChat(raw.key)) continue;
        const p = this.parse(raw);
        if (!p || p.kind === 'reaction') continue;
        if (await insertMessage(p, p.fromMe && (await isBotMessage(p.waId)) ? 'bot' : 'human', 'history')) n++;
      }
      if (n) await logEvent('history_sync', `${n} messages`);
    });

    sock.ev.on('messages.update', async (updates) => {
      for (const u of updates) await this.onUpdate(u as any).catch((e) => console.log('[wa] update failed:', e?.message));
    });

    sock.ev.on('call', async (calls) => {
      for (const c of calls) await this.onCall(c as any).catch((e) => console.log('[wa] call failed:', e?.message));
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const raw of messages) {
        try {
          await this.route(raw);
        } catch (e) {
          console.log('[wa] route failed:', (e as Error)?.stack ?? e);
        }
      }
    });
  }

  private async onUpdate(u: { key: WAMessageKey; update: any }) {
    if (!u.key?.id || u.key.fromMe || !this.isPartnerChat(u.key)) return;
    const edited = u.update?.message?.editedMessage?.message;
    if (edited) {
      const d = describe(edited);
      if (!d) return;
      if (await updateBody(u.key.id, `${d.body} (editado)`)) await this.handler.onChanged();
      return;
    }
    if (u.update?.message === null || u.update?.messageStubType === 1 /* REVOKE */) {
      if (await updateBody(u.key.id, '[eliminó este mensaje]', 'other')) await this.handler.onChanged();
    }
  }

  private callOffers = new Map<string, { isVideo: boolean; answered: boolean; at: number }>();

  private async onCall(c: { id: string; from: string; callerPn?: string; status: string; isVideo?: boolean; isGroup?: boolean }) {
    if (c.isGroup) return;
    const fromPartner =
      this.partnerJids.has(jidNormalizedUser(c.from)) || (c.callerPn && jidNormalizedUser(c.callerPn) === partnerPnJid);
    if (!fromPartner) return;
    if (c.status === 'offer' || c.status === 'ringing') {
      if (!this.callOffers.has(c.id)) {
        this.callOffers.set(c.id, { isVideo: !!c.isVideo, answered: false, at: Date.now() });
        console.log(`[call] she is calling (${c.isVideo ? 'video' : 'voice'})`);
        await this.notifySelf(`Te está llamando por ${c.isVideo ? 'videollamada' : 'llamada'}.`);
      }
    } else if (c.status === 'accept') {
      const o = this.callOffers.get(c.id);
      if (o) o.answered = true;
    } else if (c.status === 'timeout' || c.status === 'reject' || c.status === 'terminate') {
      const o = this.callOffers.get(c.id);
      this.callOffers.delete(c.id);
      // A linked device doesn't always see you answer on the phone. A call that ended after
      // ringing for over a minute was almost certainly picked up, so don't treat it as missed.
      const longCall = o && c.status === 'terminate' && Date.now() - o.at > 60_000;
      if (o && !o.answered && !longCall) await this.handler.onMissedCall(o.isVideo);
    }
  }

  private async route(raw: WAMessage) {
    const key = raw.key;
    if (!key.remoteJid) return;

    // Commands you send to yourself ("Message yourself" chat): /stop, /start, /pause 60, /status
    if (key.fromMe && this.isSelfChat(key)) {
      const text = this.textOf(raw);
      if (text?.startsWith('/')) await this.handler.onCommand(text.trim());
      return;
    }

    if (!this.isPartnerChat(key)) return;
    if (key.remoteJidAlt && jidNormalizedUser(key.remoteJidAlt) === partnerPnJid) {
      await this.rememberPartnerLid(key.remoteJid);
    }

    const p = this.parse(raw);
    if (!p) return;

    if (p.fromMe) {
      // The bot's own sends echo back here (also after a restart): never mistake them for you.
      if (this.botIds.has(p.waId) || (await isBotMessage(p.waId))) return;
      if (await insertMessage(p, 'human', 'live')) await this.handler.onManual(p);
      return;
    }
    if (!(await insertMessage(p, 'human', 'live'))) return; // duplicate delivery
    if (p.kind === 'reaction') return; // her reaction to your message: context, nothing to answer
    await this.handler.onIncoming(p, raw);
  }

  // ---------- helpers ----------

  isPartnerChat(key: WAMessageKey) {
    const jid = key.remoteJid ? jidNormalizedUser(key.remoteJid) : '';
    const alt = key.remoteJidAlt ? jidNormalizedUser(key.remoteJidAlt) : '';
    return this.partnerJids.has(jid) || this.partnerJids.has(alt);
  }

  private isSelfChat(key: WAMessageKey) {
    const jid = jidNormalizedUser(key.remoteJid!);
    return jid === this.me.pn || jid === this.me.lid;
  }

  private async learnPartnerLid() {
    try {
      if (!partnerPnJid) return;
      const lid = await this.sock?.signalRepository.lidMapping.getLIDForPN(partnerPnJid);
      if (lid) await this.rememberPartnerLid(lid);
    } catch {
      /* not critical */
    }
  }

  private async rememberPartnerLid(lid: string) {
    const norm = jidNormalizedUser(lid);
    if (this.partnerJids.has(norm)) return;
    this.partnerJids.add(norm);
    await kvSet('partner_lid', { pn: partnerPnJid, lid: norm });
  }

  textOf(raw: WAMessage): string | null {
    const c = normalizeMessageContent(raw.message);
    return (
      c?.conversation ??
      c?.extendedTextMessage?.text ??
      c?.imageMessage?.caption ??
      c?.videoMessage?.caption ??
      null
    );
  }

  parse(raw: WAMessage): Incoming | null {
    if (!raw.key.id) return null;
    const d = describe(raw.message);
    if (!d) return null;
    const tsRaw = raw.messageTimestamp;
    const ts = new Date(Number(typeof tsRaw === 'object' && tsRaw ? tsRaw.toString() : tsRaw ?? Date.now() / 1000) * 1000);
    return { waId: raw.key.id, fromMe: !!raw.key.fromMe, kind: d.kind, body: d.body, ts, key: raw.key, hasVisual: !!d.visual };
  }

  /** Raw audio/video bytes of a voice note or video, for transcription. */
  async mediaOf(raw: WAMessage): Promise<{ data: Buffer; mimetype: string; seconds: number } | null> {
    const c = normalizeMessageContent(raw.message);
    const m = c?.audioMessage ?? c?.ptvMessage ?? (c?.videoMessage?.gifPlayback ? null : c?.videoMessage);
    if (!m) return null;
    try {
      const data = await downloadMediaMessage(raw, 'buffer', {});
      return { data, mimetype: m.mimetype ?? 'audio/ogg', seconds: m.seconds ?? 0 };
    } catch (e) {
      console.log('[wa] could not download audio:', (e as Error)?.message);
      return null;
    }
  }

  /** The image Claude should see for this message (photo, sticker, video thumbnail, link preview). */
  async visualOf(raw: WAMessage): Promise<Visual | null> {
    const d = describe(raw.message);
    if (!d?.visual) return null;
    try {
      if (d.visual.source === 'thumb' && d.visual.thumb) {
        return { data: Buffer.from(d.visual.thumb).toString('base64'), mediaType: 'image/jpeg', label: d.visual.label };
      }
      const buf = await downloadMediaMessage(raw, 'buffer', {});
      return { data: buf.toString('base64'), mediaType: (d.visual.mime ?? 'image/jpeg').split(';')[0], label: d.visual.label };
    } catch (e) {
      console.log('[wa] could not get media:', (e as Error)?.message);
      return null;
    }
  }

  // ---------- actions used by the sender ----------

  private get partnerTarget() {
    return partnerPnJid;
  }

  async markRead(keys: WAMessageKey[]) {
    if (keys.length) await this.sock?.readMessages(keys);
  }

  async presence(state: Presence) {
    const to = state === 'composing' || state === 'recording' || state === 'paused' ? this.partnerTarget : undefined;
    await this.sock?.sendPresenceUpdate(state, to);
  }

  async sendText(text: string): Promise<string> {
    if (!this.sock || !this.connected) throw new Error('WhatsApp not connected');
    const id = generateMessageIDV2(this.sock.user?.id);
    this.botIds.add(id);
    const sent = await this.sock.sendMessage(this.partnerTarget, { text }, { messageId: id });
    if (sent?.message) this.sentCache.set(id, sent.message);
    return id;
  }

  /** Send a real WhatsApp voice note (the bubble with the waveform, not an audio file). */
  async sendVoice(ogg: Buffer, seconds: number, waveform?: Uint8Array): Promise<string> {
    if (!this.sock || !this.connected) throw new Error('WhatsApp not connected');
    const id = generateMessageIDV2(this.sock.user?.id);
    this.botIds.add(id);
    const content: any = { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds };
    if (waveform) content.waveform = waveform;
    const sent = await this.sock.sendMessage(this.partnerTarget, content, { messageId: id });
    if (sent?.message) this.sentCache.set(id, sent.message);
    return id;
  }

  async react(key: WAMessageKey, emoji: string): Promise<string> {
    if (!this.sock || !this.connected) throw new Error('WhatsApp not connected');
    const id = generateMessageIDV2(this.sock.user?.id);
    this.botIds.add(id);
    await this.sock.sendMessage(this.partnerTarget, { react: { text: emoji, key } }, { messageId: id });
    return id;
  }

  /** Message to your own "Message yourself" chat (alerts from the bot). */
  async notifySelf(text: string) {
    if (!this.sock || !this.connected || !this.me.pn) {
      console.log(`[notify] WhatsApp not connected, alert only logged: ${text.slice(0, 200)}`);
      await logEvent('alert_undelivered', text.slice(0, 300));
      return;
    }
    await this.sock.sendMessage(this.me.pn, { text: `🤖 ${text}` });
  }

  async logout() {
    await this.sock?.logout().catch(() => {});
  }

  async stop() {
    this.stopping = true;
    this.sock?.end(undefined);
  }
}

export const wa = new WhatsApp();
