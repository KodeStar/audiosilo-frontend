import type { Collection, CollectionItem } from '@/api/types';

import {
  collectionGrid,
  moveIndex,
  nameList,
  ownCollections,
  sharedIds,
  shareLine,
  toggleId,
  totalDuration,
  validName,
} from './collections-model';

const collection = (over: Partial<Collection> = {}): Collection => ({
  id: 1,
  name: 'Road trip',
  description: '',
  owner: { id: 1, username: 'alex' },
  owned: true,
  shared_with: [],
  item_count: 0,
  preview: [],
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('validName', () => {
  it('takes 1-100 characters once trimmed', () => {
    expect(validName('  ')).toBe(false);
    expect(validName(' Road trip ')).toBe(true);
    expect(validName('x'.repeat(100))).toBe(true);
    expect(validName('x'.repeat(101))).toBe(false);
  });
});

describe('shareLine', () => {
  it('names who an own collection is shared with', () => {
    expect(
      shareLine(
        collection({
          shared_with: [
            { id: 2, username: 'sam' },
            { id: 3, username: 'maya' },
          ],
        }),
      ),
    ).toEqual({ kind: 'sharedWith', names: ['sam', 'maya'] });
  });

  it('says nothing for a private one', () => {
    expect(shareLine(collection())).toBeNull();
    expect(shareLine(collection({ shared_with: undefined }))).toBeNull();
  });

  it('names the owner of one shared with the listener', () => {
    expect(
      shareLine(
        collection({ owned: false, owner: { id: 2, username: 'sam' }, shared_with: undefined }),
      ),
    ).toEqual({ kind: 'sharedBy', name: 'sam' });
  });
});

describe('nameList', () => {
  it('joins up to two names and counts the rest', () => {
    expect(nameList(['sam'])).toEqual({ names: 'sam', more: 0 });
    expect(nameList(['sam', 'maya', 'leo', 'ana'])).toEqual({ names: 'sam, maya', more: 2 });
  });
});

describe('moveIndex', () => {
  it('moves one place within the visible list, never past an end', () => {
    expect(moveIndex(1, -1, 3)).toBe(0);
    expect(moveIndex(1, 1, 3)).toBe(2);
    expect(moveIndex(0, -1, 3)).toBeNull();
    expect(moveIndex(2, 1, 3)).toBeNull();
  });
});

describe('the rest', () => {
  it('sums the indexed books', () => {
    const item = (duration?: number): CollectionItem => ({
      library_id: 1,
      path: 'p',
      added_at: '',
      book: duration === undefined ? undefined : ({ duration } as CollectionItem['book']),
    });
    expect(totalDuration([item(100), item(), item(50)])).toBe(150);
  });

  it('toggles a share selection', () => {
    expect(toggleId([2, 3], 2)).toEqual([3]);
    expect(toggleId([3], 2)).toEqual([3, 2]);
  });

  it('keeps own collections only, and reads the shared ids', () => {
    const own = collection({ id: 1, shared_with: [{ id: 5, username: 'sam' }] });
    const theirs = collection({ id: 2, owned: false });
    expect(ownCollections([own, theirs])).toEqual([own]);
    expect(ownCollections(undefined)).toEqual([]);
    expect(sharedIds(own)).toEqual([5]);
  });

  it('lays out one card per row on a phone, else cards of at least 260', () => {
    expect(collectionGrid(368, 'phone')).toEqual({ columns: 1, card: 368, gap: 18 });
    expect(collectionGrid(1300, 'desktop').columns).toBe(4);
    expect(collectionGrid(200, 'tablet')).toEqual({ columns: 1, card: 200, gap: 18 });
  });
});
