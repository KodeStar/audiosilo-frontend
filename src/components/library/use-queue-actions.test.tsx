import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';

import { ApiError } from '@/api/client';
import type { QueueEntry } from '@/api/types';

const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

let mockSupported: boolean | undefined = true;
let mockQueue: QueueEntry[] | undefined;
const mockAdd = jest.fn();
const mockRemove = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useCapability: () => mockSupported,
    useQueue: () => ({ data: mockQueue }),
    useAddToQueue: () => ({ mutateAsync: mockAdd, isPending: false }),
    useRemoveFromQueue: () => ({ mutateAsync: mockRemove, isPending: false }),
  };
});
const mockNoteError = jest.fn();
jest.mock('@/api/reachability', () => ({
  ...jest.requireActual('@/api/reachability'),
  noteError: (e: unknown) => mockNoteError(e),
}));

/* eslint-disable import/first */
import { CapabilityError } from '@/api/hooks';

import { QueueButton } from './queue-button';
import { findQueued, useQueueActions } from './use-queue-actions';
/* eslint-enable import/first */

const entry = (library_id: number, path: string): QueueEntry => ({
  library_id,
  path,
  added_at: '2026-10-06T10:00:00Z',
});

describe('findQueued', () => {
  it('matches the entry itself, or the book a part path belongs to', () => {
    const q = [entry(1, 'A/Book'), entry(2, 'C')];
    expect(findQueued(q, 1, 'A/Book')?.path).toBe('A/Book');
    expect(findQueued(q, 1, 'A/Book/Disc 1')?.path).toBe('A/Book');
    expect(findQueued(q, 1, 'A/Booklet')).toBeUndefined();
    expect(findQueued(q, 2, 'A/Book')).toBeUndefined();
    expect(findQueued(undefined, 1, 'A/Book')).toBeUndefined();
  });
});

describe('useQueueActions', () => {
  beforeEach(() => {
    mockSupported = true;
    mockQueue = [entry(1, 'Old')];
    mockAdd.mockReset();
    mockRemove.mockReset();
    mockToast.mockReset();
    mockNoteError.mockReset();
  });

  const hook = async () => (await renderHook(() => useQueueActions('c'))).result;
  const lastToast = () => mockToast.mock.calls.at(-1)?.[0];

  it('queues at the end and offers Undo, which removes by the stored path', async () => {
    mockAdd.mockResolvedValue([entry(1, 'Old'), entry(1, 'New')]);
    mockRemove.mockResolvedValue(undefined);
    const q = await hook();
    let ok = false;
    await act(async () => {
      ok = await q.current.queue(1, 'New/Disc 2');
    });
    expect(ok).toBe(true);
    expect(mockAdd).toHaveBeenCalledWith({ libraryId: 1, path: 'New/Disc 2', position: undefined });
    expect(lastToast().title).toBe('Added to Up next');
    await act(async () => lastToast().action.onPress());
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'New' });
  });

  it('skips a book already queued', async () => {
    const q = await hook();
    expect(q.current.isQueued(1, 'Old')).toBe(true);
    await act(async () => {
      await q.current.queue(1, 'Old');
    });
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('unqueues by the entry path, and Undo puts it back where it was', async () => {
    mockQueue = [entry(1, 'First'), entry(1, 'Book')];
    mockRemove.mockResolvedValue(undefined);
    mockAdd.mockResolvedValue(mockQueue);
    const q = await hook();
    await act(async () => {
      await q.current.unqueue(1, 'Book/Part 1');
    });
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'Book' });
    expect(lastToast().title).toBe('Removed from Up next');
    await act(async () => lastToast().action.onPress());
    expect(mockAdd).toHaveBeenCalledWith({ libraryId: 1, path: 'Book', position: 1 });
  });

  it('stays quiet on a CapabilityError and never reports it as unreachable', async () => {
    mockQueue = [];
    mockAdd.mockRejectedValue(new CapabilityError('queue', true));
    const q = await hook();
    let ok = true;
    await act(async () => {
      ok = await q.current.queue(1, 'New');
    });
    expect(ok).toBe(false);
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockNoteError).not.toHaveBeenCalled();
  });

  it('says when Up next is full, and when a change failed', async () => {
    mockQueue = [];
    mockAdd.mockRejectedValueOnce(new ApiError(409, 'queue_full'));
    const q = await hook();
    await act(async () => {
      await q.current.queue(1, 'New');
    });
    expect(lastToast().title).toBe('Up next is full. Remove a book to add another.');
    mockAdd.mockRejectedValueOnce(new ApiError(500, 'boom'));
    await act(async () => {
      await q.current.queue(1, 'New');
    });
    expect(lastToast().title).toBe("Couldn't update Up next. Try again.");
  });
});

describe('QueueButton', () => {
  beforeEach(() => {
    mockSupported = true;
    mockQueue = [entry(1, 'Old')];
    mockAdd.mockReset().mockResolvedValue([]);
    mockRemove.mockReset().mockResolvedValue(undefined);
  });

  it('is hidden unless the server has Up next', async () => {
    mockSupported = undefined;
    const unknown = await render(<QueueButton connectionId="c" libraryId={1} path="New" />);
    expect(unknown.toJSON()).toBeNull();
    mockSupported = false;
    const off = await render(<QueueButton connectionId="c" libraryId={1} path="New" />);
    expect(off.toJSON()).toBeNull();
  });

  it('queues a book, or takes a queued one off', async () => {
    await render(<QueueButton connectionId="c" libraryId={1} path="New" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Add to Up next' }));
    expect(mockAdd).toHaveBeenCalled();
    expect(screen.getByText('Queue it')).toBeTruthy();

    await render(<QueueButton connectionId="c" libraryId={1} path="Old" />);
    expect(screen.getByText('Queued')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove from Up next' }));
    expect(mockRemove).toHaveBeenCalledWith({ libraryId: 1, path: 'Old' });
  });
});
