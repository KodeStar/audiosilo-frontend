import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_EBOOK_BYTES } from './ebook-errors';

it("refuses a book at the reader document's own limit, not another", () => {
  const chunks = readFileSync(join(__dirname, '../../reader/src/chunks.js'), 'utf8');
  const m = /export const MAX_BOOK_BYTES = ([\d\s*]+);/.exec(chunks);
  expect(m).not.toBeNull();
  const reader = m![1].split('*').reduce((n, f) => n * Number(f.trim()), 1);
  expect(MAX_EBOOK_BYTES).toBe(reader);
});
