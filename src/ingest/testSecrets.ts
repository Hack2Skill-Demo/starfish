/** Seeded fake credentials shared by the redaction tests. */
// Built by concatenation so this file doesn't itself look like a leaked credential.
export const SEEDED_SECRETS: Record<string, string> = {
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0" + "." + "c2lnbmF0dXJl",
  bearerHeader: "Bearer " + "abcdef0123456789.xyz",
  google: "AIza" + "SyD".padEnd(35, "x"),
  googleOauth: "ya29." + "a0AfH6SMB".padEnd(40, "z"),
  github: "ghp_" + "A1b2C3d4E5".repeat(4),
  githubPat: "github_pat_" + "11ABCDEFG0".repeat(4),
  awsId: "AKIA" + "IOSFODNN7EXAMPLE",
  slack: "xoxb-" + "123456789012-abcdefABCDEF",
  slackHook: "https://hooks.slack.com/services/" + "T000/B000/XXXXXXXX",
  stripe: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  pem:
    "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END " + "PRIVATE KEY-----",
};
