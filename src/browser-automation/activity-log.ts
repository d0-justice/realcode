import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const logDirectory = resolve(import.meta.dir, "../../workspace/.realcode/logs");
mkdirSync(logDirectory, { recursive: true });

/** Records timestamped operational metadata without command inputs or page content. */
export function activityLog(scope: string, event: string, fields: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  const line = JSON.stringify({ at, scope, event, ...fields });
  console.log(line);
  try {
    appendFileSync(resolve(logDirectory, `realcode-${at.slice(0, 10)}.log`), `${line}\n`, "utf8");
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), scope: "logger", event: "write.failed", error: error instanceof Error ? error.message : String(error) }));
  }
}
