import pg from 'pg';
import { config } from './config.js';

export const sslFor = (url: string) =>
  /sslmode=require|supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined;

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5, ssl: sslFor(config.databaseUrl) });

export const q = <T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) =>
  pool.query<T>(text, params);

const SCHEMA = /* sql */ `
create table if not exists messages (
  id           bigserial primary key,
  wa_id        text unique,
  from_me      boolean not null,
  sent_by      text not null default 'human',      -- 'human' | 'bot' | 'import'
  kind         text not null default 'text',       -- text | image | audio | sticker | other
  body         text not null default '',
  ts           timestamptz not null,
  raw_key      jsonb,
  source       text not null default 'live',       -- live | history | import
  search       tsvector generated always as (to_tsvector('spanish', body)) stored
);
create index if not exists messages_ts_idx on messages (ts);
create index if not exists messages_search_idx on messages using gin (search);
create unique index if not exists messages_import_dedupe
  on messages (ts, from_me, md5(body)) where wa_id is null;

create table if not exists pending_replies (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  send_at     timestamptz not null,
  parts       jsonb not null,              -- string[]
  reaction    text,
  react_to    jsonb,                       -- WA message key to react to
  read_keys   jsonb,                       -- keys to mark as read before typing
  status      text not null default 'pending', -- pending | sending | sent | cancelled
  reason      text
);
create index if not exists pending_status_idx on pending_replies (status, send_at);

alter table pending_replies add column if not exists voice bytea;
alter table pending_replies add column if not exists voice_seconds int;
alter table pending_replies add column if not exists voice_waveform bytea;

create table if not exists memories (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  fact        text not null,
  expires_at  timestamptz,
  source      text not null default 'auto'   -- auto | manual
);

create table if not exists kv (
  key    text primary key,
  value  jsonb not null
);

create table if not exists wa_auth (
  key    text primary key,
  value  text not null
);

create table if not exists messages_archive (like messages including defaults);
alter table messages_archive add column if not exists partner text;
alter table messages_archive drop column if exists search;
create table if not exists memories_archive (like memories including defaults);
alter table memories_archive add column if not exists partner text;

create table if not exists events (
  id     bigserial primary key,
  ts     timestamptz not null default now(),
  type   text not null,
  detail text
);
`;

export async function migrate() {
  await pool.query(SCHEMA);
  // Self-heal: drop imported copies of a message that's already there (from WhatsApp itself,
  // or from an earlier import with the same sender, body and time).
  const d = await pool.query(`
    delete from messages a using messages b
    where a.source = 'import' and a.wa_id is null and b.id <> a.id
      and b.from_me = a.from_me and b.body = a.body
      and b.ts between a.ts - interval '90 seconds' and a.ts + interval '90 seconds'
      and (b.wa_id is not null or b.id < a.id)`);
  if (d.rowCount) console.log(`[db] removed ${d.rowCount} duplicated imported message(s)`);
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
    const client = await pool.connect();
    try {
      await client.query('begin');
      const cols = `id, wa_id, from_me, sent_by, kind, body, ts, raw_key, source`;
      await client.query(`insert into messages_archive (${cols}, partner) select ${cols}, $1 from messages`, [prev ?? 'unknown']);
      await client.query(`insert into memories_archive (id, created_at, fact, expires_at, source, partner)
                          select id, created_at, fact, expires_at, source, $1 from memories`, [prev ?? 'unknown']);
      await client.query(`delete from messages`);
      await client.query(`delete from memories`);
      await client.query(`update pending_replies set status = 'cancelled', reason = 'partner changed' where status = 'pending'`);
      await client.query(`delete from kv where key in ('style', 'memory_last_run')`);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
  await kvSet('active_partner', partner);
  await logEvent('partner_changed', `${prev ?? '—'} → ${partner}`);
  return prev;
}

// ---------- key/value helpers ----------
export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const r = await q('select value from kv where key = $1', [key]);
  return r.rowCount ? (r.rows[0].value as T) : fallback;
}

export async function kvSet(key: string, value: unknown) {
  await q(
    `insert into kv (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

export async function logEvent(type: string, detail?: string) {
  await q('insert into events (type, detail) values ($1, $2)', [type, detail ?? null]).catch(() => {});
}
