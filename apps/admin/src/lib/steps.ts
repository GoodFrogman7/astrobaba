import { STEPS, type AstrologerStatus, type Step, type Verification } from "./types";

/** Verification steps are done strictly in order: identity → qualification → interview → probation. */
export function stepState(verifications: Verification[]): Record<Step, Verification> {
  const by = new Map(verifications.map((v) => [v.step, v]));
  return Object.fromEntries(
    STEPS.map((s) => [s, by.get(s) ?? { step: s, status: "pending", note: null, at: null }]),
  ) as Record<Step, Verification>;
}

/** Whether an admin may record a result for this step now. */
export function canAct(
  step: Step,
  verifications: Verification[],
  status: AstrologerStatus,
): boolean {
  if (status === "rejected" || status === "suspended") return false;
  const state = stepState(verifications);
  const index = STEPS.indexOf(step);
  if (state[step].status === "passed") return false;
  if (!STEPS.slice(0, index).every((s) => state[s].status === "passed")) return false;
  // Probation can only be judged once the astrologer is live on probation.
  if (step === "probation") return status === "probation";
  // Identity and qualification need the documents first.
  if (step === "identity" || step === "qualification") return status !== "applied";
  return true;
}

/** Approval (→ probation) needs identity, qualification and interview passed. */
export function canApprove(verifications: Verification[], status: AstrologerStatus): boolean {
  const state = stepState(verifications);
  return (
    status === "interview" &&
    (["identity", "qualification", "interview"] as Step[]).every(
      (s) => state[s].status === "passed",
    )
  );
}

export function canSuspend(status: AstrologerStatus): boolean {
  return status === "probation" || status === "approved";
}

export function canReinstate(status: AstrologerStatus): boolean {
  return status === "suspended";
}

export function canReject(status: AstrologerStatus): boolean {
  return status !== "rejected" && status !== "approved" && status !== "suspended";
}
