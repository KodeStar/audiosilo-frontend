import { act, renderHook } from '@testing-library/react-native';
import type { TFunction } from 'i18next';

import { ApiError } from '@/api/client';
import type { OpmlExport } from '@/api/types';
import i18n from '@/i18n';

const mockExport = jest.fn();
jest.mock('@/api/hooks', () => {
  const { CapabilityError } = jest.requireActual('@/api/hooks');
  return {
    CapabilityError,
    useExportOpml: () => ({ mutateAsync: mockExport, isPending: false }),
  };
});
const mockSave = jest.fn();
jest.mock('@/components/journal/export-save', () => ({
  saveExport: (...a: unknown[]) => mockSave(...a),
}));
const mockToast = jest.fn();
jest.mock('@/components/ui/toast', () => ({ toast: (o: unknown) => mockToast(o) }));

/* eslint-disable import/first */
import { exportToast, OPML_EXPORT_NAME, useExportShows } from './opml-export';
/* eslint-enable import/first */

const t = i18n.t.bind(i18n) as TFunction;
const done = (over: Partial<OpmlExport> = {}): OpmlExport => ({
  text: '<opml version="2.0"/>',
  exported: 3,
  omittedPrivate: 0,
  omittedUnavailable: 0,
  ...over,
});

beforeEach(() => {
  mockExport.mockReset();
  mockSave.mockReset().mockResolvedValue(undefined);
  mockToast.mockReset();
});

describe('exportToast', () => {
  it('says how many were exported, and that private feeds never are', () => {
    expect(exportToast(done(), t)).toEqual({
      title: 'Exported 3 shows',
      description: 'Private feeds are never exported.',
    });
    expect(exportToast(done({ exported: 1 }), t).title).toBe('Exported 1 show');
  });

  it('counts the private and address-less shows left out', () => {
    expect(exportToast(done({ omittedPrivate: 2, omittedUnavailable: 1 }), t)).toEqual({
      title: 'Exported 3 shows',
      description:
        '2 private shows left out. Private feeds are never exported. 1 show without a public address left out.',
    });
  });

  it('reads counts it could not see as unknown, still saying private feeds stay out', () => {
    expect(
      exportToast(done({ exported: null, omittedPrivate: null, omittedUnavailable: null }), t),
    ).toEqual({ title: 'Exported your shows', description: 'Private feeds are never exported.' });
  });
});

describe('useExportShows', () => {
  it('saves the document under its name, then toasts the counts', async () => {
    mockExport.mockResolvedValue(done({ omittedPrivate: 1 }));
    const { result } = await renderHook(() => useExportShows('c1'));
    await act(() => result.current.run());
    expect(mockSave).toHaveBeenCalledWith(
      {
        name: OPML_EXPORT_NAME,
        content: '<opml version="2.0"/>',
        mimeType: 'text/x-opml',
        uti: 'public.xml',
      },
      'Your shows',
    );
    expect(mockToast).toHaveBeenCalledWith({
      title: 'Exported 3 shows',
      description: '1 private show left out. Private feeds are never exported.',
    });
  });

  it.each([
    ['opml_export_limit', 413, 'Too many shows to export in one file.'],
    ['opml_rate_limited', 429, "You've exported a lot just now. Try again in a minute."],
    ['internal', 500, "Couldn't export your shows. Try again."],
  ])('toasts a refusal (%s) and saves nothing', async (code, status, copy) => {
    mockExport.mockRejectedValue(new ApiError(status, 'no', code));
    const { result } = await renderHook(() => useExportShows('c1'));
    await act(() => result.current.run());
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith({ title: copy });
  });

  it('says so when the file could not be saved', async () => {
    mockExport.mockResolvedValue(done());
    mockSave.mockRejectedValue(new Error('share sheet'));
    const { result } = await renderHook(() => useExportShows('c1'));
    await act(() => result.current.run());
    expect(mockToast).toHaveBeenCalledWith({ title: "Couldn't export your shows. Try again." });
  });
});
