// Where each screen lives in the address bar. The app is one page; these helpers
// turn a URL into "which screen" and back, so refresh, back/forward and shared
// links all land in the right place.
//
//   /                              home (inbox)
//   /settings                      workspace settings: accounts, sign-in, API tokens
//   /profile-settings/<name>       one WhatsApp account (profile); optional /<tab>
//   /details/<name>                the old address — still understood, redirected
export const ACCOUNT_TABS = ["connection", "ai", "voices"];
// Tabs that were merged into another keep working from old links and bookmarks.
const RENAMED_TABS = { people: "voices" };
export const DEFAULT_ACCOUNT_TAB = "connection";

export const slugify = value => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };

export function parseRoute(pathname) {
  const path = String(pathname || "/").replace(/\/+$/, "") || "/";
  if (path === "/settings") return { view: "settings" };
  const profile = path.match(/^\/profile-settings\/([^/]+)(?:\/([^/]+))?$/);
  if (profile) {
    const tab = RENAMED_TABS[profile[2]] || profile[2];
    return { view: "profile", slug: decode(profile[1]), tab: ACCOUNT_TABS.includes(tab) ? tab : DEFAULT_ACCOUNT_TAB, ...(RENAMED_TABS[profile[2]] ? { legacy: true } : {}) };
  }
  const legacy = path.match(/^\/details\/([^/]+)$/);
  if (legacy) return { view: "profile", slug: decode(legacy[1]), tab: DEFAULT_ACCOUNT_TAB, legacy: true };
  return { view: "home" };
}

export const profilePath = (slug, tab) => `/profile-settings/${encodeURIComponent(slug)}${tab && tab !== DEFAULT_ACCOUNT_TAB ? `/${tab}` : ""}`;

// The name used in an account's address: its label, unless two accounts would share
// it (or it has no usable letters), in which case the account id keeps it unique.
export function accountSlug(account, accounts = []) {
  const byLabel = slugify(account?.label);
  const clash = accounts.some(other => other.id !== account?.id && slugify(other.label) === byLabel);
  return byLabel && !clash ? byLabel : slugify(account?.id);
}

export const findAccountBySlug = (accounts, slug) => accounts.find(account => accountSlug(account, accounts) === slug) || accounts.find(account => slugify(account.id) === slug) || null;
