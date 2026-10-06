import type { ReactNode } from 'react';

import { type SegmentedOption, SegmentedControl } from '@/components/ui/toggle-group';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';

import type { TabName } from './destinations';
import { usePublish, useSubNav } from './sub-nav-store';

/**
 * A tab root's sections (Library: Books / Authors / ... / Folders; You, Phase 5): ONE
 * segmented control that sits where the form factor puts it.
 * - Tablet/desktop: published to the sub-nav row beside the title (renders nothing here).
 * - Phone: rendered right here, scrolling horizontally - put it under the large title.
 * Counts are optional per option (`count`). Published content renders in the SUB-NAV's
 * tree, so it must not rely on context from the screen (ContentScope, local providers);
 * tab roots carry none.
 */
export function SubNavSections<T extends string>({
  tab,
  options,
  value,
  onChange,
  accessibilityLabel,
  className,
}: {
  tab: TabName;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  /** Classes for the phone placement. */
  className?: string;
}) {
  const phone = useLayout() === 'phone';
  usePublish(
    !phone,
    { options, value, onChange: onChange as (v: string) => void, accessibilityLabel },
    (spec) => useSubNav.getState().setSections(tab, spec),
    tab,
  );
  if (!phone) return null;
  return (
    <SegmentedControl
      scrollable
      options={options}
      value={value}
      onChange={onChange}
      accessibilityLabel={accessibilityLabel}
      className={cn('self-start', className)}
    />
  );
}

/**
 * Contextual actions of a tab root (a library picker, sort, grid/list): on tablet and
 * desktop they go to the right end of the sub-nav row, ordered by `order` (lower first)
 * among every action the root published; on a phone `children` render right here.
 * `id` names this contribution, so several components (the screen, its current mode)
 * can each publish their own. Same context rule as `SubNavSections`.
 */
export function SubNavActions({
  tab,
  id,
  order = 0,
  children,
}: {
  tab: TabName;
  id: string;
  order?: number;
  children: ReactNode;
}) {
  const phone = useLayout() === 'phone';
  usePublish(
    !phone,
    { node: children, order },
    (action) => useSubNav.getState().setAction(tab, id, action),
    `${tab}:${id}`,
  );
  return phone ? <>{children}</> : null;
}
