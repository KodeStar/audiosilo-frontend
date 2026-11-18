import { ApiError, NetworkError, TimeoutError } from '@/api/client';

import { setFinishRecorder, undoFinish } from './finish-route';

// fe#208: an Undo's progress edit goes only after the waiting finish is taken back; a
// finish that never left this device is undone here, with no edit.
describe('undoFinish', () => {
  const ref = { connectionId: 'c1', libraryId: 3, path: 'Author/Book', position: 48 };
  const steps: string[] = [];
  let unsent = false;
  let unreachable = false;
  let generation = 0;
  let knowsBefore = false;
  const restore = jest.fn(async () => {
    steps.push('restore');
  });
  const recorder = (over: Partial<Parameters<typeof setFinishRecorder>[0] & object> = {}) =>
    setFinishRecorder({
      takesEvent: () => true,
      generation: () => generation,
      leave: async () => undefined,
      reload: async () => {},
      record: async () => {},
      withdraw: async (...args) => {
        steps.push(`withdraw ${args.join(' ')}`);
        return { unsent, restore, ...(unreachable ? { unreachable: true as const } : {}) };
      },
      unrecord: async (r, since) => {
        steps.push(
          `unrecord at ${r.position}${r.atPosition ? ' (own place)' : ''} for sign-in ${since}`,
        );
      },
      restoreBefore: async (_r, since) => {
        if (knowsBefore) steps.push(`back to the place before for sign-in ${since}`);
        return knowsBefore;
      },
      ...over,
    });

  beforeEach(() => {
    steps.length = 0;
    unsent = false;
    unreachable = false;
    generation = 0;
    knowsBefore = false;
    restore.mockClear();
    recorder();
  });

  afterAll(() => setFinishRecorder(null));

  const edit = (ok: boolean) => async () => {
    steps.push('edit');
    if (!ok) throw new Error('refused');
  };

  // The edit's answer never reaches this device's record: left finished at the book's end,
  // the next offline Play started the book again at 0.
  it("a finish the server has: taken back (nothing waiting), the edit, then this device's record", async () => {
    await expect(undoFinish(ref, edit(true))).resolves.toBe('undone');
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit', 'unrecord at 48 for sign-in 0']);
  });

  it('an edit that failed puts the finish back and fails the Undo', async () => {
    await expect(undoFinish(ref, edit(false))).rejects.toThrow('refused');
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit', 'restore']);
  });

  // The first edit after the server died, before reachability noticed: the generic failure
  // offered no Try again, where the next attempt said the server can't be reached.
  it.each([
    ['no answer', new NetworkError(new Error('Failed to fetch'))],
    ['a timeout', new TimeoutError(15_000)],
    ["a proxy's 502", new ApiError(502, 'bad gateway')],
  ])('an edit that found the server away (%s): the finish back, unreachable', async (_, e) => {
    const failing = async () => {
      steps.push('edit');
      throw e;
    };
    await expect(undoFinish(ref, failing)).resolves.toBe('unreachable');
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit', 'restore']);
  });

  it("an edit the server refused is still the edit's failure", async () => {
    const refused = async () => {
      throw new ApiError(500, 'boom');
    };
    await expect(undoFinish(ref, refused)).rejects.toThrow('boom');
  });

  it('a finish that never left (offline): undone here, no edit, never put back', async () => {
    unsent = true;
    knowsBefore = true;
    await expect(undoFinish(ref, edit(false))).resolves.toBe('undone');
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'back to the place before for sign-in 0']);
  });

  // A reload since, or another tab's finish: the place before is not known here.
  it('a finish that never left, the place before it not known: its own place, no edit', async () => {
    unsent = true;
    await expect(undoFinish(ref, edit(false))).resolves.toBe('undone');
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'unrecord at 48 for sign-in 0']);
  });

  // Mark as not finished of a finish the server never got: undone here at its own place, the
  // server kept the place before the finish while this device's record moved to another.
  describe('Mark as not finished (atPosition) of a finish that never left', () => {
    const own = { ...ref, atPosition: true };
    beforeEach(() => {
      unsent = true;
    });

    it('this device knowing the place before it: back there, as the server is, with no edit', async () => {
      knowsBefore = true;
      await expect(undoFinish(own, edit(false))).resolves.toBe('undone');
      expect(steps).toEqual([
        'withdraw c1 3 Author/Book',
        'back to the place before for sign-in 0',
      ]);
    });

    it('not knowing it (a reload, another tab): the edit puts the server at the place asked', async () => {
      await expect(undoFinish(own, edit(true))).resolves.toBe('undone');
      expect(steps).toEqual([
        'withdraw c1 3 Author/Book',
        'edit',
        'unrecord at 48 (own place) for sign-in 0',
      ]);
    });

    it('not knowing it, an edit that failed (offline) puts the finish back', async () => {
      await expect(undoFinish(own, edit(false))).rejects.toThrow('refused');
      expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit', 'restore']);
    });
  });

  // fe#258 (4a): undone here, a finish that did reach the server stayed there and won on
  // reconnect.
  it('a finish the server may hold while it looks down: no edit, nothing undone here', async () => {
    unreachable = true;
    await expect(undoFinish(ref, edit(true))).resolves.toBe('unreachable');
    expect(steps).toEqual(['withdraw c1 3 Author/Book']);
  });

  // fe#258: the edit went through with the finish still queued, which then finished the
  // book again.
  it('a withdrawal that failed fails the Undo: no edit', async () => {
    recorder({
      withdraw: async () => {
        throw new Error('storage');
      },
    });
    const e = jest.fn(async () => {});
    await expect(undoFinish(ref, e)).rejects.toThrow('storage');
    expect(e).not.toHaveBeenCalled();
  });

  it('the record is undone for the sign-in the Undo began in', async () => {
    generation = 4;
    const e = jest.fn(async () => {
      generation = 5; // signed out (and in again) while the edit was out
    });
    await undoFinish(ref, e);
    expect(steps.at(-1)).toBe('unrecord at 48 for sign-in 4');
  });

  it('nothing registered: the edit alone', async () => {
    setFinishRecorder(null);
    const e = jest.fn(async () => {});
    await expect(undoFinish(ref, e)).resolves.toBe('undone');
    expect(e).toHaveBeenCalledTimes(1);
    const away = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(undoFinish(ref, away)).resolves.toBe('unreachable');
  });
});
