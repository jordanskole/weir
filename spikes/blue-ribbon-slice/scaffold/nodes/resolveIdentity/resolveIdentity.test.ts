import { describe, expect, it } from "vitest";
import { check } from "./check.js";

describe("resolveIdentity", () => {
  it("satisfies every declared example and property", () => {
    // Printed in full on failure: each entry names the artifact at fault.
    expect(check()).toEqual([]);
  });
});
