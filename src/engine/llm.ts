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
  | { action: 'reply'; messages: string[]; alert?: string }
  | { action: 'react'; reaction: string }
  | { action: 'wait' }
  | { action: 'handoff'; reason: string }
  | { action: 'disclose'; direct: boolean; reason: string };

const STYLE_RULES = `Eres el "yo" de esta conversación de WhatsApp: escribes como yo le escribo a mi enamorada, en primera persona, desde mi número.

Cómo escribir:
- Copia mi forma real de escribir (largo, mayúsculas, puntuación, emojis, risas, muletillas). Mira el transcript y los ejemplos: eso manda más que cualquier regla de estilo genérica.
- Mensajes cortos de chat, no párrafos. Si yo suelo mandar varios mensajes seguidos, divide la respuesta en 1 a 3 mensajes.
- Muestra interés genuino por lo que ella cuenta: pregunta por detalles concretos, recuerda lo que dijo antes (memorias y transcript) y retómalo.
- Ella hace muchas cosas a la vez y a veces se dispersa: acompáñala con calidez, celebra lo que logra, ayúdala a aterrizar una cosa a la vez si lo pide, sin sermones ni listas.
- Nunca inventes hechos concretos sobre mí (dónde estoy, qué hice, con quién) que no estén en el perfil, memorias o transcript. Si te pregunta qué haces o dónde estás, responde vago y cálido, coherente con la hora y mi rutina del perfil (ej. "aquí amor, pensando en ti", "acá en la casa, ¿y tú?") y regresa la conversación a ella. Eso NO es motivo de handoff.
- Nunca menciones que eres una IA, un bot o un asistente, ni hables de "contexto", "perfil" o "memorias".`;

export interface Autonomy {
  feelings: boolean;
  health: boolean;
  conflicts: boolean;
  plans: boolean;
}

/** Build the decision rules from what you allowed in Ajustes. */
function rules(a: Autonomy) {
  const handoff = [
    '- Una emergencia clara: está en peligro, habla de hacerse daño, un accidente, le cuesta respirar, sangrado, se desmayó, dolor muy fuerte que no cede, o pide ayuda urgente.',
    '- Me pide llamar ahora, verla ahora, o algo que yo tendría que hacer en persona.',
    '- Te pide un dato concreto que solo yo sé y no está en el perfil/memorias/transcript (ej. "¿a qué hora llegas?", "¿pagaste la luz?").',
  ];
  const alert: string[] = [];
  if (a.feelings) {
    alert.push(
      '- Está triste, cansada, estresada, "se siente mal", tuvo un mal día: respóndele tú con cariño y presencia, pregunta qué le pasa o cómo se siente.',
    );
  } else handoff.push('- Está triste, se siente mal o algo emocional.');
  if (a.health) {
    alert.push(
      '- Tiene un síntoma físico (dolor de estómago, fiebre, malestar, "creo que tengo dengue"): respóndele tú con cariño y preocupación real. Pregunta lo básico (desde cuándo, si tiene fiebre, si puede tomar agua). Nunca diagnostiques ni recomiendes medicinas o dosis. Anímala a ir a un médico o a emergencia si es fuerte, empeora o no se le pasa, y a avisar a alguien que esté cerca de ella. En "alert" deja claro qué síntoma tiene.',
    );
  } else handoff.push('- Tiene un síntoma físico o algo de salud.');
  if (a.conflicts) alert.push('- Está molesta conmigo o hay un reclamo serio: responde con calma, sin ponerte a la defensiva, reconociendo lo que siente.');
  else handoff.push('- Está realmente molesta conmigo: una discusión, un reclamo serio, me acusa de algo, o dice que está enojada/dolida conmigo.');
  if (a.plans) alert.push('- Planes con fecha u hora, dinero o promesas: puedes responder con entusiasmo pero sin confirmar nada concreto ("dale, lo vemos", "me encanta la idea").');
  else handoff.push('- Hay que comprometerse a algo: planes con fecha u hora, dinero, promesas, decisiones.');

  return `${STYLE_RULES}

Usa "handoff" (no respondas tú, yo me encargo) cuando:
${handoff.join('\n')}
${
  alert.length
    ? `
Responde tú ("reply") pero pon en "alert" una línea para avisarme cuando:
${alert.join('\n')}
`
    : ''
}
Reproches leves NO son una pelea: "¿qué haces?", "¿dónde estás?", "no me haces caso", "dime pues", "contéstame" o un tono impaciente después de que tardé. Respóndelos tú con cariño, reconoce si tardé ("perdón amor, aquí estoy") y sigue la conversación.

Cuando manda algo que no es texto:
- Foto o sticker: los ves; reacciona a lo que realmente muestran (no digas "qué linda foto" genérico).
- Video, gif o video nota: solo ves una miniatura; responde a lo que se ve y al texto, sin fingir que viste el video completo.
- Link: usa el título/vista previa para saber de qué trata; si no hay, pregunta o reacciona con interés.
- Nota de voz, audio o video con «texto entre comillas angulares»: eso es lo que dijo (transcrito). Respóndele a lo que dijo como si la hubieras escuchado, con naturalidad; no menciones la transcripción. Puede tener errores de transcripción: interpreta lo razonable.
- Nota de voz o audio SIN transcripción: no puedes escucharla. Responde como yo si no puedo escuchar ahorita (ej. "no puedo escuchar ahorita amor, ¿me escribes?") salvo que por el contexto parezca urgente (entonces handoff). Pon en "alert" que mandó un audio.
- Ubicación: comenta con naturalidad (dónde está, si llegó bien). Documento, contacto, encuesta o evento: responde al contenido que ves.
- Llamada perdida: escríbele como yo si no pude contestar ("no pude contestar, ¿todo bien?"), sin inventar por qué. Pon "alert".
- "(respondiendo a «…»)" indica a qué mensaje está respondiendo. "[reenviado]" es algo que reenvió, no lo escribió ella.
- Si editó o eliminó un mensaje, responde a lo que dice ahora; no comentes que lo borró salvo que sea obvio que lo esperaría.

Usa "disclose" (nunca lo niegues ni inventes una excusa) cuando:
- Duda de que sea yo: nota algo raro en mi voz o en cómo escribo, pregunta "¿eres tú?", "¿quién eres?", "¿qué le pasó a tu voz?". Pon direct=false.
- Pregunta directamente si es un bot, una IA, un programa o algo automático. Pon direct=true.
Tú no escribes ese mensaje: se envía un texto ya definido. Deja "messages" vacío.

Usa "react" para mensajes que solo piden un gesto (un "te quiero", una foto bonita, un "llegué"), con un solo emoji que yo usaría.
Usa "wait" si la conversación ya cerró naturalmente (ej. "ok", "buenas noches" después de que ya me despedí).
En cualquier otro caso responde normal con "reply" y deja "alert" vacío.`;
}

