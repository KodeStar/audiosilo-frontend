import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { shareText } from '@/lib/share';

/** A file the export hands over: its name, its text and its type. */
export type ExportFile = {
  name: string;
  content: string;
  /** For Android's share intent. */
  mimeType: string;
  /** For iOS's share sheet (a Uniform Type Identifier). */
  uti: string;
};

/** What became of the export: shared as a file, or (no file sharing on this device)
 * handed to the share sheet as text. */
export type SaveOutcome = 'file' | 'text';

/**
 * Native: write the export to the cache directory and open the share sheet on it (Save
 * to Files, Mail, Drive...). Where the OS can't share a file, the text itself goes to the
 * share sheet instead (React Native's `Share`), so the listener can still copy it. The
 * web build has its own module (`export-save.web.ts`: a download).
 */
export async function saveExport(
  file: ExportFile,
  dialogTitle: string,
  /** Called once the export is ready, just before the share sheet opens (which resolves
   * only when it closes): the caller's "Gathering" state ends there. */
  onReady?: () => void,
): Promise<SaveOutcome> {
  if (!(await Sharing.isAvailableAsync())) {
    onReady?.();
    await shareText(file.content);
    return 'text';
  }
  const out = new File(Paths.cache, file.name);
  out.create({ overwrite: true });
  out.write(file.content);
  onReady?.();
  await Sharing.shareAsync(out.uri, { mimeType: file.mimeType, UTI: file.uti, dialogTitle });
  return 'file';
}
