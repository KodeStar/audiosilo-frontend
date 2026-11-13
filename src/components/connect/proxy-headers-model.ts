import {
  cleanProxyHeaders,
  MAX_PROXY_HEADERS,
  originOf,
  type ProxyHeader,
  type ProxyHeaderProblem,
  proxyHeaderProblems,
  type ProxyHeaders,
} from '@/lib/proxy-headers';

/**
 * The proxy headers editor's draft (fe#167), pure. A row loaded from a connection's stored
 * set keeps its value hidden: the field starts empty ("kept as it is") and the stored value
 * is used unless the listener types a new one, so a stored value is never put on screen.
 */
export type HeaderDraftRow = {
  /** Stable React key. */
  key: string;
  name: string;
  /** What was typed for the value ('' keeps `stored`). */
  value: string;
  /** The stored value of a row loaded from the connection (never shown). */
  stored?: string;
};

let next = 0;
const newKey = () => `h${++next}`;

/** A blank row. */
export function blankRow(): HeaderDraftRow {
  return { key: newKey(), name: '', value: '' };
}

/** The rows for a stored set (none: one blank row to start from). */
export function draftOf(set: ProxyHeaders | null | undefined): HeaderDraftRow[] {
  if (!set?.headers.length) return [blankRow()];
  return set.headers.map((h) => ({ key: newKey(), name: h.name, value: '', stored: h.value }));
}

/** A row's value as it would be kept: what was typed, else the stored one. */
function effectiveValue(row: HeaderDraftRow): string {
  return row.value.trim() ? row.value : (row.stored ?? '');
}

/** Whether a row was left blank (no name, no value): it is dropped, never a problem. */
function isBlank(row: HeaderDraftRow): boolean {
  return !row.name.trim() && !effectiveValue(row).trim();
}

/** The headers the rows make: blank rows dropped, each with the value it would be kept with. */
function filledHeaders(rows: readonly HeaderDraftRow[]): ProxyHeader[] {
  return rows.filter((r) => !isBlank(r)).map((r) => ({ name: r.name, value: effectiveValue(r) }));
}

/** Each row's problem (null: fine or blank). */
export function draftProblems(rows: readonly HeaderDraftRow[]): (ProxyHeaderProblem | null)[] {
  const problems = proxyHeaderProblems(filledHeaders(rows));
  let i = 0;
  return rows.map((r) => (isBlank(r) ? null : problems[i++]));
}

/** Whether another row may be added. */
export function canAddRow(rows: readonly HeaderDraftRow[]): boolean {
  return rows.length < MAX_PROXY_HEADERS;
}

/**
 * The set the draft makes for `origin`: null when it holds no header (blank rows dropped)
 * or the origin is not an http(s) one. Rows with a problem are left out
 * (`cleanProxyHeaders`): a caller that saves checks `draftProblems` first.
 */
export function draftToSet(
  origin: string | null,
  rows: readonly HeaderDraftRow[],
): ProxyHeaders | null {
  return cleanProxyHeaders(origin, filledHeaders(rows));
}

/**
 * The origins a connection's headers can be for, best first: the one they are for now, the
 * server's away address (the public one a proxy guards), the address it was paired with,
 * then its home address. Distinct, http(s) only.
 */
export function proxyOriginChoices(conn: {
  serverUrl: string;
  addresses?: { home?: string; away?: string };
  proxyHeaders?: ProxyHeaders;
}): string[] {
  const all = [
    conn.proxyHeaders?.origin,
    conn.addresses?.away,
    conn.serverUrl,
    conn.addresses?.home,
  ].map((u) => (u ? originOf(u) : null));
  return [...new Set(all.filter((o): o is string => !!o))];
}
