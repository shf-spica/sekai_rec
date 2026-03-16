/**
 * OCR Web Worker (ndlocr-lite)
 * DEIMv2 (レイアウト検出) + PARSeq (文字認識) によるOCR処理
 *
 * カスケード文字認識:
 *   charCountCategory=3 → recognizer30 (16×256, ≤30文字)
 *   charCountCategory=2 → recognizer50 (16×384, ≤50文字)
 *   それ以外            → recognizer100 (16×768, ≤100文字)
 */

import './src/worker/onnx-config.js';
import { loadModel } from './src/worker/model-loader.js';
import { LayoutDetector } from './src/worker/layout-detector.js';
import { TextRecognizer } from './src/worker/text-recognizer.js';
import { ReadingOrderProcessor } from './src/worker/reading-order.js';

class OCRWorker {
  constructor() {
    this.layoutDetector = null;
    this.recognizer30 = null;
    this.recognizer50 = null;
    this.recognizer100 = null;
    this.readingOrderProcessor = new ReadingOrderProcessor();
    this.isInitialized = false;
  }

  post(message) {
    self.postMessage(message);
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      this.post({
        type: 'OCR_PROGRESS',
        stage: 'initializing',
        progress: 0.02,
        message: 'モデルを初期化中...',
      });

      // 4モデルを並列ダウンロード
      const progresses = { layout: 0, rec30: 0, rec50: 0, rec100: 0 };
      const reportProgress = () => {
        const avg = (progresses.layout + progresses.rec30 + progresses.rec50 + progresses.rec100) / 4;
        this.post({
          type: 'OCR_PROGRESS',
          stage: 'loading_models',
          progress: 0.02 + avg * 0.73,
          message: `モデルダウンロード中... ${Math.round(avg * 100)}%`,
        });
      };

      const [layoutModelData, rec30Data, rec50Data, rec100Data] = await Promise.all([
        loadModel('layout', (p) => { progresses.layout = p; reportProgress(); }),
        loadModel('recognition30', (p) => { progresses.rec30 = p; reportProgress(); }),
        loadModel('recognition50', (p) => { progresses.rec50 = p; reportProgress(); }),
        loadModel('recognition100', (p) => { progresses.rec100 = p; reportProgress(); }),
      ]);

      // ONNXセッション作成（直列）
      this.post({ type: 'OCR_PROGRESS', stage: 'initializing_models', progress: 0.76, message: 'レイアウトモデル準備中...' });
      this.layoutDetector = new LayoutDetector();
      await this.layoutDetector.initialize(layoutModelData);

      this.post({ type: 'OCR_PROGRESS', stage: 'initializing_models', progress: 0.83, message: '認識モデル (30) 準備中...' });
      this.recognizer30 = new TextRecognizer([1, 3, 16, 256]);
      await this.recognizer30.initialize(rec30Data);

      this.post({ type: 'OCR_PROGRESS', stage: 'initializing_models', progress: 0.90, message: '認識モデル (50) 準備中...' });
      this.recognizer50 = new TextRecognizer([1, 3, 16, 384]);
      await this.recognizer50.initialize(rec50Data);

      this.post({ type: 'OCR_PROGRESS', stage: 'initializing_models', progress: 0.96, message: '認識モデル (100) 準備中...' });
      this.recognizer100 = new TextRecognizer([1, 3, 16, 768]);
      await this.recognizer100.initialize(rec100Data);

      this.isInitialized = true;

      this.post({
        type: 'OCR_PROGRESS',
        stage: 'initialized',
        progress: 1.0,
        message: 'Ready',
      });
    } catch (error) {
      this.post({
        type: 'OCR_ERROR',
        error: error.message,
        stage: 'initialization',
      });
      throw error;
    }
  }

  /**
   * 2値化前処理: 各ピクセルの輝度が閾値以上なら白(255)、未満なら黒(0)
   */
  binarize(imageData, threshold = 128) {
    const { data, width, height } = imageData;
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < data.length; i += 4) {
      // ITU-R BT.601 輝度
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const v = lum >= threshold ? 255 : 0;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
    return new ImageData(out, width, height);
  }

  selectRecognizer(charCountCategory) {
    if (charCountCategory === 3) return this.recognizer30;
    if (charCountCategory === 2) return this.recognizer50;
    return this.recognizer100;
  }

  /**
   * ImageDataから矩形領域を切り出す
   */
  cropRegion(imageData, x, y, w, h) {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
    const cropped = ctx.getImageData(x, y, w, h);
    return cropped;
  }

  /**
   * 1つの領域に対してOCRパイプラインを実行
   * @returns {Array} textBlocks（元画像座標系に変換済み）
   */
  async ocrRegion(regionImageData, offsetX, offsetY, regionLabel, id, progressBase, progressRange) {
    // 2値化
    const binarized = this.binarize(regionImageData, 128);

    // レイアウト検出
    this.post({
      type: 'OCR_PROGRESS', id,
      stage: 'layout_detection',
      progress: progressBase,
      message: `${regionLabel}: 領域検出中...`,
    });

    const { lines: textRegions, blocks: pageBlocks } = await this.layoutDetector.detect(
      binarized,
      (p) => {
        this.post({
          type: 'OCR_PROGRESS', id,
          stage: 'layout_detection',
          progress: progressBase + p * progressRange * 0.4,
          message: `${regionLabel}: 領域検出中... ${Math.round(p * 100)}%`,
        });
      }
    );

    // 文字認識
    const croppedImages = TextRecognizer.cropImageDataBatch(binarized, textRegions);
    const results = [];
    for (let i = 0; i < textRegions.length; i++) {
      const region = textRegions[i];
      const recognizer = this.selectRecognizer(region.charCountCategory);
      const result = await recognizer.recognizeCropped(croppedImages[i]);

      results.push({
        ...region,
        // クロップ領域のオフセットを足して元画像座標系に変換
        x: region.x + offsetX,
        y: region.y + offsetY,
        text: result.text,
        readingOrder: i + 1,
        regionLabel,
      });

      this.post({
        type: 'OCR_PROGRESS', id,
        stage: 'text_recognition',
        progress: progressBase + progressRange * (0.4 + ((i + 1) / textRegions.length) * 0.6),
        message: `${regionLabel}: 認識 ${i + 1}/${textRegions.length}`,
      });
    }

    return { results, pageBlocks };
  }

  async processOCR(id, imageData, startTime) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      const W = imageData.width;
      const H = imageData.height;

      // Stage 0: 前処理（領域クロップ）
      this.post({
        type: 'OCR_PROGRESS', id,
        stage: 'preprocessing',
        progress: 0.02,
        message: '画像をクロップ中...',
      });

      // 領域1: 上1/3 → 曲名（CLEAR / 曲名 / 難易度）
      const titleRegion = this.cropRegion(imageData, 0, 0, W, Math.round(H / 3));
      // 領域2: 左2/3 × 下2/3 → スコア・判定（PERFECT, GREAT等）
      const scoreX = 0;
      const scoreY = Math.round(H / 3);
      const scoreW = Math.round(W * 2 / 3);
      const scoreH = H - scoreY;
      const scoreRegion = this.cropRegion(imageData, scoreX, scoreY, scoreW, scoreH);

      // Stage 1: 曲名領域 OCR (progress: 0.05 ~ 0.45)
      this.post({
        type: 'OCR_PROGRESS', id,
        stage: 'ocr_title',
        progress: 0.05,
        message: '曲名領域を認識中...',
      });
      const titleResult = await this.ocrRegion(titleRegion, 0, 0, '曲名', id, 0.05, 0.40);

      // Stage 2: スコア領域 OCR (progress: 0.45 ~ 0.85)
      this.post({
        type: 'OCR_PROGRESS', id,
        stage: 'ocr_score',
        progress: 0.45,
        message: 'スコア領域を認識中...',
      });
      const scoreResult = await this.ocrRegion(scoreRegion, scoreX, scoreY, 'スコア', id, 0.45, 0.40);

      // Stage 3: 結果マージ
      this.post({
        type: 'OCR_PROGRESS', id,
        stage: 'merging',
        progress: 0.85,
        message: '結果を統合中...',
      });

      const allResults = [...titleResult.results, ...scoreResult.results];
      // 読み順を再付番
      allResults.forEach((b, i) => { b.readingOrder = i + 1; });

      const txt = allResults
        .filter((b) => b.text)
        .map((b) => b.text)
        .join('\n');

      this.post({
        type: 'OCR_COMPLETE',
        id,
        textBlocks: allResults,
        txt,
        processingTime: Date.now() - startTime,
      });
    } catch (error) {
      this.post({
        type: 'OCR_ERROR',
        id,
        error: error.message,
      });
    }
  }
}

const ocrWorker = new OCRWorker();

self.onmessage = async (event) => {
  const message = event.data;

  switch (message.type) {
    case 'INITIALIZE':
      await ocrWorker.initialize();
      break;

    case 'OCR_PROCESS':
      await ocrWorker.processOCR(message.id, message.imageData, message.startTime);
      break;

    case 'TERMINATE':
      self.close();
      break;
  }
};

self.onerror = (error) => {
  const msg = typeof error === 'string' ? error : error.message ?? 'Unknown error';
  self.postMessage({
    type: 'OCR_ERROR',
    error: msg,
  });
};
