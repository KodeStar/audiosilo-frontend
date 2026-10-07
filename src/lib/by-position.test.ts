import { byPosition } from './by-position';

it('orders a book’s rows by place, ties by id, without touching the input', () => {
  const rows = [
    { id: 3, position: 50 },
    { id: 1, position: 10 },
    { id: 2, position: 50 },
  ];
  expect(byPosition(rows).map((r) => r.id)).toEqual([1, 2, 3]);
  expect(rows.map((r) => r.id)).toEqual([3, 1, 2]);
});
