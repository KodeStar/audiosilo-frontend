import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Book, ChaptersResponse } from '@/api/types';

let mockCanTranscode: boolean | undefined = true;
jest.mock('@/api/hooks', () => ({
  useCapability: (flag: string) => (flag === 'transcode' ? mockCanTranscode : undefined),
}));

/* eslint-disable import/first */
import { useNeedsWebTranscode } from '@/playback/transcode-capability';

import { TranscodeNote } from './transcode-note';
/* eslint-enable import/first */

/** The note as the book page draws it: under the page's own read of the rule. */
function PageNote(props: { book: Book; chapterData?: ChaptersResponse; downloaded: boolean }) {
  const transcoded = useNeedsWebTranscode(props.book, props.chapterData, 'c1');
  return <TranscodeNote {...props} transcoded={transcoded} />;
}

const book = (p: Partial<Book> = {}) =>
  ({ title: 'B', rel_path: 'A/B.m4b', direct_playable: false, codec: 'ac3', ...p }) as Book;

describe('TranscodeNote', () => {
  const prevOS = Platform.OS;
  beforeEach(() => {
    Platform.OS = 'web';
    mockCanTranscode = true;
  });
  afterEach(() => {
    Platform.OS = prevOS;
  });

  it('says the codec is converted for this browser on web', async () => {
    await render(<PageNote book={book()} downloaded={false} />);
    expect(screen.getByText('AC-3 audio is converted to MP3 for this browser')).toBeTruthy();
  });

  it('prefers the chapters codec and falls back to generic copy without one', async () => {
    const chapters = { codec: 'alac' } as ChaptersResponse;
    await render(<PageNote book={book()} chapterData={chapters} downloaded={false} />);
    expect(screen.getByText('ALAC audio is converted to MP3 for this browser')).toBeTruthy();
    await render(<PageNote book={book({ codec: '' })} downloaded={false} />);
    expect(screen.getByText('This audio is converted to MP3 for this browser')).toBeTruthy();
  });

  it.each([
    ['on native', 'ios', book(), true, false],
    ['without a transcoder', 'web', book(), false, false],
    ['while the capability is unknown', 'web', book(), undefined, false],
    ['for a direct-playable book', 'web', book({ direct_playable: true }), true, false],
    ['for a downloaded book', 'web', book(), true, true],
  ] as const)('renders nothing %s', async (_label, os, b, canTranscode, downloaded) => {
    Platform.OS = os;
    mockCanTranscode = canTranscode;
    await render(<PageNote book={b} downloaded={downloaded} />);
    expect(screen.queryByText(/converted to MP3/)).toBeNull();
  });
});
