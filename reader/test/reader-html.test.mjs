// The built reader document (public/reader.html, `npm run reader:build`): one inline script
// allowed by its hash, no subresources, and no network (the server sends the same policy
// with `frame-ancestors 'self'` and its own hash of the script).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../../public/reader.html', import.meta.url), 'utf8');
const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
const directives = new Map(
  (policy ?? '').split(';').map((d) => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, values.join(' ')];
  }),
);

test('one inline script, no external script, stylesheet or other subresource', () => {
  assert.equal(html.match(/<script\b/g)?.length, 1);
  assert.doesNotMatch(html, /<script[^>]*\bsrc=/);
  assert.doesNotMatch(html, /<link\b/);
});

test('the meta CSP allows exactly that script, by its sha256', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const hash = createHash('sha256').update(script).digest('base64');
  assert.equal(directives.get('script-src'), `'sha256-${hash}'`);
});

test('the policy is the reader recipe: no network, no plugins, no base or forms', () => {
  assert.equal(directives.get('default-src'), "'none'");
  assert.equal(directives.get('connect-src'), "'none'");
  assert.equal(directives.get('media-src'), "'none'");
  assert.equal(directives.get('object-src'), "'none'");
  assert.equal(directives.get('base-uri'), "'none'");
  assert.equal(directives.get('form-action'), "'none'");
  assert.equal(directives.get('frame-src'), 'blob:');
  assert.equal(directives.get('img-src'), 'blob: data:');
  assert.equal(directives.get('font-src'), 'blob: data:');
  assert.equal(directives.get('style-src'), "'unsafe-inline' blob:");
  assert.doesNotMatch(policy, /unsafe-eval|https?:|'self'/);
});
