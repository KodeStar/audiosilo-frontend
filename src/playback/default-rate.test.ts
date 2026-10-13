import { resetProfilesForTests } from '@/stores/profiles';
import { useSettings } from '@/stores/settings';
import { seedProfile } from '@/testing/seed-profile';

import { listenerDefaultRate } from './default-rate';

afterEach(() => {
  resetProfilesForTests();
  useSettings.setState({ defaultRate: 1 });
});

it('is the default speed setting for a grown-up, and 1x while a kids profile listens (D3)', () => {
  useSettings.setState({ defaultRate: 1.4 });
  expect(listenerDefaultRate()).toBe(1.4);
  seedProfile();
  expect(listenerDefaultRate()).toBe(1.4);
  seedProfile({ kids: true });
  expect(listenerDefaultRate()).toBe(1);
});
