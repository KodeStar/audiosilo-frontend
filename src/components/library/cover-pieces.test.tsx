import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { settleFlashList } from '@/testing/flash-list';

const mockPush = jest.fn();
// A tile's actions menu (book actions, the player) has its own tests.
const mockTileActions = jest.fn((_props: { request: number; book?: unknown }) => null);
jest.mock('@/components/library/tile-actions', () => ({
  TileActions: (p: { request: number; book?: unknown }) => mockTileActions(p),
}));
jest.mock('expo-router', () => ({ router: { push: (h: unknown) => mockPush(h) } }));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({ coverUrl: () => 'https://s/cover', authHeaders: () => ({}) }),
}));
jest.mock('@/api/hooks', () => ({ useServerInfo: () => ({ data: { capabilities: {} } }) }));
let mockDownloaded = false;
jest.mock('@/downloads/store', () => ({
  useDownloadEntry: () =>
    mockDownloaded ? { status: 'downloaded', manifest: { coverUri: null } } : undefined,
}));
// The grid clears the mini player (whose module loads the playback engine).
jest.mock('@/components/player/mini-player', () => ({ useMiniPlayerInset: () => 0 }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));

/* eslint-disable import/first */
import { FilterChip } from '@/components/ui/filter-chip';

import { CoverGrid, CoverGridSkeleton } from './cover-grid';
import { CoverTile } from './cover-tile';
import { GhostCover, hatchLines } from './ghost-cover';
import { ShelfRow } from './shelf-row';
/* eslint-enable import/first */

const tile = { connectionId: 'c', libraryId: 1, path: 'Dune', title: 'Dune', width: 132 };

