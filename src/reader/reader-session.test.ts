import type { HostMessage, ReaderMessage } from './protocol';
import { READER_START_MS, ReaderStartError } from './reader-host-types';
import { type ReadalongLink, startReaderSession } from './reader-session';

// The session setup both reader hosts share (fe#172): the start timeout, `ready`, and where
// each of the reader's messages goes. The hosts' own tests cover what they add.

function start(opts: { withReadalong?: boolean } = {}) {
  const posted: HostMessage[] = [];
  const order: string[] = [];
  const onMessage = jest.fn((m: ReaderMessage) => order.push(`message:${m.type}`));
  const onLoadError = jest.fn();
  const readalong: ReadalongLink = {
    documentReady: jest.fn(() => order.push('readalong')),
    receive: jest.fn(),
  };
  const observe = jest.fn((m: ReaderMessage) => order.push(`observe:${m.type}`));
  const session = startReaderSession({
    post: (m) => {
      posted.push(m);
      order.push(`post:${m.type}`);
    },
    callbacks: () => ({ onMessage, onLoadError }),
    onReady: () => order.push('onReady'),
    observe,
    ...(opts.withReadalong === false ? {} : { readalong }),
  });
  return { session, posted, order, onMessage, onLoadError, readalong, observe };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('startReaderSession', () => {
  it('holds messages until ready; then the host, what waited, then the read-along side', () => {
    const s = start();
    s.session.channel.send({ type: 'next' });
    expect(s.posted).toEqual([]);
    s.session.receive({ type: 'ready' });
    expect(s.order).toEqual(['onReady', 'post:next', 'readalong']);
    expect(s.onMessage).not.toHaveBeenCalled();
  });

  it('fails a document that never says ready, and not one that does', () => {
    const slow = start();
    jest.advanceTimersByTime(READER_START_MS);
    expect(slow.onLoadError).toHaveBeenCalledWith(expect.any(ReaderStartError));
    const quick = start();
    quick.session.receive({ type: 'ready' });
    jest.advanceTimersByTime(READER_START_MS);
    expect(quick.onLoadError).not.toHaveBeenCalled();
    const ended = start();
    ended.session.end();
    jest.advanceTimersByTime(READER_START_MS);
    expect(ended.onLoadError).not.toHaveBeenCalled();
  });

  it("hands the screen's messages to the host first, the read-along ones to its side", () => {
    const s = start();
    const opened: ReaderMessage = { type: 'opened', title: 'Book', toc: [], rtl: false };
    s.session.receive(opened);
    expect(s.order).toEqual(['observe:opened', 'message:opened']);
    for (const m of [
      { type: 'seek', t: 4 },
      { type: 'following', value: true },
      { type: 'readalong', state: 'ok', unresolved: 0 },
    ] as const) {
      s.session.receive(m);
      expect(s.readalong.receive).toHaveBeenLastCalledWith(m);
    }
    expect(s.onMessage).toHaveBeenCalledTimes(1);
  });

  it('logs a blocked load and tells nobody; takes nothing once ended', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = start({ withReadalong: false });
      s.session.receive({ type: 'csp', directive: 'img-src', blocked: 'https://x' });
      expect(warn).toHaveBeenCalledWith('[reader] blocked by CSP:', 'img-src', 'https://x');
      s.session.receive({ type: 'seek', t: 1 });
      s.session.end();
      s.session.receive({ type: 'loading', value: true });
      expect(s.onMessage).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
