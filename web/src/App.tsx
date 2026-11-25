import { useCallback, useEffect, useRef, useState } from 'react';
import { api, Unauthorized } from './api';

type Settings = {
  enabled: boolean;
  pausedUntil: string | null;
  debounceSec: [number, number];
  replyDelaySec: [number, number];
  quietHours: [number, number] | null;
  handBackMinutes: number;
  voiceReplies: boolean;
  autonomy: { feelings: boolean; health: boolean; conflicts: boolean; plans: boolean };
  voice: { model: string; speed: number; stability: number; similarity: number; style: number };
  disclosure: { doubtText: string; directText: string; pauseHours: number };
};
type Status = {
  settings: Settings;
  paused: boolean;
  wa: { connected: boolean; me: string | null; qr: string | null; status: string };
  partner: string | null;
  missing: string[];
  stt: 'elevenlabs' | 'openai' | null;
  voice: boolean;
  pending: { id: number; send_at: string; parts: string[]; reaction: string | null; is_voice: boolean }[];
  counts: { total: number; by_bot: number; first_ts: string | null };
  events: { ts: string; type: string; detail: string | null }[];
};

const time = (s: string) =>
  new Date(s).toLocaleString('es-PE', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = (s: string) => new Date(s).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tab, setTab] = useState<'chat' | 'perfil' | 'importar' | 'ajustes' | 'eventos'>('chat');

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>('/api/status'));
      setAuthed(true);
    } catch (e) {
      if (e instanceof Unauthorized) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  if (authed === false) return <Login onDone={refresh} />;
  if (!status) return <div className="center muted">Cargando…</div>;

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">love-accompanion</span>
        <span className={`pill ${status.wa.connected ? 'ok' : 'warn'}`}>
          {status.wa.connected ? `WhatsApp +${status.wa.me?.split('@')[0]}` : `WhatsApp: ${status.wa.status}`}
        </span>
      </header>

      {status.missing.length > 0 && (
        <section className="card notice">
          Falta configurar en Railway: <b>{status.missing.join(', ')}</b>. El panel y el QR funcionan, pero no responderá hasta que estén.
        </section>
      )}
      {status.partner && (
        <p className="muted small">
          Escuchando solo a {status.partner} ·{' '}
          {status.stt ? `notas de voz: transcribe con ${status.stt === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}` : 'notas de voz: sin transcripción (agrega ELEVENLABS_API_KEY u OPENAI_API_KEY)'}
          {' · '}
          {status.voice ? 'responde audios con tu voz' : 'respuestas por voz: falta ELEVENLABS_VOICE_ID'}
        </p>
      )}

      <KillSwitch status={status} onChange={refresh} />

      {status.wa.qr && (
        <section className="card qr">
          <h2>Vincula tu WhatsApp</h2>
          <p className="muted">WhatsApp → Dispositivos vinculados → Vincular un dispositivo.</p>
          <img src={status.wa.qr} alt="QR para vincular WhatsApp" />
        </section>
      )}

      {status.pending.length > 0 && <Queue status={status} onChange={refresh} />}

      <nav className="tabs">
        {(['chat', 'perfil', 'importar', 'ajustes', 'eventos'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      {tab === 'chat' && <Chat />}
      {tab === 'perfil' && <Profile />}
      {tab === 'importar' && <Import />}
      {tab === 'ajustes' && <SettingsForm settings={status.settings} onSaved={refresh} />}
      {tab === 'eventos' && <Events events={status.events} />}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <form
      className="center login"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/api/login', { body: { password: pw } });
          onDone();
        } catch (e) {
          setErr((e as Error).message);
        }
      }}
    >
      <span className="brand">love-accompanion</span>
      <input type="password" placeholder="Contraseña" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
      <button className="primary">Entrar</button>
      {err && <p className="error">{err}</p>}
    </form>
  );
}

