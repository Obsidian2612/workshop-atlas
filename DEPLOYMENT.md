# Workshop Atlas deployment

Workshop Atlas is a native web companion for your own workshop information. It does not convert Autodata's program, decrypt its `.IDF` files, or import its vehicle information. The original VM remains separate.

## Included

- React dashboard and searchable vehicles, specifications, procedures, repair notes and service histories.
- Local server-side accounts, password hashing, expiring sessions and viewer/editor/administrator permissions.
- Private JPG, PNG, WebP, PDF and TXT attachments, up to 10 MB each, linked to vehicles or records.
- Administrator-uploaded repair-time PDF sheets, kept privately per vehicle and opened by any signed-in user.
- Administrator-controlled member creation, role changes, password resets and removal.
- JSON export of your own records and an optional shortcut to an existing browser-accessible VM gateway.
- Dockerfile and `docker-compose.yml` for a single self-hosted application instance.

## Deploy using your Docker management interface

1. Place this application's repository on the Docker server and select it as the build context in your Docker manager. Use the supplied `Dockerfile` and `docker-compose.yml`. For Portainer or a similar manager, use a repository/stack configuration that supports building from this directory; a pasted stack alone does not upload the application's source. The compose file is deliberately named `docker-compose.yml`, because managers such as Portainer default to that filename and otherwise fail with `open .../docker-compose.yml: no such file or directory`.
2. Optionally set `WORKSHOP_SETUP_KEY` to a unique secret in your Docker manager's environment settings. When it is set, creating the first administrator requires typing that key. When it is empty the app still deploys and setup still works, but anyone who can reach the app before setup finishes can claim the administrator account, so set a key on any host other people can reach. Also optionally set `WORKSHOP_PORT` (default 3000).
3. Keep the `workshop-data` named volume mounted at `/data`. Do not replace it with temporary container storage. The application runs as the non-root `node` user (UID 1000); a bind mount must be writable by that user.
4. Deploy **one replica only**. This version keeps everything in one SQLite database (`workshop.sqlite`) with transactional, per-row writes — not a multi-instance database. All terminals access that same server. Records refresh automatically every 30 seconds and when a tab regains focus.
5. Initially restrict access to the administrator. Open `http://YOUR-SERVER-IP:3000` (or the configured port), select **Set up workspace**, and enter the setup key to create the first administrator. Use a password of at least 12 characters.
6. Configure HTTPS using your existing reverse proxy before other users sign in. Do not expose the service to the public internet or port-forward it. Keep the setup key private; it is not an account password and cannot reset an existing workspace.
7. Add team members in **Settings & members**. Share initial credentials securely. Each terminal signs in with its own account.

## Troubleshooting a stack deploy

The compose file only publishes one host port, so almost every first-deploy failure is about that port or an optional variable. All three messages below come from the manager, not the application.

| Message | Cause | Fix |
| --- | --- | --- |
| `open /data/compose/<id>/docker-compose.yml: no such file or directory` | the manager looked for `docker-compose.yml` and the checkout had a different filename or an older commit | use commit `f7b1baa` or later, leave the compose path at `docker-compose.yml`, and update/re-pull the stack instead of only redeploying |
| `required variable WORKSHOP_SETUP_KEY is missing a value` | an older compose file hard-required the variable | use `6b254d6` or later, where it is optional |
| `Bind for :::3000 failed: port is already allocated` | another container or service on the host already publishes port 3000 | set `WORKSHOP_PORT` to a free host port in the stack's environment variables and redeploy; the container always listens on 3000 internally |

To find what holds a port on the Docker host:

```bash
docker ps --format '{{.Names}} => {{.Ports}}' | grep 3000
```

Do not stop an unrelated container just to free 3000; setting `WORKSHOP_PORT` to something like `3100` is enough, and the app is reachable at that port instead.

After any change to environment variables or the compose file, choose **Update the stack** or **Pull and redeploy** so the checkout is refreshed. A plain redeploy can reuse the previous clone and repeat the same error.

The Docker image contains built assets and the server only. `src/ADCDA2`, local data, dotenv files and repository metadata are excluded from its build context. Custom visuals and fonts are bundled locally, with no external image or font service required at runtime.

## Permissions

| Capability | Viewer | Editor | Administrator |
| --- | --- | --- | --- |
| Read/search vehicles and workshop records | Yes | Yes | Yes |
| Download attachments | Yes | Yes | Yes |
| Create/edit/delete records and upload files | No | Yes | Yes |
| Export workshop records | No | Yes | Yes |
| Manage accounts and workspace settings | No | No | Yes |

Every API request enforces permissions server-side. Passwords use salted scrypt hashes. Session tokens are stored in the browser's session storage for that tab and only their SHA-256 hashes are saved server-side. Sessions expire after 12 hours; logout, account deletion, password resets and role changes revoke sessions as appropriate. Closing the tab ends the browser's saved session.

## Backup and restore

For a complete backup, stop the application and take a snapshot/archive of the entire `workshop-data` volume using your Docker manager's backup facility. It contains `workshop.sqlite` (workspace data, accounts and sessions), the `attachments` directory and the `repair-times-pdfs` directory. While the server is running, SQLite also keeps `workshop.sqlite-wal` and `workshop.sqlite-shm` beside the database; copy all three together if you copy a live volume by hand. Treat this backup as private customer information.

Restore the entire volume while the application is stopped, preserving filesystem permissions, then start the same application version. The **Export workshop records** button downloads JSON record data and attachment metadata, not the attachments themselves or account credentials; it is not a complete restore archive. No restore/import upload screen is provided in this version.

