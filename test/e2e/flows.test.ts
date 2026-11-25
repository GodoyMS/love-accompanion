import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import {
  brain, conversation, db, dispatcher, events, handleCommand, her, me, queue, replies, reset, settings, settle, speech, store, transcript, wa,
} from './harness.ts';

after(async () => {
  await dispatcher.stop();
  await db.pool.end();
});

describe('replying', () => {
  beforeEach(() => reset());

  test('answers a text like a person: online, read, typing, send', async () => {
    brain.next({ action: 'reply', messages: ['hola amor', '¿cómo estás?'] });
    await her('hola');
    await settle();
    assert.deepEqual(wa.sent.map((s) => s.body), ['hola amor', '¿cómo estás?']);
    assert.deepEqual(wa.log.slice(0, 4), ['presence:available', 'read:1', 'presence:composing', 'text:hola amor']);
    assert.deepEqual(await transcript(), ['ella: hola', 'bot: hola amor', 'bot: ¿cómo estás?']);
    assert.equal((await queue())[0].status, 'sent');
  });

  test('a burst of messages gets one answer that sees all of them', async () => {
    await reset({ debounceSec: [0.3, 0.3] }); // she types faster than the debounce
    await her('oye');
    await her('ya llegué');
    await her('estoy cansada');
    await settle();
    assert.equal(brain.inputs.length, 1);
    assert.deepEqual(brain.last.ctx.pending.map((t) => t.body), ['oye', 'ya llegué', 'estoy cansada']);
    assert.equal(wa.sent.length, 1);
  });

  test('a message arriving while Claude thinks discards that answer and re-thinks with everything', async () => {
    let release!: () => void;
    brain.gate = new Promise((r) => (release = r));
    brain.next({ action: 'reply', messages: ['respuesta vieja'] }, { action: 'reply', messages: ['respuesta nueva'] });
    await her('primero');
    await new Promise((r) => setTimeout(r, 20)); // thinking now, blocked on the gate
    await her('segundo');
    brain.gate = null;
    release();
    await settle();
    assert.deepEqual(wa.sent.map((s) => s.body), ['respuesta nueva']);
    assert.deepEqual(brain.last.ctx.pending.map((t) => t.body), ['primero', 'segundo']);
  });

  test('two passes over the same messages (e.g. restart check + her message) answer only once', async () => {
    await reset({ debounceSec: [0.3, 0.3], replyDelaySec: [600, 600] });
    let release!: () => void;
    brain.gate = new Promise((r) => (release = r));
    await her('hola');
    await new Promise((r) => setTimeout(r, 400)); // first pass is thinking, blocked
    await conversation.kick('restart', 2); // the boot check runs before that reply is queued
    brain.gate = null;
    release(); // first pass queues its reply; the boot check's timer fires afterwards
    await new Promise((r) => setTimeout(r, 600));
    await settle();
    const q = await queue();
    assert.equal(q.filter((r) => r.status === 'pending').length, 1, 'exactly one reply on its way');
    assert.equal(brain.inputs.length, 1);
  });

  test('a reply being sent when she writes again does not stop the new message from being answered', async () => {
    await reset({ replyDelaySec: [600, 600] });
    await her('uno');
    await settle();
    await db.q(`update pending_replies set status = 'sending'`); // dispatcher is mid-typing
    await her('dos');
    await settle();
    const q = await queue();
    assert.equal(q.length, 2, 'her new message got its own reply');
    assert.deepEqual(brain.last.ctx.pending.map((t) => t.body), ['uno', 'dos']);
  });

  test('a queued reply is cancelled when she writes again before it goes out', async () => {
    await reset({ replyDelaySec: [600, 600] }); // replies wait 10 min
    brain.next({ action: 'reply', messages: ['A'] }, { action: 'reply', messages: ['B'] });
    await her('uno');
    await settle();
    assert.equal(wa.sent.length, 0);
    await her('dos');
    await settle();
    const q = await queue();
    assert.equal(q[0].status, 'cancelled');
    assert.equal(q[0].reason, 'she wrote again');
    assert.equal(q[1].status, 'pending');
  });

  test('stops a multi-part reply if she writes in the middle of it', async () => {
    brain.next({ action: 'reply', messages: ['uno', 'dos', 'tres'] });
    wa.onPresence = async (p, sent) => {
      if (p === 'composing' && sent === 1) await store.insertMessage({ waId: 'MID', fromMe: false, kind: 'text', body: 'espera', ts: new Date() }, 'human', 'live');
    };
    await her('hola');
    await settle();
    assert.equal(wa.sent[0].body, 'uno');
    assert.ok(!wa.sent.some((s) => s.body === 'tres'), 'must not keep talking over her');
    assert.match((await queue())[0].reason, /she wrote again/);
  });

  test('her message counts as unanswered even if her phone clock is behind ours', async () => {
    brain.next({ action: 'reply', messages: ['primera'] });
    await her('hola');
    await settle();
    // Next message is stamped 30s in the past by her phone, but it arrives now.
    await her('¿sigues ahí?', { at: new Date(Date.now() - 30_000) });
    await settle();
    assert.equal(brain.inputs.length, 2);
    assert.deepEqual(brain.last.ctx.pending.map((t) => t.body), ['¿sigues ahí?']);
  });

  test('her reaction to your message is stored but not answered', async () => {
    await store.insertMessage({ waId: 'R1', fromMe: false, kind: 'reaction', body: '[reaccionó ❤️ a un mensaje]', ts: new Date() }, 'human', 'live');
    await conversation.kick('test');
    await settle();
    assert.equal(brain.inputs.length, 0);
  });

  test('reacts with an emoji when that is the decision', async () => {
    brain.next({ action: 'react', reaction: '❤️' });
    await her('te quiero');
    await settle();
    assert.deepEqual(wa.sent, [{ kind: 'react', body: '❤️', id: 'BOT1' }]);
  });

  test('never leaves her on "seen": every message gets at least a reaction', async () => {
    // Even if the model only says "react" without an emoji.
    brain.next({ action: 'react', reaction: '' } as any);
    await her('jaja ok');
    await settle();
    assert.deepEqual(wa.sent, [{ kind: 'react', body: '❤️', id: 'BOT1' }]);
  });
});

