import { focusedRoute, type NavState, topRootRoute } from './root-stack';

const book = { name: 'book/[libraryId]', params: { connection: 'c', libraryId: '1', path: 'a/b' } };
const shell = (index = 1): NavState => ({
  index: 0,
  routes: [
    {
      name: '(app)',
      state: {
        index: 0,
        routes: [
          { name: '(library)', state: { index, routes: [{ name: 'library/index' }, book] } },
        ],
      },
    },
  ],
});

describe('focusedRoute', () => {
  it('finds the page on screen at the end of the focused chain, with its params', () => {
    expect(focusedRoute(shell())).toEqual(book);
    expect(focusedRoute(shell(0))?.name).toBe('library/index');
  });

  it('is the root route over the shell while one is on top', () => {
    const state = shell();
    state.routes.push({ name: 'player' });
    state.index = 1;
    expect(focusedRoute(state)?.name).toBe('player');
    expect(topRootRoute(state)).toBe('player');
  });

  it('takes the last route of a stack without an index, and is null with no state', () => {
    expect(focusedRoute({ routes: [{ name: 'a' }, { name: 'b' }] })?.name).toBe('b');
    expect(focusedRoute(undefined)).toBeNull();
  });
});
