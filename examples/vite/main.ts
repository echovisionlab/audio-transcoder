import {
  AUDIO_TRANSCODER_STREAM_CAPABILITIES,
  AUDIO_TRANSCODER_VERSION,
  AudioTranscoderError,
  createAudioTranscoderStreamWorkerEngine,
  createSelfHostedRuntimeAssetSource,
  type AudioDitherMode,
  type AudioStreamInputSupportResult,
  type AudioStreamInspection,
  type AudioStreamOutputProbeTarget,
  type AudioStreamOutputSupportResult,
  type AudioStreamProgress,
  type AudioStreamTarget,
  type AudioTranscoderStreamWorkerEngine,
  type WavContainerMode,
} from '@echovisionlab/audio-transcoder';
import {
  discardPendingOutputAfterFailure,
  OutputStore,
  type OutputArtifact,
  type PendingOutput,
} from './src/output-store';
import './styles.css';

type RowStatus =
  | 'cancelled'
  | 'complete'
  | 'converting'
  | 'error'
  | 'inspecting'
  | 'queued'
  | 'ready';

interface RowError {
  readonly code?: string;
  readonly message: string;
  readonly name?: string;
  readonly reason?: string;
  readonly stack?: string;
}

interface RowState {
  readonly error: RowError | undefined;
  readonly file: File;
  readonly id: string;
  readonly inputSupport: AudioStreamInputSupportResult['status'] | undefined;
  readonly inspection: AudioStreamInspection | undefined;
  readonly output: OutputArtifact | undefined;
  readonly phase: AudioStreamProgress['phase'] | undefined;
  readonly progress: number;
  readonly status: RowStatus;
}

interface RowView {
  readonly convert: HTMLButtonElement;
  readonly detail: HTMLElement;
  readonly fileName: HTMLElement;
  readonly fileSize: HTMLElement;
  readonly output: HTMLElement;
  readonly progressBar: HTMLProgressElement;
  readonly progressValue: HTMLElement;
  readonly remove: HTMLButtonElement;
  readonly root: HTMLElement;
  readonly sourceMain: HTMLElement;
  readonly sourceMeta: HTMLElement;
  readonly status: HTMLElement;
}

interface ConversionJob {
  readonly id: string;
  readonly previousOutput?: OutputArtifact;
  readonly preset: OutputPresetDescriptor['preset'];
  readonly target: AudioStreamTarget;
}

type OutputFormatDescriptor =
  (typeof AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats)[number];
type OutputFormatId = OutputFormatDescriptor['id'];
type OutputPresetDescriptor = OutputFormatDescriptor['presets'][number];
type OutputPreset = OutputPresetDescriptor['preset'];
type WavOutputPreset = Extract<
  OutputPreset,
  { readonly container: 'wav' }
>;

interface TargetOverrides {
  readonly channels?: number;
  readonly sampleRate?: number;
}

type OutputRuntimeStatus =
  | 'checking'
  | 'retryable-error'
  | 'runtime-unavailable'
  | 'supported'
  | 'unsupported';
type OutputRuntimeGroupStatus =
  | 'checking'
  | 'operational'
  | 'retryable-error'
  | 'unprobed';

type OutputControlScope =
  | 'channels'
  | 'format'
  | 'preset'
  | 'sample-rate'
  | 'target';

interface OutputRuntimeGroupState {
  readonly message: string;
  readonly status: OutputRuntimeGroupStatus;
}

interface OutputRuntimeState {
  readonly message: string;
  readonly scope?: OutputControlScope;
  readonly status: OutputRuntimeStatus;
}

interface ExactOutputRuntimeState extends OutputRuntimeState {
  readonly key: string;
}

interface OutputTargetValidationError {
  readonly message: string;
  readonly reason: 'channels' | 'sample-rate';
}

const DEMO_ACTIVE_CONVERSION_LIMIT = 1;
const DEMO_ACTIVE_INSPECTION_LIMIT = 1;
// One active job plus the public maximum waiting queue bounds retained Files.
const DEMO_FILE_ADMISSION_LIMIT =
  AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.queue.maximumQueued +
  DEMO_ACTIVE_CONVERSION_LIMIT;
const DEMO_MAX_WAITING_INSPECTIONS =
  DEMO_FILE_ADMISSION_LIMIT - DEMO_ACTIVE_INSPECTION_LIMIT;
const DEMO_MAX_WAITING_CONVERSIONS =
  AUDIO_TRANSCODER_STREAM_CAPABILITIES.limits.queue.maximumQueued;

const engineVersion = requiredElement<HTMLElement>('engine-version');
const storageMode = requiredElement<HTMLElement>('storage-mode');
const dropZone = requiredElement<HTMLElement>('drop-zone');
const fileInput = requiredElement<HTMLInputElement>('file-input');
const pickFiles = requiredElement<HTMLButtonElement>('pick-files');
const addTone = requiredElement<HTMLButtonElement>('add-tone');
const convertAll = requiredElement<HTMLButtonElement>('convert-all');
const cancelAll = requiredElement<HTMLButtonElement>('cancel-all');
const clearAll = requiredElement<HTMLButtonElement>('clear-all');
const presetSelect = requiredElement<HTMLSelectElement>('preset');
const sampleRateSelect = requiredElement<HTMLSelectElement>('sample-rate');
const channelsSelect = requiredElement<HTMLSelectElement>('channels');
const ditherSelect = requiredElement<HTMLSelectElement>('dither');
const containerSelect = requiredElement<HTMLSelectElement>('container');
const fileAdmissionStatus = requiredElement<HTMLElement>(
  'file-admission-status',
);
const outputRuntimeStatus = requiredElement<HTMLElement>(
  'output-runtime-status',
);
const outputRuntimeDetail = requiredElement<HTMLElement>(
  'output-runtime-detail',
);
const retryOutputCheck = requiredElement<HTMLButtonElement>(
  'retry-output-check',
);
const queueSummary = requiredElement<HTMLElement>('queue-summary');
const fileList = requiredElement<HTMLElement>('file-list');
const fileRowTemplate = requiredElement<HTMLTemplateElement>('file-row-template');

const outputStore = new OutputStore();
const rowViews = new Map<string, RowView>();
const queuedProgress = new Map<string, AudioStreamProgress>();
const presetLabels = new Map<string, string>();
const outputRuntimeGroups = new Map<OutputFormatId, OutputRuntimeGroupState>(
  AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats.map(({ id }) => [
    id,
    Object.freeze({
      message: `${id.toUpperCase()} output will be checked when selected.`,
      status: 'unprobed' as const,
    }),
  ]),
);
let startupOutputProbeController = new AbortController();

let rows: readonly RowState[] = Object.freeze([]);
let inspectionQueue: readonly string[] = Object.freeze([]);
let activeInspection:
  | { readonly controller: AbortController; readonly id: string }
  | undefined;
let inspectionPumping = false;
let conversionQueue: readonly ConversionJob[] = Object.freeze([]);
let activeConversion:
  | { readonly controller: AbortController; readonly id: string }
  | undefined;
let engine: AudioTranscoderStreamWorkerEngine | undefined;
let pumping = false;
let progressFrame: number | undefined;
let disposed = false;
let disposal: Promise<void> | undefined;
let exactOutputProbeController: AbortController | undefined;
let conversionValidationController: AbortController | undefined;
let exactOutputProbeGeneration = 0;
let validatingConversions = false;
let outputProbeTail: Promise<void> = Promise.resolve();
let exactOutputRuntime: ExactOutputRuntimeState = Object.freeze({
  key: '',
  message: 'Checking the selected output target.',
  status: 'checking',
});

