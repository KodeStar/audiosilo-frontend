import { fireEvent, render } from '@testing-library/react-native';

// The not-found route (`src/app/+not-found.tsx`, CONNECT-02). The test lives here because
// a file under `src/app` is a route to Expo Router.

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  router: { replace: (...a: unknown[]) => mockReplace(...a) },
  useFocusEffect: jest.fn(),
}));

/* eslint-disable import/first */
import NotFoundScreen from '@/app/+not-found';
/* eslint-enable import/first */

beforeEach(() => mockReplace.mockReset());

it('says the page is not found and goes Home', async () => {
  const r = await render(<NotFoundScreen />);
  expect(r.getByText('Page not found')).toBeTruthy();
  expect(r.getByText(/doesn't go anywhere in AudioSilo/)).toBeTruthy();
  await fireEvent.press(r.getByText('Go to Home'));
  expect(mockReplace).toHaveBeenCalledWith('/');
});
