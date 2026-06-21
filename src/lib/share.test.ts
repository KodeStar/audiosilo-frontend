import { Share } from 'react-native';

import { shareText } from './share';

describe('shareText', () => {
  it('forwards the message to the OS share sheet', async () => {
    const spy = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction' } as Awaited<ReturnType<typeof Share.share>>);
    await shareText('hello');
    expect(spy).toHaveBeenCalledWith({ message: 'hello' });
    spy.mockRestore();
  });

  it('swallows rejection when the sheet is dismissed or unsupported', async () => {
    const spy = jest.spyOn(Share, 'share').mockRejectedValue(new Error('unavailable'));
    await expect(shareText('x')).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
