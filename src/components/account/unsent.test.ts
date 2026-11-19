import i18n from '@/i18n';

import { signOutUnsentCopy, unsentLines } from './unsent';

// What a sign-out or removal would lose, in words (fe#356: the waiting bookmarks too).
const t = i18n.t.bind(i18n);

describe('unsentLines', () => {
  it('says nothing when everything synced', () => {
    expect(unsentLines(t, { listens: 0, bookmarks: 0 }, 'Home')).toEqual([]);
  });

  it('names listens and bookmarks, each in its own sentence', () => {
    expect(unsentLines(t, { listens: 1, bookmarks: 3 }, 'Home')).toEqual([
      "1 listen hasn't synced to Home and will be lost.",
      "3 bookmarks haven't synced to Home and will be lost.",
    ]);
  });
});

describe('signOutUnsentCopy', () => {
  it('keeps the listens-only words', () => {
    expect(signOutUnsentCopy(t, { listens: 2, bookmarks: 0 }, 'Home')).toEqual({
      title: 'Listens not synced',
      message: "2 listens haven't synced to Home. Sign out anyway?",
    });
  });

  it('names the bookmarks, then asks', () => {
    expect(signOutUnsentCopy(t, { listens: 0, bookmarks: 1 }, 'Home')).toEqual({
      title: 'Not synced yet',
      message: "1 bookmark hasn't synced to Home and will be lost. Sign out anyway?",
    });
  });
});
