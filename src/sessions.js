const LIFETIME = 30 * 24 * 60 * 60 * 1000;
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
export class SessionError extends Error {
  constructor(message = 'Срок входа истёк. Введите пароль ещё раз.', status = 401) { super(message); this.status = status; }
}
export function rememberDeviceAvailable(env) {
  return !!(env.DB && env.APP_PASSWORD?.length >= 16 && env.YANDEX_API_KEY && env.YANDEX_BUSINESS_ID && env.YANDEX_CAMPAIGN_ID);
}
export function requestSession(req) {
  const authorization = req.headers.get('authorization');
  if (!authorization) return null;
  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
  if (!match) throw new SessionError();
  return match[1];
}
const fingerprint = env => digest(JSON.stringify([env.APP_PASSWORD, env.YANDEX_API_KEY, String(env.YANDEX_BUSINESS_ID), String(env.YANDEX_CAMPAIGN_ID)]));
const sessionName = async token => 'session:' + await digest(token);
export async function createSession(env) {
  if (!rememberDeviceAvailable(env)) throw new SessionError('Запоминание устройства недоступно: настройте пароль, ключ и хранилище на сервере.', 503);
  const now = Date.now(), token = hex(crypto.getRandomValues(new Uint8Array(32))), expiresAt = now + LIFETIME;
  // Store only a hash of the random bearer token; rotating credentials revokes existing sessions.
  await env.DB.prepare("DELETE FROM jobs WHERE name LIKE 'session:%' AND updated_at < ?").bind(new Date(now - LIFETIME).toISOString()).run();
  await env.DB.prepare('INSERT INTO jobs (name,value,updated_at) VALUES (?,?,?)').bind(await sessionName(token), JSON.stringify({expiresAt, authFingerprint:await fingerprint(env)}), new Date(now).toISOString()).run();
  return {token, expiresAt};
}
export async function verifySession(env, token) {
  if (!rememberDeviceAvailable(env)) throw new SessionError();
  const row = await env.DB.prepare('SELECT value FROM jobs WHERE name=?').bind(await sessionName(token)).first();
  let session;
  try { session = JSON.parse(row?.value || 'null'); } catch { throw new SessionError(); }
  if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() || session.authFingerprint !== await fingerprint(env)) throw new SessionError();
}
export async function revokeSession(env, token) {
  if (token && env.DB) await env.DB.prepare('DELETE FROM jobs WHERE name=?').bind(await sessionName(token)).run();
}
