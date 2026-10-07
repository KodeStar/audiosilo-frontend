import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import type {
  BookMetaCharacter,
  BookMetaRecap,
  BookMetaSeries,
  BookMetaSeriesWork,
  BookMetaWork,
} from '@/api/types';

// The previous-books rows fetch one work each, lazily. Mocking the hook lets the
// tests drive loading / loaded / failed without a QueryClient, and asserts the
// `enabled` flag so a CLOSED row is proven never to fetch.
const mockUseMetaWork = jest.fn();
jest.mock('@/api/hooks', () => ({
  useSavedProgress: () => undefined,
  useMetaWork: (workId: string, enabled: boolean) => mockUseMetaWork(workId, enabled),
}));
// CoverFrame's iOS shadow hook reads the theme provider, whose module side-effect-
// imports global.css (unparseable in Node); stub the hook.
const mockOpenExternal = jest.fn();
jest.mock('@/lib/support', () => ({
  openExternalUrl: (url: string) => mockOpenExternal(url),
}));
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'dark', pref: 'dark', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import {
  BookMetaCharactersTab,
  BookMetaRecapsTab,
  BookMetaSeriesTab,
  summaryIsVisible,
} from './book-meta';
import { seriesRails } from './series-rails';
/* eslint-enable import/first */

// The spoiler reveal is the SCREEN's state (shared by both tabs), so these
// harnesses stand in for it - letting the tests drive the toggle as a user does.
type CharactersProps = Omit<
  React.ComponentProps<typeof BookMetaCharactersTab>,
  'showSpoilers' | 'onToggleSpoilers'
>;
function CharactersTab(props: CharactersProps) {
  const [show, setShow] = useState(false);
  return (
    <BookMetaCharactersTab
      {...props}
      showSpoilers={show}
      onToggleSpoilers={() => setShow((v) => !v)}
    />
  );
}

type RecapsProps = Omit<
  React.ComponentProps<typeof BookMetaRecapsTab>,
  'showSpoilers' | 'onToggleSpoilers' | 'summaryVisible'
> & { summaryVisible?: boolean };
function RecapsTab({ summaryVisible, ...props }: RecapsProps) {
  const [show, setShow] = useState(false);
  // Calls the screen's OWN predicate rather than re-deriving it, so the harness can
  // never drift from what the screen would pass. A test may still state it outright.
  const visible = summaryVisible ?? summaryIsVisible(props.summary, props.progress.finished);
  return (
    <BookMetaRecapsTab
      {...props}
      summaryVisible={visible}
      showSpoilers={show}
      onToggleSpoilers={() => setShow((v) => !v)}
    />
  );
}

beforeEach(() => {
  mockOpenExternal.mockReset();
  mockUseMetaWork.mockReset();
  mockUseMetaWork.mockReturnValue({ data: undefined, isError: false });
});

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(label));
  });
}

const characters: BookMetaCharacter[] = [
  {
    id: 'bilbo',
    name: 'Bilbo Baggins',
    role: 'protagonist',
    reveal: { chapter: 1 },
    description: 'A hobbit.',
  },
  {
    id: 'smaug',
    name: 'Smaug',
    role: 'antagonist',
    reveal: { chapter: 12 },
    description: 'A dragon.',
  },
];

const recaps: BookMetaRecap[] = [
  { through: { chapter: 0 }, scope: 'series', text: 'Prior books.' },
  { through: { chapter: 6 }, scope: 'book', text: 'So far.' },
];

