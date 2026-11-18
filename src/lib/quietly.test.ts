import { quietly } from './quietly';

describe('quietly', () => {
  it('leaves no unhandled rejection behind a refused call', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      quietly(Promise.reject(new Error('ERR_MOVE_NOT_TAKEN')));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('takes a value that is no promise', () => {
    expect(() => quietly(undefined)).not.toThrow();
  });
});
