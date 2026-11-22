import { useTranslation } from 'react-i18next';

import { useToggleFavourite } from '@/api/hooks';
import { toast } from '@/components/ui/toast';

/** A heart on a book, folder or the favourites list reports a failed change even
 * when its row has already disappeared from the list. */
export function useFavouriteAction(connectionId?: string) {
  const { t } = useTranslation();
  return useToggleFavourite(connectionId, () => {
    toast({ title: t('library.favourite.failed') });
  }).mutate;
}
