

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Serve API
        if (request.method === 'POST') {
            if (url.pathname === '/api/analyze') {
                return handleAnalysis(request, env);
            }
            if (url.pathname === '/api/scan') {
                return handleScan(request, env);
            }
            if (url.pathname === '/api/extract-colors') {
                return handleExtractColors(request, env);
            }
            if (url.pathname === '/api/detect-edges') {
                return handleEdgeDetection(request, env);
            }
            if (url.pathname === '/api/learn') {
                return handleLearn(request, env);
            }
            if (url.pathname === '/api/learn-from-value') {
                return handleLearnFromValue(request, env);
            }
        }

        // Serve static assets from 'public' directory
        return env.ASSETS.fetch(request);
    },
};

// --- Helper Functions ---

function findDominantColor(bands) {
    if (!bands || bands.length === 0) return null;
    const colorCounts = {};
    bands.forEach(band => {
        // Use band.name if it exists (from colorObjs), otherwise it's just the name string
        const name = band.name || band;
        colorCounts[name] = (colorCounts[name] || 0) + 1;
    });

    const dominantColorEntry = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0];

    // Only consider a color dominant if it appears more than once.
    // This prevents filtering a valid band when all bands are unique.
    if (dominantColorEntry && dominantColorEntry[1] > 1) {
        return dominantColorEntry[0];
    }

    return null;
}

// --- Main API Handlers ---

