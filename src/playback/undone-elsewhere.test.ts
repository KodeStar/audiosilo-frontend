const mockInvalidate = jest.fn();
let mockListener: ((ref: unknown) => void) | null = null;
const mockStop = jest.fn();
jest.mock('@/api/hooks', () => ({
  invalidateFinishedProgress: (...a: unknown[]) => mockInvalidate(...a),
}));
jest.mock('@/api/provider', () => ({ queryClient: 'qc' }));
jest.mock('./progress-sync', () => ({
  onFinishUndoneElsewhere: (listener: (ref: unknown) => void) => {
    mockListener = listener;
    return mockStop;
  },
}));

/* eslint-disable-next-line import/first */
import { startUndoneElsewhere } from './undone-elsewhere';

it('reads a book again when another tab undid its finish, until stopped', () => {
  const stop = startUndoneElsewhere();
  mockListener?.({ connectionId: 'c1', libraryId: 2, path: 'A/Book' });
  expect(mockInvalidate).toHaveBeenCalledWith('qc', 'c1', 2, 'A/Book');
  stop();
  expect(mockStop).toHaveBeenCalled();
});
