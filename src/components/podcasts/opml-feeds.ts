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
  return outlineEntries(text).feeds;
}

/** The longest title a row shows from its list, in code points: a display bound of this
 * app's (the server reads and keeps at most 1,000 bytes of it, `opml.MaxTitleBytes` and
 * `bridge.MaxSubscribeTitleBytes`). */
const MAX_TITLE_CHARS = 500;

/**
 * Each subscription's own name in an OPML list, by the import rows' `outline_index`
 * (fe#126): its `title` attribute, else its `text`, on one line. The server never echoes
 * the list in its answer (a private feed's outline stays in memory), so a row's name is
 * read from the bytes the page still holds, counted as `outlineFeeds` counts. Markup it
 * can't read gives no titles (the rows show their address).
 */
export function outlineTitles(text: string): Map<number, string> {
  return outlineEntries(text).titles;
}

/** A list's addresses (`outlineFeeds`) and names (`outlineTitles`) by `outline_index`,
 * read in one walk; both empty when the markup can't be read. */
export function outlineEntries(text: string): {
  feeds: Map<number, string>;
  titles: Map<number, string>;
} {
  const feeds = new Map<number, string>();
  const titles = new Map<number, string>();
  const read = walkOutlines(text, (index, url, title) => {
    if (url) feeds.set(index, url);
    if (title) titles.set(index, title);
  });
  return read ? { feeds, titles } : { feeds: new Map(), titles: new Map() };
}

/** Visits each counted outline (`outlineFeeds`) with its index, its `xmlUrl` and its
 * title; false when the markup can't be read (the caller keeps nothing). */
function walkOutlines(
  text: string,
  visit: (index: number, url: string | null, title: string | null) => void,
): boolean {
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
    if (!m) return false;
    const [, closing, name, attrs, selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    let url: string | null = null;
    let title = '';
    let label = '';
    for (let a = attr.exec(attrs); a; a = attr.exec(attrs)) {
      const key = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? '';
      // A default namespace makes the element (and those below it) namespaced.
      if (key === 'xmlns' && value) return false;
      if (key === 'xmlurl') url = decodeEntities(value).trim();
      // The server reads these two by their exact names.
      else if (a[1] === 'title') title = oneLine(decodeEntities(value));
      else if (a[1] === 'text') label = oneLine(decodeEntities(value));
    }
    attr.lastIndex = 0;
    const inTree =
      stack[0] === 'opml' && stack[1] === 'body' && stack.slice(2).every((n) => n === 'outline');
    if (name === 'outline' && inTree) {
      index++;
      visit(index, url, title || label || null);
    }
    if (!selfClosing) stack.push(name);
  }
  return true;
}

/** A title on one line: control characters and runs of white space as one space, trimmed
 * and bounded in code points (never half an emoji's surrogate pair). */
function oneLine(s: string): string {
  const line = s.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  const chars = Array.from(line);
  return chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join('').trimEnd() : line;
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
