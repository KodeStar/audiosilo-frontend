import { saveExport as saveExportWeb } from './export-save.web';

const file = {
  name: 'journal-2026-10-07.csv',
  content: '﻿Type,Book\r\nBookmark,Éowyn\r\n',
  mimeType: 'text/csv',
  uti: 'public.comma-separated-values-text',
};

describe('saveExport (web)', () => {
  it('downloads a UTF-8 Blob under the file name and lets the URL go', async () => {
    jest.useFakeTimers();
    const click = jest.fn();
    const link = { click, remove: jest.fn(), style: {} as Record<string, string> } as Record<
      string,
      unknown
    >;
    const blobs: Blob[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { document: g.document, URL: g.URL };
    g.document = {
      createElement: () => link,
      body: { appendChild: jest.fn() },
    };
    g.URL = {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return 'blob:1';
      },
      revokeObjectURL: jest.fn(),
    };
    try {
      await expect(saveExportWeb(file, 'x')).resolves.toBe('file');
      expect(link.download).toBe(file.name);
      expect(link.href).toBe('blob:1');
      expect(click).toHaveBeenCalled();
      expect(blobs[0].type).toBe('text/csv;charset=utf-8');
      // The saved bytes start with the UTF-8 BOM (what Excel needs), then UTF-8 text.
      const bytes = [...new Uint8Array(await blobs[0].arrayBuffer())];
      expect(bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes).toContain(0xc3); // the É of Éowyn, as UTF-8
      jest.runAllTimers();
      expect((g.URL as { revokeObjectURL: jest.Mock }).revokeObjectURL).toHaveBeenCalledWith(
        'blob:1',
      );
    } finally {
      g.document = saved.document;
      g.URL = saved.URL;
      jest.useRealTimers();
    }
  });
});
