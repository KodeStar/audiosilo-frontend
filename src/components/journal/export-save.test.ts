const mockShareAsync = jest.fn(async () => {});
const mockIsAvailable = jest.fn(async () => true);
jest.mock('expo-sharing', () => ({
  isAvailableAsync: () => mockIsAvailable(),
  shareAsync: (...args: unknown[]) => mockShareAsync(...(args as [])),
}));

const mockFiles: { name: string; content?: string; created?: unknown }[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cache/' } },
  File: class {
    uri: string;
    entry: { name: string; content?: string; created?: unknown };
    constructor(_dir: unknown, name: string) {
      this.uri = `file:///cache/${name}`;
      this.entry = { name };
      mockFiles.push(this.entry);
    }
    create(opts: unknown) {
      this.entry.created = opts;
    }
    write(content: string) {
      this.entry.content = content;
    }
  },
}));

const mockShareText = jest.fn(async (_message: string) => {});
jest.mock('@/lib/share', () => ({ shareText: (m: string) => mockShareText(m) }));

/* eslint-disable import/first */
import { saveExport } from './export-save';
import { saveExport as saveExportWeb } from './export-save.web';
/* eslint-enable import/first */

const file = {
  name: 'journal-2026-10-07.csv',
  content: '﻿Type,Book\r\nBookmark,Éowyn\r\n',
  mimeType: 'text/csv',
  uti: 'public.comma-separated-values-text',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles.length = 0;
});

describe('saveExport (native)', () => {
  it('writes the file to the cache and opens the share sheet on it', async () => {
    await expect(saveExport(file, 'Export the journal')).resolves.toBe('file');
    expect(mockFiles).toEqual([
      { name: file.name, created: { overwrite: true }, content: file.content },
    ]);
    expect(mockShareAsync).toHaveBeenCalledWith(`file:///cache/${file.name}`, {
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
      dialogTitle: 'Export the journal',
    });
    expect(mockShareText).not.toHaveBeenCalled();
  });

  it("hands the text to the share sheet where files can't be shared", async () => {
    mockIsAvailable.mockResolvedValueOnce(false);
    await expect(saveExport(file, 'x')).resolves.toBe('text');
    expect(mockShareText).toHaveBeenCalledWith(file.content);
    expect(mockFiles).toEqual([]);
  });
});

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
