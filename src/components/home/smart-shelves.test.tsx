import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
const mockOpenNarrator = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openNarrator: (...a: unknown[]) => mockOpenNarrator(...a) }),
}));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));

/* eslint-disable import/first */
import type { SmartShelf } from './home-model';
import { SmartShelves } from './smart-shelves';
/* eslint-enable import/first */

const FOUR: SmartShelf[] = [
  { id: 'progress', count: 3, covers: [] },
  { id: 'short', covers: [] },
  {
    id: 'narrator',
    name: 'A Narrator With A Rather Long Name',
    books: 4,
    listened: 36000,
    connectionId: 'a',
    libraryId: 1,
    covers: [],
  },
  { id: 'added', count: 5, servers: 1, covers: [] },
];

/** The shelf ids in each rendered row, top to bottom. */
const rowIds = () =>
  screen.getAllByTestId('smart-shelves-row').map((row) =>
    within(row)
      .getAllByTestId(/^smart-shelf-/)
      .map((card) => String(card.props.testID).replace('smart-shelf-', '')),
  );

const measure = async (width: number) =>
  fireEvent(screen.getByTestId('smart-shelves'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width, height: 300 } },
  });

beforeEach(() => {
  mockLayout = 'phone';
  mockPush.mockReset();
  mockOpenNarrator.mockReset();
});

describe('SmartShelves layout', () => {
  it('puts four shelves two by two on a phone, from the first frame', async () => {
    await render(<SmartShelves shelves={FOUR} />);
    expect(rowIds()).toEqual([
      ['progress', 'short'],
      ['narrator', 'added'],
    ]);
    await measure(358);
    expect(rowIds()).toEqual([
      ['progress', 'short'],
      ['narrator', 'added'],
    ]);
  });

  it('lets a last odd card fill its row on a phone', async () => {
    await render(<SmartShelves shelves={FOUR.slice(0, 3)} />);
    expect(rowIds()).toEqual([['progress', 'short'], ['narrator']]);
  });

  it('gives every card an equal share of its row, never a percentage that can squash', async () => {
    await render(<SmartShelves shelves={FOUR} />);
    for (const card of screen.getAllByTestId(/^smart-shelf-/)) {
      // The native pressable passes a style function: resolve it unpressed.
      const raw = card.props.style;
      const style = StyleSheet.flatten(typeof raw === 'function' ? raw({ pressed: false }) : raw);
      expect(style).toMatchObject({ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 });
    }
    for (const row of screen.getAllByTestId('smart-shelves-row')) {
      expect(StyleSheet.flatten(row.props.style)).toMatchObject({ flexDirection: 'row' });
    }
  });

  it('puts four in one row on a desktop, before and after measuring', async () => {
    mockLayout = 'desktop';
    await render(<SmartShelves shelves={FOUR} />);
    expect(rowIds()).toEqual([['progress', 'short', 'narrator', 'added']]);
    await measure(960);
    expect(rowIds()).toEqual([['progress', 'short', 'narrator', 'added']]);
  });

  it('takes fewer per row when the measured row is too narrow for four', async () => {
    mockLayout = 'tablet';
    await render(<SmartShelves shelves={FOUR} />);
    // Two by two before measuring (the tablet default) and at three columns (balanced).
    expect(rowIds()).toEqual([
      ['progress', 'short'],
      ['narrator', 'added'],
    ]);
    await measure(608);
    expect(rowIds()).toEqual([
      ['progress', 'short'],
      ['narrator', 'added'],
    ]);
    await measure(900);
    expect(rowIds()).toEqual([['progress', 'short', 'narrator', 'added']]);
  });

  it('reads three columns from a measured 608 tablet row', async () => {
    mockLayout = 'tablet';
    await render(<SmartShelves shelves={FOUR.slice(0, 3)} />);
    // The tablet default (two) splits three as two and one; the measured row fits three.
    expect(rowIds()).toEqual([['progress', 'short'], ['narrator']]);
    await measure(608);
    expect(rowIds()).toEqual([['progress', 'short', 'narrator']]);
  });

  it('still opens each shelf', async () => {
    await render(<SmartShelves shelves={FOUR} />);
    await fireEvent.press(screen.getByTestId('smart-shelf-narrator'));
    expect(mockOpenNarrator).toHaveBeenCalledWith('a', 1, 'A Narrator With A Rather Long Name');
    await fireEvent.press(screen.getByTestId('smart-shelf-short'));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});
