import { kvSet, q } from '../store/db.js';

export interface StyleProfile {
  sampleSize: number;
  medianChars: number;
  p90Chars: number;
  avgBurst: number;
  capitalStart: number;
  endsWithPeriod: number;
  openingMarks: number;
  emojiRate: number;
  topEmojis: string[];
  laughs: string[];
  topWords: string[];
}

const EMOJI = /\p{Extended_Pictographic}️?/gu;
const LAUGH = /\b(j[aeis]j[aeijs]*|ja+|je+|ji+|xd+|lol|ha(ha)+|js+|jsj[sj]*)\b/gi;
const STOP = new Set(
  'que de la el en y a los se las por un una con no es lo para mi me te tu al del ya si pero como mas más este esta eso todo bien muy hay ahi ahí son fue ser sus le les yo ella vas voy hace está estoy esto ese esa'.split(
    ' ',
  ),
);

const quantile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Measure how *you* write, from your real (non-bot) messages. */
export async function computeStyle(): Promise<StyleProfile | null> {
  const r = await q<{ body: string; ts: Date; from_me: boolean }>(
    `select body, ts, from_me from (
       select body, ts, from_me from messages
       where kind = 'text' and sent_by <> 'bot'
       order by ts desc limit 8000
     ) t order by ts asc`,
  );
  const mine = r.rows.filter((m) => m.from_me).map((m) => m.body);
  if (mine.length < 20) return null;

  // Bursts: consecutive messages from me between her messages.
  const bursts: number[] = [];
  let run = 0;
  for (const m of r.rows) {
    if (m.from_me) run++;
    else if (run) {
      bursts.push(run);
      run = 0;
    }
  }

  const lens = mine.map((b) => b.length);
  const letters = mine.filter((b) => /^\p{L}/u.test(b));
  const emojiCount = new Map<string, number>();
  const laughCount = new Map<string, number>();
  const wordCount = new Map<string, number>();
  let withEmoji = 0;

  for (const b of mine) {
    const em = b.match(EMOJI);
    if (em) {
      withEmoji++;
      for (const e of em) emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1);
    }
    for (const l of b.match(LAUGH) ?? []) {
      const k = l.toLowerCase();
      laughCount.set(k, (laughCount.get(k) ?? 0) + 1);
    }
    for (const w of b.toLowerCase().match(/\p{L}{2,}/gu) ?? []) {
      if (!STOP.has(w)) wordCount.set(w, (wordCount.get(w) ?? 0) + 1);
    }
  }
  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

  const style: StyleProfile = {
    sampleSize: mine.length,
    medianChars: quantile(lens, 0.5),
    p90Chars: quantile(lens, 0.9),
    avgBurst: bursts.length ? bursts.reduce((a, b) => a + b, 0) / bursts.length : 1,
    capitalStart: letters.length ? letters.filter((b) => /^\p{Lu}/u.test(b)).length / letters.length : 0,
    endsWithPeriod: mine.filter((b) => /[^.]\.$/.test(b)).length / mine.length,
    openingMarks: mine.filter((b) => /[¿¡]/.test(b)).length / Math.max(1, mine.filter((b) => /[?!]/.test(b)).length),
    emojiRate: withEmoji / mine.length,
    topEmojis: top(emojiCount, 8),
    laughs: top(laughCount, 3),
    topWords: top(wordCount, 30),
  };
  await kvSet('style', style);
  return style;
}
