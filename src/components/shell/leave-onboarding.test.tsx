import { render } from '@testing-library/react-native';

const mockModule = { dismissTo: jest.fn() };
const mockHook = { dismissTo: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockModule;
  },
  useRouter: () => mockHook,
}));

/* eslint-disable import/first */
import { LeaveOnboarding, leaveOnboarding } from './leave-onboarding';
/* eslint-enable import/first */

beforeEach(() => jest.clearAllMocks());

// fe#252: one way back to Home from onboarding, whichever router carries it.
describe('leaving onboarding', () => {
  it('dismisses to Home through the module router', () => {
    leaveOnboarding();
    expect(mockModule.dismissTo).toHaveBeenCalledWith('/');
  });

  it('dismisses to Home once through the hook router when rendered', async () => {
    await render(<LeaveOnboarding />);
    expect(mockHook.dismissTo).toHaveBeenCalledTimes(1);
    expect(mockHook.dismissTo).toHaveBeenCalledWith('/');
    expect(mockModule.dismissTo).not.toHaveBeenCalled();
  });
});
