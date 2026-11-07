import { serverDisplayName } from './server-display-name';

const home = { id: 'home.1', name: 'AudioSilo', serverUrl: 'https://home.example' };
const away = { id: 'away.1', name: 'AudioSilo', serverUrl: 'https://away.example:8443' };

describe('serverDisplayName', () => {
  it('distinguishes same-name servers by host and port without changing their identities', () => {
    const connections = [home, away];
    expect(serverDisplayName(home, connections)).toBe('AudioSilo (home.example)');
    expect(serverDisplayName(away, connections)).toBe('AudioSilo (away.example:8443)');
    expect(connections.map((c) => c.id)).toEqual(['home.1', 'away.1']);
    expect(home.name).toBe('AudioSilo');
  });

  it('keeps a unique name unchanged', () => {
    const unique = { ...away, name: 'Library' };
    expect(serverDisplayName(home, [home, unique])).toBe('AudioSilo');
    expect(serverDisplayName(unique, [home, unique])).toBe('Library');
  });

  it('ignores multiple accounts on one server, including a legacy connection id', () => {
    const anotherUser = { ...home, id: 'home.2', serverUrl: 'http://192.168.1.5:8080' };
    const legacy = { ...home, id: 'old', serverId: 'home' };
    expect(serverDisplayName(home, [home, anotherUser, legacy])).toBe('AudioSilo');
    expect(serverDisplayName(anotherUser, [home, anotherUser, away])).toBe(
      'AudioSilo (192.168.1.5:8080)',
    );
  });

  it('keeps a long host intact so accessible labels can identify it', () => {
    const host = `${'a'.repeat(63)}.${'b'.repeat(63)}.books.example:8443`;
    const long = { ...away, serverUrl: `https://${host}/audiosilo` };
    expect(serverDisplayName(long, [home, long])).toBe(`AudioSilo (${host})`);
  });

  it('uses the full address when colliding servers share a host', () => {
    const otherPath = { ...away, serverUrl: 'https://home.example/other/' };
    expect(serverDisplayName(home, [home, otherPath])).toBe('AudioSilo (https://home.example)');
    expect(serverDisplayName(otherPath, [home, otherPath])).toBe(
      'AudioSilo (https://home.example/other)',
    );
  });
});
