import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { ApiKey } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { touchTarget } from '@/components/ui/touch-target';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

import { AccountSectionHead } from './section-head';
import type { ApiKeysManager } from './use-api-keys-manager';

/** A small button's drawn height in rem (`h-[30px]` on the web's 16 px rem). */
const SM_BUTTON_REM = 30 / 16;

/**
 * "Personal API keys": this connection's keys with when each was made and last used,
 * "Create key" (a name in {@link NewKeyDialog}; the secret is then revealed once by the
 * page's `ApiKeyCreatedModal`), and Revoke (confirmed by the page's dialog). Rendered
 * only where the server has `api_keys` and the account isn't a demo one; without the
 * capability the page shows {@link ApiKeysUnavailable} instead.
 *
 * State lives in `useApiKeysManager` (owned by the page, which renders the reveal and
 * the revoke confirmation); this component is the view over it.
 */
export function ApiKeysSection({ manager }: { manager: ApiKeysManager }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  return (
    <View className="gap-3">
      <AccountSectionHead
        title={t('settings.apiKeys.label')}
        sub={t('settings.apiKeys.sub')}
        action={
          <Button
            variant="outline"
            size="sm"
            icon="plus"
            title={t('settings.apiKeys.create')}
            onPress={() => setCreating(true)}
          />
        }
      />
      <Card className="overflow-hidden p-0">
        {manager.isLoading ? (
          <View className="gap-2 p-5" testID="api-keys-loading">
            <Skeleton className="h-3.5 w-1/3 rounded-sm" />
            <Skeleton className="h-3 w-2/3 rounded-sm" />
          </View>
        ) : manager.isError ? (
          <Text variant="muted" className="p-5">
            {t('settings.apiKeys.loadError')}
          </Text>
        ) : manager.keys.length === 0 ? (
          <Text variant="muted" className="p-5">
            {t('settings.apiKeys.empty')}
          </Text>
        ) : (
          manager.keys.map((k, i) => (
            <ApiKeyRow
              key={k.id}
              apiKey={k}
              first={i === 0}
              onRevoke={() => manager.requestRevoke(k)}
            />
          ))
        )}
      </Card>
      {manager.revokeError ? (
        <Text className="text-sm text-destructive" accessibilityLiveRegion="polite">
          {manager.revokeError}
        </Text>
      ) : null}
      <NewKeyDialog open={creating} onClose={() => setCreating(false)} manager={manager} />
    </View>
  );
}

/** The calm notice for a server without `api_keys` (an older one). */
export function ApiKeysUnavailable({ serverName }: { serverName: string }) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <AccountSectionHead title={t('settings.apiKeys.label')} sub={t('settings.apiKeys.sub')} />
      <Notice
        icon="circle-info"
        title={t('settings.apiKeys.unavailable.title', { server: serverName })}
        body={t('settings.apiKeys.unavailable.body')}
      />
    </View>
  );
}

function ApiKeyRow({
  apiKey,
  first,
  onRevoke,
}: {
  apiKey: ApiKey;
  first: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const target = touchTarget(SM_BUTTON_REM);
  return (
    <View
      className={cn('flex-row items-center gap-3 px-4 py-3', !first && 'border-t border-border')}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={1}>
          {apiKey.label}
        </Text>
        <Text variant="caption" numberOfLines={2}>
          {t('settings.apiKeys.created', { when: formatRelative(apiKey.created_at) })}
          {' · '}
          {apiKey.last_seen
            ? t('settings.apiKeys.lastUsed', { when: formatRelative(apiKey.last_seen) })
            : t('settings.apiKeys.neverUsed')}
        </Text>
      </View>
      <Button
        size="sm"
        variant="ghost"
        title={t('settings.apiKeys.revokeShort')}
        accessibilityLabel={t('settings.apiKeys.revoke', { name: apiKey.label })}
        hitSlop={target.hitSlop}
        className={target.frameClass}
        onPress={onRevoke}
      />
    </View>
  );
}

/** Names a new key, in a dialog (a bottom sheet on a phone, above the keyboard). It
 * closes once the key exists, and the page reveals the secret. */
function NewKeyDialog({
  open,
  onClose,
  manager,
}: {
  open: boolean;
  onClose: () => void;
  manager: ApiKeysManager;
}) {
  const { t } = useTranslation();
  const submit = async () => {
    if (await manager.create()) onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.apiKeys.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('settings.apiKeys.hint')}</DialogDescription>
        </DialogHeader>
        <Input
          label={t('settings.apiKeys.nameLabel')}
          placeholder={t('settings.apiKeys.namePlaceholder')}
          autoCapitalize="none"
          value={manager.label}
          onChangeText={manager.setLabel}
          error={manager.createError ?? undefined}
          onSubmitEditing={() => void submit()}
        />
        <DialogFooter>
          <Button title={t('common.cancel')} variant="ghost" onPress={onClose} />
          <Button
            title={t('settings.apiKeys.create')}
            icon="plus"
            loading={manager.createBusy}
            disabled={!manager.canCreate}
            onPress={() => void submit()}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
