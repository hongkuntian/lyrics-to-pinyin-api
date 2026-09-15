"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { owner } from "@/lib/owner";
import { requireOrigin } from "@/lib/owner-session";
import { parseOwnerInput, actionErrors } from "@/lib/control-input";
import { operate } from "@/lib/operator";
import { fixtureControls, fixtureOperate } from "@/lib/fixture-controls";
export type ActionState = { ok: boolean; message: string };
export async function ownerAction(
  _previous: ActionState,
  form: FormData,
): Promise<ActionState> {
  try {
    const identity = await owner();
    if (!identity) throw new Error("owner_required");
    requireOrigin(identity.config, (await headers()).get("origin"));
    const input = parseOwnerInput(form);
    if (identity.config.fixture)
      fixtureOperate(
        fixtureControls(identity.sessionID),
        identity.subject,
        input,
      );
    else await operate(identity.subject, input);
    revalidatePath("/", "layout");
    return {
      ok: true,
      message:
        input.kind === "control"
          ? "Control updated. Spending limits are unchanged."
          : "Saved version restored as a new revision. Devices receive it on their next revision check.",
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return {
      ok: false,
      message:
        actionErrors[code] ??
        "The action could not be confirmed. Refresh to check its status before trying again.",
    };
  }
}
