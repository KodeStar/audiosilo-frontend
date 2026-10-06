import { matchRange } from '@/components/shell/palette-model';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/** A name or title with the query's first match bold in `brand-ink` (Search and the
 * palette). */
export function Highlighted({
  text,
  query,
  numberOfLines = 1,
  display = false,
}: {
  text: string;
  query: string;
  numberOfLines?: number;
  /** Set in the display face (a series card's name), which is bold already. */
  display?: boolean;
}) {
  const range = matchRange(text, query);
  const face = display ? 'font-display text-[17px] tracking-tight' : undefined;
  return (
    <Text variant="label" numberOfLines={numberOfLines} className={face}>
      {range ? (
        <>
          {text.slice(0, range[0])}
          {/* `label` like the line around it: a bare <Text> would apply the `body`
              variant's larger size to the match. */}
          <Text
            variant="label"
            className={cn(face, display ? 'text-brand-ink' : 'font-sans-bold text-brand-ink')}
          >
            {text.slice(range[0], range[1])}
          </Text>
          {text.slice(range[1])}
        </>
      ) : (
        text
      )}
    </Text>
  );
}
