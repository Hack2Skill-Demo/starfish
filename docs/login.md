# Login and account setup

Starfish uses Firebase email/password sign-in. There is no public signup. An Auth
account alone grants no application access: a trusted administrator must create its
`starfish_users/{uid}` role record in Starfish's named Firestore database.

| Role | Incident feed | Change incident status | Settings |
|---|---|---|---|
| admin | Engine incidents | Yes | Yes |
| operator | Engine incidents | Yes | No |
| viewer | Curated `demo_incidents` only | No | No |

A viewer cannot read `incidents`, other users' roles, configuration, or secrets.
Firestore rules enforce this independently of the UI. Multiple roles are additive;
a judge account must have **only** `viewer`.

## Initial deployment setup

1. In the Starfish Firebase project, enable Authentication → Email/Password. Enable
   email enumeration protection, configure the password policy and check the password
   reset email template/authorized domains. Use the same Firebase project for the web
   Auth configuration and the user records; the watched application can be elsewhere.
2. Create Starfish's named Firestore database. Deploy this repository's rules and
   indexes only to that database. Do not replace the watched application's rules.
3. Set `web/.env` using `web/.env.example`, including the intended environment label.
   Web configuration is still build-time; runtime bootstrap is tracked in #7.
   If collection names are changed, update the corresponding rules/indexes too.
4. Using trusted Application Default Credentials authorized for Firebase Auth user
   creation and the Starfish database, provision each account:

   ```bash
   pnpm provision:user --project YOUR_STARFISH_PROJECT --email admin@example.com --role admin
   pnpm provision:user --project YOUR_STARFISH_PROJECT --email judge@example.com --role viewer
   ```

   Optional flags: `--database starfish`, `--users-collection starfish_users`.
   The command requires an explicit project, creates a new Auth user with a random,
   undisclosed password and writes exactly one role. It refuses existing email
   addresses rather than silently changing access. It sends no email and prints no
   password or reset token. If the role write fails it removes only the new identity;
   a failed cleanup is reported for manual recovery. Confirm emulator environment
   variables are unset before intentionally provisioning a deployed project.
5. Use **Forgot password?** on the sign-in page with that account's email to request
   its initial password/reset link. The account owner completes Firebase's hosted
   reset flow. The app gives the same confirmation for missing and existing accounts.
   Transport failures are displayed so the user can retry.
6. For a shared judge account, use a team-controlled real mailbox; set its password
   through that mailbox and distribute credentials only in the submission channel.
   Never commit credentials. Judges do not need access to the recovery mailbox.

For an existing account, change `starfish_users/{uid}.roles` only through the trusted
admin console/SDK after checking the UID/email. Remove the role record to revoke data
access; also disable the Auth user/revoke sessions through Firebase for full offboarding.
Sign-out in the application signs out this browser; it does not revoke every session.

## Publishing judge evidence

`demo_incidents` is a separate read-only feed. It is empty until trusted tooling or
an administrator publishes curated synthetic evidence with the incident field shape
and matching environment. There is deliberately no automatic copy from the engine
store: private logs, stacks and identifiers must never be copied wholesale into it.
Full live evidence publishing/redaction remains part of #12/#18. Do not present seeded
fixtures as actual completed fixes. Firestore document reads expose every stored field.

## Local walkthrough

Run `pnpm dev:emulated`. The seed creates `admin@starfish.local`,
`operator@starfish.local`, `viewer@starfish.local` and `nobody@starfish.local`;
all have the emulator-only password `starfish`. The first three have matching roles;
`nobody` should receive Access Denied. Viewer fixtures are synthetic demo records.
Never use these fixture credentials in a deployed project.

The Auth emulator prints reset links locally instead of delivering real email.
Check sign-in, refresh, sign-out, password reset, viewer read-only access and direct
Settings navigation. For deployment, repeat this walkthrough against real Firebase,
verify mail delivery and hosted reset completion, and confirm a viewer cannot query
private incidents or mutate either feed. Deployment and that live walkthrough are not
claimed complete by this code change.
