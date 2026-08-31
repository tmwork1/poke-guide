/** Whether the current page is rendered for a visitor without an authenticated user. */
export function isGuestMode(): boolean {
  return document.body.dataset.guestMode === 'true';
}
