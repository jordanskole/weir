/**
 * Field-level classification
 * (docs/superpowers/specs/2026-09-28-field-level-classification.md, design.md §7).
 *
 * Zones said where the network hops are; this says what goes over them, which is
 * the half that makes §7's sentence a query rather than a map.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { defineEdge, defineField } from "./define.js";
import { elaborate } from "./elaborate.js";
import { hashEdge, hashNode } from "./hash.js";
import { fieldSchema } from "./schema.js";
import { classificationsOf, crossings } from "./zones.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples", import.meta.url));
const utf8 = (extra = {}) => defineField({ type: "utf8", label: "V", description: "d", nullable: false, ...extra });

describe("classification — part of the contract", () => {
  /**
   * Spec Testing #1. `hash.ts` includes metadata describing what the data
   * *means* (`relation`) and excludes cosmetics; a classification has the
   * stronger claim, since it decides whether a topology is legal.
   *
   * Break-proof: removing the `classification` line from `fingerprint` makes
   * both hashes equal and reddens this.
   */
  it("moves an edge's schema hash, and the contract hash of a node naming it", async () => {
    const plain = defineEdge({ name: "P", label: "P", description: "d", fields: { email: utf8() } });
    const labelled = defineEdge({
      name: "P",
      label: "P",
      description: "d",
      fields: { email: utf8({ classification: "pii" }) },
    });

    expect((await hashEdge(plain)).hash).not.toBe((await hashEdge(labelled)).hash);

    const node = (edge: typeof plain) => ({
      name: "n",
      input: { kind: "single" as const, edge },
      output: { kind: "single" as const, edge },
    });
    expect((await hashNode(node(plain) as never)).hash).not.toBe((await hashNode(node(labelled) as never)).hash);
  });

  /** Spec Testing #7 — accepted by the schema, without widening it. */
  it("is accepted by the field schema, and a misspelled sibling still is not", () => {
    const validate = new Ajv2020({ strict: false }).compile(fieldSchema());

    expect(validate({ type: "utf8", label: "E", description: "d", nullable: false, classification: "pii" })).toBe(true);
    expect(validate({ type: "utf8", label: "E", description: "d", nullable: false, classifcation: "pii" })).toBe(false);
  });
});

describe("classification — what a crossing carries", () => {
  /**
   * Spec Testing #2 and #3 together, on the real example. This is §7's sentence
   * — *"no edge carrying an unredacted PII field may cross into a non-client
   * zone"* — as an answer: `Entity` leaves the server for third-party
   * enrichment carrying `pii`, twice, and the two contexts come back carrying
   * nothing.
   *
   * Break-proof: returning `[]` from `classificationsOf` leaves the crossings
   * intact and every `carries` empty, reddening the first assertion only — the
   * crossings themselves are zones' job, not this one's.
   */
  it("reports what each zone crossing carries, and nothing for unlabelled edges", async () => {
    const hops = crossings(await elaborate(join(EXAMPLES, "soc-triage/src")));

    const leaving = hops.filter((h) => h.toZone === "third-party");
    expect(leaving).toHaveLength(2);
    expect(leaving.every((h) => h.carries.includes("pii"))).toBe(true);

    const returning = hops.filter((h) => h.fromZone === "third-party");
    expect(returning).toHaveLength(2);
    expect(returning.every((h) => h.carries.length === 0)).toBe(true);
  });

  /**
   * Spec Testing #4. An edge's sensitivity is not only in its own scalar fields,
   * and a top-level-only walk would pass an edge whose PII is one level down —
   * which is most edges in any real ontology.
   *
   * Break-proof: not recursing into compound fields returns `[]` here.
   */
  it("finds a label nested inside a compound field", () => {
    const person = defineEdge({
      name: "Person",
      label: "P",
      description: "d",
      fields: { email: utf8({ classification: "pii" }) },
    });
    const order = defineEdge({ name: "Order", label: "O", description: "d", fields: { who: person, ref: utf8() } });

    expect(classificationsOf(order)).toEqual(["pii"]);
  });

  /** Spec Testing #5 — the same, one collection deep. */
  it("finds a label nested inside a many field", () => {
    const line = defineEdge({
      name: "Line",
      label: "L",
      description: "d",
      index: "id",
      fields: { id: utf8(), amount: utf8({ classification: "financial" }) },
    });
    const basket = defineEdge({ name: "Basket", label: "B", description: "d", fields: { lines: { many: line } } });

    expect(classificationsOf(basket)).toEqual(["financial"]);
  });

  /**
   * Spec Testing #6. `fingerprint` and `assertPayload` assume acyclic edge
   * definitions, which `elaborate` enforces — but this runs on a *query* path
   * where a hang would be the whole command rather than a caught error.
   *
   * Break-proof: dropping the `seen` guard throws
   * `RangeError: Maximum call stack size exceeded` — checked directly rather
   * than assumed. The first version of this comment said it would *hang*, which
   * is wrong and would have sent the next reader looking for a timeout. A stack
   * overflow arrives in milliseconds; an infinite loop would not.
   */
  it("survives a self-referential edge definition rather than overflowing the stack", () => {
    const loop: Record<string, unknown> = { name: "Loop", label: "L", description: "d", fields: {} };
    loop.fields = { self: loop, tag: utf8({ classification: "internal" }) };

    expect(classificationsOf(loop as never)).toEqual(["internal"]);
  });

  /** Spec Testing #8. */
  it("leaves every other example unlabelled and still elaborating", async () => {
    for (const name of ["recipe", "escalation", "manuscript-review", "todo-list", "person-birthday"]) {
      const program = await elaborate(join(EXAMPLES, name, "src"));
      const labelled = Object.values(program.edges).flatMap((e) => classificationsOf(e));
      expect(labelled).toEqual([]);
    }
  });
});
