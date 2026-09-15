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
  requireOrigin,
} from "@/lib/owner-session";
export async function POST(request: Request) {
  try {
    const config = ownerConfig(process.env);
    if (!config) throw new Error("unavailable");
    requireOrigin(config, request.headers.get("origin"));
    const jar = await cookies();
    if (config.fixture) {
      jar.set(
        sessionCookie,
        await signOwnerToken(config, "session", {
          sub: config.subject,
          sid: randomUUID(),
        }),
        cookieOptions(config),
      );
      return NextResponse.redirect(new URL("/automation", config.origin), 303);
    }
    const client = await oidc.discovery(
      new URL("https://vercel.com"),
      config.clientID,
      config.clientSecret,
    );
    const verifier = oidc.randomPKCECodeVerifier(),
      state = oidc.randomState(),
      nonce = oidc.randomNonce();
    jar.set(
      flowCookie,
      await signOwnerToken(config, "flow", { verifier, state, nonce }),
      cookieOptions(config, 600),
    );
    const url = oidc.buildAuthorizationUrl(client, {
      redirect_uri: `${config.origin}/auth/callback`,
      scope: "openid",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return NextResponse.redirect(url, 303);
  } catch {
    return new Response("Owner sign-in is unavailable.", { status: 403 });
  }
}
