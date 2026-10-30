import { render, screen } from '@testing-library/react-native';

// The entry's action and badge have their own tests (the series page's).
jest.mock('./entry-actions', () => ({ EntryActionButton: () => null, EntryBadge: () => null }));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/components/library/book-cover', () => ({ BookCover: () => null }));
jest.mock('@/lib/layout', () => ({
  ...jest.requireActual('@/lib/layout'),
  useLayout: () => 'desktop',
}));

/* eslint-disable import/first */
import { formatReleaseDate } from '@/lib/format';

import type { SeriesEntry } from './series-model';
import { EntryList, ShelfCaption } from './series-parts';
/* eslint-enable import/first */

// A ghost's release date (Track U2): "Out <date>" while it is ahead, in the list and under
// the bookcase; once out it is only the year, as for any book.
const ghost = (over: Partial<SeriesEntry>): SeriesEntry =>
  ({
    key: 'w:x',
    position: '6',
    title: 'Book Six',
    kind: 'ghost',
    fraction: 0,
    started: false,
    finished: false,
    ...over,
  }) as SeriesEntry;

beforeAll(() => {
  jest.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), doNotFake: ['setTimeout'] });
});
afterAll(() => jest.useRealTimers());

describe('a ghost with a release date', () => {
  it('says "Out <date>" in the list while its release is ahead', async () => {
    await render(<EntryList entries={[ghost({ releaseDate: '2026-11-12' })]} />);
    // In the device's own date order ("12 Nov 2026", "Nov 12, 2026").
    expect(screen.getByText(`Out ${formatReleaseDate('2026-11-12')}`)).toBeTruthy();
    expect(screen.queryByText('Not in your library')).toBeNull();
  });

  it('says it under the bookcase too', async () => {
    await render(
      <ShelfCaption entry={ghost({ releaseDate: '2026-11' })} current={false} here="Home" />,
    );
    expect(screen.getByText('Out Nov 2026. Not on your servers yet.')).toBeTruthy();
  });

  it('is only its year once out', async () => {
    await render(<EntryList entries={[ghost({ releaseDate: '2014-06-01', year: '2014' })]} />);
    expect(screen.getByText('2014 · Not in your library')).toBeTruthy();
    expect(screen.queryByText(/^Out /)).toBeNull();
  });
});
