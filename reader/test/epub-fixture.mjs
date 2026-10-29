// Test helpers for read-along on a real EPUB (reader/test/fixtures, copied from
// audiosilo-bridge): the EPUB unzipped with node:zlib, its OPF and sections parsed by
// jsdom (`application/xhtml+xml`, as foliate loads them), foliate's section CFIs made as
// epub.js makes them (`CFI.fromElements` over the spine's itemrefs), and a small stand-in
// for foliate's View that pages through those documents.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

import { JSDOM } from 'jsdom';

import * as CFI from '../vendor/foliate-js/epubcfi.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

/** The entries of a zip file, by name, as Buffers (stored or deflated). */
export function unzip(bytes) {
  let eocd = bytes.length - 22;
  while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(dataAt, dataAt + size);
    files.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

/** The fixture book: its window (for Range, events), its spine sections (href relative to
 * the OPF, foliate's section CFI, the parsed document) and the Bridge's map for it. */
export function loadAlice() {
  const files = unzip(readFileSync(fixture('alice.epub')));
  const { window } = new JSDOM('');
  const xml = (name, type) =>
    new window.DOMParser().parseFromString(files.get(name).toString('utf8'), type);
  const container = xml('META-INF/container.xml', 'application/xml');
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const base = opfPath.slice(0, opfPath.lastIndexOf('/') + 1);
  const opf = xml(opfPath, 'application/xml');
  const items = new Map(
    [...opf.getElementsByTagName('item')].map((i) => [i.getAttribute('id'), i]),
  );
  const itemrefs = [...opf.getElementsByTagName('itemref')];
  const cfis = CFI.fromElements(itemrefs);
  const sections = itemrefs.map((ref, index) => {
    const href = items.get(ref.getAttribute('idref')).getAttribute('href');
    const doc = new JSDOM(files.get(base + href).toString('utf8'), {
      contentType: 'application/xhtml+xml',
    }).window.document;
    return { index, href, cfi: cfis[index], doc };
  });
  const map = JSON.parse(readFileSync(fixture('alice.readalong.json'), 'utf8'));
  return { window, sections, map };
}

/** foliate's View.resolveCFI without a package document (view.js's fallback; epub.js's own
 * checks the itemref's id too, which these CFIs leave out). */
export function resolveCFI(cfi) {
  const parts = CFI.parse(cfi);
  const index = CFI.fake.toIndex((parts.parent ?? parts).shift());
  return { index, anchor: (doc) => CFI.toRange(doc, parts) };
}

/**
 * A stand-in for foliate's View over the fixture's documents. A "page" is `perPage` spans
 * of the shown section from the one gone to (or a Range given to `show`): `goTo` a span's
 * CFI shows its page, `next` the following one; each says `relocate` on the renderer as
 * the paginator does (`reason`, `range`, `index`). Annotations are recorded.
 */
export function fakeView(book, spansOf, { perPage = 3 } = {}) {
  const { window, sections } = book;
  const renderer = new window.EventTarget();
  const view = new window.EventTarget();
  let shown = null; // { index, first }: the section and the first span of the page
  const annotations = [];
  const calls = [];
  const rangeOfSpan = (index, k) => resolveCFI(spansOf(index)[k].cfi).anchor(sections[index].doc);
  const pageRange = (index, first) => {
    const spans = spansOf(index);
    const last = Math.min(spans.length - 1, first + perPage - 1);
    const r = sections[index].doc.createRange();
    const a = rangeOfSpan(index, first);
    const b = rangeOfSpan(index, last);
    r.setStart(a.startContainer, a.startOffset);
    r.setEnd(b.endContainer, b.endOffset);
    return r;
  };
  const relocate = (reason, range, index) =>
    renderer.dispatchEvent(
      new window.CustomEvent('relocate', { detail: { reason, range, index } }),
    );
  Object.assign(view, {
    book: { sections: sections.map((s) => ({ cfi: s.cfi })) },
    renderer: Object.assign(renderer, {
      getContents: () => (shown ? [{ index: shown.index, doc: sections[shown.index].doc }] : []),
    }),
    lastLocation: null,
    annotations,
    calls,
    resolveCFI,
    getCFI: (index, range) => CFI.joinIndir(sections[index].cfi, CFI.fromRange(range)),
    async goTo(target) {
      calls.push(['goTo', target]);
      const { index } = resolveCFI(target);
      const k = spansOf(index).findIndex((s) => s.cfi === target);
      if (k < 0) return;
      const loaded = shown?.index === index;
      shown = { index, first: k };
      if (!loaded) {
        view.dispatchEvent(
          new window.CustomEvent('load', { detail: { doc: sections[index].doc, index } }),
        );
      }
      relocate('navigation', pageRange(index, k), index);
    },
    async next() {
      calls.push(['next']);
      shown = { index: shown.index, first: shown.first + perPage };
      relocate('page', pageRange(shown.index, shown.first), shown.index);
    },
    /** A page the person turned to (`reason` page), from the span `first`. */
    turnTo(index, first) {
      shown = { index, first };
      relocate('page', pageRange(index, first), index);
    },
    /** The page shown is `range` (a relayout, or a page ending mid-sentence). */
    show(index, range, reason = 'page') {
      relocate(reason, range, index);
    },
    async addAnnotation({ value }) {
      calls.push(['add', value]);
      annotations.push(value);
      return { index: resolveCFI(value).index };
    },
    async deleteAnnotation({ value }) {
      calls.push(['delete', value]);
      annotations.splice(annotations.indexOf(value), 1);
    },
  });
  return { view, rangeOfSpan, pageRange };
}
