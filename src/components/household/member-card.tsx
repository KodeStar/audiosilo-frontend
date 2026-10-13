import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import {
  CapabilityError,
  useDeleteMember,
  useMemberDevices,
  useRevokeMemberDevice,
  useUpdateMember,
} from '@/api/hooks';
import type { HouseholdMember, MemberAccess, MyDevice } from '@/api/types';
import { deviceGlyph, signedInSessions } from '@/components/account/account-model';
import { AccountListRow } from '@/components/account/account-list-row';
import { deviceDetail, deviceName } from '@/components/account/devices-section';
import { profileName } from '@/components/profiles/profiles-model';
import { RenameDialog } from '@/components/profiles/rename-dialog';
import { useRemovePerson } from '@/components/profiles/use-remove-person';
import { Portrait } from '@/components/series/portrait';
import { SettingRow, SettingsCard } from '@/components/settings/settings-row';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIcon,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useOpen } from '@/lib/open';
import { useNow } from '@/lib/use-now';
import { profileOf, renameProfile } from '@/stores/profiles';
import { type Connection, useSession } from '@/stores/session';

import { AccessPicker, memberBooksName } from './access-picker';
import {
  collectionIdsFor,
  confirmsName,
  createsBooks,
  memberConnection,
  writeError,
  writeErrorText,
} from './household-model';
import { MemberPairing } from './member-pairing';
import { booksRunText, useMemberBooks } from './use-member-books';
import { hereFailure, useSignInHere } from './use-sign-in-here';

/** Which of the card's confirmations or dialogs is open. */
type Open =
  null | 'access' | 'kid' | 'qr' | 'rename' | 'delete' | 'deleteTyped' | { revoke: MyDevice };

/**
 * One household member the person listening manages (Phase 8b-1, the Household page): who
 * they are, what they can listen to (everything the owner can, or the collections shared
 * with them, each opening its page) with Change, the Kids switch (turning it on confirms
 * that their password and API keys go), their devices (each with Sign out), "Set up their
 * own device" (their pairing code), "Sign in on this device" when they aren't here yet,
 * Rename, and "Delete their account" (confirmed twice, the second time by typing their
 * name), kept apart from "Remove from this device" (this device's profile only).
 */
