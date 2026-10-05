import { BottomSheet, Button as UIButton, Column, RNHostView, Text as UIText } from '@expo/ui';
import type * as DropdownMenuPrimitive from '@rn-primitives/dropdown-menu';
import type * as PopoverPrimitive from '@rn-primitives/popover';
import type * as SelectPrimitive from '@rn-primitives/select';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/spike-ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/spike-ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/spike-ui/popover';
import {
  type Option,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/spike-ui/select';
import { useSpikeLayoutLog } from '@/components/spike-ui/spike-log';
import { Text } from '@/components/spike-ui/text';

/**
 * SPIKE (player redesign Phase 0a, branch spike/player-0a-portals - never merged).
 * The overlay test bench shared by /spike and the /spike-modal native modal: one of
 * each react-native-reusables overlay plus the @expo/ui BottomSheet, with stable
 * testIDs / labels and `[spike] <name> layout ...` logs for automation.
 */

export type SpikeOverlay = 'dialog' | 'menu' | 'popover' | 'select' | 'sheet';

const TRIGGER =
  'rounded-md border border-border bg-card px-4 py-2 active:bg-accent web:hover:bg-accent';

export function SpikeTrigger({ label, children }: { label: string; children?: ReactNode }) {
  return <Text className="text-sm font-medium text-card-foreground">{children ?? label}</Text>;
}

/** Opens a trigger-ref-driven overlay once on mount (rn-primitives' native popover /
 * select / menu position from a trigger measurement, so they are opened through the
 * trigger's imperative `open()`, after a beat so the trigger has laid out). */
function useAutoOpen(when: boolean, ref: { current: { open?: () => void } | null }) {
  useEffect(() => {
    if (!when) return;
    const t = setTimeout(() => ref.current?.open?.(), 600);
    return () => clearTimeout(t);
  }, [when, ref]);
}

export function SpikeDialog({ autoOpen, suffix = '' }: { autoOpen?: boolean; suffix?: string }) {
  const [open, setOpen] = useState(!!autoOpen);
  const { ref: logRef, onLayout: onLogLayout } = useSpikeLayoutLog(`dialog${suffix}`);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className={TRIGGER}
        accessibilityLabel={`Open dialog${suffix}`}
        testID={`spike-dialog-trigger${suffix}`}
      >
        <SpikeTrigger label="Open dialog" />
      </DialogTrigger>
      <DialogContent
        ref={logRef}
        onLayout={onLogLayout}
        testID={`spike-dialog-content${suffix}`}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Spike dialog</DialogTitle>
          <DialogDescription>Spike dialog content</DialogDescription>
        </DialogHeader>
        <DialogClose
          className={TRIGGER}
          accessibilityLabel="Close dialog"
          testID={`spike-dialog-close${suffix}`}
        >
          <SpikeTrigger label="Done" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

export function SpikeMenu({
  autoOpen,
  onAction,
}: {
  autoOpen?: boolean;
  onAction: (a: string) => void;
}) {
  const ref = useRef<DropdownMenuPrimitive.TriggerRef>(null);
  useAutoOpen(!!autoOpen, ref);
  const { ref: logRef, onLayout: onLogLayout } = useSpikeLayoutLog('menu');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={ref}
        className={TRIGGER}
        accessibilityLabel="Open menu"
        testID="spike-menu-trigger"
      >
        <SpikeTrigger label="Open menu" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={logRef}
        onLayout={onLogLayout}
        testID="spike-menu-content"
        className="w-56"
      >
        <DropdownMenuLabel>Spike menu content</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem testID="spike-menu-item-bookmark" onPress={() => onAction('bookmark')}>
          <Text>Add bookmark</Text>
        </DropdownMenuItem>
        <DropdownMenuItem testID="spike-menu-item-share" onPress={() => onAction('share')}>
          <Text>Share</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SpikePopover({ autoOpen }: { autoOpen?: boolean }) {
  const ref = useRef<PopoverPrimitive.TriggerRef>(null);
  useAutoOpen(!!autoOpen, ref);
  const { ref: logRef, onLayout: onLogLayout } = useSpikeLayoutLog('popover');
  return (
    <Popover>
      <PopoverTrigger
        ref={ref}
        className={TRIGGER}
        accessibilityLabel="Open popover"
        testID="spike-popover-trigger"
      >
        <SpikeTrigger label="Open popover" />
      </PopoverTrigger>
      <PopoverContent
        ref={logRef}
        onLayout={onLogLayout}
        testID="spike-popover-content"
        side="bottom"
        className="w-72"
      >
        <Text className="font-medium">Spike popover content</Text>
        <Text className="mt-2 text-sm text-muted-foreground">
          This should escape the clipped card it was opened from.
        </Text>
      </PopoverContent>
    </Popover>
  );
}

const FRUITS: { value: string; label: string }[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
  { value: 'damson', label: 'Damson' },
];

export function SpikeSelect({
  autoOpen,
  suffix = '',
  onValue,
}: {
  autoOpen?: boolean;
  suffix?: string;
  onValue?: (v: string) => void;
}) {
  const ref = useRef<SelectPrimitive.TriggerRef>(null);
  useAutoOpen(!!autoOpen, ref);
  const [value, setValue] = useState<Option>(undefined);
  const { ref: logRef, onLayout: onLogLayout } = useSpikeLayoutLog(`select${suffix}`);
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        setValue(v);
        if (v) onValue?.(v.value);
      }}
    >
      <SelectTrigger
        ref={ref}
        className="w-[180px]"
        accessibilityLabel={`Open select${suffix}`}
        testID={`spike-select-trigger${suffix}`}
      >
        <SelectValue placeholder="Pick a fruit" />
      </SelectTrigger>
      <SelectContent
        ref={logRef}
        onLayout={onLogLayout}
        testID={`spike-select-content${suffix}`}
        className="w-[180px]"
      >
        <SelectGroup>
          <SelectLabel>Spike select content</SelectLabel>
          {FRUITS.map((f) => (
            <SelectItem
              key={f.value}
              label={f.label}
              value={f.value}
              testID={`spike-select-item-${f.value}${suffix}`}
            />
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The @expo/ui universal BottomSheet (SwiftUI sheet / Compose ModalBottomSheet / vaul). */
export function SpikeSheet({ autoOpen }: { autoOpen?: boolean }) {
  const [open, setOpen] = useState(!!autoOpen);
  const { ref: logRef, onLayout: onLogLayout } = useSpikeLayoutLog('sheet');
  return (
    <>
      <Pressable
        className={TRIGGER}
        accessibilityLabel="Open sheet"
        accessibilityRole="button"
        testID="spike-sheet-trigger"
        onPress={() => setOpen(true)}
      >
        <SpikeTrigger label="Open sheet" />
      </Pressable>
      <BottomSheet isPresented={open} onDismiss={() => setOpen(false)} testID="spike-sheet-content">
        <Column spacing={12}>
          <UIText>Spike sheet content</UIText>
          {/* React Native views hosted inside the native sheet, measured for the log. */}
          <RNHostView matchContents>
            <View
              ref={logRef}
              onLayout={onLogLayout}
              testID="spike-sheet-rn"
              style={{ padding: 8 }}
            >
              <Text className="text-sm">RN view inside the sheet ({Platform.OS})</Text>
            </View>
          </RNHostView>
          <UIButton label="Close sheet" onPress={() => setOpen(false)} testID="spike-sheet-close" />
        </Column>
      </BottomSheet>
    </>
  );
}
