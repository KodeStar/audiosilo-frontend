import { importRowLabel, opmlText, outlineFeeds, outlineTitles, rowFeedUrl } from './opml-feeds';

const opml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>t</title></head><body>${body}</body></opml>`;

describe('outlineFeeds', () => {
  it('numbers every outline in the body from 1, categories included, as the server does', () => {
    const feeds = outlineFeeds(
      opml(`
        <outline text="News">
          <outline text="A" type="rss" xmlUrl="https://a.example/feed"/>
          <outline text="B" type="rss" xmlUrl='https://b.example/feed'></outline>
        </outline>
        <outline text="C" XMLURL="https://c.example/feed?x=1&amp;y=2"/>`),
    );
    expect([...feeds]).toEqual([
      [2, 'https://a.example/feed'],
      [3, 'https://b.example/feed'],
      [4, 'https://c.example/feed?x=1&y=2'],
    ]);
  });

  it("skips comments and CDATA, and reads a quoted '>' inside an attribute", () => {
    const feeds = outlineFeeds(
      opml(`
        <!-- <outline xmlUrl="https://commented.example/"/> -->
        <![CDATA[ <outline xmlUrl="https://cdata.example/"/> ]]>
        <outline text="a > b" xmlUrl="https://a.example/feed"/>`),
    );
    expect([...feeds]).toEqual([[1, 'https://a.example/feed']]);
  });

  it('decodes numeric entities, and counts no outline outside the body', () => {
    const text =
      '<opml><head><outline xmlUrl="https://head.example/"/></head><body>' +
      '<outline xmlUrl="https://a.example/&#x66;eed&#47;1"/></body></opml>';
    expect([...outlineFeeds(text)]).toEqual([[1, 'https://a.example/feed/1']]);
  });

  it("counts no outline under another element of the body, as the server's outline tree does", () => {
    const feeds = outlineFeeds(
      opml(`
        <group><outline xmlUrl="https://feeds.example.com/a"/></group>
        <outline xmlUrl="https://feeds.example.com/b"/>`),
    );
    expect([...feeds]).toEqual([[1, 'https://feeds.example.com/b']]);
  });

  it('reads attributes with no space between them, and a comment opener inside a CDATA', () => {
    const feeds = outlineFeeds(
      opml(`
        <outline text="A"xmlUrl="https://a.example/feed"/>
        <![CDATA[ <!-- ]]>
        <outline xmlUrl="https://b.example/feed"/>
        <!-- -->`),
    );
    expect([...feeds]).toEqual([
      [1, 'https://a.example/feed'],
      [2, 'https://b.example/feed'],
    ]);
  });

  it('gives no address at all for markup it cannot read, rather than numbers that slipped', () => {
    expect(
      outlineFeeds(`<!DOCTYPE opml>${opml('<outline xmlUrl="https://a.example/"/>')}`).size,
    ).toBe(0);
    expect(outlineFeeds(opml('<outline text=a xmlUrl="https://a.example/"/>')).size).toBe(0);
    expect(outlineFeeds(opml('<outline xmlns="urn:x" xmlUrl="https://a.example/"/>')).size).toBe(0);
  });

  it('reads nothing from a document without a body', () => {
    expect(outlineFeeds('<opml><outline xmlUrl="https://a.example/"/></opml>').size).toBe(0);
    expect(outlineFeeds('not xml').size).toBe(0);
  });
});

describe('rowFeedUrl', () => {
  const feeds = new Map([
    [1, 'https://Feeds.Example.org/show.xml'],
    [2, 'http://b.example:8080/rss'],
    [3, 'not a url'],
  ]);

  it("gives the list's address when it is the feed the row's label names", () => {
    expect(rowFeedUrl(feeds, { outline_index: 1, feed: 'https://feeds.example.org/...' })).toBe(
      'https://Feeds.Example.org/show.xml',
    );
    expect(rowFeedUrl(feeds, { outline_index: 2, feed: 'http://b.example:8080/...' })).toBe(
      'http://b.example:8080/rss',
    );
  });

  it('gives none for another host, another scheme, no address, or no label', () => {
    expect(rowFeedUrl(feeds, { outline_index: 1, feed: 'https://other.example/...' })).toBeNull();
    expect(rowFeedUrl(feeds, { outline_index: 2, feed: 'https://b.example:8080/...' })).toBeNull();
    expect(rowFeedUrl(feeds, { outline_index: 3, feed: 'https://x/...' })).toBeNull();
    expect(rowFeedUrl(feeds, { outline_index: 9, feed: 'https://x/...' })).toBeNull();
    expect(rowFeedUrl(feeds, { outline_index: 1, feed: null as never })).toBeNull();
    expect(
      rowFeedUrl(null, { outline_index: 1, feed: 'https://feeds.example.org/...' }),
    ).toBeNull();
  });
});

describe('opmlText', () => {
  it('reads the bytes as UTF-8, from bytes or a blob', async () => {
    const text = opml('<outline text="Café" xmlUrl="https://a.example/"/>');
    await expect(opmlText(new TextEncoder().encode(text))).resolves.toBe(text);
    await expect(opmlText({ text: async () => text } as Blob)).resolves.toBe(text);
  });
});

describe('outlineTitles', () => {
  it("reads each counted outline's title, else its text, on one line (fe#126)", () => {
    const titles = outlineTitles(
      opml(`
        <outline text="News">
          <outline title="A &amp; B" text="ignored" xmlUrl="https://a.example/feed"/>
          <outline text="  Line\n\tbreak  " xmlUrl="https://b.example/feed"/>
          <outline title="" text="" xmlUrl="https://c.example/feed"/>
        </outline>
        <outline TITLE="wrong case" xmlUrl="https://d.example/feed"/>`),
    );
    expect([...titles]).toEqual([
      [1, 'News'],
      [2, 'A & B'],
      [3, 'Line break'],
    ]);
  });

  it('bounds a long title, and gives none for markup it cannot read', () => {
    const long = 'x'.repeat(600);
    expect(outlineTitles(opml(`<outline title="${long}"/>`)).get(1)).toHaveLength(500);
    // Counted in characters: an emoji at the bound is kept whole, never half a pair.
    const emoji = outlineTitles(opml(`<outline title="${'x'.repeat(499)}\u{1F3A7}tail"/>`)).get(1);
    expect(emoji).toBe(`${'x'.repeat(499)}\u{1F3A7}`);
    expect([...outlineTitles('<opml><body><outline title="A" <broken></body></opml>')]).toEqual([]);
  });
});

describe('importRowLabel', () => {
  const row = { path: null, feed: 'https://feeds.example.com/...' };
  // A row's name as the panel gets it: read from the list (`outlineTitles`).
  const named = (title: string) =>
    outlineTitles(opml(`<outline title="${title}" xmlUrl="https://x.example/feed"/>`)).get(1) ??
    null;

  it('keeps a plain name as the list gave it', () => {
    expect(importRowLabel({ ...row, path: 'Morning' }, named('Morning Brief'))).toBe(
      'Morning Brief',
    );
  });

  it("shows the folder, else the server's label, for a name that is only an address", () => {
    const title = named('https://feeds.example.com/rss.xml');
    expect(importRowLabel({ ...row, path: 'Daily News' }, title)).toBe('Daily News');
    expect(importRowLabel(row, title)).toBe('https://feeds.example.com/...');
    expect(importRowLabel({ path: null, feed: null }, title)).toBe('https://feeds.example.com/...');
    // An address no host can be read from gives way too.
    expect(importRowLabel({ ...row, path: 'Daily News' }, named('http:///x?key=1'))).toBe(
      'Daily News',
    );
  });

  it("never shows a private feed's token", () => {
    const address = 'https://feeds.example.com/p/abc123?key=s3cr3t-token';
    for (const title of [
      address,
      `Bonus (${address})`,
      // A no-break space is part of an address to the server (Go's \S): never cut there.
      'https://feeds.example.com/p/abc\u00a0def?key=s3cr3t-token',
      'https://feeds.example.com/p/abc&#160;def?key=s3cr3t-token',
    ]) {
      for (const r of [row, { path: null, feed: null }]) {
        expect(importRowLabel(r, named(title))).not.toMatch(/s3cr3t|abc|key=/);
      }
    }
    expect(importRowLabel(row, named(`Bonus (${address})`))).toBe(
      'Bonus (https://feeds.example.com/...',
    );
  });

  it('falls back to the folder, then the label, with no name', () => {
    expect(importRowLabel({ ...row, path: 'Daily News' }, null)).toBe('Daily News');
    expect(importRowLabel(row, null)).toBe('https://feeds.example.com/...');
    expect(importRowLabel({ path: null, feed: null }, null)).toBeNull();
  });
});
