import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking, Platform } from 'react-native';

import { ApiError } from '@/api/client';
import type { Capabilities, ServerInfo, UpcomingCalendarStatus } from '@/api/types';
import { mountWithPortal } from '@/testing/render-overlay';
import { notifyQueriesSynchronously } from '@/testing/query-notify';

// The calendar card (Track U3) over the real hooks: the provider is mocked to list the
// connections of `mockConnections`, each with its own stub client; this device's copy of a
// link lives in the in-memory secure store (jest.setup).
type Stub = {
  baseUrl: string;
  serverInfo: jest.Mock;
  upcomingCalendar: jest.Mock;
  mintUpcomingCalendar: jest.Mock;
  deleteUpcomingCalendar: jest.Mock;
};
type MockConnection = {
  id: string;
  name: string;
  serverUrl: string;
  user: { member_kind?: 'kid'; is_demo?: boolean };
  addresses?: { away?: string };
};
const mockClients: Record<string, Stub> = {};
let mockConnections: MockConnection[] = [];
jest.mock('@/api/provider', () => ({
  useApis: () => mockConnections.map((c) => ({ connection: c, client: mockClients[c.id] })),
  useCid: (id?: string) => id ?? mockConnections[0]?.id ?? '',
  useOptionalApi: (id?: string) => mockClients[id ?? mockConnections[0]?.id] ?? null,
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));
const mockCopy = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/lib/clipboard', () => ({ copyText: (s: string) => mockCopy(s) }));

/* eslint-disable import/first */
import { forgetCalendarLink, readCalendarLink, saveCalendarLink } from '@/lib/upcoming-calendar';
import { useSession } from '@/stores/session';

import { UpcomingCalendarCard } from './upcoming-calendar';
/* eslint-enable import/first */

notifyQueriesSynchronously();

const PATH = '/api/v1/me/upcoming/releases.ics?token=feedsecret';
const CREATED = '2026-10-30T09:00:00Z';

function serverWith(id: string, caps: Partial<Capabilities>): ServerInfo {
  return {
    name: id,
    server_id: id,
    version: '2.6.0',
    api: 'v1',
    capabilities: {
      admin_ui: true,
      web_player: true,
      transcode: false,
      upload: false,
      websocket: false,
      ...caps,
    },
    auth: { methods: [] },
  };
}

type Setup = {
  id: string;
  caps?: Partial<Capabilities>;
  kid?: boolean;
  demo?: boolean;
  away?: string;
  status?: UpcomingCalendarStatus | 'fail';
};

const queryClients: QueryClient[] = [];

async function mount(setups: Setup[]) {
  mockConnections = setups.map((s) => ({
    id: s.id,
    name: `Server ${s.id}`,
    serverUrl: `https://${s.id}`,
    user: { ...(s.kid ? { member_kind: 'kid' as const } : {}), is_demo: s.demo },
    addresses: s.away ? { away: s.away } : undefined,
  }));
  useSession.setState({ connections: mockConnections as never });
  for (const s of setups) {
    const stub: Stub = {
      baseUrl: `https://${s.id}`,
      serverInfo: jest
        .fn()
        .mockResolvedValue(serverWith(s.id, s.caps ?? { upcoming: true, upcoming_calendar: true })),
      upcomingCalendar: jest.fn(),
      mintUpcomingCalendar: jest.fn().mockResolvedValue({ path: PATH, created_at: CREATED }),
      deleteUpcomingCalendar: jest.fn().mockResolvedValue(undefined),
    };
    if (s.status === 'fail') stub.upcomingCalendar.mockRejectedValue(new Error('down'));
    else stub.upcomingCalendar.mockResolvedValue(s.status ?? { active: false });
    mockClients[s.id] = stub;
  }
  // No garbage-collection timers (a settled mutation's would outlive the test).
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  queryClients.push(qc);
  return mountWithPortal(
    <QueryClientProvider client={qc}>
      <UpcomingCalendarCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockCopy.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  for (const qc of queryClients.splice(0)) qc.clear();
  // The secure store outlives a test: no copy a test kept reaches the next one.
  await Promise.all(Object.keys(mockClients).map((id) => forgetCalendarLink(id)));
  for (const id of Object.keys(mockClients)) delete mockClients[id];
  mockConnections = [];
  useSession.setState({ connections: [] });
});

describe('UpcomingCalendarCard', () => {
  it('offers Get calendar link when there is none, then shows the link it made', async () => {
    await mount([{ id: 'a' }]);
    const get = await screen.findByRole('button', { name: 'Get calendar link' });
    await fireEvent.press(get);
    await screen.findByTestId('upcoming-calendar-url');
    expect(mockClients.a.mintUpcomingCalendar).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('upcoming-calendar-url')).toHaveTextContent(`https://a${PATH}`);
    // Kept on this device, in the secure store.
    await expect(readCalendarLink('a')).resolves.toEqual({
      url: `https://a${PATH}`,
      created_at: CREATED,
    });
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
  });

  it("builds the link on the server's away address when it has one", async () => {
    await mount([{ id: 'a', away: 'https://books.example' }]);
    await fireEvent.press(await screen.findByRole('button', { name: 'Get calendar link' }));
    expect(await screen.findByTestId('upcoming-calendar-url')).toHaveTextContent(
      `https://books.example${PATH}`,
    );
  });

  it('shows the link this device holds for the active one, and copies it', async () => {
    await saveCalendarLink('a', { url: `https://a${PATH}`, created_at: CREATED });
    await mount([{ id: 'a', status: { active: true, created_at: CREATED } }]);
    expect(await screen.findByTestId('upcoming-calendar-url')).toHaveTextContent(
      `https://a${PATH}`,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    expect(mockCopy).toHaveBeenCalledWith(`https://a${PATH}`);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('subscribes with the webcal link on iOS', async () => {
    const os = Platform.OS;
    Platform.OS = 'ios';
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    try {
      await saveCalendarLink('a', { url: `https://a${PATH}`, created_at: CREATED });
      await mount([{ id: 'a', status: { active: true, created_at: CREATED } }]);
      await fireEvent.press(await screen.findByRole('button', { name: 'Subscribe' }));
      expect(open).toHaveBeenCalledWith(`webcal://a${PATH}`);
    } finally {
      open.mockRestore();
      Platform.OS = os;
    }
  });

  it('offers no Subscribe on Android (Copy only)', async () => {
    const os = Platform.OS;
    Platform.OS = 'android';
    try {
      await saveCalendarLink('a', { url: `https://a${PATH}`, created_at: CREATED });
      await mount([{ id: 'a', status: { active: true, created_at: CREATED } }]);
      await screen.findByTestId('upcoming-calendar-url');
      expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    } finally {
      Platform.OS = os;
    }
  });

  it('says a link is active elsewhere when this device has none, and forgets a replaced copy', async () => {
    await saveCalendarLink('a', { url: `https://a${PATH}`, created_at: CREATED });
    await mount([{ id: 'a', status: { active: true, created_at: '2026-10-31T08:00:00Z' } }]);
    expect(await screen.findByText('A link is active. Reset it to see it here.')).toBeTruthy();
    expect(screen.queryByTestId('upcoming-calendar-url')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    await waitFor(async () => expect(await readCalendarLink('a')).toBeNull());
  });

  it('forgets the copy of a link turned off elsewhere', async () => {
    await saveCalendarLink('a', { url: `https://a${PATH}`, created_at: CREATED });
    await mount([{ id: 'a', status: { active: false } }]);
    expect(await screen.findByRole('button', { name: 'Get calendar link' })).toBeTruthy();
    await waitFor(async () => expect(await readCalendarLink('a')).toBeNull());
  });

  it('asks before Reset, then makes a new link in place of the old', async () => {
    await mount([{ id: 'a', status: { active: true, created_at: '2026-10-01T00:00:00Z' } }]);
    await fireEvent.press(await screen.findByRole('button', { name: 'Reset link' }));
    expect(screen.getByText('Reset calendar link?')).toBeTruthy();
    // Cancel sends nothing.
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockClients.a.mintUpcomingCalendar).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Reset link' }));
    const buttons = screen.getAllByRole('button', { name: 'Reset link' });
    await fireEvent.press(buttons[buttons.length - 1]);
    expect(await screen.findByTestId('upcoming-calendar-url')).toHaveTextContent(
      `https://a${PATH}`,
    );
    expect(mockClients.a.mintUpcomingCalendar).toHaveBeenCalledTimes(1);
  });

  it('asks before Turn off, then turns it off and forgets the copy', async () => {
    await saveCalendarLink('a', { url: `https://a${PATH}`, created_at: CREATED });
    await mount([{ id: 'a', status: { active: true, created_at: CREATED } }]);
    await fireEvent.press(await screen.findByRole('button', { name: 'Turn off' }));
    expect(screen.getByText('Turn off calendar link?')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: 'Turn off' });
    await fireEvent.press(buttons[buttons.length - 1]);
    expect(await screen.findByRole('button', { name: 'Get calendar link' })).toBeTruthy();
    expect(mockClients.a.deleteUpcomingCalendar).toHaveBeenCalledTimes(1);
    await expect(readCalendarLink('a')).resolves.toBeNull();
  });

  it('keeps a new link over a status read sent before the Reset', async () => {
    const OLD = '2026-10-01T00:00:00Z';
    await saveCalendarLink('a', { url: 'https://a/old', created_at: OLD });
    await mount([{ id: 'a', status: { active: true, created_at: OLD } }]);
    expect(await screen.findByTestId('upcoming-calendar-url')).toHaveTextContent('https://a/old');
    // A read of the status in flight (a reconnect's), answered only after the Reset.
    let answer!: (s: UpcomingCalendarStatus) => void;
    mockClients.a.upcomingCalendar.mockImplementation(
      () => new Promise<UpcomingCalendarStatus>((resolve) => (answer = resolve)),
    );
    void queryClients[0].invalidateQueries({ queryKey: ['upcomingCalendar', 'a'] });
    await waitFor(() => expect(mockClients.a.upcomingCalendar).toHaveBeenCalledTimes(2));
    await fireEvent.press(screen.getByRole('button', { name: 'Reset link' }));
    const buttons = screen.getAllByRole('button', { name: 'Reset link' });
    await fireEvent.press(buttons[buttons.length - 1]);
    expect(await screen.findByTestId('upcoming-calendar-url')).toHaveTextContent(
      `https://a${PATH}`,
    );
    await act(async () => answer({ active: true, created_at: OLD }));
    expect(screen.getByTestId('upcoming-calendar-url')).toHaveTextContent(`https://a${PATH}`);
    await expect(readCalendarLink('a')).resolves.toEqual({
      url: `https://a${PATH}`,
      created_at: CREATED,
    });
  });

  it('forgets a link whose mint lands after the connection signed out', async () => {
    await mount([{ id: 'a' }]);
    let minted!: (link: { path: string; created_at: string }) => void;
    mockClients.a.mintUpcomingCalendar.mockImplementation(
      () => new Promise((resolve) => (minted = resolve)),
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Get calendar link' }));
    await act(async () => useSession.setState({ connections: [] }));
    await act(async () => minted({ path: PATH, created_at: CREATED }));
    await waitFor(() => expect(queryClients[0].isMutating()).toBe(0));
    await expect(readCalendarLink('a')).resolves.toBeNull();
  });

  it('keeps the link as it was when Turn off fails, and says so', async () => {
    await saveCalendarLink('a', { url: `https://a${PATH}`, created_at: CREATED });
    await mount([{ id: 'a', status: { active: true, created_at: CREATED } }]);
    mockClients.a.deleteUpcomingCalendar.mockRejectedValue(new Error('offline'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Turn off' }));
    const buttons = screen.getAllByRole('button', { name: 'Turn off' });
    await fireEvent.press(buttons[buttons.length - 1]);
    expect(await screen.findByTestId('upcoming-calendar-error')).toHaveTextContent(
      "Couldn't reach Server a. Your calendar link is as it was: try again in a moment.",
    );
    expect(screen.getByTestId('upcoming-calendar-url')).toBeTruthy();
    await expect(readCalendarLink('a')).resolves.not.toBeNull();
  });

  it("says a refused mint in the app's words (demo_account)", async () => {
    await mount([{ id: 'a' }]);
    mockClients.a.mintUpcomingCalendar.mockRejectedValue(
      new ApiError(403, 'demo accounts cannot', 'demo_account'),
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Get calendar link' }));
    expect(await screen.findByTestId('upcoming-calendar-error')).toHaveTextContent(
      "Demo accounts can't subscribe to a calendar.",
    );
  });

  it('shows a Retry when the status could not be read', async () => {
    await mount([{ id: 'a', status: 'fail' }]);
    expect(
      await screen.findByText("Couldn't check your calendar link on Server a. Nothing changed."),
    ).toBeTruthy();
    mockClients.a.upcomingCalendar.mockResolvedValue({ active: false });
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Get calendar link' })).toBeTruthy();
  });

  it('explains to a demo account, with no button, and asks nothing', async () => {
    await mount([{ id: 'a', demo: true }]);
    expect(await screen.findByTestId('upcoming-calendar-demo')).toHaveTextContent(
      "Demo accounts can't subscribe to a calendar.",
    );
    expect(screen.queryByRole('button', { name: 'Get calendar link' })).toBeNull();
    expect(mockClients.a.upcomingCalendar).not.toHaveBeenCalled();
  });

  it('never asks for a kid, and renders nothing without a server that offers it', async () => {
    await mount([
      { id: 'kid', kid: true },
      { id: 'off', caps: { upcoming: false, upcoming_calendar: false } },
      { id: 'old', caps: { upcoming: true } },
    ]);
    await waitFor(() => expect(mockClients.old.serverInfo).toHaveBeenCalled());
    expect(screen.queryByTestId('upcoming-calendar')).toBeNull();
    for (const id of ['kid', 'off', 'old']) {
      expect(mockClients[id].upcomingCalendar).not.toHaveBeenCalled();
    }
  });

  it('has a row per server, each named, beside a kid on another', async () => {
    await mount([{ id: 'a' }, { id: 'kid', kid: true }, { id: 'b' }]);
    expect(await screen.findByText('Server a')).toBeTruthy();
    expect(screen.getByText('Server b')).toBeTruthy();
    expect(screen.queryByText('Server kid')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('upcoming-calendar-row')).toHaveLength(2));
    expect(mockClients.kid.upcomingCalendar).not.toHaveBeenCalled();
  });
});
