const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

/* eslint-disable import/first */
import { t } from 'i18next';

import { PlaybackStartError } from '@/playback/types';
import { useSession } from '@/stores/session';

import { playFailedReason, playFailedToast } from './play-failed';
/* eslint-enable import/first */

beforeEach(() => {
  mockToast.mockClear();
  useSession.setState({
    connections: [{ id: 'c1', name: 'Hearthside', serverUrl: 'u', token: 't', user: {} as never }],
  });
});

describe('playFailedReason', () => {
  it('names the server that cannot be reached', () => {
    const err = new PlaybackStartError('offline', { connectionId: 'c1' });
    expect(playFailedReason(err, t)).toBe("Can't reach Hearthside right now.");
  });

  it("says the audio didn't load", () => {
    expect(playFailedReason(new PlaybackStartError('audio'), t)).toBe(
      "Its audio didn't load from the server.",
    );
  });

  it('has nothing to add for an unknown failure, another error, or a server since removed', () => {
    expect(playFailedReason(new PlaybackStartError('unknown'), t)).toBeUndefined();
    expect(playFailedReason(new Error('boom'), t)).toBeUndefined();
    expect(playFailedReason(undefined, t)).toBeUndefined();
    const gone = new PlaybackStartError('offline', { connectionId: 'c9' });
    expect(playFailedReason(gone, t)).toBeUndefined();
  });
});

describe('playFailedToast', () => {
  it('toasts the title with the reason as its description', () => {
    playFailedToast(new PlaybackStartError('audio'), t, 'Couldn’t start this book.');
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Couldn’t start this book.',
      description: "Its audio didn't load from the server.",
    });
  });

  it('toasts the title alone when there is no reason', () => {
    playFailedToast(new Error('boom'), t, 'Couldn’t start this book.');
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Couldn’t start this book.',
      description: undefined,
    });
  });
});
