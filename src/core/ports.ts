/**
 * The core logic talks to the outside world only through these interfaces.
 * Production wires real adapters (WhatsApp, Claude, ElevenLabs); tests wire fakes.
 */
import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import type { Autonomy } from '../store/settings.js';
import type { Turn } from '../store/messages.js';

export type Presence = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';

export interface Visual {
  data: string; // base64
  mediaType: string;
  label: string;
}

export interface Messenger {
  readonly connected: boolean;
  markRead(keys: WAMessageKey[]): Promise<void>;
  presence(p: Presence): Promise<void>;
  sendText(text: string): Promise<string>;
  sendVoice(ogg: Buffer, seconds: number, waveform?: Uint8Array): Promise<string>;
  react(key: WAMessageKey, emoji: string): Promise<string>;
  /** Your own "Message yourself" chat. */
  notifySelf(text: string): Promise<void>;
  visualOf(raw: WAMessage): Promise<Visual | null>;
  mediaOf(raw: WAMessage): Promise<{ data: Buffer; mimetype: string; seconds: number } | null>;
}

export interface Context {
  profile: string;
  styleText: string;
  memoriesText: string;
  examplesText: string;
  voiceText: string;
  transcript: string;
  pending: Turn[];
}

export interface DecideInput {
  ctx: Context;
  images: Visual[];
  autonomy: Autonomy;
  /** Answer will be spoken (voice note). */
  voice: boolean;
  /** She was already told a stand-in sometimes answers. */
  disclosed: boolean;
}

export type Decision =
  | { action: 'reply'; messages: string[]; alert?: string }
  | { action: 'react'; reaction: string }
  | { action: 'wait' }
  | { action: 'handoff'; reason: string }
  | { action: 'disclose'; direct: boolean; reason: string };

export interface Brain {
  ready(): boolean;
  decide(input: DecideInput): Promise<Decision>;
}

export interface VoiceNote {
  ogg: Buffer;
  seconds: number;
  waveform: Uint8Array;
}

export interface Speech {
  canTranscribe(): boolean;
  transcribe(audio: Buffer, mimetype: string): Promise<string | null>;
  canSpeak(): boolean;
  speak(text: string): Promise<VoiceNote>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Uniform random number in [min, max]. */
  rand(min: number, max: number): number;
}

/** The model gave no usable answer (declined, or malformed twice). */
export class NoAnswer extends Error {}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  rand: (min, max) => min + Math.random() * (max - min),
};

const notWired = (name: string) =>
  new Proxy({}, { get: () => { throw new Error(`${name} port not wired`); } }) as any;

export const ports: { messenger: Messenger; brain: Brain; speech: Speech; clock: Clock } = {
  messenger: notWired('messenger'),
  brain: notWired('brain'),
  speech: notWired('speech'),
  clock: realClock,
};

export function wire(p: Partial<typeof ports>) {
  Object.assign(ports, p);
}
