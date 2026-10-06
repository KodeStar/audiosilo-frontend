import { bookPanes } from './book-panes';

describe('bookPanes', () => {
  it('stacks on a phone, and on a desktop page the Up next drawer leaves narrow', () => {
    expect(bookPanes('phone', 0)).toBeNull();
    // 1024 less a 360 drawer.
    expect(bookPanes('desktop', 664)).toBeNull();
    expect(bookPanes('tablet', 700)).toBeNull();
  });

  it('gives the desktop cover panel 380 only where the page has room for it', () => {
    expect(bookPanes('desktop', 0)).toEqual({ panel: 380 });
    expect(bookPanes('desktop', 1376)).toEqual({ panel: 380 });
    expect(bookPanes('desktop', 920)).toEqual({ panel: 300 });
    expect(bookPanes('tablet', 834)).toEqual({ panel: 300 });
  });
});
