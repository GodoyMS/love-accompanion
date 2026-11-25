import pg from 'pg';
import { config } from '../config.js';

export const sslFor = (url: string) =>
  /sslmode=require|supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined;

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, ssl: sslFor(config.databaseUrl) });

export const q = <T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => pool.query<T>(text, params);

/** Run fn inside a transaction. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Idempotent schema. Every statement is safe to run on every boot.
 *
 * Time columns:
 * - messages.ts          when the message was written (WhatsApp's timestamp) → conversation order
 * - messages.received_at when THIS server saw it (DB clock) → "who spoke last" and staleness checks,
 *                        so a phone clock a second off can never make a message look answered.
 */
const SCHEMA = /* sql */ `
create table if not exists messages (
  id           bigserial primary key,
  wa_id        text unique,
  from_me      boolean not null,
  sent_by      text not null default 'human',      -- human | bot | import
  kind         text not null default 'text',
  body         text not null default '',
  ts           timestamptz not null,
  raw_key      jsonb,
  source       text not null default 'live',       -- live | history | import
  search       tsvector generated always as (to_tsvector('spanish', body)) stored
);
alter table messages add column if not exists received_at timestamptz;
update messages set received_at = ts where received_at is null;
alter table messages alter column received_at set default now();
alter table messages alter column received_at set not null;
create index if not exists messages_ts_idx on messages (ts);
create index if not exists messages_received_idx on messages (received_at);
create index if not exists messages_search_idx on messages using gin (search);
create unique index if not exists messages_import_dedupe on messages (ts, from_me, md5(body)) where wa_id is null;

create table if not exists pending_replies (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  send_at     timestamptz not null,
  parts       jsonb not null,
  reaction    text,
  react_to    jsonb,
  read_keys   jsonb,
  status      text not null default 'pending', -- pending | sending | sent | cancelled | failed
  reason      text
);
alter table pending_replies add column if not exists voice bytea;
alter table pending_replies add column if not exists voice_seconds int;
alter table pending_replies add column if not exists voice_waveform bytea;
alter table pending_replies add column if not exists kind text;
alter table pending_replies add column if not exists attempts int not null default 0;
update pending_replies set kind = case
    when reason = 'disclose' then 'disclose'
    when voice is not null then 'voice'
    when reaction is not null then 'react'
    else 'reply' end
  where kind is null;
alter table pending_replies alter column kind set default 'reply';
alter table pending_replies alter column kind set not null;
create index if not exists pending_status_idx on pending_replies (status, send_at);

create table if not exists memories (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  fact        text not null,
  expires_at  timestamptz,
  source      text not null default 'auto'
);

create table if not exists kv (key text primary key, value jsonb not null);
create table if not exists wa_auth (key text primary key, value text not null);

create table if not exists messages_archive (like messages including defaults);
alter table messages_archive add column if not exists partner text;
alter table messages_archive add column if not exists received_at timestamptz;
alter table messages_archive drop column if exists search;
create table if not exists memories_archive (like memories including defaults);
alter table memories_archive add column if not exists partner text;

create table if not exists events (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  type   text not null,
  detail text
);
create index if not exists events_ts_idx on events (ts);
`;

export async function migrate() {
  // Serialize concurrent boots (overlapping deploys) so DDL never races.
  await tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(4242002)');
    await c.query(SCHEMA);
  });
}

// ---------- key/value ----------
export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const r = await q('select value from kv where key = $1', [key]);
  return r.rowCount ? (r.rows[0].value as T) : fallback;
}

export async function kvSet(key: string, value: unknown) {
  await q(
    `insert into kv (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

// ---------- audit trail ----------
export async function logEvent(type: string, detail?: string) {
  await q('insert into events (type, detail) values ($1, $2)', [type, detail ?? null]).catch(() => {});
}

export async function pruneEvents(days = 30) {
  await q(`delete from events where ts < now() - make_interval(days => $1)`, [days]);
}

/**
 * When PARTNER_NUMBER changes (e.g. from a test number to the real one), archive the
 * previous conversation, memories and measured style so they never mix with the new chat.
 */
export async function archiveIfPartnerChanged(partner: string) {
  const prev = await kvGet<string | null>('active_partner', null);
  if (prev === partner) return null;
  // First time a number is set: keep whatever is there (e.g. a chat imported before configuring).
  if (prev !== null) {
    await tx(async (c) => {
      const cols = `id, wa_id, from_me, sent_by, kind, body, ts, received_at, raw_key, source`;
      await c.query(`insert into messages_archive (${cols}, partner) select ${cols}, $1 from messages`, [prev]);
      await c.query(
        `insert into memories_archive (id, created_at, fact, expires_at, source, partner)
         select id, created_at, fact, expires_at, source, $1 from memories`,
        [prev],
      );
      await c.query(`delete from messages`);
      await c.query(`delete from memories`);
      await c.query(`update pending_replies set status = 'cancelled', reason = 'partner changed' where status = 'pending'`);
      await c.query(`delete from kv where key in ('style', 'memory_last_run', 'disclosed_at', 'partner_lid')`);
    });
  }
  await kvSet('active_partner', partner);
  await logEvent('partner_changed', `${prev ?? '—'} → ${partner}`);
  return prev;
}
