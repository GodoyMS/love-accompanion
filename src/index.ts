import pg from 'pg';
import { config } from './config.js';
import { archiveIfPartnerChanged, logEvent, migrate, sslFor } from './db.js';
import { startMemoryJob } from './engine/memory.js';
import { onManualReply, onPartnerMessage, onSelfCommand, resumeOnBoot } from './engine/pipeline.js';
import { recoverStuck, startSender } from './engine/sender.js';
import { buildServer } from './server.js';
import { wa } from './wa/client.js';

async function main() {
  await migrate();
  if (config.partnerNumber) await archiveIfPartnerChanged(config.partnerNumber);

  // The panel (and kill switch) come up first, even while we wait for the WhatsApp lock.
  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`panel listening on :${config.port}`);

  // Only one process may hold the WhatsApp session. During a redeploy the new instance
  // waits here until the old one exits, so two sockets never fight over your account.
  const lockClient = new pg.Client({
    connectionString: config.databaseUrl,
    ssl: sslFor(config.databaseUrl),
  });
  await lockClient.connect();
  await lockClient.query('select pg_advisory_lock(4242001)');
  console.log('whatsapp lock acquired');

  await recoverStuck();
  await wa.start({ onPartnerMessage, onManualReply, onSelfCommand }).catch((e) => {
    console.log('[wa] start failed:', e?.message ?? e);
    wa.lastStatus = `error al iniciar: ${e?.message ?? e}`;
  });
  startSender();
  startMemoryJob();
  setTimeout(() => void resumeOnBoot(), 30_000);
  await logEvent('boot');

  const shutdown = async () => {
    await wa.stop();
    await app.close();
    await lockClient.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
