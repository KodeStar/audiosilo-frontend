import { fireEvent, render, screen } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));

/* eslint-disable import/first */
import { JournalEntryRow } from './journal-entry';
/* eslint-enable import/first */

it('opens the Journal from the Me screen', async () => {
  await render(<JournalEntryRow />);
  expect(screen.getByText('Your listening diary, bookmarks and notes')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('journal-entry'));
  expect(mockPush).toHaveBeenCalledWith('/journal');
});