function KillSwitch({ status, onChange }: { status: Status; onChange: () => void }) {
  const { enabled } = status.settings;
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onChange();
    } finally {
      setBusy(false);
    }
  };
  const live = enabled && !status.paused;

  return (
    <section className={`card switch ${live ? 'live' : ''}`}>
      <div className="switch-row">
        <div>
          <div className="state">{!enabled ? 'Apagado' : status.paused ? 'En pausa' : 'Respondiendo'}</div>
          <div className="muted small">
            {!enabled && 'No se envía nada. Los mensajes se siguen guardando.'}
            {enabled && status.paused && `Vuelve a las ${clock(status.settings.pausedUntil!)}`}
            {live && 'Responde por ti con tiempos humanos.'}
          </div>
        </div>
        <button
          className={`toggle ${enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="Interruptor principal"
          disabled={busy}
          onClick={() => act(() => api('/api/switch', { body: { enabled: !enabled } }))}
        >
          <span />
        </button>
      </div>
      {enabled && (
        <div className="row gap">
          {status.paused ? (
            <button disabled={busy} onClick={() => act(() => api('/api/resume', { method: 'POST' }))}>Reanudar</button>
          ) : (
            <>
              <button disabled={busy} onClick={() => act(() => api('/api/pause', { body: { minutes: 30 } }))}>Pausa 30 min</button>
              <button disabled={busy} onClick={() => act(() => api('/api/pause', { body: { minutes: 180 } }))}>3 h</button>
              <button disabled={busy} onClick={() => act(() => api('/api/pause', { body: { minutes: 720 } }))}>12 h</button>
            </>
          )}
        </div>
      )}
      <p className="muted small">Atajo: escríbete <code>/stop</code>, <code>/start</code> o <code>/pause 60</code> en tu chat contigo mismo.</p>
    </section>
  );
}

function Queue({ status, onChange }: { status: Status; onChange: () => void }) {
  return (
    <section className="card">
      <div className="row between">
        <h2>Por enviar</h2>
        <button className="link danger" onClick={async () => { await api('/api/pending', { method: 'DELETE' }); onChange(); }}>
          Cancelar todo
        </button>
      </div>
      {status.pending.map((p) => (
        <div key={p.id} className="queued">
          <div className="muted small">{clock(p.send_at)}</div>
          <div className="grow">
            {p.reaction && <span className="bubble me">{p.reaction}</span>}
            {p.parts.map((t, i) => <div key={i} className="bubble me bot">{p.is_voice ? '🎙️ ' : ''}{t}</div>)}
          </div>
          <div className="row gap">
            <button className="link" onClick={async () => { await api(`/api/pending/${p.id}/now`, { method: 'POST' }); onChange(); }}>
              Enviar ya
            </button>
            <button className="link danger" onClick={async () => { await api(`/api/pending/${p.id}`, { method: 'DELETE' }); onChange(); }}>
              Cancelar
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function Chat() {
  const [msgs, setMsgs] = useState<{ id: number; from_me: boolean; sent_by: string; kind: string; body: string; ts: string }[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => setMsgs(await api('/api/messages')), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs.length]);

  return (
    <section className="card chat">
      {msgs.length === 0 && <p className="muted">Aún no hay mensajes. Importa el chat o espera a que sincronice el historial.</p>}
      {msgs.map((m) => (
        <div key={m.id} className={`msg ${m.from_me ? 'mine' : ''}`}>
          <div className={`bubble ${m.from_me ? 'me' : ''} ${m.sent_by === 'bot' ? 'bot' : ''}`}>{m.body}</div>
          <div className="meta">{time(m.ts)}{m.sent_by === 'bot' && ' · bot'}</div>
        </div>
      ))}
      <div ref={end} />
    </section>
  );
}

function Profile() {
  const [profile, setProfile] = useState('');
  const [styleText, setStyleText] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const [memories, setMemories] = useState<{ id: number; fact: string; source: string; expires_at: string | null }[]>([]);
  const [fact, setFact] = useState('');
  const [working, setWorking] = useState(false);

  const loadMem = async () => setMemories(await api('/api/memories'));
  useEffect(() => {
    api('/api/profile').then((r) => {
      setProfile(r.profile);
      setStyleText(r.styleText);
    });
    loadMem();
  }, []);

  return (
    <>
      <section className="card">
        <div className="row between">
          <h2>Perfil</h2>
          <button
            className="primary"
            disabled={saved}
            onClick={async () => {
              await api('/api/profile', { method: 'PUT', body: { profile } });
              setSaved(true);
            }}
          >
            {saved ? 'Guardado' : 'Guardar'}
          </button>
        </div>
        <p className="muted small">Nombres, apodos, gustos, fechas, bromas internas, temas a evitar. Esto va en cada respuesta.</p>
        <textarea rows={22} value={profile} onChange={(e) => { setProfile(e.target.value); setSaved(false); }} />
      </section>

      <section className="card">
        <div className="row between">
          <h2>Tu estilo</h2>
          <button onClick={async () => setStyleText((await api('/api/style/recompute', { method: 'POST' })).styleText)}>Recalcular</button>
        </div>
        {styleText ? <pre className="style">{styleText}</pre> : <p className="muted">Importa el chat para medir cómo escribes.</p>}
      </section>

      <section className="card">
        <div className="row between">
          <h2>Memorias</h2>
          <button
            disabled={working}
            onClick={async () => {
              setWorking(true);
              try { await api('/api/memories/extract', { method: 'POST' }); await loadMem(); } finally { setWorking(false); }
            }}
          >
            {working ? 'Leyendo…' : 'Extraer de la última semana'}
          </button>
        </div>
        <form
          className="row gap"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!fact.trim()) return;
            await api('/api/memories', { body: { fact } });
            setFact('');
            loadMem();
          }}
        >
          <input className="grow" placeholder="Ej: Su mejor amiga se llama Ana" value={fact} onChange={(e) => setFact(e.target.value)} />
          <button>Añadir</button>
        </form>
        <ul className="memories">
          {memories.map((m) => (
            <li key={m.id}>
              <span className="grow">{m.fact}{m.expires_at && <span className="muted small"> · hasta {time(m.expires_at)}</span>}</span>
              <button className="link danger" onClick={async () => { await api(`/api/memories/${m.id}`, { method: 'DELETE' }); loadMem(); }}>×</button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Import() {
  const [file, setFile] = useState<File | null>(null);
  const [senders, setSenders] = useState<string[] | null>(null);
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const send = async (me?: string) => {
    if (!file) return;
    setBusy(true);
    setResult('');
    try {
      const form = new FormData();
      if (me) form.append('me', me);
      form.append('file', file);
      const r = await api('/api/import', { form });
      if (r.needsSender) setSenders(r.senders);
      else {
        setSenders(null);
        setResult(`Listo: ${r.inserted} mensajes nuevos de ${r.total} en el archivo.`);
      }
    } catch (e) {
      setResult((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Importar historial</h2>
      <ol className="muted small steps">
        <li>En WhatsApp abre el chat con ella → ⋮ / nombre → Más → <b>Exportar chat</b> → <b>Sin archivos</b>.</li>
        <li>Sube aquí el .txt o .zip. Puedes volver a importarlo cuando quieras: no duplica.</li>
      </ol>
      <input type="file" accept=".txt,.zip" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSenders(null); setResult(''); }} />
      {!senders && <button className="primary" disabled={!file || busy} onClick={() => send()}>{busy ? 'Leyendo…' : 'Subir'}</button>}
      {senders && (
        <div>
          <p>¿Cuál de estos eres tú?</p>
          <div className="row gap wrap">
            {senders.map((s) => <button key={s} disabled={busy} onClick={() => send(s)}>{s}</button>)}
          </div>
        </div>
      )}
      {result && <p>{result}</p>}
    </section>
  );
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [s, setLocal] = useState(settings);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const setS = (next: Settings) => {
    setLocal(next);
    setDirty(true);
    setMsg('');
  };
  // Keep in sync with the server (e.g. changed from WhatsApp) unless you're mid-edit.
  const serverKey = JSON.stringify(settings);
  useEffect(() => {
    if (!dirty) setLocal(settings);
  }, [serverKey, dirty]);
  const num = (v: string) => Math.max(0, Number(v) || 0);
  const pair = (k: 'debounceSec' | 'replyDelaySec', i: 0 | 1, v: string) => {
    const next = [...s[k]] as [number, number];
    next[i] = num(v);
    setS({ ...s, [k]: next });
  };

  return (
    <section className="card form">
      <h2>Ajustes</h2>
      <label>Espera a que ella termine de escribir (seg)
        <div className="row gap"><input type="number" value={s.debounceSec[0]} onChange={(e) => pair('debounceSec', 0, e.target.value)} /> a <input type="number" value={s.debounceSec[1]} onChange={(e) => pair('debounceSec', 1, e.target.value)} /></div>
      </label>
      <label>Demora extra antes de responder (seg)
        <div className="row gap"><input type="number" value={s.replyDelaySec[0]} onChange={(e) => pair('replyDelaySec', 0, e.target.value)} /> a <input type="number" value={s.replyDelaySec[1]} onChange={(e) => pair('replyDelaySec', 1, e.target.value)} /></div>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.voiceReplies} onChange={(e) => setS({ ...s, voiceReplies: e.target.checked })} />
        Si ella manda nota de voz, responder con nota de voz (tu voz de ElevenLabs)
      </label>
      {s.voiceReplies && <VoiceTuner voice={s.voice} onChange={(voice) => setS({ ...s, voice })} />}
      <label className="check">
        <input type="checkbox" checked={!!s.quietHours} onChange={(e) => setS({ ...s, quietHours: e.target.checked ? [1, 7] : null })} />
        Horas de sueño: de noche deja las respuestas para la mañana
      </label>
      {s.quietHours && (
        <label>Duermo de
          <div className="row gap">
            <input type="number" min={0} max={23} value={s.quietHours[0]} onChange={(e) => setS({ ...s, quietHours: [Math.min(23, num(e.target.value)), s.quietHours![1]] })} /> a
            <input type="number" min={0} max={23} value={s.quietHours[1]} onChange={(e) => setS({ ...s, quietHours: [s.quietHours![0], Math.min(23, num(e.target.value))] })} /> h
          </div>
        </label>
      )}
      <label>Si le escribes tú, minutos que espera a que sigas tú antes de volver a responder
        <input type="number" value={s.handBackMinutes} onChange={(e) => setS({ ...s, handBackMinutes: num(e.target.value) })} />
        <span className="muted small">El bot no se apaga: si contestas tú, descarta lo que tenía listo.</span>
      </label>
      <fieldset className="autonomy">
        <legend>Temas delicados que responde solo (y te avisa)</legend>
        {([
          ['feelings', 'Cuando está triste, cansada o "se siente mal"'],
          ['health', 'Síntomas físicos (la anima a ir al médico si es fuerte)'],
          ['conflicts', 'Cuando está molesta contigo o hay un reclamo'],
          ['plans', 'Planes con fecha, dinero o promesas (sin confirmar nada)'],
        ] as const).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={s.autonomy[k]} onChange={(e) => setS({ ...s, autonomy: { ...s.autonomy, [k]: e.target.checked } })} />
            {label}
          </label>
        ))}
        <p className="muted small">Siempre te pasa la conversación si es una emergencia clara (peligro, le cuesta respirar, sangrado, desmayo, hacerse daño) .</p>
      </fieldset>
      <fieldset className="autonomy">
        <legend>Si duda de que seas tú</legend>
        <label>Cuando nota algo raro ("¿eres tú?", "¿qué le pasó a tu voz?")
          <textarea rows={3} value={s.disclosure.doubtText} onChange={(e) => setS({ ...s, disclosure: { ...s.disclosure, doubtText: e.target.value } })} />
        </label>
        <label>Cuando pregunta directamente si es un bot o una IA
          <textarea rows={3} value={s.disclosure.directText} onChange={(e) => setS({ ...s, disclosure: { ...s.disclosure, directText: e.target.value } })} />
        </label>
        <label>Después queda en pausa (horas)
          <input type="number" value={s.disclosure.pauseHours} onChange={(e) => setS({ ...s, disclosure: { ...s.disclosure, pauseHours: num(e.target.value) } })} />
        </label>
        <p className="muted small">El bot nunca niega que no eres tú ni inventa una excusa. Te avisa al mismo tiempo y vuelve con /start.</p>
      </fieldset>
      <button
        className="primary"
        disabled={!dirty || saving}
        onClick={async () => {
          setSaving(true);
          try {
            // Only preferences: on/off and pause are never sent from here.
            const { enabled: _e, pausedUntil: _p, ...prefs } = s;
            setLocal(await api<Settings>('/api/settings', { method: 'PUT', body: prefs }));
            setDirty(false);
            setMsg('Guardado');
            onSaved();
          } catch (e) {
            setMsg((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? 'Guardando…' : dirty ? 'Guardar' : 'Guardado'}
      </button>
      {msg && <span className="muted small"> {msg}</span>}

      <hr />
      <button
        className="link danger"
        onClick={async () => {
          if (!confirm('¿Desvincular WhatsApp? Tendrás que escanear el QR de nuevo.')) return;
          await api('/api/wa/unlink', { method: 'POST' });
          onSaved();
        }}
      >
        Desvincular WhatsApp
      </button>
    </section>
  );
}

function Events({ events }: { events: Status['events'] }) {
  return (
    <section className="card">
      <h2>Eventos</h2>
      <ul className="events">
        {events.map((e, i) => (
          <li key={i}><span className="muted small">{time(e.ts)}</span> <b>{e.type}</b> {e.detail}</li>
        ))}
      </ul>
    </section>
  );
}

function VoiceTuner({ voice, onChange }: { voice: Settings['voice']; onChange: (v: Settings['voice']) => void }) {
  const [text, setText] = useState('Hola amor, ¿cómo estás? Aquí estoy, tranquilo, pensando en ti. Cuéntame cómo te fue hoy.');
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const slider = (k: 'speed' | 'stability' | 'similarity' | 'style', label: string, min: number, max: number, hint: string) => (
    <label>
      {label}: <b>{voice[k].toFixed(2)}</b> <span className="muted small">{hint}</span>
      <input type="range" min={min} max={max} step={0.05} value={voice[k]} onChange={(e) => onChange({ ...voice, [k]: Number(e.target.value) })} />
    </label>
  );
  return (
    <fieldset className="autonomy">
      <legend>Tu voz (ElevenLabs)</legend>
      <label>Modelo
        <select value={voice.model} onChange={(e) => onChange({ ...voice, model: e.target.value })}>
          <option value="eleven_multilingual_v2">Multilingual v2: el más estable y natural</option>
          <option value="eleven_flash_v2_5">Flash v2.5: fuerza español, más rápido</option>
          <option value="eleven_v3">v3: más expresivo</option>
        </select>
      </label>
      {slider('speed', 'Velocidad', 0.7, 1.2, '(menos = más pausado)')}
      {slider('stability', 'Estabilidad', 0, 1, '(más = más calmado y parejo)')}
      {slider('similarity', 'Parecido a tu voz', 0, 1, '(más = conserva tu acento)')}
      {slider('style', 'Estilo', 0, 1, '(0 = neutral, más = más actuado)')}
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row gap">
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              const res = await fetch('/api/voice/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voice }) });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
              if (src) URL.revokeObjectURL(src);
              setSrc(URL.createObjectURL(await res.blob()));
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Generando…' : '▶ Probar voz'}
        </button>
        <span className="muted small">Solo lo escuchas tú. Guarda abajo cuando te guste.</span>
      </div>
      {src && <audio controls autoPlay src={src} />}
      {err && <p className="error">{err}</p>}
    </fieldset>
  );
}
