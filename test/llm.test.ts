import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://x@localhost/x';
process.env.ADMIN_PASSWORD ??= 'x';
process.env.ANTHROPIC_API_KEY = 'test';
const { claudeBrain } = await import('../src/adapters/claude.ts');
const { NoAnswer } = await import('../src/core/ports.ts');
const extractMemories = claudeBrain.remember;

// The SDK keeps the fetch it saw first, so install one mock that reads a mutable queue.
let queue: { text: string; stop: string }[] = [];
let seen: number[] = [];


const mockFetch = (async (_url: string, init: any) => {
  seen.push(JSON.parse(init.body).max_tokens);
  const a = queue.shift()!;
  return new Response(
    JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: 'x',
      content: [{ type: 'text', text: a.text }], stop_reason: a.stop, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}) as any;
globalThis.fetch = mockFetch;

function respond(...answers: { text: string; stop: string }[]) {
  queue = answers;
  seen = [];
  return { get maxTokens() { return seen; } };
}

test('parses a normal structured answer', async () => {
  respond({ text: '{"facts":[{"fact":"Ella tiene examen","expires_in_days":3}]}', stop: 'end_turn' });
  assert.deepEqual(await extractMemories('t', ''), [{ fact: 'Ella tiene examen', expires_in_days: 3 }]);
});

test('retries with more tokens when the answer is cut off', async () => {
  const r = respond({ text: '{"facts":[{"fact":"Ella ti', stop: 'max_tokens' }, { text: '{"facts":[]}', stop: 'end_turn' });
  assert.deepEqual(await extractMemories('t', ''), []);
  assert.deepEqual(r.maxTokens, [1500, 3000]);
});

test('a refusal becomes NoAnswer instead of a JSON crash', async () => {
  respond({ text: '{"facts":[{"fact":"', stop: 'refusal' });
  await assert.rejects(extractMemories('t', ''), (e) => e instanceof NoAnswer);
});

test('garbage twice becomes NoAnswer', async () => {
  respond({ text: '{"facts": [', stop: 'end_turn' }, { text: 'nope', stop: 'end_turn' });
  await assert.rejects(extractMemories('t', ''), (e) => e instanceof NoAnswer);
});
