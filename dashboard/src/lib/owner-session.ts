import { SignJWT, jwtVerify } from "jose";
import { dataMode } from "./config";

export type OwnerConfig = {
  origin: string;
  secret: string;
  subject: string;
  clientID: string;
  clientSecret: string;
  fixture: boolean;
};
export function ownerConfig(
  env: Record<string, string | undefined>,
): OwnerConfig | null {
  const mode = dataMode(env);
  if (
    !env.VERCEL_ENV &&
    mode === "fixtures" &&
    env.LYRA_DASHBOARD_FIXTURE_CONTROLS === "1"
  ) {
    return {
      origin: "http://127.0.0.1:4331",
      secret: "local-synthetic-owner-session-key-only",
      subject: "fixture-owner",
      clientID: "",
      clientSecret: "",
      fixture: true,
    };
  }
  if (mode !== "production") return null;
  const {
    LYRA_DASHBOARD_ORIGIN: origin,
    LYRA_DASHBOARD_SESSION_SECRET: secret,
    LYRA_DASHBOARD_OWNER_SUBJECT: subject,
    LYRA_DASHBOARD_OAUTH_CLIENT_ID: clientID,
    LYRA_DASHBOARD_OAUTH_CLIENT_SECRET: clientSecret,
    LYRA_DASHBOARD_OPERATOR_DATABASE_URL: database,
  } = env;
  if (!origin || !secret || !subject || !clientID || !clientSecret || !database)
    return null;
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.protocol !== "https:" ||
    secret.length < 32 ||
    subject.length > 100
  )
    throw new Error("owner_configuration_required");
  return { origin, secret, subject, clientID, clientSecret, fixture: false };
}
export const sessionCookie = "lyra-owner";
export const flowCookie = "lyra-owner-flow";
export const cookieOptions = (config: OwnerConfig, maxAge = 3600) => ({
  httpOnly: true,
  secure: !config.fixture,
  sameSite: "lax" as const,
  path: "/",
  maxAge,
});
const key = (config: OwnerConfig) => new TextEncoder().encode(config.secret);
export async function signOwnerToken(
  config: OwnerConfig,
  purpose: "session" | "flow",
  payload: Record<string, string>,
  now = Math.floor(Date.now() / 1000),
) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.origin)
    .setAudience(`lyra-owner-${purpose}`)
    .setIssuedAt(now)
    .setExpirationTime(now + (purpose === "flow" ? 600 : 3600))
    .sign(key(config));
}
export async function verifyOwnerToken(
  config: OwnerConfig,
  purpose: "session" | "flow",
  token: string | undefined,
  now = new Date(),
) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(config), {
      algorithms: ["HS256"],
      issuer: config.origin,
      audience: `lyra-owner-${purpose}`,
      currentDate: now,
      maxTokenAge: purpose === "flow" ? "10m" : "1h",
      requiredClaims: ["exp", "iat"],
    });
    if (
      purpose === "session" &&
      (payload.sub !== config.subject || typeof payload.sid !== "string")
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}
export function requireOrigin(config: OwnerConfig, origin: string | null) {
  if (origin !== config.origin) throw new Error("owner_required");
}
