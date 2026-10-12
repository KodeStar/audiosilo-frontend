import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

const mockRouter = {
  push: jest.fn(),
  back: jest.fn(),
  dismissTo: jest.fn(),
  canGoBack: jest.fn(() => true),
};
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));
jest.mock('@/lib/root-stack', () => ({ popTabToRoot: jest.fn() }));
jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { popTabToRoot } from '@/lib/root-stack';
import { setPin } from '@/lib/profile-pin';
import { resetProfilesForTests, useProfiles } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { resetLaunchDecisionForTests, takeLaunchDecision } from './profiles-model';
import { ProfilesScreen } from './profiles-screen';
import { forgetPickerOpener, openProfiles } from './use-choose-profile';
/* eslint-enable import/first */

const conn = (id: string, name: string, username: string) =>
  ({
    id,
    serverId: id.split('.')[0],
    name,
    serverUrl: 'u',
    token: 't',
    user: { id: 1, username },
  }) as unknown as Connection;

beforeEach(async () => {
  jest.clearAllMocks();
  forgetPickerOpener();
  resetLaunchDecisionForTests();
  await AsyncStorage.clear();
  resetProfilesForTests();
  useSession.setState({
    status: 'authenticated',
    connections: [conn('a.1', 'Hearthside', 'chris'), conn('a.2', 'Hearthside', 'sam')],
    defaultConnectionId: 'a.1',
  });
  useProfiles.setState({
    hydrated: true,
    profiles: [
      { id: 'chris', name: 'Chris', connectionIds: ['a.1'] },
      { id: 'sam', name: 'Sam', connectionIds: ['a.2'] },
      { id: 'leo', name: 'Leo', connectionIds: [], kids: { bedtime: '19:30' } },
    ],
    activeProfileId: 'chris',
  });
});

describe("Who's listening?", () => {
  it('shows everyone, the one listening ringed, and Add someone', async () => {
    await mountWithPortal(<ProfilesScreen />);
    expect(screen.getByText("Who's listening?")).toBeTruthy();
    expect(screen.getByLabelText('Chris, Listening now')).toBeTruthy();
    expect(screen.getByLabelText('Sam, Hearthside')).toBeTruthy();
    expect(screen.getByLabelText('Leo, Kids mode · bedtime 7:30 PM')).toBeTruthy();
    // One ring: the person listening.
    expect(screen.getAllByTestId('portrait-ring', { includeHiddenElements: true })).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('profiles-add'));
    expect(mockRouter.push).toHaveBeenCalledWith('/connect?add=1&profile=new');
  });

  it('switches to someone without a PIN and goes Home with every tab at its root', async () => {
    await mountWithPortal(<ProfilesScreen />);
    await fireEvent.press(screen.getByLabelText('Sam, Hearthside'));
    await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith('/'));
    expect(useProfiles.getState().activeProfileId).toBe('sam');
    expect(useSession.getState().defaultConnectionId).toBe('a.2');
    expect(popTabToRoot).toHaveBeenCalledTimes(5);
  });

  it('asks for a PIN first, and switches once it matches', async () => {
    await setPin('sam', '2468');
    await mountWithPortal(<ProfilesScreen />);
    await fireEvent.press(screen.getByLabelText('Sam, Hearthside, asks for a PIN'));
    expect(await screen.findByText("Enter Sam's PIN")).toBeTruthy();
    expect(useProfiles.getState().activeProfileId).toBe('chris');
    await fireEvent.changeText(screen.getByTestId('pin-field'), '2468');
    await waitFor(() => expect(useProfiles.getState().activeProfileId).toBe('sam'));
  });

  it('the person listening just goes back', async () => {
    openProfiles();
    await mountWithPortal(<ProfilesScreen />);
    await fireEvent.press(screen.getByLabelText('Chris, Listening now'));
    expect(mockRouter.back).toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('when someone must be chosen: no way out, nobody ringed, everyone asks for their PIN', async () => {
    useProfiles.setState({ activeProfileId: null });
    await setPin('sam', '2468');
    await mountWithPortal(<ProfilesScreen />);
    expect(screen.queryByTestId('profiles-close')).toBeNull();
    expect(screen.queryAllByTestId('portrait-ring', { includeHiddenElements: true })).toHaveLength(
      0,
    );
    await fireEvent.press(screen.getByLabelText('Sam, Hearthside, asks for a PIN'));
    expect(await screen.findByText("Enter Sam's PIN")).toBeTruthy();
  });

  it('closes back to where the listener was when the app opened it', async () => {
    openProfiles();
    expect(mockRouter.push).toHaveBeenCalledWith('/profiles');
    await mountWithPortal(<ProfilesScreen />);
    await fireEvent.press(screen.getByTestId('profiles-close'));
    expect(mockRouter.back).toHaveBeenCalled();
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('a cold load of the picker (a reload while open): Close is Home in one press, and the launch is decided', async () => {
    // The root stack has the (app) anchor under it, so there IS something to go back to,
    // but nobody was there: Home, and the auth gate must not ask again.
    mockRouter.canGoBack.mockReturnValue(true);
    await mountWithPortal(<ProfilesScreen />);
    expect(takeLaunchDecision()).toBe(false);
    await fireEvent.press(screen.getByTestId('profiles-close'));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/');
    expect(mockRouter.back).not.toHaveBeenCalled();
    // The same with no history at all.
    mockRouter.dismissTo.mockClear();
    mockRouter.canGoBack.mockReturnValue(false);
    openProfiles();
    await fireEvent.press(screen.getByTestId('profiles-close'));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/');
    mockRouter.canGoBack.mockReturnValue(true);
  });

  it('a spinner while the profiles load; an empty state with nobody', async () => {
    useProfiles.setState({ hydrated: false });
    const { unmount } = await mountWithPortal(<ProfilesScreen />);
    expect(screen.getByTestId('profiles-loading')).toBeTruthy();
    await unmount();
    useProfiles.setState({ hydrated: true, profiles: [], activeProfileId: null });
    await mountWithPortal(<ProfilesScreen />);
    expect(screen.getByText('Nobody is signed in here yet')).toBeTruthy();
  });
});

it('finding 7: kids cannot enter onboarding through Add someone', async () => {
  useProfiles.setState({ activeProfileId: 'leo' });
  await mountWithPortal(<ProfilesScreen />);
  expect(screen.getByText('Choose a grown-up before adding someone.')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('profiles-add'));
  expect(mockRouter.push).not.toHaveBeenCalled();
  expect(useProfiles.getState().activeProfileId).toBe('leo');
});
