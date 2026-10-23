import type { OpmlImportRow } from '@/api/types';

/**
 * The feed address of each subscription in an OPML list, by the import rows'
 * `outline_index` (server v2.4.0's import Try again): the server reports only a redacted
 * label (scheme and host), so a row's single follow by address reads its address from the
 * bytes the page still holds. Counted as the server counts (`internal/podcast/opml`):
 * every unprefixed `<outline>` inside `<body>`, in document order, 1-based, categories
 * included; the `xmlUrl` attribute in any letter case, XML's own entities decoded. Lenient
 * on purpose (the server already validated the list): comments and CDATA are skipped, and
 * an address it can't find gives the row no Try again (`rowFeedUrl`).
 */
export function outlineFeeds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const open = /<body(?:\s[^>]*)?>/.exec(clean);
  if (!open) return out;
  const start = open.index + open[0].length;
  const end = clean.indexOf('</body', start);
  const body = clean.slice(start, end === -1 ? undefined : end);
  // A start tag's attributes may hold `>` inside quotes, so they are read value by value.
  const tag = /<outline((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
  const attr = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let index = 0;
  for (let m = tag.exec(body); m; m = tag.exec(body)) {
    index++;
    for (let a = attr.exec(m[1]); a; a = attr.exec(m[1])) {
      if (a[1].toLowerCase() !== 'xmlurl') continue;
      const url = decodeEntities(a[2] ?? a[3] ?? '').trim();
      if (url) out.set(index, url);
    }
    attr.lastIndex = 0;
  }
  return out;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return NAMED[name] ?? whole;
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

/** `scheme://host[:port]` of an address, lower case and without a default port (as the
 * server's redacted label writes it), or null. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The address a row's Try again follows: the list's address at its `outline_index`, only
 * when it is the feed the server's label names (the same scheme and host), else null. */
export function rowFeedUrl(
  feeds: ReadonlyMap<number, string> | null,
  row: Pick<OpmlImportRow, 'outline_index' | 'feed'>,
): string | null {
  const url = feeds?.get(row.outline_index);
  if (!url || !row.feed) return null;
  const labelled = row.feed.replace(/\/\.\.\.$/, '').toLowerCase();
  return originOf(url) === labelled ? url : null;
}

/** The text of a picked list's bytes (UTF-8, as the server reads it; Expo's runtime
 * provides `TextDecoder` on a device). */
export async function opmlText(body: Blob | Uint8Array): Promise<string> {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : body.text();
}