describe('you and the bot', () => {
  beforeEach(() => reset({ replyDelaySec: [600, 600] }));

  test('when you write yourself, queued replies are dropped and the bot stays ON', async () => {
    await her('hola');
    await settle();
    assert.equal((await queue())[0].status, 'pending');
    await me('hola amor, aquí estoy');
    const q = await queue();
    assert.equal(q[0].status, 'cancelled');
    assert.equal(q[0].reason, 'you answered yourself');
    assert.equal(await settings.canSend(), true);
  });

  test('after you write, the bot gives you the hand-back window before answering', async () => {
    await reset({ handBackMinutes: 2 });
    await me('hola');
    await her('¿qué haces?');
    await settle();
    const [r] = await queue();
    assert.equal(r.status, 'pending');
    const waitS = (new Date(r.send_at).getTime() - Date.now()) / 1000;
    assert.ok(waitS > 100 && waitS < 130, `should wait ~2 min, waited ${waitS}s`);
  });

  test('you write while the bot is "typing": it stops and sends nothing', async () => {
    await reset();
    brain.next({ action: 'reply', messages: ['bot'] });
    wa.onPresence = async (p) => {
      if (p === 'composing') await store.insertMessage({ waId: 'MANUAL', fromMe: true, kind: 'text', body: 'yo', ts: new Date() }, 'human', 'live');
    };
    await her('hola');
    await settle();
    assert.equal(wa.sent.length, 0);
    assert.match((await queue())[0].reason, /you answered yourself/);
  });

  test('your answer counts as answering her: nothing more to say', async () => {
    await reset();
    brain.next({ action: 'reply', messages: ['x'] });
    await store.insertMessage({ waId: 'H', fromMe: false, kind: 'text', body: 'hola', ts: new Date() }, 'human', 'live');
    await me('hola amor');
    await conversation.kick('test');
    await settle();
    assert.equal(brain.inputs.length, 0);
  });
});

