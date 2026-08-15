# Gakai

Gakai is a simplified, private WhatsApp workspace built around a private provider runtime.
Open `http://gakai.localhost:3000` after starting the stack.

The public service is **Gakai**. It owns the user interface, account
onboarding, QR pairing and inbox. The provider runtime stays on Docker's
private network; its API key is only used server-to-server and is never shown
in the browser.

Existing WhatsApp authentication persists in `./sessions`, so updates and
rebuilds do not require a QR scan unless WhatsApp invalidates the linked device.

## Start or update

Run `docker compose up -d --build` from this directory, then visit the URL
above. On a fresh install, the application detects that no account exists and
opens the QR pairing flow automatically. Existing accounts appear directly in
The untracked `.env` contains private provider-runtime credentials. Keep it out of Git and browser code. Existing local development installations can continue using their current provider configuration while Gakai packaging is completed.
```

Do not expose the private provider runtime directly or add its credential to browser
code.

## First-run onboarding

On a fresh installation, Gakai asks the user to create an administrator
username and password. These credentials are stored as a password hash in
`home-data/home.json`; they are not written into `.env`.

Provider-runtime dashboard credentials remain private and separate from Gakai browser authentication. Existing local deployments remain compatible during the transition.
