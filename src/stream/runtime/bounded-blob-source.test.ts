import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface CapturedCustomSourceOptions {
  readonly getSize: () => number;
  readonly maxCacheSize: number;
  readonly prefetchProfile: string;
  readonly read: (start: number, end: number) => Promise<Uint8Array>;
}

const mocks = vi.hoisted(() => ({
  options: [] as CapturedCustomSourceOptions[],
}));

vi.mock("mediabunny", () => ({
  CustomSource: class CustomSource {
    constructor(options: CapturedCustomSourceOptions) {
      mocks.options.push(options);
    }
  },
}));

import {
  createBoundedBlobSource,
  createBoundedInputSource,
  getAudioStreamInputSize,
  readAudioStreamInputRange,
} from "./bounded-blob-source.js";

beforeEach(() => {
  mocks.options.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bounded MediaBunny Blob source", () => {
  it("configures the public CustomSource API without prefetching", () => {
    const blob = new Blob(["abcdef"]);

    const source = createBoundedBlobSource(blob, 4);

    expect(source.constructor.name).toBe("CustomSource");
    expect(currentOptions()).toMatchObject({
      maxCacheSize: 4,
      prefetchProfile: "none",
    });
    expect(currentOptions().getSize()).toBe(6);
  });

  it.each([
    ["non-Blob input", {} as Blob, 4],
    ["zero bound", new Blob(), 0],
    ["unsafe bound", new Blob(), 1.5],
  ] as const)("rejects invalid configuration: %s", (_label, blob, limit) => {
    expect(() => createBoundedBlobSource(blob, limit)).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );
    expect(mocks.options).toHaveLength(0);
  });

  it.each([0, 1.5] as const)(
    "rejects an invalid cumulative read bound: %s",
    (limit) => {
      expect(() => createBoundedBlobSource(new Blob(), 4, limit)).toThrowError(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
    },
  );

  it("reads exactly the requested range into one ArrayBuffer", async () => {
    createBoundedBlobSource(
      new Blob([new Uint8Array([10, 20, 30, 40, 50])]),
      4,
    );

    const bytes = await currentOptions().read(1, 5);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect([...bytes]).toEqual([20, 30, 40, 50]);
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.byteLength).toBe(4);
    expect(view.buffer).toBe(bytes.buffer);
    expect(view.getUint8(2)).toBe(40);
  });

  it("rejects a single read larger than the configured bound", async () => {
    createBoundedBlobSource(new Blob(["abcdef"]), 4);

    await expect(currentOptions().read(0, 5)).rejects.toMatchObject({
      code: "INVALID_AUDIO_DATA",
      message: expect.stringContaining("per-read limit is 4 bytes"),
    });
  });

  it("enforces the cumulative read bound across source reads", async () => {
    createBoundedBlobSource(new Blob(["abcdef"]), 4, 5);

    await expect(currentOptions().read(0, 3)).resolves.toHaveLength(3);
    await expect(currentOptions().read(3, 6)).rejects.toMatchObject({
      code: "RESOURCE_LIMIT_EXCEEDED",
      message: expect.stringContaining("5-byte cumulative read limit"),
    });
  });

  it.each([
    ["fractional start", 0.5, 1],
    ["negative start", -1, 1],
    ["fractional end", 0, 1.5],
    ["empty range", 1, 1],
    ["reversed range", 2, 1],
    ["past EOF", 0, 5],
  ] as const)(
    "rejects an invalid read range: %s",
    async (_label, start, end) => {
      createBoundedBlobSource(new Blob(["abcd"]), 8);

      await expect(currentOptions().read(start, end)).rejects.toMatchObject({
        code: "INVALID_AUDIO_DATA",
        message: expect.stringContaining("invalid byte range"),
      });
    },
  );

  it("rejects a Blob that returns fewer bytes than requested", async () => {
    const blob = new IncompleteBlob(["abcd"]);
    createBoundedBlobSource(blob, 4);

    await expect(currentOptions().read(0, 2)).rejects.toMatchObject({
      code: "INVALID_AUDIO_DATA",
      message: expect.stringContaining("incomplete byte range"),
    });
  });

  it("reads a serializable HTTP source with an exact byte range", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        rangeResponse([20, 30, 40], "bytes 1-3/5"),
    );
    vi.stubGlobal("fetch", fetch);
    createBoundedInputSource(
      {
        http: {
          credentials: "include",
          headers: { Authorization: "Bearer private" },
          size: 5,
          url: "https://example.test/api/tools/youtube-audio/source",
        },
      },
      4,
    );

    await expect(currentOptions().read(1, 4)).resolves.toEqual(
      new Uint8Array([20, 30, 40]),
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/api/tools/youtube-audio/source");
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "include",
      method: "GET",
      redirect: "error",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer private",
    );
    expect(new Headers(init?.headers).get("range")).toBe("bytes=1-3");
    expect(currentOptions().getSize()).toBe(5);
  });

  it("defaults HTTP credentials to same-origin and accepts a full 200 response", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2])),
    );
    vi.stubGlobal("fetch", fetch);
    const input = {
      http: { size: 2, url: "https://example.test/source" },
    } as const;

    await expect(readAudioStreamInputRange(input, 0, 2)).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
    });
    expect(getAudioStreamInputSize(input)).toBe(2);
  });

  it("rejects an HTTP source that ignores a partial range", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );

    await expect(
      readAudioStreamInputRange(
        { http: { size: 3, url: "https://example.test/source" } },
        1,
        3,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_AUDIO_DATA",
      message: expect.stringContaining("ignored a partial range"),
    });
  });

  it.each([
    [undefined, "missing"],
    ["bytes 0-1/3", "wrong start"],
    ["bytes 1-1/3", "wrong end"],
    ["bytes 1-2/4", "wrong size"],
  ] as const)(
    "rejects an invalid HTTP Content-Range: %s (%s)",
    async (contentRange, _reason) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => rangeResponse([1, 2], contentRange)),
      );

      await expect(
        readAudioStreamInputRange(
          { http: { size: 3, url: "https://example.test/source" } },
          1,
          3,
        ),
      ).rejects.toMatchObject({
        code: "INVALID_AUDIO_DATA",
        message: expect.stringContaining("invalid Content-Range"),
      });
    },
  );

  it("rejects failed and unexpected HTTP statuses", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 416 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const input = {
      http: { size: 2, url: "https://example.test/source" },
    } as const;

    await expect(readAudioStreamInputRange(input, 0, 2)).rejects.toMatchObject({
      code: "INVALID_AUDIO_DATA",
      message: expect.stringContaining("status 416"),
    });
    await expect(readAudioStreamInputRange(input, 0, 2)).rejects.toMatchObject({
      code: "INVALID_AUDIO_DATA",
      message: expect.stringContaining("unexpected status 204"),
    });
  });

  it("normalizes HTTP fetch failure without leaking the source URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("secret"))),
    );

    await expect(
      readAudioStreamInputRange(
        { http: { size: 1, url: "https://example.test/private?token=secret" } },
        0,
        1,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "INVALID_AUDIO_DATA",
        message: "The HTTP media range request failed.",
      }),
    );
  });

  it("maps an aborted HTTP request to the package abort error", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    );

    const pending = readAudioStreamInputRange(
      { http: { size: 1, url: "https://example.test/source" } },
      0,
      1,
      controller.signal,
    );
    controller.abort("stop");

    await expect(pending).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  });

  it("rejects a pre-aborted range read before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort("already stopped");

    await expect(
      readAudioStreamInputRange(
        { http: { size: 1, url: "https://example.test/source" } },
        0,
        1,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing source", {}],
    ["null source", { http: null }],
    ["fractional size", { http: { size: 1.5, url: "https://example.test" } }],
    ["negative size", { http: { size: -1, url: "https://example.test" } }],
    [
      "invalid credentials",
      {
        http: {
          credentials: "sometimes",
          size: 1,
          url: "https://example.test",
        },
      },
    ],
    ["relative URL", { http: { size: 1, url: "/source" } }],
    ["non-HTTP URL", { http: { size: 1, url: "file:///tmp/source" } }],
    [
      "embedded credentials",
      { http: { size: 1, url: "https://user:pass@example.test/source" } },
    ],
    [
      "array headers",
      { http: { headers: [], size: 1, url: "https://example.test" } },
    ],
  ] as const)("rejects invalid HTTP input: %s", (_label, input) => {
    expect(() => getAudioStreamInputSize(input as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
    );
  });

  it("rejects invalid or caller-owned Range headers", async () => {
    await expect(
      readAudioStreamInputRange(
        {
          http: {
            headers: { Range: "bytes=0-0" },
            size: 1,
            url: "https://example.test/source",
          },
        },
        0,
        1,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    await expect(
      readAudioStreamInputRange(
        {
          http: {
            headers: { "X-Bad": "line\nbreak" },
            size: 1,
            url: "https://example.test/source",
          },
        },
        0,
        1,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
});

function rangeResponse(
  bytes: readonly number[],
  contentRange: string | undefined,
): Response {
  return new Response(new Uint8Array(bytes), {
    headers:
      contentRange === undefined ? {} : { "Content-Range": contentRange },
    status: 206,
  });
}

class IncompleteBlob extends Blob {
  override slice(): Blob {
    return new Blob([new Uint8Array([1])]);
  }
}

function currentOptions(): CapturedCustomSourceOptions {
  const options = mocks.options.at(-1);
  if (options === undefined) {
    throw new Error("Expected CustomSource options.");
  }
  return options;
}