describe('kill switch and pause', () => {
  beforeEach(() => reset({ replyDelaySec: [600, 600] }));

  test('switching off cancels the queue and nothing is sent', async () => {
    await her('hola');
    await settle();
    await settings.setEnabled(false, 'test');
    await db.q(`update pending_replies set send_at = now()`);
    await settle();
    assert.equal(wa.sent.length, 0);
    assert.match((await queue())[0].reason, /switched off/);
  });

  test('switched off mid-reply: stops before the next part', async () => {
    await reset();
    brain.next({ action: 'reply', messages: ['uno', 'dos'] });
    wa.onPresence = async (p, sent) => {
      // You flip the switch while it's typing the second message.
      if (p === 'composing' && sent === 1) await db.kvSet('settings', { ...(await settings.getSettings()), enabled: false, _v: 6 });
    };
    await her('hola');
    await settle();
    assert.deepEqual(wa.sent.map((s) => s.body), ['uno']);
  });

  test('while off, messages are stored; switching on answers them', async () => {
    await reset();
    await settings.setEnabled(false, 'test');
    await her('hola');
    await her('¿estás?');
    await settle();
    assert.equal(brain.inputs.length, 0);
    await settings.setEnabled(true, 'test');
    await settle();
    assert.equal(brain.inputs.length, 1);
    assert.equal(brain.last.ctx.pending.length, 2);
    assert.equal(wa.sent.length, 1);
  });

  test('pause and resume, both logged with who did it', async () => {
    await reset();
    await settings.pauseFor(60, 'panel');
    await her('hola');
    await settle();
    assert.equal(wa.sent.length, 0);
    await settings.resume('panel');
    await settle();
    assert.equal(wa.sent.length, 1);
    assert.deepEqual(await events('paused'), ['60 min — panel']);
    assert.deepEqual(await events('resumed'), ['panel']);
  });

  test('self commands', async () => {
    await handleCommand('/stop');
    assert.equal((await settings.reloadSettings()).enabled, false);
    await handleCommand('/start');
    assert.equal((await settings.reloadSettings()).enabled, true);
    await handleCommand('/pause 15');
    assert.ok(settings.isPaused(await settings.reloadSettings()));
    await handleCommand('/resume');
    assert.ok(!settings.isPaused(await settings.reloadSettings()));
    await handleCommand('/status');
    await handleCommand('/nope');
    assert.match(wa.notes.at(-2)!, /^Encendido\. En cola: 0\.$/);
    assert.match(wa.notes.at(-1)!, /No conozco/);
  });
});

