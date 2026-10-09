import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type CastButtonProps,
  castLabel,
  DrawnCastButton,
  explainBlocked,
} from './cast-button-parts';
import { ensureCastReady, requestCastSession, useCast } from './cast-state';
import { useCastButton } from './use-cast-button';

/**
 * The Cast button on the web: our own, driving the Cast Web Sender (Chromium in a secure
 * context only; see `useCastButton`). The sender script loads the first time the button
 * shows, so a page that never offers casting never loads it. Pressing it opens Chrome's
 * Cast chooser (which also stops a running cast).
 */
export function CastButton(props: CastButtonProps) {
  // Nothing (and no server read) on a device that can't cast.
  const supported = useCast((s) => s.supported);
  return supported ? <ShownCastButton {...props} /> : null;
}

function ShownCastButton(props: CastButtonProps) {
  const { t } = useTranslation();
  const model = useCastButton();
  const { show } = model;
  useEffect(() => {
    if (show) void ensureCastReady();
  }, [show]);
  if (!show) return null;
  const reason = model.blocked;
  return (
    <DrawnCastButton
      {...props}
      model={model}
      label={reason ? t('cast.button.blockedLabel') : castLabel(t, model)}
      onPress={() => (reason ? explainBlocked(t, reason) : void requestCastSession())}
    />
  );
}