engineVersion.textContent = AUDIO_TRANSCODER_VERSION;
configurePresetSelect();
configureSampleRateSelect();
syncTargetControls();
configureFileInput();
bindEvents();
fileList.replaceChildren();
renderAll();
void refreshStorageMode();
void probeOutputRuntimeGroups();
void refreshExactOutputRuntime();

function getEngine(): AudioTranscoderStreamWorkerEngine {
  if (engine === undefined) {
    engine = createAudioTranscoderStreamWorkerEngine({
      codecAssets: {
        source: createSelfHostedRuntimeAssetSource(
          new URL('.', document.baseURI).href,
        ),
      },
    });
  }
  return engine;
}

function configurePresetSelect(): void {
  const fragment = document.createDocumentFragment();
  for (const format of AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats) {
    for (const descriptor of format.presets) {
      const option = document.createElement('option');
      option.value = descriptor.preset.id;
      const label = formatPreset(descriptor);
      presetLabels.set(descriptor.preset.id, label);
      option.textContent = label;
      fragment.append(option);
    }
  }
  presetSelect.replaceChildren(fragment);

  const productionPreset = findOutputPresetDescriptor('wav-pcm24');
  if (productionPreset !== undefined) {
    presetSelect.value = productionPreset.preset.id;
  }
}

function configureSampleRateSelect(): void {
  const rates = new Set<number>();
  for (const format of AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats) {
    for (const descriptor of format.presets) {
      const constraint = descriptor.target.sampleRate;
      if (constraint.kind === 'discrete') {
        for (const value of constraint.values) rates.add(value);
      } else {
        rates.add(constraint.minimum);
        rates.add(constraint.maximum);
      }
    }
  }

  const fragment = document.createDocumentFragment();
  const preserve = document.createElement('option');
  preserve.value = 'preserve';
  preserve.textContent = 'Preserve';
  fragment.append(preserve);
  for (const rate of [...rates].sort((left, right) => left - right)) {
    const option = document.createElement('option');
    option.value = String(rate);
    option.textContent = `${formatNumber(rate / 1_000)} kHz`;
    fragment.append(option);
  }
  sampleRateSelect.replaceChildren(fragment);
}

function configureFileInput(): void {
  const hints = new Set(
    AUDIO_TRANSCODER_STREAM_CAPABILITIES.inputFormats.flatMap(
      ({ extensionHints, mimeTypeHints }) => [
        ...mimeTypeHints,
        ...extensionHints.map((extension) => `.${extension}`),
      ],
    ),
  );
  fileInput.multiple = true;
  fileInput.accept = [...hints].join(',');
}

function bindEvents(): void {
  presetSelect.addEventListener('change', handleTargetControlsChanged);
  sampleRateSelect.addEventListener('change', handleTargetControlsChanged);
  channelsSelect.addEventListener('change', handleTargetControlsChanged);
  pickFiles.addEventListener('click', openFilePicker);
  addTone.addEventListener('click', () => addFiles([createFloat32CafTone()]));
  retryOutputCheck.addEventListener('click', retrySelectedOutputCheck);
  convertAll.addEventListener('click', () => {
    void enqueueConversions(
      rows.filter(isRowConvertible).map(({ id }) => id),
    );
  });
  cancelAll.addEventListener('click', cancelConversions);
  clearAll.addEventListener('click', () => void clearRows());

  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files === null ? [] : [...fileInput.files]);
    fileInput.value = '';
  });

  dropZone.addEventListener('click', openFilePicker);
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFilePicker();
    }
  });
  dropZone.addEventListener('dragenter', handleDragEnter);
  dropZone.addEventListener('dragover', handleDragEnter);
  dropZone.addEventListener('dragleave', (event) => {
    if (!dropZone.contains(event.relatedTarget as Node | null)) {
      dropZone.classList.remove('is-dragging');
    }
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
    addFiles(event.dataTransfer === null ? [] : [...event.dataTransfer.files]);
  });

  window.addEventListener('pagehide', (event) => {
    abortOutputProbes();
    if (!event.persisted) {
      // Browsers do not await pagehide; startup reclamation covers interruption.
      void dispose().catch(() => undefined);
    }
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !disposed) {
      startupOutputProbeController = new AbortController();
      void probeOutputRuntimeGroups();
      void refreshExactOutputRuntime();
    }
  });
}

function openFilePicker(): void {
  if (rows.length >= DEMO_FILE_ADMISSION_LIMIT) {
    showAdmissionError(
      `The demo accepts up to ${DEMO_FILE_ADMISSION_LIMIT} files at once. Remove a file before adding another.`,
    );
    return;
  }
  fileInput.click();
}

function handleTargetControlsChanged(): void {
  conversionValidationController?.abort();
  clearOutputAvailabilityErrors();
  syncTargetControls();
  renderAll();
  void probeOutputRuntimeGroups();
  void refreshExactOutputRuntime();
}

function handleDragEnter(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer !== null) {
    event.dataTransfer.dropEffect = 'copy';
  }
  dropZone.classList.add('is-dragging');
}

function addFiles(files: readonly File[]): void {
  if (files.length === 0 || disposed) {
    return;
  }

  const capacity = Math.max(0, DEMO_FILE_ADMISSION_LIMIT - rows.length);
  const acceptedFiles = files.slice(0, capacity);
  const rejectedCount = files.length - acceptedFiles.length;
  if (rejectedCount > 0) {
    showAdmissionError(
      `${rejectedCount} ${rejectedCount === 1 ? 'file was' : 'files were'} not added. The demo limit is ${DEMO_FILE_ADMISSION_LIMIT} files.`,
    );
  } else {
    clearAdmissionError();
  }
  if (acceptedFiles.length === 0) {
    renderAll();
    return;
  }

  const additions = acceptedFiles.map<RowState>((file) =>
    freezeRow({
      error: undefined,
      file,
      id: crypto.randomUUID(),
      inputSupport: undefined,
      inspection: undefined,
      output: undefined,
      phase: undefined,
      progress: 0,
      status: 'inspecting',
    }),
  );
  rows = Object.freeze([...rows, ...additions]);
  for (const row of additions) {
    createRowView(row);
  }
  renderAll();
  enqueueInspections(additions.map(({ id }) => id));
}

function enqueueInspections(ids: readonly string[]): void {
  for (const id of ids) {
    if (
      activeInspection?.id === id ||
      inspectionQueue.some((queuedId) => queuedId === id)
    ) {
      continue;
    }
    if (inspectionQueue.length >= DEMO_MAX_WAITING_INSPECTIONS) {
      setRowOutputAvailabilityError(id, {
        code: 'QUEUE_CAPACITY_EXCEEDED',
        message: 'The demo inspection queue is full.',
      });
      continue;
    }
    inspectionQueue = Object.freeze([...inspectionQueue, id]);
    // Starting immediately reserves the first row as active before more IDs wait.
    void pumpInspections();
  }
}

async function pumpInspections(): Promise<void> {
  if (inspectionPumping || disposed) {
    return;
  }
  inspectionPumping = true;
  try {
    while (!disposed && inspectionQueue.length > 0) {
      const [id, ...remaining] = inspectionQueue;
      inspectionQueue = Object.freeze(remaining);
      if (id === undefined || findRow(id) === undefined) {
        continue;
      }

      const controller = new AbortController();
      activeInspection = { controller, id };
      try {
        await inspectRow(id, controller.signal);
      } finally {
        if (activeInspection?.id === id) {
          activeInspection = undefined;
        }
      }
    }
  } finally {
    inspectionPumping = false;
    if (!disposed && inspectionQueue.length > 0) {
      void pumpInspections();
    }
  }
}

