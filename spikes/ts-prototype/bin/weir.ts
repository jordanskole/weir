#!/usr/bin/env tsx
/**
 * The thin half: argv in, stdout out, exit code set. Everything worth
 * testing lives in `runCli`, which returns a result rather than writing one.
 */
import { runCli } from "../src/cli.js";

const result = await runCli(process.argv.slice(2), process.cwd());
process.stdout.write(`${result.out}\n`);
process.exit(result.code);
