import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CapabilityError, useMyRatings, useRating, useSetRating } from '@/api/hooks';
import type { RatingValue } from '@/api/types';
import { savedRating } from '@/components/player/end-credits-logic';
import { toast } from '@/components/ui/toast';

/**
 * A book's rating for its stars (capability `ratings`, which the caller checks): the
 * saved one, and `rate`, which keeps its note. A PUT replaces the whole rating, so the
 * stars wait (`ready` false) until the saved rating, whose note goes back with the new
 * value, is known (`savedRating`: the exact path, else the book holding a part path).
 */
export function useBookRating(connectionId: string, libraryId: number, path: string) {
  const { t } = useTranslation();
  const rating = useRating(libraryId, path, connectionId);
  const mine = useMyRatings(connectionId);
  const saved = savedRating(libraryId, path, rating.data, mine.isError ? [] : mine.data);
  const set = useSetRating(connectionId);
  const [picked, setPicked] = useState<RatingValue | undefined>(undefined);

  const rate = (value: RatingValue) => {
    if (saved === undefined) return;
    setPicked(value);
    set.mutateAsync({ libraryId, path, rating: value, note: saved?.note }).then(
      () => toast({ title: t('player.finished.ratingSaved') }),
      (e: unknown) => {
        setPicked(undefined);
        if (!(e instanceof CapabilityError)) toast({ title: t('player.finished.ratingFailed') });
      },
    );
  };

  return {
    value: picked ?? saved?.rating,
    ready: saved !== undefined && !set.isPending,
    rate,
  };
}
