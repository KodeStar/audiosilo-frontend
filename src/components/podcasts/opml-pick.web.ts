import type { PickedOpml } from './opml-pick';

export type { PickedOpml };

/** What the web picker offers: OPML and the XML types apps export it as. */
export const OPML_ACCEPT = '.opml,.xml,text/x-opml,text/xml,application/xml';

/**
 * Web: a hidden file input (OPML and XML), clicked once. Resolves with the `File` itself
 * as the body (a Blob, uploaded as it is), or null when the listener cancels (the input's
 * `cancel` event). The native build uses the system picker (`opml-pick.ts`).
 */
export function pickOpml(): Promise<PickedOpml | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = OPML_ACCEPT;
    input.style.display = 'none';
    let settled = false;
    const finish = (value: PickedOpml | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      finish(file ? { name: file.name, size: file.size, body: file } : null);
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
