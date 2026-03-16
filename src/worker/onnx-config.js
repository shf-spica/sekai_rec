/**
 * ONNX Runtime Web 設定
 * Web Worker内での統一設定
 *
 * onnxruntime-web/wasm を使用（CPU専用）
 */

import * as ort from 'onnxruntime-web/wasm';

function initializeONNX() {
  // シングルスレッドで安定動作
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'warning';

  // Web Worker内ではプロキシワーカー不要
  ort.env.wasm.proxy = false;
}

export async function createSession(modelData, options = {}) {
  const defaultOptions = {
    executionProviders: ['wasm'],
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