export function MemberCard({
  connection,
  member,
}: {
  connection: Connection;
  member: HouseholdMember;
}) {
  const { t } = useTranslation();
  const cid = connection.id;
  const server = connection.name;
  const name = member.name;
  const update = useUpdateMember(cid);
  const remove = useDeleteMember(cid);
  const signIn = useSignInHere(connection);
  const books = useMemberBooks(cid);
  const removal = useRemovePerson();
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  // Signed in on this device (as a person of their own), by server and user id.
  const here = useSession((s) => memberConnection(s.connections, connection, member.id));
  const hereProfile = here ? profileOf(here.id) : null;
  const kid = member.kind === 'kid';

  /** Say a write was refused and changed nothing (a toast: "Couldn't change <Name>'s
   * account" unless `title` says otherwise, then why), unless it was never sent. */
  const refused = (e: unknown, say: { title?: string; description?: string } = {}) => {
    if (e instanceof CapabilityError) return;
    toast({
      title: say.title ?? t('household.card.failed', { name }),
      description: say.description ?? writeErrorText(e, server, t),
    });
  };

  /** Change the member; false (and a toast saying nothing changed) when refused. */
  const change = async (body: Parameters<typeof update.mutateAsync>[0]['body']) => {
    try {
      await update.mutateAsync({ id: member.id, body });
      return true;
    } catch (e) {
      refused(e);
      return false;
    }
  };

  /** "What can they listen to?" saved: "<Name>'s books" first when it was chosen (its id
   * joins the set), deleted again when the change is refused (`useMemberBooks`). */
  const saveAccess = async (access: MemberAccess, ids: number[], newBooks: boolean) => {
    const booksName = createsBooks(access, newBooks) ? memberBooksName(name, t) : null;
    const run = await books.run(booksName, (newId) =>
      update.mutateAsync({
        id: member.id,
        body: {
          access,
          collection_ids: collectionIdsFor(access, newId === null ? ids : [...ids, newId]),
        },
      }),
    );
    if (run.ok) {
      close();
      return;
    }
    refused(run.error, { description: booksRunText(run, { server, booksName }, t) });
  };

  /** Renamed on the server: their profile on this device (when they are here) takes the
   * new name too, so the owner's change shows everywhere they look. */
  const rename = async (next: string) => {
    if (!(await change({ name: next }))) return false;
    if (hereProfile) renameProfile(hereProfile.id, next);
    return true;
  };

  const makeKid = async () => {
    close();
    await change({ kind: 'kid' });
  };

  const deleteAccount = async () => {
    try {
      await remove.mutateAsync(member.id);
      close();
      toast({ title: t('household.delete.done', { name }) });
    } catch (e) {
      if (writeError(e) === 'gone') {
        // Gone already (deleted from another device): the list catches up
        // (`useDeleteMember`).
        close();
        return;
      }
      refused(e, { title: t('household.delete.failed', { name }) });
    }
  };

  const signInHere = async () => {
    const result = await signIn.run(member);
    toast({
      title:
        result.status === 'done'
          ? t('household.here.done', { name })
          : hereFailure(result, name, t),
    });
  };

  return (
    <SettingsCard testID={`member-${member.id}`}>
      <View className="flex-row items-center gap-3 py-3.5">
        <Portrait name={name} kind="user" size={36} />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="label" numberOfLines={1} accessibilityRole="header">
            {name}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {t('household.card.who', {
              kind: t(kid ? 'household.kind.kid' : 'household.kind.grownup'),
              username: member.username,
            })}
          </Text>
        </View>
        {here ? (
          <Badge variant="secondary">
            <Text>{t('household.card.onThisDevice')}</Text>
          </Badge>
        ) : null}
      </View>

      <SettingRow
        testID={`member-access-${member.id}`}
        control="block"
        label={t('household.card.access')}
        description={<AccessSummary connectionId={cid} member={member} />}
      >
        <Button
          title={t('household.card.change')}
          accessibilityLabel={t('household.card.changeA11y', { name })}
          variant="outline"
          size="sm"
          className="self-start"
          onPress={() => setOpen('access')}
        />
      </SettingRow>

      <SettingRow label={t('household.card.kid')} description={t('household.card.kidBody')}>
        <Switch
          testID={`member-kid-${member.id}`}
          checked={kid}
          disabled={update.isPending}
          onCheckedChange={(on) => (on ? setOpen('kid') : void change({ kind: 'grownup' }))}
          accessibilityLabel={t('household.card.kidA11y', { name })}
        />
      </SettingRow>

      <SettingRow control="block" label={t('household.card.devices')}>
        <MemberDevices
          connectionId={cid}
          member={member}
          onRevoke={(d) => setOpen({ revoke: d })}
        />
        <View className="mt-2 flex-row flex-wrap gap-2">
          <Button
            testID={`member-setup-${member.id}`}
            title={t('household.card.setUp')}
            accessibilityLabel={t('household.card.setUpA11y', { name })}
            variant="outline"
            size="sm"
            icon="qrcode"
            onPress={() => setOpen('qr')}
          />
          {here ? null : (
            <Button
              testID={`member-here-${member.id}`}
              title={t('household.card.signInHere')}
              accessibilityLabel={t('household.card.signInHereA11y', { name })}
              variant="ghost"
              size="sm"
              icon="plus"
              loading={signIn.busy}
              onPress={() => void signInHere()}
            />
          )}
        </View>
      </SettingRow>

      <SettingRow label={t('profiles.rename.label')} description={name}>
        <Button
          title={t('profiles.rename.action')}
          accessibilityLabel={t('profiles.rename.title', { name })}
          variant="ghost"
          size="sm"
          icon="pen"
          onPress={() => setOpen('rename')}
        />
      </SettingRow>

      <SettingRow
        control="block"
        label={t('household.delete.label')}
        description={t('household.delete.hint', { name, server })}
      >
        <View className="flex-row flex-wrap gap-2">
          <Button
            testID={`member-delete-${member.id}`}
            title={t('household.delete.action')}
            accessibilityLabel={t('household.delete.a11y', { name })}
            variant="destructive-outline"
            size="sm"
            icon="trash"
            onPress={() => setOpen('delete')}
          />
          {here && hereProfile ? (
            <Button
              testID={`member-remove-${member.id}`}
              title={t('profiles.remove.action')}
              accessibilityLabel={t('profiles.remove.a11y', { name: profileName(hereProfile, t) })}
              variant="ghost"
              size="sm"
              icon="logout"
              onPress={() => void removal.request(hereProfile, profileName(hereProfile, t))}
            />
          ) : null}
        </View>
      </SettingRow>

      <AccessDialog
        open={open === 'access'}
        connectionId={cid}
        serverName={server}
        member={member}
        onSave={saveAccess}
        onClose={close}
      />
      <ConfirmDialog
        visible={open === 'kid'}
        title={t('household.card.kidConfirm.title', { name })}
        message={t('household.card.kidConfirm.body')}
        confirmLabel={t('household.card.kidConfirm.confirm')}
        confirmIcon="key"
        onConfirm={() => void makeKid()}
        onCancel={close}
      />
      <Dialog open={open === 'qr'} onOpenChange={(o) => !o && close()}>
        {open === 'qr' ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('household.qr.title', { name })}</DialogTitle>
              <DialogDescription>{t('household.qr.lead', { name, server })}</DialogDescription>
            </DialogHeader>
            <MemberPairing connectionId={cid} serverName={server} member={member} />
            <DialogFooter>
              <Button
                testID={`member-qr-done-${member.id}`}
                title={t('common.done')}
                onPress={close}
              />
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      <RenameDialog
        open={open === 'rename'}
        name={name}
        body={
          hereProfile
            ? t('household.card.renameBodyHere', { server })
            : t('household.card.renameBody', { server })
        }
        onSave={rename}
        onClose={close}
      />
      <ConfirmDialog
        visible={open === 'delete'}
        title={t('household.delete.title', { name })}
        message={t('household.delete.body', { name, server })}
        confirmLabel={t('household.delete.continue')}
        confirmIcon="trash"
        destructive
        onConfirm={() => setOpen('deleteTyped')}
        onCancel={close}
      />
      <DeleteTypedDialog
        open={open === 'deleteTyped'}
        member={member}
        onThisDevice={here !== undefined}
        busy={remove.isPending}
        onDelete={() => void deleteAccount()}
        onClose={close}
      />
      <RevokeMemberDevice
        connectionId={cid}
        member={member}
        device={typeof open === 'object' && open ? open.revoke : null}
        onClose={close}
      />
      {removal.dialog}
    </SettingsCard>
  );
}

