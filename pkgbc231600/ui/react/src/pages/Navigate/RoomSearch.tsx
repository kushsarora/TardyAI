/**
 * Room search box: type a room number ("3112"), a room name ("Learning
 * Commons") or an alias ("bathroom") and pick a destination.
 *
 * Matching and ranking happen server-side in `NavRouter.searchRooms` so the
 * client never needs a copy of the room list to filter.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { MapNode } from '@/Interfaces';
import { searchRooms } from '@/lib/tardyApi';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';

/**
 * Delay before a keystroke turns into a request. 220 ms is below the threshold
 * where typing feels laggy but still collapses a burst of keystrokes into one
 * round trip.
 */
const DEBOUNCE_MS = 220;

interface RoomSearchProps {
  buildingId: string;
  onSelect: (node: MapNode) => void;
  /** Label of the currently chosen destination, shown when the box is empty. */
  selectedLabel?: string | null;
}

export default function RoomSearch({ buildingId, onSelect, selectedLabel }: RoomSearchProps) {
  const { reportError } = useErrorBoundary();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MapNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchRooms(trimmed, buildingId, 8)
        .then((found) => {
          if (cancelled) return;
          setResults(found);
          setOpen(true);
        })
        .catch((error) => {
          if (!cancelled) reportError(error);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, buildingId, reportError]);

  useEffect(
    () => () => {
      if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
    },
    [],
  );

  const handleSelect = useCallback(
    (node: MapNode) => {
      try {
        onSelect(node);
        setQuery('');
        setResults([]);
        setOpen(false);
      } catch (error) {
        reportError(error);
      }
    },
    [onSelect, reportError],
  );

  return (
    <div className="relative">
      <label
        htmlFor="tardy-room-search"
        className="mb-1 block text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]"
      >
        Where are you headed?
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-[var(--c3-style-basic-fg-neutral)]"
          aria-hidden
        />
        <input
          id="tardy-room-search"
          type="text"
          autoComplete="off"
          value={query}
          placeholder={selectedLabel ? `Going to ${selectedLabel}` : 'Room number, name, or "bathroom"'}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setOpen(results.length > 0)}
          // Deferred so a click on a result lands before the list unmounts.
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 150);
          }}
          className="h-[var(--c3-style-height-h-36)] w-full rounded-[var(--c3-style-border-radius-4)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] pl-8 pr-8 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)] outline-none focus-visible:border-[var(--c3-style-accent-border-strong)]"
        />
        {searching && (
          <Loader2
            className="absolute right-2 top-1/2 size-4 -translate-y-1/2 animate-spin text-[var(--c3-style-basic-fg-neutral)]"
            aria-hidden
          />
        )}
      </div>

      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-[var(--c3-style-border-radius-4)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] shadow-lg">
          {results.map((node) => (
            <li key={node.id}>
              <button
                type="button"
                onClick={() => handleSelect(node)}
                className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-[var(--c3-style-basic-bg-hover)]"
              >
                <span className="text-c3-bold-body-p2 text-[var(--c3-style-basic-fg-primary)]">
                  {node.roomNumber ?? node.name ?? node.id}
                </span>
                {node.roomNumber && node.name && (
                  <span className="truncate text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">
                    {node.name}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
                  {node.floor?.name ?? ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && !searching && query.trim().length > 0 && results.length === 0 && (
        <p className="absolute z-20 mt-1 w-full rounded-[var(--c3-style-border-radius-4)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] px-3 py-2 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">
          Nothing matches {`"${query.trim()}"`} in this building.
        </p>
      )}
    </div>
  );
}
