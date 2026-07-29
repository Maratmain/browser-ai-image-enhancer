import { EnhancerError } from "../utils/errors.js";
import { inferWithJavaScript } from "./javascriptRuntime.js";
function sigmoid(value) {
    if (value >= 0) {
        const inverse = Math.exp(-value);
        return 1 / (1 + inverse);
    }
    const exponent = Math.exp(value);
    return exponent / (1 + exponent);
}
function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}
function transform(raw) {
    return {
        exposureEV: clamp(Math.tanh(raw[0] ?? 0) * 1.25, -1.25, 1.25),
        contrast: clamp(1 + Math.tanh(raw[1] ?? 0) * 0.45, 0.7, 1.45),
        saturation: clamp(1 + Math.tanh(raw[2] ?? 0) * 0.5, 0.6, 1.5),
        correctionStrength: clamp(sigmoid(raw[3] ?? 0), 0, 1),
        pivot: 0.18
    };
}
export class ModelPredictor {
    #wasmUrl;
    #preferred;
    #wasm;
    #backend = "javascript";
    constructor(wasmUrl, preferred) {
        this.#wasmUrl = wasmUrl;
        this.#preferred = preferred;
    }
    get backend() {
        return this.#backend;
    }
    async initialize() {
        if (this.#preferred === "wasm" && typeof WebAssembly !== "undefined") {
            try {
                const response = await fetch(this.#wasmUrl, { cache: "force-cache" });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                const bytes = await response.arrayBuffer();
                const instantiated = await WebAssembly.instantiate(bytes, {});
                const exports = instantiated.instance.exports;
                if (!(exports.memory instanceof WebAssembly.Memory) ||
                    typeof exports.input_ptr !== "function" ||
                    typeof exports.output_ptr !== "function" ||
                    typeof exports.infer !== "function") {
                    throw new Error("WASM model exports are invalid");
                }
                this.#wasm = exports;
                this.#backend = "wasm";
            }
            catch {
                this.#wasm = undefined;
                this.#backend = "javascript";
            }
        }
        const warmup = new Float32Array(64 * 64 * 3);
        this.predict(warmup);
        return this.#backend;
    }
    predict(input) {
        if (input.length !== 64 * 64 * 3) {
            throw new EnhancerError("MODEL_INVALID", "Model input must contain 64 x 64 x 3 values", {
                stage: "analyzing",
                details: { actualLength: input.length }
            });
        }
        try {
            let raw;
            if (this.#wasm !== undefined) {
                const inputOffset = this.#wasm.input_ptr() / Float32Array.BYTES_PER_ELEMENT;
                const outputOffset = this.#wasm.output_ptr() / Float32Array.BYTES_PER_ELEMENT;
                const memory = new Float32Array(this.#wasm.memory.buffer);
                memory.set(input, inputOffset);
                this.#wasm.infer();
                raw = new Float32Array(4);
                raw.set(memory.subarray(outputOffset, outputOffset + 4));
            }
            else {
                raw = inferWithJavaScript(input);
            }
            return { parameters: transform(raw), backend: this.#backend };
        }
        catch (error) {
            throw new EnhancerError("MODEL_INFERENCE_FAILED", "The ML model failed to run", {
                stage: "analyzing",
                cause: error
            });
        }
    }
}
