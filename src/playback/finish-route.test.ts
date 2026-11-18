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
      knowsPlaceBefore: async () => knowsBefore,
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

  it('a finish that never left (offline): undone here, no edit, never put back', async () => {
    unsent = true;
    await expect(undoFinish(ref, edit(false))).resolves.toBe('undone');
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'unrecord at 48 for sign-in 0']);
  });

  // Mark as not finished of a finish the server never got: undone here at its own place, the
  // server kept the place before the finish while this device's record moved to another.
  describe('Mark as not finished (atPosition) of a finish that never left', () => {
    const own = { ...ref, atPosition: true };

    it('this device knowing the place before it: back there, as the server is, with no edit', async () => {
      unsent = true;
      knowsBefore = true;
      await expect(undoFinish(own, edit(false))).resolves.toBe('undone');
      expect(steps).toEqual(['withdraw c1 3 Author/Book', 'unrecord at 48 for sign-in 0']);
    });

    it('not knowing it (a reload, another tab): the edit puts the server at the place asked', async () => {
      unsent = true;
      await expect(undoFinish(own, edit(true))).resolves.toBe('undone');
      expect(steps).toEqual([
        'withdraw c1 3 Author/Book',
        'edit',
        'unrecord at 48 (own place) for sign-in 0',
      ]);
    });

    it('not knowing it, an edit that failed (offline) puts the finish back', async () => {
      unsent = true;
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
  });
});
