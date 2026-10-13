import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { clipName } from '@/components/household/household-model';
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

/**
 * Rename a person (the shared Dialog: a bottom sheet on a phone that lifts above the
 * keyboard): on this device (a profile; the server account keeps its username), or a
 * household member's name on the server (Phase 8b-1). `onSave` gets the trimmed name and
 * resolves to whether it was saved (the dialog stays open on false, and the caller has said
 * why); `body` says what the name is; `validate` says what is wrong with a name (undefined:
 * nothing), by default only an empty one. A name is at most a household member's limit in
 * characters (it fits under an avatar and in a menu, and on the server too), counted as
 * the server counts them (`clipName`).
 */
export function RenameDialog({
  open,
  name,
  body,
  validate,
  onSave,
  onClose,
}: {
  open: boolean;
  name: string;
  body?: string;
  validate?: (name: string) => string | undefined;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open ? (
        <RenameBody name={name} body={body} validate={validate} onSave={onSave} onClose={onClose} />
      ) : null}
    </Dialog>
  );
}

function RenameBody({
  name,
  body,
  validate,
  onSave,
  onClose,
}: {
  name: string;
  body?: string;
  validate?: (name: string) => string | undefined;
  onSave: (name: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const error = validate
    ? validate(value)
    : value.trim().length > 0
      ? undefined
      : t('profiles.rename.empty');
  const ok = error === undefined;
  const save = async () => {
    if (!ok || saving) return;
    setSaving(true);
    try {
      if (await onSave(clipName(value.trim()))) onClose();
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
        onChangeText={(v) => setValue(clipName(v))}
        autoFocus
        autoCapitalize="words"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        error={error}
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
