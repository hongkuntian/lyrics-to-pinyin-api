import * as oidc from "openid-client";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ownerConfig,
  cookieOptions,
  flowCookie,
  sessionCookie,
  signOwnerToken,
  verifyOwnerToken,
} from "@/lib/owner-session";
export async function GET(request: Request) {
  const jar = await cookies();
  try {
    const config = ownerConfig(process.env);
    if (!config || config.fixture) throw new Error("unavailable");
    const flow = await verifyOwnerToken(
      config,
      "flow",
      jar.get(flowCookie)?.value,
    );
    jar.delete(flowCookie);
    if (
      !flow ||
      typeof flow.verifier !== "string" ||
      typeof flow.state !== "string" ||
      typeof flow.nonce !== "string"
    )
      throw new Error("invalid_flow");
    const client = await oidc.discovery(
      new URL("https://vercel.com"),
      config.clientID,
      config.clientSecret,
    );
    // Use the configured callback, never an incoming Host or forwarded host.
    const callback = new URL(`${config.origin}/auth/callback`);
    callback.search = new URL(request.url).search;
    const tokens = await oidc.authorizationCodeGrant(client, callback, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    if (tokens.claims()?.sub !== config.subject)
      throw new Error("owner_required");
    jar.set(
      sessionCookie,
      await signOwnerToken(config, "session", {
        sub: config.subject,
        sid: randomUUID(),
      }),
      cookieOptions(config),
    );
    return NextResponse.redirect(new URL("/automation", config.origin), 303);
  } catch {
    jar.delete(flowCookie);
    jar.delete(sessionCookie);
    return new Response(
      "Owner sign-in could not be verified. Return to Automation and try again.",
      { status: 403 },
    );
  }
}
