import { act, renderHook } from '@testing-library/react-native';

import { resetProfilesForTests } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';
import { seedProfile } from '@/testing/seed-profile';

import {
  KIDS_BEDTIME_UNTIL,
  listenerSettings,
  listenerSettingsFor,
  useListenerDefaultRate,
} from './listener-settings';

const settings = {
  defaultRate: 1.4,
  autoSleepTimer: false,
  autoSleepFrom: '22:00',
  autoSleepUntil: '06:00',
  autoSleepType: 'chapter' as const,
};

afterEach(() => {
  resetProfilesForTests();
  useSettings.setState({ defaultRate: 1 });
});

it('is the default speed setting for a grown-up, and 1x while a kids profile listens (D3)', () => {
  useSettings.setState({ defaultRate: 1.4 });
  expect(listenerSettings().defaultRate).toBe(1.4);
  seedProfile();
  expect(listenerSettings().defaultRate).toBe(1.4);
  seedProfile({ kids: true });
  expect(listenerSettings().defaultRate).toBe(1);
});

it("is the device's auto sleep rule for a grown-up, and the bedtime's for a kids profile", () => {
  expect(listenerSettingsFor(undefined, settings).autoSleep).toEqual({
    enabled: false,
    from: '22:00',
    until: '06:00',
    type: 'chapter',
  });
  expect(listenerSettingsFor({ bedtime: '19:30' }, settings).autoSleep).toEqual({
    enabled: true,
    from: '19:30',
    until: KIDS_BEDTIME_UNTIL,
    type: 20,
  });
});

it('follows the setting and the person listening on a screen', async () => {
  useSettings.setState({ defaultRate: 1.4 });
  seedProfile();
  const { result } = await renderHook(() => useListenerDefaultRate());
  expect(result.current).toBe(1.4);
  await act(async () => useSettings.setState({ defaultRate: 1.2 }));
  expect(result.current).toBe(1.2);
  await act(async () => seedProfile({ kids: true }));
  expect(result.current).toBe(1);
});