describe('CoverTile', () => {
  beforeEach(() => {
    mockDownloaded = false;
    mockPush.mockClear();
  });

  it('opens the book, named by its title, caption and state', async () => {
    mockDownloaded = true;
    await render(<CoverTile {...tile} caption="Frank Herbert" progress={0.42} server="Maya" />);
    const button = screen.getByRole('button', {
      name: 'Dune, Frank Herbert, 42% listened, Downloaded, On Maya',
    });
    await fireEvent.press(button);
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/book/[libraryId]',
      params: { libraryId: '1', connection: 'c', path: 'Dune' },
    });
    expect(screen.getByText('Maya')).toBeTruthy();
  });

  it('opens the book actions on a long-press, again on each, with the row it was given', async () => {
    mockTileActions.mockClear();
    const book = { rel_path: 'Dune' };
    await render(<CoverTile {...tile} book={book as never} />);
    expect(mockTileActions).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Dune' });
    await fireEvent(button, 'longPress');
    expect(mockTileActions).toHaveBeenLastCalledWith(expect.objectContaining({ request: 1, book }));
    await fireEvent(button, 'longPress');
    expect(mockTileActions).toHaveBeenLastCalledWith(expect.objectContaining({ request: 2 }));
    // A screen reader reaches them as the tile's "More actions".
    expect(button.props.accessibilityActions).toEqual([
      { name: 'longpress', label: 'More actions' },
    ]);
  });

  it("lets a caller's long-press replace the menu, or turn it off", async () => {
    mockTileActions.mockClear();
    const onLongPress = jest.fn();
    await render(<CoverTile {...tile} onLongPress={onLongPress} />);
    await fireEvent(screen.getByRole('button', { name: 'Dune' }), 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(mockTileActions).not.toHaveBeenCalled();

    await render(<CoverTile {...tile} actions={false} />);
    const off = screen.getByRole('button', { name: 'Dune' });
    expect(off.props.accessibilityActions).toBeUndefined();
    await fireEvent(off, 'longPress');
    expect(mockTileActions).not.toHaveBeenCalled();
  });

  it('says finished instead of a percentage', async () => {
    await render(<CoverTile {...tile} progress={1} finished />);
    expect(screen.getByRole('button', { name: 'Dune, Finished' })).toBeTruthy();
  });

  it('takes its own press handler', async () => {
    const onPress = jest.fn();
    await render(<CoverTile {...tile} onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Dune' }));
    expect(onPress).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('GhostCover', () => {
  it('names a missing book with its real title and place', async () => {
    await render(<GhostCover title="Rogue Protocol" position={3} width={132} />);
    expect(
      screen.getByRole('image', { name: 'Book 3, Rogue Protocol, Not in your library' }),
    ).toBeTruthy();
    expect(screen.getByText('Not in your library')).toBeTruthy();
  });

  it("marks a book on another server with that server's name", async () => {
    await render(<GhostCover title="Oathbringer" width={132} server="Maya's Shelf" />);
    expect(screen.getByRole('image', { name: "Oathbringer, On Maya's Shelf" })).toBeTruthy();
  });

  it('hatches the whole square', () => {
    const lines = hatchLines(100);
    expect(lines.length).toBe(14);
    expect(lines[0][0]).toBeCloseTo(14.14, 1);
    expect(lines.every(([, y1, , y2]) => y1 === 0 && y2 === 100)).toBe(true);
  });
});

describe('ShelfRow and CoverGrid', () => {
  const books = ['A', 'B', 'C'];

  it('renders each tile at the shelf width (132 on a phone, 164 elsewhere)', async () => {
    mockLayout = 'phone';
    const widths: number[] = [];
    await render(
      <ShelfRow
        data={books}
        keyExtractor={(b) => b}
        renderItem={(b, w) => {
          widths.push(w);
          return <Text>{b}</Text>;
        }}
      />,
    );
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('C')).toBeTruthy();
    expect(new Set(widths)).toEqual(new Set([132]));

    mockLayout = 'desktop';
    widths.length = 0;
    await render(
      <ShelfRow
        data={books}
        keyExtractor={(b) => b}
        renderItem={(b, w) => (widths.push(w), (<Text>{b}</Text>))}
      />,
    );
    expect(new Set(widths)).toEqual(new Set([164]));
    await settleFlashList();
  });

  it('lays a phone grid in two columns of the measured width', async () => {
    mockLayout = 'phone';
    const widths: number[] = [];
    await render(
      <CoverGrid
        data={books}
        keyExtractor={(b) => b}
        renderItem={(b, w) => {
          widths.push(w);
          return <Text>{b}</Text>;
        }}
        ListHeaderComponent={<Text>Header</Text>}
      />,
    );
    // Not laid out yet: nothing renders until the width is known.
    expect(screen.queryByText('A')).toBeNull();
    await fireEvent(screen.getByTestId('cover-grid'), 'layout', {
      nativeEvent: { layout: { width: 390, height: 800 } },
    });
    expect(screen.getByText('Header')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('C')).toBeTruthy();
    // 390 less two 16 gutters, less one 14 gap, in two.
    expect(new Set(widths)).toEqual(new Set([172]));
    await settleFlashList();
  });

  it('shows exact cover-shaped placeholders while loading', async () => {
    mockLayout = 'phone';
    await render(<CoverGridSkeleton rows={2} />);
    // Hidden from assistive tech, so the queries must include hidden elements.
    const hidden = { includeHiddenElements: true };
    await fireEvent(screen.getByTestId('cover-grid-skeleton', hidden), 'layout', {
      nativeEvent: { layout: { width: 390, height: 800 } },
    });
    expect(screen.getAllByTestId('cover-skeleton', hidden)).toHaveLength(4);
  });
});

describe('FilterChip', () => {
  it('is a checkbox, checked when on, with its count in its name', async () => {
    const onPress = jest.fn();
    await render(<FilterChip label="In progress" count={12} selected={false} onPress={onPress} />);
    const chip = screen.getByRole('checkbox', { name: 'In progress, 12', checked: false });
    await fireEvent.press(chip);
    expect(onPress).toHaveBeenCalled();
    await render(<FilterChip label="Finished" selected onPress={jest.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Finished', checked: true })).toBeTruthy();
  });
});
