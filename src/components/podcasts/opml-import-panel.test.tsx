import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

import type { OpmlImportRow, PodcastRequest } from '@/api/types';

const mockPick = jest.fn();
jest.mock('./opml-pick', () => ({ pickOpml: () => mockPick() }));
jest.mock('expo-router', () => ({ useIsFocused: () => true }));
// The follow requests the queued rows are read against (live, by request id).
let mockRequests: Partial<PodcastRequest>[] = [];
jest.mock('@/api/hooks', () => ({
  useFollowRequests: () => ({ data: mockRequests }),
}));

/* eslint-disable import/first */
import { OpmlImportPanel } from './opml-import-panel';
import type { WaveState } from './opml-waves';
import type { OpmlImport } from './use-opml-import';
/* eslint-enable import/first */

const row = (i: number, over: Partial<OpmlImportRow> = {}): OpmlImportRow => ({
  outline_index: i,
  status: 'followed',
  feed: `https://example.com/...`,
  private: false,
  path: null,
  request_id: null,
  duplicate_of: null,
  error: null,
  ...over,
});

function importer(over: Partial<OpmlImport> = {}): OpmlImport {
  return {
    state: null,
    problem: null,
    fileName: null,
    start: jest.fn(),
    unreadable: jest.fn(),
    stop: jest.fn(),
    retry: jest.fn(),
    retries: {},
    canRetryRow: () => false,
    retryRow: jest.fn(),
    ...over,
  };
}

const state = (status: WaveState['status'], rows: OpmlImportRow[] = []): WaveState => ({
  status,
  rows,
});

beforeEach(() => {
  mockPick.mockReset();
  mockRequests = [];
});

