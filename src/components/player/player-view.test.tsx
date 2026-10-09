import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

let mockLayout: 'phone' | 'tablet' | 'desktop' = 'phone';
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => mockLayout,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('@/api/hooks', () => ({ useBook: () => ({ data: { cover_color: { bg: '#334455' } } }) }));
// The pieces have their own tests; this one is about where they go.
jest.mock('./player-parts', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    PlayerHeader: () => <T>header</T>,
    PlayerStatusLine: () => <T>status</T>,
    PlayerActions: ({ upNext }: { upNext: boolean }) => (
      <T>{upNext ? 'actions+upnext' : 'actions'}</T>
    ),
    CompanionChips: () => <T>chips</T>,
    PlayerErrorLine: () => null,
    PlayerColumn: ({ children }: { children: unknown }) => children,
  };
});
jest.mock('./companion/companion', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { Companion: ({ variant }: { variant: string }) => <T>{`companion ${variant}`}</T> };
});
let mockOnTip: ((showing: boolean) => void) | undefined;
let mockHoverTip: boolean | undefined;
jest.mock('./seek-bar', () => ({
  PlayerSeekBar: ({
    onTip,
    hoverTip,
    timesHidden,
  }: {
    onTip?: (showing: boolean) => void;
    hoverTip?: boolean;
    timesHidden?: boolean;
  }) => {
    mockOnTip = onTip;
    mockHoverTip = hoverTip;
    mockTimesHidden = !!timesHidden;
    return null;
  },
}));
let mockOnTimelineTip: ((showing: boolean) => void) | undefined;
let mockTimesHidden = false;
jest.mock('./book-timeline', () => ({
  PlayerBookTimeline: ({ onTip }: { onTip?: (showing: boolean) => void }) => {
    mockOnTimelineTip = onTip;
    return null;
  },
}));
jest.mock('./use-playing-pins', () => ({ usePlayingPins: () => ({ bookmarks: [], notes: [] }) }));
jest.mock('./transport-controls', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { TransportControls: ({ size }: { size: string }) => <T>{`transport ${size}`}</T> };
});
let mockHostLayout: string | undefined;
jest.mock('./player-sheet-host', () => ({
  PlayerSheetHost: ({ layout }: { layout?: string }) => {
    mockHostLayout = layout;
    return null;
  },
}));
let mockGraceOpen = false;
jest.mock('./grace-card', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    GraceCard: ({ inline }: { inline?: boolean }) => <T>{inline ? 'grace inline' : 'grace'}</T>,
    useGraceCardOpen: () => mockGraceOpen,
  };
});
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/components/library/cover-wash', () => ({ CoverWash: () => null }));

/* eslint-disable import/first */
import { playerStoreMock } from '@/testing/player-store-mock';

import { useJumpUndo } from '@/playback/jump-undo';

import { useCompanion } from './companion/companion-store';
import { usePlayerSheets } from './player-sheets';
import { PlayerView } from './player-view';
/* eslint-enable import/first */

const chapters = [
  {
    index: 0,
    title: 'Prologue',
    book_offset: 0,
    start: 0,
    end: 100,
    file_path: 'a',
    file_index: 0,
  },
  {
    index: 1,
    title: 'Holden',
    book_offset: 100,
    start: 100,
    end: 200,
    file_path: 'a',
    file_index: 0,
  },
];
const BOOK = {
  connectionId: 'a',
  libraryId: 1,
  path: 'Corey/Calibans War',
  title: "Caliban's War",
  author: 'James S. A. Corey',
  cover: '',
  queue: { chapters, total: 200, tracks: [{ id: 'a:x' }] },
};

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};
async function mount(ui: ReactElement) {
  await act(async () => {
    render(<SafeAreaProvider initialMetrics={METRICS}>{ui}</SafeAreaProvider>);
  });
}

beforeEach(() => {
  mockGraceOpen = false;
  const player = playerStoreMock();
  player.reset();
  player.usePlayer.setState({ nowPlaying: BOOK, bookPosition: 150 } as never);
  usePlayerSheets.setState({ open: null });
  useCompanion.setState({ tab: null });
  useJumpUndo.setState({ jump: null });
});

