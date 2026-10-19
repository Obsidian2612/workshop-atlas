# Workshop Atlas

Workshop Atlas is a small self-hosted web app for a workshop's own knowledge: vehicles, specifications, procedures, repair notes, service history, attachments and team accounts. It is not a conversion of the original workshop software, and it does not import or decrypt that software's files.

The stack is React plus a Nitro server layer. The server stores everything locally in one JSON data file and a private attachments directory. Accounts, sessions and permissions are enforced server-side.

## Run it locally

```bash
pnpm install
pnpm run dev
```

The app opens on `http://localhost:5173` during development. Local workshop data is stored in `.workshop-data/` at the project root. That directory is ignored by Git.

## Run it with Docker Compose

This repository is built as a compose-based stack. From the repository root:

```bash
docker compose up --build
```

The default service binds port `3000`. Set `WORKSHOP_PORT` to use a different host port, for example `WORKSHOP_PORT=3100 docker compose up --build`, if something else already occupies 3000. The first administrator is created through the on-screen setup flow, using a setup key if one is configured on the server.

## Deployment notes

See `DEPLOYMENT.md` for compose settings, secrets, permissions, backup guidance and the existing legacy VM shortcut.

## Repository contents

- `src/` — React app and shared types.
- `server/` — Nitro API routes and the on-disk store.
- `Dockerfile`, `docker-compose.yml` — single-instance self-hosted deployment.
- `public/` — locally bundled images and favicon.

## License

This repository is published as-is. If this app is derived from or paired with another workshop system, keep that other system's licence and export requirements in force.
