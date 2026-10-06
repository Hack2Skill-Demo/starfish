/**
 * Settings -> On-call (#37): who Starfish may phone when an urgent incident's Slack message goes unacknowledged, and
 * when. Admins only: the Settings page renders this for an admin and nobody else, and firestore.rules refuses every
 * read and write of these documents to anyone else (guests and operators never see a number). Numbers are shown masked
 * here too; a number is typed in, never read back.
 *
 * A person is added unconfirmed. "Send code" texts them a six-digit code through the admin API; once they read it back
 * and it is entered here, the engine marks the number confirmed. Only a confirmed number is ever called.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/authCore";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { toast } from "../components/ui/toast";
import { appAdminApi, confirmOnCallNumber, sendOnCallCode } from "../lib/adminApi";
import { webConfig } from "../lib/config";
import { firestore } from "../lib/firebase";
import { formFromPolicy, policyFromForm, type PolicyForm } from "../lib/onCallForm";
import { addPerson, normalizePhone, readOnCall, removePerson, savePolicy, type OnCallCollections } from "../lib/onCallWrite";
import { ONCALL_ROLES, ROLE_LABELS, validName, type OnCallRole } from "../../../src/oncallSchema";

const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 dark:border-gray-700 dark:placeholder:text-gray-400 dark:bg-gray-900 dark:text-gray-100";
const QUERY = ["oncall"] as const;

export function OnCallEditor() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const cfg = webConfig();
  const cols: OnCallCollections = { policy: cfg.onCallCollection, people: cfg.onCallPeopleCollection };
  const uid = user?.uid ?? "unknown";
  const data = useQuery({ queryKey: QUERY, queryFn: () => readOnCall(firestore(), cols), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY });

  const [form, setForm] = useState<PolicyForm | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [person, setPerson] = useState<{ name: string; role: OnCallRole; phone: string }>({ name: "", role: "primary", phone: "" });
  const [codes, setCodes] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data.isSuccess) setForm(formFromPolicy(data.data.policy));
  }, [data.isSuccess, data.data]);

  const savePolicyM = useMutation({
    mutationFn: (p: Parameters<typeof savePolicy>[3]) => savePolicy(firestore(), cols, uid, p),
    onSuccess: () => {
      toast.success("On-call policy saved");
      return refresh();
    },
    onError: () => toast.error("Not saved: the write failed or your access changed."),
  });
  const addM = useMutation({
    mutationFn: (p: { name: string; role: OnCallRole; phone: string }) => addPerson(firestore(), cols, uid, p),
    onSuccess: () => {
      setPerson({ name: "", role: "primary", phone: "" });
      toast.success("Added. Send them a code to confirm the number.");
      return refresh();
    },
    onError: () => toast.error("Not added: the write failed or your access changed."),
  });
  const removeM = useMutation({
    mutationFn: (id: string) => removePerson(firestore(), cols, id),
    onSuccess: refresh,
    onError: () => toast.error("Not removed: the write failed or your access changed."),
  });
  const sendM = useMutation({
    mutationFn: (id: string) => sendOnCallCode(appAdminApi(), id),
    onSuccess: (r) => (r.ok ? toast.success("Code sent by text. It is valid for ten minutes.") : toast.error(r.message)),
  });
  const confirmM = useMutation({
    mutationFn: (v: { id: string; code: string }) => confirmOnCallNumber(appAdminApi(), v.id, v.code),
    onSuccess: async (r) => {
      if (!r.ok) return toast.error(r.message);
      toast.success("Number confirmed.");
      await refresh();
    },
  });

  if (data.isPending) return <p className="text-sm text-gray-600 dark:text-gray-400">Loading the on-call rota…</p>;
  if (data.isError || !form) {
    return (
      <p role="alert" className="text-sm text-error-700 dark:text-error-400">
        Couldn&apos;t read the on-call rota. Only admins can; check that firestore.rules is deployed to the Starfish database.
      </p>
    );
  }

  const submitPolicy = () => {
    const r = policyFromForm(form);
    if (!r.ok) return setProblems(r.problems);
    setProblems([]);
    savePolicyM.mutate(r.policy);
  };
  const phone = normalizePhone(person.phone);
  const canAdd = validName(person.name) && phone !== null && !addM.isPending;
  const field = (key: keyof PolicyForm, label: string, hint: string, placeholder = "") => (
    <label className="block text-sm">
      <span className="font-medium text-gray-900 dark:text-white">{label}</span>
      <input className={`${INPUT} mt-1`} placeholder={placeholder} value={String(form[key])} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">{hint}</span>
    </label>
  );

  return (
    <section aria-labelledby="oncall" className="space-y-4">
      <div>
        <h2 id="oncall" className="text-lg font-semibold text-gray-900 dark:text-white">
          On-call
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          When an urgent incident&apos;s &quot;needs a human&quot; Slack message goes unacknowledged, Starfish phones the primary, the
          primary again two minutes later, then the secondary, then the support lead. The call plays one recorded message with no
          incident detail; 1 takes it, 2 texts the link, 3 passes it on. Off unless the engine&apos;s STARFISH_PHONE_ESCALATION is on
          too; a dry run places no call. Built, tested against a fake Twilio, never run against real Twilio. Numbers are personal
          data: only admins can see this, and only masked.
        </p>
      </div>

      <form
        className="grid gap-4 rounded-lg border border-gray-200 bg-white p-4 md:grid-cols-2 dark:border-gray-700 dark:bg-gray-800"
        onSubmit={(e) => {
          e.preventDefault();
          submitPolicy();
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium text-gray-900 md:col-span-2 dark:text-white">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Phone the on-call people (the admin&apos;s switch)
        </label>
        {field("waitMinutes", "Wait before the first call (minutes)", "After the Slack message, with nobody acknowledging. 1 to 240.", "10")}
        {field("dailyCapPerPerson", "Calls per person per day", "Across every incident, per UTC day. 1 to 20.", "5")}
        {field("quietStart", "Quiet hours start", "HH:MM, 24-hour. Leave both empty for none.", "22:00")}
        {field("quietEnd", "Quiet hours end", "Outside a critical incident nothing rings in between; it waits.", "07:00")}
        {field("timeZone", "Time zone", "Of the quiet hours: an IANA name such as Europe/London.", "UTC")}
        {field("criticalOccurrences", "Critical at (occurrences)", "A regression, or this many occurrences, rings during quiet hours too.", "100")}
        {problems.length > 0 && (
          <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-error-700 md:col-span-2 dark:text-error-400">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {data.data.policy === null && (
          <p role="alert" className="text-sm text-error-700 md:col-span-2 dark:text-error-400">
            The stored policy is not valid, so the engine places no call. Save it again to fix it.
          </p>
        )}
        <div className="md:col-span-2">
          <Button type="submit" disabled={savePolicyM.isPending}>
            {savePolicyM.isPending ? "Saving…" : "Save on-call policy"}
          </Button>
        </div>
      </form>

      <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="font-medium text-gray-900 dark:text-white">People</h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          For each role the earliest-added confirmed person is called. A number is called only once its owner confirmed it.
        </p>
        {data.data.people.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Nobody on the rota yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-200 text-sm dark:divide-gray-700">
            {data.data.people.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                <span className="font-medium text-gray-900 dark:text-white">{p.name}</span>
                <span className="text-gray-700 dark:text-gray-300">{ROLE_LABELS[p.role]}</span>
                <span className="font-mono text-xs text-gray-600 dark:text-gray-400">{p.maskedPhone}</span>
                <Badge tone={p.state === "confirmed" ? "success" : "neutral"}>{p.state === "confirmed" ? "Confirmed" : "Not confirmed"}</Badge>
                {p.state === "pending" && (
                  <>
                    <Button size="sm" variant="secondary" disabled={sendM.isPending} onClick={() => sendM.mutate(p.id)}>
                      Send code
                    </Button>
                    <input
                      aria-label={`Code for ${p.name}`}
                      inputMode="numeric"
                      maxLength={6}
                      className={`${INPUT} w-28`}
                      placeholder="123456"
                      value={codes[p.id] ?? ""}
                      onChange={(e) => setCodes({ ...codes, [p.id]: e.target.value.replace(/\D/g, "") })}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={confirmM.isPending || !/^\d{6}$/.test(codes[p.id] ?? "")}
                      onClick={() => confirmM.mutate({ id: p.id, code: codes[p.id] ?? "" })}
                    >
                      Confirm
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={removeM.isPending}
                  onClick={() => {
                    if (window.confirm(`Remove ${p.name} from the on-call rota?`)) removeM.mutate(p.id);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 grid gap-3 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) addM.mutate({ name: person.name, role: person.role, phone: phone });
          }}
        >
          <input aria-label="Name" className={INPUT} placeholder="Name" value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} />
          <select aria-label="Role" className={INPUT} value={person.role} onChange={(e) => setPerson({ ...person, role: e.target.value as OnCallRole })}>
            {ONCALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <input
            aria-label="Phone number"
            type="tel"
            autoComplete="off"
            className={INPUT}
            placeholder="+15551234567"
            value={person.phone}
            onChange={(e) => setPerson({ ...person, phone: e.target.value })}
          />
          <Button type="submit" disabled={!canAdd}>
            Add person
          </Button>
        </form>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">The number in international form, e.g. +15551234567. It is not shown again.</p>
      </div>
    </section>
  );
}
