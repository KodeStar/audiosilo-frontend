import { opmlText, outlineFeeds, rowFeedUrl } from './opml-feeds';

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
