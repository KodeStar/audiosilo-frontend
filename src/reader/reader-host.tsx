import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Notice } from '@/components/ui/notice';

import type { ReaderHostProps } from './reader-host-types';

/**
 * The native reader host's placeholder until Bridge Phase 3b-2 brings the WebView host:
 * Read is offered on the web only (`canRead`), so only a link from elsewhere lands here,
 * and it says so instead of showing an empty page.
 */
export function ReaderHost(_props: ReaderHostProps) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 justify-center p-4">
      <Notice icon="book-open" title={t('reader.nativeTitle')} body={t('reader.nativeBody')} />
    </View>
  );
}