async function handleLearn(request, env) {
    try {
        const { detectedColor, correctColorName } = await request.json();

        if (!detectedColor || !correctColorName) {
            return new Response('Invalid learning data', { status: 400 });
        }

        // Get current definitions, or initialize if null (safety check for missing KV)
        let definitions = [];
        if (env.LEARNING_STORE) {
            definitions = await env.LEARNING_STORE.get("custom_colors", { type: "json" }) || [];
        }

        // Add or update the definition
        const existingIndex = definitions.findIndex(def =>
            def.r === detectedColor.r && def.g === detectedColor.g && def.b === detectedColor.b
        );

        const newDefinition = {
            name: correctColorName,
            r: detectedColor.r,
            g: detectedColor.g,
            b: detectedColor.b,
        };

        if (existingIndex > -1) {
            definitions[existingIndex] = newDefinition;
        } else {
            definitions.push(newDefinition);
        }

        // Save back to KV (only if configured)
        if (env.LEARNING_STORE) {
            await env.LEARNING_STORE.put("custom_colors", JSON.stringify(definitions));
        } else {
            console.warn("[handleLearn] LEARNING_STORE not configured, changes not persisted.");
        }

        return new Response(JSON.stringify({ success: true, message: `Learned that rgb(${detectedColor.r},${detectedColor.g},${detectedColor.b}) is ${correctColorName}` }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error(`[handleLearn] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}


async function handleAnalysis(request, env) {
    // Forward to the new endpoint to keep it simple
    return handleExtractColors(request, env);
}

async function handleScan(request, env) {
    try {
        const { slices } = await request.json();
        const customColors = env.LEARNING_STORE
            ? await env.LEARNING_STORE.get("custom_colors", { type: "json" }) || []
            : [];


        if (!slices || !Array.isArray(slices)) {
            return new Response('Invalid data', { status: 400 });
        }

        const sliceResults = slices.map(slicePixels => {
            const bands = extractBands(slicePixels, slicePixels.length, 1, 10, customColors);
            return {
                colors: bands.map(b => ({
                    r: b.rgb.r,
                    g: b.rgb.g,
                    b: b.rgb.b,
                    name: b.colorName,
                    hex: rgbToHex(b.rgb.r, b.rgb.g, b.rgb.b),
                    count: b.width
                })),
                detected_bands: bands.map(b => b.colorName)
            };
        });

        // --- Improved Body Filtering using Width ---
        const allProcessedSequences = sliceResults.map(res => {
            const bands = res.colors;

            // 1. Always filter out explicit body colors by name (case-insensitive + partial match)
            const withoutBeige = bands.filter(b => {
                const n = b.name.toLowerCase();
                return !n.includes('body') && !n.includes('beige');
            });
            if (withoutBeige.length < 3) return [];

            // 2. Then apply width-based filtering on the remaining bands
            const widths = withoutBeige.map(b => b.count).sort((a, b) => a - b);
            const medianWidth = widths[Math.floor(widths.length / 2)];
            const maxWidth = widths[widths.length - 1];

            // If a band is significantly wider than the median (e.g., > 2.5x), treat it as body
            const bodyColorName = (maxWidth > medianWidth * 2.5)
                ? withoutBeige.find(b => b.count === maxWidth).name
                : null;

            return withoutBeige.filter(b => b.name !== bodyColorName).map(b => b.name);
        });

        const sequenceCounts = {};
        allProcessedSequences.forEach(seq => {
            if (seq.length >= 3) {
                const key = seq.join(',');
                sequenceCounts[key] = (sequenceCounts[key] || 0) + 1;
            }
        });

        let bestSequence = [];
        if (Object.keys(sequenceCounts).length > 0) {
            const [topSequence] = Object.entries(sequenceCounts).sort((a, b) => b[1] - a[1])[0];
            bestSequence = topSequence.split(',');
        }

        const resistorValue = calculateResistorValue(bestSequence);

        return new Response(JSON.stringify({
            slices: sliceResults,
            detected_bands: bestSequence,
            resistor_value: resistorValue
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleExtractColors(request, env) {
    try {
        const { pixels, colorCount } = await request.json();
        const customColors = env.LEARNING_STORE
            ? await env.LEARNING_STORE.get("custom_colors", { type: "json" }) || []
            : [];

        if (!pixels || !Array.isArray(pixels) || !colorCount) {
            return new Response('Invalid data', { status: 400 });
        }

        // --- Median Cut Quantization ---
        const dominantColors = getDominantColors(pixels, colorCount);

        const enrichedColors = dominantColors.map(color => {
            const resistorColor = findClosestColor(color.rgb, customColors);
            return {
                ...color,
                name: resistorColor.name,
                hex: rgbToHex(color.rgb.r, color.rgb.g, color.rgb.b),
            };
        });

        const bandNames = enrichedColors.map(c => c.name);

        // Find and filter out the dominant color (body color) before calculation
        const colorObjs = bandNames.map(name => RESISTOR_COLORS.find(c => c.name === name)).filter(Boolean);

        // --- Improved Body Filtering for API Response ---
        // Filter out 'Beige (Body)' and any extremely dominant color by frequency/count
        const totalPixels = pixels.length;
        const filteredEnrichedColors = enrichedColors.filter(c => {
            if (c.name === 'Beige (Body)') return false;
            // If one color takes up more than 70% of the sample, it's likely background/body
            if (c.count > totalPixels * 0.7) return false;
            return true;
        });

        const filteredBandNames = filteredEnrichedColors.map(c => c.name);
        const resistorValue = calculateResistorValue(filteredBandNames);

        return new Response(JSON.stringify({
            colors: filteredEnrichedColors.map(c => ({
                r: c.rgb.r,
                g: c.rgb.g,
                b: c.rgb.b,
                hex: c.hex,
                name: c.name,
                count: c.count,
                avgX: c.avgX
            })),
            totalPixels: pixels.length,
            detected_bands: filteredBandNames,
            resistor_value: resistorValue
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
        console.error(`[handleExtractColors] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500 });
    }
}

function getDominantColors(pixels, k) {
    if (pixels.length === 0 || k === 0) return [];

    // 1. Create a bucket with all pixels
    let buckets = [pixels];

    // 2. Iteratively split buckets
    while (buckets.length < k) {
        let largestBucketIndex = -1;
        let largestRange = -1;
        let dimensionToSplit = -1;

        // Find the bucket with the largest color range to split
        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
            for (const p of buckets[i]) {
                minR = Math.min(minR, p.r); maxR = Math.max(maxR, p.r);
                minG = Math.min(minG, p.g); maxG = Math.max(maxG, p.g);
                minB = Math.min(minB, p.b); maxB = Math.max(maxB, p.b);
            }
            const rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
            const currentLargestRange = Math.max(rangeR, rangeG, rangeB);

            if (currentLargestRange > largestRange) {
                largestRange = currentLargestRange;
                largestBucketIndex = i;
                if (rangeR >= rangeG && rangeR >= rangeB) dimensionToSplit = 'r';
                else if (rangeG >= rangeR && rangeG >= rangeB) dimensionToSplit = 'g';
                else dimensionToSplit = 'b';
            }
        }

        if (largestBucketIndex === -1) break; // No more splits possible

        // 3. Split the chosen bucket
        const bucketToSplit = buckets[largestBucketIndex];
        bucketToSplit.sort((a, b) => a[dimensionToSplit] - b[dimensionToSplit]);

        const medianIndex = Math.floor(bucketToSplit.length / 2);

        const newBucket1 = bucketToSplit.slice(0, medianIndex);
        const newBucket2 = bucketToSplit.slice(medianIndex);

        // Replace the original bucket with the two new ones
        buckets.splice(largestBucketIndex, 1, newBucket1, newBucket2);
    }

    // 4. Average the colors in each bucket
    return buckets.filter(b => b.length > 0).map(bucket => {
        const colorSum = bucket.reduce((acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b, x: acc.x + p.x }), { r: 0, g: 0, b: 0, x: 0 });
        const avgColor = {
            r: Math.round(colorSum.r / bucket.length),
            g: Math.round(colorSum.g / bucket.length),
            b: Math.round(colorSum.b / bucket.length),
        };
        const avgX = Math.round(colorSum.x / bucket.length);
        return { rgb: avgColor, count: bucket.length, avgX: avgX };
    }).sort((a, b) => b.count - a.count); // Sort by prevalence
}



