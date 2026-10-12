import { useTranslation } from 'react-i18next';

import { JournalScreen } from '@/components/journal/journal-screen';
import { usePageTitle } from '@/lib/use-page-title';

// /journal[?tab=diary|bookmarks|notes]: the listener's diary, bookmarks and notes on every
// signed-in server. Kept for links made before the You hub, whose Journal section
// (`openJournal`) is the way in now.
export default function JournalRoute() {
  const { t } = useTranslation();
  usePageTitle(t('journal.title'));
  return <JournalScreen />;
}
