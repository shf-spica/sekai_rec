/**
 * OCR Post-processing for Project Sekai
 * ndlocr-liteのOCR結果から、プロセカの楽曲名と判定数を抽出する
 */

// ========================================
// Fuzzy Matching (Levenshtein Distance)
// ========================================

function levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

function similarity(s1, s2) {
    let longer = s1;
    let shorter = s2;
    if (s1.length < s2.length) {
        longer = s2;
        shorter = s1;
    }
    const longerLength = longer.length;
    if (longerLength === 0) {
        return 1.0;
    }
    return (longerLength - levenshteinDistance(longer, shorter)) / parseFloat(longerLength);
}

function diceCoefficient(s1, s2) {
    if (s1 === s2) return 1.0;
    if (s1.length < 2 || s2.length < 2) return similarity(s1, s2);

    const bigrams1 = new Map();
    for (let i = 0; i < s1.length - 1; i++) {
        const bigram = s1.slice(i, i + 2);
        bigrams1.set(bigram, (bigrams1.get(bigram) || 0) + 1);
    }

    let intersection = 0;
    for (let i = 0; i < s2.length - 1; i++) {
        const bigram = s2.slice(i, i + 2);
        if (bigrams1.has(bigram) && bigrams1.get(bigram) > 0) {
            bigrams1.set(bigram, bigrams1.get(bigram) - 1);
            intersection++;
        }
    }

    return (2.0 * intersection) / (s1.length - 1 + s2.length - 1);
}

// 楽曲名に含まれがちな不要な文字列（難易度など）
const NOISE_WORDS = ['MASTER', 'EXPERT', 'HARD', 'NORMAL', 'EASY', 'CLEAR', 'FULL COMBO', 'ALL PERFECT', 'SCORE'];

/**
 * OCR特有の視覚的な誤認識パターンを正規化する
 */
function normalizeOcrText(text) {
    let t = text;
    t = t.replace(/口/g, 'ク');
    t = t.replace(/一/g, 'ー');
    t = t.replace(/－/g, 'ー');
    t = t.replace(/-/g, 'ー');
    t = t.replace(/作/g, 'バ');
    t = t.replace(/S/g, 'ー');
    t = t.replace(/0/g, 'O');
    return t;
}

/**
 * OCRテキスト行から最も似ている楽曲名を検索
 */
function findBestSongMatch(lines, songList) {
    let bestMatch = { title: "不明", score: 0, matchedText: "" };

    const cleanLines = lines.map(line => {
        let clean = line.text.trim();
        NOISE_WORDS.forEach(w => {
            clean = clean.replace(new RegExp(w, 'gi'), '');
        });
        clean = normalizeOcrText(clean);
        clean = clean.replace(/[\s\.．。・,\-_~〜=＝+＋]/g, '');
        return { text: line.text, clean: clean.toLowerCase() };
    }).filter(l => l.clean.length >= 2);

    for (const lineObj of cleanLines) {
        const lineClean = lineObj.clean;
        if (/^[0-9]+$/.test(lineClean)) continue;

        for (const songTitle of songList) {
            if (!songTitle) continue;

            const targetClean = songTitle.toLowerCase().replace(/[\s\.．。・,\-_~〜=＝+＋]/g, '');

            if (lineClean.includes(targetClean) && targetClean.length >= 2) {
                return { title: songTitle, score: 1.0, matchedText: lineObj.text };
            }

            const dice = diceCoefficient(lineClean, targetClean);
            let lev = similarity(lineClean, targetClean);
            if (lineClean.length >= 3 && targetClean.length >= lineClean.length) {
                lev = Math.max(lev, similarity(lineClean, targetClean.substring(0, lineClean.length)) * 0.9);
            }

            const sim = (dice * 0.6) + (lev * 0.4);
            if (sim > bestMatch.score) {
                bestMatch = { title: songTitle, score: sim, matchedText: lineObj.text };
            }
        }
    }

    if (bestMatch.score < 0.25) {
        return { title: "不明", score: bestMatch.score, matchedText: bestMatch.matchedText };
    }

    return bestMatch;
}

// ========================================
// Judgment Extraction
// ========================================

/**
 * OCRのテキスト行からプロセカの判定数（PERFECT, GREAT, GOOD, BAD, MISS）を抽出する
 */
