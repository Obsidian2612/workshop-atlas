# Workshop Atlas deployment

Workshop Atlas is a native web companion for your own workshop information. It does not convert Autodata's program, decrypt its `.IDF` files, or import its vehicle information. The original VM remains separate.

Workshop Atlas uses a small SQLite-backed workspace store rather than the earlier JSON-only setup. That means the server starts from a data volume, not from a hand-edited file, and the first start for an existing workspace is the migration step below.



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

Docker Compose is only used for deployment and for local server testing with a real container runtime. The dev preview still runs directly with Node, Vite and Nitro, so the compose file is not part of the normal edit loop.

The compose file only publishes one host port, so almost every first-deploy failure is about that port or an optional variable. All three messages below come from the manager, not the application.

| Message | Cause | Fix |
| --- | --- | --- |
| `open /data/compose/<id>/docker-compose.yml: no such file or directory` | the manager looked for `docker-compose.yml` and the checkout had a different filename or an older commit | use commit `f7b1baa` or later, leave the compose path at `docker-compose.yml`, and update/re-pull the stack instead of only redeploying |
| `required variable WORKSHOP_SETUP_KEY is missing a value` | an older compose file hard-required the variable | use `6b254d6` or later, where it is optional |
| `Bind for :::3000 failed: port is already allocated` | another container or service on the host already publishes port 3000 | set `WORKSHOP_PORT` to a free host port in the stack's environment variables and redeploy; the container always listens on 3000 internally |

To find what holds a port on the Docker host, the usual command is:

```bash
docker ps --format '{{.Names}} => {{.Ports}}' | grep 3000
```

The same layout applies to the project's own compose setup: one published port, one SQLite database in the data volume, and one process that does both the API and the static files.

To find what holds a port on the Docker host:

```bash
docker ps --format '{{.Names}} => {{.Ports}}' | grep 3000
```

Do not stop an unrelated container just to free 3000; setting `WORKSHOP_PORT` to something like `3100` is enough, and the app is reachable at that port instead.

The project's compose file uses the same single-port, single-database, single-process shape: the server and the frontend each run in their own container, the proxy exposes one host port, and the database stays in the named volume. That is the shape the rest of this document assumes.

After any change to environment variables or the compose file, choose **Update the stack** or **Pull and redeploy** so the checkout is refreshed. A plain redeploy can reuse the previous clone and repeat the same error.

The compose file only drives the published app. When you are running the preview locally, use `pnpm dev` or the equivalent start command instead, and let the Vite server and Nitro server each speak on their own ports.

The Docker image contains built assets and the server only.

The dev preview does not build Docker images; it runs the Nitro server and the Vite client directly. Use the compose file only when you are ready to publish a container-based deployment. `src/ADCDA2`, local data, dotenv files and repository metadata are excluded from its build context. Custom visuals and fonts are bundled locally, with no external image or font service required at runtime.

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

If the VM already has a browser-based remote-desktop gateway (for example Guacamole or noVNC), enter its HTTP/HTTPS URL in **Settings & members**. **Autodata connection** then opens that gateway in a new tab. Set `WORKSHOP_VM_URL` in `docker-compose.yml` (or `NITRO_VM_URL` when running the server directly) to seed the shortcut on first start, so it works before anyone signs in to configure it; saving the field in Settings overrides the seeded value. Workshop Atlas does not install or configure the gateway and does not bypass the original program's licence.

Before importing legacy information, confirm your version, an authorised export/API, your reuse permission and an actual sample export. Binary `.IDF` files are not supported as imports. Safety-critical specifications entered by users must be verified against an authorised source.

## Running beside a Windows XP VM

Workshop Atlas cannot run inside Windows XP. The server needs Node.js 24 (the official 64-bit build requires Windows 8.1 or later) and Docker, and Windows XP's last browsers (IE8, Chrome 49, Firefox 52 ESR) cannot execute the React 19 bundle.

The local preview is a Vite dev server plus a Nitro server, not Docker. That means there is no compose file involved while you are iterating on the code; the compose stack is only for the server you actually publish.

 Keep the XP guest for Autodata and put the app on a small Linux VM next to it.

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

