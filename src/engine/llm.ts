import Anthropic from '@anthropic-ai/sdk';
import { config, missingConfig } from '../config.js';
import { localStamp } from '../time.js';
import type { buildContext } from './context.js';

let client: Anthropic | null = null;
const anthropic = {
  get messages() {
    if (!config.anthropicKey) throw new Error('ANTHROPIC_API_KEY no está configurada');
    client ??= new Anthropic({ apiKey: config.anthropicKey });
    return client.messages;
  },
};
export const llmReady = () => !missingConfig.includes('ANTHROPIC_API_KEY');

export type Decision =
  | { action: 'reply'; messages: string[] }
  | { action: 'react'; reaction: string }
  | { action: 'wait' }
  | { action: 'handoff'; reason: string };

const RULES = `Eres el "yo" de esta conversación de WhatsApp: escribes como yo le escribo a mi enamorada, en primera persona, desde mi número.

Cómo escribir:
- Copia mi forma real de escribir (largo, mayúsculas, puntuación, emojis, risas, muletillas). Mira el transcript y los ejemplos: eso manda más que cualquier regla de estilo genérica.
- Mensajes cortos de chat, no párrafos. Si yo suelo mandar varios mensajes seguidos, divide la respuesta en 1 a 3 mensajes.
- Muestra interés genuino por lo que ella cuenta: pregunta por detalles concretos, recuerda lo que dijo antes (memorias y transcript) y retómalo.
- Ella hace muchas cosas a la vez y a veces se dispersa: acompáñala con calidez, celebra lo que logra, ayúdala a aterrizar una cosa a la vez si lo pide, sin sermones ni listas.
- Nunca inventes hechos sobre mí (dónde estoy, qué hice, con quién) que no estén en el perfil, memorias o transcript. Si no sabes, mantente vago o pregunta por ella.
- Nunca menciones que eres una IA, un bot o un asistente, ni hables de "contexto", "perfil" o "memorias".

Usa "handoff" (no respondas tú) cuando:
- Ella está molesta conmigo, es una discusión o un reclamo.
- Salud, emergencias, duelo, crisis o algo emocionalmente fuerte.
- Hay que comprometerse a algo: planes con fecha u hora, dinero, promesas, decisiones.
- Me pide llamar, verla, o algo que yo tendría que hacer en persona.
- Pregunta si es un bot, una IA o si de verdad soy yo.
- Manda una nota de voz o algo que no puedes ver/entender.
- No tienes cómo responder sin inventar.

Usa "react" para mensajes que solo piden un gesto (un "te quiero", una foto bonita, un "llegué"), con un solo emoji que yo usaría.
Usa "wait" si la conversación ya cerró naturalmente (ej. "ok", "buenas noches" después de que ya me despedí).`;

/** Structured output: the model must answer with exactly this JSON shape. */
const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'messages', 'reaction', 'reason'],
  properties: {
    action: { type: 'string', enum: ['reply', 'react', 'wait', 'handoff'] },
    messages: {
      type: 'array',
      items: { type: 'string' },
      description: 'Si action=reply: 1 a 3 mensajes, en orden, tal cual se envían. Si no, lista vacía.',
    },
    reaction: { type: 'string', description: 'Si action=react: un emoji. Si no, vacío.' },
    reason: { type: 'string', description: 'Si action=handoff: por qué, en una línea, para mí. Si no, vacío.' },
  },
};

/** Call Claude and parse its JSON answer. */
async function askJson<T>(params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'output_config'>, schema: object): Promise<T> {
  const res = await anthropic.messages.create({
    ...params,
    output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return JSON.parse(text) as T;
}

export async function decide(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  images: { data: string; mediaType: string }[],
  hint?: string,
): Promise<Decision> {
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: RULES },
    {
      type: 'text',
      text: `# Perfil (escrito por mí)\n${ctx.profile}\n\n# Mi estilo (medido de mis mensajes reales)\n${ctx.styleText}\n\n# Muestras de cómo escribo yo\n${ctx.voiceText}`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: `# Memorias recientes sobre ella y nosotros\n${ctx.memoriesText}\n\n# Situaciones parecidas y cómo respondí de verdad\n${ctx.examplesText}`,
    },
  ];

  const newMsgs = ctx.pending.map((p) => `- ${p.body}`).join('\n');
  const content: Anthropic.ContentBlockParam[] = [
    ...images.map(
      (img): Anthropic.ImageBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType as any, data: img.data },
      }),
    ),
    {
      type: 'text',
      text: `Ahora es ${localStamp(new Date())}.\n\n# Conversación reciente\n${ctx.transcript}\n\n# Mensajes nuevos de ella que debo responder\n${newMsgs}${hint ? `\n\nNota: ${hint}` : ''}\n\nDecide qué hacer y responde con el JSON pedido.`,
    },
  ];

  const input = await askJson<any>(
    { model: config.model, max_tokens: 800, system, messages: [{ role: 'user', content }] },
    DECISION_SCHEMA,
  );
  switch (input.action) {
    case 'reply': {
      const msgs = (input.messages ?? []).map((m: string) => String(m).trim()).filter(Boolean).slice(0, 3);
      return msgs.length ? { action: 'reply', messages: msgs } : { action: 'handoff', reason: 'respuesta vacía' };
    }
    case 'react':
      return input.reaction ? { action: 'react', reaction: String(input.reaction).trim() } : { action: 'wait' };
    case 'wait':
      return { action: 'wait' };
    default:
      return { action: 'handoff', reason: String(input.reason ?? 'sin motivo') };
  }
}

/** Pull durable facts out of recent chat for long-term memory. */
export async function extractMemories(transcript: string, existing: string): Promise<{ fact: string; expires_in_days?: number }[]> {
  const out = await askJson<{ facts: { fact: string; expires_in_days: number }[] }>(
    {
      model: config.fastModel,
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: `De esta conversación entre "Yo" y "Ella" (mi enamorada), extrae hechos nuevos que me sirvan para acompañarla después: lo que está haciendo, planes, pendientes, cómo le fue en algo, gustos, nombres de gente o lugares que mencionó, cómo se siente con algo. Frases cortas, en tercera persona ("Ella tiene examen de X el jueves"). En expires_in_days pon cuántos días sigue siendo útil si es algo temporal (un examen el jueves = 3) o 0 si es duradero. No repitas lo que ya está en memorias existentes. Si no hay nada nuevo, devuelve una lista vacía.\n\n# Memorias existentes\n${existing}\n\n# Conversación\n${transcript}`,
        },
      ],
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['facts'],
      properties: {
        facts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['fact', 'expires_in_days'],
            properties: { fact: { type: 'string' }, expires_in_days: { type: 'number' } },
          },
        },
      },
    },
  );
  return (out.facts ?? [])
    .filter((f) => f?.fact)
    .map((f) => ({ fact: f.fact, expires_in_days: f.expires_in_days > 0 ? f.expires_in_days : undefined }));
}
