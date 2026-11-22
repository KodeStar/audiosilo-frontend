import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { ApiKey } from '@/api/types';
import { OfflineState } from '@/components/layout/offline-state';
import { serverRefusalState } from '@/components/layout/server-refusal-state';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { FormError } from '@/components/ui/form-error';
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
import { SectionTitle } from '@/components/ui/section-title';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { formatRelative } from '@/lib/format';

import { AccountListRow } from './account-list-row';
import type { ApiKeysManager } from './use-api-keys-manager';

/** "Created 3 days ago · Last used 2 hours ago". */
function keyDetail(k: ApiKey, t: TFunction): string {
  const used = k.last_seen
    ? t('settings.apiKeys.lastUsed', { when: formatRelative(k.last_seen) })
    : t('settings.apiKeys.neverUsed');
  return `${t('settings.apiKeys.created', { when: formatRelative(k.created_at) })} · ${used}`;
}

/**
 * "Personal API keys": this connection's keys with when each was made and last used,
 * "Create key" (a name in {@link NewKeyAction}; the secret is then revealed once by the
 * page's `ApiKeyCreatedModal`), and Revoke (confirmed by the page's dialog). Rendered
 * for eligible accounts even when the server's capabilities cannot be read. With a
 * known false flag the page shows {@link ApiKeysUnavailable}.
 *
 * State lives in `useApiKeysManager` (owned by the page, which renders the reveal and
 * the revoke confirmation); this component is the view over it.
 */
export function ApiKeysSection({
  manager,
  supported,
  connectionId,
}: {
  manager: ApiKeysManager;
  supported: boolean;
  connectionId: string;
}) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <SectionTitle
        title={t('settings.apiKeys.label')}
        sub={t('settings.apiKeys.sub')}
        action={supported && <NewKeyAction manager={manager} />}
      />
      <Card className="overflow-hidden p-0">
        {manager.unread === 'offline' ? (
          <OfflineState className="py-6" />
        ) : manager.unread === 'failed' ? (
          (serverRefusalState(manager.error, connectionId) ?? (
            <Text variant="muted" className="p-5">
              {t('settings.apiKeys.loadError')}
            </Text>
          ))
        ) : manager.isLoading ? (
          <View className="gap-2 p-5" testID="api-keys-loading">
            <Skeleton className="h-3.5 w-1/3 rounded-sm" />
            <Skeleton className="h-3 w-2/3 rounded-sm" />
          </View>
        ) : manager.keys.length === 0 ? (
          <Text variant="muted" className="p-5">
            {t('settings.apiKeys.empty')}
          </Text>
        ) : (
          manager.keys.map((k, i) => (
            <AccountListRow
              key={k.id}
              icon="key"
              title={k.label}
              detail={keyDetail(k, t)}
              first={i === 0}
              action={
                supported
                  ? {
                      title: t('settings.apiKeys.revokeShort'),
                      accessibilityLabel: t('settings.apiKeys.revoke', { name: k.label }),
                      onPress: () => manager.requestRevoke(k),
                    }
                  : undefined
              }
            />
          ))
        )}
      </Card>
      <FormError error={manager.revokeError} />
    </View>
  );
}

/** The calm notice for a server without `api_keys` (an older one). */
export function ApiKeysUnavailable({ serverName }: { serverName: string }) {
  const { t } = useTranslation();
  return (
    <View className="gap-3">
      <SectionTitle title={t('settings.apiKeys.label')} sub={t('settings.apiKeys.sub')} />
      <Notice
        icon="circle-info"
        title={t('settings.apiKeys.unavailable.title', { server: serverName })}
        body={t('settings.apiKeys.unavailable.body')}
      />
    </View>
  );
}

/** Unmounting this action closes its dialog if the account loses the capability. */
function NewKeyAction({ manager }: { manager: ApiKeysManager }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const submit = async () => {
    if (await manager.create()) setOpen(false);
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        icon="plus"
        title={t('settings.apiKeys.create')}
        onPress={() => setOpen(true)}
      />
      <Dialog open={open} onOpenChange={setOpen}>
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
            <Button title={t('common.cancel')} variant="ghost" onPress={() => setOpen(false)} />
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
    </>
  );
}
