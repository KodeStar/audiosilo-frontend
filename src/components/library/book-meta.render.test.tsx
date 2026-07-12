import { render } from '@testing-library/react-native';

import type { BookMeta } from '@/api/types';

import { BookMetaSection } from './book-meta';

// The component pulls its data from useBookMeta; drive it directly so the render
// is exercised without a live server / QueryClient.
jest.mock('@/api/hooks', () => ({ useBookMeta: jest.fn() }));
// eslint-disable-next-line import/first
import { useBookMeta } from '@/api/hooks';
const mockUseBookMeta = useBookMeta as jest.Mock;

const matched: Extract<BookMeta, { matched: true }> = {
  matched: true,
  work: {
    id: 'the-hobbit',
    title: 'The Hobbit',
    authors: [{ id: 'jrr', name: 'J. R. R. Tolkien' }],
    language: 'en',
    characters: [
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
    ],
    recaps: [
      { through: { chapter: 0 }, scope: 'series', text: 'Prior books.' },
      { through: { chapter: 6 }, scope: 'book', text: 'So far.' },
    ],
  },
  web_url: 'https://m/work?id=the-hobbit',
};

describe('BookMetaSection render', () => {
  it('renders the character cast and the story-so-far recaps when matched', async () => {
    mockUseBookMeta.mockReturnValue({ data: matched });
    const { getByText } = await render(<BookMetaSection libraryId={1} path="p" enabled />);

    // Section headings.
    expect(getByText('Characters')).toBeTruthy();
    expect(getByText('Story so far')).toBeTruthy();
    // Character names + role badge + reveal line (always visible; description is
    // behind the per-card accordion so it is not asserted here).
    expect(getByText('Bilbo Baggins')).toBeTruthy();
    expect(getByText('Smaug')).toBeTruthy();
    expect(getByText('Protagonist')).toBeTruthy();
    expect(getByText('From chapter 12')).toBeTruthy();
    // Recap headings, position-labelled.
    expect(getByText('Previously, in earlier books')).toBeTruthy();
    expect(getByText('Up to chapter 6')).toBeTruthy();
  });

  it('renders nothing when there is no match', async () => {
    mockUseBookMeta.mockReturnValue({ data: { matched: false } });
    const { toJSON } = await render(<BookMetaSection libraryId={1} path="p" enabled />);
    expect(toJSON()).toBeNull();
  });

  it('renders nothing when disabled', async () => {
    mockUseBookMeta.mockReturnValue({ data: matched });
    const { toJSON } = await render(<BookMetaSection libraryId={1} path="p" enabled={false} />);
    expect(toJSON()).toBeNull();
  });
});
