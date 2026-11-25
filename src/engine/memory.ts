import pino from 'pino';
import { config } from '../config.js';
import { kvGet, kvSet, logEvent, q } from '../db.js';
import { localStamp } from '../time.js';
import { extractMemories, llmReady } from './llm.js';

const log = pino({ level: config.logLevel });

/** Once a day, turn the last day's chat into short long-term memories. */
export function startMemoryJob() {
  setInterval(() => void maybeRun(), 60 * 60_000);
  setTimeout(() => void maybeRun(), 60_000);
}

async function maybeRun() {
  if (!llmReady()) return;
  const last = await kvGet<string | null>('memory_last_run', null);
  if (last && Date.now() - new Date(last).getTime() < 22 * 3600_000) return;
  try {
    await runMemoryExtraction(last ? new Date(last) : new Date(Date.now() - 3 * 86_400_000));
  } catch (e) {
    console.log('[memory] failed:', (e as Error)?.message ?? e);
  }
}

export async function runMemoryExtraction(since: Date) {
  const startedAt = new Date();
  const msgs = await q<{ from_me: boolean; body: string; ts: Date }>(
    `select from_me, body, ts from messages
     where ts > $1 and kind <> 'reaction' order by ts asc limit 600`,
    [since],
  );
  await q(`delete from memories where expires_at is not null and expires_at < now()`);
  if (msgs.rowCount) {
    const transcript = msgs.rows
      .map((m) => `[${localStamp(new Date(m.ts))}] ${m.from_me ? 'Yo' : 'Ella'}: ${m.body}`)
      .join('\n');
    const existing = await q<{ fact: string }>(`select fact from memories order by created_at desc limit 150`);
    const facts = await extractMemories(transcript, existing.rows.map((r) => `- ${r.fact}`).join('\n'));
    for (const f of facts) {
      await q(
        `insert into memories (fact, expires_at) values ($1, $2)`,
        [f.fact, f.expires_in_days ? new Date(Date.now() + f.expires_in_days * 86_400_000) : null],
      );
    }
    await logEvent('memories', `${facts.length} new`);
  }
  await kvSet('memory_last_run', startedAt.toISOString());
}