async function inspectRow(id: string, signal: AbortSignal): Promise<void> {
  const row = findRow(id);
  if (row === undefined) {
    return;
  }

  replaceRow(id, (current) => ({
    ...current,
    error: undefined,
    inputSupport: undefined,
    status: 'inspecting',
  }));
  renderAll();

  try {
    const result = await getEngine().probeInputSupport(
      { blob: row.file, name: row.file.name },
      { signal },
    );
    if (findRow(id) !== undefined && result.status === 'supported') {
      replaceRow(id, (current) => ({
        ...current,
        error: undefined,
        inputSupport: result.status,
        inspection: result.inspection,
        status: 'ready',
      }));
    } else if (
      findRow(id) !== undefined &&
      result.status === 'recognized-unsupported'
    ) {
      replaceRow(id, (current) => ({
        ...current,
        error: {
          code: 'UNSUPPORTED_INPUT',
          message:
            'The file was recognized, but this browser cannot decode its audio codec.',
        },
        inputSupport: result.status,
        inspection: result.inspection,
        status: 'error',
      }));
    } else if (findRow(id) !== undefined) {
      replaceRow(id, (current) => ({
        ...current,
        error: {
          code: 'UNSUPPORTED_INPUT',
          message: 'No installed input adapter recognized this audio file.',
        },
        inputSupport: result.status,
        inspection: undefined,
        status: 'error',
      }));
    }
  } catch (error) {
    if (findRow(id) !== undefined && !isAbortError(error)) {
      replaceRow(id, (current) => ({
        ...current,
        error: describeError(error),
        inputSupport: undefined,
        inspection: undefined,
        status: 'error',
      }));
    }
  } finally {
    renderAll();
    void refreshExactOutputRuntime();
  }
}

async function enqueueConversions(ids: readonly string[]): Promise<void> {
  if (disposed || validatingConversions || !isSelectedOutputReady()) {
    return;
  }

  conversionValidationController?.abort();
  const controller = new AbortController();
  conversionValidationController = controller;
  validatingConversions = true;
  renderAll();

  try {
    const target = readTarget();
    const descriptor = findOutputPresetDescriptor(target.presetId);
    if (descriptor === undefined) {
      return;
    }

    const queuedIds = new Set(conversionQueue.map(({ id }) => id));
    const candidates = ids.flatMap((id) => {
      const row = findRow(id);
      return row === undefined ||
        !isRowConvertible(row) ||
        queuedIds.has(id) ||
        activeConversion?.id === id
        ? []
        : [row];
    });
    const availableJobSlots = Math.max(
      0,
      DEMO_MAX_WAITING_CONVERSIONS -
        conversionQueue.length +
        (activeConversion === undefined ? DEMO_ACTIVE_CONVERSION_LIMIT : 0),
    );
    const admittedCandidates = candidates.slice(0, availableJobSlots);
    const rejectedCandidates = candidates.length - admittedCandidates.length;
    if (rejectedCandidates > 0) {
      showAdmissionError(
        `${rejectedCandidates} ${rejectedCandidates === 1 ? 'conversion was' : 'conversions were'} not queued. The demo queue is full.`,
      );
    }
    const jobs: ConversionJob[] = [];

    for (const row of admittedCandidates) {
      throwIfAborted(controller.signal);
      const probeTarget = resolveRowOutputProbeTarget(
        descriptor,
        target,
        row,
      );
      const staticError = validateOutputProbeTarget(descriptor, probeTarget);
      if (staticError !== undefined) {
        setRowOutputAvailabilityError(row.id, {
          code: 'UNSUPPORTED_OUTPUT',
          message: staticError.message,
        });
        continue;
      }

      try {
        const result = await enqueueOutputProbe(
          probeTarget,
          controller.signal,
        );
        throwIfAborted(controller.signal);
        if (result.status !== 'supported') {
          setRowOutputAvailabilityError(row.id, {
            code: result.code,
            message: result.message,
          });
          continue;
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const described = describeError(error);
        setRowOutputAvailabilityError(row.id, {
          code: 'OUTPUT_PROBE_FAILED',
          message: `${described.code}: ${described.message}`,
        });
        continue;
      }

      const current = findRow(row.id);
      if (current === undefined || !isRowConvertible(current)) {
        continue;
      }
      queuedIds.add(current.id);
      jobs.push({
        id: current.id,
        ...(current.output === undefined
          ? {}
          : { previousOutput: current.output }),
        preset: descriptor.preset,
        target,
      });
    }

    if (
      controller.signal.aborted ||
      conversionValidationController !== controller ||
      jobs.length === 0
    ) {
      return;
    }

    for (const job of jobs) {
      replaceRow(job.id, (current) => ({
        ...current,
        error: undefined,
        output: undefined,
        phase: 'prepare',
        progress: 0,
        status: 'queued',
      }));
    }
    conversionQueue = Object.freeze([...conversionQueue, ...jobs]);
    void pumpConversions();
  } catch (error) {
    if (!isAbortError(error)) {
      console.error('Failed to validate the selected output target.', error);
    }
  } finally {
    if (conversionValidationController === controller) {
      conversionValidationController = undefined;
      validatingConversions = false;
    }
    renderAll();
  }
}

async function pumpConversions(): Promise<void> {
  if (pumping || disposed) {
    return;
  }
  pumping = true;
  try {
    while (!disposed && conversionQueue.length > 0) {
      const [job, ...remaining] = conversionQueue;
      conversionQueue = Object.freeze(remaining);
      if (job !== undefined && findRow(job.id) !== undefined) {
        await convertRow(job);
      } else {
        await job?.previousOutput?.cleanup();
      }
    }
  } finally {
    pumping = false;
    renderAll();
    if (!disposed && conversionQueue.length > 0) {
      void pumpConversions();
    }
  }
}

async function convertRow(job: ConversionJob): Promise<void> {
  const row = findRow(job.id);
  if (row === undefined) {
    await job.previousOutput?.cleanup();
    return;
  }

  await job.previousOutput?.cleanup();
  const controller = new AbortController();
  activeConversion = { controller, id: job.id };
  replaceRow(job.id, (current) => ({
    ...current,
    phase: 'prepare',
    progress: 0,
    status: 'converting',
  }));
  renderAll();

  let pendingOutput: PendingOutput | undefined;
  try {
    pendingOutput = await outputStore.create();
    await refreshStorageMode();
    await getEngine().transcode(
      { blob: row.file, name: row.file.name },
      job.target,
      pendingOutput.stream,
      {
        ...(pendingOutput.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: pendingOutput.maxOutputBytes }),
        onProgress: (progress) => scheduleProgress(job.id, progress),
        signal: controller.signal,
      },
    );
    const artifact = await pendingOutput.complete(
      outputName(row.file.name, job.preset.extension),
      job.preset.mimeType,
    );
    if (findRow(job.id) === undefined) {
      await artifact.cleanup();
    } else {
      replaceRow(job.id, (current) => ({
        ...current,
        error: undefined,
        output: artifact,
        phase: 'finalize',
        progress: 1,
        status: 'complete',
      }));
    }
  } catch (error) {
    await discardPendingOutputAfterFailure(pendingOutput, error);
    if (findRow(job.id) !== undefined) {
      replaceRow(job.id, (current) => ({
        ...current,
        error: isAbortError(error) ? undefined : describeError(error),
        phase: undefined,
        status: isAbortError(error) ? 'cancelled' : 'error',
      }));
    }
  } finally {
    queuedProgress.delete(job.id);
    if (activeConversion?.id === job.id) {
      activeConversion = undefined;
    }
    renderAll();
  }
}

function cancelConversions(): void {
  const pending = conversionQueue;
  conversionQueue = Object.freeze([]);
  conversionValidationController?.abort();
  activeConversion?.controller.abort();
  for (const job of pending) {
    void job.previousOutput?.cleanup();
    if (findRow(job.id) !== undefined) {
      replaceRow(job.id, (current) => ({
        ...current,
        phase: undefined,
        progress: 0,
        status: 'cancelled',
      }));
    }
  }
  renderAll();
}

