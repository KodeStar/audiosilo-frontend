import { playerStoreMock, type MockNowPlaying } from '@/testing/player-store-mock';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import {
  lastInteraction,
  noteInteraction,
  resetInteractions,
  startInteractionWatch,
} from '@/playback/last-interaction';
/* eslint-enable import/first */

const player = playerStoreMock();
const NOW = 1_700_000_000_000;
const KEY_A = 'srv-1:1:a.m4b';

function book(path: string): MockNowPlaying {
  return { connectionId: 'srv-1', libraryId: 1, path, queue: { chapters: [], total: 36_000 } };
}

/** One store write, the way the engine reports: position and state together. */
function write(position: number, state = player.usePlayer.getState().snapshot.state) {
  player.usePlayer.setState({
    bookPosition: position,
    snapshot: { ...player.usePlayer.getState().snapshot, state },
  });
}

describe('last interaction', () => {
  let stop: () => void;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    player.reset();
    resetInteractions();
    player.patch({ nowPlaying: book('a.m4b'), bookPosition: 100 });
    player.setPlayState('paused');
    stop = startInteractionWatch();
  });

  afterEach(() => {
    stop();
    jest.useRealTimers();
  });

  it('knows nothing before the listener touches anything', () => {
    expect(lastInteraction(KEY_A)).toBeNull();
  });

  it('records an explicit touch at the current position', () => {
    noteInteraction();
    expect(lastInteraction(KEY_A)).toEqual({ at: NOW, position: 100 });
  });

  it('records play and pause', () => {
    jest.setSystemTime(NOW + 1_000);
    write(100, 'playing');
    expect(lastInteraction(KEY_A)).toEqual({ at: NOW + 1_000, position: 100 });
    jest.setSystemTime(NOW + 61_000);
    write(160, 'paused');
    expect(lastInteraction(KEY_A)).toEqual({ at: NOW + 61_000, position: 160 });
  });

  it('does not count playback flowing, or a buffering stall', () => {
    write(100, 'playing');
    for (let i = 1; i <= 30; i += 1) {
      jest.setSystemTime(NOW + i * 1_000);
      write(100 + i, i === 10 ? 'loading' : 'playing');
    }
    expect(lastInteraction(KEY_A)).toEqual({ at: NOW, position: 100 });
  });

  it('counts a jump either way as a touch', () => {
    write(100, 'playing');
    jest.setSystemTime(NOW + 1_000);
    write(131); // skipped 30 seconds forward
    expect(lastInteraction(KEY_A)).toEqual({ at: NOW + 1_000, position: 131 });
    jest.setSystemTime(NOW + 2_000);
    write(117); // and 15 back
    expect(lastInteraction(KEY_A)).toEqual({ at: NOW + 2_000, position: 117 });
  });

  it('allows for the playback speed before calling it a jump', () => {
    player.patch({ rate: 2 });
    write(100, 'playing');
    jest.setSystemTime(NOW + 3_000);
    write(106); // 3 seconds at 2x
    expect(lastInteraction(KEY_A)).toEqual({ at: NOW, position: 100 });
  });

  it('counts starting a book as a touch on that book', () => {
    jest.setSystemTime(NOW + 1_000);
    player.usePlayer.setState({
      nowPlaying: book('b.m4b'),
      bookPosition: 50,
      snapshot: { ...player.usePlayer.getState().snapshot, state: 'loading' },
    });
    expect(lastInteraction('srv-1:1:b.m4b')).toEqual({ at: NOW + 1_000, position: 50 });
  });

  it('ignores writes with nothing loaded', () => {
    player.usePlayer.setState({ nowPlaying: null });
    noteInteraction();
    expect(lastInteraction(KEY_A)).toBeNull();
  });
});
