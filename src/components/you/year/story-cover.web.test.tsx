import { fireEvent, render, screen } from '@testing-library/react-native';

// BookCover's module (whose pure helpers this reuses) reaches the downloads store.
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
let mockCaps: Record<string, boolean> | undefined = { cover_sizes: true };
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: mockCaps && { capabilities: mockCaps }, isError: false }),
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({
    coverUrl: (lib: number, path: string, o: { size?: number }) =>
      `/api/v1/libraries/${lib}/cover?path=${path}${o.size ? `&size=${o.size}` : ''}&token=t`,
  }),
}));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  return {
    Image: (p: { source: unknown; onError: () => void }) => (
      <View
        testID="cover-image"
        accessibilityHint={JSON.stringify(p.source)}
        onTouchEnd={p.onError}
      />
    ),
  };
});

/* eslint-disable import/first */
import { StoryCoverArt } from './story-cover.web';
/* eslint-enable import/first */

const book = { library_id: 1, path: 'Doyle/Four', title: 'The Sign of the Four', author: 'Doyle' };
const source = () => JSON.parse(screen.getByTestId('cover-image').props.accessibilityHint);

beforeEach(() => {
  mockCaps = { cover_sizes: true };
});

describe('StoryCoverArt (web)', () => {
  it('uses a plain same-origin URL sized for the share image, never a blob', async () => {
    await render(<StoryCoverArt connectionId="a" book={book} width={44} plain={false} />);
    // 44 points on a card shared at 3x: the 160 thumbnail, as a plain string (no headers).
    expect(source()).toBe('/api/v1/libraries/1/cover?path=Doyle/Four&size=160&token=t');
  });

  it('falls back from the thumbnail to the full art, then to the title', async () => {
    // 200 points at 3x is 600: the 640 thumbnail (at 223 it would be the full art).
    await render(<StoryCoverArt connectionId="a" book={book} width={200} plain={false} />);
    expect(source()).toBe('/api/v1/libraries/1/cover?path=Doyle/Four&size=640&token=t');
    await fireEvent(screen.getByTestId('cover-image'), 'touchEnd');
    expect(source()).toBe('/api/v1/libraries/1/cover?path=Doyle/Four&token=t');
    await fireEvent(screen.getByTestId('cover-image'), 'touchEnd');
    expect(screen.queryByTestId('cover-image')).toBeNull();
    expect(screen.getByText('The Sign of the Four')).toBeTruthy();
  });

  it('draws the title for a share’s second try', async () => {
    await render(<StoryCoverArt connectionId="a" book={book} width={223} plain />);
    expect(screen.queryByTestId('cover-image')).toBeNull();
    expect(screen.getByText('The Sign of the Four')).toBeTruthy();
  });
});
