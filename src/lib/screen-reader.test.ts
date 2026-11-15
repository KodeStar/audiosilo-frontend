import { AccessibilityInfo } from 'react-native';

describe('screen reader state', () => {
  it('follows the system: its first answer, then each change', async () => {
    let listener: ((on: boolean) => void) | undefined;
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((
      _event: string,
      handler: (on: boolean) => void,
    ) => {
      listener = handler;
      return { remove: jest.fn() };
    }) as never);
    await jest.isolateModulesAsync(async () => {
      const { screenReaderOn, watchScreenReader } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./screen-reader') as typeof import('./screen-reader');
      expect(screenReaderOn()).toBe(false);
      watchScreenReader();
      watchScreenReader();
      await Promise.resolve();
      expect(screenReaderOn()).toBe(true);
      listener?.(false);
      expect(screenReaderOn()).toBe(false);
      expect(AccessibilityInfo.addEventListener).toHaveBeenCalledTimes(1);
    });
  });
});
