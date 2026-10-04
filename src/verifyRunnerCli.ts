/**
 * The entrypoint of the verify runner job (src/agent/verifyRunner.ts, #74). It loads no Starfish configuration:
 * this job's whole input is the request the agent hands it, and its service account holds no roles. Exits 1 when it
 * could not do its job (the agent then treats the run as a runner failure and retries the cycle), 0 when it wrote a
 * result, whatever that result says about the patch.
 */
import { loadVerifyRunnerRequest } from "./config.js";
import { runVerifier } from "./agent/verifyRunner.js";

const uid = process.getuid?.();
console.log(`verify-runner: starting as uid ${uid ?? "unknown"}`);
const request = loadVerifyRunnerRequest();
if (request === undefined) {
  console.error("verify-runner: STARFISH_VERIFY_REQUEST is not set");
  process.exit(1);
}

// Root only to be able to hand the command to an unprivileged user (verifyGate's `runAs`); never run it as root.
const runAs = uid === 0 ? { uid: 65534, gid: 65534 } : undefined;
if (runAs === undefined) console.warn("verify-runner: NOT root, so the command runs as this same user and could read this process's environment");

try {
  const result = await runVerifier(request, runAs ? { runAs } : {});
  console.log(`verify-runner: ${result.status} (${result.rule}) in ${result.durationMs} ms`);
  process.exit(0);
} catch (err) {
  console.error(`verify-runner: ${err instanceof Error ? err.message : "failed"}`);
  process.exit(1);
}
