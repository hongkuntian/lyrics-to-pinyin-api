export type Control = "paid_work" | "reviews" | "publication";
export type ControlInput = {
  kind: "control";
  requestID: string;
  version: string;
  control: Control;
  enabled: boolean;
};
export type RollbackInput = {
  kind: "rollback";
  requestID: string;
  document: string;
  source: string;
  expected: string;
  restore: string;
  reason: string;
};
export type OwnerInput = ControlInput | RollbackInput;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
function field(form: FormData, name: string, pattern?: RegExp) {
  const value = form.get(name);
  if (
    typeof value !== "string" ||
    form.getAll(name).length !== 1 ||
    (pattern && !pattern.test(value))
  )
    throw new Error("invalid_action");
  return value;
}
export function parseOwnerInput(form: FormData): OwnerInput {
  const kind = field(form, "kind"),
    requestID = field(form, "requestID", uuid);
  if (kind === "control") {
    const version = field(form, "version", /^[1-9][0-9]{0,18}$/),
      control = field(form, "control"),
      enabled = field(form, "enabled");
    if (
      BigInt(version) > 9223372036854775807n ||
      !["paid_work", "reviews", "publication"].includes(control) ||
      !["true", "false"].includes(enabled)
    )
      throw new Error("invalid_action");
    return {
      kind,
      requestID,
      version,
      control: control as Control,
      enabled: enabled === "true",
    };
  }
  if (kind !== "rollback") throw new Error("invalid_action");
  const reason = field(form, "reason").trim();
  if (!reason || reason.length > 2000) throw new Error("invalid_action");
  return {
    kind,
    requestID,
    document: field(form, "document", hash),
    source: field(form, "source", hash),
    expected: field(form, "expected", uuid),
    restore: field(form, "restore", uuid),
    reason,
  };
}
export const actionErrors: Record<string, string> = {
  owner_required: "Sign in as the owner before making changes.",
  controls_changed:
    "These controls changed since you opened the page. Refresh and review the current settings.",
  control_unchanged:
    "This setting already has the requested value. Refresh to see it.",
  translation_revision_superseded:
    "A newer translation is now current. Refresh and review the comparison before restoring.",
  source_changed:
    "The lyrics changed. Open the song again to review its current source.",
  translation_unchanged:
    "The current translation already matches this version.",
  action_key_conflict:
    "This submission was already used for a different action. Refresh before trying again.",
  invalid_action: "Check the form and try again.",
  invalid_restore_revision:
    "This version cannot be restored to the current song.",
};
