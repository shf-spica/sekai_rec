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

// 難易度キーワード（この直前までを曲名候補とする）
const DIFFICULTY_KEYWORDS = ['APPEND', 'MASTER', 'EXPERT', 'HARD', 'NORMAL', 'EASY'];
// 楽曲名に含まれがちな不要な文字列（マッチング時除去）
const NOISE_WORDS = ['MASTER', 'EXPERT', 'HARD', 'NORMAL', 'EASY', 'CLEAR', 'FULL COMBO', 'ALL PERFECT', 'SCORE', 'APPEND'];

/**
 * OCR特有の視覚的な誤認識のみ正規化（字形の取り違え）。フユ→フュは行わない。
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

/** 小さい文字を含むカタカナの等价パターン（マッチング用）。比較時に両者を同一視するため、拗音を「大+小」の2文字形に揃える */
const SMALL_CHAR_MATCH_PAIRS = [
    ['フュ', 'フユ'], ['ジェ', 'ジエ'], ['ティ', 'テイ'], ['ディ', 'デイ'],
    ['ウィ', 'ウイ'], ['ウェ', 'ウエ'], ['ウォ', 'ウオ'], ['ヴァ', 'ウア'], ['ヴィ', 'ウイ'], ['ヴェ', 'ウエ'], ['ヴォ', 'ウオ'],
    ['キャ', 'キヤ'], ['キュ', 'キユ'], ['キョ', 'キヨ'], ['シャ', 'シヤ'], ['シュ', 'シユ'], ['ショ', 'シヨ'],
    ['チャ', 'チヤ'], ['チュ', 'チユ'], ['チョ', 'チヨ'], ['ニャ', 'ニヤ'], ['ニュ', 'ニユ'], ['ニョ', 'ニヨ'],
    ['ヒャ', 'ヒヤ'], ['ヒュ', 'ヒユ'], ['ヒョ', 'ヒヨ'], ['ミャ', 'ミヤ'], ['ミュ', 'ミユ'], ['ミョ', 'ミヨ'],
    ['リャ', 'リヤ'], ['リュ', 'リユ'], ['リョ', 'リヨ'], ['ギャ', 'ギヤ'], ['ギュ', 'ギユ'], ['ギョ', 'ギヨ'],
    ['ジャ', 'ジヤ'], ['ジュ', 'ジユ'], ['ジョ', 'ジヨ'], ['ビャ', 'ビヤ'], ['ビュ', 'ビユ'], ['ビョ', 'ビヨ'],
    ['ピャ', 'ピヤ'], ['ピュ', 'ピユ'], ['ピョ', 'ピヨ'],
];
/** マッチング時にのみ使用。拗音などを「2文字形」に正規化して比較する（フュ→フユ、ジェ→ジエ など） */
function toMatchForm(s) {
    let t = s;
    for (const [smallForm, twoCharForm] of SMALL_CHAR_MATCH_PAIRS) {
        t = t.split(smallForm).join(twoCharForm);
    }
    return t;
}

/**
 * 難易度キーワードの手前までを曲名ブロックとして抽出（1行目が「Ｒ」などノイズの場合はスキップ）
 */
function getTitleBlockLines(lines) {
    const result = [];
    for (const line of lines) {
        const t = line.text.trim().toUpperCase();
        if (DIFFICULTY_KEYWORDS.some(kw => t === kw || t.startsWith(kw))) {
            break;
        }
        if (/^[0-9]+$/.test(line.text.trim())) continue; // 数字のみはスキップ
        if (/^[Ａ-ＺA-Z]$/.test(t) || t === 'Ｒ' || t === 'R') continue; // 1文字ノイズ
        result.push(line);
    }
    return result;
}

/**
 * 曲名ブロック行から、単行・複数行結合の候補文字列を生成
 */
function buildTitleCandidates(titleBlockLines) {
    const candidates = [];
    for (let i = 0; i < titleBlockLines.length; i++) {
        const single = titleBlockLines[i].text.trim();
        if (single.length >= 2) candidates.push({ text: single, combined: [titleBlockLines[i]] });
        if (i + 1 < titleBlockLines.length) {
            const two = (single + titleBlockLines[i + 1].text.trim()).replace(/\s+/g, ' ').trim();
            if (two.length >= 2) candidates.push({ text: two, combined: [titleBlockLines[i], titleBlockLines[i + 1]] });
        }
        if (i + 2 < titleBlockLines.length) {
            const three = (single + titleBlockLines[i + 1].text.trim() + titleBlockLines[i + 2].text.trim()).replace(/\s+/g, ' ').trim();
            if (three.length >= 2) candidates.push({ text: three, combined: [titleBlockLines[i], titleBlockLines[i + 1], titleBlockLines[i + 2]] });
        }
    }
    return candidates;
}

