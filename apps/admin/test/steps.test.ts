import { describe, expect, it } from "vitest";
import { canAct, canApprove, canReinstate, canReject, canSuspend } from "../src/lib/steps";
import type { Step, Verification } from "../src/lib/types";

const passed = (...steps: Step[]): Verification[] =>
  steps.map((step) => ({ step, status: "passed", note: null, at: "2026-10-21T00:00:00Z" }));

describe("verification step ordering", () => {
  it("only the next step is actionable", () => {
    expect(canAct("identity", [], "kyc_submitted")).toBe(true);
    expect(canAct("qualification", [], "kyc_submitted")).toBe(false);
    expect(canAct("qualification", passed("identity"), "kyc_submitted")).toBe(true);
    expect(canAct("interview", passed("identity"), "interview")).toBe(false);
    expect(canAct("interview", passed("identity", "qualification"), "interview")).toBe(true);
  });

  it("documents must exist before identity/qualification checks", () => {
    expect(canAct("identity", [], "applied")).toBe(false);
  });

  it("probation is judged only while live on probation", () => {
    const three = passed("identity", "qualification", "interview");
    expect(canAct("probation", three, "interview")).toBe(false);
    expect(canAct("probation", three, "probation")).toBe(true);
  });

  it("passed steps and closed applications are not actionable", () => {
    expect(canAct("identity", passed("identity"), "kyc_submitted")).toBe(false);
    expect(canAct("identity", [], "rejected")).toBe(false);
    expect(canAct("identity", [], "suspended")).toBe(false);
  });

  it("a failed step can be re-recorded, and blocks later steps", () => {
    const failed: Verification[] = [
      { step: "identity", status: "failed", note: "blurry", at: null },
    ];
    expect(canAct("identity", failed, "kyc_submitted")).toBe(true);
    expect(canAct("qualification", failed, "kyc_submitted")).toBe(false);
  });

  it("approval needs identity, qualification and interview, in the interview state", () => {
    expect(canApprove(passed("identity", "qualification"), "interview")).toBe(false);
    expect(canApprove(passed("identity", "qualification", "interview"), "interview")).toBe(true);
    expect(canApprove(passed("identity", "qualification", "interview"), "kyc_submitted")).toBe(
      false,
    );
  });

  it("suspend / reinstate / reject apply to the right states", () => {
    expect(canSuspend("approved") && canSuspend("probation")).toBe(true);
    expect(canSuspend("interview")).toBe(false);
    expect(canReinstate("suspended")).toBe(true);
    expect(canReinstate("approved")).toBe(false);
    expect(canReject("kyc_submitted")).toBe(true);
    expect(canReject("approved")).toBe(false);
  });
});
