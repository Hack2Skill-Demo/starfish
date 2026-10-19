/**
 * The daily reopen limit the agent's last pass applied (`{runCollection}/agent_last_run.reconsiderMaxPerDay`, #456), live,
 * for the Runs page's Retry (lib/retryHold.ts). Undefined while it is read, when it cannot be read, when no pass recorded
 * it, or when the record is another environment's: the page then never guesses a limit.
 */
import { firestore } from "./firebase";
import { webConfig } from "./config";
import { subscribeAgentPass, type AgentPass } from "./engineStatus";
import { useLiveRecord } from "./useLiveRecord";

export function useReopenLimit(environment: string): number | undefined {
  const runCollection = webConfig().runCollection;
  const record = useLiveRecord<AgentPass>(runCollection, (onData, onError) => subscribeAgentPass(firestore(), runCollection, onData, onError));
  const run = record.status === "ok" ? record.data.run : null;
  return run && run.environment === environment ? run.reconsiderMaxPerDay : undefined;
}
