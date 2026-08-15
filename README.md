# Gakai

Gakai starts with no manual configuration. It opens an administrator registration page on first visit, then guides the user through WhatsApp QR pairing.

## Start

From the Gakai directory, run:

```sh
./scripts/gakai-up.sh
```

The launcher creates a private `.env` automatically when needed, generates its internal provider credential, builds the services, and prints the address to open. It never asks the user to edit `.env`.

Open [http://gakai.localhost:3000](http://gakai.localhost:3000). On the first visit, create the Gakai administrator username and password. The password is stored only as a salted hash in `home-data/home.json`, not in `.env`.

If port 3000 is already in use:

```sh
GAKAI_PORT=8080 ./scripts/gakai-up.sh
```

Then open `http://gakai.localhost:8080`.

## Access from another device

The default bind address accepts LAN connections. Use the server IP address and the selected port, for example `http://192.168.1.20:3000`.

For a stable LAN name such as `gakai.local`, configure it through your network DNS or mDNS service. Docker cannot create that DNS name consistently on every operating system. For internet-facing use, place Gakai behind an HTTPS reverse proxy and restrict access appropriately.

To bind only to the local machine:

```sh
GAKAI_BIND_ADDRESS=127.0.0.1 ./scripts/gakai-up.sh
```

## Operations

```sh
docker compose ps
docker compose logs -f home
curl http://gakai.localhost:3000/healthz
curl http://gakai.localhost:3000/readyz
```

`/healthz` confirms Gakai is running. `/readyz` also confirms that its private provider runtime is reachable.

## Private data

`.env`, `sessions/`, and `home-data/` are private local state and are excluded from Git and the Docker build context. Do not share or commit them. The browser never receives the internal provider credential.

The current Compose bundle is the migration path toward a public Gakai-only release. Replacing the private provider runtime with a Gakai-owned transport is planned work; it is not represented as complete in this repository yet.
