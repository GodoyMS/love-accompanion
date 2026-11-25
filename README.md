# love-accompanion

Un solo servicio (Node + Postgres) que conecta tu WhatsApp personal, escucha solo el chat de ella y responde con tu forma de escribir, con tiempos humanos. Tiene un panel con un interruptor que lo apaga al instante.

```
WhatsApp (Baileys, como WhatsApp Web) ─▶ guarda mensaje ─▶ espera a que termine de escribir
   ─▶ Claude (perfil + tu estilo + memorias + ejemplos reales) ─▶ cola con hora de envío
   ─▶ worker: marca leído, "escribiendo…", envía   ← revisa el interruptor antes de cada mensaje
```

## Desplegar en Railway

1. Crea un proyecto con **este repo** (usa el `Dockerfile`) y un **Postgres** (o usa una URL de Supabase).
2. Variables del servicio:
   - `DATABASE_URL` (en Railway: `${{Postgres.DATABASE_URL}}`)
   - `ADMIN_PASSWORD`: contraseña del panel
   - `ANTHROPIC_API_KEY`
   - `PARTNER_NUMBER`: número de ella con código de país, solo dígitos (`51987654321`)
   - Opcionales: `SESSION_SECRET`, `CLAUDE_MODEL`, `CLAUDE_FAST_MODEL`, `TZ_NAME` (por defecto `America/Lima`)
   - Notas de voz: `ELEVENLABS_API_KEY` u `OPENAI_API_KEY` para transcribirlas (sin ninguna, el bot le pide que escriba)
   - `ELEVENLABS_VOICE_ID`: tu voz; si ella manda nota de voz, el bot responde con nota de voz (se apaga en Ajustes)
3. Genera un dominio público, abre el panel y escanea el QR desde **WhatsApp → Dispositivos vinculados**.
4. **Importar**: exporta el chat con ella (sin archivos) y súbelo. Al vincular también llega parte del historial solo.
5. **Perfil**: llena nombres, apodos, gustos, fechas, bromas internas y temas a evitar.
6. Revisa **Tu estilo** y enciende el interruptor. Arranca **apagado** a propósito.

Mantén **1 réplica**: solo un proceso puede tener la sesión. Igual hay un lock en Postgres: en un redeploy, el nuevo proceso espera a que el viejo muera antes de conectar WhatsApp.

## Cómo apagarlo

- Panel: el interruptor. Apagar **cancela la cola** y el worker vuelve a revisar el estado justo antes de escribir y antes de cada mensaje.
- Desde WhatsApp, en tu chat contigo mismo: `/stop`, `/start`, `/pause 60`, `/resume`, `/status`, `/help`.
- Cada encendido, apagado, pausa y reanudación queda en **Eventos** con quién lo hizo (panel, comando, sistema).
- Si le escribes tú desde el celular, el bot **no se apaga**: descarta lo que tenía listo y te da 2 min (ajustable) para seguir tú. Solo vuelve a responder si te quedas callado y ella sigue esperando.

## Cuándo no responde

Te avisa en tu chat contigo mismo y lo deja para ti cuando: es una emergencia clara, te pide llamar o verse ahora, o necesita un dato que solo tú sabes. Por defecto responde solo (y te avisa) cuando está triste o tiene un síntoma leve; peleas y planes con fecha o dinero se activan en Ajustes.

Si duda de que seas tú, el bot **no lo niega**: le manda tu texto de "reemplazo" (editable en Ajustes), te avisa y queda en pausa. Si pregunta directamente si es un bot, se lo dice.

## Comportamiento "humano"

- Espera 8–25 s de silencio para responder todo junto, luego 5–45 s más.
- Marca leído, muestra "escribiendo…" proporcional al largo, divide en 1–3 mensajes si tú escribes así.
- Horas de sueño **apagadas** por defecto (responde a cualquier hora). Si las activas, te avisa a qué hora saldrá cada respuesta retenida.
- Notas de voz de ella: se transcriben; si está activado, le responde con nota de voz en tu voz ("grabando audio…" primero).
- No aparece "en línea" todo el tiempo (`markOnlineOnConnect: false`).
- A veces solo reacciona con un emoji.

Todo se ajusta en **Ajustes**. Baileys no es oficial: esto reduce el riesgo de bloqueo pero no lo elimina.

## Arquitectura

```
src/
  app/        main.ts (arranque, lock, apagado ordenado) · server.ts (API del panel)
  core/       la lógica, sin saber de WhatsApp ni Claude:
              conversation.ts  mensaje de ella → esperar → decidir → encolar
              dispatcher.ts    cola → leído → escribiendo/grabando → enviar (reintentos seguros)
              ports.ts         interfaces Messenger / Brain / Speech / Clock
              context.ts, commands.ts, notify.ts, memory.ts, time.ts
  store/      Postgres: db.ts (esquema idempotente), messages.ts, replies.ts, settings.ts (validación + migraciones)
  adapters/   whatsapp/ (Baileys), claude.ts, voice.ts + stt.ts (ElevenLabs/OpenAI)
  importer/   export de WhatsApp y medición de tu estilo
web/          panel (React + Vite), lo sirve el mismo proceso
```

Garantías que cubren las pruebas:

- **Nunca dos respuestas:** cada respuesta se toma de la cola de forma atómica. Si ella o tú escriben mientras el bot piensa o escribe, lo viejo se descarta.
- **El interruptor siempre gana:** se revisa antes de leer, antes de cada mensaje y después de "escribiendo…".
- **Quién habló último** se decide con la hora del servidor (`received_at`), no con la del celular.
- **Si falla un envío** antes de llegarle, se reintenta hasta 3 veces. Si una parte ya le llegó, nunca se reenvía. Si falla del todo, te avisa.
- **Redeploy:** termina la respuesta en curso antes de apagarse. Si igual se corta, al volver la da por cerrada (no la duplica) y retoma lo que quedó sin responder.
- **El historial importado o sincronizado** es solo contexto: nunca se "responde".

## Desarrollo

```bash
cp .env.example .env    # y completa
npm i
npm run dev             # servidor en :3000
npm run dev:web         # panel con hot reload en :5173 (proxy a :3000)
npm run build && npm start
```

### Pruebas

```bash
createdb la_test                       # Postgres local
npm run test:unit                      # parser, tipos de mensaje, voz, Claude (API simulada)
npm run test:e2e                       # flujo completo: WhatsApp/Claude/voz simulados + Postgres real
TEST_DATABASE_URL=postgres://… npm test
```

Las pruebas de punta a punta (`test/e2e/`) corren el motor real contra Postgres y simulan: ráfagas de mensajes, ella o tú escribiendo a mitad de una respuesta, interruptor y pausa, revelación, notas de voz, ediciones, llamadas perdidas, fallas de red, reinicios, reloj del celular desfasado, ajustes inválidos, la API del panel y el adaptador de WhatsApp.

CI (`.github/workflows/ci.yml`) corre typecheck, todas las pruebas y el build en cada PR y en cada push a `main`.
