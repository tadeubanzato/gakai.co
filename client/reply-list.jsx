import { useEffect, useRef, useState } from "react";
import { api } from "./app-helpers.mjs";
import { addToBox, buildBoxes, entriesFromRules, isGroupValue, moveHint, removeEntry, toRules } from "./reply-boxes.mjs";

const GROUP_HINT = "Group · replies when you're tagged";

// The people and groups the AI answers, arranged by voice (see reply-boxes.mjs). Every change is saved
// at once, one save after another so two quick edits cannot land out of order. The list is taken from
// the server once, when it first arrives; after that this is the source of truth for the screen, so a
// save finishing never overwrites an edit made while it was in flight.
export function useReplyList({ llm, base, voices, onSaved, onNotice }) {
  const fromServer = () => ({ entries: entriesFromRules(llm?.replyRules, llm?.replyLabels), assignments: llm?.replyRules?.assignments || {} });
  const [state, setState] = useState(fromServer);
  const hydrated = useRef(Boolean(llm));
  const queue = useRef(Promise.resolve());
  useEffect(() => { if (!hydrated.current && llm) { hydrated.current = true; setState(fromServer()); } }, [llm]);   // eslint-disable-line react-hooks/exhaustive-deps

  const commit = next => {
    setState(next);
    queue.current = queue.current
      .then(() => api(base + "/llm/rules", { method: "PUT", body: JSON.stringify(toRules(next)) }))
      .then(result => { onSaved?.(result); onNotice("Auto saved"); })
      .catch(error => onNotice(error.message));
  };

  const find = kind => async (query, exclude) => {
    const params = new URLSearchParams({ kind, q: query, exclude: exclude.join(",") });
    return (await api(`${base}/reply-targets?${params}`)).results || [];
  };

  // One search finds people and groups together. Someone already in another voice is offered as
  // "In Friends — move here"; picking them moves them.
  const searchFor = voiceId => async (query, exclude) => {
    const [people, groups] = await Promise.all([find("person")(query, exclude), find("group")(query, exclude)]);
    return [...people.slice(0, query ? 6 : 8), ...groups.slice(0, 4)].map(option => ({
      ...option,
      detail: moveHint(option, state, voices, voiceId) || (isGroupValue(option.value) && !option.custom ? GROUP_HINT : option.detail),
    }));
  };

  return {
    configured: Boolean(llm?.configured),
    boxes: buildBoxes(state.entries, state.assignments, voices),
    searchFor,
    add: (voiceId, option) => commit(addToBox(state, voiceId, option)),
    remove: value => commit(removeEntry(state, value)),
  };
}
