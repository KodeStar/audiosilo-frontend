import type { OpmlImportRow } from '@/api/types';
import { sameOrigin } from '@/lib/same-origin';

/**
 * The feed address of each subscription in an OPML list, by the import rows'
 * `outline_index` (server v2.4.0's import Try again): the server reports only a redacted
 * label (scheme and host), so a row's single follow by address reads its address from the
 * bytes the page still holds. Counted as the server counts (`internal/podcast/opml`
 * `Parse`): every unprefixed `<outline>` in the body's outline tree (the body's own, and
 * outlines inside those), in document order, 1-based, categories included; an outline
 * under any other element is not counted, nor is anything below it. The `xmlUrl`
 * attribute in any letter case, XML's own entities decoded. Comments, CDATA and the XML
 * declaration are skipped (left to right, so a comment opener inside a CDATA is text).
 * Markup it can't read (a DOCTYPE, a tag it can't parse, a default namespace) gives no
 * address at all, never numbers that could have slipped onto another row: an address it
 * can't find gives the row no Try again (`rowFeedUrl`).
 */
export function outlineFeeds(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const clean = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, ' ');
  // A tag: its name, then attributes read value by value (a quoted value may hold `>`).
  const tag = /<(\/?)([^\s/>]+)((?:\s*[^\s=/>"']+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  // The open elements, outermost first.
  const stack: string[] = [];
  let index = 0;
  for (let at = clean.indexOf('<'); at !== -1; at = clean.indexOf('<', tag.lastIndex)) {
    tag.lastIndex = at;
    const m = tag.exec(clean);
    if (!m) return new Map();
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    let url: string | null = null;
    for (let a = attr.exec(attrs); a; a = attr.exec(attrs)) {
      const key = a[1].toLowerCase();
      // A default namespace makes the element (and those below it) namespaced.
      if (key === 'xmlns' && (a[2] ?? a[3])) return new Map();
      if (key === 'xmlurl') url = decodeEntities(a[2] ?? a[3] ?? '').trim();
    }
    attr.lastIndex = 0;
    const inTree =
      stack[0] === 'opml' && stack[1] === 'body' && stack.slice(2).every((n) => n === 'outline');
    if (name === 'outline' && inTree) {
      index++;
      if (url) out.set(index, url);
    }
    if (!selfClosing) stack.push(name);
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

/** The address a row's Try again follows: the list's address at its `outline_index`, only
 * when it is the feed the server's label names (the same scheme and host), else null. */
export function rowFeedUrl(
  feeds: ReadonlyMap<number, string> | null,
  row: Pick<OpmlImportRow, 'outline_index' | 'feed'>,
): string | null {
  const url = feeds?.get(row.outline_index);
  if (!url || !row.feed) return null;
  const labelled = row.feed.replace(/\/\.\.\.$/, '').toLowerCase();
  // `URL.origin` is lower case without a default port, as the server's label writes it.
  return sameOrigin(url, { origin: labelled }) ? url : null;
}

/** The text of a picked list's bytes (UTF-8, as the server reads it; Expo's runtime
 * provides `TextDecoder` on a device). */
export async function opmlText(body: Blob | Uint8Array): Promise<string> {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : body.text();
}
