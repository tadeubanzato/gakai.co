import React, { useEffect, useId, useRef, useState } from "react";

// A compact tag input: "Reply to:" then the tags, then a small round + that turns into a little search
// box in the same spot. Type to search, pick a suggestion to add it, press × (or Backspace in an empty
// box) to remove a tag, Escape or a click elsewhere to put the + back.
// `search(query, excludedValues)` returns options { value, label, detail?, custom? }.
const SEARCH_DELAY_MS = 200;

export function TagPicker({ label, title = "Reply to:", placeholder = "Search a name or number", empty, tags, search, onAdd, onRemove }) {
  const titleId = useId();
  const listId = useId();
  const root = useRef(null);
  const inputRef = useRef(null);
  const addRef = useRef(null);
  const ticket = useRef(0);
  const [adding, setAdding] = useState(false);          // the small search box is showing
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);              // the suggestions are showing
  const [options, setOptions] = useState([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);

  const stopAdding = (returnFocus = false) => {
    setAdding(false); setOpen(false); setQuery("");
    if (returnFocus) setTimeout(() => addRef.current?.focus(), 0);
  };

  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);

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
    if (!adding) return undefined;
    const close = event => { if (root.current && !root.current.contains(event.target)) stopAdding(); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [adding]);   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = option => {
    if (!option) return;
    onAdd(option);
    setQuery("");
    setActive(0);
    setOpen(false);                                      // the new tag is visible; typing or clicking reopens the list
  };
  const onKeyDown = event => {
    if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, Math.max(options.length - 1, 0))); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); if (open) pick(options[active]); }
    else if (event.key === "Escape") { event.stopPropagation(); stopAdding(true); }
    else if (event.key === "Backspace" && !query && tags.length) onRemove(tags[tags.length - 1].value);
  };

  return <div className="tag-picker is-inline" ref={root} role="group" aria-labelledby={titleId}>
    <span className="tag-title" id={titleId}>{title}</span>
    <div className="tag-list" aria-label={`Selected: ${label}`}>
      {tags.map(tag => <span className="tag" key={tag.value} title={tag.title}>
        <span className="tag-text"><b>{tag.label}</b>{tag.badge && <i className="tag-kind">{tag.badge}</i>}</span>
        <button type="button" className="tag-remove" aria-label={`Remove ${tag.label}`} onClick={() => onRemove(tag.value)}>×</button>
      </span>)}
      {!tags.length && !adding && <small className="tag-empty">{empty}</small>}
      {adding
        ? <div className="tag-search is-compact">
            <input
              ref={inputRef} type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
              aria-label={`Search people or groups to add to ${label}`}
              aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
              value={query} placeholder={placeholder} autoComplete="off"
              onChange={event => { setQuery(event.currentTarget.value); setOpen(true); }}
              onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onKeyDown={onKeyDown}
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
        : <button type="button" className="tag-add" ref={addRef} aria-label={`Add people or groups to ${label}`} title="Add people or groups" onClick={() => { setAdding(true); setOpen(true); }}>
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M6 1.5v9M1.5 6h9" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
        </button>}
    </div>
  </div>;
}
