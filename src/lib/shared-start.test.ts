import { sharedStart } from './shared-start';

describe('sharedStart', () => {
  it('runs once for every holder and stops with the last release', () => {
    const stop = jest.fn();
    const run = jest.fn(() => stop);
    const start = sharedStart(run);
    const a = start();
    const b = start();
    expect(run).toHaveBeenCalledTimes(1);
    a();
    a(); // a second release of one holder is a no-op
    expect(stop).not.toHaveBeenCalled();
    b();
    expect(stop).toHaveBeenCalledTimes(1);
    // Started again after the last release: a fresh run.
    start()();
    expect(run).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('a run that throws holds nothing, so the next start tries again', () => {
    const run = jest
      .fn<() => void, []>()
      .mockImplementationOnce(() => {
        throw new Error('no');
      })
      .mockImplementation(() => () => undefined);
    const start = sharedStart(run);
    expect(() => start()).toThrow('no');
    const release = start();
    expect(run).toHaveBeenCalledTimes(2);
    release();
  });
});
