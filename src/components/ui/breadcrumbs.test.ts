import { bookCrumbs, pathCrumbs } from './breadcrumbs';

describe('pathCrumbs', () => {
  it('links the library and each folder above the last, which is where the reader is', () => {
    const open = jest.fn();
    const crumbs = pathCrumbs('Fiction', 'Sanderson/Stormlight/01', open);
    expect(crumbs.map((c) => [c.label, !!c.active, !!c.onPress])).toEqual([
      ['Fiction', false, true],
      ['Sanderson', false, true],
      ['Stormlight', false, true],
      ['01', true, false],
    ]);
    crumbs[0].onPress!();
    crumbs[2].onPress!();
    expect(open.mock.calls).toEqual([[''], ['Sanderson/Stormlight']]);
  });

  it('is the library alone, active, at its root', () => {
    expect(pathCrumbs('Fiction', '', jest.fn())).toEqual([
      { label: 'Fiction', active: true, onPress: undefined },
    ]);
  });
});

describe('bookCrumbs', () => {
  it("names the last crumb by the book's title and keeps the folder links", () => {
    const open = jest.fn();
    const crumbs = bookCrumbs(
      'Books',
      "Corey/The Expanse/02 - Caliban's War",
      "Caliban's War",
      open,
    );
    expect(crumbs.map((c) => [c.label, !!c.active, !!c.onPress])).toEqual([
      ['Books', false, true],
      ['Corey', false, true],
      ['The Expanse', false, true],
      ["Caliban's War", true, false],
    ]);
    crumbs[2].onPress!();
    expect(open).toHaveBeenCalledWith('Corey/The Expanse');
  });

  it('keeps the folder name without a title, and the library alone at the root', () => {
    expect(bookCrumbs('Books', 'A/B', '', jest.fn()).map((c) => c.label)).toEqual([
      'Books',
      'A',
      'B',
    ]);
    expect(bookCrumbs('Books', '', 'T', jest.fn()).map((c) => c.label)).toEqual(['Books']);
  });
});
