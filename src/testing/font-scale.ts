import { act } from '@testing-library/react-native';
import { Dimensions } from 'react-native';

/** Sets the system font scale the app reads (`@/lib/text-scale`) and tells its listeners,
 * as iOS and Android do when the reader changes the text size. Await it inside a test
 * (mounted components re-render); call it before rendering to start large. `jest.setup.ts`
 * starts every file at 1, so a large-text test sets it back after itself. */
export async function setFontScale(fontScale: number): Promise<void> {
  const set = (Dimensions as unknown as { set: (dims: object) => void }).set;
  await act(async () => {
    set({
      window: { ...Dimensions.get('window'), fontScale },
      screen: { ...Dimensions.get('screen'), fontScale },
    });
  });
}
