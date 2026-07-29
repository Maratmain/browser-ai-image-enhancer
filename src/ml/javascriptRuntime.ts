import { MODEL_WEIGHTS } from "./modelWeights.js";

function relu(value: number): number {
  return value > 0 ? value : 0;
}

function conv3x3Stride2(
  input: Float32Array,
  inputSize: number,
  inputChannels: number,
  outputChannels: number,
  weights: Float32Array,
  bias: Float32Array
): Float32Array {
  const outputSize = Math.ceil(inputSize / 2);
  const output = new Float32Array(outputSize * outputSize * outputChannels);
  for (let oy = 0; oy < outputSize; oy += 1) {
    for (let ox = 0; ox < outputSize; ox += 1) {
      for (let oc = 0; oc < outputChannels; oc += 1) {
        let sum = bias[oc] ?? 0;
        for (let ky = 0; ky < 3; ky += 1) {
          const iy = oy * 2 + ky - 1;
          if (iy < 0 || iy >= inputSize) continue;
          for (let kx = 0; kx < 3; kx += 1) {
            const ix = ox * 2 + kx - 1;
            if (ix < 0 || ix >= inputSize) continue;
            for (let ic = 0; ic < inputChannels; ic += 1) {
              const inputIndex = (iy * inputSize + ix) * inputChannels + ic;
              const weightIndex = ((oc * inputChannels + ic) * 3 + ky) * 3 + kx;
              sum += (input[inputIndex] ?? 0) * (weights[weightIndex] ?? 0);
            }
          }
        }
        output[(oy * outputSize + ox) * outputChannels + oc] = relu(sum);
      }
    }
  }
  return output;
}

function depthwisePointwise(
  input: Float32Array,
  inputSize: number,
  inputChannels: number,
  outputChannels: number,
  depthwiseWeights: Float32Array,
  depthwiseBias: Float32Array,
  pointwiseWeights: Float32Array,
  pointwiseBias: Float32Array
): Float32Array {
  const outputSize = Math.ceil(inputSize / 2);
  const depthwise = new Float32Array(outputSize * outputSize * inputChannels);
  const output = new Float32Array(outputSize * outputSize * outputChannels);

  for (let oy = 0; oy < outputSize; oy += 1) {
    for (let ox = 0; ox < outputSize; ox += 1) {
      for (let channel = 0; channel < inputChannels; channel += 1) {
        let sum = depthwiseBias[channel] ?? 0;
        for (let ky = 0; ky < 3; ky += 1) {
          const iy = oy * 2 + ky - 1;
          if (iy < 0 || iy >= inputSize) continue;
          for (let kx = 0; kx < 3; kx += 1) {
            const ix = ox * 2 + kx - 1;
            if (ix < 0 || ix >= inputSize) continue;
            sum +=
              (input[(iy * inputSize + ix) * inputChannels + channel] ?? 0) *
              (depthwiseWeights[channel * 9 + ky * 3 + kx] ?? 0);
          }
        }
        depthwise[(oy * outputSize + ox) * inputChannels + channel] = sum;
      }

      for (let oc = 0; oc < outputChannels; oc += 1) {
        let sum = pointwiseBias[oc] ?? 0;
        for (let ic = 0; ic < inputChannels; ic += 1) {
          sum +=
            (depthwise[(oy * outputSize + ox) * inputChannels + ic] ?? 0) *
            (pointwiseWeights[oc * inputChannels + ic] ?? 0);
        }
        output[(oy * outputSize + ox) * outputChannels + oc] = relu(sum);
      }
    }
  }
  return output;
}

export function inferWithJavaScript(input: Float32Array): Float32Array {
  const b1 = conv3x3Stride2(input, 64, 3, 8, MODEL_WEIGHTS.conv1W, MODEL_WEIGHTS.conv1B);
  const b2 = depthwisePointwise(
    b1,
    32,
    8,
    16,
    MODEL_WEIGHTS.dw2W,
    MODEL_WEIGHTS.dw2B,
    MODEL_WEIGHTS.pw2W,
    MODEL_WEIGHTS.pw2B
  );
  const b3 = depthwisePointwise(
    b2,
    16,
    16,
    24,
    MODEL_WEIGHTS.dw3W,
    MODEL_WEIGHTS.dw3B,
    MODEL_WEIGHTS.pw3W,
    MODEL_WEIGHTS.pw3B
  );
  const b4 = depthwisePointwise(
    b3,
    8,
    24,
    32,
    MODEL_WEIGHTS.dw4W,
    MODEL_WEIGHTS.dw4B,
    MODEL_WEIGHTS.pw4W,
    MODEL_WEIGHTS.pw4B
  );

  const pooled = new Float32Array(32);
  for (let channel = 0; channel < 32; channel += 1) {
    let sum = 0;
    for (let pixel = 0; pixel < 16; pixel += 1) {
      sum += b4[pixel * 32 + channel] ?? 0;
    }
    pooled[channel] = sum / 16;
  }

  const hidden = new Float32Array(16);
  for (let output = 0; output < 16; output += 1) {
    let sum = MODEL_WEIGHTS.fc1B[output] ?? 0;
    for (let inputIndex = 0; inputIndex < 32; inputIndex += 1) {
      sum += (pooled[inputIndex] ?? 0) * (MODEL_WEIGHTS.fc1W[output * 32 + inputIndex] ?? 0);
    }
    hidden[output] = relu(sum);
  }

  const result = new Float32Array(4);
  for (let output = 0; output < 4; output += 1) {
    let sum = MODEL_WEIGHTS.fc2B[output] ?? 0;
    for (let inputIndex = 0; inputIndex < 16; inputIndex += 1) {
      sum += (hidden[inputIndex] ?? 0) * (MODEL_WEIGHTS.fc2W[output * 16 + inputIndex] ?? 0);
    }
    result[output] = sum;
  }
  return result;
}
