import assert from 'node:assert/strict';
import test from 'node:test';
import { groupInfoView, personInfoView } from '../../src/domain/chat-info.mjs';

test('a person: name, number, About and a business profile when there is one', () => {
  const view = personInfoView({ id: '5511943346620@s.whatsapp.net', name: 'Mom', phone: '+55 11 94334-6620', about: '  Hey there!  ', aboutSetAt: '2026-01-02T03:04:05.000Z', business: null });
  assert.equal(view.kind, 'person');
  assert.equal(view.name, 'Mom');
  assert.equal(view.phone, '5511943346620');
  assert.equal(view.about, 'Hey there!');
  assert.equal(view.aboutSetAt, '2026-01-02T03:04:05.000Z');
  assert.equal(view.business, null);
  const shop = personInfoView({ id: 'x', name: 'Padaria', phone: '15551230000', business: { description: 'Pão fresco', website: ['https://p.example', ''], email: '', category: 'Bakery' } });
  assert.deepEqual(shop.business, { description: 'Pão fresco', email: null, address: null, category: 'Bakery', website: ['https://p.example'] });
});

test('a person with no name falls back to their number, and a hidden About is simply absent', () => {
  const view = personInfoView({ id: 'x', phone: '15551230000', about: '' });
  assert.match(view.name, /555/);
  assert.equal(view.about, null);
  assert.equal(personInfoView({ id: 'x', name: 'Ana' }).phone, null);
});

const describe = rawId => ({ id: rawId, number: rawId.split('@')[0], name: { 'a@s.whatsapp.net': 'Ana', 'b@s.whatsapp.net': 'Bruno', 'me@s.whatsapp.net': 'You', 'z@s.whatsapp.net': 'Zed' }[rawId] || rawId, isMe: rawId === 'me@s.whatsapp.net' });

test('a group: subject, description, who made it and when, with you first, then admins, then everyone by name', () => {
  const view = groupInfoView({
    id: '120363025246125486@g.us', subject: 'Carteado', desc: 'Sextas às 20h', creation: 1700000000, owner: 'a@s.whatsapp.net', size: 4, announce: true,
    participants: [{ id: 'z@s.whatsapp.net' }, { id: 'b@s.whatsapp.net', admin: 'admin' }, { id: 'a@s.whatsapp.net', admin: 'superadmin' }, { id: 'me@s.whatsapp.net' }],
  }, describe, 'https://pic');
  assert.equal(view.name, 'Carteado');
  assert.equal(view.description, 'Sextas às 20h');
  assert.equal(view.createdAt, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(view.createdBy, { id: 'a@s.whatsapp.net', name: 'Ana' });
  assert.equal(view.memberCount, 4);
  assert.equal(view.onlyAdminsCanWrite, true);
  assert.deepEqual(view.members.map(member => [member.name, member.admin]), [['You', null], ['Ana', 'superadmin'], ['Bruno', 'admin'], ['Zed', null]]);
  assert.equal(view.picture, 'https://pic');
});

test('a group with missing details still has a name and an empty, safe shape', () => {
  const view = groupInfoView({ id: 'g@g.us', participants: [] }, describe);
  assert.equal(view.name, 'Group');
  assert.equal(view.description, null);
  assert.equal(view.createdAt, null);
  assert.deepEqual(view.members, []);
  assert.equal(view.memberCount, 0);
});
