import { narrowPageEdges } from './page-edge';

describe('narrowPageEdges', () => {
  it("judges by the reader's own width once measured (fe#165)", () => {
    // The desktop companion's 420 column is phone-narrow, whatever the window.
    expect(narrowPageEdges(420, false)).toBe(true);
    expect(narrowPageEdges(900, true)).toBe(false);
  });
  it("judges by the window's layout before then", () => {
    expect(narrowPageEdges(null, true)).toBe(true);
    expect(narrowPageEdges(null, false)).toBe(false);
  });
});
