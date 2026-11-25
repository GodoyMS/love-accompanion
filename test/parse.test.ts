import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseExport } from '../src/importer/parse.ts';

test('android, spanish, 12h with a. m./p. m. and multi-line', () => {
  const txt = [
    '24/11/25, 10:05 p. m. - Los mensajes y las llamadas están cifrados de extremo a extremo.',
    '24/11/25, 10:05 p. m. - Vale: holaa amor',
    'cómo te fue hoy?',
    '24/11/25, 10:07 p. m. - Godoy: bien bebé jaja',
    '25/11/25, 12:01 a. m. - Vale: <Multimedia omitido>',
    '25/11/25, 12:02 a. m. - Godoy: Se eliminó este mensaje',
  ].join('\n');
  const { lines, senders } = parseExport(txt);
  assert.deepEqual(senders, ['Vale', 'Godoy']);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].body, 'holaa amor\ncómo te fue hoy?');
  assert.deepEqual([lines[0].d, lines[0].mo, lines[0].y, lines[0].h, lines[0].mi], [24, 11, 2025, 22, 5]);
  assert.equal(lines[2].h, 0);
  assert.equal(lines[2].body, '[multimedia]');
});

test('iphone, bracketed with seconds and invisible marks', () => {
  const txt = [
    '[3/11/25, 9:14:02 a. m.] Vale: buenos días ☀️',
    '[3/11/25, 9:20:45 a. m.] Godoy: ‎audio omitido',
    '[13/11/25, 7:01:00 p. m.] Godoy: llegando',
  ].join('\n');
  const { lines } = parseExport(txt);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].body, '[nota de voz]');
  assert.deepEqual([lines[2].d, lines[2].mo, lines[2].h], [13, 11, 19]);
});

test('english US month/day order and 24h', () => {
  const txt = ['11/24/25, 22:30 - Vale: hey', '11/25/25, 08:00 - Godoy: morning'].join('\n');
  const { lines } = parseExport(txt);
  assert.deepEqual([lines[0].mo, lines[0].d, lines[0].h], [11, 24, 22]);
});

test('media placeholders with angle brackets are normalized', async () => {
  const { parseExport } = await import('../src/importer/parse.ts');
  const { lines } = parseExport('25/11/26, 12:23 a. m. - Ella: <sticker omitido>\n25/11/26, 12:24 a. m. - Ella: <imagen omitida>');
  assert.deepEqual(lines.map((l) => l.body), ['[sticker]', '[foto]']);
});
