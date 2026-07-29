import type { EnhancementParameters } from "../api/types.js";
import { EnhancerError } from "../utils/errors.js";
import type { ProcessingHooks } from "./cpuProcessor.js";
import { createTiles } from "./tiling.js";
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders.js";

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new EnhancerError("WEBGL_INITIALIZATION_FAILED", "Unable to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "Unknown shader compilation error";
    gl.deleteShader(shader);
    throw new EnhancerError("WEBGL_INITIALIZATION_FAILED", log, { stage: "enhancing" });
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (program === null) throw new EnhancerError("WEBGL_INITIALIZATION_FAILED", "Unable to create WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "Unknown program link error";
    gl.deleteProgram(program);
    throw new EnhancerError("WEBGL_INITIALIZATION_FAILED", log, { stage: "enhancing" });
  }
  return program;
}

export interface WebGlLimits {
  readonly maxTextureSize: number;
  readonly maxRenderbufferSize: number;
  readonly maxViewportWidth: number;
  readonly maxViewportHeight: number;
}

export function queryWebGlLimits(): WebGlLimits | undefined {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2");
  if (gl === null) return undefined;
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  return {
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
    maxViewportWidth: viewport[0] ?? 0,
    maxViewportHeight: viewport[1] ?? 0
  };
}

export async function processWithWebGl(
  source: ImageBitmap,
  parameters: EnhancementParameters,
  requestedTileSize: number,
  hooks: ProcessingHooks
): Promise<OffscreenCanvas> {
  const output = new OffscreenCanvas(source.width, source.height);
  const outputContext = output.getContext("2d", { alpha: true });
  if (outputContext === null) {
    throw new EnhancerError("OUT_OF_MEMORY", "Unable to allocate output canvas", { stage: "enhancing" });
  }

  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance"
  });
  if (gl === null) {
    throw new EnhancerError("WEBGL_UNAVAILABLE", "WebGL2 is unavailable", { stage: "enhancing", recoverable: true });
  }

  const limits = queryWebGlLimits();
  const tileSize = Math.max(
    64,
    Math.min(
      requestedTileSize,
      limits?.maxTextureSize ?? requestedTileSize,
      limits?.maxRenderbufferSize ?? requestedTileSize,
      limits?.maxViewportWidth ?? requestedTileSize,
      limits?.maxViewportHeight ?? requestedTileSize
    )
  );
  const program = createProgram(gl);
  const buffer = gl.createBuffer();
  const texture = gl.createTexture();
  if (buffer === null || texture === null) {
    gl.deleteProgram(program);
    throw new EnhancerError("WEBGL_INITIALIZATION_FAILED", "Unable to allocate WebGL resources", { stage: "enhancing" });
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_image"), 0);
  gl.uniform1f(gl.getUniformLocation(program, "u_exposure"), parameters.exposureEV);
  gl.uniform1f(gl.getUniformLocation(program, "u_contrast"), parameters.contrast);
  gl.uniform1f(gl.getUniformLocation(program, "u_saturation"), parameters.saturation);
  gl.uniform1f(gl.getUniformLocation(program, "u_pivot"), parameters.pivot);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  const tiles = createTiles(source.width, source.height, tileSize);
  try {
    for (const tile of tiles) {
      if (hooks.isCancelled()) throw new EnhancerError("TASK_CANCELLED", "Task was cancelled", { stage: "enhancing" });
      canvas.width = tile.width;
      canvas.height = tile.height;
      gl.viewport(0, 0, tile.width, tile.height);
      const bitmap = await createImageBitmap(source, tile.x, tile.y, tile.width, tile.height, {
        premultiplyAlpha: "none"
      });
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      bitmap.close();
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.flush();
      const rendered = canvas.transferToImageBitmap();
      outputContext.drawImage(rendered, tile.x, tile.y);
      rendered.close();
      hooks.onProgress(((tile.index + 1) / tile.count) * 100);
      await Promise.resolve();
    }
  } finally {
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  }
  return output;
}
