import { render } from '@testing-library/react-native';

import { setFontScale } from '@/testing/font-scale';

jest.mock('expo-router', () => ({ router: { push: jest.fn(), setParams: jest.fn() } }));
jest.mock('@/lib/open', () => ({ useOpen: () => ({}) }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

const mockGrid = jest.fn();
jest.mock('./card-grid', () => ({
  CardGrid: (props: { phoneColumns?: number; minWidth: number }) => {
    mockGrid(props);
    return null;
  },
}));
jest.mock('@/api/hooks', () => ({
  useLibraryBooks: () => ({ data: undefined }),
  useProgressLookup: () => ({ progressOf: () => undefined }),
}));
jest.mock('@/lib/offline-state', () => ({ useUnreadQuery: () => null }));
jest.mock('@/lib/layout', () => ({ useLayout: () => 'phone' }));

/* eslint-disable import/first */
import { PeopleMode } from './people-mode';
/* eslint-enable import/first */

const list = {
  data: { people: [{ name: 'Brandon Sanderson', books: 2, duration: 21000 }], unknown: 0 },
  isPending: false,
  isPaused: false,
  error: null,
  refetch: jest.fn(),
} as never;

const lastGrid = () =>
  mockGrid.mock.calls.at(-1)?.[0] as { phoneColumns: number; minWidth: number };

describe('PeopleMode', () => {
  // fe#267: two columns at Android's 2.0 broke a name mid-word ("Brando / n Sand...").
  it('lays the people out one a row on a phone under large text', async () => {
    await render(<PeopleMode kind="author" connectionId="c" libraryId={1} list={list} />);
    expect(lastGrid().phoneColumns).toBe(2);
    const narrow = lastGrid().minWidth;
    try {
      await setFontScale(2);
      await render(<PeopleMode kind="author" connectionId="c" libraryId={1} list={list} />);
      expect(lastGrid().phoneColumns).toBe(1);
      expect(lastGrid().minWidth).toBeGreaterThan(narrow);
    } finally {
      await setFontScale(1);
    }
  });
});
