import type { ReactNode } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet } from '@/components/ui/sheet';
import { useLayout } from '@/lib/layout';

/**
 * How the player's speed and sleep sheets present (STYLEGUIDE section 8, "Sheets"): a
 * bottom sheet on a phone, a centred floating sheet on a tablet (the hosted `Sheet`
 * floats at 560 there), and on desktop a centred dialog. The guide's ideal on desktop
 * is a popover anchored above the dock; the sheets are opened from two places (the dock
 * and the full player) by their callers' own state, with no trigger to anchor to, so
 * the centred dialog is the stand-in until a caller can hand an anchor down.
 *
 * Children mount only while it is open (both presenters do that), so a body that
 * subscribes to the playback position costs nothing behind a closed sheet.
 */
export function PlayerSheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const layout = useLayout();
  const { height } = useWindowDimensions();
  if (layout === 'desktop') {
    return (
      <Dialog
        open={visible}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent className="max-w-[440px] gap-3 px-0 pb-0">
          <DialogHeader className="px-6">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <ScrollView
            style={{ maxHeight: Math.max(240, height - 200) }}
            contentContainerClassName="px-6 pb-6"
            keyboardShouldPersistTaps="handled"
          >
            <View>{children}</View>
          </ScrollView>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet visible={visible} onClose={onClose} title={title} scroll contentClassName="px-4 pb-4">
      {children}
    </Sheet>
  );
}
