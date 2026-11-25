import { setConnectionAliases } from '@/lib/connection-id';

const mockInvalidate = jest.fn();
let mockListener: ((ref: unknown) => void) | null = null;
const mockStop = jest.fn();
jest.mock('@/api/hooks', () => ({
  invalidateFinishedProgress: (...a: unknown[]) => mockInvalidate(...a),
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

it('reads a book again when another tab delivered or undid its finish, until stopped', () => {
  const stop = startFinishChangesElsewhere();
  setConnectionAliases({ old: 'c1' });
  mockListener?.({ connectionId: 'old', libraryId: 2, path: 'A/Book' });
  setConnectionAliases({});
  expect(mockInvalidate).toHaveBeenCalledWith('qc', 'c1', 2, 'A/Book');
  stop();
  expect(mockStop).toHaveBeenCalled();
});
