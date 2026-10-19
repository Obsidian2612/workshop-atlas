import { defineHandler } from "nitro";
import { currentUser, transact, workspace } from "../../utils/store";
export default defineHandler(event => {
  return transact(db => workspace(db, currentUser(db, event.req)));
});