// --- Analysis Logic (Copied and adapted from test_edge_detection.js) ---

const RESISTOR_COLORS = [
    // Standard EIA color codes
    { name: 'Black', r: 0, g: 0, b: 0, value: 0, multiplier: 1 },
    { name: 'Brown', r: 165, g: 42, b: 42, value: 1, multiplier: 10, tolerance: 1 },
    { name: 'Red', r: 255, g: 0, b: 0, value: 2, multiplier: 100, tolerance: 2 },
    { name: 'Orange', r: 255, g: 165, b: 0, value: 3, multiplier: 1000 },
    { name: 'Yellow', r: 255, g: 255, b: 0, value: 4, multiplier: 10000 },
    { name: 'Green', r: 0, g: 128, b: 0, value: 5, multiplier: 100000, tolerance: 0.5 },
    { name: 'Blue', r: 0, g: 0, b: 255, value: 6, multiplier: 1000000, tolerance: 0.25 },
    { name: 'Violet', r: 238, g: 130, b: 238, value: 7, multiplier: 10000000, tolerance: 0.1 },
    { name: 'Gray', r: 128, g: 128, b: 128, value: 8, multiplier: 100000000, tolerance: 0.05 },
    { name: 'White', r: 255, g: 255, b: 255, value: 9, multiplier: 1000000000 },
    { name: 'Gold', r: 255, g: 215, b: 0, multiplier: 0.1, tolerance: 5 },
    { name: 'Gold_Light', r: 255, g: 220, b: 100, value: -1, tolerance: 5 }, // 反射で白飛び気味のゴールド
    { name: 'Gold_Metallic', r: 212, g: 175, b: 55, value: -1, tolerance: 5 }, // メタリックな質感
    { name: 'Gold_Dark', r: 184, g: 134, b: 11, value: -1, tolerance: 5 }, // 影の部分
    { name: 'Gold_Ochre', r: 204, g: 119, b: 34, value: -1, tolerance: 5 }, // 黄土色に近いゴールド
    { name: 'Silver', r: 192, g: 192, b: 192, multiplier: 0.01, tolerance: 10 },
    // Body color variants
    { name: 'Beige (Body)', r: 245, g: 245, b: 220 },
    { name: 'Tan (Body)', r: 210, g: 180, b: 140 },
    { name: 'Light Blue (Body)', r: 173, g: 216, b: 230 }
];

