# Gakai

Gakai is a simplified, private WhatsApp workspace built on top of WAHA.
Open `http://gakai.localhost:3000` after starting the stack.

The public service is **Gakai**. It owns the user interface, account
onboarding, QR pairing and inbox. The upstream WAHA service stays on Docker's
private network; its API key is only used server-to-server and is never shown
in the browser.

Existing WhatsApp authentication persists in `./sessions`, so updates and
rebuilds do not require a QR scan unless WhatsApp invalidates the linked device.

## Start or update

Run `docker compose up -d --build` from this directory, then visit the URL
above. On a fresh install, the application detects that no account exists and
opens the QR pairing flow automatically. Existing accounts appear directly in
the inbox.

The untracked `.env` contains the internal WAHA credentials. Create it once
with:

```sh
docker run --rm -v "$PWD":/app/env devlikeapro/waha init-waha /app/env
```

Do not expose the WAHA Core container directly or add its API key to browser
code.

## First-run onboarding

On a fresh installation, Gakai asks the user to create an administrator
username and password. These credentials are stored as a password hash in
`home-data/home.json`; they are not written into `.env`.

The `.env` values `WAHA_DASHBOARD_USERNAME` and `WAHA_DASHBOARD_PASSWORD`
protect WAHA Core's private dashboard. They remain separate from Gakai's
browser login. For older installations that already use a password-only WAHA
Home login, the configured `WAHA_DASHBOARD_USERNAME` is accepted as the
username during the transition.
