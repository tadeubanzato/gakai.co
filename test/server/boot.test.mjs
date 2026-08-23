import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-boot-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';

const { server } = await import('../../server.mjs');
after(() => server.close());

test('the Gakai server boots on an ephemeral port and answers /healthz', async () => {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data, { ok: true, service: 'gakai' });
});
