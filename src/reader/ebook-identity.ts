import { toHex } from '@/lib/random';
import { sha256 } from '@/lib/sha256';

/** The EPUB selected for this reader session, independent of its download record. */
export type OpenedEbook = {
  source: 'download' | 'server';
  size: number;
  sha256: string;
};

/** Hash the bytes handed to the web reader, including on plain HTTP LAN servers. */
export function ebookSha256(bytes: ArrayBuffer): string {
  return toHex(sha256(new Uint8Array(bytes)));
}
