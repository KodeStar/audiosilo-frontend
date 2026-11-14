import {
  blankRow,
  canAddRow,
  draftOf,
  draftProblems,
  draftToSet,
  proxyOriginChoices,
} from './proxy-headers-model';

const SET = {
  origin: 'https://books.example.com',
  headers: [{ name: 'X-Auth', value: 'proxy-secret' }],
};

describe('proxy headers draft (fe#167)', () => {
  it('loads a stored set with its values hidden, kept unless a new one is typed', () => {
    const rows = draftOf(SET);
    expect(rows).toEqual([
      expect.objectContaining({ name: 'X-Auth', value: '', stored: 'proxy-secret' }),
    ]);
    expect(draftToSet(SET.origin, rows)).toEqual(SET);
    expect(draftToSet(SET.origin, [{ ...rows[0], value: 'new' }])?.headers[0].value).toBe('new');
  });

  it('starts empty with one blank row, and drops blank rows', () => {
    expect(draftOf(null)).toHaveLength(1);
    expect(draftToSet(SET.origin, [blankRow()])).toBeNull();
    expect(draftProblems([blankRow()])).toEqual([null]);
  });

  it("names each row's problem", () => {
    const rows = [
      { ...blankRow(), name: 'Cookie', value: 'x' },
      { ...blankRow(), name: 'X-A', value: '' },
      blankRow(),
      { ...blankRow(), name: 'X-B', value: 'ok' },
      { ...blankRow(), name: 'x-b', value: 'ok' },
    ];
    expect(draftProblems(rows)).toEqual(['reserved', 'value', null, null, 'duplicate']);
  });

  it('caps the rows', () => {
    expect(canAddRow(Array.from({ length: 7 }, blankRow))).toBe(true);
    expect(canAddRow(Array.from({ length: 8 }, blankRow))).toBe(false);
  });

  it('offers the current origin, then away, the paired address and home, once each', () => {
    expect(
      proxyOriginChoices({
        serverUrl: 'https://books.example.com/',
        addresses: { home: 'https://nas.home.example:8443', away: 'https://books.example.com' },
      }),
    ).toEqual(['https://books.example.com', 'https://nas.home.example:8443']);
    expect(
      proxyOriginChoices({
        serverUrl: 'https://a.example',
        proxyHeaders: { ...SET, origin: 'https://b.example' },
      }),
    ).toEqual(['https://b.example', 'https://a.example']);
  });

  it('never offers a plain-http address (headers are never sent over http)', () => {
    expect(
      proxyOriginChoices({
        serverUrl: 'http://192.168.1.5:8080',
        addresses: { home: 'http://192.168.1.5:8080', away: 'https://books.example.com' },
      }),
    ).toEqual(['https://books.example.com']);
    expect(proxyOriginChoices({ serverUrl: 'http://192.168.1.5:8080' })).toEqual([]);
  });
});
