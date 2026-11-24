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
  'server-bridge': 'T.ServerInfo',
  'auth-redeem': 'T.PairingPayload',
  'auth-redeem-invite': 'T.PairingPayload',
  'auth-exchange': 'T.AuthSession',
  'auth-exchange-invite': 'T.AuthSession',
  'auth-oidc-finish': 'T.AuthSession',
  'auth-password': 'T.PasswordChange',
  error: 'T.ApiErrorResponse',
  'error-code': 'T.ApiErrorResponse',
  me: 'T.User',
  'me-owner': 'T.User',
  libraries: 'T.LibrariesResponse',
  'libraries-listener': 'T.LibrariesResponse',
  fs: 'T.Listing',
  'fs-pending': 'T.Listing',
  books: 'T.BookPage',
  'books-page': 'T.BookPage',
  authors: 'T.PeopleResponse',
  series: 'T.SeriesListResponse',
  search: 'T.BooksResponse',
  'search-copies': 'T.BooksResponse',
  item: 'T.Book',
  'item-episode': 'T.Book',
  'item-readalong-stale': 'T.Book',
  'item-recordings': 'T.Book',
  chapters: 'T.ChaptersResponse',
  'chapters-edited': 'T.ChaptersResponse',
  progress: 'T.ProgressResponse',
  'me-progress': 'T.ProgressListResponse',
  'me-progress-diverged': 'T.ProgressListResponse',
  favourites: 'T.FavouritesResponse',
  'listening-sync': 'T.ListeningSyncResponse',
  'listening-sync-diverged': 'T.ListeningSyncResponse',
  bookmarks: 'T.BookmarksResponse',
  meta: 'Extract<T.BookMeta, { matched: true }>',
  'meta-bundle': 'Extract<T.BookMeta, { matched: true }>',
  'meta-unmatched': 'Extract<T.BookMeta, { matched: false }>',
  upcoming: 'T.UpcomingResponse',
  'household-listening': 'T.HouseListening',
};

// Fields the server sends that types.ts leaves out on purpose, per ENVELOPES
// type (so goldens sharing a type share the entry), by path (as the report
// prints it), each with why.
const UNMIRRORED: Record<string, Record<string, string>> = {
  'T.ServerInfo': {
    '$.capabilities.audible':
      'console-only module flag: no player surface yet (CROSS-REPO.md, Capability flags)',
  },
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
  const file = program.getSourceFile(PROBE)!;
  const errors = [
    ...program.getSyntacticDiagnostics(file),
    ...program.getSemanticDiagnostics(file),
  ];
  if (errors.length > 0) {
    throw new Error(
      errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'),
    );
  }
  const checker = program.getTypeChecker();
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
  walk(checker, shape, [type], '$', out, false);
  return { errors: [...new Set(out.errors)].sort(), unknown: [...new Set(out.unknown)].sort() };
}

const score = (p: Problems) => p.errors.length + p.unknown.length;

function members(type: ts.Type): ts.Type[] {
  return type.isUnion() ? type.types : [type];
}

/** An object type, or an intersection of them (`A & { b: number }`); never an array. */
function isObject(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isIntersection()) return type.types.every((t) => isObject(checker, t));
  return (
    !!(type.flags & ts.TypeFlags.Object) && !checker.isArrayType(type) && !checker.isTupleType(type)
  );
}

const SCALAR: Record<string, ts.TypeFlags> = {
  string: ts.TypeFlags.StringLike,
  number: ts.TypeFlags.NumberLike,
  boolean: ts.TypeFlags.BooleanLike,
  null: ts.TypeFlags.Null,
};

// A single answer must fit one whole alternative. Keep the closest member's
// diagnostics when all fail so the report names the fields to fix.
function closest<T>(choices: T[], check: (choice: T, problems: Problems) => void, out: Problems) {
  const reports = choices.map((choice) => {
    const problems: Problems = { errors: [], unknown: [] };
    check(choice, problems);
    return problems;
  });
  const best = reports.reduce((a, b) => (score(a) <= score(b) ? a : b));
  out.errors.push(...best.errors);
  out.unknown.push(...best.unknown);
}

