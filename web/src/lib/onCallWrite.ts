/**
 * Reading and saving the on-call rota and policy (#37, src/oncall/ on the engine): Settings -> On-call, admins only.
 *
 * Only firebase/firestore and the shared schema are imported here, never the web config, so firestore.rules' test suite
 * runs THESE writes against the emulator: the editor's real writes are what the rules are proven to accept.
 *
 * A phone number never leaves this module unmasked: `readOnCall` hands the page `+1 ••• ••• ••42`, and a number is only
 * ever written (when an admin adds a person or replaces their number), never read back into the page. A person is
 * created `pending`; only the engine confirms a number, when its owner reads back the code it texted
 * (src/oncall/optIn.ts, through the admin API).
 */
import { collection, deleteDoc, doc, getDoc, getDocs, limit, query, serverTimestamp, setDoc, updateDoc, type Firestore } from "firebase/firestore";
import { E164_RE, POLICY_DOC, maskPhone, parsePerson, parsePolicy, type OnCallPolicy, type OnCallRole, type PersonState } from "../../../src/oncallSchema";

export interface OnCallCollections {
  policy: string;
  people: string;
}

/** A person as the page sees them: the number masked. */
export interface PersonView {
  id: string;
  name: string;
  role: OnCallRole;
  maskedPhone: string;
  state: PersonState;
}

export interface OnCallView {
  /** null: the stored policy is not valid (the engine then places no call). */
  policy: OnCallPolicy | null;
  people: PersonView[];
}

const MAX_PEOPLE = 50;

export async function readOnCall(db: Firestore, cols: OnCallCollections): Promise<OnCallView> {
  const [policySnap, peopleSnap] = await Promise.all([getDoc(doc(db, cols.policy, POLICY_DOC)), getDocs(query(collection(db, cols.people), limit(MAX_PEOPLE)))]);
  const people = peopleSnap.docs
    .map((d) => {
      const created = (d.get("createdAt") as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      const p = parsePerson(d.id, d.data(), created);
      return p && { created, view: { id: p.id, name: p.name, role: p.role, maskedPhone: maskPhone(p.phone), state: p.state } };
    })
    .filter((p): p is { created: number; view: PersonView } => p !== null)
    .sort((a, b) => a.created - b.created)
    .map((p) => p.view);
  return { policy: parsePolicy(policySnap.exists() ? policySnap.data() : undefined), people };
}

/** "+15551234567" from what an admin typed: spaces, dashes, dots and brackets dropped. null when it is not E.164. */
export function normalizePhone(raw: string): string | null {
  const v = raw.replace(/[\s().-]/g, "");
  return E164_RE.test(v) ? v : null;
}

/** Add a person, unconfirmed. Returns the new id. */
export async function addPerson(db: Firestore, cols: OnCallCollections, uid: string, person: { name: string; role: OnCallRole; phone: string }): Promise<string> {
  const ref = doc(collection(db, cols.people));
  await setDoc(ref, {
    name: person.name.trim(),
    role: person.role,
    phone: person.phone,
    state: "pending",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });
  return ref.id;
}

/** Change a person's name or role, and with `phone` their number, which then needs confirming again. */
export async function updatePerson(
  db: Firestore,
  cols: OnCallCollections,
  uid: string,
  id: string,
  change: { name: string; role: OnCallRole; phone?: string }
): Promise<void> {
  await updateDoc(doc(db, cols.people, id), {
    name: change.name.trim(),
    role: change.role,
    ...(change.phone !== undefined && { phone: change.phone, state: "pending" }),
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });
}

export async function removePerson(db: Firestore, cols: OnCallCollections, id: string): Promise<void> {
  await deleteDoc(doc(db, cols.people, id));
}

/** Save the whole policy. Quiet hours are both set or both empty. */
export async function savePolicy(db: Firestore, cols: OnCallCollections, uid: string, policy: OnCallPolicy): Promise<void> {
  await setDoc(doc(db, cols.policy, POLICY_DOC), {
    enabled: policy.enabled,
    waitMinutes: policy.waitMinutes,
    quietStart: policy.quietStart ?? "",
    quietEnd: policy.quietEnd ?? "",
    timeZone: policy.timeZone,
    dailyCapPerPerson: policy.dailyCapPerPerson,
    criticalOccurrences: policy.criticalOccurrences,
    updatedAt: serverTimestamp(),
    updatedBy: uid,
  });
}
