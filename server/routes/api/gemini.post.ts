import { defineHandler } from "nitro";
import { readBody } from "nitro/h3";
import { fail, requireUser, transact } from "../../utils/store";
import { fetchGeminiRepairTimes } from "../../utils/gemini";

export default defineHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || typeof body !== "object") fail(400, "Invalid request");
  const { vin, make, model, year } = body as Record<string, unknown>;
  if (typeof vin !== "string" || !vin.trim()) fail(400, "A VIN is required");
  await transact(db => requireUser(db, event.req, "read"));
  if (!process.env.GEMINI_API_KEY) fail(503, "GEMINI_API_KEY is missing");
  const entries = await fetchGeminiRepairTimes(vin.trim(), make as string | undefined, model as string | undefined, year as string | undefined);
  if (!entries.length) fail(502, "No repair-time rows were returned from Gemini");
  return { operations: entries };
});