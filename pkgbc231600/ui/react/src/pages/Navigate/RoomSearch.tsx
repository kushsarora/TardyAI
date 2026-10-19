import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Loader2, Search, X } from 'lucide-react';
import { MapNode } from '@/Interfaces';
import { searchRooms } from '@/lib/tardyApi';

interface Props {
  buildingId: string;
  onSelect: (node: MapNode) => void;
  selectedLabel?: string | null;
  label?: string;
  placeholder?: string;
}
export default function RoomSearch({
  buildingId,
  onSelect,
  selectedLabel,
  label = 'Where are you headed?',
  placeholder = 'Search a room or place…',
}: Props) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MapNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState('');
  const blur = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(blur.current), []);
  useEffect(() => {
    let cancelled = false;
    setResults([]);
    setHighlight(0);
    setError('');
    if (!query.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(
      () =>
        searchRooms(query.trim(), buildingId, 10)
          .then((found) => {
            if (!cancelled) setResults(found);
          })
          .catch(() => {
            if (!cancelled) setError('Search unavailable. Please try again.');
          })
          .finally(() => {
            if (!cancelled) setSearching(false);
          }),
      180,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, buildingId]);
  const choose = (node: MapNode) => {
    onSelect(node);
    setQuery('');
    setOpen(false);
  };
  return (
    <div className="room-search">
      <label htmlFor={id}>{label}</label>
      <div className="search-field">
        <Search size={18} />
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && !!query.trim()}
          aria-controls={`${id}-results`}
          aria-activedescendant={
            open && results[highlight] ? `${id}-${highlight}` : undefined
          }
          value={query}
          autoComplete="off"
          placeholder={selectedLabel || placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            clearTimeout(blur.current);
            setOpen(true);
          }}
          onBlur={() => {
            blur.current = setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
              setHighlight((i) =>
                Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    i + (e.key === 'ArrowDown' ? 1 : -1),
                  ),
                ),
              );
            }
            if (e.key === 'Enter' && open && results[highlight]) {
              e.preventDefault();
              choose(results[highlight]);
            }
          }}
        />
        {searching ? (
          <Loader2 className="animate-spin" size={17} />
        ) : query ? (
          <button aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={16} />
          </button>
        ) : (
          <kbd>↵</kbd>
        )}
      </div>
      {open && query.trim() && (
        <ul
          id={`${id}-results`}
          role="listbox"
          className="search-results"
          aria-label={label}
        >
          {results.map((node, i) => (
            <li
              key={node.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === highlight}
              onMouseEnter={() => setHighlight(i)}
            >
              <button
                className={i === highlight ? 'highlighted' : ''}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(node)}
              >
                <span className="search-result-icon">
                  <ArrowUpRight size={17} />
                </span>
                <span>
                  <strong>
                    {node.roomNumber ? `Room ${node.roomNumber}` : node.name}
                  </strong>
                  <small>
                    {node.roomNumber ? node.name : node.kind} ·{' '}
                    {node.floor?.name}
                  </small>
                </span>
              </button>
            </li>
          ))}
          {!results.length && (
            <li className="search-message" role="status">
              {searching
                ? 'Searching the building…'
                : error ||
                  `No rooms match “${query.trim()}”. Try a room number or name.`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
