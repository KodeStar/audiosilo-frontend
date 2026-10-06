import type { BookDragPayload } from './up-next-model';

export type DropZoneProps = {
  /** The connection whose queue takes the drop: a cover from another server is refused. */
  connectionId: string | undefined;
  /** That server's name, for the refusal. */
  serverName: string;
  /** Whether the queue is empty: the zone then carries the empty state's words. */
  empty: boolean;
  onDrop: (book: BookDragPayload) => void;
};
