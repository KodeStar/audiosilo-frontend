import { Share } from 'react-native';

import { copyText } from './clipboard';

describe('copyText', () => {
  const originalNavigator = globalThis.navigator;

  function setClipboard(clipboard: { writeText: jest.Mock } | undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: clipboard ? { clipboard } : {},
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    jest.restoreAllMocks();
  });

  it('writes to the Clipboard API when available and reports success', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    const shareSpy = jest.spyOn(Share, 'share');

    await expect(copyText('secret')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('secret');
    expect(shareSpy).not.toHaveBeenCalled();
  });

  it('falls back to the share sheet (reporting false) when there is no Clipboard API', async () => {
    setClipboard(undefined);
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction' } as Awaited<ReturnType<typeof Share.share>>);

    await expect(copyText('secret')).resolves.toBe(false);
    expect(shareSpy).toHaveBeenCalledWith({ message: 'secret' });
  });

  it('falls back to the share sheet when a Clipboard write rejects', async () => {
    const writeText = jest.fn().mockRejectedValue(new Error('not allowed'));
    setClipboard({ writeText });
    const shareSpy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction' } as Awaited<ReturnType<typeof Share.share>>);

    await expect(copyText('secret')).resolves.toBe(false);
    expect(writeText).toHaveBeenCalled();
    expect(shareSpy).toHaveBeenCalledWith({ message: 'secret' });
  });
});
