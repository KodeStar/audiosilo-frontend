import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type CastButtonProps,
  castButtonWhenSupported,
  castLabel,
  DrawnCastButton,
  explainBlocked,
} from './cast-button-parts';
import { ensureCastReady, requestCastSession } from './cast-state';
import { useCastButton } from './use-cast-button';

/**
 * The Cast button on the web: our own, driving the Cast Web Sender (Chromium in a secure
 * context only; see `useCastButton`). The sender script loads the first time the button
 * shows for a book it can cast, so a page that never offers casting never loads it. Pressing it opens Chrome's
 * Cast chooser (which also stops a running cast).
 */
export const CastButton = castButtonWhenSupported(ShownCastButton);

function ShownCastButton(props: CastButtonProps) {
  const { t } = useTranslation();
  const model = useCastButton();
  const { show } = model;
  const reason = model.blocked;
  // A button that can only explain (a book it can't cast) loads nothing.
  const wanted = show && !reason;
  useEffect(() => {
    if (wanted) void ensureCastReady();
  }, [wanted]);
  if (!show) return null;
  return (
    <DrawnCastButton
      {...props}
      model={model}
      label={reason ? t('cast.button.blockedLabel') : castLabel(t, model)}
      onPress={() => (reason ? explainBlocked(t, reason) : void requestCastSession())}
    />
  );
}
