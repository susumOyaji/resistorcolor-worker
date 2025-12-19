

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
            const bands = extractBands(slicePixels, slicePixels.length, 1, customColors);
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

        // Aggregate results to find the most common sequence of value bands
        const allBandSequences = sliceResults.map(res => {
            const colorObjs = res.detected_bands.map(name => RESISTOR_COLORS.find(c => c.name === name)).filter(Boolean);
            const dominantColor = findDominantColor(colorObjs);
            return colorObjs.filter(band => band.name !== dominantColor).map(band => band.name);
        });

        const sequenceCounts = {};
        allBandSequences.forEach(seq => {
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
        const dominantColorName = findDominantColor(colorObjs);
        const filteredBandNames = bandNames.filter(name => name !== dominantColorName);

        const resistorValue = calculateResistorValue(filteredBandNames);

        return new Response(JSON.stringify({
            colors: enrichedColors.map(c => ({
                r: c.rgb.r,
                g: c.rgb.g,
                b: c.rgb.b,
                hex: c.hex,
                name: c.name,
                count: c.count,
                avgX: c.avgX
            })),
            totalPixels: pixels.length,
            detected_bands: bandNames,
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
    { name: 'Gold_Light', r: 255, g: 215, b: 0, value: -1, tolerance: 5 }, // 明るい反射を持つゴールド (#FFD700)
    { name: 'Gold_Dark', r: 184, g: 134, b: 11, value: -1, tolerance: 5 }, // 影のあるゴールド (#B8860B)
    { name: 'Silver', r: 192, g: 192, b: 192, multiplier: 0.01, tolerance: 10 },
    // A representative body color, useful for filtering.
    { name: 'Beige (Body)', r: 245, g: 245, b: 220 }
];

function findClosestColor(pixel, customColors = []) {
    let minDist = Infinity;
    let closest = RESISTOR_COLORS[0];
    if (customColors && Array.isArray(customColors)) {
        for (const color of customColors) {
            const dist = colorDistance(pixel, color);
            // Apply bias for user-learned colors
            const biasedDist = dist * 0.5;
            if (biasedDist < minDist) {
                minDist = biasedDist;
                closest = color;
            }
        }
    }
    for (const color of RESISTOR_COLORS) {
        let dist = colorDistance(pixel, color);

        // Apply bias to make Gold/Silver more likely to be chosen
        if (color.name.startsWith('Gold') || color.name === 'Silver') {
            dist *= 0.8;
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
        return "Invalid band sequence for calculation";
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
    // Define the vertical slice to analyze (e.g., middle 50%)
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
    // colorChangeThreshold now passed as a parameter
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
    const minBandWidth = 4;
    segments.forEach(seg => {
        const avgColor = averageColor(seg.pixels);
        const l = rgbToLab(avgColor.r, avgColor.g, avgColor.b).l;

        if (seg.end_x - seg.start_x + 1 < minBandWidth) {
            return;
        }

        if (l < 10 || l > 98) {
            return;
        }

        const resistorColor = findClosestColor(avgColor, customColors);

        finalBands.push({
            x: Math.round((seg.start_x + seg.end_x) / 2),
            colorName: resistorColor.name,
            rgb: avgColor,
            l: l,
            width: seg.end_x - seg.start_x + 1,
        });
    });

    return finalBands.sort((a, b) => a.x - b.x);
}


async function handleLearnFromValue(request, env) {
    try {
        const { detectedBands, correctValue, correctTolerance } = await request.json();

        if (!detectedBands || !Array.isArray(detectedBands) || !correctValue) {
            return new Response(JSON.stringify({ error: 'Invalid input data. At least 3 detected bands and a correct value are required.' }), { status: 400 });
        }

        // 1. Parse the correct resistance value string (e.g., "1k", "270") into a number
        const ohms = parseResistance(correctValue);
        if (ohms === null) {
            return new Response(JSON.stringify({ error: 'Invalid resistance value format. Use formats like 270, 4.7k, 2.2M.' }), { status: 400 });
        }

        // 2. Convert the numeric resistance value to the ideal color band sequence
        const correctColorSequence = resistanceToColors(ohms, correctTolerance);
        if (correctColorSequence.length === 0) {
            return new Response(JSON.stringify({ error: 'Could not determine a valid color sequence for the given resistance value.' }), { status: 400 });
        }

        // NOTE: Learning logic is not implemented yet.
        // This endpoint currently just returns the correctly calculated color sequence.
        return new Response(JSON.stringify({
            message: "Function not fully implemented. This is the calculated correct sequence.",
            correctColorSequence: correctColorSequence,
            yourDetectedBands: detectedBands,
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        console.error(`[handleLearnFromValue] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500 });
    }
}

function parseResistance(valueStr) {
    if (!valueStr) return null;
    const str = String(valueStr).trim().toUpperCase();
    const multiplier = str.slice(-1);
    let value = parseFloat(str);

    if (isNaN(value)) return null;

    if (multiplier === 'K') {
        value *= 1000;
    } else if (multiplier === 'M') {
        value *= 1000000;
    }

    return value;
}

function resistanceToColors(ohms, tolerance = null) {
    if (ohms < 10) { // Typically requires a Gold/Silver multiplier, focusing on standard bands for now.
        console.error(`Cannot convert value ${ohms}Ω (less than 10) to a standard 4-band code.`);
        return [];
    }

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
    const firstTwoDigits = Math.round(ohms / Math.pow(10, exponent - 1));

    if (firstTwoDigits < 10 || firstTwoDigits > 99) {
        console.error(`Could not extract two significant digits from ${ohms}Ω.`);
        return [];
    }

    const firstDigit = Math.floor(firstTwoDigits / 10);
    const secondDigit = firstTwoDigits % 10;
    const multiplierValue = exponent - 1;

    const firstBand = colorMap.find(c => c.value === firstDigit);
    const secondBand = colorMap.find(c => c.value === secondDigit);
    const multiplierBand = colorMap.find(c => c.value === multiplierValue);

    if (firstBand && secondBand && multiplierBand) {
        // Final check: does the derived value match the original?
        const reconstructedValue = (firstBand.value * 10 + secondBand.value) * Math.pow(10, multiplierBand.value);
        if (Math.abs(reconstructedValue - ohms) / ohms < 0.01) { // Allow for 1% tolerance for rounding issues
            const sequence = [firstBand.name, secondBand.name, multiplierBand.name];
            if (tolerance && toleranceMap[tolerance]) {
                const toleranceColor = toleranceMap[tolerance];
                if (toleranceColor !== 'None') {
                    sequence.push(toleranceColor);
                }
            }
            return sequence;
        }
    }

    console.error(`Could not convert ${ohms}Ω to a standard 4-band color code.`);
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
        const bandNames = bands.map(b => b.colorName);

        // Find and filter out the dominant color (body color) before calculation
        const colorObjs = bandNames.map(name => RESISTOR_COLORS.find(c => c.name === name)).filter(Boolean);
        const dominantColorName = findDominantColor(colorObjs);
        const filteredBandNames = bandNames.filter(name => name !== dominantColorName);

        const resistorValue = calculateResistorValue(filteredBandNames);

        return new Response(JSON.stringify({
            success: true,
            bands: bands,
            detected_bands: bandNames, // Return original bands for UI transparency
            resistor_value: resistorValue
        }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        console.error(`[handleEdgeDetection] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500 });
    }
}
