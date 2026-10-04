import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { classifyJid, isDisplayableConversation, JID_KIND, DISPLAYABLE_JID_SQL } from '../../src/domain/jid.mjs';

const cases = [
  ['15551110000@s.whatsapp.net', JID_KIND.INDIVIDUAL, true],
  ['15551110000:7@s.whatsapp.net', JID_KIND.INDIVIDUAL, true],
  ['123456789012345@lid', JID_KIND.INDIVIDUAL, true],
  ['120363000000000000@g.us', JID_KIND.GROUP, true],
  ['status@broadcast', JID_KIND.STATUS, false],
  ['1700000000@broadcast', JID_KIND.BROADCAST, false],
  ['120363000000000000@newsletter', JID_KIND.NEWSLETTER, false],
  ['', JID_KIND.UNSUPPORTED, false],
  [undefined, JID_KIND.UNSUPPORTED, false],
  ['not-a-jid', JID_KIND.UNSUPPORTED, false],
];

for (const [jid, kind, shown] of cases) {
  test(`classifyJid(${JSON.stringify(jid)}) is ${kind}; displayable=${shown}`, () => {
    assert.equal(classifyJid(jid), kind);
    assert.equal(isDisplayableConversation(jid), shown);
  });
}

test('the SQL filter agrees with isDisplayableConversation for every case', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (chat_id TEXT)');
  for (const [jid] of cases) if (jid) db.prepare('INSERT INTO t VALUES (?)').run(jid);
  const inSql = new Set(db.prepare(`SELECT chat_id FROM t WHERE ${DISPLAYABLE_JID_SQL}`).all().map(row => row.chat_id));
  for (const [jid, , shown] of cases) if (jid) assert.equal(inSql.has(jid), shown, jid);
});
