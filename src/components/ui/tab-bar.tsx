import { SegmentedControl, type SegmentedOption } from './segmented-control';

export type TabBarProps<T extends string> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
};

/**
 * A horizontally scrollable tab row: content-hugging pills on a rounded track,
 * the active one filled in brand pink. Generic over a string union of tab ids.
 *
 * It IS `SegmentedControl` in its scrolling, `tablist`-flavoured mode - the two
 * share one implementation so they can never drift visually. The equal-width,
 * non-scrolling default breaks down past ~4 options (the book screen has 7), which
 * is what this wrapper exists to name.
 */
export function TabBar<T extends string>(props: TabBarProps<T>) {
  return <SegmentedControl {...props} scrollable role="tab" />;
}
