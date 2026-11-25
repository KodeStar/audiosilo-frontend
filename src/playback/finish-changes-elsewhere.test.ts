import { setConnectionAliases } from '@/lib/connection-id';

const mockRefresh = jest.fn();
let mockListener: ((ref: unknown) => void) | null = null;
const mockStop = jest.fn();
jest.mock('@/api/hooks', () => ({
  refreshDeliveredFinishes: (...a: unknown[]) => mockRefresh(...a),
}));
jest.mock('@/api/provider', () => ({ queryClient: 'qc' }));
jest.mock('./finish-delivery', () => ({
  onFinishChangedElsewhere: (listener: (ref: unknown) => void) => {
    mockListener = listener;
    return mockStop;
  },
}));

/* eslint-disable-next-line import/first */
import { startFinishChangesElsewhere } from './finish-changes-elsewhere';

beforeEach(() => {
  jest.useFakeTimers();
  mockRefresh.mockClear();
});
afterEach(() => jest.useRealTimers());

it('reads a book again when another tab delivered or undid its finish, until stopped', () => {
  const stop = startFinishChangesElsewhere();
  setConnectionAliases({ old: 'c1' });
  mockListener?.({ connectionId: 'old', libraryId: 2, path: 'A/Book' });
  setConnectionAliases({});
  expect(mockRefresh).not.toHaveBeenCalled();
  jest.advanceTimersByTime(50);
  expect(mockRefresh).toHaveBeenCalledWith('qc', 'c1', [{ libraryId: 2, path: 'A/Book' }]);
  stop();
  expect(mockStop).toHaveBeenCalled();
});

it('refreshes a connection once for the books of one delivery', () => {
  const stop = startFinishChangesElsewhere();
  mockListener?.({ connectionId: 'c1', libraryId: 1, path: 'A' });
  mockListener?.({ connectionId: 'c1', libraryId: 1, path: 'B' });
  mockListener?.({ connectionId: 'c2', libraryId: 3, path: 'C' });
  jest.advanceTimersByTime(50);
  expect(mockRefresh).toHaveBeenCalledTimes(2);
  expect(mockRefresh).toHaveBeenCalledWith('qc', 'c1', [
    { libraryId: 1, path: 'A' },
    { libraryId: 1, path: 'B' },
  ]);
  expect(mockRefresh).toHaveBeenCalledWith('qc', 'c2', [{ libraryId: 3, path: 'C' }]);
  stop();
});

it('drops what was gathered when stopped', () => {
  const stop = startFinishChangesElsewhere();
  mockListener?.({ connectionId: 'c1', libraryId: 1, path: 'A' });
  stop();
  jest.advanceTimersByTime(50);
  expect(mockRefresh).not.toHaveBeenCalled();
});

it('reads a book told twice in one gathering once', () => {
  const stop = startFinishChangesElsewhere();
  mockListener?.({ connectionId: 'c1', libraryId: 1, path: 'A' });
  mockListener?.({ connectionId: 'c1', libraryId: 1, path: 'A' });
  jest.advanceTimersByTime(50);
  expect(mockRefresh).toHaveBeenCalledWith('qc', 'c1', [{ libraryId: 1, path: 'A' }]);
  stop();
});
