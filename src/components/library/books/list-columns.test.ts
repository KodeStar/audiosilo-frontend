import { listColumns } from './list-columns';

describe('listColumns', () => {
  it("follows the list's width, not the window's", () => {
    expect(listColumns('phone', 0)).toBe('none');
    expect(listColumns('desktop', 0)).toBe('all');
    expect(listColumns('desktop', 1312)).toBe('all');
    // A 1024 desktop with the Up next drawer open: a 600 list keeps the title room.
    expect(listColumns('desktop', 600)).toBe('some');
    expect(listColumns('tablet', 770)).toBe('some');
    expect(listColumns('desktop', 480)).toBe('none');
  });
});
