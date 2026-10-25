// Run once after migrations, before the first Windows workbench startup.
import { eq } from "drizzle-orm";
import { agents, closeRegisteredClients, createDb, heartbeatRuns } from "@paperclipai/db";
import { resolveMigrationConnection } from "@paperclipai/db/migration-runtime";
import { instanceSettingsService } from "../src/services/instance-settings.js";

if (process.platform !== "win32") throw new Error("This setup step is for the Windows legacy CLI workbench.");
if (!process.env.PAPERCLIP_HOME || process.env.DATABASE_URL || process.env.DATABASE_MIGRATION_URL) {
  throw new Error("Set the dedicated PAPERCLIP_HOME and do not use an external database override.");
}
const connection = await resolveMigrationConnection();
try {
  const db = createDb(connection.connectionString, { maxConnections: 1 });
  const nativeAgent = await db.select({ id: agents.id }).from(agents)
    .where(eq(agents.adapterType, "paperclip_runner")).limit(1);
  const nativeRun = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.runtimeMode, "native")).limit(1);
  if (nativeAgent.length || nativeRun.length) {
    throw new Error("This instance already contains native Runner work. Review its configuration instead of applying first-install defaults.");
  }
  const settings = await instanceSettingsService(db).updateExperimental({
    enableNativeRunner: false, enableOpenAiDot: false,
  });
  console.log(JSON.stringify({
    configured: true, enableNativeRunner: settings.experimental.enableNativeRunner,
    execution: "official Codex CLI through the legacy adapter",
  }));
} finally {
  await closeRegisteredClients(connection.connectionString);
  await connection.stop();
}
