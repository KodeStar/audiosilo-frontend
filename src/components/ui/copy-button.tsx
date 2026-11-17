import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

import { Button, type ButtonProps } from './button';
import { Text } from './text';

/**
 * A Copy button for `text`: it reads "Copied" with a check once the text reached the
 * clipboard, and goes back to `title` when the text changes (a renewed link, another
 * secret). `copyText` opens the share sheet where there is no clipboard (native), which
 * confirms nothing, so the button then stays as it was.
 */
export function CopyButton({
  text,
  title,
  ...rest
}: { text: string; title: string } & Omit<ButtonProps, 'title' | 'icon' | 'onPress' | 'children'>) {
  const { t } = useTranslation();
  // The text that was copied, so a new one reads "Copy" again with no effect.
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copied = copiedText === text;
  return (
    <Button
      {...rest}
      icon={copied ? 'check' : 'copy'}
      title={copied ? t('common.copied') : title}
      onPress={() =>
        void copyText(text).then((ok) => {
          if (ok) setCopiedText(text);
        })
      }
    />
  );
}

/**
 * A link or secret shown to be read and selected (a calendar link, an API key): monospaced,
 * on the muted box. The box is on a wrapper, not the Text: a clamped Text with padding shows
 * a sliver of its next line in the bottom padding (web).
 */
export function CodeBox({
  children,
  numberOfLines,
  className,
  textClassName,
  testID,
}: {
  children: string | undefined;
  numberOfLines?: number;
  className?: string;
  textClassName?: string;
  testID?: string;
}) {
  return (
    <View className={cn('rounded-control bg-muted px-3 py-2.5', className)}>
      <Text
        selectable
        variant="mono"
        numberOfLines={numberOfLines}
        className={textClassName}
        testID={testID}
      >
        {children}
      </Text>
    </View>
  );
}
