jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);

/* eslint-disable import/first */
import { chapterRowHeight } from './chapters-panel';
/* eslint-enable import/first */

describe('chapterRowHeight', () => {
  it('is 52 at the default text size and grows with the scale, to a cap', () => {
    expect(chapterRowHeight(1)).toBe(52);
    expect(chapterRowHeight(0.85)).toBe(52);
    expect(chapterRowHeight(2)).toBe(104);
    expect(chapterRowHeight(10)).toBe(chapterRowHeight(3.2));
  });
});
