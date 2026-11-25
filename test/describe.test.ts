import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe } from '../src/adapters/whatsapp/describe.ts';

const thumb = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const cases: [string, any, { kind: string; body: RegExp; visual?: 'download' | 'thumb' }][] = [
  ['plain text', { conversation: 'hola amor' }, { kind: 'text', body: /^hola amor$/ }],
  [
    'link with preview',
    {
      extendedTextMessage: {
        text: 'mira esto https://www.tiktok.com/@x/video/1',
        matchedText: 'https://www.tiktok.com/@x/video/1',
        title: 'Perrito bailando',
        description: 'TikTok de @x',
        jpegThumbnail: thumb,
      },
    },
    { kind: 'text', body: /mira esto .* \[link: Perrito bailando — TikTok de @x\]$/, visual: 'thumb' },
  ],
  ['link without preview', { extendedTextMessage: { text: 'https://example.com', matchedText: 'https://example.com' } }, { kind: 'text', body: /^https:\/\/example\.com$/ }],
  ['photo with caption', { imageMessage: { caption: 'mi outfit', mimetype: 'image/jpeg' } }, { kind: 'image', body: /^\[foto\] mi outfit$/, visual: 'download' }],
  ['view-once photo', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg' } } } }, { kind: 'image', body: /^\[foto de ver una vez\]$/, visual: 'download' }],
  ['video', { videoMessage: { seconds: 23, caption: 'jaja', jpegThumbnail: thumb } }, { kind: 'video', body: /^\[video 0:23\] jaja$/, visual: 'thumb' }],
  ['gif', { videoMessage: { gifPlayback: true, jpegThumbnail: thumb } }, { kind: 'video', body: /^\[gif\]$/, visual: 'thumb' }],
  ['video note (round)', { ptvMessage: { seconds: 9, jpegThumbnail: thumb } }, { kind: 'video', body: /^\[video nota 0:09\]$/, visual: 'thumb' }],
  ['voice note', { audioMessage: { ptt: true, seconds: 72 } }, { kind: 'audio', body: /^\[nota de voz 1:12\]$/ }],
  ['audio file', { audioMessage: { ptt: false, seconds: 180 } }, { kind: 'audio', body: /^\[audio 3:00\]$/ }],
  ['sticker', { stickerMessage: { isAnimated: false } }, { kind: 'sticker', body: /^\[sticker\]$/, visual: 'download' }],
  ['animated sticker', { stickerMessage: { isAnimated: true } }, { kind: 'sticker', body: /^\[sticker animado\]$/, visual: 'download' }],
  ['document', { documentMessage: { fileName: 'tesis.pdf', pageCount: 40 } }, { kind: 'document', body: /^\[documento: tesis\.pdf, 40 págs\.\]$/ }],
  [
    'document with caption (wrapped)',
    { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'cv.docx', caption: 'revísalo' } } } },
    { kind: 'document', body: /^\[documento: cv\.docx\] revísalo$/ },
  ],
  [
    'location',
    { locationMessage: { degreesLatitude: -12.1211, degreesLongitude: -77.0297, name: 'Larcomar' } },
    { kind: 'location', body: /^\[ubicación: Larcomar \(-12\.12110, -77\.02970\)\]$/ },
  ],
  ['live location', { liveLocationMessage: { caption: 'voy llegando' } }, { kind: 'location', body: /^\[ubicación en tiempo real\] voy llegando$/ }],
  ['contact', { contactMessage: { displayName: 'Ana' } }, { kind: 'contact', body: /^\[contacto: Ana\]$/ }],
  ['contacts', { contactsArrayMessage: { contacts: [{ displayName: 'Ana' }, { displayName: 'Luis' }] } }, { kind: 'contact', body: /^\[contactos: Ana, Luis\]$/ }],
  [
    'poll',
    { pollCreationMessageV3: { name: '¿Pizza o sushi?', options: [{ optionName: 'Pizza' }, { optionName: 'Sushi' }] } },
    { kind: 'poll', body: /^\[encuesta: ¿Pizza o sushi\? — opciones: Pizza \/ Sushi\]$/ },
  ],
  ['reaction', { reactionMessage: { text: '❤️' } }, { kind: 'reaction', body: /^\[reaccionó ❤️ a un mensaje\]$/ }],
  ['reaction removed', { reactionMessage: { text: '' } }, { kind: 'reaction', body: /^\[quitó una reacción\]$/ }],
  [
    'reply to a message',
    { extendedTextMessage: { text: 'jajaja sí', contextInfo: { quotedMessage: { conversation: '¿te acuerdas del perro?' } } } },
    { kind: 'text', body: /^\(respondiendo a «¿te acuerdas del perro\?»\) jajaja sí$/ },
  ],
  [
    'reply to a photo',
    { extendedTextMessage: { text: 'qué lindo', contextInfo: { quotedMessage: { imageMessage: { caption: 'atardecer' } } } } },
    { kind: 'text', body: /^\(respondiendo a «\[foto\] atardecer»\) qué lindo$/ },
  ],
  [
    'reply to your status',
    {
      extendedTextMessage: {
        text: 'dónde es eso',
        contextInfo: { remoteJid: 'status@broadcast', quotedMessage: { imageMessage: {} } },
      },
    },
    { kind: 'text', body: /^\(respondiendo a tu estado «\[foto\]»\) dónde es eso$/ },
  ],
  ['forwarded', { extendedTextMessage: { text: 'meme', contextInfo: { isForwarded: true } } }, { kind: 'text', body: /^\[reenviado\] meme$/ }],
  ['disappearing-mode text', { ephemeralMessage: { message: { conversation: 'hola' } } }, { kind: 'text', body: /^hola$/ }],
  ['unknown type', { orderMessage: { itemCount: 1 } }, { kind: 'other', body: /^\[order\]$/ }],
];

for (const [name, msg, want] of cases) {
  test(name, () => {
    const d = describe(msg);
    assert.ok(d, 'should describe');
    assert.equal(d!.kind, want.kind);
    assert.match(d!.body, want.body);
    assert.equal(d!.visual?.source, want.visual);
  });
}

test('ignores protocol and key-distribution messages', () => {
  assert.equal(describe({ protocolMessage: { type: 0 } } as any), null);
  assert.equal(describe({ senderKeyDistributionMessage: {} } as any), null);
  assert.equal(describe(null), null);
});

test('quoted media never asks for a download', () => {
  const d = describe({ extendedTextMessage: { text: 'x', contextInfo: { quotedMessage: { imageMessage: {} } } } } as any);
  assert.equal(d!.visual, undefined);
});
