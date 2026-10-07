/** The year of a `published` date ("YYYY", "YYYY-MM" or "YYYY-MM-DD"), or undefined. */
export function yearOf(published: string | undefined): string | undefined {
  return /^\d{4}/.exec(published ?? '')?.[0];
}
