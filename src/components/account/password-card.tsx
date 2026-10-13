import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { User } from '@/api/types';
import { Badge } from '@/components/ui/badge';
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
import { Text } from '@/components/ui/text';
import { isKidAccount, managerName } from '@/lib/account';
import { cn } from '@/lib/utils';

import { PW_MIN, type PasswordEditor } from './use-password-editor';

/** What the password card says about an account without a password (8b-1, D8): never
 * how it signed in (a pairing link, a code or a household owner all leave none), only
 * what is true. A kid's account can't have one (the server refuses it): its owner signs it
 * in. A household member's was set up by its owner. */
function noPasswordBody(
  user: Pick<User, 'managed_by' | 'member_kind'> | null | undefined,
  t: TFunction,
): string {
  const owner = managerName(user);
  if (isKidAccount(user)) {
    return owner ? t('account.password.bodyKid', { owner }) : t('account.password.bodyKidNoOwner');
  }
  if (owner) return t('account.password.bodyMember', { owner });
  return t('account.password.bodyNotSet');
}

/** The password card: whether this account has one, and the button that sets or changes
 * it (in {@link PasswordDialog}); none for a kid's account, which can't have one. Hidden
 * for demo accounts by the page. */
export function PasswordCard({
  editor,
  user,
  className,
}: {
  editor: PasswordEditor;
  /** The account's user (`managed_by`, `member_kind`: a household member's copy). */
  user?: Pick<User, 'managed_by' | 'member_kind'> | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const set = editor.hasPassword;
  const kid = isKidAccount(user) && !set;
  return (
    <Card className={cn('gap-3', className)}>
      <View className="flex-row flex-wrap items-center gap-2">
        <Text variant="title" accessibilityRole="header">
          {t('settings.account.password.label')}
        </Text>
        <Badge variant={set ? 'success' : 'warning'}>
          <Text>
            {set ? t('settings.account.password.set') : t('settings.account.password.notSet')}
          </Text>
        </Badge>
      </View>
      <Text variant="muted">{set ? t('account.password.bodySet') : noPasswordBody(user, t)}</Text>
      {kid ? null : (
        <Button
          variant="outline"
          icon="key"
          className="self-start"
          title={
            set ? t('settings.account.password.change') : t('settings.account.password.setNew')
          }
          onPress={editor.openEditor}
        />
      )}
    </Card>
  );
}

/** Sets or changes the password, in a dialog (a bottom sheet on a phone, lifted above
 * the software keyboard on iOS and Android). */
export function PasswordDialog({ editor }: { editor: PasswordEditor }) {
  const { t } = useTranslation();
  const change = editor.hasPassword;
  // The keyboard's Return submits too; `save` says why a short password can't be saved.
  const submit = () => void editor.save();
  return (
    <Dialog open={editor.open} onOpenChange={(open) => !open && editor.close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {change ? t('settings.account.password.change') : t('settings.account.password.setNew')}
          </DialogTitle>
          <DialogDescription>
            {change
              ? t('account.password.dialogChange')
              : t('account.password.dialogSet', { count: PW_MIN })}
          </DialogDescription>
        </DialogHeader>
        <View className="gap-1">
          {change ? (
            <Input
              containerClassName="mb-3"
              label={t('settings.account.password.current')}
              placeholder={t('settings.account.password.currentPlaceholder')}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="current-password"
              textContentType="password"
              value={editor.current}
              onChangeText={editor.setCurrent}
            />
          ) : null}
          <Input
            label={t('settings.account.password.new')}
            placeholder={t('settings.account.password.newPlaceholder', { count: PW_MIN })}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            value={editor.password}
            onChangeText={editor.setPassword}
            onSubmitEditing={submit}
            error={editor.error ?? undefined}
          />
        </View>
        <DialogFooter>
          <Button title={t('common.cancel')} variant="ghost" onPress={editor.close} />
          <Button
            title={t('common.save')}
            loading={editor.busy}
            disabled={!editor.canSave}
            onPress={submit}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
