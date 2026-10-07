import { classifyDownloadError } from './failure';

describe('classifyDownloadError', () => {
  it('reads the browsers fetch failures as the server not responding', () => {
    expect(classifyDownloadError(new TypeError('Failed to fetch'))).toEqual({ kind: 'network' });
    expect(classifyDownloadError(new TypeError('Load failed'))).toEqual({ kind: 'network' });
    expect(
      classifyDownloadError(new Error('NetworkError when attempting to fetch resource.')),
    ).toEqual({ kind: 'network' });
    expect(classifyDownloadError(new Error('The network connection was lost.'))).toEqual({
      kind: 'network',
    });
    expect(classifyDownloadError(new Error('The request timed out.'))).toEqual({ kind: 'network' });
  });

  it('reads an HTTP status as the server refusing, keeping the code', () => {
    expect(classifyDownloadError(new Error('Download failed (404)'))).toEqual({
      kind: 'server',
      status: 404,
    });
    expect(classifyDownloadError(new Error('Unable to download file: status code 503'))).toEqual({
      kind: 'server',
      status: 503,
    });
  });

  it('reads a full disk or quota as storage, before anything else', () => {
    const quota = new Error('The quota has been exceeded.');
    quota.name = 'QuotaExceededError';
    expect(classifyDownloadError(quota)).toEqual({ kind: 'storage' });
    expect(classifyDownloadError(new Error('ENOSPC: no space left on device (500)'))).toEqual({
      kind: 'storage',
    });
  });

  it('falls back to unknown, including for non-errors', () => {
    expect(classifyDownloadError(new Error('Download did not complete.'))).toEqual({
      kind: 'unknown',
    });
    expect(classifyDownloadError(undefined)).toEqual({ kind: 'unknown' });
    // A 2xx/3xx number in a message is not an HTTP failure.
    expect(classifyDownloadError(new Error('Moved (301) somewhere'))).toEqual({ kind: 'unknown' });
  });
});
