import type { EnhancementParameters, InferenceBackend } from "../api/types.js";
import { EnhancerError } from "../utils/errors.js";
import { inferWithJavaScript } from "./javascriptRuntime.js";

interface WasmExports {
  readonly memory: WebAssembly.Memory;
  readonly input_ptr: () => number;
  readonly output_ptr: () => number;
  readonly infer: () => void;
}

export interface RawPrediction {
  readonly parameters: EnhancementParameters;
  readonly backend: InferenceBackend;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const inverse = Math.exp(-value);
    return 1 / (1 + inverse);
  }
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function transform(raw: Float32Array): EnhancementParameters {
  return {
    exposureEV: clamp(Math.tanh(raw[0] ?? 0) * 1.25, -1.25, 1.25),
    contrast: clamp(1 + Math.tanh(raw[1] ?? 0) * 0.45, 0.7, 1.45),
    saturation: clamp(1 + Math.tanh(raw[2] ?? 0) * 0.5, 0.6, 1.5),
    correctionStrength: clamp(sigmoid(raw[3] ?? 0), 0, 1),
    pivot: 0.18
  };
}

export class ModelPredictor {
  readonly #wasmUrl: string;
  readonly #preferred: "wasm" | "javascript";
  #wasm: WasmExports | undefined;
  #backend: InferenceBackend = "javascript";

  constructor(wasmUrl: string, preferred: "wasm" | "javascript") {
    this.#wasmUrl = wasmUrl;
    this.#preferred = preferred;
  }

  get backend(): InferenceBackend {
    return this.#backend;
  }

  async initialize(): Promise<InferenceBackend> {
    if (this.#preferred === "wasm" && typeof WebAssembly !== "undefined") {
      try {
        const response = await fetch(this.#wasmUrl, { cache: "force-cache" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        const instantiated = await WebAssembly.instantiate(bytes, {});
        const exports = instantiated.instance.exports as unknown as WasmExports;
        if (
          !(exports.memory instanceof WebAssembly.Memory) ||
          typeof exports.input_ptr !== "function" ||
          typeof exports.output_ptr !== "function" ||
          typeof exports.infer !== "function"
        ) {
          throw new Error("WASM model exports are invalid");
        }
        this.#wasm = exports;
        this.#backend = "wasm";
      } catch {
        this.#wasm = undefined;
        this.#backend = "javascript";
      }
    }

    const warmup = new Float32Array(64 * 64 * 3);
    this.predict(warmup);
    return this.#backend;
  }

  predict(input: Float32Array): RawPrediction {
    if (input.length !== 64 * 64 * 3) {
      throw new EnhancerError("MODEL_INVALID", "Model input must contain 64 x 64 x 3 values", {
        stage: "analyzing",
        details: { actualLength: input.length }
      });
    }

    try {
      let raw: Float32Array;
      if (this.#wasm !== undefined) {
        const inputOffset = this.#wasm.input_ptr() / Float32Array.BYTES_PER_ELEMENT;
        const outputOffset = this.#wasm.output_ptr() / Float32Array.BYTES_PER_ELEMENT;
        const memory = new Float32Array(this.#wasm.memory.buffer);
        memory.set(input, inputOffset);
        this.#wasm.infer();
        raw = new Float32Array(4);
        raw.set(memory.subarray(outputOffset, outputOffset + 4));
      } else {
        raw = inferWithJavaScript(input);
      }
      return { parameters: transform(raw), backend: this.#backend };
    } catch (error) {
      throw new EnhancerError("MODEL_INFERENCE_FAILED", "The ML model failed to run", {
        stage: "analyzing",
        cause: error
      });
    }
  }
}
