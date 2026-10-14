import {
  PHONE_COVER_MIN,
  PHONE_COVER_ROOM,
  phoneCoverSize,
  playerContext,
  playerCoverSize,
} from './player-view-model';

describe('phoneCoverSize', () => {
  it('is nothing until its slot is measured', () => {
    expect(phoneCoverSize(400, 0)).toBe(0);
  });

  it('keeps the width rule where the slot is tall enough', () => {
    expect(phoneCoverSize(390, 500)).toBe(playerCoverSize('phone', 390, 0));
    expect(phoneCoverSize(390, 500)).toBe(304);
  });

  it('shrinks to its slot, less its room, so nothing needs a scroll', () => {
    expect(phoneCoverSize(400, 258)).toBe(258 - PHONE_COVER_ROOM);
  });

  it('never goes below the minimum (a very short window scrolls instead)', () => {
    expect(phoneCoverSize(375, 90)).toBe(PHONE_COVER_MIN);
  });
});

describe('playerContext', () => {
  it('names the book in its series, a range as "1-3"', () => {
    expect(playerContext({ series: 'Mistborn', series_index: 2 }, 'Fiction')).toEqual({
      kind: 'series',
      series: 'Mistborn',
      position: '2',
    });
    expect(
      playerContext({ series: 'Mistborn', series_index: 1, series_index_end: 3 }, 'Fiction'),
    ).toMatchObject({ position: '1-3' });
    expect(playerContext({ series: 'Mistborn', series_index: 0 }, 'Fiction')).toEqual({
      kind: 'series',
      series: 'Mistborn',
      position: undefined,
    });
    expect(playerContext({ series: '' }, 'Fiction')).toEqual({ kind: 'library', name: 'Fiction' });
  });
});
