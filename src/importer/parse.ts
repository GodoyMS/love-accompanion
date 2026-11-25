/**
 * Parser for WhatsApp "Export chat" .txt files (Android and iPhone, Spanish or English).
 *
 * Android: 25/11/24, 10:30 p. m. - Nombre: texto
 *          25/11/2024 22:30 - Nombre: texto
 * iPhone:  [25/11/24, 10:30:15 p. m.] Nombre: texto
 */

export interface ExportLine {
  /** Wall-clock components, in the phone's timezone. */
  y: number; mo: number; d: number; h: number; mi: number; s: number;
  sender: string;
  body: string;
}

const LINE = new RegExp(
  String.raw`^\[?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+` + // date
    String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?\s*` + // time
    String.raw`([ap]\.?\s?m\.?)?` + // am/pm (a. m. / p.m. / PM)
    String.raw`\]?\s*(?:-\s)?` + // separator
    String.raw`([^:]{1,60}?):\s([\s\S]*)$`, // sender: body
  'i',
);

const INVISIBLE = /[‎‏‪-‮⁦-⁩﻿]/g;

const MEDIA_PATTERNS: [RegExp, string][] = [
  [/<(multimedia omitido|media omitted)>/i, '[multimedia]'],
  [/^(imagen omitida|image omitted)$/i, '[foto]'],
  [/^(audio omitido|audio omitted)$/i, '[nota de voz]'],
  [/^(sticker omitido|sticker omitted)$/i, '[sticker]'],
  [/^(video omitido|video omitted)$/i, '[video]'],
  [/^(GIF omitido|GIF omitted)$/i, '[gif]'],
  [/\.(opus|ogg) \((archivo adjunto|file attached)\)$/i, '[nota de voz]'],
  [/\.(jpg|jpeg|png|webp) \((archivo adjunto|file attached)\)$/i, '[foto]'],
];

const SKIP = [
  /^(se eliminó este mensaje|eliminaste este mensaje|this message was deleted|you deleted this message)\.?$/i,
  /^<se editó este mensaje\.?>$/i,
  /^null$/,
];

export function parseExport(text: string): { lines: ExportLine[]; senders: string[] } {
  const raw = text.replace(/\r\n?/g, '\n').replace(/ | /g, ' ').split('\n');
  const heads: { m: RegExpMatchArray; extra: string[] }[] = [];

  for (const l of raw) {
    const line = l.replace(INVISIBLE, '');
    const m = line.match(LINE);
    if (m) heads.push({ m, extra: [] });
    else if (heads.length) heads[heads.length - 1].extra.push(line);
  }

  // Decide day/month order: if any first field > 12 it's d/m, if any second field > 12 it's m/d.
  let dmy = true;
  if (heads.some((h) => +h.m[2] > 12)) dmy = false;
  if (heads.some((h) => +h.m[1] > 12)) dmy = true;

  const lines: ExportLine[] = [];
  const senders = new Map<string, number>();

  for (const { m, extra } of heads) {
    let [, a, b, y, h, mi, s, ampm, sender, body] = m;
    const year = y.length === 2 ? 2000 + +y : +y;
    let hour = +h;
    if (ampm) {
      const pm = /^p/i.test(ampm);
      if (pm && hour < 12) hour += 12;
      if (!pm && hour === 12) hour = 0;
    }
    body = [body, ...extra].join('\n').replace(/<Se editó este mensaje\.?>/i, '').trim();
    if (!body || SKIP.some((r) => r.test(body))) continue;
    for (const [re, label] of MEDIA_PATTERNS) {
      if (re.test(body)) {
        body = label;
        break;
      }
    }
    sender = sender.trim();
    senders.set(sender, (senders.get(sender) ?? 0) + 1);
    lines.push({
      y: year,
      mo: dmy ? +b : +a,
      d: dmy ? +a : +b,
      h: hour,
      mi: +mi,
      s: s ? +s : 0,
      sender,
      body,
    });
  }

  return {
    lines,
    senders: [...senders.entries()].sort((x, y) => y[1] - x[1]).map(([n]) => n),
  };
}

export function kindOf(body: string) {
  if (body === '[foto]') return 'image';
  if (body === '[nota de voz]') return 'audio';
  if (body === '[sticker]') return 'sticker';
  if (/^\[(multimedia|video|gif)\]$/.test(body)) return 'other';
  return 'text';
}