/**
 * OCRテキスト行から最も似ている楽曲を検索（曲名ブロックのみ・複数行対応・短い部分一致を抑制）。
 * songDatabase: { songs: Array<{ id, title, difficulties }> } または 従来の string[]。
 * 返却: { title, id, score, matchedText }（id は DB にない場合は null）
 */
function findBestSongMatch(lines, songDatabase) {
    const songList = Array.isArray(songDatabase) ? songDatabase.map(t => (typeof t === 'string' ? { id: null, title: t } : { id: t.id, title: t.title }))
        : (songDatabase.songs || []).map(s => ({ id: s.id, title: s.title }));
    let bestMatch = { title: "不明", id: null, score: 0, matchedText: "" };

    const titleBlockLines = getTitleBlockLines(lines);
    const candidates = buildTitleCandidates(titleBlockLines);

    for (const { text: rawCandidate, combined } of candidates) {
        let clean = rawCandidate;
        NOISE_WORDS.forEach(w => {
            clean = clean.replace(new RegExp(w, 'gi'), '');
        });
        clean = normalizeOcrText(clean);
        clean = clean.replace(/[\s\.．。・,\-_~〜=＝+＋]/g, '');
        const lineClean = clean.toLowerCase();
        const lineMatch = toMatchForm(lineClean);
        if (lineMatch.length < 2) continue;

        for (const { id, title: songTitle } of songList) {
            if (!songTitle) continue;

            const targetClean = songTitle.toLowerCase().replace(/[\s\.．。・,\-_~〜=＝+＋]/g, '');
            const targetMatch = toMatchForm(targetClean);

            // 短い曲名での部分一致を禁止
            const minLengthForInclude = 5;
            if (lineMatch.includes(targetMatch) && targetMatch.length >= minLengthForInclude) {
                return { title: songTitle, id, score: 1.0, matchedText: combined.map(l => l.text).join(' ') };
            }

            const dice = diceCoefficient(lineMatch, targetMatch);
            let lev = similarity(lineMatch, targetMatch);
            if (lineMatch.length >= 3 && targetMatch.length >= lineMatch.length) {
                lev = Math.max(lev, similarity(lineMatch, targetMatch.substring(0, lineMatch.length)) * 0.9);
            }

            let sim = (dice * 0.6) + (lev * 0.4);
            const lenRatio = Math.min(lineMatch.length, targetMatch.length) / Math.max(lineMatch.length, targetMatch.length);
            if (lenRatio < 0.5) sim *= lenRatio * 2;

            if (sim > bestMatch.score) {
                bestMatch = { title: songTitle, id, score: sim, matchedText: combined.map(l => l.text).join(' ') };
            }
        }
    }

    if (bestMatch.score < 0.25) {
        return { title: "不明", id: null, score: bestMatch.score, matchedText: bestMatch.matchedText };
    }

    return bestMatch;
}

// ========================================
// Judgment Extraction
// ========================================

/**
 * 隣接する数字行を1つにマージした場合の値を試す（例: "135"+"8"→1358, "8"+"135"→8135）。
 * 候補を返す: [ mergedValue, 使用したインデックスの配列 ]。マージしない場合は [aNum, [i]]
 */
function tryMergeTwo(aVal, bVal, aY, bY, yGapMax) {
    if (Math.abs((bY ?? 0) - (aY ?? 0)) > (yGapMax ?? 70)) return null;
    const combinedForward = parseInt(aVal + bVal, 10);
    const combinedBackward = parseInt(bVal + aVal, 10);
    if (!Number.isNaN(combinedForward) && combinedForward <= 9999 && combinedForward >= 0) {
        if (!Number.isNaN(combinedBackward) && combinedBackward <= 9999 && combinedBackward >= 0) {
            return [combinedForward, combinedBackward];
        }
        return [combinedForward];
    }
    if (!Number.isNaN(combinedBackward) && combinedBackward <= 9999 && combinedBackward >= 0) {
        return [combinedBackward];
    }
    return null;
}

/**
 * 改行で分割された数字行をマージする。
 * 隣接2行を「前+後」「後+前」の両方でマージ候補を試し、totalNoteCount が与えられていれば
 * その値に一致する候補を優先する（PERFECT が totalNoteCount に近い／または5数の和が totalNoteCount に一致）。
 * 例: "358"+"1"→1358, "135"+"8"→1358, "1"+"358"→1358
 */
