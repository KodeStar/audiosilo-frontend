import { fireEvent, render, screen } from '@testing-library/react-native';
import { PixelRatio } from 'react-native';

// A host stand-in for expo-image, so the test can read the source and fire its error.
jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  return { Image: (props: object) => <View testID="cover-image" {...props} /> };
});

const mockApi = {
  coverUrl: jest.fn(
    (lib: number, path: string, o?: { size?: number; version?: string }) =>
      `https://s/libraries/${lib}/cover?path=${path}${o?.size ? `&size=${o.size}` : ''}${o?.version ? `&v=${o.version}` : ''}`,
  ),
  authHeaders: () => ({ Authorization: 'Bearer t' }),
};
let mockHasApi = true;
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => (mockHasApi ? mockApi : null),
}));
let mockInfo: { data?: { capabilities: { cover_sizes?: boolean } }; isError?: boolean } = {};
jest.mock('@/api/hooks', () => ({ useServerInfo: () => mockInfo }));
let mockEntry: { status: string; manifest: { coverUri: string | null } } | undefined;
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => mockEntry }));

// CoverFrame's iOS shadow reads the theme (the provider imports global.css).
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { BookCover, coverCandidates, coverSizeFor } from './book-cover';
/* eslint-enable import/first */

const url = (size?: number) => `u${size ?? ''}`;

describe('coverSizeFor', () => {
  it('picks the smallest thumbnail covering the drawn pixels', () => {
    expect(coverSizeFor(48, 3)).toBe(160);
    expect(coverSizeFor(80, 2)).toBe(160);
    expect(coverSizeFor(132, 2)).toBe(320);
    expect(coverSizeFor(164, 3)).toBe(640);
  });

  it('wants the full art past the largest thumbnail', () => {
    expect(coverSizeFor(400, 3)).toBeUndefined();
  });
});

describe('coverCandidates', () => {
  it('tries the downloaded copy, then the thumbnail, then the full art', () => {
    expect(coverCandidates({ local: 'file://c.jpg', thumbnails: true, url, size: 320 })).toEqual([
      'file://c.jpg',
      'u320',
      'u',
    ]);
  });

  it('goes straight to the full art without thumbnails (or a size)', () => {
    expect(coverCandidates({ thumbnails: false, url, size: 320 })).toEqual(['u']);
    expect(coverCandidates({ thumbnails: true, url })).toEqual(['u']);
  });

  it('offers nothing remote while the server flags are unknown', () => {
    expect(coverCandidates({ thumbnails: undefined, url, size: 160 })).toEqual([]);
    expect(coverCandidates({ local: 'file://c.jpg', thumbnails: undefined, url })).toEqual([
      'file://c.jpg',
    ]);
  });
});

describe('BookCover', () => {
  beforeEach(() => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(2);
    mockHasApi = true;
    mockInfo = { data: { capabilities: { cover_sizes: true } } };
    mockEntry = undefined;
    mockApi.coverUrl.mockClear();
  });

  const props = { connectionId: 'c', libraryId: 1, path: 'A/B', width: 132, title: 'Dune' };
  const source = () => screen.getByTestId('cover-image').props.source;

  it('asks for the thumbnail with the cover version, and falls back to the full art', async () => {
    await render(<BookCover {...props} coverVersion="v7" />);
    expect(source()).toEqual({
      uri: 'https://s/libraries/1/cover?path=A/B&size=320&v=v7',
      headers: { Authorization: 'Bearer t' },
    });
    await fireEvent(screen.getByTestId('cover-image'), 'error');
    expect(source().uri).toBe('https://s/libraries/1/cover?path=A/B&v=v7');
  });

  it('shows the title once every source has failed', async () => {
    mockInfo = { data: { capabilities: {} } };
    await render(<BookCover {...props} />);
    expect(source().uri).toBe('https://s/libraries/1/cover?path=A/B');
    await fireEvent(screen.getByTestId('cover-image'), 'error');
    expect(screen.queryByText('Dune')).toBeTruthy();
    expect(screen.queryByTestId('cover-image')).toBeNull();
  });

  it("uses the downloaded copy of a book that's on this device", async () => {
    mockEntry = { status: 'downloaded', manifest: { coverUri: 'file:///d/cover.jpg' } };
    await render(<BookCover {...props} />);
    expect(source()).toBe('file:///d/cover.jpg');
  });

  it('waits for the server flags instead of fetching the full art first', async () => {
    mockInfo = {};
    await render(<BookCover {...props} />);
    expect(screen.queryByTestId('cover-image')).toBeNull();
    // An empty frame, not the title fallback.
    expect(screen.queryByText('Dune')).toBeNull();
  });

  it('takes an unreachable server as one without thumbnails', async () => {
    mockInfo = { isError: true };
    await render(<BookCover {...props} />);
    expect(source().uri).toBe('https://s/libraries/1/cover?path=A/B');
  });
});
