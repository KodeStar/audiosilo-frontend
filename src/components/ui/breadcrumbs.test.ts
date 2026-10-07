import { pathCrumbs } from './breadcrumbs';

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
