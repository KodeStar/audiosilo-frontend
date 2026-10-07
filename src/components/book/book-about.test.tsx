import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { Book } from '@/api/types';
import type { MatchedBookMeta } from '@/components/library/book-meta';

const mockOpenExternal = jest.fn();
jest.mock('@/lib/support', () => ({
  openExternalUrl: (url: string) => mockOpenExternal(url),
}));
// CoverFrame's iOS shadow hook (book-meta's) reads the theme provider, whose module
// side-effect-imports global.css (unparseable in Node); stub the hook.
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'dark', pref: 'dark', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import { BookAbout } from './book-about';
/* eslint-enable import/first */

const book = (over: Partial<Book> = {}) =>
  ({ title: 'The Hobbit', author: 'J. R. R. Tolkien', narrator: '', ...over }) as Book;

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

beforeEach(() => mockOpenExternal.mockReset());

describe('BookAbout', () => {
  it('renders the description, production details and the meta link', async () => {
    await mount(<BookAbout book={book()} meta={HOBBIT} />);
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
        attribution: {
          credit: 'AudioSilo Meta contributors',
          license: 'CC BY-SA 4.0',
          license_url: 'https://cc/by-sa',
          source_url: 'https://m/work?id=the-hobbit&edit',
        },
      },
    };
    await mount(<BookAbout book={book({ description: 'Server text.' })} meta={community} />);
    expect(screen.getByText('A hobbit goes there and back again.')).toBeTruthy();
    expect(screen.queryByText('Server text.')).toBeNull();
    expect(screen.getByText('CC BY-SA 4.0')).toBeTruthy();
    await press('Improve this');
    expect(mockOpenExternal).toHaveBeenCalledWith('https://m/work?id=the-hobbit&edit');
  });

  it('reads complete for an unmatched book: the server text, else who wrote it', async () => {
    await mount(<BookAbout book={book({ description: "  The server's own words.  " })} />);
    expect(screen.getByText("The server's own words.")).toBeTruthy();
    expect(screen.queryByText('View on AudioSilo Meta')).toBeNull();
    await mount(<BookAbout book={book({ published: '2010-08-31' })} />);
    expect(screen.getByText(/^The Hobbit .*J\. R\. R\. Tolkien/)).toBeTruthy();
    expect(screen.getByText('2010-08-31')).toBeTruthy();
    expect(screen.queryByText('Publisher')).toBeNull();
  });
});