async function removeRow(id: string): Promise<void> {
  conversionValidationController?.abort();
  inspectionQueue = Object.freeze(
    inspectionQueue.filter((queuedId) => queuedId !== id),
  );
  if (activeInspection?.id === id) {
    activeInspection.controller.abort();
  }
  if (activeConversion?.id === id) {
    activeConversion.controller.abort();
  }

  const queued = conversionQueue.filter((job) => job.id === id);
  conversionQueue = Object.freeze(
    conversionQueue.filter((job) => job.id !== id),
  );
  const row = findRow(id);
  rows = Object.freeze(rows.filter((candidate) => candidate.id !== id));
  rowViews.get(id)?.root.remove();
  rowViews.delete(id);
  queuedProgress.delete(id);
  clearAdmissionError();
  renderAll();
  void refreshExactOutputRuntime();

  await Promise.all([
    row?.output?.cleanup(),
    ...queued.map(({ previousOutput }) => previousOutput?.cleanup()),
  ]);
}

async function clearRows(): Promise<void> {
  const currentRows = rows;
  const queued = conversionQueue;
  conversionValidationController?.abort();
  cancelConversions();
  inspectionQueue = Object.freeze([]);
  activeInspection?.controller.abort();
  rows = Object.freeze([]);
  rowViews.clear();
  fileList.replaceChildren();
  queuedProgress.clear();
  clearAdmissionError();
  renderAll();
  void refreshExactOutputRuntime();

  await Promise.all([
    ...currentRows.map(({ output }) => output?.cleanup()),
    ...queued.map(({ previousOutput }) => previousOutput?.cleanup()),
  ]);
}

function scheduleProgress(id: string, progress: AudioStreamProgress): void {
  if (disposed || findRow(id) === undefined) {
    return;
  }
  queuedProgress.set(id, progress);
  if (progressFrame !== undefined) {
    return;
  }
  progressFrame = requestAnimationFrame(() => {
    progressFrame = undefined;
    for (const [rowId, latest] of queuedProgress) {
      if (findRow(rowId) !== undefined) {
        replaceRow(rowId, (row) => ({
          ...row,
          phase: latest.phase,
          progress: latest.progress,
        }));
      }
    }
    queuedProgress.clear();
    renderAll();
  });
}

function createRowView(row: RowState): void {
  const root = fileRowTemplate.content.firstElementChild?.cloneNode(true);
  if (!(root instanceof HTMLElement)) {
    throw new Error('The file row template must contain one HTML element.');
  }
  const view: RowView = {
    convert: requiredDescendant<HTMLButtonElement>(root, '.convert-one'),
    detail: requiredDescendant(root, '.status-detail'),
    fileName: requiredDescendant(root, '.file-name'),
    fileSize: requiredDescendant(root, '.file-size'),
    output: requiredDescendant(root, '.output-slot'),
    progressBar: requiredDescendant<HTMLProgressElement>(root, '.progress-bar'),
    progressValue: requiredDescendant(root, '.progress-value'),
    remove: requiredDescendant<HTMLButtonElement>(root, '.remove-one'),
    root,
    sourceMain: requiredDescendant(root, '.source-main'),
    sourceMeta: requiredDescendant(root, '.source-meta'),
    status: requiredDescendant(root, '.status-text'),
  };
  view.convert.addEventListener('click', () => {
    void enqueueConversions([row.id]);
  });
  view.remove.addEventListener('click', () => void removeRow(row.id));
  rowViews.set(row.id, view);
  fileList.append(root);
}

function renderAll(): void {
  for (const row of rows) {
    renderRow(row);
  }

  const ready = rows.filter(isRowConvertible).length;
  const complete = rows.filter(({ status }) => status === 'complete').length;
  const failed = rows.filter(({ status }) => status === 'error').length;
  const parts = [
    `${rows.length}/${DEMO_FILE_ADMISSION_LIMIT} files`,
    ...(activeConversion === undefined ? [] : ['1 active']),
    ...(conversionQueue.length === 0
      ? []
      : [`${conversionQueue.length} queued`]),
    ...(complete === 0 ? [] : [`${complete} complete`]),
    ...(failed === 0 ? [] : [`${failed} failed`]),
  ];
  queueSummary.textContent = parts.join(' / ');
  fileList.toggleAttribute('hidden', rows.length === 0);
  const admissionFull = rows.length >= DEMO_FILE_ADMISSION_LIMIT;
  fileInput.disabled = admissionFull;
  pickFiles.disabled = admissionFull;
  addTone.disabled = admissionFull;
  dropZone.setAttribute('aria-disabled', String(admissionFull));
  convertAll.disabled =
    ready === 0 || validatingConversions || !isSelectedOutputReady();
  cancelAll.disabled =
    !validatingConversions &&
    activeConversion === undefined &&
    conversionQueue.length === 0;
  clearAll.disabled = rows.length === 0;
  renderOutputRuntimeStatus();
}

function renderRow(row: RowState): void {
  const view = rowViews.get(row.id);
  if (view === undefined) {
    return;
  }

  view.root.dataset.status = row.status;
  view.fileName.textContent = row.file.name;
  view.fileName.title = row.file.name;
  view.fileSize.textContent = formatBytes(row.file.size);

  if (row.inspection === undefined) {
    view.sourceMain.textContent =
      row.status === 'error' ? 'Inspection failed' : 'Reading metadata';
    view.sourceMeta.textContent = row.error?.code ?? 'Local header inspection';
  } else {
    view.sourceMain.textContent = `${row.inspection.container} / ${row.inspection.codec}`;
    view.sourceMeta.textContent = formatInspection(row.inspection);
  }

  const presentation = statusPresentation(row);
  view.status.textContent = presentation.label;
  view.detail.textContent = presentation.detail;
  view.progressBar.toggleAttribute(
    'hidden',
    row.status !== 'converting' && row.status !== 'queued',
  );
  view.progressBar.setAttribute('aria-valuemin', '0');
  view.progressBar.setAttribute('aria-valuemax', '100');
  view.progressBar.setAttribute(
    'aria-valuenow',
    String(Math.round(row.progress * 100)),
  );
  view.progressBar.value = row.progress;
  view.progressValue.textContent = `${Math.round(row.progress * 1_000) / 10}%`;

  view.convert.disabled =
    !isRowConvertible(row) ||
    validatingConversions ||
    !isSelectedOutputReady();
  view.convert.textContent =
    row.status === 'complete' || row.status === 'cancelled'
      ? 'Reconvert'
      : 'Convert';
  view.remove.disabled = row.status === 'converting';

  view.output.replaceChildren();
  if (row.output !== undefined) {
    const link = document.createElement('a');
    link.href = row.output.url;
    link.download = row.output.downloadName;
    link.textContent = `Download ${formatBytes(row.output.size)}`;
    view.output.append(link);
  }
}

function statusPresentation(row: RowState): {
  readonly detail: string;
  readonly label: string;
} {
  switch (row.status) {
    case 'inspecting':
      return { detail: 'Reading local headers', label: 'Inspecting' };
    case 'ready':
      return { detail: 'Ready for conversion', label: 'Ready' };
    case 'queued':
      return { detail: 'Waiting for the active file', label: 'Queued' };
    case 'converting': {
      const percent = Math.round(row.progress * 1_000) / 10;
      return {
        detail: `${formatPhase(row.phase)} / ${percent.toFixed(1)}%`,
        label: 'Converting',
      };
    }
    case 'complete':
      return {
        detail:
          row.output === undefined
            ? 'Output complete'
            : `${formatBytes(row.output.size)} / ${formatStorage(row.output.storage)}`,
        label: 'Complete',
      };
    case 'cancelled':
      return { detail: 'No partial output was kept', label: 'Cancelled' };
    case 'error':
      return {
        detail:
          row.error === undefined
            ? 'Conversion failed'
            : formatRowError(row.error),
        label: 'Error',
      };
  }
}

