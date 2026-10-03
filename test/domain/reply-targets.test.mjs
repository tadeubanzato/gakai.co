import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRuleLabels, searchGroups, searchPeople } from '../../src/domain/reply-targets.mjs';

const chats = [
  { id: '5511999777057@s.whatsapp.net', name: null, timestamp: 300 },
  { id: '18577075969@s.whatsapp.net', name: 'Tadeu Banzato', timestamp: 200 },
  { id: '14153180419@s.whatsapp.net', name: null, timestamp: 100 },
  { id: '120363025246125486@g.us', name: 'Família Banzato', timestamp: 250 },
  { id: '120363111111111111@g.us', name: 'Work Team', timestamp: 150 },
  { id: 'status@broadcast', name: null, timestamp: 400 },
];
// Contacts use the store's row shape (contact_id) for some rows and id for others.
const contacts = [
  { contact_id: '5511999777057@s.whatsapp.net', name: 'Marina Souza', phone: '5511999777057' },
  { id: '14153180419@s.whatsapp.net', name: 'José Álvares', phone: '14153180419' },
  { contact_id: '5511888000111@s.whatsapp.net', name: 'Carlos Never-Messaged', phone: '5511888000111' },
];

test('an empty query suggests recent conversations, named from contacts, newest first, never status or groups', () => {
  const results = searchPeople({ chats, contacts, query: '' });
  assert.deepEqual(results.map(r => r.value), ['5511999777057', '18577075969', '14153180419']);
  assert.equal(results[0].label, 'Marina Souza', 'a chat with no name takes its contact name');
  assert.equal(results[0].detail, '+5511999777057');
});

test('typing a name finds people regardless of case and accents', () => {
  assert.deepEqual(searchPeople({ chats, contacts, query: 'jose' }).map(r => r.label), ['José Álvares']);
  assert.deepEqual(searchPeople({ chats, contacts, query: 'MARI' }).map(r => r.label), ['Marina Souza']);
});

test('typing digits finds a number with or without the country code, and with punctuation', () => {
  for (const query of ['999777', '5511999777', '+55 (11) 99977', '11999777', '0011999777']) {
    assert.deepEqual(searchPeople({ chats, contacts, query }).map(r => r.value), ['5511999777057'], query);
  }
  assert.deepEqual(searchPeople({ chats, contacts, query: '857 707' }).map(r => r.value), ['18577075969']);
});

test('contacts never messaged are still found by name, but only after the conversations', () => {
  assert.deepEqual(searchPeople({ chats, contacts, query: 'carlos' }).map(r => r.value), ['5511888000111']);
});

test('an already-selected person is not offered again', () => {
  const results = searchPeople({ chats, contacts, query: '', exclude: ['+55 11 99977-7057'] });
  assert.deepEqual(results.map(r => r.value), ['18577075969', '14153180419']);
});

test('a valid number that is in no conversation is offered as "Add this number"', () => {
  const results = searchPeople({ chats, contacts, query: '+44 20 7946 0958' });
  assert.deepEqual(results, [{ value: '442079460958', label: '+442079460958', detail: 'Add this number', custom: true }]);
  assert.deepEqual(searchPeople({ chats, contacts, query: '5511999777057' }).filter(r => r.custom), [], 'an existing match is not duplicated as custom');
  assert.deepEqual(searchPeople({ chats, contacts, query: '999777' }).filter(r => r.custom), [], 'a half-typed known number is never offered as a new one');
});

test('searchGroups matches names without accents, newest first, and ignores people', () => {
  assert.deepEqual(searchGroups({ chats, query: 'familia' }).map(r => r.label), ['Família Banzato']);
  assert.deepEqual(searchGroups({ chats, query: '' }).map(r => r.label), ['Família Banzato', 'Work Team']);
  assert.equal(searchGroups({ chats, query: '', exclude: ['120363025246125486'] }).length, 1);
});

test('a long group id not in the chat list is offered as "Add this group ID", a short number is not', () => {
  assert.deepEqual(searchGroups({ chats, query: '120363999999999999' }), [{ value: '120363999999999999@g.us', label: '120363999999999999', detail: 'Add this group ID', custom: true }]);
  assert.deepEqual(searchGroups({ chats, query: '5511' }), []);
});

test('resolveRuleLabels names saved numbers and groups, and leaves unknown ones null', () => {
  const labels = resolveRuleLabels({ numbers: ['5511999777057', '442079460958'], groups: ['120363025246125486@g.us', '999999999999@g.us'] }, { chats, contacts });
  assert.deepEqual(labels, {
    numbers: { 5511999777057: 'Marina Souza', 442079460958: null },
    groups: { '120363025246125486@g.us': 'Família Banzato', '999999999999@g.us': null },
  });
});
