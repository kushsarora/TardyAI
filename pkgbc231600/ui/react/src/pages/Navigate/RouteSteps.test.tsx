import React from 'react';
import { render, screen, within } from '@testing-library/react';

import type { NavRoute } from '@/Interfaces';
import type { RouteLegWithSteps } from '@/lib/routeStepTypes';

import RouteSteps from './RouteSteps';

const LEG_1: RouteLegWithSteps = {
  floorId: 'grainger-f1',
  floorLevel: 1,
  floorName: 'Level 1',
  points: [],
  seconds: 46.4,
  meters: 60.4,
  instruction: 'Walk to West Stairs',
  exitConnectorKey: 'stair-west',
};

const LEG_3: RouteLegWithSteps = {
  floorId: 'grainger-f3',
  floorLevel: 3,
  floorName: 'Level 3',
  points: [],
  seconds: 98.2,
  meters: 123.9,
  instruction: 'Take West Stairs to Level 3, then walk to 3335 (Class Room 3335)',
  exitConnectorKey: null,
};

function route(legs: RouteLegWithSteps[]): NavRoute {
  return { found: true, legs, totalSeconds: 184.6, totalMeters: 184.3, floorsTraversed: 2, stepFree: false };
}

function renderSteps(legs: RouteLegWithSteps[]) {
  return render(<RouteSteps route={route(legs)} activeFloorId={null} onFocusFloor={() => undefined} />);
}

test('shows each step text with its distance, numbered per floor', () => {
  renderSteps([
    {
      ...LEG_1,
      steps: [
        { kind: 'start', text: 'From West Entrance, walk 43 m', meters: 42.9, seconds: 33, pointIndex: 0 },
        { kind: 'turn', text: 'Turn left, then walk 13 m', meters: 12.5, seconds: 9.6, pointIndex: 1 },
      ],
    },
    {
      ...LEG_3,
      steps: [
        { kind: 'connector', text: 'Take West Stairs up to Level 3', meters: 0, seconds: 0, pointIndex: 0 },
        { kind: 'turn', text: 'Turn right, then walk 74 m to Elevator C (east)', meters: 74.2, seconds: 57, pointIndex: 1 },
        { kind: 'arrive', text: '3335 (Class Room 3335) is on your left', meters: 44.7, seconds: 37.4, pointIndex: 7 },
      ],
    },
  ]);

  const level1 = screen.getByRole('list', { name: 'Directions on Level 1' });
  const l1Items = within(level1).getAllByRole('listitem');
  expect(l1Items).toHaveLength(2);
  expect(l1Items[0]).toHaveTextContent('From West Entrance, walk 43 m');
  expect(l1Items[0]).toHaveTextContent('43 m');
  expect(l1Items[1]).toHaveTextContent('Turn left, then walk 13 m');

  const level3 = screen.getByRole('list', { name: 'Directions on Level 3' });
  const l3Items = within(level3).getAllByRole('listitem');
  expect(l3Items.map((li) => li.textContent)).toEqual([
    'Take West Stairs up to Level 3',
    'Turn right, then walk 74 m to Elevator C (east)74 m',
    '3335 (Class Room 3335) is on your left45 m',
  ]);
  // The leg summaries stay visible above the steps.
  expect(screen.getByText('Walk to West Stairs')).toBeInTheDocument();
});

test('falls back to the leg instruction when the server sends no steps', () => {
  renderSteps([LEG_1, { ...LEG_3, steps: [] }]);
  expect(screen.getByText('Walk to West Stairs')).toBeInTheDocument();
  expect(screen.getByText(LEG_3.instruction)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: /^Directions on/ })).not.toBeInTheDocument();
});
