import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The status icon's colour, a theme colour's name. */
export type JobStatusTone = 'mutedForeground' | 'warning' | 'destructive';

/**
 * A Bridge job's compact status, as Generate's (`JobStatus`) and Find on LibriVox's fetch
 * (`FetchStatus`) show it: an icon and a title, one caption line, a neutral progress bar
 * while there is a fraction, then `children` (a further line). Status is the words and the
 * icon, never colour alone. `action` (Cancel, Try again) sits at the title's end; a status
 * as wide as its page puts its button in `children` instead, left-aligned (an end-aligned one
 * would float in the middle of the row).
 */
export function JobStatusLayout({
  testID,
  icon,
  tone,
  title,
  line,
  lineLines,
  fraction,
  action,
  className,
  children,
}: {
  testID: string;
  icon: IconName;
  tone: JobStatusTone;
  title: string;
  line: string;
  lineLines: number;
  fraction?: number;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const themed = useThemeColors();
  return (
    <View testID={testID} className={cn('max-w-[560px] gap-1.5', className)}>
      <View className="flex-row items-center gap-2">
        <Icon name={icon} size={14} color={themed[tone]} />
        <Text variant="label" className="min-w-0 flex-1" numberOfLines={2}>
          {title}
        </Text>
        {action}
      </View>
      <Text variant="caption" numberOfLines={lineLines} style={tabularNums}>
        {line}
      </Text>
      {fraction !== undefined ? (
        <ProgressBar fraction={fraction} minPercent={4} fillClassName="bg-foreground/60" />
      ) : null}
      {children}
    </View>
  );
}