/** What a member can listen to: everything the owner can, or the collections shared with
 * them, each opening its page (none yet: says so). */
function AccessSummary({
  connectionId,
  member,
}: {
  connectionId: string;
  member: HouseholdMember;
}) {
  const { t } = useTranslation();
  const { openCollection } = useOpen();
  if (member.access === 'all') {
    return <Text variant="caption">{t('household.card.everything')}</Text>;
  }
  const collections = member.collections ?? [];
  if (collections.length === 0) {
    return <Text variant="caption">{t('household.card.noCollections')}</Text>;
  }
  return (
    <View className="gap-1">
      <Text variant="caption">{t('household.card.onlyCollections')}</Text>
      <View className="flex-row flex-wrap gap-x-3" accessibilityRole="list">
        {collections.map((c) => (
          <Button
            key={c.id}
            testID={`member-collection-${c.id}`}
            variant="link"
            size="sm"
            className="px-0"
            title={t('household.card.collection', { name: c.name, count: c.items })}
            accessibilityLabel={t('household.card.openCollection', { name: c.name })}
            onPress={() => openCollection(connectionId, c.id)}
          />
        ))}
      </View>
    </View>
  );
}

/** A member's signed-in devices, each with Sign out; loading, error and none states. */
function MemberDevices({
  connectionId,
  member,
  onRevoke,
}: {
  connectionId: string;
  member: HouseholdMember;
  onRevoke: (d: MyDevice) => void;
}) {
  const { t } = useTranslation();
  const devices = useMemberDevices(member.id, connectionId);
  const now = useNow(60_000);
  const rows = signedInSessions(devices.data);
  if (devices.isError) {
    return (
      <View className="gap-2" testID={`member-devices-error-${member.id}`}>
        <Text variant="caption">{t('household.card.devicesFailed', { name: member.name })}</Text>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          title={t('common.retry')}
          onPress={() => void devices.refetch()}
        />
      </View>
    );
  }
  if (devices.isPending) {
    return (
      <View className="gap-2" testID={`member-devices-loading-${member.id}`}>
        <Skeleton className="h-3.5 w-1/2 rounded-sm" />
        <Skeleton className="h-3 w-2/3 rounded-sm" />
      </View>
    );
  }
  if (rows.length === 0) {
    return <Text variant="caption">{t('household.card.noDevices', { name: member.name })}</Text>;
  }
  return (
    <View className="overflow-hidden rounded-xl border border-border" accessibilityRole="list">
      {rows.map((d, i) => {
        const device = deviceName(d, t);
        return (
          <AccountListRow
            key={d.id}
            testID={`member-device-${d.id}`}
            icon={deviceGlyph(d)}
            title={device}
            detail={deviceDetail(d, t, now)}
            first={i === 0}
            action={{
              title: t('account.devices.signOut'),
              accessibilityLabel: t('household.devices.signOutA11y', {
                name: member.name,
                device,
              }),
              onPress: () => onRevoke(d),
            }}
          />
        );
      })}
    </View>
  );
}

