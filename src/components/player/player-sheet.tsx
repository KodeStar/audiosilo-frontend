import type { ReactNode } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet } from '@/components/ui/sheet';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';

/** The most a desktop dialog takes of the window's height. */
const DESKTOP_MAX_FRACTION = 0.85;
/** A `fill` dialog never grows past this on a tall desktop. */
const DESKTOP_FILL_MAX = 640;

/**
 * How the player's sheets present (STYLEGUIDE section 8, "Sheets"): a bottom sheet on a
 * phone, a centred floating sheet on a tablet (the `Sheet` floats at 560 there), and on
 * desktop a centred dialog. The guide's ideal on desktop is a popover anchored above the
 * dock; the sheets are opened from several places through `usePlayerSheets`, with no
 * trigger to anchor to, so the centred dialog is the stand-in until a caller can hand an
 * anchor down.
 *
 * `body` says what the content is:
 * - `scroll` (default): plain content; the sheet scrolls it once it passes the sheet's
 *   height cap (a share of the window).
 * - `fill`: content with its own scroller (a virtualized list, the companion's tabs). The
 *   sheet takes `fraction` of the window's height and the content fills what the header
 *   leaves, so the list can measure itself.
 *
 * Children mount only while it is open (both presenters do that), so a body that
 * subscribes to the playback position costs nothing behind a closed sheet.
 */
export function PlayerSheet({
  visible,
  onClose,
  title,
  body = 'scroll',
  fraction = 0.7,
  className,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body?: 'scroll' | 'fill';
  /** A `fill` sheet's height, as a share of the window's. */
  fraction?: number;
  /** The body's padding (a `scroll` body; a `fill` body pads itself). */
  className?: string;
  children: ReactNode;
}) {
  const layout = useLayout();
  const { height } = useWindowDimensions();
  const fill = body === 'fill';
  if (layout === 'desktop') {
    return (
      <Dialog
        open={visible}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          className={cn(fill ? 'max-w-[480px]' : 'max-w-[440px]', 'gap-3 px-0 pb-0')}
          style={
            fill
              ? { height: Math.min(DESKTOP_FILL_MAX, Math.round(height * fraction)) }
              : { maxHeight: Math.round(height * DESKTOP_MAX_FRACTION) }
          }
        >
          <DialogHeader className="px-6">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {fill ? (
            <View className="flex-1">{children}</View>
          ) : (
            // Shrinks to the dialog's cap and scrolls the rest.
            <ScrollView
              style={{ flexShrink: 1 }}
              contentContainerClassName={cn('px-6 pb-6', className)}
              keyboardShouldPersistTaps="handled"
            >
              <View>{children}</View>
            </ScrollView>
          )}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      {...(fill
        ? { fill: true, maxHeightFraction: fraction }
        : { scroll: true, contentClassName: cn('px-4 pb-4', className) })}
    >
      {children}
    </Sheet>
  );
}