function mergeSplitNumberLines(numberLines, totalNoteCount) {
    if (numberLines.length === 0) return numberLines;
    const used = new Set();
    const result = [];

    for (let i = 0; i < numberLines.length; i++) {
        if (used.has(i)) continue;
        const a = numberLines[i];
        const aVal = a.text.trim();
        const aNum = parseInt(aVal, 10);
        const aY = a.y ?? 0;
        const aOrder = a.readingOrder ?? i;

        let bestMerged = aNum;
        let bestUsedJ = -1;
        let bestScore = -1; // totalNoteCount との一致度

        for (let j = i + 1; j < numberLines.length; j++) {
            if (used.has(j)) continue;
            const b = numberLines[j];
            const bVal = b.text.trim();
            const bY = b.y ?? 0;
            const tries = tryMergeTwo(aVal, bVal, aY, bY, 70);
            if (!tries) continue;
            for (const merged of tries) {
                let score = 0;
                if (totalNoteCount != null) {
                    if (merged === totalNoteCount) score = 10; // PERFECT が総ノーツ数と一致
                    else if (Math.abs(merged - totalNoteCount) < 100) score = 5;
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestMerged = merged;
                    bestUsedJ = j;
                } else if (bestUsedJ < 0 && score >= 0) {
                    bestMerged = merged;
                    bestUsedJ = j;
                }
            }
            break; // 隣接1ペアのみマージ（連続3行以上は次のループで）
        }

        if (bestUsedJ >= 0) {
            used.add(i);
            used.add(bestUsedJ);
            result.push({ text: String(bestMerged), y: aY, readingOrder: aOrder, mergedValue: bestMerged });
        } else {
            result.push({ ...a, mergedValue: aNum });
        }
    }

    return result;
}

/**
 * OCRのテキスト行からプロセカの判定数（PERFECT, GREAT, GOOD, BAD, MISS）を抽出する
 * @param {Array} lines - テキスト行
 * @param {number|null} totalNoteCount - 楽曲の総ノーツ数（あれば数字マージの優先に利用）
 */
function extractJudgments(lines, totalNoteCount) {
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

    let numberLines = lines
        .filter(l => /^[0-9]{1,4}$/.test(l.text.trim()))
        .sort((a, b) => (a.readingOrder != null ? a.readingOrder - b.readingOrder : (a.y || 0) - (b.y || 0)));

    // 改行で分割された数字をマージ（totalNoteCount があればそれを手がかりに採用候補を選択）
    numberLines = mergeSplitNumberLines(numberLines, totalNoteCount);
    numberLines.sort((a, b) => (a.y ?? 0) - (b.y ?? 0));

    if (keysFound.length > 0 && numberLines.length >= keysFound.length) {
        for (const kf of keysFound) {
            if (judgments[kf.key] === null) {
                let closestNum = null;
                let minDiff = Infinity;
                for (const numLine of numberLines) {
                    const diff = Math.abs((numLine.y ?? 0) - kf.y);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestNum = numLine;
                    }
                }
                if (closestNum && minDiff < 80) {
                    judgments[kf.key] = closestNum.mergedValue;
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

/** OCR行から難易度キーワードを検出し、musicDifficulty のキー（小文字）を返す */
function getDifficultyFromLines(lines) {
    const full = lines.map(l => l.text.toUpperCase()).join('\n');
    if (/\bAPPEND\b/.test(full)) return 'append';
    if (/\bMASTER\b/.test(full)) return 'master';
    if (/\bEXPERT\b/.test(full)) return 'expert';
    if (/\bHARD\b/.test(full)) return 'hard';
    if (/\bNORMAL\b/.test(full)) return 'normal';
    if (/\bEASY\b/.test(full)) return 'easy';
    return null;
}

/** songDatabase から songId と difficulty で totalNoteCount を取得 */
function getTotalNoteCount(songDatabase, songId, difficulty) {
    if (!songDatabase?.songs || songId == null || !difficulty) return null;
    const song = songDatabase.songs.find(s => s.id === songId);
    if (!song?.difficulties) return null;
    return song.difficulties[difficulty] ?? song.difficulties[difficulty.toLowerCase()] ?? null;
}

/**
 * ndlocr-liteの結果をパースして構造化データを返す
 * @param {Object} ocrResult - OCR結果 { textBlocks, fullText, processingTime }
 * @param {Object|Array} songDatabase - { songs: [{ id, title, difficulties }] } または 従来の string[]
 */
export function parseGameResult(ocrResult, songDatabase) {
    const parsed = parseNdlocrOutput(ocrResult);

    const matchedSong = findBestSongMatch(parsed.lines, songDatabase);
    const difficulty = getDifficultyFromLines(parsed.lines);
    const totalNoteCount = getTotalNoteCount(songDatabase, matchedSong.id, difficulty);
    const judgments = extractJudgments(parsed.lines, totalNoteCount ?? undefined);

    return {
        rawText: parsed.text,
        songTitle: matchedSong.title,
        songId: matchedSong.id,
        matchConfidence: matchedSong.score.toFixed(2),
        judgments: judgments,
    };
}
