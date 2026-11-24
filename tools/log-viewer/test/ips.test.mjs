import assert from 'node:assert/strict';
import test from 'node:test';
import { ipPrefix, protectIps } from '../lib/logs.mjs';
import { sampleRows, VIEWS } from '../lib/views.mjs';

test('IPs become network prefixes', () => {
  assert.equal(ipPrefix('203.0.113.77'), '203.0.113.0/24');
  assert.equal(ipPrefix('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3::/48');
  assert.equal(ipPrefix('2a01:4f8:c17:1234::1'), '2a01:4f8:c17::/48');
  assert.equal(ipPrefix('2001:0db8:0000:0042::1'), '2001:db8:0::/48');
  for (const bad of ['', 'not-an-ip', '999.1.1.1', '<script>']) assert.equal(ipPrefix(bad), '-');
});

test('no view ever returns a full IP, and IPs sharing a prefix merge', () => {
  for (const id of Object.keys(VIEWS)) {
    const rows = protectIps(VIEWS[id], sampleRows(id, '24h'));
    const text = JSON.stringify(rows);
    for (const ip of ['192.0.2.14', '192.0.2.201', '198.51.100.7', '203.0.113.50', '2001:db8:85a3::8a2e', '2001:db8:85a3:1::5']) {
      assert.ok(!text.includes(ip), `${id} leaked ${ip}`);
    }
    assert.ok(rows.every((r) => !('ip' in r)), `${id} kept an ip column`);
  }
  const merged = protectIps(VIEWS['top-sources'], [
    { ip: '192.0.2.14', country: 'US', status: '200', requests: '3' },
    { ip: '192.0.2.201', country: 'US', status: '404', requests: '2' },
  ]);
  assert.deepEqual(merged, [{ source: '192.0.2.0/24', country: 'US', requests: '5', errors: '2' }]);
});
