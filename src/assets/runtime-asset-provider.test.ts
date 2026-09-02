import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createJsDelivrGitHubRuntimeAssetSource,
  createJsDelivrRuntimeAssetSource,
  createRuntimeAssetProvider,
  createSelfHostedRuntimeAssetSource,
  resolveRuntimeAssetUrl,
  type RuntimeAssetFetch,
  type RuntimeAssetLoadState,
  type RuntimeAssetManifest,
  type RuntimeAssetProviderOptions,
} from "./runtime-asset-provider.js";

const ABC_BYTES = new Uint8Array([97, 98, 99]);
const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const MANIFEST: RuntimeAssetManifest = {
  schemaVersion: 1,
  version: "1.0.0",
  abiVersion: 1,
  assets: {
    aac: {
      path: "aac.wasm",
      bytes: ABC_BYTES.byteLength,
      sha256: ABC_SHA256.toUpperCase(),
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtime asset sources", () => {
  it("uses an exact GitHub tag and base path in jsDelivr URLs", () => {
    const source = createJsDelivrGitHubRuntimeAssetSource(
      "echovisionlab/audio-transcoder",
      "v1.2.3-beta.4+build.5",
      "codec-assets",
    );

    expect(Object.isFrozen(source)).toBe(true);
    expect(resolveRuntimeAssetUrl(source, "wasm/aac encoder.wasm")).toBe(
      "https://cdn.jsdelivr.net/gh/echovisionlab/audio-transcoder@v1.2.3-beta.4+build.5/codec-assets/wasm/aac%20encoder.wasm",
    );
  });

  it.each(["1.2.3", "vlatest", "v^1.2.3", "v1.2", "v01.2.3"])(
    "rejects the non-exact jsDelivr GitHub tag %s",
    (tag) => {
      expect(() =>
        createJsDelivrGitHubRuntimeAssetSource(
          "echovisionlab/audio-transcoder",
          tag,
          "codec-assets",
        ),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
    },
  );

  it.each([
    ["example/audio/transcoder", "codec-assets"],
    ["echovisionlab/audio-transcoder", "../codec-assets"],
  ])(
    "rejects an invalid GitHub repository or base path",
    (repository, basePath) => {
      expect(() =>
        createJsDelivrGitHubRuntimeAssetSource(repository, "v1.2.3", basePath),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
    },
  );

  it("uses an exact npm version and a stable asset name in jsDelivr URLs", () => {
    const source = createJsDelivrRuntimeAssetSource(
      "@echovisionlab/audio-transcoder-codecs",
      "1.2.3-beta.4+build.5",
    );

    expect(Object.isFrozen(source)).toBe(true);
    expect(resolveRuntimeAssetUrl(source, "wasm/aac encoder.wasm")).toBe(
      "https://cdn.jsdelivr.net/npm/@echovisionlab/audio-transcoder-codecs@1.2.3-beta.4+build.5/wasm/aac%20encoder.wasm",
    );
  });

  it.each(["latest", "^1.2.3", "~1.2.3", "1.2", "01.2.3"])(
    "rejects the non-exact jsDelivr version %s",
    (version) => {
      expect(() =>
        createJsDelivrRuntimeAssetSource("@example/codecs", version),
      ).toThrowError(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
    },
  );

  it("rejects an invalid npm package name", () => {
    expect(() =>
      createJsDelivrRuntimeAssetSource("@example/../codecs", "1.0.0"),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message: "Invalid npm package name: @example/../codecs",
      }),
    );
  });

  it("normalizes a caller-selected self-host base URL", () => {
    const source = createSelfHostedRuntimeAssetSource(
      "https://assets.example.test/audio/v1///",
    );

    expect(Object.isFrozen(source)).toBe(true);
    expect(resolveRuntimeAssetUrl(source, "aac.wasm")).toBe(
      "https://assets.example.test/audio/v1/aac.wasm",
    );
  });

  it.each(["", "/", "https://assets.test/v1?token=x", "/assets/v1#hash"])(
    "rejects the unsafe self-host base URL %j",
    (baseUrl) => {
      expect(() => createSelfHostedRuntimeAssetSource(baseUrl)).toThrowError(
        expect.objectContaining({ code: "INVALID_CONFIGURATION" }),
      );
    },
  );

  it.each([
    "",
    "/aac.wasm",
    "wasm//aac.wasm",
    "wasm/./aac.wasm",
    "wasm/../aac.wasm",
    "wasm\\aac.wasm",
    "aac.wasm?raw=1",
    "aac.wasm#v1",
  ])("rejects the unsafe package-relative asset path %j", (assetPath) => {
    expect(() =>
      resolveRuntimeAssetUrl(
        createSelfHostedRuntimeAssetSource("/assets/v1"),
        assetPath,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  });
});

describe("runtime asset manifest validation", () => {
  it("requires callers to select a source explicitly", () => {
    expect(() =>
      createRuntimeAssetProvider({
        manifest: MANIFEST,
        expectedAbiVersion: 1,
      } as RuntimeAssetProviderOptions),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message: "A runtime asset source must be selected explicitly.",
      }),
    );
  });

  it.each([
    ["expected ABI version", 0, 1],
    ["expected ABI version", 1.5, 1],
    ["manifest ABI version", 1, 0],
    ["manifest ABI version", 1, Number.NaN],
  ] as const)(
    "rejects an invalid %s",
    (label, expectedAbiVersion, manifestAbiVersion) => {
      expect(() =>
        createProvider(workingFetch(), {
          expectedAbiVersion,
          manifest: { ...MANIFEST, abiVersion: manifestAbiVersion },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "INVALID_CONFIGURATION",
          message: `${label} must be a positive integer.`,
        }),
      );
    },
  );

  it("rejects an incompatible ABI before fetching an asset", () => {
    const fetchAsset = workingFetch();

    expect(() =>
      createProvider(fetchAsset, { expectedAbiVersion: 2 }),
    ).toThrowError(
      expect.objectContaining({
        code: "ABI_MISMATCH",
        message: "Runtime asset ABI mismatch: expected 2, received 1.",
      }),
    );
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("rejects a non-exact manifest version", () => {
    expect(() =>
      createProvider(workingFetch(), {
        manifest: { ...MANIFEST, version: "latest" },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message:
          "Runtime asset manifest requires an exact version, received: latest",
      }),
    );
  });

  it("rejects an unsupported manifest schema version", () => {
    expect(() =>
      createProvider(workingFetch(), {
        manifest: {
          ...MANIFEST,
          schemaVersion: 2,
        } as unknown as RuntimeAssetManifest,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message: "Unsupported runtime asset manifest schema version: 2",
      }),
    );
  });

  it("requires the jsDelivr package and manifest versions to match", () => {
    expect(() =>
      createProvider(workingFetch(), {
        source: createJsDelivrRuntimeAssetSource("@example/codecs", "1.0.1"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message:
          "jsDelivr package version 1.0.1 does not match manifest version 1.0.0.",
      }),
    );
  });

  it("requires the jsDelivr GitHub tag and manifest versions to match", () => {
    expect(() =>
      createProvider(workingFetch(), {
        source: createJsDelivrGitHubRuntimeAssetSource(
          "echovisionlab/audio-transcoder",
          "v1.0.1",
          "codec-assets",
        ),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message:
          "jsDelivr GitHub tag v1.0.1 does not match manifest version 1.0.0.",
      }),
    );
  });

  it("validates jsDelivr versions in fallback sources too", () => {
    expect(() =>
      createProvider(workingFetch(), {
        fallbackSources: [
          createJsDelivrRuntimeAssetSource("@example/codecs", "1.0.1"),
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_CONFIGURATION",
        message:
          "jsDelivr package version 1.0.1 does not match manifest version 1.0.0.",
      }),
    );
  });

  it.each([
    [
      "empty name",
      { "": { path: "aac.wasm", bytes: 3, sha256: ABC_SHA256 } },
      "Runtime asset names must not be empty.",
    ],
    [
      "unsafe path",
      { aac: { path: "../aac.wasm", bytes: 3, sha256: ABC_SHA256 } },
      "Runtime asset path must be a safe package-relative path: ../aac.wasm",
    ],
    [
      "zero byte size",
      { aac: { path: "aac.wasm", bytes: 0, sha256: ABC_SHA256 } },
      "byte size for runtime asset aac must be a positive integer.",
    ],
    [
      "fractional byte size",
      { aac: { path: "aac.wasm", bytes: 1.5, sha256: ABC_SHA256 } },
      "byte size for runtime asset aac must be a positive integer.",
    ],
    [
      "invalid digest",
      { aac: { path: "aac.wasm", bytes: 3, sha256: "not-a-digest" } },
      "Runtime asset aac must declare a 64-character hexadecimal SHA-256 digest.",
    ],
  ] as const)("rejects a manifest with an %s", (_case, assets, message) => {
    expect(() =>
      createProvider(workingFetch(), {
        manifest: {
          schemaVersion: 1,
          version: "1.0.0",
          abiVersion: 1,
          assets,
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_CONFIGURATION", message }),
    );
  });
});

describe("runtime asset loading", () => {
  it("reports progress, deduplicates concurrent loads, and returns safe copies", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ABC_BYTES.slice(0, 1));
        controller.enqueue(ABC_BYTES.slice(1));
        controller.close();
      },
    });
    const fetchAsset = vi.fn<RuntimeAssetFetch>(async () =>
      responseWith(stream, { "content-length": "3" }),
    );
    const provider = createProvider(fetchAsset);
    const observed: RuntimeAssetLoadState[] = [];
    provider.subscribe(() => {
      throw new Error("observer failure must be isolated");
    });
    const unsubscribe = provider.subscribe((state) => observed.push(state));

    expect(provider.abiVersion).toBe(1);
    expect(provider.getState("aac")).toEqual({
      assetName: "aac",
      phase: "idle",
      loadedBytes: 0,
      totalBytes: null,
      error: null,
    });
    expect(provider.resolveUrl("aac")).toBe("/runtime-assets/aac.wasm");
    expect(provider.resolveUrls("aac")).toEqual(["/runtime-assets/aac.wasm"]);
    expect(Object.isFrozen(provider.resolveUrls("aac"))).toBe(true);

    const first = provider.load("aac");
    const concurrent = provider.load("aac");
    expect(concurrent).not.toBe(first);
    const [firstBytes, concurrentBytes] = await Promise.all([
      first,
      concurrent,
    ]);
    expect(firstBytes).toEqual(ABC_BYTES);
    expect(concurrentBytes).toEqual(ABC_BYTES);
    expect(firstBytes).not.toBe(concurrentBytes);
    firstBytes[0] = 0;
    const cachedBytes = await provider.load("aac");
    expect(cachedBytes).toEqual(ABC_BYTES);
    expect(cachedBytes).not.toBe(concurrentBytes);
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(fetchAsset).toHaveBeenCalledWith("/runtime-assets/aac.wasm", {
      signal: expect.any(AbortSignal),
    });
    expect(observed.map(({ phase }) => phase)).toEqual([
      "downloading",
      "downloading",
      "downloading",
      "downloading",
      "verifying",
      "ready",
    ]);
    expect(
      observed.map(({ loadedBytes, totalBytes }) => [loadedBytes, totalBytes]),
    ).toEqual([
      [0, null],
      [0, 3],
      [1, 3],
      [3, 3],
      [3, 3],
      [3, 3],
    ]);
    expect(Object.isFrozen(provider.getState("aac"))).toBe(true);
    expect(provider.getState("aac").phase).toBe("ready");

    unsubscribe();
  });

  it.each([
    [new Error("already stopped"), "already stopped"],
    [42, "Runtime asset load was aborted."],
  ] as const)(
    "rejects a pre-aborted load without starting fetch (%#)",
    async (reason, message) => {
      const fetchAsset = workingFetch();
      const provider = createProvider(fetchAsset);
      const signal = {
        aborted: true,
        reason,
      } as AbortSignal;

      await expect(provider.load("aac", signal)).rejects.toMatchObject({
        code: "LOAD_ABORTED",
        message,
      });
      expect(fetchAsset).not.toHaveBeenCalled();
      expect(provider.getState("aac").phase).toBe("idle");
    },
  );

  it("aborts a non-cooperative fetch promptly and permits a clean retry", async () => {
    const never = new Promise<Response>(() => undefined);
    const fetchAsset = vi
      .fn<RuntimeAssetFetch>()
      .mockImplementationOnce(() => never)
      .mockResolvedValueOnce(responseWith(ABC_BYTES));
    const provider = createProvider(fetchAsset);
    const controller = new AbortController();

    const pending = provider.load("aac", controller.signal);
    await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledOnce());
    const internalSignal = fetchAsset.mock.calls[0]?.[1]?.signal;
    controller.abort("asset no longer needed");
    const retry = provider.load("aac");

    await expect(pending).rejects.toMatchObject({
      code: "LOAD_ABORTED",
      message: "asset no longer needed",
    });
    expect(internalSignal).toBeInstanceOf(AbortSignal);
    expect((internalSignal as AbortSignal).aborted).toBe(true);
    await expect(retry).resolves.toEqual(ABC_BYTES);
    expect(fetchAsset).toHaveBeenCalledTimes(2);
    expect(provider.getState("aac").phase).toBe("ready");
  });

  it("keeps a shared fetch alive for a remaining subscriber", async () => {
    const response = deferred<Response>();
    const fetchAsset = vi.fn<RuntimeAssetFetch>(() => response.promise);
    const provider = createProvider(fetchAsset);
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = provider.load("aac", firstController.signal);
    const second = provider.load("aac", secondController.signal);
    await vi.waitFor(() => expect(fetchAsset).toHaveBeenCalledOnce());
    const internalSignal = fetchAsset.mock.calls[0]?.[1]?.signal as AbortSignal;
    firstController.abort("first caller stopped");

    await expect(first).rejects.toMatchObject({
      code: "LOAD_ABORTED",
      message: "first caller stopped",
    });
    expect(internalSignal.aborted).toBe(false);
    response.resolve(responseWith(ABC_BYTES));
    await expect(second).resolves.toEqual(ABC_BYTES);
    expect(internalSignal.aborted).toBe(false);
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it("cancels a pending body reader when the final subscriber aborts", async () => {
    const read = deferred<ReadableStreamReadResult<Uint8Array>>();
    const reader = {
      cancel: vi.fn().mockRejectedValue(new Error("reader cancel failed")),
      read: vi.fn(() => read.promise),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const provider = createProvider(async () => response);
    const controller = new AbortController();

    const pending = provider.load("aac", controller.signal);
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());
    controller.abort("stop reading");

    await expect(pending).rejects.toMatchObject({
      code: "LOAD_ABORTED",
      message: "stop reading",
    });
    await vi.waitFor(() => {
      expect(reader.cancel).toHaveBeenCalledWith("stop reading");
      expect(reader.releaseLock).toHaveBeenCalledOnce();
    });
    expect(provider.getState("aac")).toMatchObject({
      error: null,
      phase: "idle",
    });
    read.reject(new Error("late reader failure"));
  });

  it("handles cancellation that happens while starting a body read", async () => {
    const controller = new AbortController();
    const arrayBuffer = vi.fn(() => {
      controller.abort("stopped before body read");
      return Promise.reject(new Error("late arrayBuffer failure"));
    });
    const response = {
      arrayBuffer,
      body: null,
      headers: new Headers(),
      ok: true,
      status: 200,
      statusText: "OK",
    } as unknown as Response;
    const provider = createProvider(async () => response);

    await expect(provider.load("aac", controller.signal)).rejects.toMatchObject(
      {
        code: "LOAD_ABORTED",
        message: "stopped before body read",
      },
    );
    expect(arrayBuffer).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(provider.getState("aac").phase).toBe("idle"));
  });

  it("loads without total-byte progress when Content-Length is absent", async () => {
    const provider = createProvider(
      vi.fn<RuntimeAssetFetch>(async () => new Response(ABC_BYTES)),
    );
    const observed: RuntimeAssetLoadState[] = [];
    provider.subscribe((state) => observed.push(state));

    await expect(provider.load("aac")).resolves.toEqual(ABC_BYTES);

    expect(observed.every(({ totalBytes }) => totalBytes === null)).toBe(true);
    expect(observed.at(-1)).toMatchObject({
      phase: "ready",
      loadedBytes: 3,
      totalBytes: null,
    });
  });

  it("supports responses without a readable stream", async () => {
    const arrayBuffer = vi.fn(async () => ABC_BYTES.slice().buffer);
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: null,
      arrayBuffer,
    } as unknown as Response;
    const provider = createProvider(async () => response);

    await expect(provider.load("aac")).resolves.toEqual(ABC_BYTES);
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it("uses global fetch only when a fetch implementation is not supplied", async () => {
    const fetchAsset = workingFetch();
    vi.stubGlobal("fetch", fetchAsset);
    const provider = createRuntimeAssetProvider({
      manifest: MANIFEST,
      expectedAbiVersion: 1,
      source: createSelfHostedRuntimeAssetSource("/runtime-assets"),
    });

    await expect(provider.load("aac")).resolves.toEqual(ABC_BYTES);
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it.each(["getState", "resolveUrl", "load"] as const)(
    "rejects an asset absent from the manifest through %s",
    (method) => {
      const provider = createProvider(workingFetch());

      expect(() => provider[method]("missing")).toThrowError(
        expect.objectContaining({
          code: "ASSET_NOT_FOUND",
          message: "Runtime asset is not present in the manifest: missing",
        }),
      );
    },
  );

  it("rejects a non-successful HTTP response with a clear error state", async () => {
    const provider = createProvider(
      vi.fn<RuntimeAssetFetch>(
        async () =>
          new Response("missing", { status: 404, statusText: "Not Found" }),
      ),
    );

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      message: "Failed to download runtime asset aac: HTTP 404 Not Found.",
    });
    expect(provider.getState("aac")).toMatchObject({
      phase: "error",
      loadedBytes: 0,
      totalBytes: null,
      error: { code: "HTTP_ERROR" },
    });
  });

  it.each(["not-a-number", "-1", "1.5", "9007199254740992"])(
    "rejects the invalid Content-Length %s",
    async (contentLength) => {
      const provider = createProvider(
        vi.fn<RuntimeAssetFetch>(async () =>
          responseWith(ABC_BYTES, { "content-length": contentLength }),
        ),
      );

      await expect(provider.load("aac")).rejects.toMatchObject({
        code: "HTTP_ERROR",
        message: `Runtime asset aac returned an invalid Content-Length header: ${contentLength}.`,
      });
    },
  );

  it("does not confuse compressed Content-Length with decoded asset size", async () => {
    const provider = createProvider(
      vi.fn<RuntimeAssetFetch>(async () =>
        responseWith(ABC_BYTES, { "content-length": "4" }),
      ),
    );

    await expect(provider.load("aac")).resolves.toEqual(ABC_BYTES);
    expect(provider.getState("aac")).toMatchObject({
      phase: "ready",
      loadedBytes: 3,
      totalBytes: null,
    });
  });

  it("rejects a short response body when Content-Length is absent", async () => {
    const provider = createProvider(
      vi.fn<RuntimeAssetFetch>(async () => new Response(ABC_BYTES.slice(0, 2))),
    );

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "SIZE_MISMATCH",
      message:
        "Runtime asset aac has the wrong byte size: expected 3, received 2.",
    });
  });

  it("stops reading a response body as soon as it exceeds the manifest size", async () => {
    const cancel = vi.fn();
    const reader = {
      read: vi.fn().mockResolvedValueOnce({
        done: false,
        value: new Uint8Array([1, 2, 3, 4]),
      }),
      cancel,
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const provider = createProvider(async () => response);

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "SIZE_MISMATCH",
      message:
        "Runtime asset aac has the wrong byte size: expected 3, received 4.",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it("does not await a non-cooperative oversized-body cancel and permits retry", async () => {
    const cancellation = deferred<void>();
    const reader = {
      read: vi.fn().mockResolvedValueOnce({
        done: false,
        value: new Uint8Array([1, 2, 3, 4]),
      }),
      cancel: vi.fn(() => cancellation.promise),
      releaseLock: vi.fn(),
    };
    const oversizedResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const fetchAsset = vi
      .fn<RuntimeAssetFetch>()
      .mockResolvedValueOnce(oversizedResponse)
      .mockResolvedValueOnce(responseWith(ABC_BYTES));
    const provider = createProvider(fetchAsset);

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "SIZE_MISMATCH",
      message:
        "Runtime asset aac has the wrong byte size: expected 3, received 4.",
    });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
    expect(provider.getState("aac").phase).toBe("error");

    cancellation.reject(new Error("late reader cancellation failure"));
    await expect(provider.load("aac")).resolves.toEqual(ABC_BYTES);
    expect(fetchAsset).toHaveBeenCalledTimes(2);
  });

  it("preserves the size error when an oversized-body cancel throws", async () => {
    const reader = {
      read: vi.fn().mockResolvedValueOnce({
        done: false,
        value: new Uint8Array([1, 2, 3, 4]),
      }),
      cancel: vi.fn(() => {
        throw new Error("reader refused cancellation");
      }),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const provider = createProvider(async () => response);

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "SIZE_MISMATCH",
    });
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it("rejects bytes whose SHA-256 does not match the manifest", async () => {
    const provider = createProvider(workingFetch(), {
      manifest: {
        ...MANIFEST,
        assets: {
          aac: { ...MANIFEST.assets.aac!, sha256: "0".repeat(64) },
        },
      },
    });

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "INTEGRITY_MISMATCH",
      message: expect.stringContaining(
        "Runtime asset aac failed SHA-256 verification",
      ),
    });
    expect(provider.getState("aac")).toMatchObject({
      phase: "error",
      loadedBytes: 3,
      error: { code: "INTEGRITY_MISMATCH" },
    });
  });

  it("normalizes transport failures and permits a later retry", async () => {
    const fetchAsset = vi
      .fn<RuntimeAssetFetch>()
      .mockRejectedValueOnce(new Error("network offline"))
      .mockRejectedValueOnce("connection reset")
      .mockResolvedValueOnce(responseWith(ABC_BYTES));
    const provider = createProvider(fetchAsset);

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: "Failed to load runtime asset aac: network offline",
    });
    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: "Failed to load runtime asset aac: connection reset",
    });
    await expect(provider.load("aac")).resolves.toEqual(ABC_BYTES);
    expect(fetchAsset).toHaveBeenCalledTimes(3);
  });

  it("uses a verified fallback after the primary source fails", async () => {
    const fetchAsset = vi
      .fn<RuntimeAssetFetch>()
      .mockResolvedValueOnce(
        new Response("missing", { status: 404, statusText: "Not Found" }),
      )
      .mockResolvedValueOnce(responseWith(ABC_BYTES));
    const provider = createProvider(fetchAsset, {
      fallbackSources: [
        createSelfHostedRuntimeAssetSource("/local-codec-assets"),
      ],
    });

    expect(provider.resolveUrls("aac")).toEqual([
      "/runtime-assets/aac.wasm",
      "/local-codec-assets/aac.wasm",
    ]);
    await expect(provider.load("aac")).resolves.toEqual(ABC_BYTES);
    expect(fetchAsset.mock.calls.map(([url]) => url)).toEqual([
      "/runtime-assets/aac.wasm",
      "/local-codec-assets/aac.wasm",
    ]);
  });

  it("requires a fallback to pass the same integrity manifest", async () => {
    const fetchAsset = vi
      .fn<RuntimeAssetFetch>()
      .mockImplementation(async () =>
        responseWith(new Uint8Array([120, 121, 122])),
      );
    const provider = createProvider(fetchAsset, {
      fallbackSources: [
        createSelfHostedRuntimeAssetSource("/local-codec-assets"),
      ],
    });

    await expect(provider.load("aac")).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      message: expect.stringContaining("failed SHA-256 verification"),
    });
    expect(fetchAsset).toHaveBeenCalledTimes(2);
    expect(provider.getState("aac")).toMatchObject({
      error: { code: "DOWNLOAD_FAILED" },
      phase: "error",
    });
  });
});

function createProvider(
  fetchAsset: RuntimeAssetFetch,
  overrides: Partial<RuntimeAssetProviderOptions> = {},
) {
  return createRuntimeAssetProvider({
    manifest: MANIFEST,
    expectedAbiVersion: 1,
    source: createSelfHostedRuntimeAssetSource("/runtime-assets"),
    fetch: fetchAsset,
    ...overrides,
  });
}

function workingFetch(): ReturnType<typeof vi.fn<RuntimeAssetFetch>> {
  return vi.fn<RuntimeAssetFetch>(async () => responseWith(ABC_BYTES));
}

function responseWith(body: BodyInit, headers?: HeadersInit): Response {
  return new Response(body, headers === undefined ? {} : { headers });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