The desktop app lives on the Linux VM next to Windows XP. If you want a GUI around the Vite dev server for local iteration, you can run the preview from a host desktop and point the browser at the Linux VM's dev port, but the app itself is still a browser application.

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

**Settings → Repair time PDFs** stores a printed repair-time sheet (PDF, 10 MB maximum) for a vehicle or for the whole workshop. Files live in the `repair-times-pdfs` directory inside the data volume and are served only to signed-in users; uploading and deleting require an administrator.

**Read times** parses the sheet and shows its operations (code, description and duration) before anything is written. **Apply** writes them to the vehicle you pick in the dialog, which defaults to the sheet's own vehicle, so one sheet can also be applied to a different vehicle. Re-applying the same sheet replaces operations with the same code instead of duplicating them, and when the target vehicle has a VIN the same entries join the licensed dataset for future lookups.

The reader works on the PDF's text layer; it reads positions rather than a fixed template, so it can separate the code, description, type, hours and price even when the source generator has printed them as separate runs. Minutes are rounded from decimal hours.

The paste parser works on plain text only: labelled lines, the copied `Year | Manufacturers | Model range | Engine` table, and the engine panel beneath it. It does not read the PDF, and it does not read positions. That keeps it simple and lets the pasted sheet and the PDF sheet reuse the same apply logic without becoming one big rule set.

The reader works on the PDF's text layer: printed sheets from catalogue or terminal software read correctly, while scans and photographs of a sheet have no text to read and are reported as unreadable. Column layout is taken from text positions, so the code, description, type, hours and price are separated even when the generator prints them as separate runs. Minutes are rounded from decimal hours. Only import data your licence allows you to reuse.

### Paste capture from the program

The reader works on the PDF's text layer; it reads positions rather than a fixed template, so it can separate the code, description, type, hours and price even when the source generator has printed them as separate runs. Minutes are rounded from decimal hours.

The paste parser works on plain text only: labelled lines, the copied `Year | Manufacturers | Model range | Engine` table, and the engine panel beneath it. It does not read the PDF, and it does not read positions. That keeps it simple and lets the pasted sheet and the PDF sheet reuse the same apply logic without becoming one big rule set.

The reader works on the PDF's text layer: printed sheets from catalogue or terminal software read correctly, while scans and photographs of a sheet have no text to read and are reported as unreadable. Column layout is taken from text positions, so the code, description, type, hours and price are separated even when the generator prints them as separate runs. Minutes are rounded from decimal hours. Only import data your licence allows you to reuse.

### Paste capture from the program

Paste capture is the manual side of the same workflow: select and copy rows in the program, paste into the dialog, and apply only after **Read paste** shows the parsed rows. The same paste box also parses a vehicle identification screen, and it shares its parsed-result preview with the PDF sheet path, because both of those produce an in-app preview before the app writes anything.

**Paste from the program** (the clipboard button in the header, or **Autodata connection → Paste from the VM**) is the manual capture path for content you are licensed to view in the original program. Select the operation rows in the program, copy them, and paste them into the dialog. The server accepts one operation per line, tab-separated columns or plain description-and-hours lines (`5.70` or `5,70`), shows the parsed rows and any skipped lines, and writes nothing until you press **Apply**.

A vehicle identification screen can be pasted into the same box. The server recognises labelled lines (`Make: Alfa Romeo`), the copied `Year | Manufacturers | Model range | Engine` table and the engine panel below it, then shows **make, model, year and engine** as editable fields before saving. If the detected vehicle matches the one selected, the dialog updates that vehicle; otherwise it offers to create a new vehicle from the details. Nothing is written until **Read paste** has shown the values and you press the apply button.

Only the text you paste is read. The app does not connect to the VM, drive its screen, decrypt `.IDF` files or fetch data on its own. Re-applying a paste replaces operations with the same description on that vehicle instead of duplicating them, and when the vehicle has a VIN the entries also join the repair-time dataset for future lookups. Use it only for content your licence permits you to store outside the original application.