function readTarget(): AudioStreamTarget {
  const descriptor = findOutputPresetDescriptor(presetSelect.value);
  if (descriptor === undefined) {
    throw new Error('Select a supported output preset.');
  }

  const overrides = readTargetOverrides();
  const preset = descriptor.preset;
  if (isWavOutputPreset(preset)) {
    const wavContainer = readWavContainer();
    return preset.id === 'wav-float32'
      ? Object.freeze({
          ...overrides,
          dither: readNonIntegerDither(),
          presetId: preset.id,
          wavContainer,
        })
      : Object.freeze({
          ...overrides,
          dither: readIntegerDither(),
          presetId: preset.id,
          wavContainer,
        });
  }

  return preset.sampleFormat === 'integer'
    ? Object.freeze({
        ...overrides,
        dither: readIntegerDither(),
        presetId: preset.id,
      })
    : Object.freeze({
        ...overrides,
        dither: readNonIntegerDither(),
        presetId: preset.id,
      });
}

function isWavOutputPreset(preset: OutputPreset): preset is WavOutputPreset {
  return preset.container === 'wav';
}

function readTargetOverrides(): TargetOverrides {
  const sampleRate = optionalNumber(sampleRateSelect.value);
  const channels = optionalNumber(channelsSelect.value);
  return Object.freeze({
    ...(channels === undefined ? {} : { channels }),
    ...(sampleRate === undefined ? {} : { sampleRate }),
  });
}

function readIntegerDither(): AudioDitherMode {
  switch (ditherSelect.value) {
    case 'auto':
    case 'none':
    case 'tpdf':
      return ditherSelect.value;
    default:
      throw new Error('Select a supported dither mode.');
  }
}

function readNonIntegerDither(): Exclude<AudioDitherMode, 'tpdf'> {
  const dither = readIntegerDither();
  if (dither === 'tpdf') {
    throw new Error('TPDF dither requires an integer output preset.');
  }
  return dither;
}

function readWavContainer(): WavContainerMode {
  switch (containerSelect.value) {
    case 'auto':
    case 'rf64':
    case 'riff':
      return containerSelect.value;
    default:
      throw new Error('Select a supported WAV container mode.');
  }
}

function syncTargetControls(): void {
  syncPresetOptions();
  const descriptor = findOutputPresetDescriptor(presetSelect.value);
  if (descriptor === undefined) {
    containerSelect.disabled = true;
    return;
  }

  const isWav = descriptor.preset.container === 'wav';
  containerSelect.disabled = !isWav;
  if (!isWav) {
    containerSelect.value = 'auto';
  }

  const tpdfOption = [...ditherSelect.options].find(
    ({ value }) => value === 'tpdf',
  );
  const acceptsTpdf = descriptor.preset.sampleFormat === 'integer';
  if (tpdfOption !== undefined) {
    tpdfOption.disabled = !acceptsTpdf;
  }
  if (!acceptsTpdf && ditherSelect.value === 'tpdf') {
    ditherSelect.value = 'auto';
  }

  syncNumericOptions(sampleRateSelect, (sampleRate) => {
    const constraint = descriptor.target.sampleRate;
    return constraint.kind === 'range'
      ? sampleRate >= constraint.minimum && sampleRate <= constraint.maximum
      : constraint.values.some((candidate) => candidate === sampleRate);
  });
  syncNumericOptions(
    channelsSelect,
    (channels) =>
      channels >= descriptor.target.channels.minimum &&
      channels <= descriptor.target.channels.maximum,
  );
}

function syncPresetOptions(): void {
  for (const option of presetSelect.options) {
    const descriptor = findOutputPresetDescriptor(option.value);
    const format =
      descriptor === undefined
        ? undefined
        : findOutputFormatDescriptor(descriptor.preset.id);
    const runtime =
      format === undefined ? undefined : outputRuntimeGroups.get(format.id);
    const label = presetLabels.get(option.value) ?? option.value;

    if (runtime === undefined) {
      option.disabled = runtime === undefined;
      option.textContent = label;
    } else if (runtime.status === 'checking') {
      option.disabled = true;
      option.textContent = `${label} (checking)`;
    } else if (runtime.status === 'unprobed') {
      option.disabled = false;
      option.textContent = label;
    } else {
      option.disabled = false;
      option.textContent = label;
    }
    option.title = runtime?.message ?? 'Output preset is not installed.';
  }
}

function syncNumericOptions(
  select: HTMLSelectElement,
  accepts: (value: number) => boolean,
): void {
  for (const option of select.options) {
    if (option.value === 'preserve') {
      option.disabled = false;
      continue;
    }
    const value = Number(option.value);
    option.disabled = !Number.isFinite(value) || !accepts(value);
  }
  if (select.selectedOptions[0]?.disabled === true) {
    select.value = 'preserve';
  }
}

async function probeOutputRuntimeGroups(): Promise<void> {
  const controller = startupOutputProbeController;
  const selectedFormat = findOutputFormatDescriptor(presetSelect.value);
  if (
    selectedFormat === undefined ||
    disposed ||
    controller.signal.aborted ||
    outputRuntimeGroups.get(selectedFormat.id)?.status !== 'unprobed'
  ) {
    return;
  }

  await probeOutputRuntimeGroup(selectedFormat, controller);
  if (disposed || controller.signal.aborted) {
    return;
  }

  syncTargetControls();
  renderAll();
  await refreshExactOutputRuntime();
}

async function probeOutputRuntimeGroup(
  format: OutputFormatDescriptor,
  controller: AbortController,
): Promise<void> {
  const selectedDescriptor = format.presets.find(
    ({ preset }) => preset.id === presetSelect.value,
  );
  const descriptor = selectedDescriptor ?? format.presets[0];
  if (descriptor === undefined) {
    setOutputRuntimeGroup(format.id, {
      message: `No ${format.id.toUpperCase()} output preset is installed.`,
      status: 'retryable-error',
    });
    return;
  }

  setOutputRuntimeGroup(format.id, {
    message: `Checking the ${format.id.toUpperCase()} output runtime.`,
    status: 'checking',
  });
  try {
    const target = representativeOutputProbeTarget(descriptor);
    const result = await enqueueOutputProbe(target, controller.signal);
    throwIfAborted(controller.signal);
    setOutputRuntimeGroup(format.id, {
      message: `${format.id.toUpperCase()} exact output checks are operational.`,
      status: 'operational',
    });
    applyStartupExactOutputResult(format, target, result);
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) {
      return;
    }
    const described = describeError(error);
    setOutputRuntimeGroup(format.id, {
      message: `${described.code}: ${described.message}`,
      status: 'retryable-error',
    });
  }
}

function applyStartupExactOutputResult(
  format: OutputFormatDescriptor,
  target: AudioStreamOutputProbeTarget,
  result: AudioStreamOutputSupportResult,
): void {
  const selectedFormat = findOutputFormatDescriptor(presetSelect.value);
  const descriptor = findOutputPresetDescriptor(presetSelect.value);
  if (
    selectedFormat?.id !== format.id ||
    descriptor === undefined ||
    outputProbeTargetKey(resolveSelectedOutputProbeTarget(descriptor)) !==
      outputProbeTargetKey(target)
  ) {
    return;
  }
  setExactOutputRuntime(exactOutputRuntimeState(format, target, result));
}

function setOutputRuntimeGroup(
  formatId: OutputFormatId,
  state: OutputRuntimeGroupState,
): void {
  outputRuntimeGroups.set(formatId, Object.freeze(state));
  syncPresetOptions();
}

