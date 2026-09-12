import { describe, expect, it, vi } from "vitest";
import { fetchBoundedUrl, validateFetchUrl } from "./fetch-policy";

const publicAddress = async () => ["203.0.113.10"];
const pdf = (body = "%PDF-1.4 synthetic") =>
  new Response(Buffer.from(body), {
    headers: { "content-type": "application/pdf" }
  });
const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { location } });

describe("validateFetchUrl", () => {
  it("allows HTTPS public documents and rejects SSRF targets", () => {
    expect(
      validateFetchUrl("https://docs.example.com/manual.pdf").hostname
    ).toBe("docs.example.com");
    expect(() => validateFetchUrl("http://127.0.0.1/admin")).toThrow("HTTPS");
    expect(() =>
      validateFetchUrl("https://169.254.169.254/latest/meta-data")
    ).toThrow("private");
    expect(() => validateFetchUrl("https://localhost/manual.pdf")).toThrow(
      "private"
    );
    expect(() =>
      validateFetchUrl("https://metadata.google.internal/computeMetadata/v1/")
    ).toThrow("private");
  });

  it("never forwards credentials embedded in a source URL", () => {
    expect(() =>
      validateFetchUrl("https://user:secret@docs.example.com/manual.pdf")
    ).toThrow("credential");
  });
});

describe("fetchBoundedUrl", () => {
  it("rejects DNS rebinding to a private or loopback address before connecting", async () => {
    const fetchImpl = vi.fn();
    for (const address of [
      "10.1.2.3",
      "::ffff:127.0.0.1",
      "fd00::1",
      "169.254.169.254"
    ]) {
      await expect(
        fetchBoundedUrl("https://docs.example.com/manual.pdf", {
          fetchImpl,
          resolve: async () => [address]
        })
      ).rejects.toThrow("private");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a redirect into the metadata service or a non-HTTPS scheme", async () => {
    await expect(
      fetchBoundedUrl("https://docs.example.com/manual.pdf", {
        fetchImpl: async () =>
          redirect("https://169.254.169.254/latest/meta-data"),
        resolve: publicAddress
      })
    ).rejects.toThrow("private");
    await expect(
      fetchBoundedUrl("https://docs.example.com/manual.pdf", {
        fetchImpl: async () => redirect("http://docs.example.com/manual.pdf"),
        resolve: publicAddress
      })
    ).rejects.toThrow("HTTPS");
    const hops = vi.fn(async () =>
      redirect("https://docs.example.com/next.pdf")
    );
    await expect(
      fetchBoundedUrl("https://docs.example.com/manual.pdf", {
        fetchImpl: hops,
        resolve: publicAddress,
        maxRedirects: 2
      })
    ).rejects.toThrow("redirect limit");
    expect(hops).toHaveBeenCalledTimes(3);
  });

  it("rejects unsupported content types and oversized bodies", async () => {
    await expect(
      fetchBoundedUrl("https://docs.example.com/manual", {
        fetchImpl: async () =>
          new Response("<html></html>", {
            headers: { "content-type": "text/html" }
          }),
        resolve: publicAddress
      })
    ).rejects.toThrow("unsupported");
    await expect(
      fetchBoundedUrl("https://docs.example.com/manual.pdf", {
        fetchImpl: async () =>
          new Response(Buffer.alloc(64), {
            headers: {
              "content-type": "application/pdf",
              "content-length": "999"
            }
          }),
        resolve: publicAddress,
        maxBytes: 128
      })
    ).rejects.toThrow("byte limit");
    await expect(
      fetchBoundedUrl("https://docs.example.com/manual.pdf", {
        fetchImpl: async () => pdf("x".repeat(256)),
        resolve: publicAddress,
        maxBytes: 128
      })
    ).rejects.toThrow("byte limit");
  });

  it("returns bounded bytes with the final validated URL", async () => {
    const redirectModes: Array<RequestInit["redirect"]> = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      redirectModes.push(init?.redirect);
      return String(input).endsWith("/manual.pdf")
        ? redirect("https://cdn.example.com/final.pdf")
        : pdf();
    };
    const result = await fetchBoundedUrl(
      "https://docs.example.com/manual.pdf",
      { fetchImpl, resolve: publicAddress }
    );
    expect(result.finalUrl).toBe("https://cdn.example.com/final.pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.bytes.toString("utf8")).toContain("%PDF");
    expect(redirectModes).toEqual(["manual", "manual"]);
  });
});
