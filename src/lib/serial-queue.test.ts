import { serialQueue } from './serial-queue';

describe('serialQueue', () => {
  it('runs one job at a time, in order', async () => {
    const serially = serialQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => () =>
      new Promise<string>((resolve) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          resolve(name);
        }, ms);
      });
    const results = await Promise.all([serially(job('a', 20)), serially(job('b', 1))]);
    expect(results).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('rejects only the failed job, and runs the next', async () => {
    const serially = serialQueue();
    const failed = serially(async () => {
      throw new Error('boom');
    });
    const next = serially(async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });

  it('keeps each queue apart', async () => {
    const a = serialQueue();
    const b = serialQueue();
    let release: () => void = () => {};
    void a(() => new Promise<void>((r) => (release = r)));
    // b is not held behind a's unfinished job.
    await expect(b(async () => 'b')).resolves.toBe('b');
    release();
  });
});
