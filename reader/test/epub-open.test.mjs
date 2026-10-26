// The reader's DRM check (`hasDrm`): font obfuscation is not DRM, anything else is. And the
// SHA-1 that undoes IDPF font obfuscation where `crypto.subtle` is missing (plain HTTP).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { hasDrm, sha1 } from '../src/epub-open.js';

test('sha1 matches the standard digest, across block boundaries and in UTF-8', () => {
  for (const text of [
    '',
    'abc',
    'urn:uuid:12345678-1234-1234-1234-123456789abc',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(119),
    'x'.repeat(120),
    'isbn:978-0-00-000000-0 Ünïcödé 書 🙂',
  ]) {
    assert.equal(
      [...sha1(text)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      createHash('sha1').update(text, 'utf8').digest('hex'),
      `sha1 of ${JSON.stringify(text)}`,
    );
  }
});

const encryption = (...algorithms) => `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"
  xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
${algorithms
  .map(
    (a) => `  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="${a}"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/x"/></enc:CipherData>
  </enc:EncryptedData>`,
  )
  .join('\n')}
</encryption>`;

test('no encryption.xml is no DRM', () => {
  assert.equal(hasDrm(null), false);
  assert.equal(hasDrm(''), false);
});

test('font obfuscation (IDPF, Adobe) is not DRM', () => {
  assert.equal(
    hasDrm(encryption('http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC')),
    false,
  );
});

test('encrypted content is DRM', () => {
  assert.equal(hasDrm(encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc')), true);
  assert.equal(
    hasDrm(
      encryption(
        'http://www.idpf.org/2008/embedding',
        'http://www.w3.org/2001/04/xmlenc#aes256-cbc',
      ),
    ),
    true,
  );
});

test('an unprefixed EncryptionMethod counts too', () => {
  assert.equal(
    hasDrm('<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>'),
    true,
  );
});
