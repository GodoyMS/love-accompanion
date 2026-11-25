import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { config, partnerPnJid } from '../config.js';
import { kvGet, kvSet, logEvent, q } from '../db.js';
import { usePgAuthState } from './auth.js';

export type IncomingKind = 'text' | 'image' | 'audio' | 'sticker' | 'reaction' | 'other';

export interface Parsed {
  waId: string;
  fromMe: boolean;
  kind: IncomingKind;
  body: string;
  ts: Date;
  key: WAMessageKey;
}

type Handler = {
  onPartnerMessage: (m: Parsed, raw: WAMessage) => void | Promise<void>;
  onManualReply: (m: Parsed) => void | Promise<void>;
  onSelfCommand: (text: string) => void | Promise<void>;
};

const log = pino({ level: config.logLevel === 'debug' ? 'debug' : 'warn' });

class WhatsApp {
  sock: WASocket | null = null;
  qrDataUrl: string | null = null;
  connected = false;
  me: { pn: string | null; lid: string | null } = { pn: null, lid: null };
  private partnerJids = new Set<string>(partnerPnJid ? [partnerPnJid] : []);
  /** Ids of messages the bot sent, so we can tell them apart from you typing on your phone. */
  private botIds = new Set<string>();
  private sentCache = new Map<string, proto.IMessage>();
  private handler!: Handler;
  private stopping = false;
  private retries = 0;

  async start(handler: Handler) {
    this.handler = handler;
    // The learned LID belongs to whichever number was configured when it was learned.
    const saved = await kvGet<{ pn: string; lid: string } | string | null>('partner_lid', null);
    if (saved && typeof saved === 'object' && saved.pn === partnerPnJid) this.partnerJids.add(saved.lid);
    await this.connect();
  }

  private async connect() {
    const { state, saveCreds, clear } = await usePgAuthState();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger: log as any,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false, // keep your phone getting notifications and don't look "always online"
      syncFullHistory: true,
      getMessage: async (key) => (key.id ? this.sentCache.get(key.id) : undefined),
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      }
      if (u.connection === 'open') {
        this.connected = true;
        this.retries = 0;
        this.qrDataUrl = null;
        this.me = {
          pn: sock.user?.id ? jidNormalizedUser(sock.user.id) : null,
          lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
        };
        await this.learnPartnerLid();
        await logEvent('wa_connected', this.me.pn ?? undefined);
      }
      if (u.connection === 'close') {
        this.connected = false;
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        await logEvent('wa_closed', String(code));
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
        setTimeout(() => this.connect().catch((e) => log.error(e)), wait);
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
        await storeMessage(p, 'human', 'history');
        n++;
      }
      if (n) await logEvent('history_sync', `${n} messages`);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const raw of messages) {
        try {
          await this.route(raw);
        } catch (e) {
          log.error(e, 'route failed');
        }
      }
    });
  }

  private async route(raw: WAMessage) {
    const key = raw.key;
    if (!key.remoteJid) return;

    // Commands you send to yourself ("Message yourself" chat): /stop, /start, /pause 60, /status
    if (key.fromMe && this.isSelfChat(key)) {
      const text = this.textOf(raw);
      if (text?.startsWith('/')) await this.handler.onSelfCommand(text.trim());
      return;
    }

    if (!this.isPartnerChat(key)) return;
    if (key.remoteJidAlt && jidNormalizedUser(key.remoteJidAlt) === partnerPnJid) {
      await this.rememberPartnerLid(key.remoteJid);
    }

    const p = this.parse(raw);
    if (!p) return;

    if (p.fromMe) {
      if (this.botIds.has(p.waId)) return; // our own send, already stored by the sender
      await storeMessage(p, 'human', 'live');
      await this.handler.onManualReply(p);
      return;
    }
    if (p.kind === 'reaction') return;
    await storeMessage(p, 'human', 'live');
    await this.handler.onPartnerMessage(p, raw);
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

  parse(raw: WAMessage): Parsed | null {
    const c = normalizeMessageContent(raw.message);
    if (!c || !raw.key.id) return null;
    const type = getContentType(c);
    if (!type || type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return null;

    let kind: IncomingKind = 'other';
    let body = '';
    switch (type) {
      case 'conversation':
      case 'extendedTextMessage':
        kind = 'text';
        body = this.textOf(raw) ?? '';
        break;
      case 'imageMessage':
        kind = 'image';
        body = `[foto]${c.imageMessage?.caption ? ' ' + c.imageMessage.caption : ''}`;
        break;
      case 'videoMessage':
        kind = 'other';
        body = `[video]${c.videoMessage?.caption ? ' ' + c.videoMessage.caption : ''}`;
        break;
      case 'audioMessage':
        kind = 'audio';
        body = '[nota de voz]';
        break;
      case 'stickerMessage':
        kind = 'sticker';
        body = '[sticker]';
        break;
      case 'reactionMessage':
        kind = 'reaction';
        body = `[reacción ${c.reactionMessage?.text ?? ''}]`;
        break;
      default:
        body = `[${type.replace('Message', '')}]`;
    }
    const tsRaw = raw.messageTimestamp;
    const ts = new Date(Number(typeof tsRaw === 'object' && tsRaw ? tsRaw.toString() : tsRaw ?? Date.now() / 1000) * 1000);
    return { waId: raw.key.id, fromMe: !!raw.key.fromMe, kind, body, ts, key: raw.key };
  }

  async downloadImage(raw: WAMessage): Promise<{ data: string; mediaType: string } | null> {
    try {
      const buf = await downloadMediaMessage(raw, 'buffer', {});
      const mediaType = normalizeMessageContent(raw.message)?.imageMessage?.mimetype ?? 'image/jpeg';
      return { data: buf.toString('base64'), mediaType: mediaType.split(';')[0] };
    } catch {
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

  async presence(state: 'available' | 'unavailable' | 'composing' | 'paused') {
    const to = state === 'composing' || state === 'paused' ? this.partnerTarget : undefined;
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

  async react(key: WAMessageKey, emoji: string) {
    if (!this.sock || !this.connected) throw new Error('WhatsApp not connected');
    const id = generateMessageIDV2(this.sock.user?.id);
    this.botIds.add(id);
    await this.sock.sendMessage(this.partnerTarget, { react: { text: emoji, key } }, { messageId: id });
  }

  /** Message to your own "Message yourself" chat (alerts from the bot). */
  async notifySelf(text: string) {
    if (!this.sock || !this.connected || !this.me.pn) return;
    await this.sock.sendMessage(this.me.pn, { text: `🤖 ${text}` }).catch(() => {});
  }

  async logout() {
    await this.sock?.logout().catch(() => {});
  }

  async stop() {
    this.stopping = true;
    this.sock?.end(undefined);
  }
}

export async function storeMessage(p: Parsed, sentBy: 'human' | 'bot', source: 'live' | 'history') {
  await q(
    `insert into messages (wa_id, from_me, sent_by, kind, body, ts, raw_key, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (wa_id) do nothing`,
    [p.waId, p.fromMe, sentBy, p.kind, p.body, p.ts, JSON.stringify(p.key), source],
  );
}

export const wa = new WhatsApp();