function findClosestColor(pixel, customColors = []) {
    let minDist = Infinity;
    let closest = RESISTOR_COLORS[0];

    // First check user-learned colors with high bias
    if (customColors && Array.isArray(customColors)) {
        for (const color of customColors) {
            const dist = colorDistance(pixel, color);
            // Smaller multiplier means higher priority
            const biasedDist = dist * 0.4;
            if (biasedDist < minDist) {
                minDist = biasedDist;
                closest = color;
            }
        }
    }

    // Then check standard colors
    for (const color of RESISTOR_COLORS) {
        let dist = colorDistance(pixel, color);

        // Apply strong bias to make Gold/Silver more likely to be chosen over Yellow/Gray
        if (color.name.startsWith('Gold')) {
            dist *= 0.65; // ゴールドの判定を強く優先
        } else if (color.name === 'Silver') {
            dist *= 0.8;
        }

        // Body colors should be picked easily if it's actually body
        if (color.name.includes('(Body)')) {
            dist *= 0.9;
        }

        if (dist <= minDist) {
            minDist = dist;
            closest = color;
        }
    }

    // Unify different shades of Gold into a single 'Gold'
    if (closest.name && closest.name.startsWith('Gold')) {
        return RESISTOR_COLORS.find(c => c.name === 'Gold');
    }

    return closest;
}

function calculateResistorValue(bands) {
    if (!bands || bands.length < 3) return null;

    let colorObjsFull = bands.map(bandName => {
        return RESISTOR_COLORS.find(c => c.name === bandName) || null;
    }).filter(obj => obj !== null);

    if (colorObjsFull.length < 3) {
        return "Not enough valid bands";
    }

    let resistance = 0;
    let tolerance = 20; // Default tolerance
    let digits = [];
    let multiplierObj = null;
    let toleranceObj = null;

    // Determine 3, 4, 5, or 6 band resistor
    // For simplicity, we will assume 4 or 5 band, where the last band is tolerance and second-to-last is multiplier
    const lastBand = colorObjsFull[colorObjsFull.length - 1];

    // Silver/Gold are usually tolerance/multiplier, never first digit
    if (lastBand.tolerance !== undefined) {
        toleranceObj = lastBand;
        multiplierObj = colorObjsFull[colorObjsFull.length - 2];
        digits = colorObjsFull.slice(0, colorObjsFull.length - 2);
    } else {
        // Assume 3-band code
        multiplierObj = colorObjsFull[colorObjsFull.length - 1];
        digits = colorObjsFull.slice(0, colorObjsFull.length - 1);
    }

    if (digits.length === 0 || digits.some(d => d.value === undefined) || !multiplierObj || multiplierObj.multiplier === undefined) {
        // Fallback for 3-band or misidentified sequences
        return "Invalid band sequence";
    }

    const digitValue = parseInt(digits.map(d => d.value).join(''));
    resistance = digitValue * multiplierObj.multiplier;

    if (toleranceObj) {
        tolerance = toleranceObj.tolerance;
    }

    return formatResistance(resistance) + ` ±${tolerance}%`;
}


function formatResistance(ohms) {
    if (ohms >= 1000000) return (ohms / 1000000).toFixed(1).replace(/\.0$/, '') + 'MΩ';
    if (ohms >= 1000) return (ohms / 1000).toFixed(1).replace(/\.0$/, '') + 'kΩ';
    return ohms + 'Ω';
}

function rgbToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}


