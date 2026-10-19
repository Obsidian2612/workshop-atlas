# Workshop Atlas deployment

Workshop Atlas is a native web companion for your own workshop information. It does not convert Autodata's program, decrypt its `.IDF` files, or import its vehicle information. The original VM remains separate.

## Included

- React dashboard and searchable vehicles, specifications, procedures, repair notes and service histories.
- Local server-side accounts, password hashing, expiring sessions and viewer/editor/administrator permissions.
- Private JPG, PNG, WebP, PDF and TXT attachments, up to 10 MB each, linked to vehicles or records.
- Administrator-controlled member creation, role changes, password resets and removal.
- JSON export of your own records and an optional shortcut to an existing browser-accessible VM gateway.
- Dockerfile and `docker-compose.yml` for a single self-hosted application instance.

## Deploy using your Docker management interface

1. Place this application's repository on the Docker server and select it as the build context in your Docker manager. Use the supplied `Dockerfile` and `docker-compose.yml`. For Portainer or a similar manager, use a repository/stack configuration that supports building from this directory; a pasted stack alone does not upload the application's source. The compose file is deliberately named `docker-compose.yml`, because managers such as Portainer default to that filename and otherwise fail with `open .../docker-compose.yml: no such file or directory`.
2. Optionally set `WORKSHOP_SETUP_KEY` to a unique secret in your Docker manager's environment settings. When it is set, creating the first administrator requires typing that key. When it is empty the app still deploys and setup still works, but anyone who can reach the app before setup finishes can claim the administrator account, so set a key on any host other people can reach. Also optionally set `WORKSHOP_PORT` (default 3000).
3. Keep the `workshop-data` named volume mounted at `/data`. Do not replace it with temporary container storage. The application runs as the non-root `node` user (UID 1000); a bind mount must be writable by that user.
4. Deploy **one replica only**. This version uses a serialized, atomically written JSON store, not a multi-instance database. All terminals access that same server. Records refresh automatically every 30 seconds and when a tab regains focus.
5. Initially restrict access to the administrator. Open `http://YOUR-SERVER-IP:3000` (or the configured port), select **Set up workspace**, and enter the setup key to create the first administrator. Use a password of at least 12 characters.
6. Configure HTTPS using your existing reverse proxy before other users sign in. Do not expose the service to the public internet or port-forward it. Keep the setup key private; it is not an account password and cannot reset an existing workspace.
7. Add team members in **Settings & members**. Share initial credentials securely. Each terminal signs in with its own account.

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

For a complete backup, stop the application and take a snapshot/archive of the entire `workshop-data` volume using your Docker manager's backup facility. It contains `workspace.json` (including accounts) and the `attachments` directory. Treat this backup as private customer information.

Restore the entire volume while the application is stopped, preserving filesystem permissions, then start the same application version. The **Export workshop records** button downloads JSON record data and attachment metadata, not the attachments themselves or account credentials; it is not a complete restore archive. No restore/import upload screen is provided in this version.

## Existing Autodata VM

If the VM already has a browser-based remote-desktop gateway (for example Guacamole or noVNC), enter its HTTP/HTTPS URL in **Settings & members**. **Autodata connection** then opens that gateway in a new tab. Workshop Atlas does not install or configure the gateway and does not bypass the original program's licence.

Before importing legacy information, confirm your version, an authorised export/API, your reuse permission and an actual sample export. Binary `.IDF` files are not supported as imports. Safety-critical specifications entered by users must be verified against an authorised source.

## Local preview

In development, local records are stored in `.workshop-data/` at the application root (ignored by Git). Do not put this directory under `public/` or `src/`. The local preview and deployed Docker instance have separate data unless you intentionally restore a complete volume backup.
