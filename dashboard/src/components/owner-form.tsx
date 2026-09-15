"use client";
import { useActionState } from "react";
import { ownerAction } from "@/app/automation/actions";
import { Button } from "./ui/button";
export function OwnerForm({
  fields,
  label,
  disabled = false,
  reason = false,
}: {
  fields: Record<string, string>;
  label: string;
  disabled?: boolean;
  reason?: boolean;
}) {
  const [state, action, pending] = useActionState(ownerAction, {
    ok: false,
    message: "",
  });
  return (
    <form action={action} className="owner-form">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {reason && (
        <label>
          Reason for restoring
          <textarea
            name="reason"
            required
            maxLength={2000}
            rows={3}
            disabled={disabled || pending || state.ok}
            placeholder="Describe the problem with the current translation."
          />
        </label>
      )}
      <Button
        type="submit"
        variant={reason ? "default" : "outline"}
        disabled={disabled || pending || state.ok}
      >
        {pending ? "Saving…" : label}
      </Button>
      {state.message && (
        <p role={state.ok ? "status" : "alert"}>{state.message}</p>
      )}
    </form>
  );
}
