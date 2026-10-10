import { type Profile, useProfiles } from '@/stores/profiles';

/** The bedtime `seedProfile` gives a kid unless the test says otherwise. */
const KIDS = { bedtime: '19:30' };

/**
 * Make one person the active, hydrated profile: Leo (`id` 'p') on `srv.1`, a grown-up,
 * or a kid with `kids: true` (bedtime 19:30) or the kids settings given. Pair it with
 * `afterEach(resetProfilesForTests)`.
 */
export function seedProfile(
  over: Partial<Omit<Profile, 'kids'>> & { kids?: Profile['kids'] | boolean } = {},
): void {
  const { kids, ...rest } = over;
  useProfiles.setState({
    profiles: [
      {
        id: 'p',
        name: 'Leo',
        connectionIds: ['srv.1'],
        ...rest,
        ...(kids ? { kids: kids === true ? KIDS : kids } : {}),
      },
    ],
    activeProfileId: 'p',
    hydrated: true,
  });
}
