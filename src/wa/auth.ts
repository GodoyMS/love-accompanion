import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { q } from '../db.js';

/** Baileys auth state stored in Postgres, so the service needs no volume. */
export async function usePgAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clear: () => Promise<void>;
}> {
  const read = async (key: string) => {
    const r = await q('select value from wa_auth where key = $1', [key]);
    return r.rowCount ? JSON.parse(r.rows[0].value, BufferJSON.reviver) : null;
  };
  const write = (key: string, value: unknown) =>
    q(
      `insert into wa_auth (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value, BufferJSON.replacer)],
    );
  const remove = (key: string) => q('delete from wa_auth where key = $1', [key]);

  const creds: AuthenticationCreds = (await read('creds')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          if (!ids.length) return out;
          const keys = ids.map((id) => `${type}:${id}`);
          const r = await q('select key, value from wa_auth where key = any($1)', [keys]);
          for (const row of r.rows) {
            const id = row.key.slice(type.length + 1);
            let value = JSON.parse(row.value, BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            out[id] = value;
          }
          return out;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category in data) {
            const entries = data[category as keyof SignalDataTypeMap] ?? {};
            for (const id in entries) {
              const value = entries[id];
              const key = `${category}:${id}`;
              tasks.push(value ? write(key, value) : remove(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await write('creds', creds);
    },
    clear: async () => {
      await q('delete from wa_auth');
    },
  };
}
