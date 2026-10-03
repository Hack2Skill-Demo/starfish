/** Seeded fake credentials shared by the redaction tests. */
// Built by concatenation so this file doesn't itself look like a leaked credential.
export const SEEDED_SECRETS: Record<string, string> = {
  jwt: "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0" + "." + "c2lnbmF0dXJl",
  bearer: "Bearer " + "abcdef0123456789.xyz",
  googleApiKey: "AIza" + "SyD".padEnd(35, "x"),
  googleOAuth: "ya29." + "a0AfH6SMB".padEnd(40, "z"),
  githubToken: "ghp_" + "A1b2C3d4E5".repeat(4),
  githubPat: "github_pat_" + "11ABCDEFG0".repeat(4),
  awsKeyId: "AKIA" + "IOSFODNN7EXAMPLE",
  slackToken: "xoxb-" + "123456789012-abcdefABCDEF",
  slackWebhook: "https://hooks.slack.com/services/" + "T000/B000/XXXXXXXX",
  stripeKey: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  privateKey:
    "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END " + "PRIVATE KEY-----",
};
