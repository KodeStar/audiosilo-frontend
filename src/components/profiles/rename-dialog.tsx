import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MEMBER_NAME_MAX } from '@/components/household/household-model';
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

/** The longest name a person gets (it fits under an avatar and in a menu): a household
 * member's limit, so a name that fits here fits on the server too. */
const NAME_MAX = MEMBER_NAME_MAX;

/**
 * Rename a person (the shared Dialog: a bottom sheet on a phone that lifts above the
 * keyboard): on this device (a profile; the server account keeps its username), or a
 * household member's name on the server (Phase 8b-1). `onSave` gets the trimmed name and
 * resolves to whether it was saved (the dialog stays open on false, and the caller has said
 * why); `body` says what the name is; `validate` says what is wrong with a name (undefined:
 * nothing), by default only an empty one.
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
