import { runBackup } from "../utils/backup";

let scheduled = false;

// One backup a day keeps a restorable copy without anyone remembering to press
// a button. It runs in-process: the shop already has one server, and this needs
// no extra container, cron or credentials.
export default function backupSchedule() {
  if (scheduled) return;
  scheduled = true;
  if (process.env.NODE_ENV !== "production") return;

  const hours = Math.max(1, Number(process.env.BACKUP_INTERVAL_HOURS) || 24);
  const run = () => {
    void runBackup()
      .then(result => console.info(`Backup written to ${result.directory} with ${result.files} file(s)`))
      .catch(error => console.warn("Automatic backup failed", error));
  };
  // A shop should not go without a backup for a day just because the server was
  // restarted; the first run happens shortly after start-up.
  const first = setTimeout(run, process.env.BACKUP_ON_START === "1" ? 2_000 : 60_000);
  const timer = setInterval(run, hours * 60 * 60 * 1000);
  first.unref();
  timer.unref();
}
