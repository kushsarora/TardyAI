import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import RoomSearch from './RoomSearch';
import { searchRooms } from '@/lib/tardyApi';
import type { MapNode } from '@/Interfaces';

jest.mock('@/lib/tardyApi', () => ({ searchRooms: jest.fn() }));
const search = searchRooms as jest.MockedFunction<typeof searchRooms>;
const room = {
  id: '3335',
  roomNumber: '3335',
  name: 'Class Room',
  floor: { name: 'Level 3' },
} as MapNode;
const settle = async () => {
  await act(async () => {
    jest.advanceTimersByTime(200);
  });
};
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

test('keyboard selection reports a room and closes the suggestions', async () => {
  search.mockResolvedValue([room]);
  const select = jest.fn();
  render(<RoomSearch buildingId="grainger" onSelect={select} />);
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: '3335' } });
  await settle();
  expect(input).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(select).toHaveBeenCalledWith(room);
  expect(input).toHaveValue('');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('an old response cannot replace results for a newer query', async () => {
  let resolveOld: (nodes: MapNode[]) => void;
  search
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce([]);
  render(<RoomSearch buildingId="grainger" onSelect={jest.fn()} />);
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: '3335' } });
  await settle();
  fireEvent.change(input, { target: { value: 'not-a-room' } });
  await settle();
  await act(async () => {
    resolveOld([room]);
  });
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('No rooms match');
});

test('a failed search shows an actionable message', async () => {
  search.mockRejectedValue(new Error('offline'));
  render(<RoomSearch buildingId="grainger" onSelect={jest.fn()} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: '3335' } });
  await settle();
  expect(screen.getByRole('status')).toHaveTextContent(
    'Search unavailable. Please try again.',
  );
});
