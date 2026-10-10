import type { NavState } from '@/lib/root-stack';

import { navFor, type PlayRoute, playRoute } from './play-route';

type Input = Parameters<typeof playRoute>[0];
const base: Input = {
  phone: false,
  playerOnTop: false,
  bookOnTop: false,
  loaded: false,
  toggle: false,
  viaBookPage: false,
};

describe('playRoute', () => {
  it.each<[string, Partial<Input>, PlayRoute]>([
    ['a tablet or desktop starts another book in place', {}, { kind: 'start' }],
    ['a tablet or desktop plays the loaded book on', { loaded: true }, { kind: 'play-on' }],
    [
      'a toggle pauses or plays the loaded book',
      { loaded: true, toggle: true },
      { kind: 'toggle' },
    ],
    // On a phone too: Home's Now card and the book page's primary never open the player
    // for the book already in it.
    [
      'a toggle stays in place on a phone',
      { phone: true, loaded: true, toggle: true },
      { kind: 'toggle' },
    ],
    ['a toggle starts a book not loaded', { toggle: true }, { kind: 'start' }],
    ['a phone opens the player', { phone: true }, { kind: 'player', bookPage: false }],
    // The player route applies the jump once, also to the loaded book.
    [
      'a phone opens the player on the loaded book too',
      { phone: true, loaded: true },
      { kind: 'player', bookPage: false },
    ],
    [
      'a phone opens the player over the book page when asked',
      { phone: true, viaBookPage: true },
      { kind: 'player', bookPage: true },
    ],
    // The book page's own menu: a second copy of the page under the player is noise.
    [
      'a phone pushes no second copy of the book page on screen',
      { phone: true, viaBookPage: true, bookOnTop: true },
      { kind: 'player', bookPage: false },
    ],
    // Pushing the player over the open one would stack a second full player: minimised
    // twice, and when that book ends the credits replace only the top one, so closing
    // them lands on the lower player with nothing loaded.
    [
      'a phone starts in place with the full player on top',
      { phone: true, playerOnTop: true, viaBookPage: true },
      { kind: 'start' },
    ],
    [
      'a phone plays the loaded book on under the open player',
      { phone: true, playerOnTop: true, loaded: true },
      { kind: 'play-on' },
    ],
  ])('%s', (_, over, expected) => {
    expect(playRoute({ ...base, ...over })).toEqual(expected);
  });
});

describe('navFor', () => {
  const target = { connectionId: 'c', libraryId: 1, path: 'a/b' };
  const withPage = (params: object, top?: string): NavState => ({
    index: top ? 1 : 0,
    routes: [
      {
        name: '(app)',
        state: {
          routes: [
            {
              name: '(library)',
              state: { routes: [{ name: 'library/index' }, { name: 'book/[libraryId]', params }] },
            },
          ],
        },
      },
      ...(top ? [{ name: top }] : []),
    ],
  });

  it("knows the book's own page on screen by its route params", () => {
    const params = { connection: 'c', libraryId: '1', path: 'a/b' };
    expect(navFor(withPage(params), target)).toEqual({ playerOnTop: false, bookOnTop: true });
    expect(navFor(withPage({ ...params, path: 'a/c' }), target).bookOnTop).toBe(false);
    expect(navFor(withPage({ ...params, connection: 'd' }), target).bookOnTop).toBe(false);
    expect(navFor(withPage({ ...params, libraryId: '2' }), target).bookOnTop).toBe(false);
  });

  it('knows the full player on top (and the page under it is not on screen)', () => {
    const params = { connection: 'c', libraryId: '1', path: 'a/b' };
    expect(navFor(withPage(params, 'player'), target)).toEqual({
      playerOnTop: true,
      bookOnTop: false,
    });
    expect(navFor(undefined, target)).toEqual({ playerOnTop: false, bookOnTop: false });
  });
});
