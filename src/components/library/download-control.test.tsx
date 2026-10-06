import { fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

const mockRemove = jest.fn();
jest.mock('@/downloads/use-download-controls', () => ({
  useDownloadControls: () => ({
    supported: true,
    status: 'downloaded',
    error: null,
    progress: 1,
    bytes: 52_428_800,
    totalBytes: 52_428_800,
    start: jest.fn(),
    cancel: jest.fn(),
    remove: mockRemove,
  }),
}));

/* eslint-disable import/first */
import type { Book } from '@/api/types';

import { DownloadControl } from './download-control';
/* eslint-enable import/first */

const book = { title: 'Blood Rites' } as Book;

beforeEach(() => mockRemove.mockReset());

describe('DownloadControl', () => {
  it.each([false, true])(
    'asks before deleting a download, with its size (compact %s)',
    async (compact) => {
      await mountWithPortal(
        <DownloadControl libraryId={1} path="b" book={book} compact={compact} />,
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Remove download' }));
      expect(mockRemove).not.toHaveBeenCalled();
      expect(screen.getByText('Remove this download?')).toBeTruthy();
      expect(screen.getByText(/Blood Rites will need a connection.*It frees 50 MB\./)).toBeTruthy();

      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      expect(mockRemove).not.toHaveBeenCalled();

      await fireEvent.press(screen.getByRole('button', { name: 'Remove download' }));
      await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
      expect(mockRemove).toHaveBeenCalledTimes(1);
    },
  );
});
