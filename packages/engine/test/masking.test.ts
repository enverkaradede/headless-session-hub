import { describe, expect, it } from "vitest";
import { REDACTED, collectEnvSecrets, maskText, maskValue } from "../src/masking.ts";

// Fake secrets assembled at runtime so no secret-shaped literal sits in the repo.
const fakeToken = (prefix: string, length: number) => prefix + "Ab3".repeat(Math.ceil(length / 3)).slice(0, length);
const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "c2lnbmF0dXJlLXBhcnQ"].join(".");

describe("maskText", () => {
  it.each([
    ["a JWT", `token is ${jwt} ok`],
    ["a GitHub token", `use ${fakeToken("ghp_", 36)} now`],
    ["an Anthropic key", `ANTHROPIC=${fakeToken("sk-ant-api03-", 40)}`],
    ["an AWS access key id", `key ${fakeToken("AKIA", 16).toUpperCase()}`],
    ["a Slack token", fakeToken("xoxb-", 30)],
  ])("removes %s", (_label, input) => {
    const out = maskText(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/eyJzdWIi|ghp_Ab3|sk-ant-api03-Ab3|AKIAAB3|xoxb-Ab3/i);
  });

  it("keeps the scheme of an Authorization header but drops the credential", () => {
    expect(maskText("Authorization: Bearer abcdefgh12345678")).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(maskText('curl -H "Authorization: Basic dXNlcjpwYXNz"')).not.toContain("dXNlcjpwYXNz");
  });

  it("drops the password from a connection string but keeps user and host", () => {
    const out = maskText("postgres://app:hunter2secret@db.internal:5432/main");
    expect(out).toBe(`postgres://app:${REDACTED}@db.internal:5432/main`);
  });

  it("masks ADO.NET style connection string fields", () => {
    const out = maskText("Server=x;User Id=sa;Password=Sup3rS3cret!;AccountKey=abc123==;");
    expect(out).not.toContain("Sup3rS3cret");
    expect(out).not.toContain("abc123==");
  });

  it("masks key=value and JSON assignments with secret names", () => {
    expect(maskText("DB_PASSWORD=correcthorse")).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(maskText('{"client_secret": "s3cr3t-value"}')).toBe(`{"client_secret": "${REDACTED}"}`);
    expect(maskText("api_key: abcdef123456")).toBe(`api_key: ${REDACTED}`);
  });

  it("leaves harmless values under secret-looking keys alone", () => {
    expect(maskText("max_tokens: 4096")).toBe("max_tokens: 4096");
    expect(maskText("password: ${DB_PASSWORD}")).toBe("password: ${DB_PASSWORD}");
  });

  it("masks a YAML value that sits on the line after its key (block form)", () => {
    const yaml = ["wifis:", "  home:", "    password:", '      "wifi-psk-value-123"', "    hidden: false"].join("\n");
    const out = maskText(yaml);
    expect(out).not.toContain("wifi-psk-value-123");
    expect(out).toContain("hidden: false");
  });

  it("masks every line of a YAML block scalar under a secret key", () => {
    const yaml = ["secret: |", "  line-one-secret", "  line-two-secret", "other: visible"].join("\n");
    const out = maskText(yaml);
    expect(out).not.toMatch(/line-(one|two)-secret/);
    expect(out).toContain("other: visible");
  });

  it("masks a private key block, including an unterminated one", () => {
    const pem = ["-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAA", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
    expect(maskText(pem)).not.toContain("b3BlbnNzaC1rZXktdjEAAAA");
    expect(maskText("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA")).not.toContain("MIIEpAIBAAKCAQEA");
  });

  it("masks literal values of secret-named env vars wherever they appear", () => {
    const literals = collectEnvSecrets({ MY_SERVICE_TOKEN: "plain-looking-value", HOME: "/home/x" });
    expect(literals).toEqual(["plain-looking-value"]);
    expect(maskText("echo plain-looking-value | cat", literals)).toBe(`echo ${REDACTED} | cat`);
  });

  it("keeps non-ASCII text intact", () => {
    expect(maskText("C:\\Users\\AyşeŞahin\\proje çalıştı")).toBe("C:\\Users\\AyşeŞahin\\proje çalıştı");
  });
});

describe("maskValue", () => {
  it("drops values of secret-named keys and masks nested strings", () => {
    const masked = maskValue({
      command: `curl -H "Authorization: Bearer ${fakeToken("", 24)}" x`,
      env: { GITHUB_TOKEN: "abc-def-ghi", PATH: "/usr/bin" },
      nested: [{ password: "pw-123456" }],
    });
    const json = JSON.stringify(masked);
    expect(json).not.toContain("abc-def-ghi");
    expect(json).not.toContain("pw-123456");
    expect(json).not.toContain("Ab3Ab3Ab3");
    expect(json).toContain("/usr/bin");
  });
});
