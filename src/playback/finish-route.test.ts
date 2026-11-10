import { setFinishRecorder, undoFinish } from './finish-route';

// fe#208: an Undo's progress edit goes only after the waiting finish is taken back; a
// finish that never left this device is undone here, with no edit.
describe('undoFinish', () => {
  const ref = { connectionId: 'c1', libraryId: 3, path: 'Author/Book', position: 48 };
  const steps: string[] = [];
  let unsent = false;
  const restore = jest.fn(async () => {
    steps.push('restore');
  });
  const recorder = (over: Partial<Parameters<typeof setFinishRecorder>[0] & object> = {}) =>
    setFinishRecorder({
      takesEvent: () => true,
      record: async () => {},
      withdraw: async (...args) => {
        steps.push(`withdraw ${args.join(' ')}`);
        return { unsent, restore };
      },
      unrecord: async (r) => {
        steps.push(`unrecord at ${r.position}`);
      },
      ...over,
    });

  beforeEach(() => {
    steps.length = 0;
    unsent = false;
    restore.mockClear();
    recorder();
  });

  afterAll(() => setFinishRecorder(null));

  const edit = (ok: boolean) => async () => {
    steps.push('edit');
    return ok;
  };

  // The edit's answer never reaches this device's record: left finished at the book's end,
  // the next offline Play started the book again at 0.
  it("a finish the server has: taken back (nothing waiting), the edit, then this device's record", async () => {
    await expect(undoFinish(ref, edit(true))).resolves.toBe(true);
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit', 'unrecord at 48']);
  });

  it('an edit that failed puts the finish back', async () => {
    await expect(undoFinish(ref, edit(false))).resolves.toBe(false);
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit', 'restore']);
  });

  it('a finish that never left (offline): undone here, no edit, never put back', async () => {
    unsent = true;
    await expect(undoFinish(ref, edit(false))).resolves.toBe(true);
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'unrecord at 48']);
  });

  it('a withdrawal that failed still edits', async () => {
    recorder({
      withdraw: async () => {
        throw new Error('storage');
      },
    });
    const e = jest.fn(async () => true);
    await expect(undoFinish(ref, e)).resolves.toBe(true);
    expect(e).toHaveBeenCalledTimes(1);
  });

  it('nothing registered: the edit alone', async () => {
    setFinishRecorder(null);
    const e = jest.fn(async () => true);
    await expect(undoFinish(ref, e)).resolves.toBe(true);
    expect(e).toHaveBeenCalledTimes(1);
  });
});
