/**
 * @jest-environment node
 */
// Wire parity (audiosilo#96, server#347): the server's goldens, one JSON shape
// per player envelope (audiosilo-server internal/api/testdata/wire/, copied into
// __wire__/ by `npm run wire:sync`), checked against the hand-mirrored types in
// types.ts, read with the TypeScript compiler. A type's required field the
// server does not send, a field sent with a JSON type the type does not allow,
// and a field the server sends that the type does not know all fail, so a
// rename or drop on either side fails here instead of shipping.
//
// A field the player deliberately does not read goes in UNMIRRORED with why.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const WIRE_DIR = path.join(__dirname, '__wire__');
const PROBE = path.join(__dirname, '__wire_probe__.ts');

// Each golden's type: the expression `client.ts` reads the answer as (T. is
// types.ts).
const ENVELOPES: Record<string, string> = {
  server: 'T.ServerInfo',
  'server-anonymous': 'T.ServerInfo',
  'auth-redeem': 'T.PairingPayload',
  'auth-exchange': 'T.AuthSession',
  me: 'T.User',
  libraries: '{ libraries: T.Library[] }',
  fs: 'T.Listing',
  books: 'T.BookPage',
  authors: '{ authors?: T.PersonCount[] | null; unknown: number }',
  series: '{ series: T.SeriesCount[] | null }',
  search: '{ books: T.Book[] }',
  item: 'T.Book',
  chapters: 'T.ChaptersResponse',
  progress: '{ progress: T.Progress | null }',
  'me-progress': '{ progress: T.Progress[] | null }',
  'listening-sync': 'T.ListeningSyncResponse',
  bookmarks: '{ bookmarks: T.Bookmark[] }',
  meta: 'T.BookMeta',
  upcoming: 'T.UpcomingResponse',
  'household-listening': 'T.HouseListening',
};

// Fields the server sends that types.ts leaves out on purpose, per golden, by
// path (as the report prints it), each with why.
const AUDIBLE = 'console-only module flag: no player surface yet (CROSS-REPO.md, Capability flags)';
const UNMIRRORED: Record<string, Record<string, string>> = {
  server: { '$.capabilities.audible': AUDIBLE },
  'server-anonymous': { '$.capabilities.audible': AUDIBLE },
};

type Shape = string | Shape[] | { [k: string]: Shape };

type Problems = { errors: string[]; unknown: string[] };

const isOr = (s: Shape): s is { $or: Shape[] } =>
  typeof s === 'object' && !Array.isArray(s) && Array.isArray((s as { $or?: unknown }).$or);

/** A program over types.ts plus a probe file declaring `W<i> = <expression>`. */
function probeTypes(
  expressions: string[],
  extra = '',
): { checker: ts.TypeChecker; types: ts.Type[] } {
  const source =
    `import type * as T from './types';\n${extra}\n` +
    expressions.map((e, i) => `export type W${i} = ${e};`).join('\n');
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    types: [],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (f, lang, ...rest) =>
    f === PROBE ? ts.createSourceFile(f, source, lang) : getSourceFile.call(host, f, lang, ...rest);
  host.fileExists = (f) => f === PROBE || fileExists.call(host, f);
  host.readFile = (f) => (f === PROBE ? source : readFile.call(host, f));
  const program = ts.createProgram([PROBE], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === PROBE);
  if (errors.length > 0) {
    throw new Error(
      errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
    );
  }
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(PROBE)!;
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  file.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n)) aliases.set(n.name.text, n);
  });
  return {
    checker,
    types: expressions.map((_, i) => checker.getTypeFromTypeNode(aliases.get(`W${i}`)!.type)),
  };
}

/** How shape (the server's) and type (the player's) disagree. */
function compare(checker: ts.TypeChecker, shape: Shape, type: ts.Type): Problems {
  const out: Problems = { errors: [], unknown: [] };
  walk(checker, shape, type, '$', out);
  out.errors.sort();
  out.unknown.sort();
  return out;
}

function members(type: ts.Type): ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

const SCALAR: Record<string, ts.TypeFlags> = {
  string: ts.TypeFlags.StringLike,
  number: ts.TypeFlags.NumberLike,
  boolean: ts.TypeFlags.BooleanLike,
  null: ts.TypeFlags.Null,
};

function walk(checker: ts.TypeChecker, shape: Shape, type: ts.Type, at: string, out: Problems) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
  const name = () => checker.typeToString(type);
  if (isOr(shape)) {
    for (const alt of shape.$or) walk(checker, alt, type, at, out);
    return;
  }
  if (typeof shape === 'string') {
    const flag = SCALAR[shape];
    if (flag === undefined) throw new Error(`${at}: unknown shape ${shape}`);
    if (!members(type).some((m) => m.flags & flag)) {
      out.errors.push(`${at}: the server sends ${shape}, the type is ${name()}`);
    }
    return;
  }
  if (Array.isArray(shape)) {
    const arrays = members(type).filter((m) => checker.isArrayType(m) || checker.isTupleType(m));
    if (arrays.length === 0) {
      out.errors.push(`${at}: the server sends an array, the type is ${name()}`);
      return;
    }
    if (shape.length === 0) return;
    const el = checker.getTypeArguments(arrays[0] as ts.TypeReference)[0];
    if (el) walk(checker, shape[0], el, `${at}[]`, out);
    return;
  }
  const objects = members(type).filter(
    (m) => m.flags & ts.TypeFlags.Object && !checker.isArrayType(m) && !checker.isTupleType(m),
  );
  if (objects.length === 0) {
    out.errors.push(`${at}: the server sends an object, the type is ${name()}`);
    return;
  }
  // A union of object types (a discriminated answer): the member that fits best.
  let best: Problems | undefined;
  for (const obj of objects) {
    const p: Problems = { errors: [], unknown: [] };
    walkObject(checker, shape, obj, at, p);
    if (!best || p.errors.length + p.unknown.length < best.errors.length + best.unknown.length) {
      best = p;
    }
    if (best.errors.length + best.unknown.length === 0) break;
  }
  out.errors.push(...best!.errors);
  out.unknown.push(...best!.unknown);
}

