import { claudeBrain } from '../adapters/claude.js';
import { kvGet, kvSet, logEvent, pruneEvents, q } from '../store/db.js';
import { localStamp } from './time.js';

let timer: NodeJS.Timeout | null = null;

/** Once a day: turn the last day's chat into short long-term memories, and tidy old logs. */
export function startMemoryJob() {
  timer = setInterval(() => void maybeRun(), 60 * 60_000);
  setTimeout(() => void maybeRun(), 60_000).unref?.();
}

export function stopMemoryJob() {
  if (timer) clearInterval(timer);
}

async function maybeRun() {
  if (!claudeBrain.ready()) return;
  const last = await kvGet<string | null>('memory_last_run', null);
  if (last && Date.now() - new Date(last).getTime() < 22 * 3600_000) return;
  try {
    await runMemoryExtraction(last ? new Date(last) : new Date(Date.now() - 3 * 86_400_000));
    await pruneEvents(30);
  } catch (e) {
    console.log('[memory] failed:', (e as Error)?.message ?? e);
  }
}

export async function runMemoryExtraction(since: Date) {
  const startedAt = new Date();
  const msgs = await q<{ from_me: boolean; body: string; ts: Date }>(
    `select from_me, body, ts from messages where ts > $1 and kind <> 'reaction' order by ts asc limit 600`,
    [since],
  );
  await q(`delete from memories where expires_at is not null and expires_at < now()`);
  if (msgs.rowCount) {
    const transcript = msgs.rows.map((m) => `[${localStamp(new Date(m.ts))}] ${m.from_me ? 'Yo' : 'Ella'}: ${m.body}`).join('\n');
    const existing = await q<{ fact: string }>(`select fact from memories order by created_at desc limit 150`);
    const facts = await claudeBrain.remember(transcript, existing.rows.map((r) => `- ${r.fact}`).join('\n'));
    for (const f of facts) {
      await q(`insert into memories (fact, expires_at) values ($1, $2)`, [
        f.fact,
        f.expires_in_days ? new Date(Date.now() + f.expires_in_days * 86_400_000) : null,
      ]);
    }
    await logEvent('memories', `${facts.length} new`);
  }
  await kvSet('memory_last_run', startedAt.toISOString());
}
