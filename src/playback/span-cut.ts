/**
 * The store's cut of the span playing through a connection (`cutListeningSpanNow`: closed
 * into the outbox, a span opening where it ended), for the listening outbox's last send at
 * a sign-out or a removal (`unsentListens`): the outbox cannot import the store (the store
 * imports it). A module of its own, imported by both; the store registers its cut here as it
 * loads. None registered (the outbox loaded without the store): no span is open to cut.
 */
type SpanCut = (connectionId: string) => void;

let cut: SpanCut | null = null;

/** The store's cut (null: none, as before one registered). */
export function provideSpanCut(next: SpanCut | null): void {
  cut = next;
}

/** Cut the span playing through `connectionId`, if one is open, through the registered cut. */
export function cutPlayingSpan(connectionId: string): void {
  cut?.(connectionId);
}
