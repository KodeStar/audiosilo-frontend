import { router } from 'expo-router';

import { backOrHome } from './back-or-home';

jest.mock('expo-router', () => ({
  router: { canGoBack: jest.fn(), back: jest.fn(), dismissTo: jest.fn() },
}));

const mocked = router as unknown as Record<'canGoBack' | 'back' | 'dismissTo', jest.Mock>;

beforeEach(() => jest.clearAllMocks());

it('goes back when there is a screen to go back to', () => {
  mocked.canGoBack.mockReturnValue(true);
  backOrHome();
  expect(mocked.back).toHaveBeenCalledTimes(1);
  expect(mocked.dismissTo).not.toHaveBeenCalled();
});

it('goes Home when nothing is under the screen (a cold link)', () => {
  mocked.canGoBack.mockReturnValue(false);
  backOrHome();
  expect(mocked.dismissTo).toHaveBeenCalledWith('/');
  expect(mocked.back).not.toHaveBeenCalled();
});
