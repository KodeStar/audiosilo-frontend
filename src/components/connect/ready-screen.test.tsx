import { fireEvent, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Book } from '@/api/types';

import { renderConnect as render } from './connect-testing';
import { ReadyScreen } from './ready-screen';
import type { ReadySummary } from './use-ready-summary';

const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  router: { dismissTo: (h: unknown) => mockDismissTo(h) },
}));
let mockLayout = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
let mockSummary: ReadySummary;
jest.mock('./use-ready-summary', () => ({ useReadySummary: () => mockSummary }));

const book = (title: string, i: number) =>
  ({ library_id: 1, rel_path: `b${i}`, title, author: 'X Y', duration: 3600 * 10 }) as Book;

beforeEach(() => {
  jest.clearAllMocks();
  mockLayout = 'phone';
  mockSummary = {
    line: { kind: 'booksIn', books: 3249, names: ['Fiction', 'Non-fiction', 'Kids'] },
    failed: false,
    books: [book('One', 1), book('Two', 2)],
    place: { title: 'The Way of Kings', chapter: 23, percent: 38 },
  };
});

it('says the server is connected, the counts, and where the place came from', async () => {
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  expect(screen.getByText('Hearthside is connected')).toBeTruthy();
  expect(screen.getByText('Your library is ready.')).toBeTruthy();
  expect(
    screen.getByText(
      '3,249 books in Fiction, Non-fiction and Kids. Your place in The Way of Kings came with you: chapter 23, 38% in.',
    ),
  ).toBeTruthy();
  expect(screen.getByLabelText('Step 3 of 3')).toBeTruthy();
});

it('says nothing about a place the listener does not have', async () => {
  mockSummary = { ...mockSummary, place: null, line: { kind: 'booksIn', books: 1, names: ['A'] } };
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  expect(screen.getByText('1 book in A.')).toBeTruthy();
});

it('a place in a book without chapters gives the percent alone', async () => {
  mockSummary = { ...mockSummary, place: { title: 'Dune', percent: 5 } };
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  expect(screen.getByText(/Your place in Dune came with you: 5% in\./)).toBeTruthy();
});

it('an empty server says so, with ghost spines', async () => {
  mockSummary = { line: { kind: 'empty' }, failed: false, books: [], place: null };
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  expect(screen.getByText(/Hearthside has no books yet/)).toBeTruthy();
});

it('libraries it could not read: says so, and still lets the listener in', async () => {
  mockSummary = { line: null, failed: true, books: undefined, place: null };
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  expect(screen.getByText(/couldn't be read just now/)).toBeTruthy();
  expect(screen.getByText('Start listening')).toBeTruthy();
});

it('Start listening goes Home; Browse the library opens the Library', async () => {
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  await fireEvent.press(screen.getByText('Start listening'));
  expect(mockDismissTo).toHaveBeenLastCalledWith('/');
  await fireEvent.press(screen.getByText('Browse the library'));
  expect(mockDismissTo).toHaveBeenLastCalledWith('/library');
});

it('shows "At home and away" when the server has both addresses', async () => {
  await render(
    <ReadyScreen
      connectionId="c1"
      name="Hearthside"
      addresses={{ home: 'http://192.168.1.20:8080', away: 'https://books.example.com' }}
    />,
  );
  expect(screen.getByText('At home and away')).toBeTruthy();
  expect(screen.getByText(/Hearthside has two addresses/)).toBeTruthy();
});

it("says on the web only what the addresses are for (a browser doesn't switch)", async () => {
  const os = Platform.OS;
  Platform.OS = 'web';
  try {
    await render(
      <ReadyScreen
        connectionId="c1"
        name="Hearthside"
        addresses={{ home: 'http://192.168.1.20:8080', away: 'https://books.example.com' }}
      />,
    );
    expect(screen.queryByText(/switches by itself/)).toBeNull();
    expect(screen.getByText(/The apps use the home address/)).toBeTruthy();
  } finally {
    Platform.OS = os;
  }
});

it('no addresses card with only one address', async () => {
  await render(
    <ReadyScreen connectionId="c1" name="Hearthside" addresses={{ away: 'https://b.example' }} />,
  );
  expect(screen.queryByText('At home and away')).toBeNull();
});

it('stands up as many of the newest books as fit the shelf', async () => {
  mockSummary = { ...mockSummary, books: Array.from({ length: 30 }, (_, i) => book(`B${i}`, i)) };
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  const row = screen.getByTestId('ready-shelf-row', { includeHiddenElements: true });
  await fireEvent(row, 'layout', { nativeEvent: { layout: { width: 300, height: 120 } } });
  const shown = screen.queryAllByText(/^B\d+$/, { includeHiddenElements: true });
  expect(shown.length).toBeGreaterThan(3);
  expect(shown.length).toBeLessThan(30);
});

it('sits beside the cover cascade on a desktop', async () => {
  mockLayout = 'desktop';
  await render(<ReadyScreen connectionId="c1" name="Hearthside" />);
  expect(screen.getByTestId('cover-cascade')).toBeTruthy();
});