describe('sensitive moments', () => {
  beforeEach(() => reset());

  test('an emergency is answered within seconds — ignoring delays, your hand-back and sleep hours — and pings you once', async () => {
    const h = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Lima', hour: 'numeric', hour12: false })) % 24;
    await reset({ replyDelaySec: [600, 600], handBackMinutes: 30, quietHours: [h, (h + 2) % 24] });
    await me('hola');
    brain.next(
      { action: 'reply', messages: ['amor, ve a emergencia ya y avísale a alguien cerca'], alert: 'le cuesta respirar', urgent: true },
      { action: 'reply', messages: ['¿ya saliste?'], alert: 'sigue mal', urgent: true },
    );
    await her('no puedo respirar');
    await settle();
    const [r] = await queue();
    assert.ok(new Date(r.send_at).getTime() - Date.now() < 15_000, 'goes out within seconds');
    await her('ayuda');
    await settle();
    assert.equal(wa.notes.filter((n) => n.startsWith('Emergencia')).length, 1, 'one ping per 30 min');
    assert.deepEqual(await events('urgent'), ['le cuesta respirar', 'sigue mal']);
  });

  test('delicate but normal topics are answered and only logged (no ping)', async () => {
    brain.next({ action: 'reply', messages: ['ay amor, ¿qué sientes?'], alert: 'se siente mal' });
    await her('me siento mal');
    await settle();
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.notes.length, 0);
    assert.deepEqual(await events('alert'), ['se siente mal']);
  });

  test('disclosure: tells her the configured text, keeps running, and from then on answers honestly', async () => {
    brain.next({ action: 'disclose', direct: false, reason: 'notó la voz' });
    await her('¿qué le pasó a tu voz?');
    await settle();
    const s = await settings.reloadSettings();
    assert.deepEqual(wa.sent.map((x) => x.body), [s.disclosure.doubtText]);
    assert.ok(!settings.isPaused(s), 'does not pause on its own');
    assert.match(wa.notes[0], /dudó de que fueras tú.*Sigo respondiéndole/s);
    await her('ok, ¿y entonces?');
    await settle();
    assert.equal(brain.last.disclosed, true);
    assert.equal(wa.sent.length, 2);
  });

  test('direct "are you a bot?" gets the direct text', async () => {
    brain.next({ action: 'disclose', direct: true, reason: 'preguntó' });
    await her('¿eres un bot?');
    await settle();
    assert.equal(wa.sent[0].body, (await settings.getSettings()).disclosure.directText);
  });

  test('no usable answer: retries once insisting on a reply, so she still gets one', async () => {
    const { NoAnswer } = await import('../../src/core/ports.ts');
    brain.next(new NoAnswer('el modelo no quiso responder'), { action: 'reply', messages: ['aquí estoy amor'] });
    await her('algo');
    await settle();
    assert.deepEqual(wa.sent.map((s) => s.body), ['aquí estoy amor']);
    assert.match(brain.last.hint ?? '', /responderle tú sí o sí/);
    assert.equal(wa.notes.length, 0);
  });

  test('two failures in a row: you are told once, never a crash', async () => {
    const { NoAnswer } = await import('../../src/core/ports.ts');
    brain.next(new NoAnswer('nada'), new NoAnswer('nada'), new NoAnswer('nada'), new NoAnswer('nada'));
    await her('uno');
    await settle();
    await her('dos');
    await settle();
    assert.equal(wa.sent.length, 0);
    assert.equal(wa.notes.filter((n) => n.startsWith('No pude generar una respuesta')).length, 1);
  });

  test('an unexpected error alerts you once and the next message still works', async () => {
    brain.next(new Error('boom'), new Error('boom'), { action: 'reply', messages: ['ya'] });
    await her('uno');
    await settle();
    await her('dos');
    await settle();
    assert.equal(wa.notes.filter((n) => n.startsWith('No pude generar')).length, 1);
    await her('tres');
    await settle();
    assert.deepEqual(wa.sent.map((s) => s.body), ['ya']);
  });

  test('without an API key it does nothing (and does not crash)', async () => {
    brain.isReady = false;
    await her('hola');
    await settle();
    assert.equal(brain.inputs.length, 0);
    assert.equal(wa.sent.length, 0);
  });
});

