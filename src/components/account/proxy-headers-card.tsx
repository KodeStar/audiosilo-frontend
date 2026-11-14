import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { ProxyHeadersEditor } from '@/components/connect/proxy-headers-editor';
import {
  draftOf,
  draftProblems,
  draftToSet,
  type HeaderDraftRow,
  proxyOriginChoices,
} from '@/components/connect/proxy-headers-model';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormError } from '@/components/ui/form-error';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { hostOf } from '@/lib/pairing';
import { MASKED_PROXY_VALUE } from '@/lib/proxy-headers';
import { cn } from '@/lib/utils';
import { useSession } from '@/stores/session';

/**
 * "Proxy headers" (fe#167): custom headers for an auth proxy in front of this server
 * (Cloudflare Access, Authentik, Authelia and the like), sent to one of its addresses only.
 * Shown whatever the server's flags: it is needed most when the proxy turns every request
 * away. Values are never shown, not even while editing (a stored value's field says
 * "Kept as it is"). Saving rebuilds the connection's clients, and what failed is read again.
 */
export function ProxyHeadersCard({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation();
  const conn = useSession((s) => s.connections.find((c) => c.id === connectionId));
  const setProxyHeaders = useSession((s) => s.setProxyHeaders);
  const [rows, setRows] = useState<HeaderDraftRow[] | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  if (!conn) return null;

  const set = conn.proxyHeaders;
  const choices = proxyOriginChoices(conn);
  const editing = rows !== null;
  const target = origin ?? choices[0] ?? null;

  const startEdit = () => {
    setRows(draftOf(set));
    setOrigin(set?.origin ?? choices[0] ?? null);
    setTried(false);
    setError(null);
  };
  const stopEdit = () => {
    setRows(null);
    setTried(false);
    setError(null);
  };
  const save = async () => {
    if (!rows) return;
    setTried(true);
    if (draftProblems(rows).some(Boolean)) return;
    setSaving(true);
    setError(null);
    try {
      await setProxyHeaders(connectionId, draftToSet(target, rows));
      stopEdit();
    } catch {
      setError(t('proxyHeaders.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    setConfirmRemove(false);
    try {
      await setProxyHeaders(connectionId, null);
    } catch {
      setError(t('proxyHeaders.saveFailed'));
    }
  };

  return (
    <Card className="gap-3" testID="proxy-headers-card">
      <View className="gap-0.5">
        <Text variant="title" accessibilityRole="header">
          {t('proxyHeaders.title')}
        </Text>
        <Text variant="muted">
          {set && !editing
            ? t('proxyHeaders.sentTo', { origin: set.origin })
            : t('proxyHeaders.body')}
        </Text>
      </View>

      {editing ? (
        <View className="gap-3">
          {choices.length > 1 && target ? (
            <View className="gap-1.5">
              <Text variant="eyebrow">{t('proxyHeaders.sendTo')}</Text>
              <SegmentedControl
                scrollable
                accessibilityLabel={t('proxyHeaders.sendTo')}
                options={choices.map((o) => ({ value: o, label: hostOf(o) }))}
                value={target}
                onChange={setOrigin}
                className="max-w-full self-start"
              />
            </View>
          ) : null}
          <ProxyHeadersEditor rows={rows} onChange={setRows} showProblems={tried} />
          <View className="flex-row flex-wrap gap-2">
            <Button
              title={t('proxyHeaders.save')}
              loading={saving}
              disabled={saving}
              onPress={() => void save()}
              testID="proxy-headers-save"
            />
            <Button variant="ghost" title={t('common.cancel')} onPress={stopEdit} />
          </View>
        </View>
      ) : set ? (
        <View className="gap-3">
          <View className="overflow-hidden rounded-card border border-border">
            {set.headers.map((h, i) => (
              <View
                key={h.name}
                accessible
                accessibilityLabel={t('proxyHeaders.hiddenValue', { name: h.name })}
                className={cn(
                  'flex-row items-center gap-3 px-4 py-3',
                  i > 0 && 'border-t border-border',
                )}
              >
                <Text variant="mono" className="min-w-0 flex-1" numberOfLines={1}>
                  {h.name}
                </Text>
                <Text variant="mono" aria-hidden>
                  {MASKED_PROXY_VALUE}
                </Text>
              </View>
            ))}
          </View>
          <View className="flex-row flex-wrap gap-2">
            <Button
              variant="outline"
              icon="pen"
              title={t('proxyHeaders.edit')}
              onPress={startEdit}
              testID="proxy-headers-edit"
            />
            <Button
              variant="destructive-outline"
              icon="trash"
              title={t('proxyHeaders.removeAll')}
              onPress={() => setConfirmRemove(true)}
              testID="proxy-headers-remove"
            />
          </View>
        </View>
      ) : choices.length === 0 ? (
        // Only an https address takes them, and this connection knows none.
        <Text variant="caption" testID="proxy-headers-https-only">
          {t('proxyHeaders.httpsOnly')}
        </Text>
      ) : (
        <Button
          className="self-start"
          variant="outline"
          icon="key"
          title={t('proxyHeaders.addHeaders')}
          onPress={startEdit}
          testID="proxy-headers-start"
        />
      )}

      <FormError error={error} />
      <Text variant="caption">
        {Platform.OS === 'web' ? t('proxyHeaders.webNote') : t('proxyHeaders.notCarried')}
      </Text>

      <ConfirmDialog
        visible={confirmRemove}
        title={t('proxyHeaders.removeTitle')}
        message={t('proxyHeaders.removeBody')}
        confirmLabel={t('proxyHeaders.removeAll')}
        confirmIcon="trash"
        destructive
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </Card>
  );
}
