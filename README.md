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
3. Genera un dominio público, abre el panel y escanea el QR desde **WhatsApp → Dispositivos vinculados**.
4. **Importar**: exporta el chat con ella (sin archivos) y súbelo. Al vincular también llega parte del historial solo.
5. **Perfil**: llena nombres, apodos, gustos, fechas, bromas internas y temas a evitar.
6. Revisa **Tu estilo** y enciende el interruptor. Arranca **apagado** a propósito.

Mantén **1 réplica**: solo un proceso puede tener la sesión. Igual hay un lock en Postgres: en un redeploy, el nuevo proceso espera a que el viejo muera antes de conectar WhatsApp.

## Cómo apagarlo

- Panel: el interruptor. Apagar **cancela la cola** y el worker vuelve a revisar el estado justo antes de escribir y antes de cada mensaje.
- Desde WhatsApp, en tu chat contigo mismo: `/stop`, `/start`, `/pause 60`, `/status`.
- Si le escribes tú desde el celular, el bot **no se apaga**: descarta lo que tenía listo y te da 2 min (ajustable) para seguir tú. Solo vuelve a responder si te quedas callado y ella sigue esperando.

## Cuándo no responde

Te avisa en tu chat contigo mismo y lo deja para ti cuando: es una emergencia real, te pide llamar o verse ahora, pregunta si es un bot, o manda una nota de voz. Por defecto responde solo (y te avisa) cuando está triste o "se siente mal"; peleas y planes con fecha o dinero se activan en Ajustes.

## Comportamiento "humano"

- Espera 8–25 s de silencio para responder todo junto, luego 5–45 s más.
- Marca leído, muestra "escribiendo…" proporcional al largo, divide en 1–3 mensajes si tú escribes así.
- No responde en tus horas de sueño (1–7 a. m. por defecto); esas respuestas salen al "despertar".
- No aparece "en línea" todo el tiempo (`markOnlineOnConnect: false`).
- A veces solo reacciona con un emoji.

Todo se ajusta en **Ajustes**. Baileys no es oficial: esto reduce el riesgo de bloqueo pero no lo elimina.

## Desarrollo

```bash
cp .env.example .env   # y completa
npm i
npm run dev            # servidor en :3000
npm run dev:web        # panel con hot reload en :5173 (proxy a :3000)
npm test               # parser del export
npm run build && npm start
```

`src/wa` conexión y sesión en Postgres · `src/engine` contexto, Claude, cola y envío · `src/importer` export y estilo · `web/` panel.
