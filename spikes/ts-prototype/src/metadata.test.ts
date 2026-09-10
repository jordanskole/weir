import { describe, expect, it } from "vitest";
import { computeImplementationMetadata } from "./metadata.js";

describe("computeImplementationMetadata", () => {
  it("reports complexity 1 for a straight-line function with no branches", () => {
    const source = `export default function birthday(payload) {
  return { age: payload.age + 1 };
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(1);
  });

  it("counts an if statement as one decision point", () => {
    const source = `export default function classify(payload) {
  if (payload.age === 42) {
    return { edge: "Pass", payload: {} };
  }
  return { edge: "Fail", payload: {} };
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(2);
  });

  it("counts each && / || as its own decision point", () => {
    const source = `export default function eligible(payload) {
  return payload.age >= 18 && payload.age <= 65 || payload.override;
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(3);
  });

  it("counts a for loop, a switch's non-default case, and a catch block", () => {
    const source = `export default function process(payload) {
  for (const item of payload.items) {
    switch (item.kind) {
      case "a":
        break;
      default:
        break;
    }
  }
  try {
    risky();
  } catch (e) {
    return { edge: "Fail", payload: {} };
  }
  return { edge: "Pass", payload: {} };
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(4);
  });

  it("reports the actual line count", () => {
    const source = `export default function f(payload) {
  return payload;
}
`;
    expect(computeImplementationMetadata(source).lines).toBe(3);
  });
});