describe('voice', () => {
  beforeEach(() => reset());

  test('her voice note is transcribed and answered with a voice note (recording first)', async () => {
    brain.next((i) => ({ action: 'reply', messages: [i.voice ? 'te respondo hablando' : 'texto'] }));
    await her('[nota de voz 0:04]', { kind: 'audio' });
    await settle();
    // A 3 s note is held back ~6 s, the time it takes a person to record it.
    const [r] = await queue();
    assert.equal(r.kind, 'voice');
    assert.ok(new Date(r.send_at).getTime() - Date.now() > 4_000);
    await db.q(`update pending_replies set send_at = now()`);
    await settle();
    assert.equal(brain.last.voice, true);
    assert.equal(brain.last.ctx.pending[0].body, '[nota de voz 0:04] «hola amor, ¿cómo estás?»');
    assert.deepEqual(wa.sent.map((s) => s.kind), ['voice']);
    assert.ok(wa.log.indexOf('presence:recording') < wa.log.indexOf('voice:3s'));
    assert.match((await transcript()).at(-1)!, /^bot: \[nota de voz 0:03\] «te respondo hablando»$/);
  });

  test('a voice note followed by a text is still answered by voice', async () => {
    await reset({ debounceSec: [0.3, 0.3] });
    await her('[nota de voz 0:04]', { kind: 'audio' });
    await her('¿me escuchaste?');
    await settle();
    assert.equal(brain.inputs.length, 1);
    assert.deepEqual(brain.last.ctx.pending.map((t) => t.kind), ['audio', 'text']);
    assert.equal(brain.last.voice, true);
    assert.equal((await queue())[0].kind, 'voice');
  });

  test('only texts → text, even if she sent a voice note earlier that was already answered', async () => {
    await her('[nota de voz 0:04]', { kind: 'audio' });
    await settle();
    await db.q(`update pending_replies set send_at = now()`);
    await settle();
    await her('ok, y tú?');
    await settle();
    assert.equal(brain.last.voice, false);
  });

  test('if text-to-speech fails, the same answer goes out as text', async () => {
    speech.speakOk = false;
    brain.next({ action: 'reply', messages: ['hola amor'] });
    await her('[nota de voz 0:04]', { kind: 'audio' });
    await settle();
    assert.deepEqual(wa.sent, [{ kind: 'text', body: 'hola amor', id: 'BOT1' }]);
  });

  test('voice replies off → text', async () => {
    await reset({ voiceReplies: false });
    await her('[nota de voz 0:04]', { kind: 'audio' });
    await settle();
    assert.equal(brain.last.voice, false);
    assert.equal(wa.sent[0].kind, 'text');
  });

  test('no transcription available → Claude sees the note without text', async () => {
    speech.transcribeOk = false;
    await her('[nota de voz 0:04]', { kind: 'audio' });
    await settle();
    assert.equal(brain.last.ctx.pending[0].body, '[nota de voz 0:04]');
  });

  test('photos are shown to Claude', async () => {
    await her('[foto] mira', { kind: 'image', visual: true });
    await settle();
    assert.equal(brain.last.images.length, 1);
  });
});

describe('edits, deletes, calls', () => {
  beforeEach(() => reset({ replyDelaySec: [600, 600] }));

  test('an edit re-thinks with the corrected text', async () => {
    const id = await her('nos vemos a las 5');
    await settle();
    await store.updateBody(id, 'nos vemos a las 6 (editado)');
    await conversation.onChanged();
    await settle();
    const q = await queue();
    assert.equal(q[0].status, 'cancelled');
    assert.equal(q[1].status, 'pending');
    assert.equal(brain.last.ctx.pending[0].body, 'nos vemos a las 6 (editado)');
  });

  test('a missed call becomes part of the chat and gets a text back', async () => {
    await reset();
    brain.next({ action: 'reply', messages: ['no pude contestar, ¿todo bien?'] });
    await conversation.onMissedCall(true);
    await settle();
    assert.equal(brain.last.ctx.pending[0].body, '[llamada de video perdida]');
    assert.equal(wa.sent.length, 1);
  });
});

