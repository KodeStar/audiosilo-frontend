import { render } from '@testing-library/react-native';

let mockListening: { data: unknown; isError: boolean; isPaused: boolean } = {
  data: undefined,
  isError: false,
  isPaused: false,
};
jest.mock('@/api/hooks', () => ({
  useCapability: () => true,
  useMyListening: () => mockListening,
  useListeningGoal: () => ({ data: undefined }),
}));
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import { ThisWeekCard } from './this-week-card';
/* eslint-enable import/first */

describe('ThisWeekCard', () => {
  it('holds its place with a skeleton while the stats load', async () => {
    mockListening = { data: undefined, isError: false, isPaused: false };
    const { toJSON } = await render(<ThisWeekCard />);
    expect(toJSON()).not.toBeNull();
  });

  // Offline before the stats answered: no skeleton that waits for the network.
  it('shows nothing while the read waits for the network', async () => {
    mockListening = { data: undefined, isError: false, isPaused: true };
    const { toJSON } = await render(<ThisWeekCard />);
    expect(toJSON()).toBeNull();
  });

  it('shows nothing when the read failed', async () => {
    mockListening = { data: undefined, isError: true, isPaused: false };
    const { toJSON } = await render(<ThisWeekCard />);
    expect(toJSON()).toBeNull();
  });
});
