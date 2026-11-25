import { config } from './config.js';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: config.timezone,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(d: Date) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset (ms) of the configured timezone at instant d. */
function tzOffset(d: Date) {
  const p = parts(d);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(d.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in the configured timezone to a real Date. */
export function fromLocal(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(guess - tzOffset(new Date(guess)));
}

export function localHour(d = new Date()) {
  return parts(d).h + parts(d).mi / 60;
}

/** If `d` falls in quiet hours, return the instant quiet hours end (+ jitter). Otherwise null. */
export function quietHoursEnd(d: Date, quiet: [number, number] | null): Date | null {
  if (!quiet) return null;
  const [start, end] = quiet;
  const h = localHour(d);
  const inQuiet = start <= end ? h >= start && h < end : h >= start || h < end;
  if (!inQuiet) return null;
  const p = parts(d);
  let wake = fromLocal(p.y, p.mo, p.d, end, 0);
  if (wake.getTime() <= d.getTime()) wake = new Date(wake.getTime() + 86_400_000);
  return wake;
}

export function localStamp(d: Date) {
  return d.toLocaleString('es-PE', {
    timeZone: config.timezone, weekday: 'short', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