### Upgrading from the JSON store

Earlier versions kept everything in `workspace.json`. On first start the server imports that file into `workshop.sqlite` once, records the import in the database, and leaves `workspace.json` untouched as a pre-migration copy; later restarts never import it again. Check the vehicles, records, attachments and accounts in the app, then delete `workspace.json` from the volume once you trust the import. Restoring a legacy `workspace.json` into a volume that already has a populated `workshop.sqlite` does not change anything — stop the app, remove the database files, and let the next start import the JSON.

## Existing Autodata VM

If the VM already has a browser-based remote-desktop gateway (for example Guacamole or noVNC), enter its HTTP/HTTPS URL in **Settings & members**. **Autodata connection** then opens that gateway in a new tab. Workshop Atlas does not install or configure the gateway and does not bypass the original program's licence.

Before importing legacy information, confirm your version, an authorised export/API, your reuse permission and an actual sample export. Binary `.IDF` files are not supported as imports. Safety-critical specifications entered by users must be verified against an authorised source.

## Running beside a Windows XP VM

Workshop Atlas cannot run inside Windows XP. The server needs Node.js 24 (the official 64-bit build requires Windows 8.1 or later) and Docker, and Windows XP's last browsers (IE8, Chrome 49, Firefox 52 ESR) cannot execute the React 19 bundle. Keep the XP guest for Autodata and put the app on a small Linux VM next to it.

Suggested topology on one hypervisor (Hyper-V, VMware Workstation or VirtualBox):

| VM | Purpose | Network |
| --- | --- | --- |
| Ubuntu Server 24.04 LTS | Docker Engine + Workshop Atlas | Bridged adapter, DHCP reservation or static IP |
| Windows XP | Autodata only | Host-only or isolated internal network |
| Optional gateway VM/container | Guacamole or noVNC, publishes the XP desktop over HTTP(S) | Reachable from the workshop LAN, not the internet |

Steps on the Linux VM:

1. Install Docker Engine and the Compose plugin, then clone this repository.
2. Create `.env` with `WORKSHOP_PORT=3000` (or another free port) and run `docker compose up -d --build`.
3. Allow only that port through the VM firewall, and keep the service on the workshop LAN behind your reverse proxy and HTTPS.
4. Open `http://LINUX-VM-IP:3000`, create the administrator account, then add the gateway URL in **Settings → Browser-accessible VM URL**. **Autodata connection** will open the XP desktop in a new tab.

Do not expose the XP guest directly to the internet, and do not attempt to install this Node application on XP through compatibility shims. The VM shortcut in the app is a link to a gateway you run yourself; it does not set up remote access.

## Repair time data

Repair times can come from two places, and both are optional.

### Licensed provider API

Set these on the server (or in the compose environment):

| Variable | Purpose |
| --- | --- |
| `REPAIR_API_URL` | Provider endpoint that accepts a VIN lookup; leave empty to disable provider calls |
| `REPAIR_API_KEY` | Optional bearer token sent as `Authorization: Bearer …` |
| `REPAIR_API_TIMEOUT_MS` | Lookup timeout, default `5000` |

The app sends `GET REPAIR_API_URL?vin=…&make=…&model=…&year=…` and expects JSON in one of these shapes:

```json
{ "operations": [ { "operation": "Brake pads front", "minutes": 90 } ] }
```

```json
[ { "operation": "Brake pads front", "minutes": 90 } ]
```

`repairTimes`, `data` and `results` array keys are also accepted, and each item may use `minutes`, `min` or `time`. Lookups run after a vehicle with a VIN is saved, never block the save, and are cached for 24 hours per vehicle. **Refresh** on the vehicle page forces a new lookup. Provider failures are logged server-side and never discard existing data.

### CSV or JSON import

Administrators can paste a licensed export in **Settings → Repair time data**. CSV needs a header row with `vin`, `operation` and `minutes`:

```csv
vin,operation,minutes
WV2ZZZ2KZKX135899,Brake pads front,90
```

JSON accepts an array (or an object keyed by VIN) of `{ "vin", "operation", "minutes" }`. Imports are capped at 2 MB / 5000 rows, merge by VIN and operation, and are applied immediately to any vehicle already carrying a matching VIN. VINs are matched case-insensitively; minutes must be whole numbers from 0 to 1440.

Only import or query data your licence permits you to reuse outside the original application. Autodata `.IDF` files are not readable input, and this feature does not decrypt or scrape them.

### Uploaded PDF sheets

**Settings → Repair time PDFs** stores a printed repair-time sheet (PDF, 10 MB maximum) for a vehicle or for the whole workshop. Files live in the `repair-times-pdfs` directory inside the data volume and are served only to signed-in users; uploading and deleting require an administrator. The sheet is kept as reference material — its contents are not parsed into repair-time entries, so use the CSV/JSON import for data you want applied to a vehicle.

## Partsouq vehicle lookup

When a vehicle has a VIN, its page offers **Search VIN on Partsouq**, which opens `https://partsouq.com/en/search/all?q=VIN` in a new tab. This is a convenience link only: Workshop Atlas does not scrape Partsouq, does not send your credentials, and does not store Partsouq data. Partsouq's own API is partner-only; request access from them if you need automated catalogue data.

## Local preview

In development, local records are stored in `.workshop-data/` at the application root (ignored by Git). Do not put this directory under `public/` or `src/`. The local preview and deployed Docker instance have separate data unless you intentionally restore a complete volume backup.