function rgbToLab(r, g, b) {
    r /= 255, g /= 255, b /= 255;
    r = r > 0.04045 ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = g > 0.04045 ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = b > 0.04045 ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) * 100;
    let y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750) * 100;
    let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) * 100;
    x /= 95.047, y /= 100, z /= 108.883;
    x = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + 16 / 116;
    y = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + 16 / 116;
    z = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + 16 / 116;
    return { l: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

function colorDistance(c1, c2) {
    const lab1 = rgbToLab(c1.r, c1.g, c1.b);
    const lab2 = rgbToLab(c2.r, c2.g, c2.b);
    return Math.sqrt(Math.pow(lab1.l - lab2.l, 2) + Math.pow(lab1.a - lab2.a, 2) + Math.pow(lab1.b - lab2.b, 2));
}

function averageColor(colors) {
    if (colors.length === 0) return { r: 0, g: 0, b: 0 };
    const sum = colors.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
    return { r: Math.round(sum.r / colors.length), g: Math.round(sum.g / colors.length), b: Math.round(sum.b / colors.length) };
}

function extractBands(pixels, width, height, colorChangeThreshold, customColors = []) {
    if (pixels.length === 0 || width === 0 || height === 0) return [];

    const averagedLine = [];
    const startY = Math.floor(height * 0.25);
    const endY = Math.floor(height * 0.75);




    for (let x = 0; x < width; x++) {
        let sumR = 0, sumG = 0, sumB = 0;
        let count = 0;
        for (let y = startY; y < endY; y++) {
            const idx = y * width + x;
            if (pixels[idx]) {
                sumR += pixels[idx].r;
                sumG += pixels[idx].g;
                sumB += pixels[idx].b;
                count++;
            }
        }
        if (count > 0) {
            averagedLine.push({ r: Math.round(sumR / count), g: Math.round(sumG / count), b: Math.round(sumB / count), x: x });
        } else {
            averagedLine.push({ r: 0, g: 0, b: 0, x: x });
        }
    }

    const segments = [];
    if (averagedLine.length === 0) return [];

    let currentSegment = { start_x: averagedLine[0].x, end_x: averagedLine[0].x, pixels: [averagedLine[0]] };
    for (let i = 1; i < averagedLine.length; i++) {
        const prevColor = averagedLine[i - 1];
        const currentColor = averagedLine[i];

        if (colorDistance(prevColor, currentColor) > colorChangeThreshold) {
            segments.push(currentSegment);
            currentSegment = { start_x: currentColor.x, end_x: currentColor.x, pixels: [currentColor] };
        } else {
            currentSegment.end_x = currentColor.x;
            currentSegment.pixels.push(currentColor);
        }
    }
    segments.push(currentSegment);

    const finalBands = [];
    const minBandWidth = 3;

    // 全セグメントの幅の統計を先に取る（後のフィルタリング用）
    const allWidths = segments.map(s => s.end_x - s.start_x + 1).filter(w => w >= minBandWidth);
    const medianWidth = allWidths.length > 0 ? allWidths.sort((a, b) => a - b)[Math.floor(allWidths.length / 2)] : 10;

    segments.forEach((seg, index) => {
        const avgColor = averageColor(seg.pixels);
        const lab = rgbToLab(avgColor.r, avgColor.g, avgColor.b);
        const l = lab.l;
        const segWidth = seg.end_x - seg.start_x + 1;

        if (segWidth < minBandWidth) return;

        // 【改善ポイント1】まず色を判定する (除外する前に判断する)
        const resistorColor = findClosestColor(avgColor, customColors);
        const isMetallic = resistorColor.name.startsWith('Gold') || resistorColor.name === 'Silver';

        // 【改善ポイント2】輝度制限の動的緩和
        // 金属色（金色・銀色）の可能性がある場合は、白飛び(L>99)や影(L<5)を許容する
        if (!isMetallic && (l < 5 || l > 99)) return;

        // 【改善ポイント3】端のバンドに対する幅制限の緩和
        // 4バンド目の金色は、画像端で広く認識されやすいため、
        // 配列の最初や最後付近のセグメントは、2.5倍ルールから除外する
        const isAtEdge = (index === 0 || index >= segments.length - 2);
        if (!isAtEdge && segWidth > medianWidth * 2.5) {
            // 中央付近で異常に太い場合は、依然として本体色(Body)の可能性が高い
            if (resistorColor.name.includes('Body')) return;
        }

        finalBands.push({
            x: Math.round((seg.start_x + seg.end_x) / 2),
            colorName: resistorColor.name,
            rgb: avgColor,
            l: l,
            width: segWidth,
        });
    });

    return finalBands.sort((a, b) => a.x - b.x);
}


async function handleLearnFromValue(request, env) {
    try {
        const { detectedBands, correctValue, correctTolerance } = await request.json();

        if (!detectedBands || !Array.isArray(detectedBands) || !correctValue) {
            return new Response(JSON.stringify({ error: 'Invalid input data.' }), { status: 400 });
        }

        const ohms = parseResistance(correctValue);
        if (ohms === null) return new Response(JSON.stringify({ error: 'Invalid resistance value format.' }), { status: 400 });

        const correctColorSequence = resistanceToColors(ohms, correctTolerance);
        if (correctColorSequence.length === 0) return new Response(JSON.stringify({ error: 'Could not determine sequence.' }), { status: 400 });

        // Learning logic would go here, involving saving to KV
        return new Response(JSON.stringify({
            success: true,
            message: "Value parsed, correct sequence determined.",
            correctColorSequence: correctColorSequence,
            yourDetectedBands: detectedBands,
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

function parseResistance(valueStr) {
    if (!valueStr) return null;
    const str = String(valueStr).trim().toUpperCase();
    let multiplier = 1;
    let numericPart = str;

    if (str.endsWith('K')) { multiplier = 1000; numericPart = str.slice(0, -1); }
    else if (str.endsWith('M')) { multiplier = 1000000; numericPart = str.slice(0, -1); }

    const value = parseFloat(numericPart);
    return isNaN(value) ? null : value * multiplier;
}

function resistanceToColors(ohms, tolerance = null) {
    if (ohms < 0.1) return [];

    const colorMap = [
        { name: 'Black', value: 0 }, { name: 'Brown', value: 1 }, { name: 'Red', value: 2 },
        { name: 'Orange', value: 3 }, { name: 'Yellow', value: 4 }, { name: 'Green', value: 5 },
        { name: 'Blue', value: 6 }, { name: 'Violet', value: 7 }, { name: 'Gray', value: 8 },
        { name: 'White', value: 9 }
    ];

    const toleranceMap = {
        '1': 'Brown', '2': 'Red', '0.5': 'Green', '0.25': 'Blue',
        '0.1': 'Violet', '5': 'Gold', '10': 'Silver', '20': 'None'
    };

    const exponent = Math.floor(Math.log10(ohms));
    let firstTwoDigits = Math.round(ohms / Math.pow(10, exponent - 1));

    // Handle cases where rounding goes to 100
    if (firstTwoDigits === 100) {
        firstTwoDigits = 10;
        // multiplier will shift accordingly
    }

    const firstDigit = Math.floor(firstTwoDigits / 10);
    const secondDigit = firstTwoDigits % 10;
    const multiplierValue = Math.log10(ohms / firstTwoDigits) + 1;

    const firstBand = colorMap.find(c => c.value === firstDigit);
    const secondBand = colorMap.find(c => c.value === secondDigit);

    // Multiplier can be Gold (-1) or Silver (-2)
    let multiplierBandName = '';
    if (multiplierValue === -1) multiplierBandName = 'Gold';
    else if (multiplierValue === -2) multiplierBandName = 'Silver';
    else {
        const mb = colorMap.find(c => c.value === Math.round(multiplierValue));
        if (mb) multiplierBandName = mb.name;
    }

    if (firstBand && secondBand && multiplierBandName) {
        const sequence = [firstBand.name, secondBand.name, multiplierBandName];
        if (tolerance && toleranceMap[tolerance]) {
            const tc = toleranceMap[tolerance];
            if (tc !== 'None') sequence.push(tc);
        }
        return sequence;
    }

    return [];
}


async function handleEdgeDetection(request, env) {
    try {
        const { pixels, width, height, threshold } = await request.json();
        const customColors = env.LEARNING_STORE
            ? await env.LEARNING_STORE.get("custom_colors", { type: "json" }) || []
            : [];

        if (!pixels || !Array.isArray(pixels) || !width || !height || threshold === undefined) {
            return new Response('Invalid data', { status: 400 });
        }

        const bands = extractBands(pixels, width, height, threshold, customColors);

        // --- Refined Body Filtering ---
        // 1. Mark segments that are clearly body colors by name (case-insensitive)
        let processedBands = bands.map(b => {
            const name = b.colorName.toLowerCase();
            return {
                ...b,
                isBody: name.includes('body') || name.includes('beige') || name.includes('tan')
            };
        });

        // 2. Identify segments that are "wide" compared to others
        if (processedBands.length >= 3) {
            const widths = processedBands.map(b => b.width).sort((a, b) => a - b);
            const medianWidth = widths[Math.floor(widths.length / 2)];

            // If a segment is > 2.5x the median width, it's highly likely to be the body or a gap
            processedBands = processedBands.map(b => {
                if (b.width > medianWidth * 2.5) {
                    return { ...b, isBody: true };
                }
                return b;
            });
        }

        // 3. Filter out those marked as body
        const filteredBands = processedBands.filter(b => !b.isBody);
        const filteredBandNames = filteredBands.map(b => b.colorName);

        const resistorValue = calculateResistorValue(filteredBandNames);

        return new Response(JSON.stringify({
            success: true,
            bands: filteredBands,
            detected_bands: filteredBandNames,
            resistor_value: resistorValue
        }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        console.error(`[handleEdgeDetection] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

