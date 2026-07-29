import { detectFormat } from "../codecs/detectFormat.js";
import { probeImage } from "../codecs/dimensions.js";
import { decodeImage } from "../codecs/nativeDecoder.js";
import { encodeCanvas } from "../codecs/encoder.js";
import { ModelPredictor } from "../ml/predictor.js";
import { prepareModelInput } from "../ml/preprocess.js";
import { applySafetyGuard } from "../ml/safetyGuard.js";
import { processWithCpu } from "../processing/cpuProcessor.js";
import { processWithWebGl, queryWebGlLimits } from "../processing/webglProcessor.js";
import { TaskResources } from "../resources/TaskResources.js";
import { EnhancerError, normalizeError } from "../utils/errors.js";
import { now, roundMs } from "../utils/timing.js";
const scope = self;
const queue = [];
const tasks = new Map();
let currentTask;
let enhancerOptions;
let predictor;
let initialized = false;
let disposed = false;
function post(message) {
    scope.postMessage(message);
}
function ensureNotCancelled(task, stage) {
    if (task.cancelled || task.disposed || disposed) {
        throw new EnhancerError("TASK_CANCELLED", "Task was cancelled", {
            ...(stage === undefined ? {} : { stage })
        });
    }
}
function updateTask(task, status, progress, stageProgress, patch = {}, force = false) {
    const options = enhancerOptions;
    const timestamp = now();
    const previousStatus = task.info.status;
    const monotonic = Math.max(task.info.progress, Math.min(100, progress));
    task.info = {
        ...task.info,
        ...patch,
        status,
        progress: monotonic,
        stageProgress: Math.max(0, Math.min(100, stageProgress))
    };
    const statusChanged = status !== previousStatus;
    const progressChanged = monotonic - task.lastEmittedProgress >= 1;
    const due = timestamp - task.lastEmittedAt >= (options?.progressThrottleMs ?? 100);
    if (force || statusChanged || (progressChanged && due)) {
        task.lastEmittedAt = timestamp;
        task.lastEmittedProgress = monotonic;
        post({ type: "STATUS", taskId: task.taskId, task: task.info });
    }
}
function forceStatus(task, status, progress, stageProgress, patch = {}) {
    task.info = {
        ...task.info,
        ...patch,
        status,
        progress: Math.max(task.info.progress, Math.min(100, progress)),
        stageProgress: Math.max(0, Math.min(100, stageProgress))
    };
    task.lastEmittedAt = now();
    task.lastEmittedProgress = task.info.progress;
    post({ type: "STATUS", taskId: task.taskId, task: task.info });
}
function validateDimensions(width, height) {
    const options = enhancerOptions;
    if (options === undefined)
        throw new EnhancerError("NOT_INITIALIZED", "Worker is not initialized");
    if (width < 16 || height < 16) {
        throw new EnhancerError("IMAGE_TOO_SMALL", "Image dimensions must be at least 16 x 16 pixels", {
            stage: "validating",
            recoverable: true,
            details: { width, height }
        });
    }
    if (width > options.maxDimension || height > options.maxDimension) {
        throw new EnhancerError("IMAGE_DIMENSION_TOO_LARGE", "Image side exceeds the configured limit", {
            stage: "validating",
            recoverable: true,
            details: { width, height, maxDimension: options.maxDimension }
        });
    }
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels > options.maxPixels) {
        throw new EnhancerError("IMAGE_TOO_LARGE", "Image contains more pixels than allowed", {
            stage: "validating",
            recoverable: true,
            details: { width, height, pixels, maxPixels: options.maxPixels }
        });
    }
}
function timingsWithTotal(partial, started) {
    return {
        ...partial,
        processingMs: roundMs(now() - started)
    };
}
async function initialize(options) {
    if (initialized && predictor !== undefined) {
        const limits = queryWebGlLimits();
        return {
            worker: true,
            offscreenCanvas: typeof OffscreenCanvas !== "undefined",
            createImageBitmap: typeof createImageBitmap === "function",
            webgl2: limits !== undefined,
            wasm: typeof WebAssembly !== "undefined",
            nativeJpegDecode: true,
            nativePngDecode: true,
            nativeBmpDecode: true,
            nativeHeicDecode: false,
            jpegEncode: true,
            pngEncode: true,
            ...(limits === undefined
                ? {}
                : {
                    maxTextureSize: limits.maxTextureSize,
                    maxRenderbufferSize: limits.maxRenderbufferSize,
                    maxViewportWidth: limits.maxViewportWidth,
                    maxViewportHeight: limits.maxViewportHeight
                }),
            primaryMode: limits !== undefined ? "worker-webgl2" : options.allowCpuFallback ? "worker-cpu" : "unsupported",
            inferenceBackend: predictor.backend
        };
    }
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
        throw new EnhancerError("UNSUPPORTED_BROWSER", "OffscreenCanvas and createImageBitmap are required");
    }
    const metadataResponse = await fetch(options.modelMetadataUrl, { cache: "force-cache" });
    if (!metadataResponse.ok) {
        throw new EnhancerError("MODEL_LOAD_FAILED", `Model metadata request failed with HTTP ${metadataResponse.status}`);
    }
    const metadata = (await metadataResponse.json());
    if (metadata.architecture !== "tiny-cnn-v1" || metadata.input?.width !== 64 || metadata.input.height !== 64) {
        throw new EnhancerError("MODEL_INVALID", "Model metadata is incompatible with this runtime");
    }
    const nextPredictor = new ModelPredictor(options.modelWasmUrl, options.preferredInferenceBackend);
    await nextPredictor.initialize();
    predictor = nextPredictor;
    enhancerOptions = options;
    initialized = true;
    const limits = queryWebGlLimits();
    const testCanvas = new OffscreenCanvas(2, 2);
    const context = testCanvas.getContext("2d");
    context?.fillRect(0, 0, 2, 2);
    let pngEncode = false;
    let jpegEncode = false;
    try {
        pngEncode = (await testCanvas.convertToBlob({ type: "image/png" })).size > 0;
    }
    catch {
        pngEncode = false;
    }
    try {
        const blob = await testCanvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
        jpegEncode = blob.size > 0 && blob.type === "image/jpeg";
    }
    catch {
        jpegEncode = false;
    }
    const primaryMode = limits !== undefined ? "worker-webgl2" : options.allowCpuFallback ? "worker-cpu" : "unsupported";
    if (primaryMode === "unsupported") {
        throw new EnhancerError("UNSUPPORTED_BROWSER", "Neither WebGL2 nor the CPU fallback is available");
    }
    return {
        worker: true,
        offscreenCanvas: true,
        createImageBitmap: true,
        webgl2: limits !== undefined,
        wasm: typeof WebAssembly !== "undefined",
        nativeJpegDecode: true,
        nativePngDecode: true,
        nativeBmpDecode: true,
        nativeHeicDecode: false,
        jpegEncode,
        pngEncode,
        ...(limits === undefined
            ? {}
            : {
                maxTextureSize: limits.maxTextureSize,
                maxRenderbufferSize: limits.maxRenderbufferSize,
                maxViewportWidth: limits.maxViewportWidth,
                maxViewportHeight: limits.maxViewportHeight
            }),
        primaryMode,
        inferenceBackend: nextPredictor.backend
    };
}
async function runTask(task) {
    const options = enhancerOptions;
    const activePredictor = predictor;
    if (options === undefined || activePredictor === undefined) {
        throw new EnhancerError("NOT_INITIALIZED", "Worker has not been initialized");
    }
    const resources = new TaskResources();
    const started = now();
    const startedAt = Date.now();
    const warnings = [];
    let format;
    let validationMs = 0;
    let decodingMs = 0;
    let normalizationMs = 0;
    let previewMs = 0;
    let inferenceMs = 0;
    let safetyGuardMs = 0;
    let enhancementMs = 0;
    let encodingMs = 0;
    try {
        ensureNotCancelled(task, "validating");
        forceStatus(task, "validating", 1, 0, {
            startedAt,
            queueTimeMs: Math.max(0, startedAt - task.createdAt)
        });
        const validationStart = now();
        if (task.source.size > options.maxFileSizeBytes) {
            throw new EnhancerError("FILE_TOO_LARGE", "Input file exceeds the configured limit", {
                stage: "validating",
                recoverable: true,
                details: { sizeBytes: task.source.size, maxFileSizeBytes: options.maxFileSizeBytes }
            });
        }
        format = await detectFormat(task.source);
        const probe = await probeImage(task.source, format);
        if (probe.width !== undefined && probe.height !== undefined) {
            validateDimensions(probe.width, probe.height);
        }
        validationMs = roundMs(now() - validationStart);
        ensureNotCancelled(task, "decoding");
        forceStatus(task, "decoding", 5, 0);
        const decodeStart = now();
        const decoded = await decodeImage(task.source, format, probe, options.heicDecoderUrl);
        decodingMs = roundMs(now() - decodeStart);
        resources.trackBitmap(decoded.bitmap);
        warnings.push(...decoded.warnings);
        ensureNotCancelled(task, "normalizing");
        forceStatus(task, "normalizing", 20, 0);
        const normalizeStart = now();
        validateDimensions(decoded.width, decoded.height);
        normalizationMs = roundMs(now() - normalizeStart);
        const inputInfo = {
            ...(task.fileName === undefined ? {} : { fileName: task.fileName }),
            format,
            ...(task.mimeType === undefined ? {} : { mimeType: task.mimeType }),
            sizeBytes: task.source.size,
            width: decoded.width,
            height: decoded.height,
            pixels: decoded.width * decoded.height,
            hasAlpha: decoded.hasAlpha
        };
        forceStatus(task, "analyzing", 25, 0, { input: inputInfo, warnings: [...warnings] });
        const previewStart = now();
        const prepared = prepareModelInput(decoded.bitmap, 64);
        previewMs = roundMs(now() - previewStart);
        ensureNotCancelled(task, "analyzing");
        updateTask(task, "analyzing", 32, 35, {}, true);
        const inferenceStart = now();
        const prediction = activePredictor.predict(prepared.values);
        inferenceMs = roundMs(now() - inferenceStart);
        ensureNotCancelled(task, "analyzing");
        const safetyStart = now();
        const parameters = applySafetyGuard(prediction.parameters, prepared.statistics);
        safetyGuardMs = roundMs(now() - safetyStart);
        forceStatus(task, "enhancing", 45, 0, {
            parameters,
            inferenceBackend: prediction.backend
        });
        const enhancementStart = now();
        let processingBackend;
        let processed;
        const hooks = {
            isCancelled: () => task.cancelled || task.disposed || disposed,
            onProgress: (stageProgress) => {
                updateTask(task, "enhancing", 45 + stageProgress * 0.4, stageProgress);
            }
        };
        const forceCpu = task.options.processingBackend === "cpu";
        const forceWebGl = task.options.processingBackend === "webgl2";
        if (!forceCpu) {
            try {
                processed = await processWithWebGl(decoded.bitmap, parameters, 2048, hooks);
                processingBackend = "webgl2";
            }
            catch (error) {
                if (forceWebGl || !options.allowCpuFallback || error instanceof EnhancerError && error.code === "TASK_CANCELLED") {
                    throw error;
                }
                warnings.push({ code: "CPU_FALLBACK_USED", message: "WebGL2 недоступен; использован резервный CPU-режим." });
                processed = await processWithCpu(decoded.bitmap, parameters, 384, hooks);
                processingBackend = "cpu";
            }
        }
        else {
            processed = await processWithCpu(decoded.bitmap, parameters, 384, hooks);
            processingBackend = "cpu";
        }
        enhancementMs = roundMs(now() - enhancementStart);
        ensureNotCancelled(task, "encoding");
        resources.releaseBitmap(decoded.bitmap);
        forceStatus(task, "encoding", 85, 0, {
            processingBackend,
            warnings: [...warnings]
        });
        const encodeStart = now();
        const encoded = await encodeCanvas(processed, format, decoded.hasAlpha, task.options);
        encodingMs = roundMs(now() - encodeStart);
        warnings.push(...encoded.warnings);
        ensureNotCancelled(task, "encoding");
        const completedAt = Date.now();
        const timings = timingsWithTotal({
            validationMs,
            decodingMs,
            normalizationMs,
            previewMs,
            inferenceMs,
            safetyGuardMs,
            enhancementMs,
            encodingMs
        }, started);
        const completed = {
            ...task.info,
            status: "completed",
            progress: 100,
            stageProgress: 100,
            completedAt,
            processingTimeMs: timings.processingMs,
            totalTimeMs: Math.max(0, completedAt - task.createdAt),
            output: {
                mimeType: encoded.mimeType,
                sizeBytes: encoded.blob.size,
                width: processed.width,
                height: processed.height
            },
            parameters,
            processingBackend,
            inferenceBackend: prediction.backend,
            timings,
            warnings: [...warnings, { code: "METADATA_STRIPPED", message: "Метаданные EXIF и GPS не перенесены в результат." }]
        };
        task.info = completed;
        post({ type: "STATUS", taskId: task.taskId, task: completed });
        post({ type: "RESULT", taskId: task.taskId, result: encoded.blob });
    }
    catch (error) {
        const normalized = normalizeError(error, "INTERNAL_ERROR", task.info.status);
        const completedAt = Date.now();
        if (normalized.code === "TASK_CANCELLED" || task.cancelled || task.disposed || disposed) {
            const cancelled = {
                ...task.info,
                status: "cancelled",
                stageProgress: task.info.stageProgress,
                completedAt,
                processingTimeMs: roundMs(now() - started),
                totalTimeMs: Math.max(0, completedAt - task.createdAt),
                warnings: [...warnings]
            };
            task.info = cancelled;
            post({ type: "STATUS", taskId: task.taskId, task: cancelled });
        }
        else {
            const failed = {
                ...task.info,
                status: "failed",
                completedAt,
                processingTimeMs: roundMs(now() - started),
                totalTimeMs: Math.max(0, completedAt - task.createdAt),
                warnings: [...warnings],
                error: normalized.toTaskError()
            };
            task.info = failed;
            post({ type: "STATUS", taskId: task.taskId, task: failed });
        }
    }
    finally {
        resources.dispose();
    }
}
async function processQueue() {
    if (currentTask !== undefined || disposed)
        return;
    const next = queue.shift();
    if (next === undefined)
        return;
    currentTask = next;
    await runTask(next);
    if (next.disposed)
        tasks.delete(next.taskId);
    currentTask = undefined;
    void processQueue();
}
function createTask(message) {
    if (!initialized || disposed) {
        post({
            type: "ERROR",
            taskId: message.taskId,
            error: new EnhancerError(disposed ? "DISPOSED" : "NOT_INITIALIZED", "Worker is unavailable").toTaskError()
        });
        return;
    }
    const task = {
        taskId: message.taskId,
        source: message.source,
        ...(message.fileName === undefined ? {} : { fileName: message.fileName }),
        ...(message.mimeType === undefined ? {} : { mimeType: message.mimeType }),
        options: message.options,
        createdAt: message.createdAt,
        cancelled: false,
        disposed: false,
        lastEmittedAt: 0,
        lastEmittedProgress: 0,
        info: {
            taskId: message.taskId,
            status: "queued",
            progress: 0,
            stageProgress: 0,
            createdAt: message.createdAt,
            warnings: []
        }
    };
    tasks.set(task.taskId, task);
    queue.push(task);
    post({ type: "STATUS", taskId: task.taskId, task: task.info });
    void processQueue();
}
function abortTask(taskId) {
    const task = tasks.get(taskId);
    if (task === undefined)
        return;
    task.cancelled = true;
    if (currentTask?.taskId !== taskId) {
        const index = queue.findIndex((candidate) => candidate.taskId === taskId);
        if (index >= 0)
            queue.splice(index, 1);
        const cancelled = {
            ...task.info,
            status: "cancelled",
            completedAt: Date.now()
        };
        task.info = cancelled;
        post({ type: "STATUS", taskId, task: cancelled });
    }
}
scope.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "INIT") {
        void initialize(message.options)
            .then((capabilities) => post({ type: "READY", requestId: message.requestId, capabilities }))
            .catch((error) => {
            const normalized = normalizeError(error, "NOT_INITIALIZED");
            post({ type: "INIT_ERROR", requestId: message.requestId, error: normalized.toTaskError() });
        });
    }
    else if (message.type === "CREATE_TASK") {
        createTask(message);
    }
    else if (message.type === "ABORT_TASK") {
        abortTask(message.taskId);
    }
    else if (message.type === "DISPOSE_TASK") {
        const task = tasks.get(message.taskId);
        if (task !== undefined) {
            task.disposed = true;
            abortTask(message.taskId);
            if (currentTask?.taskId !== message.taskId)
                tasks.delete(message.taskId);
        }
    }
    else if (message.type === "DISPOSE") {
        disposed = true;
        for (const task of tasks.values())
            task.cancelled = true;
        queue.splice(0, queue.length);
        post({ type: "DISPOSED" });
        scope.close();
    }
});