function walk(
  checker: ts.TypeChecker,
  shape: Shape,
  types: ts.Type[],
  at: string,
  out: Problems,
  merged: boolean,
) {
  const variants = types.flatMap(members);
  if (variants.some((t) => t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return;
  const name = () => types.map((t) => checker.typeToString(t)).join(' | ');
  if (isOr(shape)) {
    for (const alt of shape.$or) walk(checker, alt, types, at, out, merged);
    return;
  }
  if (typeof shape === 'string') {
    const flag = SCALAR[shape];
    if (flag === undefined) throw new Error(`${at}: unknown shape ${shape}`);
    if (!variants.some((m) => m.flags & flag)) {
      out.errors.push(`${at}: the server sends ${shape}, the type is ${name()}`);
    }
    return;
  }
  if (Array.isArray(shape)) {
    const arrays = variants.filter((m) => checker.isArrayType(m) || checker.isTupleType(m));
    if (arrays.length === 0) {
      out.errors.push(`${at}: the server sends an array, the type is ${name()}`);
      return;
    }
    if (shape.length === 0) return;
    const elements = arrays.map((m) => checker.getIndexTypeOfType(m, ts.IndexKind.Number)!);
    const walkRows = (rows: ts.Type[], p: Problems) =>
      walk(checker, shape[0], rows, `${at}[]`, p, true);
    if (merged) walkRows(elements, out);
    else closest(elements, (row, p) => walkRows([row], p), out);
    return;
  }
  const objects = variants.filter((m) => isObject(checker, m));
  if (objects.length === 0) {
    out.errors.push(`${at}: the server sends an object, the type is ${name()}`);
    return;
  }
  if (merged) walkObjects(checker, shape, objects, at, out, true);
  else closest(objects, (obj, p) => walkObjects(checker, shape, [obj], at, p, false), out);
}

// A merged golden can contain several values for the same field. A row of
// this type could be present if each required field has a possible value.
function canAppear(checker: ts.TypeChecker, shape: Shape, type: ts.Type): boolean {
  if (isOr(shape)) return shape.$or.some((alt) => canAppear(checker, alt, type));
  return members(type).some((member) => {
    if (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (typeof shape === 'string') return !!(member.flags & SCALAR[shape]);
    if (Array.isArray(shape)) return checker.isArrayType(member) || checker.isTupleType(member);
    return isObject(checker, member) && requiredGaps(checker, shape, member, true).length === 0;
  });
}

function requiredGaps(
  checker: ts.TypeChecker,
  shape: { [k: string]: Shape },
  obj: ts.Type,
  checkValues: boolean,
): string[] {
  return checker.getPropertiesOfType(obj).flatMap((prop) => {
    const type = checker.getTypeOfSymbol(prop);
    if (members(type).some((m) => m.flags & ts.TypeFlags.Undefined)) return [];
    if (!Object.hasOwn(shape, prop.name))
      return [`${prop.name}: required in the type, the server does not send it`];
    if (checkValues && !canAppear(checker, shape[prop.name], type))
      return [`${prop.name}: no observed value fits the required ${checker.typeToString(type)}`];
    return [];
  });
}

// The server merges array elements by JSON kind. Only a union member that
// could occur in those rows can account for a field specific to that member.
function walkObjects(
  checker: ts.TypeChecker,
  shape: { [k: string]: Shape },
  objects: ts.Type[],
  at: string,
  out: Problems,
  merged: boolean,
) {
  const variants = objects.map((obj) => ({
    obj,
    gaps: requiredGaps(checker, shape, obj, objects.length > 1),
  }));
  const gaps: Problems = { errors: [], unknown: [] };
  const reportGaps = (variant: (typeof variants)[number], p: Problems) => {
    p.errors.push(...variant.gaps.map((gap) => `${at}.${gap}`));
  };
  if (variants.every((v) => v.gaps.length > 0)) closest(variants, reportGaps, gaps);

  const fields = Object.entries(shape).map(([key, sub]) => {
    const owners = variants.flatMap((v) => {
      const prop = checker.getPropertyOfType(v.obj, key);
      const type = prop
        ? checker.getTypeOfSymbol(prop)
        : checker.getIndexInfoOfType(v.obj, ts.IndexKind.String)?.type;
      return type ? [{ ...v, type }] : [];
    });
    const possible = owners.filter((v) => v.gaps.length === 0);
    if (owners.length && !possible.length) closest(owners, reportGaps, gaps);
    return { key, sub, owners, possible };
  });

  // If a required field rules out a member we need, walk all its fields for
  // diagnostics. A retyped leaf then gets its own path in the report.
  const before = out.errors.length;
  for (const { key, sub, owners, possible } of fields) {
    if (!owners.length) out.unknown.push(`${at}.${key}`);
    else {
      const types = (gaps.errors.length ? owners : possible).map((v) => v.type);
      walk(checker, sub, types, `${at}.${key}`, out, merged);
    }
  }
  if (objects.length === 1 || out.errors.length === before) out.errors.push(...gaps.errors);
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
    const allowed = UNMIRRORED[ENVELOPES[name]] ?? {};
    const report = {
      route: golden.route,
      errors,
      // A server field types.ts does not know: mirror it, or list it in UNMIRRORED.
      unknown: unknown.filter((p) => !(p in allowed)),
    };
    expect(report).toEqual({ route: golden.route, errors: [], unknown: [] });
  });

  // An UNMIRRORED entry no golden of its type needs any more: the server no longer
  // sends the field, types.ts now has it, or no ENVELOPES entry names the type.
  // Goldens sharing a type need not all send the field (GET /server signed in
  // sends more than the anonymous one), so one of them needing it is enough.
  it('has no stale UNMIRRORED entry', () => {
    const needed = new Set(
      names.flatMap((n, i) =>
        compare(checker, goldens[n].shape, types[i]).unknown.map((p) => `${ENVELOPES[n]} ${p}`),
      ),
    );
    const listed = Object.entries(UNMIRRORED).flatMap(([type, allowed]) =>
      Object.keys(allowed).map((p) => `${type} ${p}`),
    );
    expect(listed.filter((entry) => !needed.has(entry))).toEqual([]);
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
      h?: (string | number)[];
      i?: Inner & { y: string };
    };`;
  const { checker, types } = probeTypes(['Probe'], extra);
  const good: Shape = {
    a: 'string',
    c: 'string',
    d: [{ x: 'number' }],
    e: { kind: 'string' },
    f: { anything: 'number' },
    h: [{ $or: ['string', 'number'] }],
    i: { x: 'number', y: 'string' },
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

  it('reports a missing required field, a retype (in an $or too) and an unknown field', () => {
    const bad: Shape = {
      a: 'number',
      d: [{ x: 'number', y: 'string' }],
      e: { kind: 'string' },
      f: { anything: 'string' },
      h: [{ $or: ['string', 'boolean'] }],
      i: { x: 'number', w: 'string' },
      z: 'boolean',
    };
    expect(compare(checker, bad, types[0])).toEqual({
      errors: [
        '$.a: the server sends number, the type is string',
        '$.c: required in the type, the server does not send it',
        '$.f.anything: the server sends string, the type is number',
        '$.h[]: the server sends boolean, the type is string | number',
        '$.i.y: required in the type, the server does not send it',
      ],
      unknown: ['$.d[].y', '$.i.w', '$.z'],
    });
  });

  it('checks later array alternatives and keeps a single array consistent with its type', () => {
    const {
      checker,
      types: [type],
    } = probeTypes(['string[] | number[]']);
    expect(compare(checker, ['number'], type)).toEqual({ errors: [], unknown: [] });
    expect(compare(checker, [{ $or: ['string', 'number'] }], type).errors).toHaveLength(1);
  });

  it('walks all members represented in a merged row, including their nested fields', () => {
    const {
      checker,
      types: [type],
    } = probeTypes([
      '({ a: string; value: { x: string; data: number[] } } | { b: boolean; id: number; value: { y: number; data: string[] } })[]',
    ]);
    const value = { x: 'string', y: 'number', data: [{ $or: ['number', 'string'] }] };
    const row = { a: 'string', b: 'boolean', id: 'number', value };
    expect(compare(checker, [row], type)).toEqual({ errors: [], unknown: [] });
    expect(compare(checker, [{ a: 'string', value: { x: 'string', data: [] } }], type)).toEqual({
      errors: [],
      unknown: [],
    });
    expect(
      compare(checker, [{ ...row, value: { ...value, y: 'string', z: 'null' } }], type),
    ).toEqual({
      errors: ['$[].value.y: the server sends string, the type is number'],
      unknown: ['$[].value.z'],
    });
    expect(compare(checker, [{ a: 'string', b: 'boolean', value }], type).errors).toContain(
      '$[].id: required in the type, the server does not send it',
    );
  });

  it('requires each represented row to account for its shared fields', () => {
    const {
      checker,
      types: [type],
    } = probeTypes([
      '({ left: number; shared: { value: string } } | { right: number; shared: { value: boolean } })[]',
    ]);
    const row = {
      left: 'number',
      right: 'number',
      shared: { value: { $or: ['string', 'boolean'] } },
    };
    expect(compare(checker, [row], type)).toEqual({ errors: [], unknown: [] });
    expect(compare(checker, [{ ...row, shared: { value: 'string' } }], type).errors).toHaveLength(
      1,
    );
  });

  it('reports null where the type has none, and an array where it wants an object', () => {
    expect(compare(checker, { ...good, a: 'null', e: [] }, types[0]).errors).toEqual([
      '$.a: the server sends null, the type is string',
      '$.e: the server sends an array, the type is { kind: "on"; on: boolean; } | { kind: "off"; }',
    ]);
  });
});
