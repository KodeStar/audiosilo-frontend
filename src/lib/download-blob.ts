/**
 * Web: download a Blob under `name` (a temporary object URL behind a hidden link). For
 * the web builds' file exports (the Journal's export, a Year in listening card); the
 * native builds share a file instead. DOM only: import it from `.web` modules.
 */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next turn: some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
