import { unzipSync, strFromU8 } from 'fflate';
import { fromLocal } from '../core/time.js';
import { pool } from '../store/db.js';
import { kindOf, parseExport } from './parse.js';
import { computeStyle } from './style.js';

/** Accept the .txt or the .zip WhatsApp produces and return the chat text. */
export function readExportFile(filename: string, buf: Buffer): string {
  if (/\.zip$/i.test(filename) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name.endsWith('.txt') });
    const txt = Object.values(files)[0];
    if (!txt) throw new Error('El .zip no tiene un .txt del chat');
    return strFromU8(txt);
  }
  return buf.toString('utf8');
}

export async function importExport(text: string, me?: string) {
  const { lines, senders } = parseExport(text);
  if (!lines.length) throw new Error('No reconocí el formato del chat exportado');
  if (!me) return { needsSender: true as const, senders };
  if (!senders.includes(me)) throw new Error(`"${me}" no aparece en el chat`);

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('begin');
    for (const l of lines) {
      const r = await client.query(
        // Skip anything already there (re-imports, or messages that came in via WhatsApp history sync).
        // received_at = ts: imported history must never look like a new message to answer.
        `insert into messages (from_me, sent_by, kind, body, ts, received_at, source)
         select $1, 'import', $2, $3, $4::timestamptz, $4::timestamptz, 'import'
         where not exists (
           select 1 from messages
           where from_me = $1 and body = $3
             and ts between $4::timestamptz - interval '90 seconds' and $4::timestamptz + interval '90 seconds'
         )
         on conflict do nothing`,
        [l.sender === me, kindOf(l.body), l.body, fromLocal(l.y, l.mo, l.d, l.h, l.mi, l.s)],
      );
      inserted += r.rowCount ?? 0;
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  const style = await computeStyle();
  return { needsSender: false as const, total: lines.length, inserted, style };
}
