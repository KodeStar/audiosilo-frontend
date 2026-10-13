import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Keyboard } from 'react-native';

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
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({
  ...jest.requireActual('@/components/ui/toast'),
  toast: (o: unknown) => mockToast(o),
}));

/* eslint-disable import/first */
import { popTabToRoot } from '@/lib/root-stack';
import * as profilePin from '@/lib/profile-pin';
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
    // The number pad goes before the switch and Home (Android kept a QWERTY keyboard up
    // over Home when the focused field was simply removed).
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    await fireEvent.changeText(screen.getByTestId('pin-field'), '2468');
    await waitFor(() => expect(useProfiles.getState().activeProfileId).toBe('sam'));
    await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith('/'));
    expect(dismiss).toHaveBeenCalled();
    expect(dismiss.mock.invocationCallOrder[0]).toBeLessThan(
      mockRouter.dismissTo.mock.invocationCallOrder[0],
    );
    dismiss.mockRestore();
  });

  it('asks for a PIN the secure store holds even when the mirror lost it (a stale web tab)', async () => {
    await setPin('sam', '2468');
    // Another tab (or a failed document write) left the profile without its mirror.
    useProfiles.setState({
      profiles: useProfiles
        .getState()
        .profiles.map((p) => (p.id === 'sam' ? { ...p, hasPin: undefined } : p)),
    });
    await mountWithPortal(<ProfilesScreen />);
    await fireEvent.press(screen.getByLabelText('Sam, Hearthside'));
    expect(await screen.findByText("Enter Sam's PIN")).toBeTruthy();
    expect(useProfiles.getState().activeProfileId).toBe('chris');
    // The mirror is repaired, so the picker shows the key again.
    expect(useProfiles.getState().profiles.find((p) => p.id === 'sam')?.hasPin).toBe(true);
  });

  it('never switches when the PIN store cannot be read, even with no PIN mirrored', async () => {
    await setPin('sam', '2468');
    // The mirror lost the PIN (a failed write, an older web tab) and the store is unreadable.
    useProfiles.setState({
      profiles: useProfiles
        .getState()
        .profiles.map((p) => (p.id === 'sam' ? { ...p, hasPin: undefined } : p)),
    });
    const read = jest.spyOn(profilePin, 'readPin').mockRejectedValue(new Error('locked'));
    await mountWithPortal(<ProfilesScreen />);
    await fireEvent.press(screen.getByLabelText('Sam, Hearthside'));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith({
        title: "Couldn't check the PIN on this device. Try again.",
      }),
    );
    expect(useProfiles.getState().activeProfileId).toBe('chris');
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pin-field')).toBeNull();
    read.mockRestore();
  });

  it('an unreadable PIN store refuses a mirrored PIN the same way', async () => {
    await setPin('sam', '2468');
    const read = jest.spyOn(profilePin, 'readPin').mockRejectedValue(new Error('locked'));
    await mountWithPortal(<ProfilesScreen />);
    await fireEvent.press(screen.getByLabelText('Sam, Hearthside, asks for a PIN'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
    expect(useProfiles.getState().activeProfileId).toBe('chris');
    expect(screen.queryByTestId('pin-field')).toBeNull();
    read.mockRestore();
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
