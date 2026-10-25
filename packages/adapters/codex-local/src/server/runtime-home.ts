import { createHash } from "node:crypto";
import path from "node:path";

/** Keep Windows SQLite sidecar paths below MAX_PATH without merging identities. */
export function resolveCodexRuntimeHome(
  managedHome: string,
  kind: "connector-runtimes" | "skill-runtimes",
  agentId: string,
  runtimeDigest: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return path.join(managedHome, kind, agentId, runtimeDigest);

  // Include every namespace from the original layout; never truncate the digest.
  // Old homes remain intact. New invocations use the compact, stable namespace.
  const identity = createHash("sha256")
    .update(JSON.stringify([kind, agentId, runtimeDigest]))
    .digest("hex");
  return path.join(managedHome, "rt", identity);
}
