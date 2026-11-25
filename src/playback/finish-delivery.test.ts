import {
  finishDelivered,
  onFinishChangedElsewhere,
  setFinishChannelForTests,
  tellFinishChangedElsewhere,
} from './finish-delivery';

// fe#258's follow-up: after an Undo in one tab, another tab kept showing the book finished
// ("Listen again") until clicked. The undoing tab tells the others on a tab channel.
describe('a finish undone in another tab', () => {
  afterEach(() => setFinishChannelForTests(undefined));

  it('is posted on the channel and heard by its subscribers', () => {
    const listeners = new Set<(ref: unknown) => void>();
    const posted: unknown[] = [];
    setFinishChannelForTests({
      post: (message) => {
        posted.push(message);
        for (const l of listeners) l(message);
      },
      subscribe: (listener) => {
        listeners.add(listener as (ref: unknown) => void);
        return () => listeners.delete(listener as (ref: unknown) => void);
      },
    });
    const told: unknown[] = [];
    const stop = onFinishChangedElsewhere((ref) => told.push(ref));
    const ref = { connectionId: 'c1', libraryId: 4, path: 'Author/Book: Two' };
    tellFinishChangedElsewhere({ ...ref, position: 12 } as typeof ref);
    // Only the book goes out.
    expect(posted).toEqual([ref]);
    expect(told).toEqual([ref]);
    // A different tab drained the finish after reconnect. The receiving tab uses the
    // same invalidation it already understands for Undo, without a second broadcast.
    finishDelivered('c1', [{ libraryId: 4, path: ref.path }]);
    expect(posted).toEqual([ref, ref]);
    expect(told).toEqual([ref, ref]);
    stop();
    tellFinishChangedElsewhere(ref);
    expect(told).toHaveLength(2);
  });

  it('is nothing without a channel (off the web)', () => {
    setFinishChannelForTests(null);
    expect(() =>
      tellFinishChangedElsewhere({ connectionId: 'c1', libraryId: 1, path: 'A' }),
    ).not.toThrow();
    expect(typeof onFinishChangedElsewhere(() => {})).toBe('function');
  });
});
