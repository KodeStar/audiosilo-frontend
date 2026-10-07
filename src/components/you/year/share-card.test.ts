const mockCapture = jest.fn(async (..._args: unknown[]) => 'file:///cache/card.png');
const mockShare = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('react-native-view-shot', () => ({
  captureRef: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock('expo-sharing', () => ({ shareAsync: (...args: unknown[]) => mockShare(...args) }));

/* eslint-disable import/first */
import type { View } from 'react-native';

import { captureCard, deliverCard } from './share-card';
/* eslint-enable import/first */

describe('share a card (native)', () => {
  it('captures the card as a 1080 x 1920 PNG file', async () => {
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
