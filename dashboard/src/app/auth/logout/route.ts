import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  ownerConfig,
  sessionCookie,
  flowCookie,
  requireOrigin,
} from "@/lib/owner-session";
export async function POST(request: Request) {
  try {
    const config = ownerConfig(process.env);
    if (!config) throw new Error("unavailable");
    requireOrigin(config, request.headers.get("origin"));
    const jar = await cookies();
    jar.delete(sessionCookie);
    jar.delete(flowCookie);
    return NextResponse.redirect(new URL("/automation", config.origin), 303);
  } catch {
    return new Response("Owner sign-in required.", { status: 403 });
  }
}
