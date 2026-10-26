// The reader's DRM check (`hasDrm`): font obfuscation is not DRM, anything else is.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasDrm } from '../src/epub-open.js';

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
