// An in-memory file tree standing in for expo-file-system's File/Directory (the calls the
// engine's `moveConnection` makes: exists, list, move, delete, name), with the module's move
// rule: into an EXISTING directory it lands inside it, else it takes the destination's name.
const mockTree = new Map<string, 'dir' | string>(); // uri -> 'dir' or file content
const mockFailMove = { uri: null as string | null };
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]) =>
    parts
      .map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri))
      .join('/')
      .replace(/\/+$/, '');
  const leaf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
  class Entry {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get name() {
      return leaf(this.uri);
    }
    delete() {
      for (const k of [...mockTree.keys()]) {
        if (k === this.uri || k.startsWith(`${this.uri}/`)) mockTree.delete(k);
      }
    }
    async move(to: Entry) {
      if (mockFailMove.uri === this.uri) throw new Error(`cannot move ${this.uri}`);
      const dest = mockTree.get(to.uri) === 'dir' ? `${to.uri}/${this.name}` : to.uri;
      for (const [k, v] of [...mockTree.entries()]) {
        if (k === this.uri || k.startsWith(`${this.uri}/`)) {
          mockTree.delete(k);
          mockTree.set(dest + k.slice(this.uri.length), v);
        }
      }
      this.uri = dest;
    }
  }
  class MockFile extends Entry {
    get exists() {
      const v = mockTree.get(this.uri);
      return v !== undefined && v !== 'dir';
    }
  }
  class MockDirectory extends Entry {
    get exists() {
      return mockTree.get(this.uri) === 'dir';
    }
    list() {
      return [...mockTree.entries()]
        .filter(
          ([k]) => k.startsWith(`${this.uri}/`) && !k.slice(this.uri.length + 1).includes('/'),
        )
        .map(([k, v]) => (v === 'dir' ? new MockDirectory(k) : new MockFile(k)));
    }
  }
  return { File: MockFile, Directory: MockDirectory, Paths: { document: 'file:///docs' } };
});

/* eslint-disable import/first */
import { engine } from './engine.native';
/* eslint-enable import/first */

const ROOT = 'file:///docs/downloads';

/** Seed files (and every folder above them) under the downloads root. */
function seed(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++)
      mockTree.set(`${ROOT}/${parts.slice(0, i).join('/')}`, 'dir');
    mockTree.set(`${ROOT}/${rel}`, content);
  }
  mockTree.set(ROOT, 'dir');
}

/** Every file under the root, relative, with its content. */
const files = () =>
  Object.fromEntries(
    [...mockTree.entries()]
      .filter(([, v]) => v !== 'dir')
      .map(([k, v]) => [k.slice(ROOT.length + 1), v]),
  );

beforeEach(() => {
  mockTree.clear();
  mockFailMove.uri = null;
});

describe('engine.native moveConnection', () => {
  it("renames the connection's folder: every book, cover and text file follows", async () => {
    seed({
      'srv/1/Book-abc/0.mp3': 'a',
      'srv/1/Book-abc/cover.jpg': 'c',
      'srv/1/Book-abc/meta.json': 'm',
      'srv/2/Other-def/0.m4b': 'o',
      'keep/1/X-1/0.mp3': 'k',
    });
    await engine.moveConnection!('srv', 'srv.3');
    expect(files()).toEqual({
      'srv.3/1/Book-abc/0.mp3': 'a',
      'srv.3/1/Book-abc/cover.jpg': 'c',
      'srv.3/1/Book-abc/meta.json': 'm',
      'srv.3/2/Other-def/0.m4b': 'o',
      'keep/1/X-1/0.mp3': 'k',
    });
    expect(mockTree.has(`${ROOT}/srv`)).toBe(false);
    // The engine's own uris for the new id find them.
    expect(engine.localUri!('srv.3', 1, 'Book', '0.mp3')).toMatch(
      /^file:\/\/\/docs\/downloads\/srv\.3\/1\//,
    );
  });

  it('is a no-op when there is nothing under the old id (moved already, or no downloads)', async () => {
    seed({ 'srv.3/1/B-1/0.mp3': 'a' });
    await engine.moveConnection!('srv', 'srv.3');
    await engine.moveConnection!('srv', 'srv.3');
    expect(files()).toEqual({ 'srv.3/1/B-1/0.mp3': 'a' });
  });

  it('finishes a run cut short: merges what the new folder lacks, keeps what it has, drops the old', async () => {
    seed({
      'srv/1/A-1/0.mp3': 'old-a',
      'srv/1/B-2/0.mp3': 'b',
      'srv/2/C-3/0.mp3': 'c',
      'srv.3/1/A-1/0.mp3': 'moved-a',
    });
    await engine.moveConnection!('srv', 'srv.3');
    expect(files()).toEqual({
      'srv.3/1/A-1/0.mp3': 'moved-a',
      'srv.3/1/B-2/0.mp3': 'b',
      'srv.3/2/C-3/0.mp3': 'c',
    });
    expect(mockTree.has(`${ROOT}/srv`)).toBe(false);
  });

  it('rejects when the folder cannot move, leaving it where it was', async () => {
    seed({ 'srv/1/A-1/0.mp3': 'a' });
    mockFailMove.uri = `${ROOT}/srv`;
    await expect(engine.moveConnection!('srv', 'srv.3')).rejects.toThrow(/cannot move/);
    expect(files()).toEqual({ 'srv/1/A-1/0.mp3': 'a' });
  });

  it('moving back is the same call reversed', async () => {
    seed({ 'srv/1/A-1/0.mp3': 'a' });
    await engine.moveConnection!('srv', 'srv.3');
    await engine.moveConnection!('srv.3', 'srv');
    expect(files()).toEqual({ 'srv/1/A-1/0.mp3': 'a' });
  });
});

describe('engine.native renameFile', () => {
  const book = `${ROOT}/srv/1/Book-abc`;

  it('renames a stored file in its folder', async () => {
    seed({ 'srv/1/Book-abc/0.mka': 'mp3 bytes' });
    await expect(engine.renameFile!(`${book}/0.mka`, '0.mp3')).resolves.toBe(true);
    expect(files()).toEqual({ 'srv/1/Book-abc/0.mp3': 'mp3 bytes' });
  });

  it('never replaces a file already under the new name', async () => {
    seed({ 'srv/1/Book-abc/0.mka': 'old', 'srv/1/Book-abc/0.mp3': 'new' });
    await expect(engine.renameFile!(`${book}/0.mka`, '0.mp3')).resolves.toBe(false);
    expect(files()).toEqual({ 'srv/1/Book-abc/0.mka': 'old', 'srv/1/Book-abc/0.mp3': 'new' });
  });

  it('resolves false when the file is missing or cannot move, leaving it as it was', async () => {
    seed({ 'srv/1/Book-abc/1.mka': 'x' });
    await expect(engine.renameFile!(`${book}/0.mka`, '0.mp3')).resolves.toBe(false);
    mockFailMove.uri = `${book}/1.mka`;
    await expect(engine.renameFile!(`${book}/1.mka`, '1.mp3')).resolves.toBe(false);
    expect(files()).toEqual({ 'srv/1/Book-abc/1.mka': 'x' });
  });
});