describe('BookMetaCharactersTab', () => {
  it('hides characters the listener has not reached, then reveals them on request', async () => {
    await mount(
      <CharactersTab characters={characters} progress={{ chapter: 1, finished: false }} />,
    );

    expect(screen.getByText('Bilbo Baggins')).toBeTruthy();
    expect(screen.getByText('Protagonist')).toBeTruthy();
    expect(screen.queryByText('Smaug')).toBeNull();
    expect(screen.getByText('1 hidden to avoid spoilers')).toBeTruthy();

    await press('Show anyway');
    expect(screen.getByText('Smaug')).toBeTruthy();
    expect(screen.getByText('From chapter 12')).toBeTruthy();
    expect(screen.getByText('Spoiler')).toBeTruthy();
    expect(screen.getByText('Hide spoilers')).toBeTruthy();
    // The count caption goes with the reveal - it would otherwise claim entries are
    // hidden while sitting right next to them.
    expect(screen.queryByText('1 hidden to avoid spoilers')).toBeNull();

    await press('Hide spoilers');
    expect(screen.queryByText('Smaug')).toBeNull();
    expect(screen.getByText('1 hidden to avoid spoilers')).toBeTruthy();
  });

  it('shows the whole cast, with no spoiler notice, on a finished book', async () => {
    await mount(
      <CharactersTab characters={characters} progress={{ chapter: 2, finished: true }} />,
    );
    expect(screen.getByText('Bilbo Baggins')).toBeTruthy();
    expect(screen.getByText('Smaug')).toBeTruthy();
    expect(screen.queryByText('Show anyway')).toBeNull();
  });
});

describe('BookMetaRecapsTab', () => {
  it('shows only the recaps whose chapters are behind the listener', async () => {
    await mount(<RecapsTab recaps={recaps} progress={{ chapter: 3, finished: false }} />);

    expect(screen.getByText('Previously, in earlier books')).toBeTruthy();
    expect(screen.queryByText('Up to chapter 6')).toBeNull();
    expect(screen.getByText('1 hidden to avoid spoilers')).toBeTruthy();

    await press('Show anyway');
    expect(screen.getByText('Up to chapter 6')).toBeTruthy();
  });

  it('keeps the recap text behind its own accordion', async () => {
    await mount(<RecapsTab recaps={recaps} progress={{ chapter: 9, finished: false }} />);
    expect(screen.queryByText('So far.')).toBeNull();
    await press('Up to chapter 6');
    expect(screen.getByText('So far.')).toBeTruthy();
  });
});

