import { fireEvent, render, screen } from '@testing-library/react-native';

const mockOpenUrl = jest.fn(async (_u: string) => {});
jest.mock('@/lib/support', () => ({ openExternalUrl: (u: string) => mockOpenUrl(u) }));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { useSession } from '@/stores/session';

import { NoLibrariesState } from './no-libraries-state';
/* eslint-enable import/first */

const conn = (id: string, role: 'admin' | 'user') => ({
  id,
  name: id === 'a' ? 'Hearthside' : 'Attic',
  serverUrl: `https://${id}.example`,
  token: 't',
  user: { id: 1, username: 'x', role },
});

beforeEach(() => mockOpenUrl.mockClear());

// CONNECT-02: the admin is the one who adds a library, so they are not told to ask.
it("sends the server's admin to the console's setup flow", async () => {
  useSession.setState({ connections: [conn('a', 'admin')] } as never);
  await render(<NoLibrariesState connectionIds={['a']} />);
  expect(screen.getByText('No libraries yet')).toBeTruthy();
  expect(screen.getByText(/admin console of Hearthside/)).toBeTruthy();
  await fireEvent.press(screen.getByText('Add your first library'));
  expect(mockOpenUrl).toHaveBeenCalledWith('https://a.example/admin/setup');
});

it('tells a listener to ask the owner', async () => {
  useSession.setState({ connections: [conn('a', 'user'), conn('b', 'admin')] } as never);
  await render(<NoLibrariesState connectionIds={['a']} />);
  expect(screen.getByText('No libraries are shared with your account yet.')).toBeTruthy();
  expect(screen.queryByText('Add your first library')).toBeNull();
});
