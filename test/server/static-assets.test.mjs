import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-static-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server } = await import('../../server.mjs');
after(() => server.close());
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test('the logo is served as a small PNG image, not a generic download', async () => {
  const response = await fetch(`${base}/logo.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  // A full-colour mascot lockup at 2x its display size; keep it from ballooning into the original artwork.
  assert.ok(bytes.length < 120 * 1024, `logo should stay small for a sidebar image, got ${bytes.length} bytes`);
});

test('the settings screens are served the app page, so refresh and shared links work', async () => {
  const home = await (await fetch(`${base}/`)).text();
  for (const path of ['/settings', '/settings/', '/profile-settings/tadeu', '/profile-settings/tadeu/ai', '/details/tadeu']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/, path);
    assert.equal(await response.text(), home, `${path} is the same single page as /`);
  }
});
