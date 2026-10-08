import { Text as RNText, type TextProps } from 'react-native';

import { cn } from '@/lib/utils';

/** How far a story card's type may grow with the system text size: the card is a fixed
 * 9:16 picture, so its words can't reflow past the edge (each card's words are also
 * read out whole: see `cardSpeech`). */
export const STORY_FONT_SCALE_MAX = 1.25;

/**
 * Type on a story card: white on the card's deep ground in both themes (a card is a
 * printed object, like a cover), sized by the card (callers pass the size in `style`,
 * scaled with the card's width). Not the themed `<Text>`: its roles are sized for pages.
 */
export function StoryText({ className, ...props }: TextProps & { className?: string }) {
  return (
    <RNText
      maxFontSizeMultiplier={STORY_FONT_SCALE_MAX}
      className={cn('font-sans text-white', className)}
      {...props}
    />
  );
}
