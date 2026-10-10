/**
 * The feedback engine's write (src/triageRules.ts): an operator corrects how far Starfish should have gone with one
 * incident. ONE batch: the incident gets the latest correction (`corrected*`, which the engine reads as a cap), and its
 * `corrections` subcollection gets an immutable history entry; firestore.rules ties the two together.
 *
 * Only firebase/firestore and the shared schema are imported here, never the web config, so firestore.rules' test suite
 * runs THESE writes against the emulator: the page's real writes are what the rules are proven to accept.
 */
import { collection, deleteField, doc, getDocs, limit, orderBy, query, serverTimestamp, writeBatch, type Firestore } from "firebase/firestore";
import { MAX_NOTE, cleanText, isLevel, type Level } from "../../../src/triageRules";

/** The history entry's subcollection under an incident. firestore.rules names it too. */
export const CORRECTIONS = "corrections";

/** What each level means to the person choosing it. */
export const LEVEL_LABELS: Record<Level, string> = {
  noise: "Noise: decline it",
  log: "Log: an issue, a person fixes it",
  fix: "Fix: a pull request a person merges",
  merge: "Merge: no limit from me",
};

export async function saveCorrection(db: Firestore, incidentCollection: string, incidentId: string, uid: string, level: Level, note: string): Promise<void> {
  if (!isLevel(level)) throw new Error("Choose a level.");
  const text = note.trim() === "" ? null : cleanText(note, MAX_NOTE);
  if (note.trim() !== "" && text === null) throw new Error(`The note must be at most ${MAX_NOTE} characters, on one line.`);
  const incident = doc(db, incidentCollection, incidentId);
  const entry = doc(collection(incident, CORRECTIONS));
  const batch = writeBatch(db);
  batch.update(incident, {
    correctedLevel: level,
    correctedBy: uid,
    correctedAt: serverTimestamp(),
    correctionNote: text ?? deleteField(),
    correctionId: entry.id,
  });
  batch.set(entry, { level, by: uid, at: serverTimestamp(), ...(text !== null && { note: text }) });
  await batch.commit();
}

export interface CorrectionEntry {
  id: string;
  level: Level;
  by: string;
  /** ISO, or "" when the stored value was not a timestamp. */
  at: string;
  note?: string;
}

/** The newest corrections of an incident, newest first. An entry that is not one is skipped. */
export async function readCorrections(db: Firestore, incidentCollection: string, incidentId: string, max = 10): Promise<CorrectionEntry[]> {
  const snap = await getDocs(query(collection(db, incidentCollection, incidentId, CORRECTIONS), orderBy("at", "desc"), limit(max)));
  return snap.docs.flatMap((d) => {
    const v = d.data();
    if (!isLevel(v.level) || typeof v.by !== "string") return [];
    const at = (v.at as { toDate?: () => Date } | undefined)?.toDate?.();
    const note = cleanText(v.note, MAX_NOTE);
    return [{ id: d.id, level: v.level, by: v.by, at: at instanceof Date ? at.toISOString() : "", ...(note !== null && { note }) }];
  });
}
