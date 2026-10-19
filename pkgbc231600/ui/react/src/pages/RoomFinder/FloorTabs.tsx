/**
 * One tab per floor the route visits, in travel order.
 *
 * ### Why the tab identity is the segment, not the floor
 *
 * A route can leave a floor and come back to it, which produces two segments
 * with the same `floorKey` — two different walks that happen to share a plan.
 * Keying tabs by floor would collapse them into one and silently drop half the
 * journey, so the tab value is the segment's position in the route. The floor
 * name is only the label.
 */

import React from 'react';
import { ArrowDownUp } from 'lucide-react';

import { RouteFloorSegment } from '@/Interfaces';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface FloorTabsProps {
  /** The route's floor segments, in travel order. */
  segments: RouteFloorSegment[];
  /** Index into {@link FloorTabsProps.segments} of the floor on the map. */
  activeIndex: number;
  onSelect: (index: number) => void;
}

/** Label a segment the way the tab should read. */
function segmentLabel(segment: RouteFloorSegment): string {
  return segment.floorName ?? `Floor ${segment.floorLevel}`;
}

export default function FloorTabs({ segments, activeIndex, onSelect }: FloorTabsProps) {
  // A single-floor route has nothing to switch between, and a lone tab reads as
  // a control that does not work. Show the floor as plain text instead.
  if (segments.length <= 1) {
    if (segments.length === 0) return null;
    return (
      <p className="text-c3-bold-label-l2 text-[var(--c3-style-basic-fg-secondary)]">
        {segmentLabel(segments[0])}
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tabs
        value={String(activeIndex)}
        onValueChange={(value) => onSelect(Number(value))}
        variant="bordered"
        size="md"
      >
        <TabsList>
          {segments.map((segment, index) => (
            <TabsTrigger key={`${segment.floorKey}-${index}`} value={String(index)}>
              {segmentLabel(segment)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <span className="flex items-center gap-1.5 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
        <ArrowDownUp className="size-3.5" aria-hidden />
        {segments.length} floors on this route
      </span>
    </div>
  );
}
