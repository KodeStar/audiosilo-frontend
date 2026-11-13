import { fireEvent, screen } from '@testing-library/react-native';

import type { ServerInfo } from '@/api/types';
import { ADMIN } from '@/testing/bridge-fixtures';
import { librivoxServer } from '@/testing/librivox-fixtures';
import { mountWithPortal } from '@/testing/render-overlay';

const mockOpenFind = jest.fn();
jest.mock('@/lib/open', () => ({
  useOpen: () => ({ openFindLibrivox: (...a: unknown[]) => mockOpenFind(...a) }),
}));
let mockServer: ServerInfo | undefined;
const mockAskedFor: (string | undefined)[] = [];
jest.mock('@/api/hooks', () => ({
  useServerInfo: (cid?: string) => {
    mockAskedFor.push(cid);
    return { data: mockServer };
  },
}));

/* eslint-disable import/first */
import { useSession } from '@/stores/session';

import { LibrivoxMenu } from './librivox-menu';
/* eslint-enable import/first */

const signIn = (user: object = ADMIN) =>
  useSession.setState({
    connections: [{ id: 'c1', name: 'Home', serverUrl: 'u', token: 't', user } as never],
  });

beforeEach(() => {
  mockServer = librivoxServer();
  mockAskedFor.length = 0;
  mockOpenFind.mockReset();
  signIn();
});

describe('LibrivoxMenu', () => {
  it("opens Find on LibriVox for this library from an admin's menu", async () => {
    await mountWithPortal(<LibrivoxMenu connectionId="c1" libraryId={3} />);
    expect(mockAskedFor).toContain('c1');
    await fireEvent.press(screen.getByTestId('books-menu'));
    await fireEvent.press(await screen.findByTestId('books-find-librivox'));
    expect(mockOpenFind).toHaveBeenCalledWith('c1', 3);
  });

  it('is not there for anyone but an admin', async () => {
    signIn({ ...ADMIN, role: 'user' });
    await mountWithPortal(<LibrivoxMenu connectionId="c1" libraryId={3} />);
    expect(screen.queryByTestId('books-menu')).toBeNull();
  });

  it('is not there on an older server or Bridge, or with metadata off', async () => {
    mockServer = librivoxServer({ bridge: { version: '0.6.0', features: ['sidecars'] } });
    await mountWithPortal(<LibrivoxMenu connectionId="c1" libraryId={3} />);
    expect(screen.queryByTestId('books-menu')).toBeNull();
    const caps = librivoxServer().capabilities;
    mockServer = librivoxServer({ capabilities: { ...caps, metadata: false } });
    await mountWithPortal(<LibrivoxMenu connectionId="c1" libraryId={3} />);
    expect(screen.queryByTestId('books-menu')).toBeNull();
  });

  it('is not there while the server is not known', async () => {
    mockServer = undefined;
    await mountWithPortal(<LibrivoxMenu connectionId="c1" libraryId={3} />);
    expect(screen.queryByTestId('books-menu')).toBeNull();
  });
});
