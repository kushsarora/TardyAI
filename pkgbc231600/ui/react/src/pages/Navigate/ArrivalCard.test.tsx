import React from 'react';
import { fireEvent, render, screen, act } from '@testing-library/react';
import ArrivalCard from './ArrivalCard';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 9, 19, 10, 0, 0));
});
afterEach(() => jest.useRealTimers());

test('a late arrival by less than a minute is still reported late', () => {
  render(<ArrivalCard routeSeconds={30} />);
  fireEvent.change(screen.getByLabelText(/Class starts at/), {
    target: { value: '10:00' },
  });
  expect(screen.getByRole('status')).toHaveTextContent('About 1 min late');
});

test('arrival updates as time passes and disappears when the route is cleared', () => {
  const { rerender } = render(<ArrivalCard routeSeconds={60} />);
  fireEvent.change(screen.getByLabelText(/Class starts at/), {
    target: { value: '10:02' },
  });
  expect(screen.getByRole('status')).toHaveTextContent('1 min to spare');
  act(() => {
    jest.advanceTimersByTime(75000);
  });
  expect(screen.getByRole('status')).toHaveTextContent('About 1 min late');
  rerender(<ArrivalCard routeSeconds={null} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(
    screen.getByText('Add your route to check your arrival.'),
  ).toBeInTheDocument();
});
