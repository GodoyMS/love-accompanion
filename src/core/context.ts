import type { StyleProfile } from '../importer/style.js';
import { kvGet, q } from '../store/db.js';
import { recentTurns, unanswered } from '../store/messages.js';
import type { Context } from './ports.js';
import { localStamp } from './time.js';

export const DEFAULT_PROFILE = `# Quién soy yo
- Nombre:
- Cómo me dice ella:
- A qué me dedico / mi rutina:

# Quién es ella
- Nombre:
- Cómo le digo yo:
- A qué se dedica, sus proyectos y rutinas:
- Cosas que le gustan:
- Cosas que no le gustan / temas a evitar:
- Cómo apoyarla cuando está dispersa o abrumada:

# Nosotros
- Desde cuándo estamos juntos:
- Fechas importantes:
- Bromas internas, palabras nuestras:
- Planes que tenemos:

# Reglas extra para el bot
-
`;

/** Past situations similar to the current one, with how you actually answered. */
async function fewShot(query: string, excludeAfter: Date, n = 6) {
  if (!query.trim()) return [];
  const r = await q<{ her: string; me: string }>(
    `with matches as (
       select distinct on (body) id, ts, body,
              ts_rank(search, websearch_to_tsquery('spanish', $1)) as rank
       from messages
       where not from_me and kind = 'text' and ts < $2::timestamptz - interval '1 day'
         and search @@ websearch_to_tsquery('spanish', $1)
       order by body, ts desc
     ),
     hits as (select id, ts, body from matches order by rank desc, ts desc limit $3)
     select h.body as her, string_agg(r.body, E'\\n' order by r.ts) as me
     from hits h
     join lateral (
       select body, ts from messages m
       where m.from_me and m.kind = 'text' and m.ts > h.ts and m.ts < h.ts + interval '2 hours'
         and m.ts < coalesce((select min(ts) from messages x where not x.from_me and x.ts > h.ts and x.id <> h.id), 'infinity')
       order by m.ts limit 4
     ) r on true
     group by h.id, h.body`,
    [orQuery(query), excludeAfter, n],
  );
  return r.rows;
}

/** Turn free text into an OR query so short chats still find matches. */
function orQuery(text: string) {
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .match(/[a-zñ]{4,}/g);
  return [...new Set(words ?? [])].slice(0, 12).join(' or ');
}

/** Random sample of your own messages, to anchor tone even when search finds nothing. */
async function myVoiceSample(n = 25) {
  const r = await q<{ body: string }>(
    `select body from messages
     where from_me and kind = 'text' and sent_by <> 'bot' and length(body) between 2 and 200
     order by random() limit $1`,
    [n],
  );
  return r.rows.map((x) => x.body);
}

/** Everything Claude needs to answer her unanswered messages. */
export async function buildContext(): Promise<Context> {
  const [profile, style, memories, recent, pending] = await Promise.all([
    kvGet<string>('profile', DEFAULT_PROFILE),
    kvGet<StyleProfile | null>('style', null),
    q<{ fact: string; created_at: Date }>(
      `select fact, created_at from memories
       where expires_at is null or expires_at > now()
       order by created_at desc limit 120`,
    ),
    recentTurns(),
    unanswered(),
  ]);
  const lastText = pending.map((p) => p.body).join(' ');
  const [examples, voice] = await Promise.all([
    fewShot(lastText, pending[0]?.ts ?? new Date()),
    myVoiceSample(),
  ]);

  const transcript = recent
    .map((t) => `[${localStamp(new Date(t.ts))}] ${t.from_me ? 'Yo' : 'Ella'}: ${t.body}`)
    .join('\n');

  return {
    profile,
    styleText: style ? describeStyle(style) : 'Aún no hay historial importado: escribe corto y natural.',
    memoriesText: memories.rows.length
      ? memories.rows.map((m) => `- (${localStamp(new Date(m.created_at))}) ${m.fact}`).join('\n')
      : '(sin memorias todavía)',
    examplesText: examples.length
      ? examples.map((e) => `Ella: ${e.her}\nYo: ${e.me}`).join('\n---\n')
      : '(sin ejemplos parecidos)',
    voiceText: voice.length ? voice.map((v) => `- ${v}`).join('\n') : '(sin muestras)',
    transcript,
    pending,
  };
}

export function describeStyle(s: StyleProfile): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `- Largo típico de cada mensaje: ~${s.medianChars} caracteres (mediana). Rara vez más de ${s.p90Chars}.`,
    `- Mensajes seguidos por respuesta: normalmente ${s.avgBurst.toFixed(1)}.`,
    `- Empieza con mayúscula: ${pct(s.capitalStart)} de las veces.`,
    `- Termina con punto: ${pct(s.endsWithPeriod)}. Usa signos de apertura (¿¡): ${pct(s.openingMarks)}.`,
    `- Mensajes con emoji: ${pct(s.emojiRate)}. Emojis favoritos: ${s.topEmojis.join(' ') || 'ninguno'}.`,
    `- Risa: ${s.laughs.join(', ') || 'no aplica'}.`,
    `- Palabras/expresiones frecuentes: ${s.topWords.join(', ')}.`,
  ].join('\n');
}
