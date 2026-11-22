import { useToggleFavourite } from '@/api/hooks';
import { toast } from '@/components/ui/toast';
import i18n from '@/i18n';

/** A heart on a book, folder or the favourites list reports a failed change even
 * when its row has already disappeared from the list. The text is read when it fails,
 * so a row in a long list adds no language subscription of its own. */
export function useFavouriteAction(connectionId?: string) {
  return useToggleFavourite(connectionId, () => {
    toast({ title: i18n.t('library.favourite.failed') });
  }).mutate;
}
