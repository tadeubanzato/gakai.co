import React, { useEffect, useId, useRef, useState } from "react";
import { api } from "./app-helpers.mjs";

// "Who should the AI reply to?" — an allowlist, so enabling AI replies never
// answers a chat that was not added here. People are matched by phone number;
// groups only get a reply when this account is @-tagged in them. Each list is
// a tag input: type to search your conversations, pick a suggestion, remove a
// tag with its ×. Every change saves itself.
const SEARCH_DELAY_MS = 200;

function TagPicker({ label, placeholder, empty, tags, search, onAdd, onRemove }) {
  const inputId = useId();
  const listId = useId();
  const root = useRef(null);
  const ticket = useRef(0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  // Suggestions follow what is typed (and shrink as tags are added), after a short pause.
  useEffect(() => {
    if (!open) return undefined;
    const mine = ++ticket.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const results = await search(query, tags.map(tag => tag.value));
        if (mine !== ticket.current) return;
        setOptions(results);
        setActive(0);
      } catch { if (mine === ticket.current) setOptions([]); }
      finally { if (mine === ticket.current) setLoading(false); }
    }, query ? SEARCH_DELAY_MS : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, tags.length]);

  useEffect(() => {
    if (!open) return undefined;
    const close = event => { if (root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = option => {
    if (!option) return;
    onAdd(option);
    setQuery("");
    setActive(0);
  };
  const onKeyDown = event => {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, Math.max(options.length - 1, 0))); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); if (open) pick(options[active]); }
    else if (event.key === "Escape") { if (open) { event.stopPropagation(); setOpen(false); } }
    else if (event.key === "Backspace" && !query && tags.length) onRemove(tags[tags.length - 1].value);
  };

  return <div className="tag-picker" ref={root}>
    <label htmlFor={inputId}>{label}</label>
    <div className="tag-list" aria-label={`Selected: ${label}`}>
      {tags.map(tag => <span className="tag" key={tag.value} title={tag.title}>
        <span className="tag-text"><b>{tag.label}</b></span>
        <button type="button" className="tag-remove" aria-label={`Remove ${tag.label}`} onClick={() => onRemove(tag.value)}>×</button>
      </span>)}
      {!tags.length && <small className="tag-empty">{empty}</small>}
    </div>
    <div className="tag-search">
      <input
        id={inputId} type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        value={query} placeholder={placeholder} autoComplete="off"
        onChange={event => { setQuery(event.currentTarget.value); setOpen(true); }}
        onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
      />
      {open && <ul className="tag-options" id={listId} role="listbox" aria-label={`${label} suggestions`}>
        {options.map((option, index) => <li
          key={option.value} id={`${listId}-${index}`} role="option" aria-selected={index === active}
          className={"tag-option" + (index === active ? " is-active" : "") + (option.custom ? " is-custom" : "")}
          onMouseDown={event => { event.preventDefault(); pick(option); }} onMouseEnter={() => setActive(index)}
        ><b>{option.label}</b>{option.detail && <small>{option.detail}</small>}</li>)}
        {!options.length && <li className="tag-option-empty" role="presentation">{loading ? "Searching…" : query ? "No match. Check the spelling or type the full number." : "No more conversations to suggest."}</li>}
      </ul>}
    </div>
  </div>;
}

// A tag shows the name only; the number or id appears in its tooltip, and as
// the label itself when there is no name to show.
const personTag = (phone, labels) => ({ value: phone, label: labels?.numbers?.[phone] || `+${phone}`, title: `+${phone}` });
const groupTag = (id, labels) => ({ value: id, label: labels?.groups?.[id] || id.replace(/@g\.us$/, ""), title: id.replace(/@g\.us$/, "") });

export function AiReplyRules({ llm, base, onNotice, onSaved }) {
  const rules = llm?.replyRules || { numbers: [], groups: [] };
  const [people, setPeople] = useState(() => rules.numbers.map(phone => personTag(phone, llm?.replyLabels)));
  const [groups, setGroups] = useState(() => rules.groups.map(id => groupTag(id, llm?.replyLabels)));
  const queue = useRef(Promise.resolve());

  const find = kind => async (query, exclude) => {
    const params = new URLSearchParams({ kind, q: query, exclude: exclude.join(",") });
    return (await api(`${base}/reply-targets?${params}`)).results || [];
  };

  // Saves run one after another, so two quick edits cannot land out of order.
  const save = (nextPeople, nextGroups) => {
    queue.current = queue.current
      .then(() => api(base + "/llm/rules", { method: "PUT", body: JSON.stringify({ numbers: nextPeople.map(tag => tag.value), groups: nextGroups.map(tag => tag.value) }) }))
      .then(result => { onSaved?.(result); onNotice("Auto saved"); })
      .catch(error => onNotice(error.message));
  };
  const change = (setList, list, other, isPeople) => ({
    add: option => {
      const tag = { value: option.value, label: option.label, title: isPeople ? `+${option.value}` : option.value.replace(/@g\.us$/, "") };
      const next = [...list, tag];
      setList(next);
      isPeople ? save(next, other) : save(other, next);
    },
    remove: value => {
      const next = list.filter(tag => tag.value !== value);
      setList(next);
      isPeople ? save(next, other) : save(other, next);
    },
  });
  const peopleActions = change(setPeople, people, groups, true);
  const groupActions = change(setGroups, groups, people, false);

  return <section className="reply-rules" aria-labelledby="reply-rules-title">
    <h4 id="reply-rules-title">Who should the AI reply to?</h4>
    <p className="hint-inline"><small>The AI only answers the people and groups listed here. With nothing listed it answers no one.</small></p>
    <TagPicker
      label="People (direct messages)" placeholder="Search a name, or type a number — with or without country code"
      empty="No one yet." tags={people} search={find("person")} onAdd={peopleActions.add} onRemove={peopleActions.remove}
    />
    <TagPicker
      label="Groups (only when someone tags you)" placeholder="Search a group name"
      empty="No groups yet." tags={groups} search={find("group")} onAdd={groupActions.add} onRemove={groupActions.remove}
    />
  </section>;
}
