import type { Connection } from '@/stores/session';

import { adminConnection, adminConsoleUrl } from './admin-console';

describe('adminConsoleUrl', () => {
  it('builds the console and its setup flow from the server address', () => {
    expect(adminConsoleUrl('https://h:8080')).toBe('https://h:8080/admin');
    expect(adminConsoleUrl('https://h:8080/', 'setup')).toBe('https://h:8080/admin/setup');
  });
});

describe('adminConnection', () => {
  const conn = (id: string, role: 'admin' | 'user') =>
    ({ id, user: { id: 1, username: id, role } }) as unknown as Connection;
  const list = [conn('a', 'user'), conn('b', 'admin'), conn('c', 'admin')];

  it("finds the first connection signed in as the server's admin", () => {
    expect(adminConnection(list)?.id).toBe('b');
  });

  it('looks only at the given connections', () => {
    expect(adminConnection(list, ['a', 'c'])?.id).toBe('c');
    expect(adminConnection(list, ['a'])).toBeUndefined();
  });
});
