import { expect, it } from 'vitest';
import { checkedSourceAuthorization, hasSourceAuthorization } from '../src/source-authorization';
import { recoveryRequest } from '../src/session-request';
import type { PlaybackAuthorization, PlaybackSessionView, PlaybackStart } from '../src/types';

it('preserves required source headers while separating native Cookie/User-Agent properties', () => {
  expect(checkedSourceAuthorization({ headers: { Cookie: 'source-cookie', 'User-Agent': 'Native client', Referer: 'https://provider.example/', Authorization: 'Bearer source-token' } })).toEqual({
    cookie: 'source-cookie', userAgent: 'Native client', headers: { Referer: 'https://provider.example/', Authorization: 'Bearer source-token' },
  });
  expect(hasSourceAuthorization({ headers: { Authorization: 'Bearer source-token' } })).toBe(true);
});

it('rejects injection, transport-owned headers and ambiguous credentials without echoing values', () => {
  const cases: PlaybackAuthorization[] = [
    { headers: { Host: 'private-token' } }, { headers: { Authorization: 'private-token\r\nInjected: yes' } },
    { headers: { Referer: 'private-token', referer: 'different' } },
    { cookie: 'different', headers: { Cookie: 'private-token' } },
  ];
  for (const value of cases) {
    try { checkedSourceAuthorization(value); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toMatchObject({ code: 'authorization-failed' }); expect(String(error)).not.toContain('private-token'); }
  }
});

it('unsupported source headers request proxy delivery once, not forced encoding', () => {
  const direct = { deliveryKind: 'direct', mode: 'direct' } as PlaybackSessionView;
  const request = { streamId: 'source' } as PlaybackStart;
  const proxy = recoveryRequest(direct, request, 'authorization-unsupported');
  expect(proxy).toMatchObject({ managedOnly: true });
  expect(proxy?.forceTranscode).toBeUndefined();
  expect(recoveryRequest({ ...direct, deliveryKind: 'gateway' }, proxy!, 'authorization-unsupported')).toBeUndefined();
});
