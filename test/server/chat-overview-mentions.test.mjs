import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Math.floor(Date.now() / 1000);
const mentionedId = '89249571455071';
const chatId = 'group-chat@g.us';
const accountId = 'mentions-account';

const scratch = await mkdtemp(join(tmpdir(), 'gakai-chat-overview-mentions-'));
process.env.HOME_DATA_DIR = scratch;
process.env.PORT = '0';
process.env.GAKAI_PROVIDER_KIND = 'mock';

const { server, provider } = await import('../../server.mjs');
after(() => server.close());

provider.__test.seedAccount(accountId);
provider.__test.seedChat(accountId, {
  id: chatId, name: 'Family Group', picture: null,
  lastMessage: { body: `Valeu @${mentionedId} !`, text: `Valeu @${mentionedId} !`, timestamp: now, hasMedia: false, system: null },
});
// The inbox preview's mention resolver has no per-message mentionedJid list
// to work from (only the lightweight chat-overview summary), so it resolves
// a bare @<number> against a guessed @s.whatsapp.net jid.
provider.__test.seedContact(accountId, { id: `${mentionedId}@s.whatsapp.net`, name: 'Erica Tanaka' });

if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const setup = await fetch(`${base}/api/app/auth/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'mentions-admin', password: 'a-long-enough-password' }),
});
const cookie = setup.headers.get('set-cookie').split(';')[0];

test('the inbox list preview resolves @123456 mentions to real names, same as the reply preview', async () => {
  const response = await fetch(`${base}/api/app/accounts/${accountId}/chats`, { headers: { cookie } });
  const chats = await response.json();

  assert.equal(response.status, 200);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].lastMessage.body, 'Valeu @Erica Tanaka !');
  assert.equal(chats[0].lastMessage.text, 'Valeu @Erica Tanaka !');
});
