import { act, render, screen } from '@testing-library/react-native';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
jest.mock('react-native-marked', () => ({ useMarkdown: () => [] }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
jest.mock('../playing-target', () => ({
  usePlayingTarget: () => ({ connectionId: 'gone', libraryId: 1, path: 'Corey/Calibans War' }),
}));
// The book's connection is gone (a download playing on after its server was removed):
// no client, and the throwing hooks behind Bookmarks, Notes and History throw as `useApi`.
jest.mock('@/api/provider', () => ({
  ConnectionScope: ({ children }: { children: unknown }) => children,
  useOptionalApi: () => null,
  useCid: (cid?: string) => cid ?? '',
}));
const mockNoClient = () => {
  throw new Error('useApi() requires a configured server connection');
};
jest.mock('@/api/hooks', () => ({
  useCapability: () => undefined,
  useBook: () => ({ data: undefined, isLoading: false }),
  useBookProgress: () => ({ data: undefined }),
  useChapters: () => ({ data: undefined, isLoading: false }),
  useBookMeta: () => ({ data: undefined, isLoading: false }),
  useBookmarks: mockNoClient,
  useDeleteBookmark: mockNoClient,
  useNotes: mockNoClient,
  useAddNote: mockNoClient,
  useDeleteNote: mockNoClient,
  useHistory: mockNoClient,
}));

/* eslint-disable import/first */
import { Companion } from './companion';
import type { CompanionTab } from './companion-model';
import { useCompanion } from './companion-store';
/* eslint-enable import/first */

describe('Companion', () => {
  it.each<CompanionTab>(['bookmarks', 'notes', 'history'])(
    "says the book's server is not connected on %s, instead of crashing",
    async (tab) => {
      useCompanion.setState({ tab });
      await act(async () => {
        render(<Companion variant="column" />);
      });
      expect(screen.getByText("This book's server isn't connected")).toBeTruthy();
    },
  );
});
