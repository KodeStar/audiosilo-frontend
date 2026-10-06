import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useLatestRef } from '@/lib/use-latest';

import { activeBookDrag } from './drag-source';
import type { DropZoneProps } from './drop-zone-types';
import { BOOK_DRAG_TYPE, canDrop, parseDragPayload } from './up-next-model';

type Over = 'idle' | 'ok' | 'other-server';

/**
 * The dashed "Drag any cover here to queue it" zone (STYLEGUIDE section 8, "Up next"):
 * HTML5 drag and drop of a cover from the page (`useBookDragSource`). It reacts only to
 * a book, and takes only one from the queue's own server; a cover from another server
 * says so instead. With nothing queued it is the empty state.
 */
export function DropZone({ connectionId, serverName, empty, onDrop }: DropZoneProps) {
  const { t } = useTranslation();
  const ref = useRef<View>(null);
  const [over, setOver] = useState<Over>('idle');
  const latest = useLatestRef({ connectionId, onDrop });

  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;
    const isBook = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(BOOK_DRAG_TYPE);
    // A drag from another window has no `activeBookDrag`: accept it, the drop decides.
    const verdict = (book = activeBookDrag()) =>
      book ? canDrop(book, latest.current.connectionId) : 'ok';
    const onOver = (e: DragEvent) => {
      if (!isBook(e)) return;
      e.preventDefault();
      const v = verdict();
      if (e.dataTransfer) e.dataTransfer.dropEffect = v === 'ok' ? 'copy' : 'none';
      setOver(v === 'other-server' ? 'other-server' : 'ok');
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget instanceof Node && node.contains(e.relatedTarget)) return;
      setOver('idle');
    };
    const onDropEvent = (e: DragEvent) => {
      if (!isBook(e)) return;
      e.preventDefault();
      setOver('idle');
      const book = parseDragPayload(e.dataTransfer?.getData(BOOK_DRAG_TYPE)) ?? activeBookDrag();
      if (book && canDrop(book, latest.current.connectionId) === 'ok') latest.current.onDrop(book);
    };
    node.addEventListener('dragenter', onOver);
    node.addEventListener('dragover', onOver);
    node.addEventListener('dragleave', onLeave);
    node.addEventListener('drop', onDropEvent);
    return () => {
      node.removeEventListener('dragenter', onOver);
      node.removeEventListener('dragover', onOver);
      node.removeEventListener('dragleave', onLeave);
      node.removeEventListener('drop', onDropEvent);
    };
  }, [latest]);

  const line =
    over === 'ok'
      ? t('upnext.drop.over')
      : over === 'other-server'
        ? t('upnext.drop.otherServer', { server: serverName })
        : empty
          ? t('upnext.empty.dropHint')
          : t('upnext.drop.hint');

  return (
    <View
      ref={ref}
      testID="upnext-drop-zone"
      className={cn(
        'mx-1.5 my-1 items-center gap-1 rounded-xl border-[1.5px] border-dashed px-3 transition-colors motion-reduce:transition-none',
        empty ? 'py-6' : 'py-3',
        over === 'ok'
          ? 'border-brand bg-brand-soft'
          : over === 'other-server'
            ? 'border-border-strong bg-muted'
            : 'border-border-strong',
      )}
    >
      {empty && over === 'idle' ? (
        <Text variant="label" className="text-center">
          {t('upnext.empty.title')}
        </Text>
      ) : null}
      <Text
        variant="caption"
        className={cn('text-center text-[12.5px]', over === 'ok' && 'text-brand-ink')}
      >
        {line}
      </Text>
    </View>
  );
}