function extractJudgments(lines) {
    const judgments = {
        PERFECT: null,
        GREAT: null,
        GOOD: null,
        BAD: null,
        MISS: null
    };

    const fullText = lines.map(l => l.text).join('\n').toUpperCase();

    // パターン1: 「PERFECT 1234」のように同じ行に含まれている場合
    for (const key of Object.keys(judgments)) {
        const regex = new RegExp(`${key}\\s*[\\:：\\-]?\\s*([0-9]{1,4})`, 'i');
        const match = fullText.match(regex);
        if (match && match[1]) {
            judgments[key] = parseInt(match[1], 10);
        }
    }

    if (Object.values(judgments).every(v => v !== null)) {
        return filterValidJudgments(judgments);
    }

    // パターン2: キーワードと数字の位置ベースマッチング
    const judgmentKeywords = {
        'PERFECT': ['PERFECT', 'PEREFCT', 'PERFT'],
        'GREAT': ['GREAT', 'GRET', 'GREA'],
        'GOOD': ['GOOD', 'GO0D', 'COON', 'GOO'],
        'BAD': ['BAD', '8AD', 'BA0'],
        'MISS': ['MISS', 'M1SS']
    };

    const keysFound = [];

    for (const line of lines) {
        const text = line.text.toUpperCase();
        let bestKey = null;
        let bestSim = 0;

        for (const [key, aliases] of Object.entries(judgmentKeywords)) {
            if (aliases.some(a => text.includes(a))) {
                bestKey = key;
                bestSim = 1.0;
                break;
            }
            const words = text.split(/[^A-Z]/).filter(w => w.length >= 3);
            for (const word of words) {
                const sim = similarity(word, key);
                if (sim > bestSim && sim > 0.6) {
                    bestSim = sim;
                    bestKey = key;
                }
            }
        }

        if (bestKey) {
            const existingIdx = keysFound.findIndex(k => k.key === bestKey);
            if (existingIdx === -1) {
                keysFound.push({ key: bestKey, y: line.y || 0, sim: bestSim });
            } else if (bestSim > keysFound[existingIdx].sim) {
                keysFound[existingIdx] = { key: bestKey, y: line.y || 0, sim: bestSim };
            }
        }
    }

    const numberLines = lines
        .filter(l => /^[0-9]{1,4}$/.test(l.text.trim()))
        .sort((a, b) => (a.y || 0) - (b.y || 0));

    if (keysFound.length > 0 && numberLines.length >= keysFound.length) {
        for (const kf of keysFound) {
            if (judgments[kf.key] === null) {
                let closestNum = null;
                let minDiff = Infinity;
                for (const numLine of numberLines) {
                    const diff = Math.abs((numLine.y || 0) - kf.y);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestNum = numLine;
                    }
                }
                if (closestNum && minDiff < 50) {
                    judgments[kf.key] = parseInt(closestNum.text.trim(), 10);
                }
            }
        }
    }

    return filterValidJudgments(judgments);
}

function filterValidJudgments(judgments) {
    Object.keys(judgments).forEach(k => {
        if (judgments[k] === null) {
            judgments[k] = "不明";
        }
    });
    return judgments;
}

// ========================================
// ndlocr-lite Output Parsing
// ========================================

/**
 * ndlocr-liteのOCR結果を行データに変換する
 * @param {Object} ocrResult - ndlocr-lite Worker からの結果 { textBlocks, fullText }
 * @returns {Object} { text: string, lines: Array<{text, x, y, width, height}> }
 */
function parseNdlocrOutput(ocrResult) {
    const lines = [];
    let fullText = ocrResult.fullText || '';

    if (ocrResult.textBlocks && ocrResult.textBlocks.length > 0) {
        for (const block of ocrResult.textBlocks) {
            if (block.text && block.text.trim()) {
                lines.push({
                    text: block.text.trim(),
                    x: block.x || 0,
                    y: block.y || 0,
                    width: block.width || 0,
                    height: block.height || 0,
                    confidence: block.confidence || 0.9,
                    readingOrder: block.readingOrder || 0,
                });
            }
        }
        // 読み順でソート
        lines.sort((a, b) => a.readingOrder - b.readingOrder);

        if (!fullText) {
            fullText = lines.map(l => l.text).join('\n');
        }
    } else if (fullText) {
        // textBlocksがない場合はfullTextを行分割
        const rawLines = fullText.split(/\n/).filter(l => l.trim().length > 0);
        rawLines.forEach((text, idx) => {
            lines.push({
                text: text.trim(),
                x: 0,
                y: idx * 30,
                width: 0,
                height: 30,
                confidence: 0.9,
            });
        });
    }

    return { text: fullText, lines };
}

// ========================================
// Main Post-processing API
// ========================================

/**
 * ndlocr-liteの結果をパースして構造化データを返す
 * @param {Object} ocrResult - ndlocr-lite Worker からの結果 { textBlocks, fullText, processingTime }
 * @param {Array<string>} songList - 曲名ホワイトリストの配列
 */
export function parseGameResult(ocrResult, songList) {
    const parsed = parseNdlocrOutput(ocrResult);

    const matchedSong = findBestSongMatch(parsed.lines, songList);
    const judgments = extractJudgments(parsed.lines);

    return {
        rawText: parsed.text,
        songTitle: matchedSong.title,
        matchConfidence: matchedSong.score.toFixed(2),
        judgments: judgments,
    };
}
