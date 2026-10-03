// The administrator signs in with a username or, optionally, an email address.
export const MAX_EMAIL_LENGTH = 254;

// Returns the lowercased address, '' for "no email" (blank clears it), or null
// when what was typed is not an email address.
export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email) return '';
  if (email.length > MAX_EMAIL_LENGTH) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// Does what was typed on the sign-in form name this administrator? The
// username matches exactly (as it always has); the email ignores case.
export function loginNamesAdmin({ username, email }, typed) {
  const entered = String(typed ?? '').trim();
  if (!entered) return false;
  if (username && entered === username) return true;
  return Boolean(email) && entered.toLowerCase() === email;
}
