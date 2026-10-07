import { fireEvent, screen } from '@testing-library/react-native';

import { mountWithPortal } from '@/testing/render-overlay';

const mockRemove = jest.fn();
let mockControlsOverride: Record<string, unknown> = {};
jest.mock('@/downloads/use-download-controls', () => ({
  useDownloadControls: () => ({
    connectionId: 'c',
    supported: true,
    needsTranscode: false,
    status: 'downloaded',
    error: null,
    progress: 1,
    bytes: 52_428_800,
    totalBytes: 52_428_800,
    start: jest.fn(),
    cancel: jest.fn(),
    ...mockControlsOverride,
  }),
}));
// The confirm reads the room it frees from the registry and removes through the store.
jest.mock('@/downloads/store', () => ({
  useDownloadEntry: () => ({ status: 'downloaded', bytes: 52_428_800, totalBytes: 52_428_800 }),
  useDownloads: { getState: () => ({ remove: mockRemove }) },
}));

/* eslint-disable import/first */
import type { Book } from '@/api/types';

import { DownloadControl, DownloadProgress } from './download-control';
/* eslint-enable import/first */

const book = { title: 'Blood Rites' } as Book;

beforeEach(() => {
  mockRemove.mockReset();
  mockControlsOverride = {};
});

describe('DownloadControl', () => {
  // Removed from the menu its "Downloaded" button opens (with the size on this device).
  const pressRemove = async () => {
    await fireEvent.press(screen.getByRole('button', { name: 'Downloaded' }));
    expect(screen.getByText('50 MB on this device')).toBeTruthy();
    await fireEvent.press(screen.getByText('Remove download'));
  };

  it('asks before deleting a download, with its size', async () => {
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} />);
    await pressRemove();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(screen.getByText('Remove this download?')).toBeTruthy();
    expect(screen.getByText(/Blood Rites will need a connection.*It frees 50 MB\./)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockRemove).not.toHaveBeenCalled();

    await pressRemove();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove' }));
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledWith('c', 1, 'b');
  });

  it('shows the percent on the full control, and cancels from it', async () => {
    const cancel = jest.fn();
    mockControlsOverride = { status: 'downloading', progress: 0.52, cancel };
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} />);
    expect(screen.getByText('52% · Cancel')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '52% · Cancel, Cancel download' }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  // At 400 "100% · Cancel" pushed the hero's "..." onto a row of its own: a short
  // (stacked) row says only Cancel (the ring and the progress line carry the percent),
  // and the words give way rather than wrap.
  it('says only Cancel in a short row, the percent kept for screen readers', async () => {
    mockControlsOverride = { status: 'downloading', progress: 1 };
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} short />);
    expect(screen.queryByText('100% · Cancel')).toBeNull();
    const label = screen.getByText('Cancel');
    expect(label.props.numberOfLines).toBe(1);
    const button = screen.getByRole('button', { name: '100% · Cancel, Cancel download' });
    expect(String(button.props.className)).toMatch(/\bshrink\b/);
    expect(String(button.props.className)).not.toMatch(/shrink-0/);
  });

  it('keeps Downloaded and Download to one line that can give way', async () => {
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} short />);
    expect(screen.getByText('Downloaded').props.numberOfLines).toBe(1);
    mockControlsOverride = { status: undefined };
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} short />);
    expect(screen.getByText('Download').props.numberOfLines).toBe(1);
  });

  it('offers the download for offline, and a retry after a failure', async () => {
    const start = jest.fn();
    mockControlsOverride = { status: undefined, start };
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Download for offline' }));
    expect(start).toHaveBeenCalledTimes(1);
    mockControlsOverride = { status: 'error', error: 'The server stopped responding.', start };
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} />);
    expect(screen.getByRole('button', { name: 'Retry download' })).toBeTruthy();
    expect(screen.getByText('The server stopped responding.')).toBeTruthy();
  });

  it('says why when this browser plays the book transcoded', async () => {
    mockControlsOverride = { supported: false, needsTranscode: true, status: undefined };
    await mountWithPortal(<DownloadControl libraryId={1} path="b" book={book} />);
    const button = screen.getByRole('button', { name: "Can't download in this browser" });
    expect(button).toBeDisabled();
  });
});

describe('DownloadProgress', () => {
  it('says the percent and the bytes over an ink bar while downloading, nothing after', async () => {
    mockControlsOverride = { status: 'downloading', progress: 0.01, bytes: 524_288 };
    await mountWithPortal(<DownloadProgress libraryId={1} path="b" />);
    expect(screen.getByText(/^Downloading 1% · .+ \/ 50 MB$/)).toBeTruthy();
    // Ink, not pink (the hero's pink is the book's progress), and a started bar shows.
    expect(JSON.stringify(screen.toJSON())).toMatch(/bg-foreground\/60"[^}]*"width":"4%"/);
    mockControlsOverride = {};
    await mountWithPortal(<DownloadProgress libraryId={1} path="b" />);
    expect(screen.queryByText(/^Downloading/)).toBeNull();
  });
});
