import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { Book } from '@/api/types';
import type { ReaderHostHandle, ReaderHostProps } from '@/reader/reader-host-types';

import type { TextTabModel } from './use-text-tab';

jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/reader/reader-settings', () => ({ loadFontScale: () => Promise.resolve(1) }));
let mockApi: object | null = {};
jest.mock('@/api/provider', () => ({ useOptionalApi: () => mockApi }));
// The narration (its own tests): where the player is, and the seek.
const mockSeek = jest.fn();
let mockNarrating = true;
jest.mock('@/reader/narration', () => ({
  useNarration: () => ({
    narrating: mockNarrating,
    readalongPosition: () => ({ t: 20, rate: 1, playing: true }),
    onSeek: mockSeek,
  }),
}));
// The Make offer (its own tests): what it was given.
jest.mock('@/components/bridge/make-readalong', () => ({
  MakeReadalongOffer: ({ again, hasEbook }: { again?: boolean; hasEbook: boolean }) => {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text testID="make-offer">{`${again ? 'again' : 'first'}:${hasEbook}`}</Text>;
  },
}));
// The host is the platform's part (its own tests): here it hands the panel the reader's
// messages and takes its commands.
const mockHandle: ReaderHostHandle = {
  goto: jest.fn(),
  next: jest.fn(),
  prev: jest.fn(),
  follow: jest.fn(),
  syncPosition: jest.fn(),
};
let mockHost: ReaderHostProps | null = null;
let mockMounts = 0;
jest.mock('@/reader/reader-host', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    ReaderHost: (props: ReaderHostProps) => {
      mockHost = props;
      React.useEffect(() => {
        mockMounts++;
      }, []);
      React.useImperativeHandle(props.ref, () => mockHandle);
      return null;
    },
  };
});

/* eslint-disable import/first */
import { TextPanel } from './text-panel';
/* eslint-enable import/first */

const TARGET = { connectionId: 'c1', libraryId: 1, path: 'A/Book' };
const EARLY = 'epubcfi(/6/4!/4/2,/1:0,/1:9)';
const NOW = 'epubcfi(/6/4!/4/4,/1:0,/1:9)';
const MAP = {
  sections: [
    {
      href: 'c1.xhtml',
      spans: [
        { cfi: EARLY, start: 1, end: 10 },
        { cfi: NOW, start: 18, end: 25 },
        { cfi: 'epubcfi(/6/4!/4/6,/1:0,/1:9)', start: 30, end: 40 },
      ],
    },
  ],
};
const BOOK = {
  title: 'Alice',
  ebook: { path: 'A/Book/alice.epub', size: 7 },
  readalong: { state: 'ready', generated_at: 'g1' },
} as unknown as Book;

const model = (p: Partial<TextTabModel> = {}): TextTabModel => ({
  shown: true,
  map: MAP,
  book: BOOK,
  ...p,
});

async function mount(text = model(), fill = true) {
  await act(async () => {
    render(<TextPanel target={TARGET} text={text} fill={fill} />);
  });
  await waitFor(() => expect(mockHost).not.toBeNull());
}

const host = () => mockHost!;
const shows = async () => {
  await act(async () => {
    host().onMessage({ type: 'opened', title: 'Alice', toc: [], rtl: false });
    host().onReadalongState!({ state: 'ok', unresolved: 0 });
  });
};

describe('TextPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHost = null;
    mockMounts = 0;
    mockApi = {};
    mockNarrating = true;
  });

  it('opens the book at the sentence being read, following the narration', async () => {
    await mount();
    expect(host()).toMatchObject({
      connectionId: 'c1',
      libraryId: 1,
      path: 'A/Book',
      ebookSize: 7,
      at: { cfi: NOW },
      readalongMap: MAP,
      followNarration: true,
    });
    expect(host().onSeek).toBe(mockSeek);
  });

  it('shows the page edges once the reader took the map, and no pill while it follows', async () => {
    await mount();
    expect(screen.queryByLabelText('Next page')).toBeNull();
    await shows();
    expect(screen.getByLabelText('Next page')).toBeTruthy();
    await act(async () => host().onFollowing!(true));
    expect(screen.queryByText('Back to narration')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Next page'));
    expect(mockHandle.next).toHaveBeenCalled();
  });

  it('narrows the page edges to the margin in a narrow column, clear of the text (fe#165)', async () => {
    await mount();
    await shows();
    await fireEvent(screen.getByTestId('companion-text'), 'layout', {
      nativeEvent: { layout: { width: 420, height: 600, x: 0, y: 0 } },
    });
    expect(screen.getByLabelText('Next page').props.className).toMatch(/\bw-6\b/);
    await fireEvent(screen.getByTestId('companion-text'), 'layout', {
      nativeEvent: { layout: { width: 900, height: 600, x: 0, y: 0 } },
    });
    expect(screen.getByLabelText('Next page').props.className).toMatch(/\bw-11\b/);
  });

  it('offers Back to narration once the listener turned away, and follows on a press', async () => {
    await mount();
    await shows();
    await act(async () => host().onFollowing!(false));
    await fireEvent.press(screen.getByText('Back to narration'));
    expect(mockHandle.follow).toHaveBeenCalled();
  });

  it('says a part of the book that did not load, and Try again opens it again (fe#164)', async () => {
    await mount();
    await shows();
    await act(async () => host().onMessage({ type: 'error', code: 'section', message: 'x' }));
    expect(screen.getByText("Couldn't load the text")).toBeTruthy();
    expect(screen.getByText(/A part of the book didn't load/)).toBeTruthy();
    const before = mockMounts;
    await fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(mockMounts).toBe(before + 1));
  });

  it("says when the map names nothing in this ebook, with an admin's Make again", async () => {
    await mount();
    await act(async () => host().onReadalongState!({ state: 'none', unresolved: 3 }));
    expect(screen.getByText("The text can't follow this narration")).toBeTruthy();
    expect(screen.getByTestId('make-offer').props.children).toBe('again:true');
  });

  it('offers an admin Make read-along for a book with no map yet', async () => {
    await act(async () => {
      render(
        <TextPanel
          target={TARGET}
          text={model({ map: null, book: { ...BOOK, readalong: undefined } })}
          fill
        />,
      );
    });
    expect(screen.getByText('No read-along for this book yet')).toBeTruthy();
    expect(screen.getByTestId('make-offer').props.children).toBe('first:true');
    expect(mockHost).toBeNull();
  });

  it('says why a stale map no longer fits, offering to make it again', async () => {
    const stale = { ...BOOK, readalong: { state: 'stale', reason: 'ebook_changed' } } as Book;
    await act(async () => {
      render(<TextPanel target={TARGET} text={model({ map: null, book: stale })} fill />);
    });
    expect(screen.getByText('The read-along is out of date')).toBeTruthy();
    expect(screen.getByText(/The ebook changed since it was made/)).toBeTruthy();
    expect(screen.getByTestId('make-offer').props.children).toBe('again:true');
  });

  it("says the book's server is not connected instead of opening it", async () => {
    mockApi = null;
    await act(async () => {
      render(<TextPanel target={TARGET} text={model()} fill />);
    });
    expect(screen.getByText("This book's server isn't connected")).toBeTruthy();
    expect(mockHost).toBeNull();
  });
});
