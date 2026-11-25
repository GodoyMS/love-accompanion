/**
 * End-to-end harness: the real conversation engine, queue, dispatcher, settings and
 * Postgres, with WhatsApp / Claude / ElevenLabs replaced by in-memory fakes.
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:pg@localhost:5432/la_test';
process.env.ADMIN_PASSWORD ??= 'test-password';
process.env.PARTNER_NUMBER ??= '51900000001';
process.env.ANTHROPIC_API_KEY ??= 'test';

const db = await import('../../src/store/db.ts');
const settings = await import('../../src/store/settings.ts');
const store = await import('../../src/store/messages.ts');
const replies = await import('../../src/store/replies.ts');
const ports = await import('../../src/core/ports.ts');
const { conversation } = await import('../../src/core/conversation.ts');
const { dispatcher } = await import('../../src/core/dispatcher.ts');
const { handleCommand } = await import('../../src/core/commands.ts');

export { conversation, db, dispatcher, handleCommand, ports, replies, settings, store };
type Decision = import('../../src/core/ports.ts').Decision;
type DecideInput = import('../../src/core/ports.ts').DecideInput;

// ---------- fakes ----------

export class FakeMessenger {
  connected = true;
  /** Everything visible she'd see, in order. */
  log: string[] = [];
  sent: { kind: 'text' | 'voice' | 'react'; body: string; id: string }[] = [];
  notes: string[] = [];
  /** Make the next N sends throw. */
  failSends = 0;
  /** Called right before each send (to simulate things happening mid-reply). */
  beforeSend: ((n: number) => Promise<void> | void) | null = null;
  /** Called on each presence change, e.g. while "typing…" (to simulate things happening mid-reply). */
  onPresence: ((p: string, sentSoFar: number) => Promise<void> | void) | null = null;
  private n = 0;

  private async send(kind: 'text' | 'voice' | 'react', body: string) {
    if (this.beforeSend) await this.beforeSend(this.sent.length);
    if (this.failSends > 0) {
      this.failSends--;
      throw new Error('network down');
    }
    const id = `BOT${++this.n}`;
    this.sent.push({ kind, body, id });
    this.log.push(`${kind}:${body}`);
    return id;
  }
  async markRead(keys: unknown[]) {
    this.log.push(`read:${keys.length}`);
  }
  async presence(p: string) {
    this.log.push(`presence:${p}`);
    if (this.onPresence) await this.onPresence(p, this.sent.length);
  }
  sendText(text: string) {
    return this.send('text', text);
  }
  sendVoice(_ogg: Buffer, seconds: number) {
    return this.send('voice', `${seconds}s`);
  }
  react(_key: unknown, emoji: string) {
    return this.send('react', emoji);
  }
  async notifySelf(text: string) {
    this.notes.push(text);
  }
  async visualOf() {
    return { data: 'aW1n', mediaType: 'image/jpeg', label: 'Foto que mandó' };
  }
  async mediaOf() {
    return { data: Buffer.from('ogg'), mimetype: 'audio/ogg', seconds: 4 };
  }
}

export class FakeBrain {
  inputs: DecideInput[] = [];
  private queue: (Decision | Error | ((i: DecideInput) => Decision | Promise<Decision>))[] = [];
  /** Resolves the in-flight decide() only when released (to simulate a slow model). */
  gate: Promise<void> | null = null;
  isReady = true;

  next(...d: (Decision | Error | ((i: DecideInput) => Decision | Promise<Decision>))[]) {
    this.queue.push(...d);
    return this;
  }
  ready() {
    return this.isReady;
  }
  async decide(input: DecideInput): Promise<Decision> {
    this.inputs.push(input);
    if (this.gate) await this.gate;
    const d = this.queue.shift() ?? { action: 'reply', messages: [`respuesta ${this.inputs.length}`] };
    if (d instanceof Error) throw d;
    return typeof d === 'function' ? d(input) : d;
  }
  get last() {
    return this.inputs[this.inputs.length - 1];
  }
}

export class FakeSpeech {
  transcribeOk = true;
  speakOk = true;
  transcribed: string | null = 'hola amor, ¿cómo estás?';
  canTranscribe() {
    return this.transcribeOk;
  }
  async transcribe() {
    return this.transcribed;
  }
  canSpeak() {
    return true;
  }
  async speak(_text: string) {
    if (!this.speakOk) throw new Error('elevenlabs 500');
    return { ogg: Buffer.from('OggS'), seconds: 3, waveform: new Uint8Array(64) };
  }
}

// ---------- world ----------

export let wa = new FakeMessenger();
export let brain = new FakeBrain();
export let speech = new FakeSpeech();
const instant = { now: () => Date.now(), sleep: async () => {}, rand: (min: number) => min };
ports.wire({ messenger: wa as any, brain: brain as any, speech: speech as any, clock: instant });
let ids = 0;

/** Fresh DB + fresh fakes, bot ON with instant timing. */
export async function reset(over: Partial<import('../../src/store/settings.ts').Settings> = {}) {
  await dispatcher.drain();
  await conversation.idle();
  await db.migrate();
  await db.q(`truncate messages, pending_replies, memories, kv, events restart identity`);
  wa = new FakeMessenger();
  brain = new FakeBrain();
  speech = new FakeSpeech();
  ports.wire({ messenger: wa as any, brain: brain as any, speech: speech as any, clock: instant });
  await db.kvSet('settings', { ...settings.DEFAULT_SETTINGS, enabled: true, debounceSec: [0, 0], replyDelaySec: [0, 0], ...over, _v: 6 });
  await settings.reloadSettings();
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** She sends something (what the WhatsApp adapter does on a new message). */
export async function her(body: string, opts: { kind?: string; visual?: boolean; at?: Date } = {}) {
  const waId = `HER${++ids}`;
  const m = { waId, fromMe: false, kind: opts.kind ?? 'text', body, ts: opts.at ?? new Date(), key: { id: waId }, hasVisual: !!opts.visual };
  await store.insertMessage(m, 'human', 'live');
  await conversation.onIncoming(m, { key: m.key, message: {} } as any);
  return waId;
}

/** You write to her from your phone. */
export async function me(body: string) {
  const waId = `ME${++ids}`;
  const m = { waId, fromMe: true, kind: 'text', body, ts: new Date(), key: { id: waId }, hasVisual: false };
  await store.insertMessage(m, 'human', 'live');
  await conversation.onManual();
}

/** Let thinking and sending finish. */
export async function settle() {
  for (let i = 0; i < 5; i++) {
    await tick();
    await conversation.idle();
    await dispatcher.drain();
  }
}

export async function queue() {
  return (await db.q(`select kind, status, parts, reason, send_at from pending_replies order by id`)).rows;
}

export async function transcript() {
  return (await db.q(`select from_me, sent_by, kind, body from messages order by received_at, id`)).rows.map(
    (r: any) => `${r.from_me ? (r.sent_by === 'bot' ? 'bot' : 'yo') : 'ella'}: ${r.body}`,
  );
}

export async function events(type: string) {
  return (await db.q(`select detail from events where type = $1 order by id`, [type])).rows.map((r: any) => r.detail);
}