describe('OpmlImportPanel', () => {
  it('starts an import with the chosen file', async () => {
    const opml = importer();
    const picked = { name: 'subs.opml', size: 10, body: new Uint8Array(10) };
    mockPick.mockResolvedValue(picked);
    await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(screen.getByText('Choose a file')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('opml-choose'));
    expect(opml.start).toHaveBeenCalledWith(picked);
  });

  it('does nothing when the picker is cancelled, and says so when it fails', async () => {
    const opml = importer();
    mockPick.mockResolvedValueOnce(null);
    await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    await fireEvent.press(screen.getByTestId('opml-choose'));
    expect(opml.start).not.toHaveBeenCalled();
    expect(opml.unreadable).not.toHaveBeenCalled();
    mockPick.mockRejectedValueOnce(new Error('no'));
    await fireEvent.press(screen.getByTestId('opml-choose'));
    expect(opml.unreadable).toHaveBeenCalled();
  });

  it('says a file over 1 MB was refused, with no progress', async () => {
    await render(
      <OpmlImportPanel
        opml={importer({ problem: 'tooLarge', fileName: 'big.opml' })}
        connectionId="c1"
        libraryId={7}
      />,
    );
    expect(screen.getByTestId('opml-problem').props.children).toBe(
      'That file is over 1 MB. Export a shorter list.',
    );
    expect(screen.getByText('Choose another file')).toBeTruthy();
    expect(screen.queryByTestId('opml-status')).toBeNull();
  });

  it('counts down to the next batch while waiting, with Stop', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const opml = importer({
        fileName: 'subs.opml',
        state: state({ kind: 'waitingTime', at: 1_000_000 + 25_000, why: 'spacing' }, [
          row(1),
          row(2, { status: 'queued', request_id: 5 }),
          row(3, { status: 'limited' }),
          row(4, { status: 'duplicate', duplicate_of: 1 }),
        ]),
      });
      await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
      expect(screen.getByTestId('opml-status').props.children).toBe('Next batch in 25 s.');
      expect(screen.getByTestId('opml-summary').props.children).toBe(
        '2 of 3 shows followed or being added',
      );
      await act(async () => jest.advanceTimersByTime(5_000));
      expect(screen.getByTestId('opml-status').props.children).toBe('Next batch in 20 s.');
      expect(screen.getByTestId('opml-choose').props.accessibilityState?.disabled).toBe(true);
      await fireEvent.press(screen.getByTestId('opml-stop'));
      expect(opml.stop).toHaveBeenCalled();
      expect(screen.queryByTestId('opml-retry')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('lists every subscription by its place, with what happened to it', async () => {
    await render(
      <OpmlImportPanel
        opml={importer({
          state: state({ kind: 'done' }, [
            row(1, { path: 'Daily News' }),
            row(2, { status: 'already_following', private: true }),
            // The server marks an invalid row private too: no badge without a feed.
            row(3, { status: 'invalid', feed: null, private: true }),
            row(4, { status: 'duplicate', duplicate_of: 1, private: true }),
          ]),
        })}
        connectionId="c1"
        libraryId={7}
      />,
    );
    const r = (i: number) => within(screen.getByTestId(`opml-row-${i}`));
    expect(r(1).getByText('Entry 1')).toBeTruthy();
    expect(r(1).getByText('Daily News')).toBeTruthy();
    expect(r(1).getByText('Following')).toBeTruthy();
    expect(r(2).getByText('Already following')).toBeTruthy();
    expect(r(2).getByText('Private feed')).toBeTruthy();
    expect(r(3).getAllByText('No usable feed address')).toHaveLength(1);
    expect(r(3).queryByText('Private feed')).toBeNull();
    expect(r(4).getByText('In the list twice (Entry 1)')).toBeTruthy();
    expect(r(4).queryByText('Private feed')).toBeNull();
    expect(screen.getByTestId('opml-status').props.children).toBe('All done.');
    expect(screen.queryByTestId('opml-stop')).toBeNull();
    expect(screen.queryByTestId('opml-retry')).toBeNull();
  });

  it.each([
    [{ kind: 'stalled' }, "The next batch couldn't start. Try again in a while."],
    [{ kind: 'stopped', why: 'user' }, 'Stopped. Shows already added stay.'],
    [{ kind: 'stopped', why: 'busy' }, 'Your server stayed busy. Try again later.'],
    [
      { kind: 'stopped', why: 'cantAct' },
      'Stopped, because someone else is listening on this device now.',
    ],
    [{ kind: 'failed', code: 'invalid_opml' }, "That file isn't an OPML list."],
    [{ kind: 'failed', code: 'opml_limit' }, 'That list is too large to import.'],
    [{ kind: 'failed', code: null }, "Couldn't import the list. Try again."],
  ] as [WaveState['status'], string][])('offers Try again once %j', async (status, copy) => {
    const opml = importer({ state: state(status) });
    await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(screen.getByTestId('opml-status').props.children).toBe(copy);
    await fireEvent.press(screen.getByTestId('opml-retry'));
    expect(opml.retry).toHaveBeenCalled();
    expect(screen.queryByTestId('opml-stop')).toBeNull();
  });

  it('says the server is busy with its wait', async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      await render(
        <OpmlImportPanel
          opml={importer({ state: state({ kind: 'waitingTime', at: 2_000, why: 'busy' }) })}
          connectionId="c1"
          libraryId={7}
        />,
      );
      expect(screen.getByTestId('opml-status').props.children).toBe(
        'Your server is busy. Trying again in 2 s.',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('is not done while the last wave is still being added, and reads each row live', async () => {
    const rows = [
      row(1),
      row(2, { status: 'queued', request_id: 5 }),
      row(3, { status: 'already_queued', request_id: 6 }),
    ];
    mockRequests = [
      { id: 5, state: 'running' },
      { id: 6, state: 'queued' },
    ];
    const opml = importer({ state: state({ kind: 'done' }, rows) });
    const view = await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(screen.getByTestId('opml-status').props.children).toBe(
      'The last shows are still being added.',
    );
    expect(within(screen.getByTestId('opml-row-2')).getByText('Being added')).toBeTruthy();

    mockRequests = [
      { id: 5, state: 'done', library_id: 7, show_path: 'Daily News' },
      { id: 6, state: 'failed', library_id: 7, show_path: null },
    ];
    await view.rerender(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(within(screen.getByTestId('opml-row-2')).getByText('Following')).toBeTruthy();
    expect(within(screen.getByTestId('opml-row-2')).getByText('Daily News')).toBeTruthy();
    expect(within(screen.getByTestId('opml-row-3')).getByText("Couldn't add")).toBeTruthy();
    // Not "All done." with a row that could not be added (R-4).
    expect(screen.getByTestId('opml-status').props.children).toBe(
      "Done. 1 show couldn't be added. You can try it again below.",
    );
    expect(screen.getByTestId('opml-summary').props.children).toBe(
      '2 of 3 shows followed or being added',
    );
  });

  it("says an import's own rate limit in words of its own (BRIDGE-08)", async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      await render(
        <OpmlImportPanel
          opml={importer({ state: state({ kind: 'waitingTime', at: 25_000, why: 'rateLimited' }) })}
          connectionId="c1"
          libraryId={7}
        />,
      );
      expect(screen.getByTestId('opml-status').props.children).toBe(
        'Imports can run about once every 30 seconds. Trying again in 25 s.',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('says why a row could not be added, with its own Try again (BRIDGE-01)', async () => {
    const failed = row(1, {
      status: 'error',
      request_id: 9,
      error: { code: 'recently_failed', message: 'x' },
    });
    const retryRow = jest.fn();
    const opml = importer({
      state: state({ kind: 'done' }, [failed, row(2), row(3, { status: 'cancelled' })]),
      canRetryRow: (r) => r.outline_index !== 2,
      retryRow,
    });
    const view = await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(screen.getByTestId('opml-row-reason-1').props.children).toBe(
      "It couldn't be added a short while ago.",
    );
    expect(within(screen.getByTestId('opml-row-3')).getByText('Cancelled')).toBeTruthy();
    expect(screen.queryByTestId('opml-row-retry-2')).toBeNull();
    await fireEvent.press(screen.getByTestId('opml-row-retry-1'));
    expect(retryRow).toHaveBeenCalledWith(failed);

    // Its request's own reason, once the list holds it.
    mockRequests = [{ id: 9, state: 'failed', error: { code: 'not_a_feed', message: 'x' } }];
    await view.rerender(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(screen.getByTestId('opml-row-reason-1').props.children).toBe(
      "That address isn't a podcast feed.",
    );
  });

  it("shows a row's Try again answer over the wave's", async () => {
    const failed = row(1, { status: 'error', error: { code: 'recently_failed', message: 'x' } });
    const opml = importer({
      state: state({ kind: 'done' }, [failed]),
      retries: { 1: { kind: 'answered', row: { ...failed, status: 'followed', error: null } } },
      // As the hook's: a row that could not be added.
      canRetryRow: (r) => r.status === 'error' || r.status === 'cancelled',
    });
    await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(within(screen.getByTestId('opml-row-1')).getByText('Following')).toBeTruthy();
    expect(screen.queryByTestId('opml-row-reason-1')).toBeNull();
    expect(screen.queryByTestId('opml-row-retry-1')).toBeNull();
    expect(screen.getByTestId('opml-status').props.children).toBe('All done.');
  });

  it('counts the shows that could not be added and offers Try again for them', async () => {
    const opml = importer({
      state: state({ kind: 'done' }, [
        row(1),
        row(2, { status: 'unavailable' }),
        row(3, { status: 'unavailable' }),
      ]),
    });
    await render(<OpmlImportPanel opml={opml} connectionId="c1" libraryId={7} />);
    expect(
      within(screen.getByTestId('opml-row-2')).getByText("Can't be added right now"),
    ).toBeTruthy();
    expect(screen.getByTestId('opml-status').props.children).toBe(
      "2 shows can't be added right now. Try again later, or ask the person who runs your server.",
    );
    await fireEvent.press(screen.getByTestId('opml-retry'));
    expect(opml.retry).toHaveBeenCalled();
  });
});
