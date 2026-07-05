import { act, render, screen } from '@testing-library/react-native';

// The skeleton components are pure, but their modules pull in the screen deps
// (expo-router via @/lib/open, the API/downloads stores). Stub those boundaries so
// the module graph loads under jest without the ESM expo-router entry.
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openBook: jest.fn(), openLibrary: jest.fn(), openPlayer: jest.fn() }),
}));
jest.mock('@/api/provider', () => ({
  useApi: () => ({ coverUrl: () => '', authHeaders: () => ({}) }),
  useCid: (cid?: string) => cid,
}));
jest.mock('@/downloads/store', () => ({ useDownloadEntry: () => undefined }));
// theme-provider side-effect-imports global.css (unparseable in Node); stub the hook.
jest.mock('@/theme/theme-provider', () => ({
  useTheme: () => ({ scheme: 'dark', pref: 'dark', setPref: jest.fn() }),
}));

/* eslint-disable import/first */
import { GridCardSkeleton } from './poster-grid';
import { BookRowSkeleton, BookRowSkeletonList } from './search-results';
/* eslint-enable import/first */

async function mount(ui: React.ReactElement) {
  await act(async () => {
    render(ui);
  });
}

describe('library skeletons', () => {
  it('renders a grid card skeleton', async () => {
    await mount(<GridCardSkeleton width={160} />);
    expect(screen.root).toBeTruthy();
  });

  it('renders a grid card skeleton with a footer line', async () => {
    await mount(<GridCardSkeleton width={160} footer />);
    expect(screen.root).toBeTruthy();
  });

  it('renders a single row skeleton', async () => {
    await mount(<BookRowSkeleton />);
    expect(screen.root).toBeTruthy();
  });

  it('renders the requested number of row skeletons', async () => {
    await mount(<BookRowSkeletonList count={4} />);
    expect(screen.root).toBeTruthy();
  });
});
