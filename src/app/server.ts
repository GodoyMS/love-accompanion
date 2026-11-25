import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { sttProvider } from '../adapters/stt.js';
import { speakable, tts, voiceReady } from '../adapters/voice.js';
import { wa } from '../adapters/whatsapp/client.js';
import { config, missingConfig } from '../config.js';
import { DEFAULT_PROFILE, describeStyle } from '../core/context.js';
import { runMemoryExtraction } from '../core/memory.js';
import { importExport, readExportFile } from '../importer/import.js';
import { computeStyle, type StyleProfile } from '../importer/style.js';
import { kvGet, kvSet, q } from '../store/db.js';
import * as replies from '../store/replies.js';
import { getSettings, isPaused, normalizeSettings, pauseFor, resume, setEnabled, updateSettings, type Settings } from '../store/settings.js';

const COOKIE = 'la_session';
const sign = (v: string) => createHmac('sha256', config.sessionSecret).update(v).digest('hex');

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = req.cookies[COOKIE];
  const [exp, mac] = (token ?? '').split('.');
  if (!exp || !mac || !safeEqual(mac, sign(exp)) || Number(exp) < Date.now()) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

export async function buildServer() {
  const app = Fastify({ logger: { level: config.logLevel === 'debug' ? 'info' : 'warn' }, trustProxy: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.get('/healthz', async () => ({ ok: true }));

  // ---------- auth ----------
  // Per-IP throttle: a stranger guessing can't lock you out of your own panel.
  const attempts = new Map<string, { n: number; until: number }>();
  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    const now = Date.now();
    const a = attempts.get(req.ip);
    if (a && a.until > now && a.n >= 10) {
      return reply.code(429).send({ error: 'Demasiados intentos. Espera 15 minutos.' });
    }
    if (!safeEqual(String(req.body?.password ?? ''), config.adminPassword)) {
      const prev = a && a.until > now ? a.n : 0;
      attempts.set(req.ip, { n: prev + 1, until: now + 15 * 60_000 });
      await new Promise((r) => setTimeout(r, 800));
      return reply.code(401).send({ error: 'contraseña incorrecta' });
    }
    attempts.delete(req.ip);
    const exp = String(Date.now() + 30 * 86_400_000);
    reply.setCookie(COOKIE, `${exp}.${sign(exp)}`, {
      httpOnly: true, sameSite: 'strict', secure: req.protocol === 'https', path: '/', maxAge: 30 * 86_400,
    });
    return { ok: true };
  });
  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---------- everything below requires login ----------
  app.register(async (api) => {
    api.addHook('preHandler', requireAuth);

    api.get('/api/status', async () => {
      const s = await getSettings();
      const [pending, counts, events] = await Promise.all([
        replies.listPending(),
        q(`select count(*)::int total,
                  count(*) filter (where sent_by = 'bot')::int by_bot,
                  min(ts) first_ts
           from messages`),
        q(`select ts, type, detail from events order by ts desc limit 30`),
      ]);
      return {
        settings: s,
        paused: isPaused(s),
        wa: { connected: wa.connected, me: wa.me.pn, qr: wa.qrDataUrl, status: wa.lastStatus },
        partner: config.partnerNumber ? `+${config.partnerNumber}` : null,
        missing: missingConfig,
        stt: sttProvider(),
        voice: voiceReady(),
        pending,
        counts: counts.rows[0],
        events: events.rows,
      };
    });

    api.post<{ Body: { enabled: boolean } }>('/api/switch', async (req) => {
      await setEnabled(!!req.body.enabled, 'panel');
      return getSettings();
    });

    api.post<{ Body: { minutes: number } }>('/api/pause', async (req) => {
      await pauseFor(Math.min(7 * 24 * 60, Math.max(1, Math.round(Number(req.body?.minutes)) || 60)), 'panel');
      return getSettings();
    });

    api.post('/api/resume', async () => {
      await resume('panel');
      return getSettings();
    });

    const idParam = (id: string) => {
      const n = Number(id);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    api.delete<{ Params: { id: string } }>('/api/pending/:id', async (req, reply) => {
      const id = idParam(req.params.id);
      if (!id) return reply.code(400).send({ error: 'id inválido' });
      await replies.cancelOne(id, 'panel');
      return { ok: true };
    });
    api.delete('/api/pending', async () => ({ cancelled: await replies.cancelPending('panel') }));
    api.post<{ Params: { id: string } }>('/api/pending/:id/now', async (req, reply) => {
      const id = idParam(req.params.id);
      if (!id) return reply.code(400).send({ error: 'id inválido' });
      await replies.sendNow(id);
      return { ok: true };
    });

    // Only preferences here; on/off and pause have their own endpoints (and audit trail).
    api.put<{ Body: Partial<Settings> }>('/api/settings', async (req) => {
      const { enabled: _e, pausedUntil: _p, ...rest } = (req.body ?? {}) as Partial<Settings>;
      return updateSettings(rest);
    });

    api.get<{ Querystring: { before?: string } }>('/api/messages', async (req) => {
      const r = await q(
        `select id, from_me, sent_by, kind, body, ts from messages
         where ($1::timestamptz is null or ts < $1) order by ts desc limit 100`,
        [req.query.before ?? null],
      );
      return r.rows.reverse();
    });

    api.get('/api/profile', async () => {
      const style = await kvGet<StyleProfile | null>('style', null);
      return {
        profile: await kvGet('profile', DEFAULT_PROFILE),
        style,
        styleText: style ? describeStyle(style) : null,
      };
    });
    api.put<{ Body: { profile: string } }>('/api/profile', async (req) => {
      await kvSet('profile', String(req.body?.profile ?? '').slice(0, 20_000));
      return { ok: true };
    });
    api.post('/api/style/recompute', async () => {
      const style = await computeStyle();
      return { style, styleText: style ? describeStyle(style) : null };
    });

    api.get('/api/memories', async () =>
      (await q(`select * from memories where expires_at is null or expires_at > now() order by created_at desc`)).rows,
    );
    api.post<{ Body: { fact: string } }>('/api/memories', async (req, reply) => {
      const fact = String(req.body?.fact ?? '').trim().slice(0, 500);
      if (!fact) return reply.code(400).send({ error: 'vacío' });
      await q(`insert into memories (fact, source) values ($1, 'manual')`, [fact]);
      return { ok: true };
    });
    api.delete<{ Params: { id: string } }>('/api/memories/:id', async (req) => {
      await q(`delete from memories where id = $1`, [req.params.id]);
      return { ok: true };
    });
    api.post('/api/memories/extract', async () => {
      await runMemoryExtraction(new Date(Date.now() - 7 * 86_400_000));
      return { ok: true };
    });

    api.post('/api/import', async (req, reply) => {
      let me: string | undefined;
      let text: string | null = null;
      for await (const part of req.parts()) {
        if (part.type === 'file') text = readExportFile(part.filename, await part.toBuffer());
        else if (part.fieldname === 'me') me = String(part.value) || undefined;
      }
      if (!text) return reply.code(400).send({ error: 'Falta el archivo' });
      try {
        return await importExport(text, me);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    });

    // Listen to your voice with the current (or unsaved) tuning, without sending anything to her.
    api.post<{ Body: { text?: string; voice?: Settings['voice'] } }>('/api/voice/preview', async (req, reply) => {
      if (!voiceReady()) return reply.code(400).send({ error: 'Falta ELEVENLABS_API_KEY o ELEVENLABS_VOICE_ID' });
      const text = speakable(String(req.body?.text || 'Hola amor, ¿cómo estás? Aquí estoy, tranquilo, pensando en ti.')).slice(0, 400);
      try {
        const s = await getSettings();
        const tuning = req.body?.voice ? normalizeSettings({ ...s, voice: req.body.voice }, s).voice : s.voice;
        const mp3 = await tts(text, tuning);
        return reply.type('audio/mpeg').send(mp3);
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    });

    api.post('/api/wa/unlink', async () => {
      await setEnabled(false, 'unlink');
      await wa.logout();
      return { ok: true };
    });
  });

  // ---------- panel (built React app) ----------
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = [join(here, '../web/dist'), join(here, '../../web/dist')].find(existsSync);
  if (webDist) {
    await app.register(fstatic, { root: webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }

  return app;
}
