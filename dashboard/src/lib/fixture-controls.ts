import "server-only";
import { randomUUID } from "node:crypto";
import type { ControlAction } from "./model";
import type { OwnerInput } from "./control-input";
export type FixtureControls = {
  version: string;
  paid_work: boolean;
  reviews: boolean;
  publication: boolean;
  head: string | null;
  actions: ControlAction[];
  requests: Map<string, string>;
  expires: number;
};
const globalState = globalThis as typeof globalThis & {
  lyraFixtureControls?: Map<string, FixtureControls>;
};
const states = (globalState.lyraFixtureControls ??= new Map());
export function fixtureControls(sessionID?: string): FixtureControls {
  for (const [id, value] of states)
    if (value.expires < Date.now()) states.delete(id);
  const value = sessionID && states.get(sessionID);
  if (value) return value;
  const state: FixtureControls = {
    version: "1",
    paid_work: true,
    reviews: true,
    publication: true,
    head: null,
    actions: [],
    requests: new Map(),
    expires: Date.now() + 3600000,
  };
  if (sessionID && states.size < 100) states.set(sessionID, state);
  return state;
}
export function fixtureOperate(
  state: FixtureControls,
  subject: string,
  input: OwnerInput,
) {
  const prior = state.requests.get(input.requestID);
  if (prior) {
    if (prior !== JSON.stringify(input)) throw new Error("action_key_conflict");
    return;
  }
  const before: ControlAction["before_state"] = {},
    after: ControlAction["after_state"] = {};
  if (input.kind === "control") {
    if (state.version !== input.version) throw new Error("controls_changed");
    if (state[input.control] === input.enabled)
      throw new Error("control_unchanged");
    Object.assign(before, {
      version: state.version,
      paid_work: state.paid_work,
      reviews: state.reviews,
      publication: state.publication,
    });
    state[input.control] = input.enabled;
    state.version = (BigInt(state.version) + 1n).toString();
    Object.assign(after, {
      version: state.version,
      paid_work: state.paid_work,
      reviews: state.reviews,
      publication: state.publication,
    });
  } else {
    if (
      input.document !== "1".padStart(64, "0") ||
      input.restore !== "20000000-0000-4000-8000-000000000001"
    )
      throw new Error("invalid_restore_revision");
    if (input.source !== "f".repeat(64)) throw new Error("source_changed");
    if (
      input.expected !== (state.head ?? "00000000-0000-4000-8000-000000000001")
    )
      throw new Error("translation_revision_superseded");
    if (state.head) throw new Error("translation_unchanged");
    before.revision_id = input.expected;
    state.head = randomUUID();
    Object.assign(after, {
      revision_id: state.head,
      restored_from: input.restore,
      sequence: 3,
    });
  }
  state.requests.set(input.requestID, JSON.stringify(input));
  state.actions.unshift({
    id: input.requestID,
    actor: subject,
    kind: input.kind,
    document_id: input.kind === "rollback" ? input.document : null,
    before_state: before,
    after_state: after,
    created_at: new Date().toISOString(),
  });
}
