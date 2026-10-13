import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { renameProfile } from '@/stores/profiles';

/** The longest name a person gets on this device (it fits under an avatar and in a menu). */
export const NAME_MAX = 40;

/** Rename a person on this device (the shared Dialog: a bottom sheet on a phone that lifts
 * above the keyboard). The name is local: the server account keeps its username.
 *
 * `onSave` renames something else instead (a household member's name on the server,
 * Phase 8b-1): it gets the trimmed name and resolves to whether it was saved (the dialog
 * stays open on false, and the caller has said why); `body` then says what the name is. */
export function RenameDialog({
  open,
  profileId,
  name,
  body,
  onSave,
  onClose,
}: {
  open: boolean;
  profileId?: string;
  name: string;
  body?: string;
  onSave?: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open ? (
        <RenameBody
          name={name}
          body={body}
          onSave={
            onSave ??
            (async (next) => {
              if (profileId) renameProfile(profileId, next);
              return true;
            })
          }
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function RenameBody({
  name,
  body,
  onSave,
  onClose,
}: {
  name: string;
  body?: string;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const ok = value.trim().length > 0;
  const save = async () => {
    if (!ok || saving) return;
    setSaving(true);
    try {
      if (await onSave(value.slice(0, NAME_MAX).trim())) onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('profiles.rename.title', { name })}</DialogTitle>
        <DialogDescription>{body ?? t('profiles.rename.body')}</DialogDescription>
      </DialogHeader>
      <Input
        testID="rename-field"
        label={t('profiles.rename.label')}
        value={value}
        onChangeText={setValue}
        maxLength={NAME_MAX}
        autoFocus
        autoCapitalize="words"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        error={ok ? undefined : t('profiles.rename.empty')}
      />
      <DialogFooter>
        <Button title={t('common.cancel')} variant="ghost" onPress={onClose} />
        <Button
          title={t('common.save')}
          disabled={!ok}
          loading={saving}
          onPress={() => void save()}
        />
      </DialogFooter>
    </DialogContent>
  );
}