That paste flow is the manual counterpart to the PDF sheet path: both show a preview before writing, both reuse the same apply logic, and both stay off the text-position machinery that the PDF reader uses. The paste parser is deliberately separate because it reads plain text, not PDF positions.

### Google Gemini lookup

The vehicle page offers **Search times with Gemini** in the repair-times header. The server asks Gemini for candidate repair times using the vehicle's VIN, with make, model and year as context, and shows the results in a preview dialog. Only the rows you tick and confirm are written. Repair times are stored on that vehicle with the `gemini` source and are not added to the licensed VIN dataset. Tightening torque searches use Brave Search; see [Online torque specification search](#online-torque-specification-search).

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Google AI Studio API key. Required to enable the button. |
| `GEMINI_MODEL` | Gemini model, default `gemini-3.8-flash`. |
| `GEMINI_TIMEOUT_MS` | Lookup timeout, default `60000`. |

Requests use Gemini's low thinking level and ask for at most 40 repair times, which keeps generation inside the timeout. If a lookup still times out, raise `GEMINI_TIMEOUT_MS`.

Create a key at <https://aistudio.google.com/apikey> and set it in the server environment or the compose environment. Lookups require an editor or administrator account. Repair-time lookups need a VIN. AI-generated times are estimates; check them against an authorised source before using them for quotes or billing.

## Online torque specification search

The **Tightening torques** section on a vehicle page offers **Search torque specifications with Groq**. The server sends the vehicle identity (make, model, year, engine model/number, variant and VIN) to Groq's built-in browser search, asks it to find source-backed torque specifications, and shows the cited sources and candidate rows in a preview dialog. **Nothing is written until you tick the rows you trust and press Add selected.** Groq's search can help locate information, but its output is not verified manufacturer data; check safety-critical values against an authorised service source.

### Configuration

| Variable | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Groq API key. Required to enable searches. |
| `GROQ_MODEL` | Groq browser-search model: `openai/gpt-oss-20b` (default) or `openai/gpt-oss-120b`. |
| `GROQ_TIMEOUT_MS` | Request timeout in milliseconds (default `60000`). |

Create an API key at <https://console.groq.com/keys> and set it as `GROQ_API_KEY` in your server environment or Docker stack environment, then restart/redeploy the app. The default model is `openai/gpt-oss-20b`; both listed model choices support Groq's built-in browser search. No separate search-provider key or endpoint is needed.

### What happens to a search

- Only editors and administrators can run a search. Six searches per user per minute; results are cached for 10 minutes per vehicle.
- Groq performs browser search server-side and returns a response with its answer and citation text. The app extracts only rows with valid torque values/units and direct source URLs that Groq included in its response.
- Candidate values use recognised units (`Nm`, `lbf·ft`, `lbf·in`, `kgf·m`). Invalid values, units, or rows without a source link are discarded.
- Rows are merged by fastener and stage, so re-running a search replaces matching values instead of duplicating them.
- Online values are third-party content. Verify safety-critical figures against an authorised source; the preview says so and the app stores only what you confirm.

Groq's browser search is not compatible with Structured Outputs, so the server validates and normalizes the JSON-like response before showing candidates. Citations help identify potentially relevant source pages but do not guarantee factual accuracy or correct vehicle matching.

Current API details and model support are in [Groq's Browser Search documentation](https://console.groq.com/docs/tool-use/built-in-tools/browser-search) and [model list](https://console.groq.com/docs/models).

## Partsouq vehicle lookup

When a vehicle has a VIN, its page offers **Search VIN on Partsouq**, which opens `https://partsouq.com/en/search/all?q=VIN` in a new tab. This is a convenience link only: Workshop Atlas does not scrape Partsouq, does not send your credentials, and does not store Partsouq data. Partsouq's own API is partner-only; request access from them if you need automated catalogue data.

## Local preview

In development, local records are stored in `.workshop-data/` at the application root (ignored by Git). Do not put this directory under `public/` or `src/`. The local preview and deployed Docker instance have separate data unless you intentionally restore a complete volume backup.
