// "Who should the AI reply to?" as one box per voice. Each person or group sits in exactly one
// box — the voice they are answered in — and everyone without a voice sits in "Everyone else",
// which gets Gakai's built-in basic reply style. This is only how the list is arranged on screen;
// what is saved is still the flat list of numbers and groups plus who uses which voice.
export const DEFAULT_BOX_NAME = "Everyone else";

export const isGroupValue = value => /@g\.us$/i.test(String(value));

const plain = value => String(value).replace(/@g\.us$/i, "");
const omit = (object, key) => { const { [key]: _removed, ...rest } = object; return rest; };

// A search suggestion becomes a listed person or group.
export function entryFromOption(option) {
  const group = isGroupValue(option.value);
  return { value: option.value, kind: group ? "group" : "person", label: option.label, title: group ? plain(option.value) : `+${option.value}`, ...(group ? { badge: "Group" } : {}) };
}

// The saved list, as entries with the names the server gave them.
export function entriesFromRules(rules, labels) {
  const people = (rules?.numbers || []).map(phone => entryFromOption({ value: phone, label: labels?.numbers?.[phone] || `+${phone}` }));
  const groups = (rules?.groups || []).map(id => entryFromOption({ value: id, label: labels?.groups?.[id] || plain(id) }));
  return [...people, ...groups];
}

// One box per voice (in the order the voices were made) and "Everyone else" last. A voice that
// no longer exists puts its people back in "Everyone else".
export function buildBoxes(entries, assignments, voices) {
  const boxes = voices.map(voice => ({ voiceId: voice.id, name: voice.name, entries: [] }));
  const fallback = { voiceId: "", name: DEFAULT_BOX_NAME, entries: [] };
  for (const entry of entries) (boxes.find(box => box.voiceId === assignments[entry.value]) || fallback).entries.push(entry);
  return [...boxes, fallback];
}

// Put a person or group into a box. Someone already listed (in any box) is moved, not duplicated.
export function addToBox(state, voiceId, option) {
  const existing = state.entries.find(entry => entry.value === option.value);
  const entries = existing ? state.entries : [...state.entries, entryFromOption(option)];
  const assignments = voiceId ? { ...state.assignments, [option.value]: voiceId } : omit(state.assignments, option.value);
  return { entries, assignments };
}

export function removeEntry(state, value) {
  return { entries: state.entries.filter(entry => entry.value !== value), assignments: omit(state.assignments, value) };
}

// What the server stores.
export function toRules(state) {
  const listed = new Set(state.entries.map(entry => entry.value));
  const assignments = Object.fromEntries(Object.entries(state.assignments).filter(([value]) => listed.has(value)));
  return {
    numbers: state.entries.filter(entry => entry.kind === "person").map(entry => entry.value),
    groups: state.entries.filter(entry => entry.kind === "group").map(entry => entry.value),
    assignments,
  };
}

// When a suggestion is someone already in a different box, say so — picking it moves them here.
export function moveHint(option, state, voices, boxVoiceId) {
  if (!state.entries.some(entry => entry.value === option.value)) return null;
  const currentId = state.assignments[option.value] || "";
  if (currentId === boxVoiceId) return null;
  const name = voices.find(voice => voice.id === currentId)?.name || DEFAULT_BOX_NAME;
  return `In ${name} — move here`;
}
