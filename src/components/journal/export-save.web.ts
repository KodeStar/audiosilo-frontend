import type { ExportFile, SaveOutcome } from './export-save';

export type { ExportFile, SaveOutcome };

/**
 * Web: download the export (a Blob behind a temporary link, named `journal-<date>.md` or
 * `.csv`). The native build shares a file instead (`export-save.ts`).
 */
export async function saveExport(
  file: ExportFile,
  _dialogTitle: string,
  onReady?: () => void,
): Promise<SaveOutcome> {
  onReady?.();
  const blob = new Blob([file.content], { type: `${file.mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next turn: some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return 'file';
}
