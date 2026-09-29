/**
 * The recovery path's body. Run it through the gate before it can be used:
 *
 *   weir accept useFallback examples/flaky-source \
 *     --source examples/flaky-source/implementations/useFallback.ts \
 *     --impl examples/flaky-source/accepted
 *
 * The rate it returns is a placeholder, and deliberately a poor one. That is
 * what `provenance: fallback` on the output is for: the value is not
 * trustworthy, and the edge says so in a field a consumer can branch on,
 * rather than in a comment nobody downstream can read.
 */
export default function useFallback(failed: {
  input: { base: string; quote: string };
  reason: string;
}) {
  return {
    base: failed.input.base,
    quote: failed.input.quote,
    rate: 1,
    provenance: "fallback",
  };
}
