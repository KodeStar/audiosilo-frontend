import { acceptReaderMessage, createHostChannel, parseReaderMessage } from './protocol';

const CFI = 'epubcfi(/6/4!/4/2/1:0)';

describe('parseReaderMessage', () => {
  it('takes the reader messages it knows, field by field', () => {
    expect(parseReaderMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(
      parseReaderMessage({ type: 'progress', cfi: CFI, fraction: 0.5, sectionLabel: 'One' }),
    ).toEqual({ type: 'progress', cfi: CFI, fraction: 0.5, sectionLabel: 'One' });
    expect(parseReaderMessage({ type: 'loading', value: true })).toEqual({
      type: 'loading',
      value: true,
    });
    expect(parseReaderMessage({ type: 'error', code: 'drm', message: 'locked' })).toEqual({
      type: 'error',
      code: 'drm',
      message: 'locked',
    });
    // A part of the open book that did not load (fe#164).
    expect(parseReaderMessage({ type: 'error', code: 'section', message: 'TypeError' })).toEqual({
      type: 'error',
      code: 'section',
      message: 'TypeError',
    });
    expect(parseReaderMessage({ type: 'escape', key: 'x' })).toEqual({ type: 'escape' });
    expect(parseReaderMessage({ type: 'opened', title: 'Ali', toc: [], rtl: true })).toEqual({
      type: 'opened',
      title: 'Ali',
      toc: [],
      rtl: true,
    });
  });

  it('keeps a usable TOC and drops broken entries', () => {
    const message = parseReaderMessage({
      type: 'opened',
      title: 'Alice',
      toc: [
        { label: 'One', href: 'one.xhtml', depth: 0 },
        { label: 'Deep', href: 'deep.xhtml', depth: 99 },
        { label: 'No href', href: '' },
        'junk',
      ],
    });
    expect(message).toEqual({
      type: 'opened',
      title: 'Alice',
      toc: [
        { label: 'One', href: 'one.xhtml', depth: 0 },
        { label: 'Deep', href: 'deep.xhtml', depth: 5 },
      ],
      rtl: false,
    });
  });

  it('clamps a fraction and refuses a place that is not a CFI the server takes', () => {
    expect(parseReaderMessage({ type: 'progress', cfi: CFI, fraction: 3 })).toMatchObject({
      fraction: 1,
    });
    expect(parseReaderMessage({ type: 'progress', cfi: '/6/4', fraction: 0.1 })).toBeNull();
    expect(
      parseReaderMessage({ type: 'progress', cfi: `epubcfi(${'x'.repeat(2048)})`, fraction: 0.1 }),
    ).toBeNull();
    expect(parseReaderMessage({ type: 'progress', cfi: CFI, fraction: NaN })).toBeNull();
  });

  it('ignores anything else', () => {
    expect(parseReaderMessage(null)).toBeNull();
    expect(parseReaderMessage('ready')).toBeNull();
    expect(parseReaderMessage({ type: 'eval', code: 'x' })).toBeNull();
    expect(parseReaderMessage({ type: 'error', code: 'other' })).toBeNull();
    expect(parseReaderMessage({ type: 'loading', value: 'yes' })).toBeNull();
  });
});

describe('acceptReaderMessage', () => {
  const frame = {};
  const origin = 'https://books.example';

  it('takes a message from the reader frame on our origin', () => {
    expect(
      acceptReaderMessage({ source: frame, origin, data: { type: 'ready' } }, frame, origin),
    ).toEqual({ type: 'ready' });
  });

  it('ignores another window, another origin, or no frame yet', () => {
    const data = { type: 'ready' };
    expect(acceptReaderMessage({ source: {}, origin, data }, frame, origin)).toBeNull();
    expect(
      acceptReaderMessage({ source: frame, origin: 'https://evil.example', data }, frame, origin),
    ).toBeNull();
    expect(acceptReaderMessage({ source: frame, origin: 'null', data }, frame, origin)).toBeNull();
    expect(acceptReaderMessage({ source: undefined, origin, data }, undefined, origin)).toBeNull();
  });
});

describe('createHostChannel', () => {
  it('holds messages until the reader is ready, then sends them in order', () => {
    const post = jest.fn();
    const channel = createHostChannel(post);
    const book = new ArrayBuffer(4);
    channel.send({ type: 'next' });
    channel.send(
      {
        type: 'open',
        book,
        name: 'Book',
        theme: { scheme: 'light', background: '#ffffff', foreground: '#000000' },
        fontScale: 1,
      },
      [book],
    );
    expect(post).not.toHaveBeenCalled();
    channel.ready();
    expect(post.mock.calls.map(([m]) => m.type)).toEqual(['next', 'open']);
    expect(post.mock.calls[1][1]).toEqual([book]);
    channel.send({ type: 'prev' });
    expect(post).toHaveBeenLastCalledWith({ type: 'prev' }, []);
  });

  it('says whether the reader is ready', () => {
    const channel = createHostChannel(jest.fn());
    expect(channel.isReady()).toBe(false);
    channel.ready();
    expect(channel.isReady()).toBe(true);
  });
});

// Read-along (Bridge Phase 3c): what the reader says back, field by field.
describe('parseReaderMessage (read-along)', () => {
  it('takes a seek, a follow state and what the reader made of the map', () => {
    expect(parseReaderMessage({ type: 'seek', t: 31.2, i: 4, cfi: CFI })).toEqual({
      type: 'seek',
      t: 31.2,
    });
    expect(parseReaderMessage({ type: 'seek', t: 0 })).toEqual({ type: 'seek', t: 0 });
    expect(parseReaderMessage({ type: 'following', value: false })).toEqual({
      type: 'following',
      value: false,
    });
    expect(parseReaderMessage({ type: 'readalong', state: 'ok', unresolved: 3 })).toEqual({
      type: 'readalong',
      state: 'ok',
      unresolved: 3,
    });
    expect(parseReaderMessage({ type: 'readalong', state: 'none', unresolved: 0 })).toEqual({
      type: 'readalong',
      state: 'none',
      unresolved: 0,
    });
    // A count past any map is capped, never trusted.
    expect(parseReaderMessage({ type: 'readalong', state: 'ok', unresolved: 1e12 })).toEqual({
      type: 'readalong',
      state: 'ok',
      unresolved: 1_000_000,
    });
  });

  it.each([
    { type: 'seek' },
    { type: 'seek', t: -1 },
    { type: 'seek', t: Number.NaN },
    { type: 'seek', t: Infinity },
    { type: 'seek', t: '12' },
    { type: 'seek', t: 8 * 24 * 3600 },
    { type: 'following' },
    { type: 'following', value: 'yes' },
    { type: 'readalong', state: 'ready', unresolved: 0 },
    { type: 'readalong', state: 'ok' },
    { type: 'readalong', state: 'ok', unresolved: -1 },
    { type: 'readalong', state: 'ok', unresolved: 1.5 },
  ])('refuses %j', (data) => {
    expect(parseReaderMessage(data)).toBeNull();
  });
});
