/**
 * ONNX Runtime Web 設定
 * Web Worker内での統一設定
 *
 * WebGPU を優先し、未対応環境では WASM にフォールバック
 */

import * as ort from 'onnxruntime-web/webgpu';

function initializeONNX() {
  ort.env.logLevel = 'warning';
  if (ort.env.wasm) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  }
}

export async function createSession(modelData, options = {}) {
  const defaultOptions = {
    executionProviders: ['webgpu', 'wasm'],
    logSeverityLevel: 4,
    graphOptimizationLevel: 'basic',
    enableCpuMemArena: false,
    enableMemPattern: false,
    ...options,
  };

  try {
    const session = await ort.InferenceSession.create(modelData, defaultOptions);
    return session;
  } catch (error) {
    console.error('Failed to create ONNX session:', error);
    throw error;
  }
}

initializeONNX();

export { ort };
