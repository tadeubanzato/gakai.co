import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BOX_NAME, addToBox, buildBoxes, entriesFromRules, entryFromOption, isGroupValue, moveHint, removeEntry, toRules } from '../../client/reply-boxes.mjs';

const voices = [{ id: 'vo_mom', name: 'Mom' }, { id: 'vo_friends', name: 'Friends' }];
const GROUP = '120363025246125486@g.us';
const person = (value, label = `+${value}`) => ({ value, label });

test('a suggestion becomes a person or a group, groups carrying a badge', () => {
  assert.deepEqual(entryFromOption(person('18577075969', 'Tadeu')), { value: '18577075969', kind: 'person', label: 'Tadeu', title: '+18577075969' });
  assert.deepEqual(entryFromOption({ value: GROUP, label: 'Carteado' }), { value: GROUP, kind: 'group', label: 'Carteado', title: '120363025246125486', badge: 'Group' });
  assert.equal(isGroupValue(GROUP), true);
  assert.equal(isGroupValue('18577075969'), false);
});

test('the saved list becomes entries, using names where the server knows them', () => {
  const entries = entriesFromRules({ numbers: ['18577075969', '5511999777057'], groups: [GROUP] }, { numbers: { 18577075969: 'Tadeu' }, groups: { [GROUP]: 'Carteado' } });
  assert.deepEqual(entries.map(entry => [entry.kind, entry.label]), [['person', 'Tadeu'], ['person', '+5511999777057'], ['group', 'Carteado']]);
  assert.deepEqual(entriesFromRules(undefined, undefined), []);
});

test('one box per voice, in order, with everyone else last — people and groups together', () => {
  const entries = entriesFromRules({ numbers: ['18577075969', '5511999777057', '15551230000'], groups: [GROUP] }, {});
  const boxes = buildBoxes(entries, { '18577075969': 'vo_mom', '5511999777057': 'vo_friends', [GROUP]: 'vo_friends' }, voices);
  assert.deepEqual(boxes.map(box => [box.name, box.entries.map(entry => entry.value)]), [
    ['Mom', ['18577075969']],
    ['Friends', ['5511999777057', GROUP]],
    [DEFAULT_BOX_NAME, ['15551230000']],
  ]);
});

test('with no voices there is just the one box, and a deleted voice sends its people back to it', () => {
  const entries = entriesFromRules({ numbers: ['18577075969'], groups: [] }, {});
  assert.deepEqual(buildBoxes(entries, {}, []).map(box => box.name), [DEFAULT_BOX_NAME]);
  const boxes = buildBoxes(entries, { '18577075969': 'vo_gone' }, voices);
  assert.deepEqual(boxes.find(box => box.voiceId === '').entries.map(entry => entry.value), ['18577075969']);
});

test('adding inside a box lists the person and gives them that voice in one step', () => {
  const start = { entries: [], assignments: {} };
  const added = addToBox(start, 'vo_mom', person('18577075969', 'Tadeu'));
  assert.deepEqual(toRules(added), { numbers: ['18577075969'], groups: [], assignments: { '18577075969': 'vo_mom' } });
  const inDefault = addToBox(added, '', person('5511999777057'));
  assert.deepEqual(toRules(inDefault).assignments, { '18577075969': 'vo_mom' }, 'the default box assigns no voice');
  assert.deepEqual(toRules(addToBox(start, 'vo_friends', { value: GROUP, label: 'Carteado' })), { numbers: [], groups: [GROUP], assignments: { [GROUP]: 'vo_friends' } });
});

test('adding someone who is already listed moves them — never a duplicate', () => {
  const state = addToBox({ entries: [], assignments: {} }, 'vo_mom', person('18577075969'));
  const moved = addToBox(state, 'vo_friends', person('18577075969'));
  assert.equal(moved.entries.length, 1);
  assert.deepEqual(moved.assignments, { '18577075969': 'vo_friends' });
  const toDefault = addToBox(moved, '', person('18577075969'));
  assert.equal(toDefault.entries.length, 1);
  assert.deepEqual(toDefault.assignments, {}, 'moving to everyone else releases the voice');
});

test('removing someone takes their voice with them', () => {
  let state = addToBox({ entries: [], assignments: {} }, 'vo_mom', person('18577075969'));
  state = addToBox(state, 'vo_friends', person('5511999777057'));
  const after = removeEntry(state, '18577075969');
  assert.deepEqual(toRules(after), { numbers: ['5511999777057'], groups: [], assignments: { '5511999777057': 'vo_friends' } });
  assert.deepEqual(removeEntry(after, 'nobody'), after, 'removing someone not listed changes nothing');
});

test('a suggestion for someone in another box says so; one in this box or not listed says nothing', () => {
  const state = addToBox(addToBox({ entries: [], assignments: {} }, 'vo_mom', person('18577075969')), '', person('5511999777057'));
  assert.equal(moveHint(person('18577075969'), state, voices, 'vo_friends'), 'In Mom — move here');
  assert.equal(moveHint(person('5511999777057'), state, voices, 'vo_friends'), `In ${DEFAULT_BOX_NAME} — move here`);
  assert.equal(moveHint(person('18577075969'), state, voices, 'vo_mom'), null, 'already here');
  assert.equal(moveHint(person('14155550000'), state, voices, 'vo_mom'), null, 'not listed at all');
});