function walkObject(
  checker: ts.TypeChecker,
  shape: { [k: string]: Shape },
  obj: ts.Type,
  at: string,
  out: Problems,
) {
  const index = checker.getIndexInfoOfType(obj, ts.IndexKind.String);
  const props = new Map(checker.getPropertiesOfType(obj).map((p) => [p.name, p]));
  for (const [key, sub] of Object.entries(shape)) {
    const prop = props.get(key);
    if (prop) walk(checker, sub, checker.getTypeOfSymbol(prop), `${at}.${key}`, out);
    else if (index) walk(checker, sub, index.type, `${at}.${key}`, out);
    else out.unknown.push(`${at}.${key}`);
  }
  for (const [key, prop] of props) {
    if (key in shape || prop.flags & ts.SymbolFlags.Optional) continue;
    if (members(checker.getTypeOfSymbol(prop)).some((m) => m.flags & ts.TypeFlags.Undefined))
      continue;
    out.errors.push(`${at}.${key}: required in the type, the server does not send it`);
  }
}

function readGoldens(): Record<string, { route: string; shape: Shape }> {
  return Object.fromEntries(
    fs
      .readdirSync(WIRE_DIR)
      .filter((n) => n.endsWith('.json') && n !== 'source.json')
      .map((n) => [
        n.replace(/\.json$/, ''),
        JSON.parse(fs.readFileSync(path.join(WIRE_DIR, n), 'utf8')),
      ]),
  );
}

describe('wire parity with the server goldens', () => {
  const goldens = readGoldens();
  const names = Object.keys(ENVELOPES);
  const { checker, types } = probeTypes(names.map((n) => ENVELOPES[n]));

  it('maps every golden to a type, and every type to a golden', () => {
    expect(Object.keys(goldens).sort()).toEqual([...names].sort());
  });

  it.each(names.map((n, i) => [n, i] as const))('%s matches types.ts', (name, i) => {
    const golden = goldens[name];
    const { errors, unknown } = compare(checker, golden.shape, types[i]);
    const allowed = UNMIRRORED[name] ?? {};
    const report = {
      route: golden.route,
      errors,
      // A server field types.ts does not know: mirror it, or list it in UNMIRRORED.
      unknown: unknown.filter((p) => !(p in allowed)),
      // An UNMIRRORED entry the server no longer sends, or types.ts now has.
      staleAllowances: Object.keys(allowed).filter((p) => !unknown.includes(p)),
    };
    expect(report).toEqual({ route: golden.route, errors: [], unknown: [], staleAllowances: [] });
  });

  it('pins the server commit the copy came from', () => {
    const source = JSON.parse(fs.readFileSync(path.join(WIRE_DIR, 'source.json'), 'utf8'));
    expect(source.repo).toBe('KodeStar/audiosilo-server');
    expect(source.ref).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the parity check itself', () => {
  const extra = `
    type Inner = { x: number };
    type Probe = {
      a: string;
      b?: number;
      c: 'one' | 'two';
      d: Inner[] | null;
      e: { kind: 'on'; on: boolean } | { kind: 'off' };
      f: Record<string, number>;
      g: string | undefined;
    };`;
  const { checker, types } = probeTypes(['Probe'], extra);
  const good: Shape = {
    a: 'string',
    c: 'string',
    d: [{ x: 'number' }],
    e: { kind: 'string' },
    f: { anything: 'number' },
  };

  it('accepts a shape the type covers (optional and undefined fields may be absent)', () => {
    expect(compare(checker, good, types[0])).toEqual({ errors: [], unknown: [] });
    expect(
      compare(checker, { ...good, d: 'null', e: { kind: 'string', on: 'boolean' } }, types[0]),
    ).toEqual({
      errors: [],
      unknown: [],
    });
  });

  it('reports a missing required field, a retype and an unknown field', () => {
    const bad: Shape = {
      a: 'number',
      d: [{ x: 'number', y: 'string' }],
      e: { kind: 'string' },
      f: { anything: 'string' },
      z: 'boolean',
    };
    expect(compare(checker, bad, types[0])).toEqual({
      errors: [
        '$.a: the server sends number, the type is string',
        '$.c: required in the type, the server does not send it',
        '$.f.anything: the server sends string, the type is number',
      ],
      unknown: ['$.d[].y', '$.z'],
    });
  });

  it('reports null where the type has none, and an array where it wants an object', () => {
    expect(compare(checker, { ...good, a: 'null', e: [] }, types[0]).errors).toEqual([
      '$.a: the server sends null, the type is string',
      '$.e: the server sends an array, the type is { kind: "on"; on: boolean; } | { kind: "off"; }',
    ]);
  });
});
