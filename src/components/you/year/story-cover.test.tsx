import { render, screen } from '@testing-library/react-native';

// BookCover reaches the theme (its frame's shadow) and the downloads store.
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
jest.mock('@/api/hooks', () => ({
  useServerInfo: () => ({ data: { capabilities: { cover_sizes: true } }, isError: false }),
}));
jest.mock('@/api/provider', () => ({
  useOptionalApi: () => ({
    coverUrl: (lib: number, path: string, o: { size?: number }) =>
      `/api/v1/libraries/${lib}/cover?path=${path}${o.size ? `&size=${o.size}` : ''}&token=t`,
    authHeaders: () => ({ Authorization: 'Bearer t' }),
  }),
}));
jest.mock('expo-image', () => {
  const { View } = jest.requireActual('react-native');
  return { Image: (p: object) => <View testID="cover-image" {...p} /> };
});

/* eslint-disable import/first */
import { StoryCoverArt } from './story-cover';
/* eslint-enable import/first */

const book = { library_id: 1, path: 'Doyle/Four', title: 'The Sign of the Four', author: 'Doyle' };
const uri = () => {
  const source = screen.getByTestId('cover-image').props.source;
  return typeof source === 'string' ? source : source.uri;
};

describe('StoryCoverArt', () => {
  it('asks for the thumbnail that covers the share image', async () => {
    // 44 points on a card shared at 3x: the 160 thumbnail.
    await render(<StoryCoverArt connectionId="a" book={book} width={44} plain={false} />);
    expect(uri()).toBe('/api/v1/libraries/1/cover?path=Doyle/Four&size=160&token=t');
  });

  it('takes the largest thumbnail past it, never the full art', async () => {
    // 223 points at 3x is 669: past the largest thumbnail.
    await render(<StoryCoverArt connectionId="a" book={book} width={223} plain={false} />);
    expect(uri()).toBe('/api/v1/libraries/1/cover?path=Doyle/Four&size=640&token=t');
  });

  it('draws the title for a share’s second try', async () => {
    await render(<StoryCoverArt connectionId="a" book={book} width={223} plain />);
    expect(screen.queryByTestId('cover-image')).toBeNull();
    expect(screen.getByText('The Sign of the Four')).toBeTruthy();
  });
});
