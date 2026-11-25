import type { Speech } from '../core/ports.js';
import { sttProvider, transcribe } from './stt.js';
import { makeVoiceNote, voiceReady } from './voice.js';

/** ElevenLabs/OpenAI speech wired as the core's Speech port. */
export const realSpeech: Speech = {
  canTranscribe: () => !!sttProvider(),
  transcribe,
  canSpeak: voiceReady,
  speak: makeVoiceNote,
};
