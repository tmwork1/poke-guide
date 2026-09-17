/** Whether the current page belongs to an anonymous Supabase user (trial-mode UI only). */
export function isGuestMode(): boolean {
  return document.body.dataset.guestMode === 'true';
}
