jest.mock('@/playback/store', () => ({ usePlayer: jest.fn() }));
jest.mock('@/api/provider', () => ({ useOptionalApi: jest.fn() }));
jest.mock('@/api/hooks', () => ({ bookmarksQuery: jest.fn(), notesQuery: jest.fn() }));

// eslint-disable-next-line import/first
import { pinsOf } from './use-playing-pins';

describe('pinsOf', () => {
  it('pins every bookmark, and only the notes that have a place', () => {
    // Notes are written without a place (0): no pin, so no tap snaps to the book's start.
    const pins = pinsOf(
      [{ position: 0 }, { position: 120 }],
      [{ position: 0 }, { position: 0 }, { position: 300 }],
    );
    expect(pins).toEqual({ bookmarks: [0, 120], notes: [300] });
  });
});
