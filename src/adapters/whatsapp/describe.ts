import { getContentType, normalizeMessageContent, type proto } from '@whiskeysockets/baileys';

export type IncomingKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'sticker'
  | 'document'
  | 'location'
  | 'contact'
  | 'poll'
  | 'event'
  | 'reaction'
  | 'call'
  | 'other';

export interface Described {
  kind: IncomingKind;
  /** Human-readable line stored in the DB and shown to Claude, e.g. "[video 0:12] mira esto". */
  body: string;
  /**
   * Visual Claude can look at:
   * - 'download': full media must be downloaded (photos, stickers)
   * - 'thumb': an embedded JPEG preview is already in the message (videos, GIFs, link previews)
   */
  visual?: { source: 'download' | 'thumb'; label: string; thumb?: Uint8Array; mime?: string };
}

const secs = (n?: number | null) => {
  if (!n) return '';
  const m = Math.floor(n / 60);
  return ` ${m}:${String(Math.round(n % 60)).padStart(2, '0')}`;
};

const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Everything WhatsApp can send, turned into one line Claude (and you, in the panel) can read. */
export function describe(message: proto.IMessage | null | undefined, opts: { quoted?: boolean } = {}): Described | null {
  const raw = message;
  const c = normalizeMessageContent(message);
  if (!c) return null;
  const type = getContentType(c);
  if (!type || type === 'protocolMessage' || type === 'senderKeyDistributionMessage' || type === 'messageContextInfo') {
    return null;
  }

  const viewOnce = !!(raw?.viewOnceMessage || raw?.viewOnceMessageV2 || raw?.viewOnceMessageV2Extension);
  let d: Described;

  switch (type) {
    case 'conversation':
      d = { kind: 'text', body: c.conversation ?? '' };
      break;

    case 'extendedTextMessage': {
      const m = c.extendedTextMessage!;
      let body = m.text ?? '';
      // Link preview: tell Claude what the link is about (a reel, a song, a news article…).
      if (m.matchedText || m.title) {
        const parts = [m.title, m.description].filter(Boolean).map((x) => clip(String(x), 120));
        if (parts.length) body += ` [link: ${parts.join(' — ')}]`;
      }
      d = { kind: 'text', body };
      if (m.jpegThumbnail?.length && !opts.quoted) {
        d.visual = { source: 'thumb', label: 'Vista previa del link que mandó', thumb: m.jpegThumbnail, mime: 'image/jpeg' };
      }
      break;
    }

    case 'imageMessage': {
      const m = c.imageMessage!;
      d = { kind: 'image', body: `[foto${viewOnce ? ' de ver una vez' : ''}]${m.caption ? ' ' + m.caption : ''}` };
      if (!opts.quoted) d.visual = { source: 'download', label: 'Foto que mandó', mime: m.mimetype ?? 'image/jpeg' };
      break;
    }

    case 'videoMessage':
    case 'ptvMessage': {
      const m = (c.videoMessage ?? c.ptvMessage)!;
      const what = type === 'ptvMessage' ? 'video nota' : m.gifPlayback ? 'gif' : 'video';
      d = {
        kind: 'video',
        body: `[${what}${viewOnce ? ' de ver una vez' : ''}${what === 'gif' ? '' : secs(m.seconds)}]${m.caption ? ' ' + m.caption : ''}`,
      };
      if (m.jpegThumbnail?.length && !opts.quoted) {
        d.visual = { source: 'thumb', label: `Miniatura del ${what} que mandó (no ves el resto)`, thumb: m.jpegThumbnail, mime: 'image/jpeg' };
      }
      break;
    }

    case 'audioMessage': {
      const m = c.audioMessage!;
      d = { kind: 'audio', body: `[${m.ptt ? 'nota de voz' : 'audio'}${secs(m.seconds)}]` };
      break;
    }

    case 'stickerMessage': {
      const m = c.stickerMessage!;
      d = { kind: 'sticker', body: `[sticker${m.isAnimated ? ' animado' : ''}]` };
      if (!opts.quoted) d.visual = { source: 'download', label: 'Sticker que mandó', mime: 'image/webp' };
      break;
    }

    case 'documentMessage': {
      const m = c.documentMessage!;
      const name = m.fileName || m.title || 'archivo';
      d = { kind: 'document', body: `[documento: ${name}${m.pageCount ? `, ${m.pageCount} págs.` : ''}]${m.caption ? ' ' + m.caption : ''}` };
      break;
    }

    case 'locationMessage': {
      const m = c.locationMessage!;
      const place = [m.name, m.address].filter(Boolean).join(', ');
      d = { kind: 'location', body: `[ubicación${place ? ': ' + place : ''} (${m.degreesLatitude?.toFixed(5)}, ${m.degreesLongitude?.toFixed(5)})]${m.comment ? ' ' + m.comment : ''}` };
      break;
    }

    case 'liveLocationMessage': {
      const m = c.liveLocationMessage!;
      d = { kind: 'location', body: `[ubicación en tiempo real]${m.caption ? ' ' + m.caption : ''}` };
      break;
    }

    case 'contactMessage':
      d = { kind: 'contact', body: `[contacto: ${c.contactMessage?.displayName ?? 'sin nombre'}]` };
      break;

    case 'contactsArrayMessage': {
      const names = (c.contactsArrayMessage?.contacts ?? []).map((x) => x.displayName).filter(Boolean);
      d = { kind: 'contact', body: `[contactos: ${names.join(', ') || (c.contactsArrayMessage?.displayName ?? '')}]` };
      break;
    }

    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5': {
      const m = (c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3 ?? (c as any).pollCreationMessageV5)!;
      const opts2 = (m.options ?? []).map((o: any) => o.optionName).filter(Boolean);
      d = { kind: 'poll', body: `[encuesta: ${m.name ?? ''} — opciones: ${opts2.join(' / ')}]` };
      break;
    }

    case 'pollUpdateMessage':
      d = { kind: 'poll', body: '[votó en una encuesta]' };
      break;

    case 'eventMessage': {
      const m = (c as any).eventMessage;
      d = { kind: 'event', body: `[evento: ${m?.name ?? ''}${m?.description ? ' — ' + clip(m.description, 100) : ''}]` };
      break;
    }

    case 'reactionMessage': {
      const t = c.reactionMessage?.text;
      d = { kind: 'reaction', body: t ? `[reaccionó ${t} a un mensaje]` : '[quitó una reacción]' };
      break;
    }

    default:
      d = { kind: 'other', body: `[${String(type).replace(/Message$/, '')}]` };
  }

  // Context that changes the meaning of the message.
  const ctx = (c as any)[type]?.contextInfo as proto.IContextInfo | undefined;
  if (!opts.quoted && ctx) {
    if (ctx.isForwarded) d.body = `[reenviado] ${d.body}`;
    if (ctx.quotedMessage) {
      const q = describe(ctx.quotedMessage, { quoted: true });
      if (q?.body) {
        const status = ctx.remoteJid === 'status@broadcast' ? 'a tu estado' : '';
        d.body = `(respondiendo ${status || 'a'} «${clip(q.body, 100)}») ${d.body}`;
      }
    }
  }
  d.body = d.body.trim();
  return d;
}
