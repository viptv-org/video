import { PlayerOperationError, type PlaybackAuthorization } from './types';

/** Validate source-only credentials before handing them to a platform engine. */
export function checkedSourceAuthorization(input?: PlaybackAuthorization): PlaybackAuthorization | undefined {
  if (!input) return undefined;
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  let cookie = input.cookie, userAgent = input.userAgent;
  const valid = (value: unknown): value is string => typeof value === 'string' && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
  const invalid = () => new PlayerOperationError('authorization-failed', 'The source supplied invalid playback authorization.');
  if ((cookie !== undefined && !valid(cookie)) || (userAgent !== undefined && !valid(userAgent)) || Object.keys(input.headers ?? {}).length > 32) throw invalid();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const key = name.toLowerCase();
    if (!/^[a-z0-9-]{1,128}$/i.test(name) || !valid(value) || seen.has(key)
      || ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'upgrade', 'keep-alive', 'te', 'trailer'].includes(key)) throw invalid();
    seen.add(key);
    if (key === 'cookie') { if (cookie !== undefined && cookie !== value) throw invalid(); cookie = value; }
    else if (key === 'user-agent') { if (userAgent !== undefined && userAgent !== value) throw invalid(); userAgent = value; }
    else headers[name] = value;
  }
  return { ...(cookie ? { cookie } : {}), ...(userAgent ? { userAgent } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
}

export function hasSourceAuthorization(input?: PlaybackAuthorization): boolean {
  const value = checkedSourceAuthorization(input);
  return !!(value?.cookie || value?.userAgent || Object.keys(value?.headers ?? {}).length);
}
