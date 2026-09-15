import { owner } from "@/lib/owner";
import { ownerConfig } from "@/lib/owner-session";
import { Button } from "./ui/button";
export async function OwnerStatus() {
  const identity = await owner(),
    configured = ownerConfig(process.env);
  return (
    <div className="owner-status">
      <div>
        <strong>
          {identity ? "Owner controls unlocked" : "Viewing access"}
        </strong>
        <p>
          {identity
            ? "Your owner session expires after one hour."
            : configured
              ? "Sign in with your owner account to pause automation or restore a saved version."
              : "Owner sign-in has not been configured. Records remain available to view."}
        </p>
      </div>
      {identity ? (
        <form action="/auth/logout" method="post">
          <Button variant="outline">Lock controls</Button>
        </form>
      ) : configured ? (
        <form action="/auth/login" method="post">
          <Button variant="outline">
            {configured.fixture
              ? "Unlock sample controls"
              : "Sign in with Vercel"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
