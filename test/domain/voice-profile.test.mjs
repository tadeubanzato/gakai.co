import assert from 'node:assert/strict';
import test from 'node:test';
import { TEMPLATES, compileVoicePrompt, parseVoiceYaml, MAX_VOICES_PER_ACCOUNT } from '../../src/domain/voice-profile.mjs';

const ok = yaml => { const result = parseVoiceYaml(yaml); assert.equal(result.ok, true, JSON.stringify(result.errors)); return result.profile; };
const errors = yaml => { const result = parseVoiceYaml(yaml); assert.equal(result.ok, false); return result.errors; };

test('every shipped template is a valid voice profile', () => {
  assert.ok(TEMPLATES.length >= 3);
  for (const template of TEMPLATES) assert.equal(parseVoiceYaml(template.yaml).ok, true, `${template.id}: ${JSON.stringify(parseVoiceYaml(template.yaml).errors)}`);
  assert.equal(MAX_VOICES_PER_ACCOUNT, 5);
});

test('a minimal profile needs only a name', () => {
  assert.deepEqual(ok('name: Mom'), { name: 'Mom' });
  assert.match(errors('voice: warm')[0].message, /"name" is required/);
});

test('a mistyped key is an error with a hint, never silently ignored', () => {
  const [error] = errors('name: Mom\nnevr:\n  - promise plans\n');
  assert.match(error.message, /Unknown key "nevr"\. Did you mean "never"\?/);
  assert.equal(error.line, 2, 'it points at the right line');
  assert.match(errors('name: Mom\nrandom_thing: 1')[0].message, /Allowed keys/);
});

test('values are checked: types, ranges and lengths', () => {
  assert.match(errors('name: Mom\nmax_sentences: 40')[0].message, /1 to 10/);
  assert.match(errors('name: Mom\nmax_sentences: two')[0].message, /1 to 10/);
  assert.match(errors('name: Mom\nemoji: lots')[0].message, /none, sparingly, often/);
  assert.match(errors('name: Mom\nnever: promise plans')[0].message, /list/);
  assert.match(errors(`name: ${'x'.repeat(61)}`)[0].message, /"name"/);
  assert.match(errors('name: Mom\nexamples:\n  - they: hi\n')[0].message, /"they:".*"me:"/);
  assert.match(errors('name: Mom\nexamples:\n  - they: hi\n    me: hello\n    extra: no\n')[0].message, /exactly/);
  assert.match(errors('name: Mom\ngroups:\n  tagged: yes\n')[0].message, /Unknown group key "tagged"/);
});

test('facts_about_me can be empty to allow none, a list, or key: value pairs', () => {
  assert.deepEqual(ok('name: A\nfacts_about_me: []').facts_about_me, []);
  assert.deepEqual(ok('name: A\nfacts_about_me:\n  - lives in Boston\n').facts_about_me, ['lives in Boston']);
  assert.deepEqual(ok('name: A\nfacts_about_me:\n  hours: 9 to 6\n').facts_about_me, { hours: '9 to 6' });
});

test('broken YAML is reported with its line, and an empty or oversized file is refused', () => {
  const [error] = errors('name: Mom\n  voice: [unclosed\n');
  assert.ok(error.message.length > 0);
  assert.match(errors('')[0].message, /empty/);
  assert.match(errors('name: A\ninstructions: ' + 'x'.repeat(21000))[0].message, /too long/);
  assert.match(errors('- just\n- a list\n')[0].message, /list of "key: value"/);
});

test('YAML tricks are not honoured: aliases and custom tags cannot run or expand anything', () => {
  const aliased = parseVoiceYaml('name: &a Mom\nrole: *a\n');
  assert.equal(aliased.ok, false, 'aliases are refused');
  assert.match(aliased.errors[0].message, /anchors and aliases/);
  const tagged = parseVoiceYaml('name: Mom\nrole: !!js/function "function(){return 1}"\n');
  assert.equal(tagged.ok === true ? typeof tagged.profile.role : 'rejected', tagged.ok ? 'string' : 'rejected', 'a tag never produces a function');
  assert.notEqual(typeof (tagged.profile?.role), 'function');
});

test('the compiled prompt carries the fixed rules, the profile, and the guardrails', () => {
  const profile = ok(TEMPLATES.find(template => template.id === 'family').yaml);
  const prompt = compileVoicePrompt(profile);
  assert.match(prompt, /ONLY the message text/);
  assert.match(prompt, /untrusted text/);
  assert.match(prompt, /Who you are talking to: My mother/);
  assert.match(prompt, /Voice: affectionate/);
  assert.match(prompt, /at most 2 sentences/);
  assert.match(prompt, /Facts you may state about the owner: none\./);
  assert.match(prompt, /Never:\n- promise visits, calls or plans/);
  assert.match(prompt, /When unsure: Write a short holding reply/);
  assert.match(prompt, /They: Já almoçou\?\nOwner: Já sim, mãe! E você\?/);
  assert.equal(prompt.includes('group chat'), false, 'the group paragraph is only for groups');
});

test('listed facts replace the "none" statement', () => {
  const prompt = compileVoicePrompt(ok('name: W\nfacts_about_me:\n  hours: Mon–Fri 9 to 6\n'));
  assert.match(prompt, /Facts you may state about the owner \(and nothing else\):\n- hours: Mon–Fri 9 to 6/);
});

test('in a group the group settings apply, and the tag-only paragraph is added', () => {
  const profile = ok('name: G\nvoice: warm\nmax_sentences: 3\nnever:\n  - gossip\ngroups:\n  voice: terse\n  max_sentences: 1\n  never:\n    - share private details\n');
  const group = compileVoicePrompt(profile, { chat: 'group' });
  assert.match(group, /Voice: terse/);
  assert.match(group, /at most 1 sentence\./);
  assert.match(group, /- gossip\n- share private details/);
  assert.match(group, /replying because the owner was tagged/);
  const direct = compileVoicePrompt(profile, { chat: 'direct' });
  assert.match(direct, /Voice: warm/);
  assert.match(direct, /at most 3 sentences/);
  assert.equal(direct.includes('share private details'), false);
});

test('a list of voice traits stays readable even when a trait contains a comma', () => {
  const prompt = compileVoicePrompt(ok('name: V\nvoice:\n  - casual and direct, like texting a friend\n  - short\n'));
  assert.match(prompt, /Voice: casual and direct, like texting a friend; short/);
});
