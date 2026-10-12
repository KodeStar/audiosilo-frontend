import { claimPageTitle, formatDocumentTitle, usePageTitleStore } from './document-title';

const title = () => usePageTitleStore.getState().claim?.title ?? null;

describe('formatDocumentTitle', () => {
  it('names the book playing first, then the page, then just the brand', () => {
    expect(formatDocumentTitle({ page: 'Library', playing: 'Project Hail Mary' })).toBe(
      '▶ Project Hail Mary · AudioSilo',
    );
    expect(formatDocumentTitle({ page: 'Library', playing: null })).toBe('Library · AudioSilo');
    expect(formatDocumentTitle({ page: '', playing: '' })).toBe('AudioSilo');
    expect(formatDocumentTitle({})).toBe('AudioSilo');
  });
});

describe('claimPageTitle', () => {
  afterEach(() => usePageTitleStore.setState({ claim: null }));

  it('sets the title and clears it on release', () => {
    const release = claimPageTitle('Dune');
    expect(title()).toBe('Dune');
    release();
    expect(title()).toBeNull();
  });

  it("doesn't let a late release clear a newer claim", () => {
    // Back from an author page: the book page's focus claims before the author's blur.
    const releaseAuthor = claimPageTitle('Frank Herbert');
    const releaseBook = claimPageTitle('Dune');
    releaseAuthor();
    expect(title()).toBe('Dune');
    releaseBook();
    expect(title()).toBeNull();
  });

  it('tells two claims with the same text apart', () => {
    // The book page and the full player over it both name "Dune".
    const releaseBook = claimPageTitle('Dune');
    const releasePlayer = claimPageTitle('Dune');
    releaseBook();
    expect(title()).toBe('Dune');
    releasePlayer();
    expect(title()).toBeNull();
  });
});
