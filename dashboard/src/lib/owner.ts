import "server-only";
import { cookies } from "next/headers";
import { ownerConfig, sessionCookie, verifyOwnerToken } from "./owner-session";
export async function owner() {
  const config = ownerConfig(process.env);
  if (!config) return null;
  const claims = await verifyOwnerToken(
    config,
    "session",
    (await cookies()).get(sessionCookie)?.value,
  );
  return claims
    ? { subject: config.subject, sessionID: claims.sid as string, config }
    : null;
}
