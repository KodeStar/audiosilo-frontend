import { Button } from './button';
import { Card } from './card';
import { Text } from './text';

export function ErrorNote({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <Card className="gap-3">
      <Text className="text-red-500">{message ?? 'Something went wrong.'}</Text>
      {onRetry ? <Button title="Retry" variant="secondary" onPress={onRetry} /> : null}
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
