import { q } from './db.js';

/** One stored WhatsApp message. */
export interface Turn {
  id: number;
  wa_id: string | null;
  from_me: boolean;
  sent_by: 'human' | 'bot' | 'import';
  kind: string;
  body: string;
  ts: Date;
  received_at: Date;
  raw_key: any;
  source: 'live' | 'history' | 'import';
}

export interface NewMessage {
  waId: string;
  fromMe: boolean;
  kind: string;
  body: string;
  ts: Date;
  key?: unknown;
}

/**
 * Store a message from WhatsApp. Live messages get received_at = now (DB clock); history
 * gets received_at = ts so old messages never look like new arrivals. Returns false if
 * it was already stored.
 */
export async function insertMessage(m: NewMessage, sentBy: 'human' | 'bot', source: 'live' | 'history'): Promise<boolean> {
  const r = await q(
    `insert into messages (wa_id, from_me, sent_by, kind, body, ts, raw_key, source, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8 = 'history' then $6::timestamptz else now() end)
     on conflict (wa_id) do nothing`,
    [m.waId, m.fromMe, sentBy, m.kind, m.body, m.ts, m.key ? JSON.stringify(m.key) : null, source],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Something the bot just sent. */
export async function insertBotMessage(waId: string | null, kind: string, body: string) {
  await q(
    `insert into messages (wa_id, from_me, sent_by, kind, body, ts, source) values ($1, true, 'bot', $2, $3, now(), 'live')
     on conflict (wa_id) do nothing`,
    [waId, kind, body],
  );
}

/** Something that happened in the chat without a WhatsApp message (e.g. a missed call). */
export async function insertSynthetic(kind: string, body: string) {
  await q(
    `insert into messages (wa_id, from_me, sent_by, kind, body, ts, source) values ($1, false, 'human', $2, $3, now(), 'live')`,
    [`synthetic-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, body],
  );
}

export async function isBotMessage(waId: string) {
  const r = await q(`select 1 from messages where wa_id = $1 and sent_by = 'bot'`, [waId]);
  return (r.rowCount ?? 0) > 0;
}

export async function updateBody(waId: string, body: string, kind?: string) {
  const r = await q(`update messages set body = $2, kind = coalesce($3, kind) where wa_id = $1`, [waId, body, kind ?? null]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Her live messages (last 24 h) that arrived after the last thing sent from your number.
 * Imported or synced history is context only: it is never something "to answer".
 */
export async function unanswered(): Promise<Turn[]> {
  const r = await q<Turn>(
    `select * from messages
     where not from_me and kind <> 'reaction' and source = 'live'
       and received_at > now() - interval '24 hours'
       and received_at > coalesce((select max(received_at) from messages where from_me), 'epoch')
     order by received_at, id`,
  );
  return r.rows;
}

export async function recentTurns(limit = 60): Promise<Turn[]> {
  const r = await q<Turn>(
    `select * from (select * from messages where kind <> 'reaction' order by ts desc, id desc limit $1) t order by ts, id`,
    [limit],
  );
  return r.rows;
}

/** Did she write anything (that needs an answer) after t? */
export async function herMessageSince(t: Date) {
  const r = await q(`select 1 from messages where not from_me and kind <> 'reaction' and received_at > $1 limit 1`, [t]);
  return (r.rowCount ?? 0) > 0;
}

/** Did you write to her yourself after t? */
export async function manualMessageSince(t: Date) {
  const r = await q(`select 1 from messages where from_me and sent_by = 'human' and source = 'live' and received_at > $1 limit 1`, [t]);
  return (r.rowCount ?? 0) > 0;
}

export async function lastManualAt(withinMinutes = 60): Promise<Date | null> {
  const r = await q(
    `select max(received_at) as t from messages
     where from_me and sent_by = 'human' and source = 'live' and received_at > now() - make_interval(mins => $1)`,
    [withinMinutes],
  );
  return r.rows[0]?.t ? new Date(r.rows[0].t) : null;
}
