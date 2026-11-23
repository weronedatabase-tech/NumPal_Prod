// ==========================================
// date-parser.js - Offline Expiry Date Parser & Disambiguator
// ==========================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ExpiryDateParser = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = {
    JAN: 1, JANUARY: 1,
    FEB: 2, FEBRUARY: 2,
    MAR: 3, MARCH: 3,
    APR: 4, APRIL: 4,
    MAY: 5,
    JUN: 6, JUNE: 6,
    JUL: 7, JULY: 7,
    AUG: 8, AUGUST: 8,
    SEP: 9, SEPT: 9, SEPTEMBER: 9,
    OCT: 10, OCTOBER: 10,
    NOV: 11, NOVEMBER: 11,
    DEC: 12, DECEMBER: 12
  };

  // Common OCR corruptions of 3-letter English month abbreviations
  const MONTH_OCR_MAP = {
    J4N: 'JAN', IAN: 'JAN', '1AN': 'JAN',
    FE8: 'FEB', FEB: 'FEB', F3B: 'FEB',
    M4R: 'MAR', MAR: 'MAR',
    A9R: 'APR', APR: 'APR', '4PR': 'APR',
    M4Y: 'MAY', MAY: 'MAY',
    JUN: 'JUN', JVN: 'JUN', '1UN': 'JUN',
    JUL: 'JUL', JU1: 'JUL', JUI: 'JUL', '1UL': 'JUL',
    AU6: 'AUG', AUG: 'AUG', '4UG': 'AUG',
    '5EP': 'SEP', SEP: 'SEP', SEPT: 'SEP',
    '0CT': 'OCT', OCT: 'OCT', QCT: 'OCT', DCT: 'OCT',
    N0V: 'NOV', NOV: 'NOV',
    DEC: 'DEC', DE0: 'DEC', D3C: 'DEC', OEC: 'DEC'
  };

  const EXPIRY_KEYWORDS = /\b(EXPIRY|EXPIRE[DS]?|EXP\.?|BEST\s*BEFORE|BEST\s*BY|BBE|BB|USE\s*BY|USE\s*BEFORE|UB|CONSUME\s*BY|SELL\s*BY|VALID\s*(UNTIL|THRU|TO)|GOOD\s*THRU|END)\b|(^|\s)E\s*[:\-]/i;
  const MFG_KEYWORDS = /\b(MFG|MFD|MANUFACTUR\w*|PROD\.?|PRODUCTION|PRO\.?|PKD|PACKED|PACK\s*DATE|DOM|LOT|BATCH|L\/N|B\/N)\b|(^|\s)M\s*[:\-]/i;

  function repairDigits(str) {
    return str
      .replace(/[OoQqDd]/g, '0')
      .replace(/[IiLl|!]/g, '1')
      .replace(/[Zz]/g, '2')
      .replace(/[Ss]/g, '5')
      .replace(/[Gg]/g, '6')
      .replace(/[Bb]/g, '8');
  }

  function normalizeMonthToken(raw) {
    const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (MONTHS[clean]) return MONTHS[clean];
    if (MONTH_OCR_MAP[clean] && MONTHS[MONTH_OCR_MAP[clean]]) {
      return MONTHS[MONTH_OCR_MAP[clean]];
    }
    return null;
  }

  function daysInMonth(year, month1Based) {
    return new Date(year, month1Based, 0).getDate();
  }

  function expandTwoDigitYear(yy, refYear) {
    const n = parseInt(yy, 10);
    if (isNaN(n) || n < 0 || n > 99) return null;
    // Map 00..99 into the nearest reasonable century around refYear
    const century = Math.floor(refYear / 100) * 100;
    let year = century + n;
    if (year < refYear - 30) year += 100;
    if (year > refYear + 50) year -= 100;
    return year;
  }

  function isValidDateParts(year, month, day, refYear) {
    const minYear = refYear - 10;
    const maxYear = refYear + 15;
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
    if (year < minYear || year > maxYear) return false;
    if (month < 1 || month > 12) return false;
    const maxDay = daysInMonth(year, month);
    return day >= 1 && day <= maxDay;
  }

  function buildDate(year, month, day, isMonthOnly) {
    const finalDay = isMonthOnly ? daysInMonth(year, month) : day;
    const d = new Date(year, month - 1, finalDay);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Group OCR boxes that lie on the same horizontal text line
  function mergeSpatialLines(detections) {
    if (!Array.isArray(detections) || detections.length === 0) return [];

    const normalized = detections
      .filter(d => d && typeof d.text === 'string' && d.text.trim().length > 0)
      .map(d => {
        const box = d.box || { x: 0, y: 0, width: 100, height: 20 };
        return {
          text: d.text.trim(),
          confidence: typeof d.confidence === 'number' ? d.confidence : 0.8,
          x: box.x,
          y: box.y,
          width: Math.max(1, box.width),
          height: Math.max(1, box.height),
          cx: box.x + box.width / 2,
          cy: box.y + box.height / 2
        };
      });

    normalized.sort((a, b) => a.cy - b.cy || a.x - b.x);

    const lines = [];
    for (const item of normalized) {
      let matchedLine = null;
      for (const line of lines) {
        const yOverlap = Math.min(item.y + item.height, line.yMax) - Math.max(item.y, line.yMin);
        const minH = Math.min(item.height, line.yMax - line.yMin);
        const cyDist = Math.abs(item.cy - line.cy);
        if ((minH > 0 && yOverlap / minH >= 0.4) || cyDist <= line.avgHeight * 0.65) {
          matchedLine = line;
          break;
        }
      }
      if (matchedLine) {
        matchedLine.items.push(item);
        matchedLine.yMin = Math.min(matchedLine.yMin, item.y);
        matchedLine.yMax = Math.max(matchedLine.yMax, item.y + item.height);
        matchedLine.xMin = Math.min(matchedLine.xMin, item.x);
        matchedLine.xMax = Math.max(matchedLine.xMax, item.x + item.width);
        matchedLine.cy = (matchedLine.yMin + matchedLine.yMax) / 2;
        matchedLine.avgHeight =
          matchedLine.items.reduce((s, it) => s + it.height, 0) / matchedLine.items.length;
      } else {
        lines.push({
          items: [item],
          yMin: item.y,
          yMax: item.y + item.height,
          xMin: item.x,
          xMax: item.x + item.width,
          cy: item.cy,
          avgHeight: item.height
        });
      }
    }

    lines.sort((a, b) => a.cy - b.cy);

    return lines.map(line => {
      line.items.sort((a, b) => a.x - b.x);
      const text = line.items.map(it => it.text).join(' ');
      const confidence =
        line.items.reduce((s, it) => s + it.confidence, 0) / line.items.length;
      return {
        text,
        confidence,
        xMin: line.xMin,
        xMax: line.xMax,
        yMin: line.yMin,
        yMax: line.yMax,
        cy: line.cy,
        avgHeight: line.avgHeight
      };
    });
  }

  function extractDatesFromLine(lineText, refYear) {
    const results = [];
    const upper = lineText.toUpperCase().replace(/\s+/g, ' ').trim();

    function addCandidate(year, month, day, isMonthOnly, matchIndex, matchedText, specificityBonus) {
      const actualDay = isMonthOnly ? daysInMonth(year, month) : day;
      if (!isValidDateParts(year, month, actualDay, refYear)) return;
      results.push({
        year,
        month,
        day: actualDay,
        date: buildDate(year, month, actualDay, isMonthOnly),
        isMonthOnly: !!isMonthOnly,
        matchIndex,
        matchedText: matchedText.trim(),
        specificityBonus
      });
    }

    const monthPattern = '(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:T|TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?|J4N|FE8|F3B|M4R|4PR|M4Y|JU1|JUI|AU6|5EP|0CT|QCT|N0V|DE0|D3C)';

    // 1. DD MMM YYYY or DD MMM YY (with optional separators or compact like 28NOV26)
    const reDMYAlpha = new RegExp(
      `(?<![A-Z0-9])([0-3OoIiLl]?[0-9OoIiLlSsBbZz])\\s*[-./,\\s]?\\s*(${monthPattern})\\s*[-./,\\s]?\\s*([0-9OoIiLlSsBbZz]{2,4})(?![A-Z0-9])`,
      'gi'
    );
    let m;
    while ((m = reDMYAlpha.exec(upper)) !== null) {
      const d = parseInt(repairDigits(m[1]), 10);
      const mo = normalizeMonthToken(m[2]);
      const yRaw = repairDigits(m[3]);
      if (!mo || (yRaw.length !== 2 && yRaw.length !== 4)) continue;
      const y = yRaw.length === 4 ? parseInt(yRaw, 10) : expandTwoDigitYear(yRaw, refYear);
      addCandidate(y, mo, d, false, m.index, m[0], 30);
    }

    // 2. MMM DD YYYY or MMM DD, YY
    const reMDYAlpha = new RegExp(
      `(?<![A-Z0-9])(${monthPattern})\\s*[-./,\\s]+([0-3OoIiLl]?[0-9OoIiLlSsBbZz])(?:ST|ND|RD|TH)?\\s*[-./,\\s]+([0-9OoIiLlSsBbZz]{2,4})(?![A-Z0-9])`,
      'gi'
    );
    while ((m = reMDYAlpha.exec(upper)) !== null) {
      const mo = normalizeMonthToken(m[1]);
      const d = parseInt(repairDigits(m[2]), 10);
      const yRaw = repairDigits(m[3]);
      if (!mo || (yRaw.length !== 2 && yRaw.length !== 4)) continue;
      const y = yRaw.length === 4 ? parseInt(yRaw, 10) : expandTwoDigitYear(yRaw, refYear);
      addCandidate(y, mo, d, false, m.index, m[0], 28);
    }

    // 3. YYYY MMM DD
    const reYMDAlpha = new RegExp(
      `(?<![A-Z0-9])([12][0-9OoIiLlSsBbZz]{3})\\s*[-./,\\s]?\\s*(${monthPattern})\\s*[-./,\\s]?\\s*([0-3OoIiLl]?[0-9OoIiLlSsBbZz])(?![A-Z0-9])`,
      'gi'
    );
    while ((m = reYMDAlpha.exec(upper)) !== null) {
      const y = parseInt(repairDigits(m[1]), 10);
      const mo = normalizeMonthToken(m[2]);
      const d = parseInt(repairDigits(m[3]), 10);
      if (!mo) continue;
      addCandidate(y, mo, d, false, m.index, m[0], 30);
    }

    // 4. YYYY[-./ ]MM[-./ ]DD (4-digit year first)
    const reYMDNum = /(?<![0-9])([12][0-9OoIiLlSsBbZz]{3})\s*[-./]\s*([01OoIiLl]?[0-9OoIiLlSsBbZz])\s*[-./]\s*([0-3OoIiLl]?[0-9OoIiLlSsBbZz])(?![0-9])/g;
    while ((m = reYMDNum.exec(upper)) !== null) {
      const y = parseInt(repairDigits(m[1]), 10);
      const mo = parseInt(repairDigits(m[2]), 10);
      const d = parseInt(repairDigits(m[3]), 10);
      addCandidate(y, mo, d, false, m.index, m[0], 28);
    }

    // 5. DD[-./ ]MM[-./ ]YYYY or DD[-./ ]MM[-./ ]YY (SG/UK DD/MM default; falls back to MM/DD if middle > 12)
    const reDMYNum = /(?<![0-9])([0-3OoIiLl]?[0-9OoIiLlSsBbZz])\s*[-./]\s*([0-3OoIiLl]?[0-9OoIiLlSsBbZz])\s*[-./]\s*([0-9OoIiLlSsBbZz]{2,4})(?![0-9])/g;
    while ((m = reDMYNum.exec(upper)) !== null) {
      const p1Raw = repairDigits(m[1]);
      const p2Raw = repairDigits(m[2]);
      const p3Raw = repairDigits(m[3]);
      if (p3Raw.length !== 2 && p3Raw.length !== 4) continue;
      const p1 = parseInt(p1Raw, 10);
      const p2 = parseInt(p2Raw, 10);
      const y = p3Raw.length === 4 ? parseInt(p3Raw, 10) : expandTwoDigitYear(p3Raw, refYear);

      if (isValidDateParts(y, p2, p1, refYear)) {
        // Standard DD/MM/YY(YY)
        addCandidate(y, p2, p1, false, m.index, m[0], p3Raw.length === 4 ? 26 : 22);
      } else if (isValidDateParts(y, p1, p2, refYear)) {
        // US MM/DD/YY(YY) fallback when second number > 12
        addCandidate(y, p1, p2, false, m.index, m[0], p3Raw.length === 4 ? 24 : 20);
      } else if (p3Raw.length === 2) {
        // Asian YY.MM.DD fallback (e.g. 26.11.28 where first number wasn't valid day or > 31)
        const yAlt = expandTwoDigitYear(p1Raw, refYear);
        const dAlt = parseInt(p3Raw, 10);
        if (isValidDateParts(yAlt, p2, dAlt, refYear)) {
          addCandidate(yAlt, p2, dAlt, false, m.index, m[0], 18);
        }
      }
    }

    // 6. Space-separated full numeric dates: "28 11 2026" or "2026 11 28" or "28 11 26"
    const reSpaceNum = /(?<![0-9])([0-9OoIiLlSsBbZz]{2,4})\s+([0-3OoIiLl]?[0-9OoIiLlSsBbZz])\s+([0-9OoIiLlSsBbZz]{2,4})(?![0-9])/g;
    while ((m = reSpaceNum.exec(upper)) !== null) {
      const a = repairDigits(m[1]);
      const b = repairDigits(m[2]);
      const c = repairDigits(m[3]);
      if (a.length === 4 && c.length <= 2) {
        addCandidate(parseInt(a, 10), parseInt(b, 10), parseInt(c, 10), false, m.index, m[0], 20);
      } else if (a.length <= 2 && (c.length === 4 || c.length === 2)) {
        const y = c.length === 4 ? parseInt(c, 10) : expandTwoDigitYear(c, refYear);
        const p1 = parseInt(a, 10);
        const p2 = parseInt(b, 10);
        if (isValidDateParts(y, p2, p1, refYear)) {
          addCandidate(y, p2, p1, false, m.index, m[0], c.length === 4 ? 20 : 16);
        } else if (isValidDateParts(y, p1, p2, refYear)) {
          addCandidate(y, p1, p2, false, m.index, m[0], 15);
        }
      }
    }

    // Only check month-only and compact formats if no full-date match overlaps the same index range
    const hasFullMatchAt = (idx, len) =>
      results.some(r => !r.isMonthOnly && idx >= r.matchIndex - 2 && idx <= r.matchIndex + r.matchedText.length);

    // 7. Month + Year (Alpha): "NOV 2026", "NOV26", "MAR-2027"
    const reMYAlpha = new RegExp(
      `(?<![A-Z0-9])(${monthPattern})\\s*[-./,\\s]?\\s*([0-9OoIiLlSsBbZz]{2,4})(?![A-Z0-9])`,
      'gi'
    );
    while ((m = reMYAlpha.exec(upper)) !== null) {
      if (hasFullMatchAt(m.index, m[0].length)) continue;
      const mo = normalizeMonthToken(m[1]);
      const yRaw = repairDigits(m[2]);
      if (!mo || (yRaw.length !== 2 && yRaw.length !== 4)) continue;
      const y = yRaw.length === 4 ? parseInt(yRaw, 10) : expandTwoDigitYear(yRaw, refYear);
      addCandidate(y, mo, 1, true, m.index, m[0], 14);
    }

    // 8. Month + Year (Numeric): "05/2027", "11-26", "2027.05"
    const reMYNum = /(?<![0-9\-./])([0-9OoIiLlSsBbZz]{2,4})\s*[-./]\s*([0-9OoIiLlSsBbZz]{2,4})(?![0-9\-./])/g;
    while ((m = reMYNum.exec(upper)) !== null) {
      if (hasFullMatchAt(m.index, m[0].length)) continue;
      const a = repairDigits(m[1]);
      const b = repairDigits(m[2]);
      if (a.length === 2 && b.length === 4) {
        addCandidate(parseInt(b, 10), parseInt(a, 10), 1, true, m.index, m[0], 14);
      } else if (a.length === 4 && b.length === 2) {
        addCandidate(parseInt(a, 10), parseInt(b, 10), 1, true, m.index, m[0], 14);
      } else if (a.length === 2 && b.length === 2) {
        const mo = parseInt(a, 10);
        const y = expandTwoDigitYear(b, refYear);
        if (mo >= 1 && mo <= 12) {
          addCandidate(y, mo, 1, true, m.index, m[0], 10);
        }
      }
    }

    // 9. Compact 8-digit dates: YYYYMMDD or DDMMYYYY (strictly standalone, never part of longer barcodes)
    const reCompact8 = /(?<![0-9])([0-9]{8})(?![0-9])/g;
    while ((m = reCompact8.exec(upper)) !== null) {
      if (hasFullMatchAt(m.index, 8)) continue;
      const s = m[1];
      const yFirst = parseInt(s.slice(0, 4), 10);
      const mFirst = parseInt(s.slice(4, 6), 10);
      const dFirst = parseInt(s.slice(6, 8), 10);
      if (isValidDateParts(yFirst, mFirst, dFirst, refYear)) {
        addCandidate(yFirst, mFirst, dFirst, false, m.index, s, 16);
        continue;
      }
      const dLast = parseInt(s.slice(0, 2), 10);
      const mLast = parseInt(s.slice(2, 4), 10);
      const yLast = parseInt(s.slice(4, 8), 10);
      if (isValidDateParts(yLast, mLast, dLast, refYear)) {
        addCandidate(yLast, mLast, dLast, false, m.index, s, 15);
      }
    }

    // 10. Compact 6-digit dates: DDMMYY or YYMMDD (only if reasonable year & no other match)
    const reCompact6 = /(?<![0-9])([0-9]{6})(?![0-9])/g;
    while ((m = reCompact6.exec(upper)) !== null) {
      if (hasFullMatchAt(m.index, 6)) continue;
      const s = m[1];
      const d1 = parseInt(s.slice(0, 2), 10);
      const mo1 = parseInt(s.slice(2, 4), 10);
      const y1 = expandTwoDigitYear(s.slice(4, 6), refYear);
      if (isValidDateParts(y1, mo1, d1, refYear)) {
        addCandidate(y1, mo1, d1, false, m.index, s, 8);
        continue;
      }
      const y2 = expandTwoDigitYear(s.slice(0, 2), refYear);
      const mo2 = parseInt(s.slice(2, 4), 10);
      const d2 = parseInt(s.slice(4, 6), 10);
      if (isValidDateParts(y2, mo2, d2, refYear)) {
        addCandidate(y2, mo2, d2, false, m.index, s, 7);
      }
    }

    return results;
  }

  function scoreContext(lineText, matchIndex, aboveLineText) {
    const prefix = lineText.slice(Math.max(0, matchIndex - 24), matchIndex);
    const fullContext = prefix + ' ' + (aboveLineText || '');

    let score = 0;
    let role = 'unknown';

    // Check closest keyword in prefix first (handles "MFG 01/01/25 EXP 01/01/27" on one line!)
    const expMatches = [...prefix.matchAll(new RegExp(EXPIRY_KEYWORDS.source, 'gi'))];
    const mfgMatches = [...prefix.matchAll(new RegExp(MFG_KEYWORDS.source, 'gi'))];

    const lastExpIdx = expMatches.length ? expMatches[expMatches.length - 1].index : -1;
    const lastMfgIdx = mfgMatches.length ? mfgMatches[mfgMatches.length - 1].index : -1;

    if (lastExpIdx > lastMfgIdx) {
      score += 50;
      role = 'expiry';
    } else if (lastMfgIdx > lastExpIdx) {
      score -= 60;
      role = 'mfg';
    } else if (aboveLineText) {
      // Check label directly above this line
      if (EXPIRY_KEYWORDS.test(aboveLineText) && !MFG_KEYWORDS.test(aboveLineText)) {
        score += 35;
        role = 'expiry';
      } else if (MFG_KEYWORDS.test(aboveLineText) && !EXPIRY_KEYWORDS.test(aboveLineText)) {
        score -= 45;
        role = 'mfg';
      } else if (EXPIRY_KEYWORDS.test(fullContext)) {
        score += 20;
        role = 'expiry';
      }
    }

    return { score, role };
  }

  function parse(detections, todayDate) {
    const today = todayDate ? new Date(todayDate) : new Date();
    today.setHours(0, 0, 0, 0);
    const refYear = today.getFullYear();

    const lines = mergeSpatialLines(detections);
    const rawText = lines.map(l => l.text).join('\n');

    if (lines.length === 0) {
      return { foundDate: false, rawText: '', reason: 'no_text' };
    }

    const candidates = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Find nearest line directly above (within 2.5x line height) for label association
      let aboveText = '';
      if (i > 0) {
        const prev = lines[i - 1];
        const vGap = line.yMin - prev.yMax;
        if (vGap >= -prev.avgHeight * 0.5 && vGap <= line.avgHeight * 2.5) {
          aboveText = prev.text;
        }
      }

      const found = extractDatesFromLine(line.text, refYear);
      for (const item of found) {
        const ctx = scoreContext(line.text, item.matchIndex, aboveText);
        const totalScore =
          ctx.score +
          item.specificityBonus +
          Math.round((line.confidence || 0.7) * 15);

        candidates.push({
          ...item,
          role: ctx.role,
          confidence: line.confidence,
          score: totalScore,
          lineText: line.text
        });
      }
    }

    // Deduplicate identical YYYY-MM-DD dates keeping the highest score
    const dedupMap = new Map();
    for (const c of candidates) {
      const key = `${c.year}-${c.month}-${c.day}`;
      const existing = dedupMap.get(key);
      if (!existing || c.score > existing.score) {
        dedupMap.set(key, c);
      }
    }
    const uniqueCandidates = Array.from(dedupMap.values());

    if (uniqueCandidates.length === 0) {
      return { foundDate: false, rawText, reason: 'no_valid_date' };
    }

    // Filter out pure manufacturing dates if there are other candidates;
    // if ONLY manufacturing dates exist, fail safely instead of misreporting!
    const nonMfg = uniqueCandidates.filter(c => c.role !== 'mfg');
    if (nonMfg.length === 0) {
      return {
        foundDate: false,
        rawText,
        reason: 'only_mfg_found',
        candidates: uniqueCandidates
      };
    }

    // Explicit expiry-labeled candidates win first
    const expiryLabeled = nonMfg.filter(c => c.role === 'expiry');
    let chosen;

    if (expiryLabeled.length > 0) {
      // Among expiry-labeled dates, prefer highest score, tie-break by latest date
      expiryLabeled.sort((a, b) => b.score - a.score || b.date.getTime() - a.date.getTime());
      chosen = expiryLabeled[0];
    } else if (nonMfg.length >= 2) {
      // Multiple unlabeled dates (typically MFG + EXP where labels weren't printed/read):
      // Prefer full dates over compact 6-digit guesses, then pick the LATEST date!
      const strong = nonMfg.filter(c => c.specificityBonus >= 14);
      const pool = strong.length > 0 ? strong : nonMfg;
      pool.sort((a, b) => b.date.getTime() - a.date.getTime());
      chosen = pool[0];
    } else {
      chosen = nonMfg[0];
    }

    return {
      foundDate: true,
      date: chosen.date,
      isExpired: chosen.date < today,
      isMonthOnly: chosen.isMonthOnly,
      matchedText: chosen.matchedText,
      confidence: chosen.confidence,
      role: chosen.role,
      rawText,
      candidates: uniqueCandidates
    };
  }

  return {
    parse,
    mergeSpatialLines,
    extractDatesFromLine,
    repairDigits
  };
}));
