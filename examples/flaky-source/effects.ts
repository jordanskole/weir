/**
 * The host's effect handlers for this example, supplied with
 * `weir run --effects`.
 *
 * `BAD=1` makes the upstream service misbehave: it returns `rate` as a string,
 * which is a shape `Rate` does not permit. Nothing about the handler is
 * special-cased — weir asserts its result against the declared output edge the
 * same way it would assert any node's input.
 */
export default {
  http: async (payload: { base: string; quote: string }) => {
    if (process.env.BAD === "1") {
      return { ...payload, rate: "one point oh nine", provenance: "live" };
    }
    return { ...payload, rate: 1.09, provenance: "live" };
  },
};