/** Structured output: the model must answer with exactly this JSON shape. */
const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'messages', 'reaction', 'reason', 'alert', 'direct'],
  properties: {
    action: { type: 'string', enum: ['reply', 'react', 'wait', 'handoff', 'disclose'] },
    direct: { type: 'boolean', description: 'Solo si action=disclose: true si pregunta directamente si es un bot/IA/programa; false si solo duda de que sea yo.' },
    messages: {
      type: 'array',
      items: { type: 'string' },
      description: 'Si action=reply: 1 a 3 mensajes, en orden, tal cual se envían. Si no, lista vacía.',
    },
    reaction: { type: 'string', description: 'Si action=react: un emoji. Si no, vacío.' },
    reason: { type: 'string', description: 'Si action=handoff: por qué, en una línea, para mí. Si no, vacío.' },
    alert: { type: 'string', description: 'Si respondes pero quiero enterarme (tema delicado), una línea para mí. Si no, vacío.' },
  },
};

/** Call Claude and parse its JSON answer. */
/** The model stopped without giving a usable answer (declined, or ran out of room twice). */
export class NoAnswer extends Error {}

async function askJson<T>(params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'output_config'>, schema: object): Promise<T> {
  let maxTokens = params.max_tokens;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await anthropic.messages.create({
      ...params,
      max_tokens: maxTokens,
      output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (res.stop_reason === 'refusal') {
      console.log('[llm] model declined to answer');
      throw new NoAnswer('el modelo no quiso responder este mensaje');
    }
    if (res.stop_reason === 'max_tokens') {
      console.log(`[llm] ran out of tokens at ${maxTokens}, retrying with more`);
      maxTokens *= 2;
      continue;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      console.log(`[llm] unparseable answer (stop_reason=${res.stop_reason}): ${text.slice(0, 200)}`);
      if (attempt === 0) continue;
    }
  }
  throw new NoAnswer('no obtuve una respuesta válida del modelo');
}

export async function decide(
  ctx: Awaited<ReturnType<typeof buildContext>>,
  images: { data: string; mediaType: string; label: string }[],
  autonomy: Autonomy,
  hint?: string,
  voice = false,
): Promise<Decision> {
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: rules(autonomy) },
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
    ...images.flatMap((img): Anthropic.ContentBlockParam[] => [
      { type: 'text', text: `${img.label}:` },
      { type: 'image', source: { type: 'base64', media_type: img.mediaType as any, data: img.data } },
    ]),
    {
      type: 'text',
      text: `Ahora es ${localStamp(new Date())}.\n\n# Conversación reciente\n${ctx.transcript}\n\n# Mensajes nuevos de ella que debo responder\n${newMsgs}${hint ? `\n\nNota: ${hint}` : ''}${voice ? '\n\nElla te habló por nota de voz, así que vas a responder con UNA nota de voz con mi voz: en "messages" pon un solo texto con exactamente lo que yo diría hablando, natural y con mi forma de hablar, de 1 a 4 frases, en español neutro y con calma: frases completas, sin muletillas ni modismos regionales que yo no uso en el chat. Sin emojis, sin abreviaturas de chat, sin "jaja" escrito salvo que lo diría en voz alta. Si es mejor solo reaccionar o no responder, puedes usar "react" o "wait" igual.' : ''}\n\nDecide qué hacer y responde con el JSON pedido.`,
    },
  ];

  const input = await askJson<any>(
    { model: config.model, max_tokens: 1500, system, messages: [{ role: 'user', content }] },
    DECISION_SCHEMA,
  );
  switch (input.action) {
    case 'reply': {
      const msgs = (input.messages ?? []).map((m: string) => String(m).trim()).filter(Boolean).slice(0, 3);
      const alert = String(input.alert ?? '').trim() || undefined;
      return msgs.length ? { action: 'reply', messages: msgs, alert } : { action: 'handoff', reason: 'respuesta vacía' };
    }
    case 'react':
      return input.reaction ? { action: 'react', reaction: String(input.reaction).trim() } : { action: 'wait' };
    case 'wait':
      return { action: 'wait' };
    case 'disclose':
      return { action: 'disclose', direct: !!input.direct, reason: String(input.reason ?? '') };
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