describe('delivery failures and restarts', () => {
  beforeEach(() => reset());

  test('a send that fails before anything reached her is retried, without duplicates', async () => {
    wa.failSends = 1;
    brain.next({ action: 'reply', messages: ['hola'] });
    await her('hola');
    await settle();
    assert.equal(wa.sent.length, 0);
    let [r] = await queue();
    assert.equal(r.status, 'pending');
    await db.q(`update pending_replies set send_at = now()`);
    await settle();
    [r] = await queue();
    assert.equal(r.status, 'sent');
    assert.deepEqual(wa.sent.map((s) => s.body), ['hola']);
  });

  test('a failure after part of the reply reached her is never re-sent', async () => {
    brain.next({ action: 'reply', messages: ['uno', 'dos'] });
    wa.beforeSend = (n) => {
      if (n === 1) wa.failSends = 1;
    };
    await her('hola');
    await settle();
    const [r] = await queue();
    assert.equal(r.status, 'sent');
    assert.match(r.reason, /partially delivered/);
    assert.deepEqual(wa.sent.map((s) => s.body), ['uno']);
  });

  test('gives up after 3 attempts and tells you', async () => {
    wa.failSends = 99;
    await her('hola');
    for (let i = 0; i < 3; i++) {
      await settle();
      await db.q(`update pending_replies set send_at = now() where status = 'pending'`);
    }
    await settle();
    assert.equal((await queue())[0].status, 'failed');
    assert.match(wa.notes.at(-1)!, /No pude enviarle/);
  });

  test('WhatsApp disconnected: replies wait, then go out on reconnect', async () => {
    wa.connected = false;
    await her('hola');
    await settle();
    assert.equal((await queue())[0].status, 'pending');
    wa.connected = true;
    await settle();
    assert.equal(wa.sent.length, 1);
  });

  test('restart: a reply cut mid-send is closed (never doubled), unanswered messages are picked up', async () => {
    await replies.enqueue({ kind: 'reply', sendAt: new Date(), parts: ['x'] });
    await db.q(`update pending_replies set status = 'sending'`);
    assert.equal(await replies.closeInterrupted(), 1);
    await store.insertMessage({ waId: 'OLD', fromMe: false, kind: 'text', body: '¿hola?', ts: new Date() }, 'human', 'live');
    await conversation.kick('restart', 2);
    await settle();
    assert.equal(wa.sent.length, 1);
  });

  test('a bot message echoed back after a restart is not mistaken for you', async () => {
    await store.insertBotMessage('BOTX', 'text', 'hola');
    assert.equal(await store.isBotMessage('BOTX'), true);
    assert.equal(await store.isBotMessage('SOMEONE'), false);
  });

  test('imported history never counts as unanswered', async () => {
    const { importExport } = await import('../../src/importer/import.ts');
    await importExport('01/11/25, 10:00 p. m. - Vale: hola\n01/11/25, 10:01 p. m. - Godoy: hola amor\n01/11/25, 10:02 p. m. - Vale: chau', 'Godoy');
    assert.equal((await store.unanswered()).length, 0);
    // …and when she writes live, only the live message is "new".
    await her('hola de nuevo');
    await settle();
    assert.deepEqual(brain.last.ctx.pending.map((t) => t.body), ['hola de nuevo']);
  });
});

describe('sleep hours', () => {
  test('off by default: answers at 3am right away', async () => {
    await reset();
    assert.equal((await settings.getSettings()).quietHours, null);
  });

  test('on: the reply is parked until morning and you are told when', async () => {
    const h = new Date().toLocaleString('en-US', { timeZone: 'America/Lima', hour: 'numeric', hour12: false });
    const now = Number(h) % 24;
    await reset({ quietHours: [now, (now + 2) % 24] });
    await her('hola');
    await settle();
    assert.equal(wa.sent.length, 0);
    assert.equal(wa.notes.length, 0, 'no WhatsApp ping while you sleep');
    assert.match((await events('deferred'))[0], /horas de sueño, sale a las/);
  });
});

