export interface BundledAacEmscriptenModule {
  readonly HEAPU8: Uint8Array;
  cwrap(
    name: string,
    returnType: string | null,
    argumentTypes: readonly string[],
  ): unknown;
}

export interface BundledAacEmscriptenModuleOptions {
  readonly instantiateWasm: (
    imports: WebAssembly.Imports,
    receiveInstance: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) => WebAssembly.Exports;
}

declare function createBundledAacEmscriptenModule(
  options: BundledAacEmscriptenModuleOptions,
): Promise<BundledAacEmscriptenModule>;

export default createBundledAacEmscriptenModule;
