import { downloadBlob } from '@/lib/download-blob';

import type { ExportFile } from './export-save';

export type { ExportFile };

/**
 * Web: download the export (a Blob behind a temporary link, named `journal-<date>.md` or
 * `.csv`). The native build shares a file instead (`export-save.ts`).
 */
export async function saveExport(
  file: ExportFile,
  _dialogTitle: string,
  onReady?: () => void,
): Promise<void> {
  onReady?.();
  downloadBlob(new Blob([file.content], { type: `${file.mimeType};charset=utf-8` }), file.name);
}
