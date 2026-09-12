import { describe, expect, it } from "vitest";
import {
  isStepUpRequiredBody,
  STEP_UP_REQUIRED_CODE,
  StepUpRequiredError,
  stepUpRequiredResponse
} from "./step-up";

describe("step-up denial", () => {
  it.each([
    [
      "the Carbon API error envelope",
      {
        code: "FORBIDDEN",
        status: 403,
        message: "x",
        data: { code: "step_up_required", method: "carbon-mfa" }
      }
    ],
    ["a knowledge service body", { error: "step_up_required" }]
  ])("recognises %s", (_name, body) => {
    expect(isStepUpRequiredBody(body)).toBe(true);
  });

  it.each([
    [
      "a plain forbidden envelope",
      { code: "FORBIDDEN", status: 403, message: "x" }
    ],
    ["another knowledge error", { error: "query_unavailable" }],
    ["a code at the top level", { code: "step_up_required" }],
    ["a string", "step_up_required"],
    ["an array", [{ error: "step_up_required" }]],
    ["null", null]
  ])("does not recognise %s", (_name, body) => {
    expect(isStepUpRequiredBody(body)).toBe(false);
  });

  it("answers a source denial with the same code and no caching", async () => {
    const response = stepUpRequiredResponse();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: STEP_UP_REQUIRED_CODE });
    expect(isStepUpRequiredBody({ error: STEP_UP_REQUIRED_CODE })).toBe(true);
  });

  it("is a distinguishable error class", () => {
    const error = new StepUpRequiredError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StepUpRequiredError");
    expect(error.message).toMatch(/two-factor/);
  });
});
