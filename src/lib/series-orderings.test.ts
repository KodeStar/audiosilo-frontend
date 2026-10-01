import type { BookMetaSeries } from '@/api/types';

import {
  familyKey,
  familyName,
  orderingLabelKey,
  parsePicks,
  selectedView,
  seriesViews,
  viewHoldsWork,
} from './series-orderings';

function work(id: string, position: string) {
  return { id, title: id, position, authors: [], web_url: `https://m/work?id=${id}` };
}

// A primary (publication order) whose family also has a chronological variant -
// the server's collapsed rail as seen from a book the primary places.
const primaryRail: BookMetaSeries = {
  id: 'narnia',
  name: 'The Chronicles of Narnia',
  position: '1',
  ordering: 'publication',
  works: [work('lion', '1'), work('caspian', '2')],
  orderings: [
    {
      id: 'narnia-chronological',
      name: 'The Chronicles of Narnia (Chronological)',
      ordering: 'chronological',
      ordering_of: 'narnia',
      position: '2',
      works: [work('nephew', '1'), work('lion', '2')],
    },
  ],
};

// The same family seen from a book only the chronological variant places: the main
// view IS the variant, and it names the family's primary in `ordering_of`.
const variantRail: BookMetaSeries = {
  id: 'narnia-chronological',
  name: 'The Chronicles of Narnia (Chronological)',
  position: '0.5',
  ordering: 'chronological',
  ordering_of: 'narnia',
  works: [work('prequel', '0.5'), work('nephew', '1')],
  orderings: [
    {
      id: 'narnia',
      name: 'The Chronicles of Narnia',
      ordering: 'publication',
      works: [work('lion', '1')],
    },
  ],
};

// An older server: no ordering fields at all.
const plain: BookMetaSeries = { id: 'solo', name: 'Solo', position: '2', works: [work('a', '1')] };

describe('familyKey', () => {
  it('is the primary id for every member of a family', () => {
    expect(familyKey(primaryRail)).toBe('narnia');
    expect(familyKey(variantRail)).toBe('narnia');
  });

  it('is the series id when the server sends no ordering data', () => {
    expect(familyKey(plain)).toBe('solo');
  });
});

describe('seriesViews', () => {
  it('is just the main view for a series with no alternates', () => {
    const views = seriesViews(plain);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: 'solo', position: '2' });
  });

  it('lists the primary first, then the variants', () => {
    expect(seriesViews(primaryRail).map((v) => v.id)).toEqual(['narnia', 'narnia-chronological']);
  });

  it('keeps family order on a variant-only book, whose main view is a variant', () => {
    expect(seriesViews(variantRail).map((v) => v.id)).toEqual(['narnia', 'narnia-chronological']);
  });

  it('orders several variants by id, as metaserve does', () => {
    const s: BookMetaSeries = {
      ...primaryRail,
      orderings: [
        { id: 'z-variant', name: 'Z', ordering: 'recommended', ordering_of: 'narnia', works: [] },
        { id: 'a-variant', name: 'A', ordering: 'chronological', ordering_of: 'narnia', works: [] },
      ],
    };
    expect(seriesViews(s).map((v) => v.id)).toEqual(['narnia', 'a-variant', 'z-variant']);
  });

  it("normalizes an alternate's absent position to empty", () => {
    const alt = seriesViews(variantRail).find((v) => v.id === 'narnia');
    expect(alt?.position).toBe('');
  });

  it('drops an alternate repeating the main view or another alternate', () => {
    const s: BookMetaSeries = {
      ...primaryRail,
      orderings: [
        { id: 'narnia', name: 'dup of main', works: [] },
        primaryRail.orderings![0],
        primaryRail.orderings![0],
      ],
    };
    expect(seriesViews(s).map((v) => v.id)).toEqual(['narnia', 'narnia-chronological']);
  });
});

describe('selectedView', () => {
  it('is the main view with no pick', () => {
    expect(selectedView(primaryRail, {}).id).toBe('narnia');
    expect(selectedView(variantRail, {}).id).toBe('narnia-chronological');
  });

  it('honours the pick remembered for the family', () => {
    const picks = { narnia: 'narnia-chronological' };
    expect(selectedView(primaryRail, picks).id).toBe('narnia-chronological');
  });

  it('applies one family pick to every book of the family', () => {
    const picks = { narnia: 'narnia' };
    expect(selectedView(variantRail, picks).id).toBe('narnia');
  });

  it('falls back to the main view on a stale or unknown pick', () => {
    expect(selectedView(primaryRail, { narnia: 'gone' }).id).toBe('narnia');
    expect(selectedView(plain, { solo: 'narnia' }).id).toBe('solo');
  });

  it("ignores another family's pick", () => {
    expect(selectedView(plain, { narnia: 'narnia-chronological' }).id).toBe('solo');
  });
});

describe('viewHoldsWork', () => {
  it('is true when the view states a position or lists the work', () => {
    const [pub, chron] = seriesViews(primaryRail);
    expect(viewHoldsWork(pub, 'lion')).toBe(true);
    expect(viewHoldsWork(chron, 'lion')).toBe(true);
  });

  it('is false for an order the work is not part of', () => {
    const pub = seriesViews(variantRail).find((v) => v.id === 'narnia')!;
    expect(viewHoldsWork(pub, 'prequel')).toBe(false);
  });
});

describe('orderingLabelKey', () => {
  it('maps each known ordering to its translation key', () => {
    expect(orderingLabelKey('publication')).toBe('book.meta.ordering.publication');
    expect(orderingLabelKey('chronological')).toBe('book.meta.ordering.chronological');
    expect(orderingLabelKey('recommended')).toBe('book.meta.ordering.recommended');
  });

  it('is undefined when unset or unrecognised (the caller uses the series name)', () => {
    expect(orderingLabelKey(undefined)).toBeUndefined();
    expect(orderingLabelKey('alphabetical')).toBeUndefined();
    expect(orderingLabelKey('toString')).toBeUndefined();
  });
});

describe('familyName', () => {
  it("is the primary's name, whichever view is main", () => {
    expect(familyName(primaryRail)).toBe('The Chronicles of Narnia');
    expect(familyName(variantRail)).toBe('The Chronicles of Narnia');
  });

  it("is the main view's name when the family's primary is not carried", () => {
    const s: BookMetaSeries = { ...variantRail, orderings: [] };
    expect(familyName(s)).toBe('The Chronicles of Narnia (Chronological)');
  });
});

describe('parsePicks', () => {
  it('keeps string -> string entries only', () => {
    expect(parsePicks({ narnia: 'narnia-chronological', bad: 3, empty: '' })).toEqual({
      narnia: 'narnia-chronological',
    });
  });

  it('is empty for anything that is not an object of picks', () => {
    expect(parsePicks(null)).toEqual({});
    expect(parsePicks('narnia')).toEqual({});
    expect(parsePicks(['narnia'])).toEqual({});
  });
});