async function refreshExactOutputRuntime(force = false): Promise<void> {
  if (disposed) {
    return;
  }

  const descriptor = findOutputPresetDescriptor(presetSelect.value);
  const format = findOutputFormatDescriptor(presetSelect.value);
  if (descriptor === undefined || format === undefined) {
    setExactOutputRuntime({
      key: '',
      message: 'Select an installed output preset.',
      status: 'retryable-error',
    });
    return;
  }

  const target = resolveSelectedOutputProbeTarget(descriptor);
  const key = outputProbeTargetKey(target);
  const runtimeGroup = outputRuntimeGroups.get(format.id);
  if (runtimeGroup === undefined || runtimeGroup.status !== 'operational') {
    exactOutputProbeController?.abort();
    exactOutputProbeController = undefined;
    exactOutputProbeGeneration += 1;
    setExactOutputRuntime({
      key,
      message:
        runtimeGroup?.message ??
        `${format.id.toUpperCase()} output is not installed.`,
      status:
        runtimeGroup?.status === 'checking'
          ? 'checking'
          : 'retryable-error',
    });
    return;
  }

  const staticError = validateOutputProbeTarget(descriptor, target);
  if (staticError !== undefined) {
    exactOutputProbeController?.abort();
    exactOutputProbeController = undefined;
    exactOutputProbeGeneration += 1;
    setExactOutputRuntime({
      key,
      message: staticError.message,
      scope: staticError.reason,
      status: 'unsupported',
    });
    return;
  }

  if (
    !force &&
    exactOutputRuntime.key === key &&
    (exactOutputRuntime.status !== 'checking' ||
      exactOutputProbeController !== undefined)
  ) {
    return;
  }

  exactOutputProbeController?.abort();
  const controller = new AbortController();
  exactOutputProbeController = controller;
  const generation = ++exactOutputProbeGeneration;
  setExactOutputRuntime({
    key,
    message: `Checking ${format.id.toUpperCase()} at ${formatNumber(target.sampleRate)} Hz / ${target.channels} ch.`,
    status: 'checking',
  });

  try {
    const result = await enqueueOutputProbe(target, controller.signal);
    if (
      disposed ||
      controller.signal.aborted ||
      exactOutputProbeController !== controller ||
      exactOutputProbeGeneration !== generation
    ) {
      return;
    }
    setExactOutputRuntime(exactOutputRuntimeState(format, target, result));
  } catch (error) {
    if (
      isAbortError(error) ||
      exactOutputProbeController !== controller ||
      exactOutputProbeGeneration !== generation
    ) {
      return;
    }
    const described = describeError(error);
    setExactOutputRuntime({
      key,
      message: `${described.code}: ${described.message}`,
      status: 'retryable-error',
    });
  } finally {
    if (exactOutputProbeController === controller) {
      exactOutputProbeController = undefined;
    }
    renderAll();
  }
}

function exactOutputRuntimeState(
  format: OutputFormatDescriptor,
  target: AudioStreamOutputProbeTarget,
  result: AudioStreamOutputSupportResult,
): ExactOutputRuntimeState {
  const key = outputProbeTargetKey(target);
  if (result.status === 'supported') {
    return Object.freeze({
      key,
      message: `${format.id.toUpperCase()} at ${formatNumber(target.sampleRate)} Hz / ${target.channels} ch is ready.`,
      status: 'supported',
    });
  }
  if (result.status === 'unsupported-configuration') {
    return Object.freeze({
      key,
      message: result.message,
      scope: result.reason,
      status: 'unsupported',
    });
  }
  return Object.freeze({
    key,
    message: result.message,
    scope: 'target',
    status: 'runtime-unavailable',
  });
}

function setExactOutputRuntime(state: ExactOutputRuntimeState): void {
  exactOutputRuntime = Object.freeze(state);
  renderAll();
}

