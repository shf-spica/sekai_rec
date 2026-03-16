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
 * 数字行の配列を 5 つの連続区間に分割するインデックスを列挙する（0 < s1 < s2 < s3 < s4 < K）
 * 各区間の文字列を連結して1整数にし、5数の順序は PERFECT, GREAT, GOOD, BAD, MISS に対応
 */
function* partitionIntoFive(K) {
    if (K < 5) return;
    for (let s1 = 1; s1 <= K - 4; s1++) {
        for (let s2 = s1 + 1; s2 <= K - 3; s2++) {
            for (let s3 = s2 + 1; s3 <= K - 2; s3++) {
                for (let s4 = s3 + 1; s4 <= K - 1; s4++) {
                    yield [s1, s2, s3, s4];
                }
            }
        }
    }
}

/**
 * 数字行の文字列配列を、与えた分割 [s1,s2,s3,s4] で5区間にし、各区間を連結して整数化して返す
 */
function mergePartition(texts, s1, s2, s3, s4) {
    const g0 = texts.slice(0, s1).join('');
    const g1 = texts.slice(s1, s2).join('');
    const g2 = texts.slice(s2, s3).join('');
    const g3 = texts.slice(s3, s4).join('');
    const g4 = texts.slice(s4).join('');
    const n0 = parseInt(g0, 10);
    const n1 = parseInt(g1, 10);
    const n2 = parseInt(g2, 10);
    const n3 = parseInt(g3, 10);
    const n4 = parseInt(g4, 10);
    if (Number.isNaN(n0) || Number.isNaN(n1) || Number.isNaN(n2) || Number.isNaN(n3) || Number.isNaN(n4)) return null;
    if (n0 < 0 || n1 < 0 || n2 < 0 || n3 < 0 || n4 < 0) return null;
    if (n0 > 9999 || n1 > 9999 || n2 > 9999 || n3 > 9999 || n4 > 9999) return null;
    return [n0, n1, n2, n3, n4];
}

/**
 * 数字行から、総和が totalNoteCount と一致する5数（PERFECT,GREAT,GOOD,BAD,MISS）の組み合わせを探す
 * @param {Array<{text}>} numberLines - 読み順ソート済みの数字行
 * @param {number} totalNoteCount - 楽曲の総ノーツ数
 * @returns {{ judgments: Object, sumError: boolean }} 見つかれば sumError: false、なければ sumError: true でベストエフォート
 */
function findJudgmentsBySum(numberLines, totalNoteCount) {
    const texts = numberLines.map(l => l.text.trim());
    const K = texts.length;
    const keys = ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'];

    if (K < 5) {
        const judgments = Object.fromEntries(keys.map(k => [k, '不明']));
        return { judgments, sumError: true };
    }

    for (const [s1, s2, s3, s4] of partitionIntoFive(K)) {
        const five = mergePartition(texts, s1, s2, s3, s4);
        if (!five) continue;
        const sum = five[0] + five[1] + five[2] + five[3] + five[4];
        if (sum === totalNoteCount) {
            const judgments = Object.fromEntries(keys.map((k, i) => [k, five[i]]));
            return { judgments, sumError: false };
        }
    }

    // 一致する分割がなければエラー（数字または難易度の認識ミス）。ベストエフォートは出さず不明扱い
    const judgments = Object.fromEntries(keys.map(k => [k, '不明']));
    return { judgments, sumError: true };
}

/**
 * totalNoteCount なし時用：隣接する「1桁」と「複数桁」を1つにマージしてから Y 位置でキーワードに割り当てる
 */
function mergeNumberLinesFallback(numberLines) {
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
        let merged = aNum;
        let usedJ = -1;
        for (let j = i + 1; j < numberLines.length; j++) {
            if (used.has(j)) continue;
            const b = numberLines[j];
            const bVal = b.text.trim();
            const bY = b.y ?? 0;
            if (Math.abs((bY ?? 0) - aY) > 70) break;
            const a1 = aVal.length === 1;
            const b1 = bVal.length === 1;
            if (a1 !== b1) {
                const single = a1 ? aVal : bVal;
                const multi = a1 ? bVal : aVal;
                const combined = parseInt(single + multi, 10);
                if (!Number.isNaN(combined) && combined <= 9999 && combined >= 0) {
                    merged = combined;
                    usedJ = j;
                }
                break;
            }
        }
        if (usedJ >= 0) used.add(i), used.add(usedJ);
        result.push({ ...a, mergedValue: merged });
    }
    return result;
}

/**
 * OCRのテキスト行からプロセカの判定数（PERFECT, GREAT, GOOD, BAD, MISS）を抽出する
 * totalNoteCount がある場合：数字行を5区間に分割し総和が totalNoteCount と一致する組み合わせのみ採用。一致しなければエラー（不明）。
 * totalNoteCount がない場合：キーワード＋Y位置で割り当て（従来ロジック）。
 * @returns {{ judgments: Object, sumError: boolean }}
 */
function extractJudgments(lines, totalNoteCount) {
    const keys = ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'];
    const numberLines = lines
        .filter(l => /^[0-9]{1,4}$/.test(l.text.trim()))
        .sort((a, b) => (a.readingOrder != null ? a.readingOrder - b.readingOrder : (a.y || 0) - (b.y || 0)));

    if (totalNoteCount != null && numberLines.length >= 5) {
        return findJudgmentsBySum(numberLines, totalNoteCount);
    }

    const judgments = { PERFECT: null, GREAT: null, GOOD: null, BAD: null, MISS: null };
    const fullText = lines.map(l => l.text).join('\n').toUpperCase();

    for (const key of keys) {
        const regex = new RegExp(`${key}\\s*[\\:：\\-]?\\s*([0-9]{1,4})`, 'i');
        const match = fullText.match(regex);
        if (match && match[1]) judgments[key] = parseInt(match[1], 10);
    }

    if (Object.values(judgments).every(v => v !== null)) {
        return { judgments: filterValidJudgments(judgments), sumError: false };
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

    const merged = mergeNumberLinesFallback(numberLines);
    merged.sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    if (keysFound.length > 0 && merged.length >= keysFound.length) {
        for (const kf of keysFound) {
            if (judgments[kf.key] === null) {
                let closest = null;
                let minDiff = Infinity;
                for (const numLine of merged) {
                    const d = Math.abs((numLine.y ?? 0) - kf.y);
                    if (d < minDiff) minDiff = d, closest = numLine;
                }
                if (closest && minDiff < 80) judgments[kf.key] = closest.mergedValue;
            }
        }
    }

    return { judgments: filterValidJudgments(judgments), sumError: false };
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
    const { judgments, sumError: judgmentsSumError } = extractJudgments(parsed.lines, totalNoteCount ?? undefined);

    return {
        rawText: parsed.text,
        songTitle: matchedSong.title,
        songId: matchedSong.id,
        matchConfidence: matchedSong.score.toFixed(2),
        difficulty: difficulty ? difficulty.toUpperCase() : null,
        judgments,
        judgmentsSumError: judgmentsSumError || false,
    };
}