/** "Sign Evie out of Kitchen iPad?", then the sign-out and a toast. */
function RevokeMemberDevice({
  connectionId,
  member,
  device,
  onClose,
}: {
  connectionId: string;
  member: HouseholdMember;
  device: MyDevice | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const revoke = useRevokeMemberDevice(connectionId);
  const name = member.name;
  const label = device ? deviceName(device, t) : '';
  const confirm = async () => {
    if (!device) return;
    onClose();
    try {
      await revoke.mutateAsync({ id: member.id, deviceId: device.id });
      toast({ title: t('household.devices.done', { name, device: label }) });
    } catch (e) {
      if (e instanceof CapabilityError) return;
      // Signed out already (404): the lists are read again whatever the answer
      // (`useRevokeMemberDevice`).
      const why = writeError(e);
      if (why === 'gone') {
        toast({ title: t('account.devices.gone', { name: label }) });
        return;
      }
      toast({
        title: t('account.devices.failed', { name: label }),
        ...(why === 'tooMany' ? { description: t('common.tooManyTries') } : {}),
      });
    }
  };
  return (
    <ConfirmDialog
      visible={device !== null}
      title={t('household.devices.confirmTitle', { name, device: label })}
      message={t('household.devices.confirmBody', { name, device: label })}
      confirmLabel={t('account.devices.confirm.confirm')}
      confirmIcon="logout"
      destructive
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}

/** "What can they listen to?" for an existing member: the same picker as the add form
 * (without its own heading: the dialog's title asks the question), saved as one change
 * (access and, for collections, the full set to share, "<Name>'s books" created first
 * when chosen). */
function AccessDialog({
  open,
  connectionId,
  serverName,
  member,
  onSave,
  onClose,
}: {
  open: boolean;
  connectionId: string;
  serverName: string;
  member: HouseholdMember;
  onSave: (access: MemberAccess, ids: number[], newBooks: boolean) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open ? (
        <AccessBody
          connectionId={connectionId}
          serverName={serverName}
          member={member}
          onSave={onSave}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function AccessBody({
  connectionId,
  serverName,
  member,
  onSave,
  onClose,
}: {
  connectionId: string;
  serverName: string;
  member: HouseholdMember;
  onSave: (access: MemberAccess, ids: number[], newBooks: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [access, setAccess] = useState(member.access);
  const [ids, setIds] = useState(() => (member.collections ?? []).map((c) => c.id));
  const [newBooks, setNewBooks] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(access, ids, newBooks);
    } finally {
      setSaving(false);
    }
  };
  return (
    <DialogContent testID="member-access-dialog">
      <DialogHeader>
        <DialogTitle>{t('household.card.accessTitle', { name: member.name })}</DialogTitle>
      </DialogHeader>
      <ScrollView className="max-h-[440px]" keyboardShouldPersistTaps="handled">
        <AccessPicker
          connectionId={connectionId}
          serverName={serverName}
          name={member.name}
          access={access}
          collectionIds={ids}
          newBooks={newBooks}
          showTitle={false}
          onAccess={setAccess}
          onCollections={setIds}
          onNewBooks={setNewBooks}
        />
      </ScrollView>
      <DialogFooter>
        <Button title={t('common.cancel')} variant="ghost" onPress={onClose} />
        <Button
          testID="member-access-save"
          title={t('common.save')}
          loading={saving}
          onPress={() => void save()}
        />
      </DialogFooter>
    </DialogContent>
  );
}

/** The second confirmation of "Delete their account": type their name. */
function DeleteTypedDialog({
  open,
  member,
  onThisDevice,
  busy,
  onDelete,
  onClose,
}: {
  open: boolean;
  member: HouseholdMember;
  onThisDevice: boolean;
  busy: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open ? (
        <DeleteTypedBody
          member={member}
          onThisDevice={onThisDevice}
          busy={busy}
          onDelete={onDelete}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function DeleteTypedBody({
  member,
  onThisDevice,
  busy,
  onDelete,
  onClose,
}: {
  member: HouseholdMember;
  onThisDevice: boolean;
  busy: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const name = member.name;
  const ok = confirmsName(typed, member);
  return (
    <DialogContent testID="member-delete-typed">
      <View className="flex-row items-start gap-3.5">
        <DialogIcon name="trash" tone="destructive" />
        <DialogHeader className="flex-1">
          <DialogTitle>{t('household.delete.typedTitle', { name })}</DialogTitle>
          <DialogDescription>{t('household.delete.typedBody', { name })}</DialogDescription>
        </DialogHeader>
      </View>
      {onThisDevice ? (
        <Text variant="muted">{t('household.delete.alsoHere', { name })}</Text>
      ) : null}
      <Input
        testID="member-delete-field"
        label={t('household.delete.field', { name })}
        value={typed}
        onChangeText={setTyped}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={() => ok && onDelete()}
      />
      <DialogFooter>
        <Button title={t('common.cancel')} variant="ghost" onPress={onClose} />
        <Button
          testID="member-delete-confirm"
          title={t('household.delete.confirm')}
          variant="destructive"
          icon="trash"
          disabled={!ok}
          loading={busy}
          onPress={onDelete}
        />
      </DialogFooter>
    </DialogContent>
  );
}
