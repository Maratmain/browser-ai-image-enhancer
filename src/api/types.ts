export type InputFormat = "jpeg" | "png" | "bmp" | "heic" | "heif";
export type OutputMimeType = "image/jpeg" | "image/png";
export type ProcessingBackend = "webgl2" | "cpu";
export type InferenceBackend = "wasm" | "javascript";

export type TaskStatus =
  | "queued"
  | "validating"
  | "decoding"
  | "normalizing"
  | "analyzing"
  | "enhancing"
  | "encoding"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export type TaskErrorCode =
  | "NOT_INITIALIZED"
  | "DISPOSED"
  | "INVALID_SOURCE"
  | "FILE_TOO_LARGE"
  | "QUEUE_FULL"
  | "UNSUPPORTED_FORMAT"
  | "INVALID_IMAGE"
  | "IMAGE_TOO_SMALL"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_DIMENSION_TOO_LARGE"
  | "DECODE_FAILED"
  | "UNSUPPORTED_BMP_VARIANT"
  | "HEIC_DECODER_LOAD_FAILED"
  | "HEIC_DECODE_FAILED"
  | "MODEL_LOAD_FAILED"
  | "MODEL_INVALID"
  | "MODEL_INFERENCE_FAILED"
  | "WASM_INITIALIZATION_FAILED"
  | "WEBGL_UNAVAILABLE"
  | "WEBGL_INITIALIZATION_FAILED"
  | "WEBGL_CONTEXT_LOST"
  | "CANVAS_LIMIT_EXCEEDED"
  | "OUTPUT_FORMAT_UNSUPPORTED"
  | "OUT_OF_MEMORY"
  | "ENCODE_FAILED"
  | "TASK_NOT_FOUND"
  | "TASK_EXPIRED"
  | "TASK_NOT_COMPLETED"
  | "TASK_CANCELLED"
  | "UNSUPPORTED_BROWSER"
  | "INTERNAL_ERROR";

export type TaskWarningCode =
  | "METADATA_STRIPPED"
  | "ANIMATION_FIRST_FRAME_ONLY"
  | "AUXILIARY_HEIF_IMAGES_IGNORED"
  | "CPU_FALLBACK_USED"
  | "WEBGL_CONTEXT_RECOVERED"
  | "JPEG_ALPHA_COMPOSITED"
  | "OUTPUT_MIME_CHANGED"
  | "NATIVE_DECODER_FALLBACK_USED"
  | "HEIC_NATIVE_DECODE_ONLY";

export interface TaskError {
  readonly code: TaskErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
  readonly stage?: TaskStatus;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface TaskWarning {
  readonly code: TaskWarningCode;
  readonly message: string;
}

export interface EnhancementParameters {
  readonly exposureEV: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly correctionStrength: number;
  readonly pivot: number;
}

export interface StageTimings {
  readonly validationMs: number;
  readonly decodingMs: number;
  readonly normalizationMs: number;
  readonly previewMs: number;
  readonly inferenceMs: number;
  readonly safetyGuardMs: number;
  readonly enhancementMs: number;
  readonly encodingMs: number;
  readonly processingMs: number;
}

export interface TaskInfo {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly progress: number;
  readonly stageProgress: number;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly queueTimeMs?: number;
  readonly processingTimeMs?: number;
  readonly totalTimeMs?: number;
  readonly input?: {
    readonly fileName?: string;
    readonly format: InputFormat;
    readonly mimeType?: string;
    readonly sizeBytes: number;
    readonly width: number;
    readonly height: number;
    readonly pixels: number;
    readonly hasAlpha: boolean;
  };
  readonly output?: {
    readonly mimeType: OutputMimeType;
    readonly sizeBytes: number;
    readonly width: number;
    readonly height: number;
  };
  readonly parameters?: EnhancementParameters;
  readonly processingBackend?: ProcessingBackend;
  readonly inferenceBackend?: InferenceBackend;
  readonly timings?: StageTimings;
  readonly warnings: readonly TaskWarning[];
  readonly error?: TaskError;
}

export interface ImageEnhancerOptions {
  readonly maxPixels?: number;
  readonly maxDimension?: number;
  readonly maxFileSizeBytes?: number;
  readonly queueLimit?: number;
  readonly resultRetentionMs?: number;
  readonly progressThrottleMs?: number;
  readonly modelWasmUrl?: string;
  readonly modelMetadataUrl?: string;
  readonly heicDecoderUrl?: string;
  readonly allowCpuFallback?: boolean;
  readonly preferredInferenceBackend?: "wasm" | "javascript";
}

export interface EnhanceTaskOptions {
  readonly outputType?: "auto" | OutputMimeType;
  readonly jpegQuality?: number;
  readonly backgroundColor?: string;
  readonly processingBackend?: "auto" | ProcessingBackend;
}

export interface EnhancerCapabilities {
  readonly worker: boolean;
  readonly offscreenCanvas: boolean;
  readonly createImageBitmap: boolean;
  readonly webgl2: boolean;
  readonly wasm: boolean;
  readonly nativeJpegDecode: boolean;
  readonly nativePngDecode: boolean;
  readonly nativeBmpDecode: boolean;
  readonly nativeHeicDecode: boolean;
  readonly jpegEncode: boolean;
  readonly pngEncode: boolean;
  readonly maxTextureSize?: number;
  readonly maxRenderbufferSize?: number;
  readonly maxViewportWidth?: number;
  readonly maxViewportHeight?: number;
  readonly primaryMode: "worker-webgl2" | "worker-cpu" | "unsupported";
  readonly inferenceBackend: InferenceBackend;
}

export interface StatusChangeDetail {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly progress: number;
  readonly stageProgress: number;
  readonly task: TaskInfo;
}

export interface AbortResult {
  readonly taskId: string;
  readonly success: boolean;
  readonly status: TaskStatus;
}

export interface ResolvedEnhancerOptions {
  readonly maxPixels: number;
  readonly maxDimension: number;
  readonly maxFileSizeBytes: number;
  readonly queueLimit: number;
  readonly resultRetentionMs: number;
  readonly progressThrottleMs: number;
  readonly modelWasmUrl: string;
  readonly modelMetadataUrl: string;
  readonly heicDecoderUrl?: string;
  readonly allowCpuFallback: boolean;
  readonly preferredInferenceBackend: "wasm" | "javascript";
}

export interface ResolvedTaskOptions {
  readonly outputType: "auto" | OutputMimeType;
  readonly jpegQuality: number;
  readonly backgroundColor: string;
  readonly processingBackend: "auto" | ProcessingBackend;
}

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "cancelled",
  "failed"
]);
