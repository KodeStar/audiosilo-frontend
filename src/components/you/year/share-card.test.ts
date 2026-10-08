const mockCapture = jest.fn(async (..._args: unknown[]) => 'file:///cache/card.png');
const mockShare = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('react-native-view-shot', () => ({
  captureRef: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock('expo-sharing', () => ({ shareAsync: (...args: unknown[]) => mockShare(...args) }));

/* eslint-disable import/first */
import { PixelRatio, Platform, type View } from 'react-native';

import { captureCard, captureSize, deliverCard } from './share-card';
/* eslint-enable import/first */

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('share a card (native)', () => {
  it('asks iOS for points at the screen scale, Android for pixels: 1080 x 1920 either way', () => {
    // iOS renders width/height as points at the device scale: 1080 x 1920 came out
    // 3240 x 5760 on a 3x iPhone.
    expect(captureSize('ios', 3)).toEqual({ width: 360, height: 640 });
    expect(captureSize('ios', 2)).toEqual({ width: 540, height: 960 });
    expect(captureSize('android', 2.625)).toEqual({ width: 1080, height: 1920 });
  });

  it('captures an iOS card at points that render to 1080 x 1920', async () => {
    Platform.OS = 'ios';
    jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
    const view = {} as View;
    await captureCard(view, 'audiosilo-2026-01-hours.png');
    expect(mockCapture).toHaveBeenLastCalledWith(
      view,
      expect.objectContaining({ width: 360, height: 640, format: 'png', quality: 1 }),
    );
  });

  it('captures the card as a 1080 x 1920 PNG file (Android)', async () => {
    Platform.OS = 'android';
    jest.spyOn(PixelRatio, 'get').mockReturnValue(2.625);
    const view = {} as View;
    expect(await captureCard(view, 'audiosilo-2026-01-hours.png')).toBe('file:///cache/card.png');
    expect(mockCapture).toHaveBeenCalledWith(view, {
      format: 'png',
      quality: 1,
      width: 1080,
      height: 1920,
      result: 'tmpfile',
      fileName: 'audiosilo-2026-01-hours',
    });
  });

  it('opens the share sheet on it as a PNG', async () => {
    const outcome = await deliverCard('file:///cache/card.png', {
      fileName: 'audiosilo-2026-01-hours.png',
      title: 'My 2026 in listening',
    });
    expect(outcome).toBe('shared');
    expect(mockShare).toHaveBeenCalledWith('file:///cache/card.png', {
      mimeType: 'image/png',
      UTI: 'public.png',
      dialogTitle: 'My 2026 in listening',
    });
  });
});
