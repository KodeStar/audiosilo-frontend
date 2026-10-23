import { File } from 'expo-file-system';

import { OPML_MAX_BYTES } from './find-shows-model';

/** A picked OPML list: its name, its size in bytes and the bytes to upload (a `Blob` on
 * the web, a `Uint8Array` on a device). A file over the import limit carries no bytes:
 * it is refused before anything is read or sent. */
export type PickedOpml = { name: string; size: number; body: Blob | Uint8Array };

/**
 * Native: the system document picker (expo-file-system's `File.pickFileAsync`, no new
 * dependency) with no type filter, since OPML has no system type on iOS; the server reads
 * the bytes whatever the file is called. Null when the listener cancels. The web build has
 * its own module (`opml-pick.web.ts`: a file input).
 */
export async function pickOpml(): Promise<PickedOpml | null> {
  const picked = await File.pickFileAsync();
  if (picked.canceled) return null;
  const file = picked.result;
  const size = file.size ?? 0;
  if (size > OPML_MAX_BYTES) return { name: file.name, size, body: new Uint8Array() };
  const bytes = await file.bytes();
  return { name: file.name, size: bytes.byteLength, body: bytes };
}
