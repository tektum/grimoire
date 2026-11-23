import { describe, expect, it } from 'vitest';
import { addressKey, buildTrustedProxies, forwardedWithoutPorts, normaliseAddress, resolveClientAddress, UNKNOWN_ADDRESS } from '../../src/users/client-address.js';

const trusted = buildTrustedProxies(['10.0.0.0/8', '192.168.1.1', '::1', 'fd00::/8']);

describe('resolveClientAddress', () => {
  it('uses the peer when it is not a trusted proxy, whatever the header says', () => {
    expect(resolveClientAddress(null, '203.0.113.9', trusted)).toBe('203.0.113.9');
    expect(resolveClientAddress('1.2.3.4', '203.0.113.9', trusted)).toBe('203.0.113.9');
    expect(resolveClientAddress('1.2.3.4', '203.0.113.9', buildTrustedProxies([]))).toBe('203.0.113.9');
  });

  it('reads the header from the right behind a trusted proxy', () => {
    expect(resolveClientAddress('198.51.100.7', '10.1.2.3', trusted)).toBe('198.51.100.7');
    expect(resolveClientAddress('6.6.6.6, 198.51.100.7', '10.1.2.3', trusted)).toBe('198.51.100.7');
    expect(resolveClientAddress('198.51.100.7, 10.9.9.9, 192.168.1.1', '10.1.2.3', trusted)).toBe('198.51.100.7');
    expect(resolveClientAddress('2001:db8::1', '::1', trusted)).toBe('2001:db8::1');
  });

  it('keeps the peer when an entry is malformed, and takes the left-most when every hop is trusted', () => {
    expect(resolveClientAddress('not-an-ip', '10.1.2.3', trusted)).toBe('10.1.2.3');
    expect(resolveClientAddress('198.51.100.7, garbage', '10.1.2.3', trusted)).toBe('10.1.2.3');
    expect(resolveClientAddress('', '10.1.2.3', trusted)).toBe('10.1.2.3');
    expect(resolveClientAddress('10.5.5.5, 10.6.6.6', '10.1.2.3', trusted)).toBe('10.5.5.5');
  });

  it('counts mapped spellings as one client and answers unknown without a peer', () => {
    expect(resolveClientAddress(null, '::ffff:203.0.113.9', trusted)).toBe('203.0.113.9');
    expect(resolveClientAddress('::ffff:198.51.100.7', '::ffff:10.1.2.3', trusted)).toBe('198.51.100.7');
    expect(resolveClientAddress(null, undefined, trusted)).toBe(UNKNOWN_ADDRESS);
  });
});

describe('normaliseAddress', () => {
  it('gives one canonical text per client', () => {
    expect(normaliseAddress('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normaliseAddress('::FFFF:102:304')).toBe('1.2.3.4');
    expect(normaliseAddress('2001:DB8:0:0::1')).toBe('2001:db8::1');
    expect(normaliseAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normaliseAddress('::ffff:c633:6407')).toBe('198.51.100.7');
  });

  it('refuses anything that is not an address, and an oversized text', () => {
    expect(normaliseAddress('nonsense')).toBeUndefined();
    expect(normaliseAddress(undefined)).toBeUndefined();
    expect(normaliseAddress('1'.repeat(101))).toBeUndefined();
  });
});

describe('addressKey', () => {
  it('masks IPv6 to the /64 and leaves IPv4 alone', () => {
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('203.0.113.1')).toBe('203.0.113.1');
    expect(addressKey(UNKNOWN_ADDRESS)).toBe(UNKNOWN_ADDRESS);
  });
});

describe('buildTrustedProxies', () => {
  it('accepts an IPv4-mapped range, whose prefix counts 96 more bits, and a single IPv6 address', () => {
    const list = buildTrustedProxies(['::ffff:10.0.0.0/104', '2001:db8::1']);
    expect(resolveClientAddress('192.0.2.1', '10.1.2.3', list)).toBe('192.0.2.1');
    expect(resolveClientAddress('192.0.2.1', '11.1.2.3', list)).toBe('11.1.2.3');
    expect(resolveClientAddress('192.0.2.1', '2001:db8::1', list)).toBe('192.0.2.1');
  });

  it('ignores an entry that is not an address or whose prefix is unusable, without throwing', () => {
    const list = buildTrustedProxies(['', 'bogus', '10.0.0.0/abc', '10.0.0.0/-1']);
    expect(resolveClientAddress('192.0.2.1', '10.1.2.3', list)).toBe('10.1.2.3');
  });
});

describe('forwardedWithoutPorts', () => {
  it('removes ports and brackets from each entry and leaves other text alone', () => {
    expect(forwardedWithoutPorts('198.51.100.7:5678, [2001:db8::5]:443, [2001:db8::6], 2001:db8::7, nonsense')).toBe(
      '198.51.100.7,2001:db8::5,2001:db8::6,2001:db8::7,nonsense',
    );
  });
});
