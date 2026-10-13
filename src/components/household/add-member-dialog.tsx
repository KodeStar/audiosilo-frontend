import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions, View } from 'react-native';

import { qk, useAddMember } from '@/api/hooks';
import type { AddMemberBody, HouseholdMember } from '@/api/types';
import { addMemberHere } from '@/components/connect/add-member-here';
import { profileName } from '@/components/profiles/profiles-model';
import { Button } from '@/components/ui/button';
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
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useLayout } from '@/lib/layout';
import { type Profile, useActiveProfile } from '@/stores/profiles';
import type { Connection } from '@/stores/session';

import { AccessPicker, memberBooksName } from './access-picker';
import {
  type AddForm,
  collectionIdsFor,
  createsBooks,
  listIsStale,
  MEMBER_NAME_MAX,
  newAddForm,
  validMemberName,
  withAccess,
  withKid,
  writeError,
} from './household-model';
import { MemberPairing } from './member-pairing';
import {
  hereFailure,
  type SignInHereResult,
  signInHereFailure,
  useSignInHere,
} from './use-sign-in-here';
import { booksRunText, useMemberBooks } from './use-member-books';

/** Where the add flow is: the form; a kid signed in here (`here`: how that went); a
 * grown-up's pairing code (`here`: "They'll also use this phone", not asked yet = null). */
type Step =
  | { kind: 'form' }
  | { kind: 'kid'; member: HouseholdMember; here: SignInHereResult }
  | { kind: 'grownup'; member: HouseholdMember; here: SignInHereResult | null };

/**
 * "Add someone to your household" (Phase 8b-1), in the shared Dialog (a bottom sheet on a
 * phone that lifts above the software keyboard on iOS and Android; centred on tablet and
 * desktop). The form: their name, Kids, and "What can they listen to?" (decision J: a kid
 * starts on "Only collections I share", a grown-up on "Everything I can listen to", and
 * the choice follows the Kids switch until the owner picks one). Then:
 * - a kid is made with `sign_in_here` and signed in on this device at once
 *   (`addMemberHere`: a profile of their own in kids mode; the owner stays listening),
 *   and, when the owner has no PIN, the dialog offers to set one (`onSetPin`);
 * - a grown-up is made, then shown their pairing code ("Show Ellis this code"), with
 *   "They'll also use this phone" to sign them in here as an ordinary person too.
 * A refused add says why in the form and changes nothing.
 */
export function AddMemberDialog({
  connection,
  onClose,
  onSetPin,
}: {
  /** The owner's connection the member is added on (null: closed). */
  connection: Connection | null;
  onClose: () => void;
  /** Set a PIN for the owner (the person listening): the dialog has closed. */
  onSetPin: (owner: Profile) => void;
}) {
  return (
    <Dialog open={connection !== null} onOpenChange={(o) => !o && onClose()}>
      {connection ? (
        <AddMemberFlow connection={connection} onClose={onClose} onSetPin={onSetPin} />
      ) : null}
    </Dialog>
  );
}

function AddMemberFlow({
  connection,
  onClose,
  onSetPin,
}: {
  connection: Connection;
  onClose: () => void;
  onSetPin: (owner: Profile) => void;
}) {
  const connectionId = connection.id;
  const serverName = connection.name;
  const [step, setStep] = useState<Step>({ kind: 'form' });
  return (
    <DialogContent testID="add-member-dialog">
      {step.kind === 'form' ? (
        <FormStep
          connectionId={connectionId}
          serverName={serverName}
          onCancel={onClose}
          onAdded={setStep}
        />
      ) : step.kind === 'kid' ? (
        <KidStep step={step} onClose={onClose} onSetPin={onSetPin} />
      ) : (
        <GrownUpStep
          step={step}
          connection={connection}
          onHere={(here) => setStep({ ...step, here })}
          onClose={onClose}
        />
      )}
    </DialogContent>
  );
}

/** The form's scroller: the dialog has no height cap of its own on a native phone (only
 * while the keyboard is up, `keyboardCap`), so the fields scroll within most of the
 * window, and shrink (`flexShrink`) under the keyboard's cap so the footer stays on
 * screen. */
