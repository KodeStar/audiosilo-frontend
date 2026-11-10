import { setFinishRecorder, undoFinish } from './finish-route';

// fe#208: an Undo's progress edit goes only after the waiting finish is taken back.
describe('undoFinish', () => {
  const ref = { connectionId: 'c1', libraryId: 3, path: 'Author/Book' };
  const steps: string[] = [];
  const restore = jest.fn(async () => {
    steps.push('restore');
  });

  beforeEach(() => {
    steps.length = 0;
    restore.mockClear();
    setFinishRecorder({
      takesEvent: () => true,
      record: async () => {},
      withdraw: async (...args) => {
        steps.push(`withdraw ${args.join(' ')}`);
        return restore;
      },
    });
  });

  afterAll(() => setFinishRecorder(null));

  it('takes the finish back, then edits; the finish stays out', async () => {
    const ok = await undoFinish(ref, async () => {
      steps.push('edit');
      return true;
    });
    expect(ok).toBe(true);
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit']);
  });

  it('an edit that failed puts the finish back', async () => {
    const ok = await undoFinish(ref, async () => {
      steps.push('edit');
      return false;
    });
    expect(ok).toBe(false);
    expect(steps).toEqual(['withdraw c1 3 Author/Book', 'edit', 'restore']);
  });

  it('a withdrawal that failed still edits', async () => {
    setFinishRecorder({
      takesEvent: () => true,
      record: async () => {},
      withdraw: async () => {
        throw new Error('storage');
      },
    });
    const edit = jest.fn(async () => true);
    await expect(undoFinish(ref, edit)).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('nothing registered: the edit alone', async () => {
    setFinishRecorder(null);
    const edit = jest.fn(async () => true);
    await expect(undoFinish(ref, edit)).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
