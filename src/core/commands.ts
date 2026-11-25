import { config } from '../config.js';
import { countPending } from '../store/replies.js';
import { getSettings, isPaused, pauseFor, resume, setEnabled } from '../store/settings.js';
import { notify } from './notify.js';

const HELP = `Comandos:
/stop — apaga el bot
/start — lo enciende (y quita cualquier pausa)
/pause 60 — pausa N minutos
/resume — quita la pausa
/status — cómo está`;

/** Commands you send in your own "Message yourself" chat. */
export async function handleCommand(text: string) {
  const [cmd, arg] = text.trim().toLowerCase().split(/\s+/);
  switch (cmd) {
    case '/stop':
    case '/off':
      await setEnabled(false, 'comando /stop');
      return notify('Apagado. No se envía nada más.');
    case '/start':
    case '/on':
      await setEnabled(true, 'comando /start');
      return notify('Encendido.');
    case '/pause': {
      const min = Math.min(7 * 24 * 60, Math.max(1, Math.round(Number(arg)) || 60));
      await pauseFor(min, 'comando /pause');
      return notify(`En pausa ${min} min.`);
    }
    case '/resume':
      await resume('comando /resume');
      return notify('Pausa quitada.');
    case '/status': {
      const s = await getSettings();
      const until = s.pausedUntil ? new Date(s.pausedUntil).toLocaleTimeString('es-PE', { timeZone: config.timezone }) : '';
      return notify(`${s.enabled ? 'Encendido' : 'Apagado'}${isPaused(s) ? `, en pausa hasta ${until}` : ''}. En cola: ${await countPending()}.`);
    }
    case '/help':
    case '/ayuda':
      return notify(HELP);
    default:
      return notify(`No conozco "${cmd}".\n\n${HELP}`);
  }
}