describe('BookMetaSeriesTab', () => {
  it('renders each rail work with its position', async () => {
    await mount(
      <BookMetaSeriesTab
        rails={seriesRails(
          [
            {
              id: 's',
              name: 'Middle-earth',
              position: '1',
              works: [
                {
                  id: 'lotr',
                  title: 'The Fellowship of the Ring',
                  position: '2',
                  authors: [],
                  web_url: 'https://m/work?id=lotr',
                },
              ],
            },
          ],
          'the-hobbit',
        )}
      />,
    );
    // The title appears twice (the cover's own placeholder label + the caption),
    // so identify the rail entry by its link label.
    expect(screen.getByLabelText('The Fellowship of the Ring')).toBeTruthy();
    expect(screen.getByText('Book 2')).toBeTruthy();
    // A series with one order has no toggle.
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('BookMetaSeriesTab reading-order toggle', () => {
  const entry = (id: string, title: string, position: string): BookMetaSeriesWork => ({
    id,
    title,
    position,
    authors: [],
    web_url: `https://m/work?id=${id}`,
  });
  const narnia: BookMetaSeries = {
    id: 'narnia',
    name: 'The Chronicles of Narnia',
    position: '1',
    ordering: 'publication',
    works: [entry('lion', 'The Lion', '1'), entry('caspian', 'Prince Caspian', '2')],
    orderings: [
      {
        id: 'narnia-chronological',
        name: 'The Chronicles of Narnia (Chronological)',
        ordering: 'chronological',
        ordering_of: 'narnia',
        position: '2',
        works: [entry('nephew', "The Magician's Nephew", '1'), entry('lion', 'The Lion', '2')],
      },
    ],
  };

  // Stands in for the screen: the pick lives above the tab and drives its rails,
  // exactly as the book screen's remembered per-family picks do.
  function Harness({ series, onPick }: { series: BookMetaSeries; onPick?: jest.Mock }) {
    const [picks, setPicks] = useState<Record<string, string>>({});
    return (
      <BookMetaSeriesTab
        rails={seriesRails([series], 'lion', picks)}
        onSelectView={(family, id) => {
          onPick?.(family, id);
          setPicks((p) => ({ ...p, [family]: id }));
        }}
      />
    );
  }

  it('offers a labelled radio group, the main order checked', async () => {
    await mount(<Harness series={narnia} />);
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Publication', checked: true })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Chronological', checked: false })).toBeTruthy();
    expect(screen.getByLabelText('Reading order')).toBeTruthy();
    expect(screen.getByLabelText('Prince Caspian')).toBeTruthy();
    expect(screen.queryByLabelText("The Magician's Nephew")).toBeNull();
  });

  it('switches the rail to the picked order and reports the pick for its family', async () => {
    const onPick = jest.fn();
    await mount(<Harness series={narnia} onPick={onPick} />);
    await press('Chronological');
    expect(onPick).toHaveBeenCalledWith('narnia', 'narnia-chronological');
    expect(screen.getByRole('radio', { name: 'Chronological', checked: true })).toBeTruthy();
    expect(screen.getByLabelText("The Magician's Nephew")).toBeTruthy();
    expect(screen.queryByLabelText('Prince Caspian')).toBeNull();
  });

  it('falls back to the series name when an order states no ordering', async () => {
    const unlabelled: BookMetaSeries = {
      ...narnia,
      ordering: undefined,
    };
    await mount(<Harness series={unlabelled} />);
    expect(screen.getByRole('radio', { name: 'The Chronicles of Narnia' })).toBeTruthy();
  });

  it('says so when the book is not part of the picked order', async () => {
    const notInChron: BookMetaSeries = {
      ...narnia,
      orderings: [
        {
          ...narnia.orderings![0],
          position: undefined,
          works: [entry('nephew', "The Magician's Nephew", '1')],
        },
      ],
    };
    await mount(<Harness series={notInChron} />);
    expect(screen.queryByText("This book isn't part of this reading order.")).toBeNull();
    await press('Chronological');
    expect(screen.getByText("This book isn't part of this reading order.")).toBeTruthy();
    expect(screen.getByLabelText("The Magician's Nephew")).toBeTruthy();
  });
});

// --- Catching up on the previous books ------------------------------------

const previous: BookMetaSeriesWork[] = [
  {
    id: 'book-two',
    title: 'The Two Towers',
    position: '2',
    authors: [],
    web_url: 'https://m/work?id=book-two',
  },
  {
    id: 'book-one',
    title: 'The Fellowship',
    position: '1',
    authors: [],
    web_url: 'https://m/work?id=book-one',
  },
];

const fetched = (over: Partial<BookMetaWork>): BookMetaWork => ({
  id: 'book-two',
  title: 'The Two Towers',
  authors: [],
  language: 'en',
  ...over,
});

describe('previous books (Recaps tab)', () => {
  it('lists the earlier books closed, and fetches one only when it is opened', async () => {
    await mount(
      <RecapsTab
        recaps={recaps}
        progress={{ chapter: 9, finished: false }}
        previousBooks={previous}
      />,
    );

    expect(screen.getByText('Previous books')).toBeTruthy();
    expect(screen.getByText('The Two Towers')).toBeTruthy();
    expect(screen.getByText('Book 1')).toBeTruthy();
    // Both rows are closed, so neither may fetch.
    expect(mockUseMetaWork).toHaveBeenCalledWith('book-two', false);
    expect(mockUseMetaWork).toHaveBeenCalledWith('book-one', false);

    mockUseMetaWork.mockReturnValue({
      data: fetched({ recap_summary: { in_short: 'Frodo went east.' } }),
      isError: false,
    });
    await press('The Two Towers');
    expect(mockUseMetaWork).toHaveBeenCalledWith('book-two', true);
    // Only the opened row fetches.
    expect(mockUseMetaWork).not.toHaveBeenCalledWith('book-one', true);
    expect(screen.getByText('In short')).toBeTruthy();
    expect(screen.getByText('Frodo went east.')).toBeTruthy();
  });

  it('shows the in_short inline but keeps the ending behind its own extra tap', async () => {
    mockUseMetaWork.mockReturnValue({
      data: fetched({
        recap_summary: { in_short: 'A journey.', ending: 'The ring is destroyed.' },
      }),
      isError: false,
    });
    await mount(
      <RecapsTab recaps={[]} progress={{ chapter: 0, finished: false }} previousBooks={previous} />,
    );

    await press('The Two Towers');
    // The earlier book's in_short is inline (no "whole-book summary" tap), even
    // though the CURRENT book is unfinished: the reader opened this row deliberately.
    expect(screen.getByText('A journey.')).toBeTruthy();
    expect(screen.queryByText('Whole-book summary')).toBeNull();
    expect(screen.getByText('How it ends')).toBeTruthy();
    expect(screen.queryByText('The ring is destroyed.')).toBeNull();

    await press('How it ends');
    expect(screen.getByText('The ring is destroyed.')).toBeTruthy();
  });

  it('falls back to the furthest book-scope recap when there is no summary', async () => {
    mockUseMetaWork.mockReturnValue({
      data: fetched({
        recaps: [
          { through: { chapter: 3 }, scope: 'book', text: 'Early on.' },
          { through: { chapter: 20 }, scope: 'book', text: 'Nearly all of it.' },
        ],
      }),
      isError: false,
    });
    await mount(
      <RecapsTab recaps={[]} progress={{ chapter: 0, finished: false }} previousBooks={previous} />,
    );

    await press('The Two Towers');
    expect(screen.getByText('Nearly all of it.')).toBeTruthy();
    expect(screen.queryByText('Early on.')).toBeNull();
  });

  it('shows a quiet note plus the meta link when the work has no recap at all', async () => {
    mockUseMetaWork.mockReturnValue({ data: fetched({}), isError: false });
    await mount(
      <RecapsTab recaps={[]} progress={{ chapter: 0, finished: false }} previousBooks={previous} />,
    );
    await press('The Two Towers');
    expect(screen.getByText('No recap available for this book yet.')).toBeTruthy();
    expect(screen.getByText('View on AudioSilo Meta')).toBeTruthy();
  });

  it('degrades quietly when the fetch fails (old server / meta service down)', async () => {
    mockUseMetaWork.mockReturnValue({ data: undefined, isError: true });
    await mount(
      <RecapsTab recaps={[]} progress={{ chapter: 0, finished: false }} previousBooks={previous} />,
    );
    await press('The Two Towers');
    expect(screen.getByText("Couldn't load this book's details.")).toBeTruthy();
    expect(screen.getByText('View on AudioSilo Meta')).toBeTruthy();
  });
});

describe('previous books (Characters tab)', () => {
  it("renders the earlier book's cast as cards, descriptions still per-card", async () => {
    mockUseMetaWork.mockReturnValue({
      data: fetched({
        characters: [
          {
            id: 'gollum',
            name: 'Gollum',
            role: 'minor',
            reveal: { chapter: 4 },
            description: 'Sneaky.',
          },
        ],
      }),
      isError: false,
    });
    await mount(
      <CharactersTab
        characters={[]}
        progress={{ chapter: 0, finished: false }}
        previousBooks={previous}
      />,
    );

    await press('The Two Towers');
    expect(screen.getByText('Gollum')).toBeTruthy();
    // No spoiler gating inside a previous book, but the description keeps its own tap.
    expect(screen.queryByText('Sneaky.')).toBeNull();
    await press('Gollum');
    expect(screen.getByText('Sneaky.')).toBeTruthy();
  });

  it('shows a quiet note when the earlier book has no cast', async () => {
    mockUseMetaWork.mockReturnValue({ data: fetched({}), isError: false });
    await mount(
      <CharactersTab
        characters={[]}
        progress={{ chapter: 0, finished: false }}
        previousBooks={previous}
      />,
    );
    await press('The Fellowship');
    expect(screen.getByText('No characters listed for this book yet.')).toBeTruthy();
  });
});

describe("the current book's own summary", () => {
  // `in_short` is the whole book in one paragraph, ENDING INCLUDED - so mid-book it
  // must never render without a deliberate tap.
  const summary = {
    in_short: 'A hobbit goes there and back again.',
    ending: 'He comes home rich.',
  };

  it('hides the in_short behind a "Whole-book summary" spoiler row while unfinished', async () => {
    await mount(
      <RecapsTab recaps={recaps} progress={{ chapter: 9, finished: false }} summary={summary} />,
    );
    // Not mounted at all (not merely collapsed), so nothing leaks to a screen reader.
    expect(screen.queryByText('A hobbit goes there and back again.')).toBeNull();
    expect(screen.queryByText('In short')).toBeNull();
    expect(screen.getByText('Whole-book summary')).toBeTruthy();
    expect(screen.getByText('Spoiler')).toBeTruthy();
    // The position-keyed recaps still follow under their own heading.
    expect(screen.getByText('Story so far')).toBeTruthy();

    await press('Whole-book summary');
    expect(screen.getByText('A hobbit goes there and back again.')).toBeTruthy();
    // The label is a neutral heading, not an action: it stays put once expanded.
    expect(screen.getByText('Whole-book summary')).toBeTruthy();
  });

  it('withholds the ending entirely until the book is finished, even after the tap', async () => {
    await mount(
      <RecapsTab recaps={recaps} progress={{ chapter: 9, finished: false }} summary={summary} />,
    );
    expect(screen.queryByText('How it ends')).toBeNull();
    await press('Whole-book summary');
    expect(screen.queryByText('How it ends')).toBeNull();
    expect(screen.queryByText('He comes home rich.')).toBeNull();
  });

  it('renders the tap row for an in_short-only unfinished book, so the panel is never empty', async () => {
    await mount(
      <RecapsTab
        recaps={[]}
        progress={{ chapter: 2, finished: false }}
        summary={{ in_short: 'A hobbit goes there and back again.' }}
      />,
    );
    expect(screen.getByText('Whole-book summary')).toBeTruthy();
    expect(screen.queryByText('A hobbit goes there and back again.')).toBeNull();
  });

  it('shows the in_short inline once finished, above the story-so-far accordion', async () => {
    await mount(
      <RecapsTab recaps={recaps} progress={{ chapter: 9, finished: true }} summary={summary} />,
    );
    expect(screen.getByText('In short')).toBeTruthy();
    expect(screen.getByText('A hobbit goes there and back again.')).toBeTruthy();
    expect(screen.queryByText('Whole-book summary')).toBeNull();
    expect(screen.getByText('Story so far')).toBeTruthy();
  });

  it('offers the ending behind an extra tap once the book is finished', async () => {
    await mount(
      <RecapsTab recaps={recaps} progress={{ chapter: 9, finished: true }} summary={summary} />,
    );
    expect(screen.getByText('How it ends')).toBeTruthy();
    expect(screen.queryByText('He comes home rich.')).toBeNull();
    await press('How it ends');
    expect(screen.getByText('He comes home rich.')).toBeTruthy();
  });

  it('renders no summary block at all when the screen says it is not visible', async () => {
    // The ending-only, unfinished case: the screen computes `summaryVisible` false
    // (which is also why no Recaps tab exists for it), and the panel agrees.
    await mount(
      <RecapsTab
        recaps={[]}
        progress={{ chapter: 2, finished: false }}
        summary={{ ending: 'He comes home rich.' }}
        summaryVisible={false}
      />,
    );
    expect(screen.queryByText('How it ends')).toBeNull();
    expect(screen.queryByText('In short')).toBeNull();
    expect(screen.queryByText('Whole-book summary')).toBeNull();
  });
});

describe('the shared spoiler reveal', () => {
  it('renders the withheld entries when the screen already has spoilers shown', async () => {
    // Both tabs read ONE reveal held by the screen, so switching tabs after
    // revealing keeps them revealed - here: mounted with it already on.
    await mount(
      <BookMetaCharactersTab
        characters={characters}
        progress={{ chapter: 1, finished: false }}
        showSpoilers
        onToggleSpoilers={jest.fn()}
      />,
    );
    expect(screen.getByText('Smaug')).toBeTruthy();
    expect(screen.getByText('Spoiler')).toBeTruthy();
    expect(screen.getByText('Hide spoilers')).toBeTruthy();
  });

  it('reports the toggle to the screen rather than hiding it locally', async () => {
    const onToggleSpoilers = jest.fn();
    await mount(
      <BookMetaRecapsTab
        recaps={recaps}
        progress={{ chapter: 3, finished: false }}
        summaryVisible={false}
        showSpoilers={false}
        onToggleSpoilers={onToggleSpoilers}
      />,
    );
    await press('Show anyway');
    expect(onToggleSpoilers).toHaveBeenCalled();
    // Still hidden: only the screen's state can reveal them.
    expect(screen.queryByText('Up to chapter 6')).toBeNull();
  });
});
