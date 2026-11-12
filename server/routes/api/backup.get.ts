import { defineHandler } from "nitro";
import { requireUser, transact } from "../../utils/store";
import { backupArchive } from "../../utils/backup";

// A complete, restorable copy: database plus every uploaded file. Editing the
// database while the snapshot is taken cannot corrupt it, so this is safe to
// request while the workshop is being used.
export default defineHandler(async event => {
  await transact(db => { requireUser(db, event.req, "admin"); });
  const { body, filename } = await backupArchive();
  return new Response(body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
