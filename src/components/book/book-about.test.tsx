import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { Book } from '@/api/types';
import type { MatchedBookMeta } from '@/components/library/book-meta';

const mockOpenExternal = jest.fn();
jest.mock('@/lib/support', () => ({
  openExternalUrl: (url: string) => mockOpenExternal(url),
}));
const mockOpenLibraryRoot = jest.fn();
jest.mock('@/lib/open', () => ({
  openLibraryRoot: (href: unknown) => mockOpenLibraryRoot(href),
}));
// CoverFrame's iOS shadow hook (book-meta's) reads the theme provider, whose module
// side-effect-imports global.css (unparseable in Node); stub the hook.
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'dark', pref: 'dark', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import { useLibrarySelection } from '@/stores/library-selection';

import { BookAbout, openLabelBooks } from './book-about';
/* eslint-enable import/first */

const book = (over: Partial<Book> = {}) =>
  ({ title: 'The Hobbit', author: 'J. R. R. Tolkien', narrator: '', ...over }) as Book;

/** The server's CC BY-SA credit for a work's community content. */
const ATTRIBUTION = {
  credit: 'AudioSilo Meta contributors',
  license: 'CC BY-SA 4.0',
  license_url: 'https://cc/by-sa',
  source_url: 'https://m/work?id=the-hobbit&edit',
};

const HOBBIT: MatchedBookMeta = {
  matched: true,
  work: {
    id: 'the-hobbit',
    title: 'The Hobbit',
    authors: [{ id: 'jrr', name: 'J. R. R. Tolkien' }],
    language: 'en',
    description: 'In a hole in the ground there lived a hobbit.',
    first_published: '1937',
  },
  recording: { id: 'rec', narrators: [], publisher: 'Recorded Books', abridged: true },
  web_url: 'https://m/work?id=the-hobbit',
};

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

beforeEach(() => {
  mockOpenExternal.mockReset();
  mockOpenLibraryRoot.mockReset();
});

