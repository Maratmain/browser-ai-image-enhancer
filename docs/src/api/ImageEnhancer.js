import { TERMINAL_STATUSES } from "./types.js";
import { TaskManager } from "./TaskManager.js";
import { WorkerBridge } from "../worker/WorkerBridge.js";
import { EnhancerError } from "../utils/errors.js";
import { createTaskId } from "../utils/ids.js";
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024;
const DEFAULT_HEIC_DECODER_URL = "https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/next/heic-to.js";
function resolveEnhancerOptions(options = {}) {
    const defaults = {
        modelWasmUrl: new URL("../../assets/model.wasm", import.meta.url).href,
        modelMetadataUrl: new URL("../../assets/model.json", import.meta.url).href
    };
    return {
        maxPixels: options.maxPixels ?? 15_000_000,
        maxDimension: options.maxDimension ?? 16_384,
        maxFileSizeBytes: options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE,
        queueLimit: options.queueLimit ?? 8,
        resultRetentionMs: options.resultRetentionMs ?? 300_000,
        progressThrottleMs: options.progressThrottleMs ?? 100,
        modelWasmUrl: options.modelWasmUrl ?? defaults.modelWasmUrl,
        modelMetadataUrl: options.modelMetadataUrl ?? defaults.modelMetadataUrl,
        heicDecoderUrl: options.heicDecoderUrl ?? DEFAULT_HEIC_DECODER_URL,
        allowCpuFallback: options.allowCpuFallback ?? true,
        preferredInferenceBackend: options.preferredInferenceBackend ?? "wasm"
    };
}
function resolveTaskOptions(options = {}) {
    const quality = options.jpegQuality ?? 0.92;
    if (!Number.isFinite(quality) || quality < 0.1 || quality > 1) {
        throw new EnhancerError("INVALID_SOURCE", "jpegQuality must be between 0.1 and 1", {
            recoverable: true
        });
    }
    return {
        outputType: options.outputType ?? "auto",
        jpegQuality: quality,
        backgroundColor: options.backgroundColor ?? "#ffffff",
        processingBackend: options.processingBackend ?? "auto"
    };
}
export class ImageEnhancer extends EventTarget {
    #options;
    #bridge;
    #tasks;
    #submitted = new Set();
    #readyPromise;
    #disposed = false;
    constructor(options = {}) {
        super();
        this.#options = resolveEnhancerOptions(options);
        this.#bridge = new WorkerBridge(new URL("../worker/image.worker.js", import.meta.url));
        this.#bridge.addListener((message) => this.#handleWorkerMessage(message));
        this.#tasks = new TaskManager(this.#options.resultRetentionMs, (taskId) => {
            try {
                this.#bridge.post({ type: "DISPOSE_TASK", taskId });
            }
            catch {
                // The worker may already have been disposed.
            }
            this.#tasks.remove(taskId, true);
        });
    }
    ready() {
        this.#assertActive();
        if (this.#readyPromise === undefined) {
            const requestId = createTaskId();
            this.#readyPromise = this.#bridge.initialize({
                type: "INIT",
                requestId,
                options: this.#options
            });
        }
        return this.#readyPromise;
    }
    createTask(source, options = {}) {
        this.#assertActive();
        if (!(source instanceof Blob)) {
            throw new EnhancerError("INVALID_SOURCE", "Source must be a File or Blob", {
                recoverable: true
            });
        }
        if (source.size > this.#options.maxFileSizeBytes) {
            throw new EnhancerError("FILE_TOO_LARGE", "Input file exceeds the configured limit", {
                recoverable: true,
                details: { sizeBytes: source.size, limitBytes: this.#options.maxFileSizeBytes }
            });
        }
        if (this.#tasks.countActive() >= this.#options.queueLimit) {
            throw new EnhancerError("QUEUE_FULL", "Task queue is full", { recoverable: true });
        }
        const taskId = createTaskId();
        const createdAt = Date.now();
        const fileName = source instanceof File ? source.name : undefined;
        const mimeType = source.type || undefined;
        const task = {
            taskId,
            status: "queued",
            progress: 0,
            stageProgress: 0,
            createdAt,
            warnings: []
        };
        this.#tasks.create(task);
        this.#dispatchStatus(task);
        const taskOptions = resolveTaskOptions(options);
        void this.ready()
            .then(() => {
            if (!this.#tasks.has(taskId) || this.#submitted.has(taskId)) {
                return;
            }
            this.#submitted.add(taskId);
            this.#bridge.post({
                type: "CREATE_TASK",
                taskId,
                source,
                ...(fileName === undefined ? {} : { fileName }),
                ...(mimeType === undefined ? {} : { mimeType }),
                options: taskOptions,
                createdAt
            });
            const current = this.#tasks.get(taskId);
            if (current.status === "cancelling") {
                this.#bridge.post({ type: "ABORT_TASK", taskId });
            }
        })
            .catch((error) => {
            if (!this.#tasks.has(taskId)) {
                return;
            }
            const normalized = error instanceof EnhancerError
                ? error
                : new EnhancerError("NOT_INITIALIZED", error instanceof Error ? error.message : String(error));
            const failed = {
                ...this.#tasks.get(taskId),
                status: "failed",
                completedAt: Date.now(),
                error: normalized.toTaskError()
            };
            this.#tasks.update(failed);
            this.#dispatchStatus(failed);
        });
        return taskId;
    }
    getStatus(taskId) {
        this.#assertActive();
        return this.#tasks.get(taskId);
    }
    async abortTask(taskId) {
        this.#assertActive();
        const current = this.#tasks.get(taskId);
        if (TERMINAL_STATUSES.has(current.status)) {
            return { taskId, success: current.status === "cancelled", status: current.status };
        }
        const cancelling = {
            ...current,
            status: "cancelling"
        };
        this.#tasks.update(cancelling);
        this.#dispatchStatus(cancelling);
        if (this.#submitted.has(taskId)) {
            this.#bridge.post({ type: "ABORT_TASK", taskId });
        }
        const terminal = await this.#tasks.waitForTerminal(taskId);
        return {
            taskId,
            success: terminal.status === "cancelled",
            status: terminal.status
        };
    }
    async getResult(taskId) {
        this.#assertActive();
        return this.#tasks.getResult(taskId);
    }
    async disposeTask(taskId) {
        this.#assertActive();
        const current = this.#tasks.get(taskId);
        if (!TERMINAL_STATUSES.has(current.status)) {
            await this.abortTask(taskId);
        }
        if (this.#submitted.has(taskId)) {
            this.#bridge.post({ type: "DISPOSE_TASK", taskId });
        }
        this.#submitted.delete(taskId);
        this.#tasks.remove(taskId);
    }
    async dispose() {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        try {
            this.#bridge.post({ type: "DISPOSE" });
        }
        catch {
            // The worker may have failed before disposal.
        }
        this.#bridge.terminate();
        this.#submitted.clear();
        this.#tasks.clear();
    }
    #handleWorkerMessage(message) {
        if (this.#disposed) {
            return;
        }
        if (message.type === "STATUS") {
            if (!this.#tasks.has(message.taskId)) {
                return;
            }
            const task = this.#tasks.update(message.task);
            this.#dispatchStatus(task);
        }
        else if (message.type === "RESULT") {
            if (this.#tasks.has(message.taskId)) {
                this.#tasks.setResult(message.taskId, message.result);
            }
        }
        else if (message.type === "ERROR" && message.taskId !== undefined && this.#tasks.has(message.taskId)) {
            const current = this.#tasks.get(message.taskId);
            const failed = {
                ...current,
                status: "failed",
                completedAt: Date.now(),
                error: message.error
            };
            this.#tasks.update(failed);
            this.#dispatchStatus(failed);
        }
    }
    #dispatchStatus(task) {
        const detail = {
            taskId: task.taskId,
            status: task.status,
            progress: task.progress,
            stageProgress: task.stageProgress,
            task
        };
        this.dispatchEvent(new CustomEvent("statuschange", { detail }));
    }
    #assertActive() {
        if (this.#disposed) {
            throw new EnhancerError("DISPOSED", "ImageEnhancer has been disposed");
        }
    }
}