describe('PlayerView', () => {
  it('phone: medium transport, Up next among the actions, companion chips, no companion inline', async () => {
    mockLayout = 'phone';
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(screen.getByTestId('player-phone')).toBeTruthy();
    expect(screen.getByText('transport md')).toBeTruthy();
    expect(screen.getByText('actions+upnext')).toBeTruthy();
    expect(screen.getByText('chips')).toBeTruthy();
    expect(screen.queryByText(/^companion /)).toBeNull();
  });

  it('tablet: the companion sits below the controls', async () => {
    mockLayout = 'tablet';
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(screen.getByText('transport lg')).toBeTruthy();
    expect(screen.getByText('companion inline')).toBeTruthy();
    expect(screen.queryByText('chips')).toBeNull();
    expect(screen.getByText('actions+upnext')).toBeTruthy();
  });

  it("tablet: a tap in the inline companion acts with the keyboard up (the Notes composer's Add)", async () => {
    mockLayout = 'tablet';
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(screen.getByTestId('player-page').props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('desktop: a companion column, and Up next stays in the drawer', async () => {
    mockLayout = 'desktop';
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(screen.getByTestId('player-companion-column')).toBeTruthy();
    expect(screen.getByText('companion column')).toBeTruthy();
    expect(screen.getByText('actions')).toBeTruthy();
  });

  it('lays out by its measured width, not the window class', async () => {
    mockLayout = 'desktop';
    await mount(<PlayerView onClose={jest.fn()} />);
    await act(async () => {
      fireEvent(screen.getByTestId('player-desktop'), 'layout', {
        nativeEvent: { layout: { width: 800, height: 900, x: 0, y: 0 } },
      });
    });
    expect(screen.getByTestId('player-tablet')).toBeTruthy();
  });

  it('opens the chapters from the title as a sheet on a phone', async () => {
    mockLayout = 'phone';
    await mount(<PlayerView onClose={jest.fn()} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Holden, show chapters'));
    });
    expect(usePlayerSheets.getState().open).toBe('chapters');
  });

  it('asks for the chapters on a desktop too: its sheet host, told the layout, picks the column', async () => {
    mockLayout = 'desktop';
    await mount(<PlayerView onClose={jest.fn()} />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Holden, show chapters'));
    });
    expect(usePlayerSheets.getState().open).toBe('chapters');
    expect(mockHostLayout).toBe('desktop');
  });

  it.each(['phone', 'tablet', 'desktop'] as const)(
    '%s: the grace card takes the status line place, in the flow, never over the controls',
    async (layout) => {
      mockLayout = layout;
      mockGraceOpen = true;
      await mount(<PlayerView onClose={jest.fn()} />);
      expect(screen.getByText('grace inline')).toBeTruthy();
      expect(screen.queryByText('grace')).toBeNull();
      expect(screen.queryByText('status')).toBeNull();
    },
  );

  it('shows the status line while no grace card is up', async () => {
    mockLayout = 'phone';
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(screen.getByText('status')).toBeTruthy();
    expect(screen.queryByText(/^grace/)).toBeNull();
  });

  it("makes way for the seek bar's tip: the status slot fades while it shows", async () => {
    mockLayout = 'desktop';
    await mount(<PlayerView onClose={jest.fn()} />);
    const slot = () => screen.getByTestId('player-status-slot', { includeHiddenElements: true });
    expect(slot().props.style).toBeUndefined();
    await act(async () => mockOnTip?.(true));
    expect(slot().props.style).toEqual({ opacity: 0 });
    await act(async () => mockOnTip?.(false));
    expect(slot().props.style).toBeUndefined();
  });

  it("keeps the seek bar's hover tip off the Undo chip while it can be undone", async () => {
    // A click on the bar (the web) leaves the pointer on it: its hover tip would hide the
    // status slot, and the chip in it, for the chip's whole life.
    mockLayout = 'desktop';
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(mockHoverTip).toBe(true);
    const now = Date.now();
    const jump = { from: 30, bookKey: 'a:1:Corey/Calibans War', until: now + 10_000, at: now };
    await act(async () => useJumpUndo.setState({ jump }));
    expect(mockHoverTip).toBe(false);
    // Another book's undo is not this player's chip.
    await act(async () => useJumpUndo.setState({ jump: { ...jump, bookKey: 'a:1:Other' } }));
    expect(mockHoverTip).toBe(true);
  });

  it('keeps the hover tip while the grace card holds the status slot, chip or not', async () => {
    mockLayout = 'desktop';
    mockGraceOpen = true;
    const now = Date.now();
    useJumpUndo.setState({
      jump: { from: 30, bookKey: 'a:1:Corey/Calibans War', until: now + 10_000, at: now },
    });
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(mockHoverTip).toBe(true);
  });

  it("makes way for the timeline's tip: the seek bar's times row hides while it shows", async () => {
    mockLayout = 'phone';
    await mount(<PlayerView onClose={jest.fn()} />);
    expect(mockTimesHidden).toBe(false);
    await act(async () => mockOnTimelineTip?.(true));
    expect(mockTimesHidden).toBe(true);
    // The status slot is not in its way.
    const slot = screen.getByTestId('player-status-slot', { includeHiddenElements: true });
    expect(slot.props.style).toBeUndefined();
    await act(async () => mockOnTimelineTip?.(false));
    expect(mockTimesHidden).toBe(false);
  });
});
