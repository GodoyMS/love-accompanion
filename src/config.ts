function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const digits = (s: string) => s.replace(/\D/g, '');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: req('DATABASE_URL'),
  adminPassword: req('ADMIN_PASSWORD'),
  sessionSecret: process.env.SESSION_SECRET ?? req('ADMIN_PASSWORD') + ':love-accompanion',
  anthropicKey: req('ANTHROPIC_API_KEY'),
  model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-5-5',
  fastModel: process.env.CLAUDE_FAST_MODEL ?? 'claude-haiku-5-5',
  /** Her number, international format, digits only (e.g. 51987654321). */
  partnerNumber: digits(req('PARTNER_NUMBER')),
  timezone: process.env.TZ_NAME ?? 'America/Lima',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export const partnerPnJid = `${config.partnerNumber}@s.whatsapp.net`;
