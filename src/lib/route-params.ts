import { useLocalSearchParams } from 'expo-router';
import { LocalRouteParamsContext } from 'expo-router/build/Route';
import { use } from 'react';

type Params = Record<string, string | string[] | undefined>;

/**
 * The route's search params, decoded exactly ONCE (CONNECT-01). Expo Router already
 * decodes a URL's query into the route's params (`getStateFromPath`, and an in-app push
 * goes through the same parse), and `useLocalSearchParams` then runs `decodeURIComponent`
 * over every value a second time: a folder named `Lit%20Book` was asked for as `Lit Book`,
 * and a double-encoded link (`Jane%2520Austen`) opened `Jane Austen`. This reads the
 * route's own params (the context `useLocalSearchParams` reads) instead. A key the
 * context lacks (a screen rendered outside a navigator, as in unit tests that mock
 * `expo-router`) falls back to `useLocalSearchParams`. Use this, never
 * `useLocalSearchParams` (lint enforces it): any param can carry a name with a `%`.
 */
export function useRouteParams<T extends Params = Params>(): T {
  const decodedTwice = useLocalSearchParams() as Params;
  const raw = (use(LocalRouteParamsContext) ?? {}) as Record<string, unknown>;
  return decodedOnce(raw, decodedTwice) as T;
}

function decodedOnce(raw: Record<string, unknown>, fallback: Params): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(fallback)) {
    out[key] = key in raw ? asParam(raw[key]) : value;
  }
  return out;
}

/** A route param as a string or string list; any other value (a number set through
 * `setParams`) as its string, as `useLocalSearchParams` hands it back. */
function asParam(v: unknown): string | string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  return String(v);
}
