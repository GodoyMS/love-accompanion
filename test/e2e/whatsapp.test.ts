import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { db, reset } from './harness.ts';

const { wa } = await import('../../src/adapters/whatsapp/client.ts');
const w: any = wa;

const HER = '51900000001@s.whatsapp.net';
const ME = '51911111111@s.whatsapp.net';
let calls: string[] = [];
let n = 0;
const msg = (m: any, opts: { fromMe?: boolean; jid?: string; id?: string } = {}) => ({
  key: { id: opts.id ?? `W${++n}`, remoteJid: opts.jid ?? HER, fromMe: !!opts.fromMe },
  messageTimestamp: Math.floor(Date.now() / 1000),
  message: m,
});

beforeEach(async () => {
  await reset();
  calls = [];
  w.me = { pn: ME, lid: null };
  w.handler = {
    onIncoming: async (m: any) => void calls.push(`incoming:${m.kind}:${m.body}`),
    onChanged: async () => void calls.push('changed'),
    onMissedCall: async (v: boolean) => void calls.push(`missed:${v ? 'video' : 'voice'}`),
    onManual: async () => void calls.push('manual'),
    onCommand: async (t: string) => void calls.push(`command:${t}`),
  };
});

after(() => db.pool.end());

const bodies = async () => (await db.q(`select from_me, sent_by, kind, body from messages order by id`)).rows;

test('her messages are stored and handed to the conversation', async () => {
  await w.route(msg({ conversation: 'hola' }));
  await w.route(msg({ imageMessage: { caption: 'mira' } }));
  assert.deepEqual(calls, ['incoming:text:hola', 'incoming:image:[foto] mira']);
  assert.equal((await bodies()).length, 2);
});

test('the same message delivered twice is handled once', async () => {
  const m = msg({ conversation: 'hola' }, { id: 'DUP' });
  await w.route(m);
  await w.route(m);
  assert.deepEqual(calls, ['incoming:text:hola']);
});

test('her reactions are stored as context but not answered', async () => {
  await w.route(msg({ reactionMessage: { text: '❤️' } }));
  assert.deepEqual(calls, []);
  assert.equal((await bodies())[0].kind, 'reaction');
});

test('you writing from your phone is a manual reply; the bot\'s own echo is not', async () => {
  await w.route(msg({ conversation: 'yo a mano' }, { fromMe: true }));
  await db.q(`insert into messages (wa_id, from_me, sent_by, kind, body, ts) values ('BOT9', true, 'bot', 'text', 'del bot', now())`);
  await w.route(msg({ conversation: 'del bot' }, { fromMe: true, id: 'BOT9' }));
  assert.deepEqual(calls, ['manual']);
});

test('commands only from your own chat; other people are ignored', async () => {
  await w.route(msg({ conversation: '/status' }, { fromMe: true, jid: ME }));
  await w.route(msg({ conversation: 'hola' }, { jid: '51977777777@s.whatsapp.net' }));
  await w.route(msg({ conversation: '/stop' }, { jid: '51977777777@s.whatsapp.net' }));
  assert.deepEqual(calls, ['command:/status']);
  assert.equal((await bodies()).length, 0);
});

test('recognizes her under WhatsApp\'s new LID ids', async () => {
  await w.route({ key: { id: 'L1', remoteJid: '999@lid', remoteJidAlt: HER, fromMe: false }, messageTimestamp: 1, message: { conversation: 'por lid' } });
  await w.route({ key: { id: 'L2', remoteJid: '999@lid', fromMe: false }, messageTimestamp: 1, message: { conversation: 'lid sin alt' } });
  assert.deepEqual(calls, ['incoming:text:por lid', 'incoming:text:lid sin alt']);
});

test('edits and deletes update the stored text', async () => {
  await w.route(msg({ conversation: 'a las 5' }, { id: 'E1' }));
  await w.onUpdate({ key: { id: 'E1', remoteJid: HER, fromMe: false }, update: { message: { editedMessage: { message: { conversation: 'a las 6' } } } } });
  await w.onUpdate({ key: { id: 'E1', remoteJid: HER, fromMe: false }, update: { message: null, messageStubType: 1 } });
  assert.deepEqual(calls.slice(1), ['changed', 'changed']);
  assert.equal((await bodies())[0].body, '[eliminó este mensaje]');
});

test('calls: missed → handed over; answered or long → not missed; strangers ignored', async () => {
  await w.onCall({ id: 'C1', from: HER, status: 'offer', isVideo: true });
  await w.onCall({ id: 'C1', from: HER, status: 'terminate' });
  await w.onCall({ id: 'C2', from: HER, status: 'offer' });
  await w.onCall({ id: 'C2', from: HER, status: 'accept' });
  await w.onCall({ id: 'C2', from: HER, status: 'terminate' });
  await w.onCall({ id: 'C3', from: HER, status: 'offer' });
  w.callOffers.get('C3').at -= 90_000;
  await w.onCall({ id: 'C3', from: HER, status: 'terminate' });
  await w.onCall({ id: 'C4', from: '51977777777@s.whatsapp.net', status: 'offer' });
  await w.onCall({ id: 'C4', from: '51977777777@s.whatsapp.net', status: 'terminate' });
  assert.deepEqual(calls, ['missed:video']);
});
