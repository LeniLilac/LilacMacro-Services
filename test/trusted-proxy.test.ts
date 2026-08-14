import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedProxyAddressResolver } from '../src/infrastructure/trusted-proxy.js';

test('untrusted peers cannot forge visitor identity through forwarding headers', () => {
  const resolver = new TrustedProxyAddressResolver(['10.250.254.3/32']);

  assert.equal(resolver.resolve('203.0.113.9', '198.51.100.4'), '203.0.113.9');
  assert.equal(resolver.resolve('203.0.113.9', ['198.51.100.4']), '203.0.113.9');
});

test('the dedicated tunnel peer supplies one validated Cloudflare visitor address', () => {
  const resolver = new TrustedProxyAddressResolver(['10.250.254.3/32', '2001:db8::/48']);

  assert.equal(resolver.resolve('10.250.254.3', '198.51.100.4'), '198.51.100.4');
  assert.equal(resolver.resolve('2001:db8::7', '2001:db8:ffff::1'), '2001:db8:ffff::1');
});

test('malformed or ambiguous Cloudflare headers collapse to the trusted tunnel peer', () => {
  const resolver = new TrustedProxyAddressResolver(['127.0.0.1/32']);

  assert.equal(resolver.resolve('::ffff:127.0.0.1', '198.51.100.4, 192.0.2.8'), '127.0.0.1');
  assert.equal(resolver.resolve('127.0.0.1', ['198.51.100.4']), '127.0.0.1');
  assert.equal(resolver.resolve('127.0.0.1', undefined), '127.0.0.1');
  assert.equal(resolver.resolve(undefined, '198.51.100.4'), 'unidentified-peer');
});
