import { describe, expect, it } from "vitest";

import { detectCredentialWrite } from "../src/credential-write";

describe("credential write warnings", () => {
  it("warns on a generic prefixed high-entropy token", () => {
    const warning = detectCredentialWrite({
      target: "instructions",
      value: "Use svc_A7f9K2mQ8xR4tY6uP3nW5zB1 for authentication.",
    });

    expect(warning).toEqual({
      code: "credential-shaped-write",
      level: "warning",
      target: "instructions",
      shapes: ["prefixed-token"],
    });
  });

  it("warns on long hex and base64-shaped values inside nested writes", () => {
    expect(
      detectCredentialWrite({
        target: "memory",
        value: {
          durable: {
            first: "9f86d081884c7d659a2feaa0c55ad015",
            second: "QWxhZGRpbjpPcGVuU2VzYW1lMTIzNDU2Nzg5MA==",
          },
        },
      }),
    ).toEqual({
      code: "credential-shaped-write",
      level: "warning",
      target: "memory",
      shapes: ["long-hex", "long-opaque-token"],
    });
  });

  it("reports one most-specific shape for a prefixed or hex token", () => {
    expect(
      detectCredentialWrite({
        target: "instructions",
        value: "svc_A7f9K2mQ8xR4tY6uP3nW5zB1cD0eF",
      })?.shapes,
    ).toEqual(["prefixed-token"]);
    expect(
      detectCredentialWrite({
        target: "instructions",
        value: "9f86d081884c7d659a2feaa0c55ad015",
      })?.shapes,
    ).toEqual(["long-hex"]);
  });

  it("detects an opaque secret in a URL path as well as a query value", () => {
    const warning = detectCredentialWrite({
      target: "flow",
      value: [
        "https://hooks.example.test/external/run/A7f9K2mQ8xR4tY6uP3nW5zB1cD0eF",
        "https://api.example.test/callback?signature=F8d2Q6pL9sW4nR7yT1vX5zC3bM0kJ2hG",
      ],
    });

    expect(warning).toEqual({
      code: "credential-shaped-write",
      level: "warning",
      target: "flow",
      shapes: ["url-embedded-secret"],
    });
  });

  it("never returns the matched credential or source text", () => {
    const secret = "svc_A7f9K2mQ8xR4tY6uP3nW5zB1";
    const warning = detectCredentialWrite({ target: "instructions", value: { text: secret } });

    expect(JSON.stringify(warning)).not.toContain(secret);
    expect(warning).not.toHaveProperty("value");
    expect(warning).not.toHaveProperty("match");
  });

  it.each([
    "Write the weekly status update to memory.",
    "https://docs.example.test/guides/getting-started",
    "customer_12345",
    "550e8400-e29b-41d4-a716-446655440000",
  ])("stays silent for ordinary content: %s", (value) => {
    expect(detectCredentialWrite({ target: "memory", value })).toBeUndefined();
  });

  it("handles cycles without walking forever", () => {
    const value: Record<string, unknown> = { text: "ordinary content" };
    value.self = value;

    expect(detectCredentialWrite({ target: "flow", value })).toBeUndefined();
  });
});