function enqueueOutputProbe(
  target: AudioStreamOutputProbeTarget,
  signal: AbortSignal,
): Promise<AudioStreamOutputSupportResult> {
  const operation = outputProbeTail.then(async () => {
    throwIfAborted(signal);
    return getEngine().probeOutputSupport(target, { signal });
  });
  outputProbeTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function resolveSelectedOutputProbeTarget(
  descriptor: OutputPresetDescriptor,
): AudioStreamOutputProbeTarget {
  const overrides = readTargetOverrides();
  for (const row of rows) {
    if (row.inputSupport !== 'supported' || row.inspection === undefined) {
      continue;
    }
    const candidate = resolveOutputProbeTarget(
      descriptor,
      overrides.channels ?? row.inspection.channels,
      overrides.sampleRate ?? row.inspection.sampleRate,
    );
    if (validateOutputProbeTarget(descriptor, candidate) === undefined) {
      return candidate;
    }
  }

  const representative = representativeOutputProbeTarget(descriptor);
  return Object.freeze({
    channels: overrides.channels ?? representative.channels,
    presetId: descriptor.preset.id,
    sampleRate: overrides.sampleRate ?? representative.sampleRate,
  });
}

function resolveRowOutputProbeTarget(
  descriptor: OutputPresetDescriptor,
  target: AudioStreamTarget,
  row: RowState,
): AudioStreamOutputProbeTarget {
  const representative = representativeOutputProbeTarget(descriptor);
  return resolveOutputProbeTarget(
    descriptor,
    target.channels ?? row.inspection?.channels ?? representative.channels,
    target.sampleRate ??
      row.inspection?.sampleRate ??
      representative.sampleRate,
  );
}

function resolveOutputProbeTarget(
  descriptor: OutputPresetDescriptor,
  channels: number | null,
  sampleRate: number | null,
): AudioStreamOutputProbeTarget {
  const representative = representativeOutputProbeTarget(descriptor);
  return Object.freeze({
    channels: channels ?? representative.channels,
    presetId: descriptor.preset.id,
    sampleRate: sampleRate ?? representative.sampleRate,
  });
}

function representativeOutputProbeTarget(
  descriptor: OutputPresetDescriptor,
): AudioStreamOutputProbeTarget {
  const channels =
    descriptor.target.channels.minimum <= 2 &&
    descriptor.target.channels.maximum >= 2
      ? 2
      : descriptor.target.channels.minimum;
  const constraint = descriptor.target.sampleRate;
  const sampleRate =
    constraint.kind === 'range'
      ? Math.min(constraint.maximum, Math.max(constraint.minimum, 48_000))
      : constraint.values.find((value) => value === 48_000) ??
        constraint.values[0] ??
        48_000;
  return Object.freeze({
    channels,
    presetId: descriptor.preset.id,
    sampleRate,
  });
}

function validateOutputProbeTarget(
  descriptor: OutputPresetDescriptor,
  target: AudioStreamOutputProbeTarget,
): OutputTargetValidationError | undefined {
  if (
    !Number.isInteger(target.channels) ||
    target.channels < descriptor.target.channels.minimum ||
    target.channels > descriptor.target.channels.maximum
  ) {
    return Object.freeze({
      message: `${target.channels} channels is unavailable for ${formatPreset(descriptor)}.`,
      reason: 'channels' as const,
    });
  }

  const constraint = descriptor.target.sampleRate;
  const supportsSampleRate =
    Number.isInteger(target.sampleRate) &&
    (constraint.kind === 'range'
      ? target.sampleRate >= constraint.minimum &&
        target.sampleRate <= constraint.maximum
      : constraint.values.some((value) => value === target.sampleRate));
  return supportsSampleRate
    ? undefined
    : Object.freeze({
        message: `${formatNumber(target.sampleRate)} Hz is unavailable for ${formatPreset(descriptor)}.`,
        reason: 'sample-rate' as const,
      });
}

function outputProbeTargetKey(target: AudioStreamOutputProbeTarget): string {
  return `${target.presetId}:${target.channels}:${target.sampleRate}`;
}

function isSelectedOutputReady(): boolean {
  return selectedOutputRuntimeState().status === 'supported';
}

function renderOutputRuntimeStatus(): void {
  const status = outputRuntimeDisplayState();
  outputRuntimeStatus.dataset.state = outputRuntimeVisualState(status.status);
  outputRuntimeStatus.textContent = outputRuntimeLabel(status.status);
  outputRuntimeStatus.title = status.message;
  outputRuntimeDetail.textContent = status.message;
  retryOutputCheck.hidden =
    status.status !== 'retryable-error' &&
    status.status !== 'runtime-unavailable';
  retryOutputCheck.disabled = validatingConversions || disposed;
  syncOutputControlAvailability(status);
}

function selectedOutputRuntimeState(): OutputRuntimeState {
  const descriptor = findOutputPresetDescriptor(presetSelect.value);
  const format = findOutputFormatDescriptor(presetSelect.value);
  if (descriptor === undefined || format === undefined) {
    return Object.freeze({
      message: 'Select an installed output preset.',
      status: 'retryable-error',
    });
  }

  const group = outputRuntimeGroups.get(format.id);
  if (group === undefined || group.status !== 'operational') {
    return Object.freeze({
      message:
        group?.message ?? `${format.id.toUpperCase()} output is not installed.`,
      status: group?.status === 'checking' ? 'checking' : 'retryable-error',
    });
  }

  const key = outputProbeTargetKey(resolveSelectedOutputProbeTarget(descriptor));
  return exactOutputRuntime.key === key
    ? exactOutputRuntime
    : Object.freeze({
        message: 'Checking the selected output target.',
        status: 'checking' as const,
      });
}

function outputRuntimeDisplayState(): OutputRuntimeState {
  if (validatingConversions) {
    return Object.freeze({
      message: 'Checking output targets for the selected files.',
      status: 'checking' as const,
    });
  }

  const selected = selectedOutputRuntimeState();
  if (selected.status !== 'supported') {
    return selected;
  }

  const rowError = rows.find(
    ({ error }) =>
      error?.code === 'OUTPUT_PROBE_FAILED' ||
      error?.code === 'OUTPUT_RUNTIME_UNAVAILABLE',
  )?.error;
  if (rowError === undefined) {
    return selected;
  }
  return Object.freeze({
    message: rowError.message,
    status:
      rowError.code === 'OUTPUT_RUNTIME_UNAVAILABLE'
        ? ('runtime-unavailable' as const)
        : ('retryable-error' as const),
  });
}

function outputRuntimeVisualState(
  status: OutputRuntimeStatus,
): 'checking' | 'error' | 'ready' | 'unavailable' {
  if (status === 'supported') {
    return 'ready';
  }
  if (status === 'retryable-error') {
    return 'error';
  }
  return status === 'checking' ? 'checking' : 'unavailable';
}

function outputRuntimeLabel(status: OutputRuntimeStatus): string {
  switch (status) {
    case 'checking':
      return 'Checking output codecs';
    case 'supported':
      return 'Output ready';
    case 'unsupported':
      return 'Output unsupported';
    case 'runtime-unavailable':
      return 'Output unavailable';
    case 'retryable-error':
      return 'Output check failed';
  }
}

function syncOutputControlAvailability(
  status: OutputRuntimeState,
): void {
  const controls = [presetSelect, sampleRateSelect, channelsSelect];
  for (const control of controls) {
    delete control.dataset.outputState;
    control.removeAttribute('aria-invalid');
    control.removeAttribute('aria-describedby');
  }
  if (
    (status.status !== 'unsupported' &&
      status.status !== 'runtime-unavailable') ||
    status.scope === undefined
  ) {
    return;
  }

  const affected =
    status.scope === 'channels'
      ? [channelsSelect]
      : status.scope === 'sample-rate'
        ? [sampleRateSelect]
        : status.scope === 'target'
          ? controls
          : [presetSelect];
  for (const control of affected) {
    control.dataset.outputState = 'unavailable';
    control.setAttribute('aria-describedby', outputRuntimeDetail.id);
    if (status.status === 'unsupported') {
      control.setAttribute('aria-invalid', 'true');
    }
  }
}

function retrySelectedOutputCheck(): void {
  if (disposed) {
    return;
  }
  clearOutputAvailabilityErrors();

  const descriptor = findOutputPresetDescriptor(presetSelect.value);
  const format = findOutputFormatDescriptor(presetSelect.value);
  const group = format === undefined ? undefined : outputRuntimeGroups.get(format.id);
  if (
    descriptor !== undefined &&
    format !== undefined &&
    group?.status === 'retryable-error'
  ) {
    startupOutputProbeController.abort();
    exactOutputProbeController?.abort();
    exactOutputProbeController = undefined;
    exactOutputProbeGeneration += 1;
    startupOutputProbeController = new AbortController();
    setOutputRuntimeGroup(format.id, {
      message: `Checking the ${format.id.toUpperCase()} output runtime.`,
      status: 'unprobed',
    });
    const target = resolveSelectedOutputProbeTarget(descriptor);
    setExactOutputRuntime({
      key: outputProbeTargetKey(target),
      message: `Checking ${format.id.toUpperCase()} output again.`,
      status: 'checking',
    });
    syncTargetControls();
    renderAll();
    void probeOutputRuntimeGroups();
    return;
  }

  renderAll();
  void refreshExactOutputRuntime(true);
}

function setRowOutputAvailabilityError(id: string, error: RowError): void {
  if (findRow(id) === undefined) {
    return;
  }
  replaceRow(id, (row) => ({
    ...row,
    error,
    phase: undefined,
    status: 'error',
  }));
}

function clearOutputAvailabilityErrors(): void {
  rows = Object.freeze(
    rows.map((row) =>
      row.error?.code === 'UNSUPPORTED_OUTPUT' ||
      row.error?.code === 'OUTPUT_RUNTIME_UNAVAILABLE' ||
      row.error?.code === 'OUTPUT_PROBE_FAILED'
        ? freezeRow({
            ...row,
            error: undefined,
            status: row.output === undefined ? 'ready' : 'complete',
          })
        : row,
    ),
  );
}

function showAdmissionError(message: string): void {
  fileAdmissionStatus.textContent = message;
  fileAdmissionStatus.hidden = false;
}

function clearAdmissionError(): void {
  fileAdmissionStatus.textContent = '';
  fileAdmissionStatus.hidden = true;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }
}

function findOutputPresetDescriptor(
  presetId: string,
): OutputPresetDescriptor | undefined {
  for (const format of AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats) {
    for (const descriptor of format.presets) {
      if (descriptor.preset.id === presetId) {
        return descriptor;
      }
    }
  }
  return undefined;
}

function findOutputFormatDescriptor(
  presetId: string,
): OutputFormatDescriptor | undefined {
  return AUDIO_TRANSCODER_STREAM_CAPABILITIES.outputFormats.find(({ presets }) =>
    presets.some(({ preset }) => preset.id === presetId),
  );
}

async function refreshStorageMode(): Promise<void> {
  const mode = await outputStore.getMode();
  storageMode.textContent =
    mode === 'opfs'
      ? 'OPFS temporary files'
      : 'Memory fallback / 128 MiB session budget';
}

function replaceRow(
  id: string,
  update: (row: RowState) => Omit<RowState, never>,
): void {
  rows = Object.freeze(
    rows.map((row) => (row.id === id ? freezeRow(update(row)) : row)),
  );
}

function findRow(id: string): RowState | undefined {
  return rows.find((row) => row.id === id);
}