function useBodyCap() {
  const { height } = useWindowDimensions();
  return Math.round(height * (useLayout() === 'phone' ? 0.6 : 0.62));
}

function FormStep({
  connectionId,
  serverName,
  onCancel,
  onAdded,
}: {
  connectionId: string;
  serverName: string;
  onCancel: () => void;
  onAdded: (step: Step) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const add = useAddMember(connectionId);
  const books = useMemberBooks(connectionId);
  const [form, setForm] = useState<AddForm>(() => newAddForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cap = useBodyCap();
  const name = form.name.trim();
  const valid = validMemberName(form.name);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    // "Create <Name>'s books": made now, before the member, so its id is in the body;
    // deleted again when the add is refused (`useMemberBooks`).
    const booksName = createsBooks(form.access, form.newBooks) ? memberBooksName(name, t) : null;
    let sent: number[] | undefined;
    const run = await books.run(booksName, (newId) => {
      const chosen = newId === null ? form.collectionIds : [...form.collectionIds, newId];
      sent = collectionIdsFor(form.access, chosen);
      const body: AddMemberBody = {
        name,
        kind: form.kid ? 'kid' : 'grownup',
        access: form.access,
        ...(form.kid ? { sign_in_here: true } : {}),
        ...(sent ? { collection_ids: sent } : {}),
      };
      return add.mutateAsync(body);
    });
    try {
      if (!run.ok) {
        setError(booksRunText(run, { server: serverName, booksName }, t));
        // The cap or the admin's switch changed under the page: show it as it is now.
        if (run.stage === 'write' && listIsStale(writeError(run.error))) {
          void qc.invalidateQueries({ queryKey: qk.householdMembers(connectionId) });
        }
        return;
      }
      const result = run.value;
      // The collections now list them among the people each is shared with.
      if (sent?.length) void qc.invalidateQueries({ queryKey: qk.collections(connectionId) });
      if (!form.kid) {
        onAdded({ kind: 'grownup', member: result.member, here: null });
        return;
      }
      let here: SignInHereResult = { status: 'failed' };
      if (result.session) {
        try {
          await addMemberHere(result.session, { name: result.member.name, kids: true });
          here = { status: 'done' };
        } catch (e) {
          here = signInHereFailure(e, true);
        }
      }
      onAdded({ kind: 'kid', member: result.member, here });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('household.add.title')}</DialogTitle>
        <DialogDescription>{t('household.add.body', { server: serverName })}</DialogDescription>
      </DialogHeader>
      <ScrollView
        style={{ maxHeight: cap, flexShrink: 1 }}
        contentContainerClassName="gap-4"
        keyboardShouldPersistTaps="handled"
      >
        <Input
          testID="add-member-name"
          label={t('household.add.name')}
          value={form.name}
          onChangeText={(v) => setForm((f) => ({ ...f, name: v }))}
          maxLength={MEMBER_NAME_MAX}
          autoFocus
          autoCapitalize="words"
          autoComplete="off"
          returnKeyType="done"
          error={form.name && !valid ? t('household.add.nameError') : undefined}
        />
        <View className="flex-row items-center gap-4">
          <View className="min-w-0 flex-1 gap-0.5">
            <Text variant="label">{t('household.add.kids')}</Text>
            <Text variant="caption">{t('household.add.kidsBody')}</Text>
          </View>
          <Switch
            testID="add-member-kids"
            checked={form.kid}
            onCheckedChange={(on) => setForm((f) => withKid(f, on))}
            accessibilityLabel={t('household.add.kids')}
          />
        </View>
        <AccessPicker
          connectionId={connectionId}
          serverName={serverName}
          name={form.name}
          access={form.access}
          collectionIds={form.collectionIds}
          newBooks={form.newBooks}
          onAccess={(a) => setForm((f) => withAccess(f, a))}
          onCollections={(ids) => setForm((f) => ({ ...f, collectionIds: ids }))}
          onNewBooks={(on) => setForm((f) => ({ ...f, newBooks: on }))}
        />
      </ScrollView>
      {error ? (
        <Text
          testID="add-member-error"
          className="text-sm text-destructive"
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      ) : null}
      <DialogFooter>
        <Button title={t('common.cancel')} variant="ghost" onPress={onCancel} />
        <Button
          testID="add-member-submit"
          title={form.kid ? t('household.add.submitKid') : t('household.add.submitGrownUp')}
          disabled={!valid}
          loading={busy}
          onPress={() => void submit()}
        />
      </DialogFooter>
    </>
  );
}

/** A kid was added: signed in here in kids mode (or why not), and, when the person
 * listening has no PIN, the offer to set one (a kid could switch to them otherwise). */
function KidStep({
  step,
  onClose,
  onSetPin,
}: {
  step: Extract<Step, { kind: 'kid' }>;
  onClose: () => void;
  onSetPin: (owner: Profile) => void;
}) {
  const { t } = useTranslation();
  const owner = useActiveProfile();
  const name = step.member.name;
  const here = step.here;
  const offerPin = here.status === 'done' && owner !== null && !owner.hasPin;
  return (
    <>
      <View className="flex-row items-start gap-3.5">
        <DialogIcon name={here.status === 'done' ? 'circle-check' : 'circle-info'} />
        <DialogHeader className="flex-1">
          <DialogTitle>{t('household.kid.title', { name })}</DialogTitle>
          <DialogDescription testID="add-kid-result">
            {here.status === 'done'
              ? t('household.kid.body', { name })
              : here.status === 'already'
                ? t('household.here.already', { name })
                : here.message
                  ? `${here.message} ${t('household.here.failedCard')}`
                  : t('household.here.failed', { name })}
          </DialogDescription>
        </DialogHeader>
      </View>
      {offerPin ? (
        <Text variant="muted" testID="add-kid-pin-offer">
          {t('household.kid.pinOffer', { name, owner: profileName(owner, t) })}
        </Text>
      ) : null}
      <DialogFooter>
        {offerPin ? (
          <>
            <Button title={t('household.kid.notNow')} variant="ghost" onPress={onClose} />
            <Button
              testID="add-kid-set-pin"
              title={t('profiles.pin.set')}
              icon="key"
              onPress={() => {
                onClose();
                onSetPin(owner);
              }}
            />
          </>
        ) : (
          <Button title={t('common.done')} onPress={onClose} />
        )}
      </DialogFooter>
    </>
  );
}

/** A grown-up was added: their pairing code, then "They'll also use this phone" above
 * the footer's Done. */
function GrownUpStep({
  step,
  connection,
  onHere,
  onClose,
}: {
  step: Extract<Step, { kind: 'grownup' }>;
  connection: Connection;
  onHere: (here: SignInHereResult) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const connectionId = connection.id;
  const serverName = connection.name;
  const signIn = useSignInHere(connection);
  const name = step.member.name;
  const cap = useBodyCap();

  const alsoHere = async () => {
    const here = await signIn.run(step.member);
    onHere(here);
    if (here.status === 'done') toast({ title: t('household.here.done', { name }) });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('household.qr.title', { name })}</DialogTitle>
        <DialogDescription>
          {t('household.qr.lead', { name, server: serverName })}
        </DialogDescription>
      </DialogHeader>
      <ScrollView style={{ maxHeight: cap, flexShrink: 1 }} contentContainerClassName="gap-4">
        <MemberPairing connectionId={connectionId} serverName={serverName} member={step.member} />
        {step.here?.status === 'done' ? (
          <Text variant="muted" testID="add-grownup-here">
            {t('household.here.done', { name })}
          </Text>
        ) : (
          <View className="gap-2">
            <Button
              testID="add-grownup-also-here"
              variant="outline"
              icon={phone ? 'mobile' : 'laptop'}
              className="self-start"
              title={phone ? t('household.qr.alsoHerePhone') : t('household.qr.alsoHereDevice')}
              loading={signIn.busy}
              onPress={() => void alsoHere()}
            />
            {step.here ? (
              <Text
                testID="add-grownup-here-error"
                className="text-sm text-destructive"
                accessibilityLiveRegion="polite"
              >
                {hereFailure(step.here, name, t)}
              </Text>
            ) : null}
          </View>
        )}
      </ScrollView>
      <DialogFooter>
        <Button testID="add-grownup-done" title={t('common.done')} onPress={onClose} />
      </DialogFooter>
    </>
  );
}
