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
