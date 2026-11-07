import { ebookSha256 } from './ebook-identity';

it('identifies the actual EPUB bytes by their SHA-256, including equal-size editions', () => {
  const first = new Uint8Array([97, 98, 99]).buffer;
  const second = new Uint8Array([97, 98, 100]).buffer;
  expect(ebookSha256(first)).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  expect(ebookSha256(second)).not.toBe(ebookSha256(first));
});
