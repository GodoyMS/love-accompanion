import pg from 'pg';
import { claudeBrain } from '../adapters/claude.js';
import { realSpeech } from '../adapters/speech.js';
import { wa } from '../adapters/whatsapp/client.js';
import { config } from '../config.js';
import { handleCommand } from '../core/commands.js';
import { conversation } from '../core/conversation.js';
import { dispatcher } from '../core/dispatcher.js';
import { startMemoryJob, stopMemoryJob } from '../core/memory.js';
import { wire } from '../core/ports.js';
import { archiveIfPartnerChanged, logEvent, migrate, pool, sslFor } from '../store/db.js';
import { bringForwardParked, closeInterrupted } from '../store/replies.js';
import { getSettings, migrateSettings } from '../store/settings.js';
import { buildServer } from './server.js';

async function main() {
  await migrate();
  await migrateSettings();
  if (config.partnerNumber) await archiveIfPartnerChanged(config.partnerNumber);

  wire({ messenger: wa, brain: claudeBrain, speech: realSpeech });

  // The panel (and kill switch) come up first, even while we wait for the WhatsApp lock.
  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[boot] panel listening on :${config.port}`);

  // Only one process may hold the WhatsApp session. During a redeploy the new instance
  // waits here until the old one exits, so two sockets never fight over your account.
  const lock = new pg.Client({ connectionString: config.databaseUrl, ssl: sslFor(config.databaseUrl) });
  await lock.connect();
  await lock.query('select pg_advisory_lock(4242001)');
  console.log('[boot] whatsapp lock acquired');

  const interrupted = await closeInterrupted();
  if (interrupted) console.log(`[boot] closed ${interrupted} reply(ies) interrupted by the last shutdown`);

  await wa
    .start({
      onIncoming: (m, raw) => conversation.onIncoming(m, raw),
      onChanged: () => conversation.onChanged(),
      onMissedCall: (v) => conversation.onMissedCall(v),
      onManual: () => conversation.onManual(),
      onCommand: (t) => handleCommand(t),
    })
    .catch((e: Error) => {
      console.log('[wa] start failed:', e?.message ?? e);
      wa.lastStatus = `error al iniciar: ${e?.message ?? e}`;
    });

  dispatcher.start();
  startMemoryJob();
  await logEvent('boot');

  const s = await getSettings();
  console.log(
    `[boot] bot ${s.enabled ? 'ON' : 'OFF'}, sleep hours ${s.quietHours ? s.quietHours.join('-') + 'h' : 'off'}, ` +
      `timing ${s.debounceSec.join('-')}s + ${s.replyDelaySec.join('-')}s, voice replies ${s.voiceReplies ? 'on' : 'off'}`,
  );

  // Once WhatsApp has had a moment to connect: catch up on anything she sent while we were down.
  setTimeout(async () => {
    if (!(await getSettings()).quietHours) {
      const n = await bringForwardParked();
      if (n) console.log(`[boot] brought forward ${n} reply(ies) parked for sleep hours`);
    }
    await conversation.kick('restart', 2);
  }, 15_000).unref?.();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${signal}: finishing the reply in progress…`);
    stopMemoryJob();
    // Let the reply being typed finish instead of cutting it in half (Railway gives us time).
    await Promise.race([dispatcher.stop(), new Promise((r) => setTimeout(r, 50_000))]);
    await wa.stop();
    await app.close();
    await lock.end().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => console.log('[fatal?] unhandled rejection:', (e as Error)?.stack ?? e));

main().catch((e) => {
  console.error('[boot] failed:', e);
  process.exit(1);
});
