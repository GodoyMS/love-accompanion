import { q, tx } from './db.js';

export type ReplyKind = 'reply' | 'voice' | 'react' | 'disclose';
export type ReplyStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';

export interface Reply {
  id: number;
  created_at: Date;
  send_at: Date;
  kind: ReplyKind;
  parts: string[];
  reaction: string | null;
  react_to: any;
  read_keys: any[] | null;
  voice: Buffer | null;
  voice_seconds: number | null;
  voice_waveform: Buffer | null;
  status: ReplyStatus;
  attempts: number;
  reason: string | null;
}

export interface NewReply {
  kind: ReplyKind;
  sendAt: Date;
  parts?: string[];
  readKeys?: unknown[];
  reaction?: string;
  reactTo?: unknown;
  voice?: { ogg: Buffer; seconds: number; waveform: Uint8Array };
}

export async function enqueue(r: NewReply): Promise<number> {
  const res = await q<{ id: number }>(
    `insert into pending_replies (kind, send_at, parts, read_keys, reaction, react_to, voice, voice_seconds, voice_waveform)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      r.kind,
      r.sendAt,
      JSON.stringify(r.parts ?? []),
      JSON.stringify(r.readKeys ?? []),
      r.reaction ?? null,
      r.reactTo ? JSON.stringify(r.reactTo) : null,
      r.voice?.ogg ?? null,
      r.voice?.seconds ?? null,
      r.voice ? Buffer.from(r.voice.waveform) : null,
    ],
  );
  return Number(res.rows[0].id);
}

/** Cancel everything not yet started. Returns how many. */
export async function cancelPending(reason: string): Promise<number> {
  const r = await q(`update pending_replies set status = 'cancelled', reason = $1 where status = 'pending'`, [reason]);
  return r.rowCount ?? 0;
}

export async function cancelOne(id: number, reason: string) {
  await q(`update pending_replies set status = 'cancelled', reason = $2 where id = $1 and status = 'pending'`, [id, reason]);
}

export async function sendNow(id: number) {
  await q(`update pending_replies set send_at = now() where id = $1 and status = 'pending'`, [id]);
}

/** Atomically take the next due reply, so it can never be sent twice. */
export async function claimDue(): Promise<Reply | null> {
  return tx(async (c) => {
    const r = await c.query<Reply>(
      `select * from pending_replies where status = 'pending' and send_at <= now()
       order by send_at, id limit 1 for update skip locked`,
    );
    if (!r.rowCount) return null;
    await c.query(`update pending_replies set status = 'sending', attempts = attempts + 1 where id = $1`, [r.rows[0].id]);
    return { ...r.rows[0], id: Number(r.rows[0].id), attempts: r.rows[0].attempts + 1 };
  });
}

export async function finish(id: number, status: 'sent' | 'cancelled' | 'failed', reason?: string) {
  await q(`update pending_replies set status = $2, reason = $3 where id = $1`, [id, status, reason ?? null]);
}

/** Nothing was delivered yet: put it back to try again a bit later. */
export async function retryLater(id: number, seconds: number, reason: string) {
  await q(
    `update pending_replies set status = 'pending', send_at = now() + make_interval(secs => $2), reason = $3 where id = $1`,
    [id, seconds, reason],
  );
}

export async function listPending() {
  const r = await q(
    `select id, kind, send_at, parts, reaction, voice is not null as is_voice
     from pending_replies where status = 'pending' order by send_at, id`,
  );
  return r.rows;
}

export async function countPending() {
  const r = await q<{ n: number }>(`select count(*)::int n from pending_replies where status in ('pending', 'sending')`);
  return r.rows[0].n;
}

/** After a crash mid-send we can't know what reached her: never resend, just close it. */
export async function closeInterrupted() {
  const r = await q(`update pending_replies set status = 'cancelled', reason = 'interrupted by restart' where status = 'sending'`);
  return r.rowCount ?? 0;
}

/** Replies parked far in the future (old sleep-hours) come forward when sleep hours are off. */
export async function bringForwardParked(): Promise<number> {
  const r = await q(
    `update pending_replies set send_at = now() + interval '5 seconds' + random() * interval '30 seconds'
     where status = 'pending' and send_at > now() + interval '10 minutes'`,
  );
  return r.rowCount ?? 0;
}