describe('settings validation', () => {
  test('garbage from the panel is clamped or ignored', () => {
    const s = settings.normalizeSettings({
      debounceSec: [30, 5],
      replyDelaySec: ['x', 99999],
      quietHours: [1, 1],
      handBackMinutes: -4,
      voice: { speed: 9, model: 'hack' },
      disclosure: { doubtText: '   ', pauseHours: 1e9 },
      evil: true,
    });
    assert.deepEqual(s.debounceSec, [5, 30]);
    assert.deepEqual(s.replyDelaySec, [5, 1800]);
    assert.equal(s.quietHours, null);
    assert.equal(s.handBackMinutes, 0);
    assert.equal(s.voice.speed, 1.2);
    assert.equal(s.voice.model, 'eleven_multilingual_v2');
    assert.equal(s.disclosure.doubtText, settings.DEFAULT_SETTINGS.disclosure.doubtText);
    assert.equal((s.disclosure as any).pauseHours, undefined);
    assert.equal((s as any).evil, undefined);
  });

  test('old saved settings are migrated once (sleep hours off, slow defaults replaced, livelier voice, no pause texts)', async () => {
    await reset();
    await db.kvSet('settings', {
      enabled: true, quietHours: [3, 7], debounceSec: [20, 60], takeoverMinutes: 30,
      voice: { model: 'eleven_flash_v2_5', speed: 0.9, stability: 0.65, similarity: 0.9, style: 0 },
      disclosure: { pauseHours: 12, doubtText: 'Amor, te soy sincero: no soy Godoy, soy un reemplazo suyo para que no te quedes sin respuesta cuando él no puede contestar. Ya le aviso para que te escriba él.', directText: 'mi texto' },
    });
    await settings.migrateSettings();
    const s = await settings.reloadSettings();
    assert.equal(s.quietHours, null);
    assert.deepEqual(s.debounceSec, [8, 25]);
    assert.deepEqual(s.voice, { model: 'eleven_flash_v2_5', speed: 1.02, stability: 0.4, similarity: 0.85, style: 0.35 });
    assert.match(s.disclosure.doubtText, /Igual aquí sigo/);
    assert.equal(s.disclosure.directText, 'mi texto', 'your own text is kept');
    // A later choice of yours survives the next boot.
    await settings.updateSettings({ quietHours: [1, 6] });
    await settings.migrateSettings();
    assert.deepEqual((await settings.reloadSettings()).quietHours, [1, 6]);
  });
});

describe('importing the chat (#5)', () => {
  const EXPORT = '01/11/25, 10:00 p. m. - Vale: hola\n01/11/25, 10:01 p. m. - Godoy: hola amor\n01/11/25, 10:02 p. m. - Vale: <sticker omitido>';
  const imported = async () => (await db.q(`select from_me, body from messages where source = 'import' order by ts`)).rows;

  test('re-importing (even choosing the wrong "you" first) never duplicates', async () => {
    await reset();
    const { importExport } = await import('../../src/importer/import.ts');
    await importExport(EXPORT, 'Vale'); // wrong choice
    const r = await importExport(EXPORT, 'Godoy'); // fixed
    assert.equal((r as any).replaced, 3);
    assert.deepEqual(await imported(), [
      { from_me: false, body: 'hola' },
      { from_me: true, body: 'hola amor' },
      { from_me: false, body: '[sticker]' },
    ]);
  });

  test('the real WhatsApp message replaces its imported copy', async () => {
    await reset();
    const { importExport } = await import('../../src/importer/import.ts');
    await importExport(EXPORT, 'Godoy');
    const ts = (await db.q(`select ts from messages where body = 'hola amor'`)).rows[0].ts;
    await store.insertMessage({ waId: 'REAL1', fromMe: true, kind: 'text', body: 'hola amor', ts: new Date(ts) }, 'human', 'history');
    const rows = (await db.q(`select source from messages where body = 'hola amor'`)).rows;
    assert.deepEqual(rows, [{ source: 'history' }]);
  });

  test('boot self-heals duplicates left by older versions', async () => {
    await reset();
    for (let i = 0; i < 2; i++) {
      await db.q(`insert into messages (from_me, sent_by, kind, body, ts, received_at, source)
                  values (false, 'import', 'text', 'hola', '2025-11-01T03:00:00Z', '2025-11-01T03:00:00Z', 'import')
                  on conflict do nothing`);
    }
    await db.q(`insert into messages (from_me, sent_by, kind, body, ts, received_at, source)
                values (false, 'import', 'text', 'hola', '2025-11-01T03:00:30Z', '2025-11-01T03:00:30Z', 'import')`);
    await db.migrate();
    assert.equal((await db.q(`select count(*)::int n from messages where body = 'hola'`)).rows[0].n, 1);
  });
});