describe('BookAbout', () => {
  it('renders the description, production details and the meta link', async () => {
    await mount(
      <BookAbout book={book()} meta={HOBBIT} work={HOBBIT.work} onOpenLabel={jest.fn()} />,
    );
    expect(screen.getByText('About')).toBeTruthy();
    expect(screen.getByText('In a hole in the ground there lived a hobbit.')).toBeTruthy();
    expect(screen.getByText('Recorded Books')).toBeTruthy();
    expect(screen.getByText('1937')).toBeTruthy();
    expect(screen.getByText('Abridged')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();
    // No community text: no licence line, and the work's page is one quiet link away.
    expect(screen.queryByText('Improve this')).toBeNull();
    await press('View on AudioSilo Meta');
    expect(mockOpenExternal).toHaveBeenCalledWith('https://m/work?id=the-hobbit');
  });

  it('leads with the community description, credited, with Improve this', async () => {
    const community: MatchedBookMeta = {
      ...HOBBIT,
      work: {
        ...HOBBIT.work,
        community_description: { text: 'A hobbit goes there and back again.' },
        attribution: ATTRIBUTION,
      },
    };
    await mount(
      <BookAbout
        book={book({ description: 'Server text.' })}
        meta={community}
        work={community.work}
        onOpenLabel={jest.fn()}
      />,
    );
    expect(screen.getByText('A hobbit goes there and back again.')).toBeTruthy();
    expect(screen.queryByText('Server text.')).toBeNull();
    expect(screen.getByText('CC BY-SA 4.0')).toBeTruthy();
    await press('Improve this');
    expect(mockOpenExternal).toHaveBeenCalledWith('https://m/work?id=the-hobbit&edit');
  });

  it('reads complete for an unmatched book: the server text, else who wrote it', async () => {
    await mount(
      <BookAbout
        book={book({ description: "  The server's own words.  " })}
        work={undefined}
        onOpenLabel={jest.fn()}
      />,
    );
    expect(screen.getByText("The server's own words.")).toBeTruthy();
    expect(screen.queryByText('View on AudioSilo Meta')).toBeNull();
    await mount(
      <BookAbout
        book={book({ published: '2010-08-31' })}
        work={undefined}
        onOpenLabel={jest.fn()}
      />,
    );
    expect(screen.getByText(/^The Hobbit .*J\. R\. R\. Tolkien/)).toBeTruthy();
    expect(screen.getByText('2010-08-31')).toBeTruthy();
    expect(screen.queryByText('Publisher')).toBeNull();
  });

  describe('a description generated on this server (Bridge 1c)', () => {
    const WRITTEN = 'Written on this server in its own words.';
    const generated = {
      generated: { description: true },
      generated_description: { text: WRITTEN },
    };
    // An unmatched book's work, as the server builds it from what its Bridge generated.
    const unmatched = { id: '', title: 'The Hobbit', authors: [], language: '', ...generated };

    it('marks it, with no credit or Improve this, and keeps the meta link', async () => {
      const bare: MatchedBookMeta = {
        ...HOBBIT,
        // An attribution for other community content must not ride on generated text.
        work: { ...HOBBIT.work, description: undefined, ...generated, attribution: ATTRIBUTION },
      };
      await mount(<BookAbout book={book()} meta={bare} work={bare.work} onOpenLabel={jest.fn()} />);
      expect(screen.getByText(WRITTEN)).toBeTruthy();
      expect(screen.getByTestId('about-generated-mark')).toBeTruthy();
      expect(screen.getByText('Generated on this server')).toBeTruthy();
      expect(screen.queryByText('CC BY-SA 4.0')).toBeNull();
      expect(screen.queryByText('Improve this')).toBeNull();
      await press('View on AudioSilo Meta');
      expect(mockOpenExternal).toHaveBeenCalledWith('https://m/work?id=the-hobbit');
    });

    it('shows it for an unmatched book, with no link to AudioSilo Meta', async () => {
      await mount(<BookAbout book={book()} work={unmatched} onOpenLabel={jest.fn()} />);
      expect(screen.getByText(WRITTEN)).toBeTruthy();
      expect(screen.getByTestId('about-generated-mark')).toBeTruthy();
      expect(screen.queryByText('View on AudioSilo Meta')).toBeNull();
    });

    it("gives way to the book's own description, unmarked", async () => {
      await mount(
        <BookAbout
          book={book({ description: 'Server text.' })}
          work={unmatched}
          onOpenLabel={jest.fn()}
        />,
      );
      expect(screen.getByText('Server text.')).toBeTruthy();
      expect(screen.queryByText(WRITTEN)).toBeNull();
      expect(screen.queryByTestId('about-generated-mark')).toBeNull();
      expect(screen.queryByText('Generated on this server')).toBeNull();
    });

    // The credit is the work's own, beside the community text it credits: never another
    // object's, so a work handed in without its envelope still carries its licence.
    it('credits community text from the work it came from', async () => {
      const work = {
        ...HOBBIT.work,
        community_description: { text: 'A hobbit goes there and back again.' },
        attribution: ATTRIBUTION,
      };
      await mount(<BookAbout book={book()} work={work} onOpenLabel={jest.fn()} />);
      expect(screen.getByText('A hobbit goes there and back again.')).toBeTruthy();
      expect(screen.getByText('CC BY-SA 4.0')).toBeTruthy();
      await press('Improve this');
      expect(mockOpenExternal).toHaveBeenCalledWith('https://m/work?id=the-hobbit&edit');
    });
  });

  it("shows the book's genres and tags as chips, each opening the Library on it", async () => {
    const onOpenLabel = jest.fn();
    await mount(
      <BookAbout
        book={book({ genres: ['Fantasy', 'Classics'], tags: ['Book club'], language: 'English' })}
        work={undefined}
        onOpenLabel={onOpenLabel}
      />,
    );
    expect(screen.getByText('Genres')).toBeTruthy();
    expect(screen.getByText('Tags')).toBeTruthy();
    expect(screen.getByText('Classics')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Books in the genre Fantasy'));
    });
    expect(onOpenLabel).toHaveBeenCalledWith('genre', 'Fantasy');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Books tagged Book club'));
    });
    expect(onOpenLabel).toHaveBeenLastCalledWith('tag', 'Book club');
  });

  it('shows no labels for a book without them (an older server)', async () => {
    await mount(<BookAbout book={book()} work={undefined} onOpenLabel={jest.fn()} />);
    expect(screen.queryByText('Genres')).toBeNull();
    expect(screen.queryByText('Tags')).toBeNull();
  });
});

describe('openLabelBooks', () => {
  it("selects the book's library, then opens its Books mode on the label", () => {
    openLabelBooks('c2', 7, 'tag', 'Book club');
    expect(useLibrarySelection.getState().selection).toEqual({ connectionId: 'c2', libraryId: 7 });
    expect(mockOpenLibraryRoot).toHaveBeenCalledWith({
      pathname: '/library',
      params: { mode: 'books', tag: 'Book club' },
    });
  });
});
