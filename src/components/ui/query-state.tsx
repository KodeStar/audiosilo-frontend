import { useTranslation } from 'react-i18next';

import { Button } from './button';
import { Card } from './card';
import { Text } from './text';

export function ErrorNote({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <Text className="text-red-500">{message ?? t('ui.error')}</Text>
      {onRetry ? <Button title={t('common.retry')} variant="secondary" onPress={onRetry} /> : null}
    </Card>
  );
}

export function EmptyNote({ message }: { message: string }) {
  return (
    <Card>
      <Text variant="muted">{message}</Text>
    </Card>
  );
}
