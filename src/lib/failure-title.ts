import { t } from 'i18next';

import { isServerBusyError } from '@/api/client';

/** The title of the toast for a request to the server that failed: a busy server says so, to
 * try again in a moment (`common.serverBusy`: a 503, the server's own or a proxy's, which
 * reads busy too, `isServerBusyError`); anything else is `fallback`, the action's own
 * failure. */
export function failureTitle(e: unknown, fallback: string): string {
  return isServerBusyError(e) ? t('common.serverBusy') : fallback;
}