function isRowConvertible(row: RowState): boolean {
  return (
    row.inputSupport === 'supported' &&
    row.inspection !== undefined &&
    row.error === undefined &&
    (row.status === 'ready' ||
      row.status === 'cancelled' ||
      row.status === 'complete')
  );
}

function freezeRow(row: RowState): RowState {
  return Object.freeze(row);
}

function abortOutputProbes(): void {
  startupOutputProbeController.abort();
  exactOutputProbeController?.abort();
  exactOutputProbeController = undefined;
  exactOutputProbeGeneration += 1;
  conversionValidationController?.abort();
}

function dispose(): Promise<void> {
  if (disposal !== undefined) {
    return disposal;
  }
  disposed = true;
  abortOutputProbes();
  activeConversion?.controller.abort();
  inspectionQueue = Object.freeze([]);
  activeInspection?.controller.abort();
  if (progressFrame !== undefined) {
    cancelAnimationFrame(progressFrame);
    progressFrame = undefined;
  }
  const queuedOutputs = conversionQueue.flatMap(({ previousOutput }) =>
    previousOutput === undefined ? [] : [previousOutput],
  );
  conversionQueue = Object.freeze([]);
  disposal = (async () => {
    const failures: unknown[] = [];
    if (engine !== undefined) {
      try {
        // Worker disposal waits for output writer locks before OPFS removal starts.
        await engine.dispose();
      } catch (error) {
        failures.push(error);
      }
    }

    const outputs = [
      ...rows.flatMap(({ output }) => (output === undefined ? [] : [output])),
      ...queuedOutputs,
    ];
    const cleanups = outputs.map((output) => output.cleanup());
    const settlements = await Promise.allSettled(cleanups);
    failures.push(
      ...settlements.flatMap((settlement) =>
        settlement.status === 'rejected' ? [settlement.reason] : [],
      ),
    );
    try {
      await outputStore.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Failed to dispose the demo.');
    }
  })();
  return disposal;
}

function createFloat32CafTone(): File {
  const sampleRate = 48_000;
  const channels = 2;
  const durationSeconds = 2;
  const frames = sampleRate * durationSeconds;
  const bytesPerSample = 4;
  const payloadBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(68 + payloadBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'caff');
  view.setUint16(4, 1, false);
  view.setUint16(6, 0, false);
  writeAscii(view, 8, 'desc');
  view.setBigInt64(12, 32n, false);
  view.setFloat64(20, sampleRate, false);
  writeAscii(view, 28, 'lpcm');
  view.setUint32(32, 1 | 2, false);
  view.setUint32(36, bytesPerSample * channels, false);
  view.setUint32(40, 1, false);
  view.setUint32(44, channels, false);
  view.setUint32(48, 32, false);
  writeAscii(view, 52, 'data');
  view.setBigInt64(56, BigInt(payloadBytes + 4), false);
  view.setUint32(64, 0, false);

  for (let frame = 0; frame < frames; frame += 1) {
    const edgeFrames = Math.min(frame, frames - frame - 1);
    const fade = Math.min(1, edgeFrames / 720);
    for (let channel = 0; channel < channels; channel += 1) {
      const frequency = channel === 0 ? 440 : 660;
      const sample =
        Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * 0.25 * fade;
      view.setFloat32(
        68 + (frame * channels + channel) * bytesPerSample,
        sample,
        false,
      );
    }
  }

  return new File([buffer], 'test-tone-float32.caf', {
    lastModified: Date.now(),
    type: 'audio/x-caf',
  });
}

function describeError(error: unknown): RowError {
  if (error instanceof AudioTranscoderError) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  if (
    typeof error === 'object' &&
    error !== null
  ) {
    const code =
      'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    const message =
      'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error);
    const name =
      'name' in error && typeof error.name === 'string'
        ? error.name
        : undefined;
    const reason =
      'reason' in error && typeof error.reason === 'string'
        ? error.reason
        : undefined;
    const stack =
      'stack' in error && typeof error.stack === 'string'
        ? error.stack
        : undefined;
    return {
      ...(code === undefined ? {} : { code }),
      message,
      ...(name === undefined ? {} : { name }),
      ...(reason === undefined ? {} : { reason }),
      ...(stack === undefined ? {} : { stack }),
    };
  }
  return {
    message: String(error),
  };
}

function formatRowError(error: RowError): string {
  const classification = error.code ?? error.name;
  return classification === undefined
    ? error.message
    : `${classification}: ${error.message}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof AudioTranscoderError &&
      error.code === 'OPERATION_ABORTED') ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'OPERATION_ABORTED')
  );
}

function formatInspection(inspection: AudioStreamInspection): string {
  return [
    inspection.sampleRate === null
      ? 'Rate unknown'
      : `${formatNumber(inspection.sampleRate)} Hz`,
    inspection.channels === null
      ? 'Channels unknown'
      : `${inspection.channels} ch`,
    formatSourceEncoding(inspection),
    inspection.durationSeconds === null
      ? 'Duration unknown'
      : formatDuration(inspection.durationSeconds),
  ].join(' / ');
}

function formatSourceEncoding(inspection: AudioStreamInspection): string {
  const encoding = inspection.sourceEncoding;
  if (encoding === undefined || encoding.kind === 'unknown') {
    return inspection.bitDepth === null
      ? 'Encoding unknown'
      : `${inspection.bitDepth}-bit encoding`;
  }
  if (encoding.kind === 'lossless-compressed') {
    const depth = encoding.bitDepth === null ? '' : ` ${encoding.bitDepth}-bit`;
    return `${encoding.codec.toUpperCase()}${depth} lossless`;
  }
  if (encoding.kind === 'lossy-compressed') {
    const bitrate =
      encoding.estimatedBitrateBps === null
        ? ''
        : ` ~${formatNumber(encoding.estimatedBitrateBps / 1_000)} kbps`;
    return `${encoding.codec.toUpperCase()}${bitrate} lossy`;
  }

  const depth = encoding.bitDepth === null ? 'Unknown-depth' : `${encoding.bitDepth}-bit`;
  const representation =
    encoding.sampleFormat === 'float'
      ? 'float'
      : encoding.signedness === 'signed'
        ? 'signed integer'
        : encoding.signedness === 'unsigned'
          ? 'unsigned integer'
          : 'integer';
  const endianness =
    encoding.endianness === 'big'
      ? ' BE'
      : encoding.endianness === 'little'
        ? ' LE'
        : '';
  return `${depth} ${representation}${endianness}`;
}

function formatPreset(descriptor: OutputPresetDescriptor): string {
  if (descriptor.kind === 'lossy') {
    const codec = descriptor.codec.toUpperCase();
    const container = descriptor.preset.container.toUpperCase();
    const format = codec === container ? codec : `${codec} (${container})`;
    return `${format} ${descriptor.bitrate / 1_000} kbps`;
  }
  const format =
    descriptor.preset.sampleFormat === 'float' ? 'float' : 'PCM';
  return `${descriptor.preset.container.toUpperCase()} ${format} ${descriptor.bitDepth}-bit`;
}

function formatPhase(phase: AudioStreamProgress['phase'] | undefined): string {
  switch (phase) {
    case 'prepare':
      return 'Preparing';
    case 'decode':
      return 'Decoding';
    case 'encode':
      return 'Encoding';
    case 'finalize':
      return 'Finalizing';
    default:
      return 'Processing';
  }
}

function formatStorage(storage: OutputArtifact['storage']): string {
  return storage === 'opfs' ? 'OPFS' : 'memory';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0] ?? 'KiB';
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function outputName(name: string, extension: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'audio';
  return `${base}-converted.${extension}`;
}

function optionalNumber(value: string): number | undefined {
  if (value === '' || value === 'preserve') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing required element #${id}.`);
  }
  return element as T;
}

function requiredDescendant<T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing required template element ${selector}.`);
  }
  return element;
}
