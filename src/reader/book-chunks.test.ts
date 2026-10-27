import { CHUNK_BYTES, chunkCount, sendInChunks } from './book-chunks';
import type { HostMessage } from './protocol';

const open = {
  name: 'Book',
  theme: { scheme: 'light', background: '#ffffff', foreground: '#111111' },
  fontScale: 1,
} as const;

/** A reader that names each read by where it starts and how long it is. */
const reads: [number, number][] = [];
const read = async (position: number, length: number) => {
  reads.push([position, length]);
  return `${position}+${length}`;
};

beforeEach(() => {
  reads.length = 0;
});

describe('chunkCount', () => {
  it('counts the 256 KB pieces a book comes in, the last one short', () => {
    expect(CHUNK_BYTES).toBe(256 * 1024);
    expect(chunkCount(1)).toBe(1);
    expect(chunkCount(CHUNK_BYTES)).toBe(1);
    expect(chunkCount(CHUNK_BYTES + 1)).toBe(2);
    expect(chunkCount(24_836_548)).toBe(95);
  });
});

describe('sendInChunks', () => {
  it('announces the size and count, then posts every chunk in order, the last one short', async () => {
    const posted: HostMessage[] = [];
    const size = 2 * CHUNK_BYTES + 10;
    await expect(
      sendInChunks(
        size,
        { ...open, at: { cfi: 'epubcfi(/6/2)' } },
        read,
        (m) => posted.push(m),
        () => false,
      ),
    ).resolves.toBe(true);
    expect(posted[0]).toEqual({
      type: 'open',
      ...open,
      at: { cfi: 'epubcfi(/6/2)' },
      size,
      chunks: 3,
    });
    expect(posted.slice(1)).toEqual([
      { type: 'chunk', seq: 0, data: `0+${CHUNK_BYTES}` },
      { type: 'chunk', seq: 1, data: `${CHUNK_BYTES}+${CHUNK_BYTES}` },
      { type: 'chunk', seq: 2, data: `${2 * CHUNK_BYTES}+10` },
    ]);
  });

  it('reads one chunk only once the last was posted (one held at a time)', async () => {
    const order: string[] = [];
    await sendInChunks(
      2 * CHUNK_BYTES,
      open,
      async (position) => {
        order.push(`read ${position}`);
        return 'x';
      },
      (m) => order.push(m.type === 'chunk' ? `post ${m.seq}` : m.type),
      () => false,
    );
    expect(order).toEqual(['open', 'read 0', 'post 0', `read ${CHUNK_BYTES}`, 'post 1']);
  });

  it('stops between chunks once cancelled, posting nothing more', async () => {
    const posted: HostMessage[] = [];
    let stop = false;
    const done = await sendInChunks(
      3 * CHUNK_BYTES,
      open,
      async (position, length) => {
        if (position > 0) stop = true;
        return read(position, length);
      },
      (m) => posted.push(m),
      () => stop,
    );
    expect(done).toBe(false);
    expect(posted.map((m) => (m.type === 'chunk' ? m.seq : m.type))).toEqual(['open', 0]);
  });

  it('refuses an empty or unknown size before posting anything', async () => {
    const post = jest.fn();
    for (const size of [0, -1, Number.NaN, 1.5]) {
      await expect(sendInChunks(size, open, read, post, () => false)).rejects.toThrow();
    }
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects when a read fails, the reader left without its chunks', async () => {
    const post = jest.fn();
    await expect(
      sendInChunks(
        CHUNK_BYTES * 2,
        open,
        () => Promise.reject(new Error('gone')),
        post,
        () => false,
      ),
    ).rejects.toThrow('gone');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
