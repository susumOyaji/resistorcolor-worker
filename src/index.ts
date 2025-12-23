
export interface Env {
    LEARNING_STORE: KVNamespace;
    ASSETS: Fetcher;
}

interface Pixel {
    r: number;
    g: number;
    b: number;
    x?: number;
}

interface DetectionResult {
    colors: any[];
    detected_bands: string[];
    resistor_value: string | null;
    totalPixels?: number;
    slices?: any[];
}

interface ResistorColor {
    name: string;
    r: number;
    g: number;
    b: number;
    value?: number;
    multiplier?: number;
    tolerance?: number;
}

interface CustomColor {
    name: string;
    r: number;
    g: number;
    b: number;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

function findDominantColor(bands: { name: string }[] | string[]): string | null {
    if (!bands || bands.length === 0) return null;
    const colorCounts: { [key: string]: number } = {};
    bands.forEach(band => {
        // Use band.name if it exists (from colorObjs), otherwise it's just the name string
        const name = (typeof band === 'string') ? band : band.name;
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

async function handleLearn(request: Request, env: Env): Promise<Response> {
    try {
        const { detectedColor, correctColorName } = await request.json() as any;

        if (!detectedColor || !correctColorName) {
            return new Response('Invalid learning data', { status: 400 });
        }

        // Get current definitions, or initialize if null (safety check for missing KV)
        let definitions: CustomColor[] = [];
        if (env.LEARNING_STORE) {
            definitions = await env.LEARNING_STORE.get<CustomColor[]>("custom_colors", { type: "json" }) || [];
        }

        // Add or update the definition
        const existingIndex = definitions.findIndex(def =>
            def.r === detectedColor.r && def.g === detectedColor.g && def.b === detectedColor.b
        );

        const newDefinition: CustomColor = {
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

    } catch (e: any) {
        console.error(`[handleLearn] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}


async function handleAnalysis(request: Request, env: Env): Promise<Response> {
    // Forward to the new endpoint to keep it simple
    return handleExtractColors(request, env);
}

async function handleScan(request: Request, env: Env): Promise<Response> {
    try {
        const { slices } = await request.json() as { slices: Pixel[][] };
        const customColors = env.LEARNING_STORE
            ? await env.LEARNING_STORE.get<CustomColor[]>("custom_colors", { type: "json" }) || []
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
            const withoutBeige = bands.filter((b: any) => {
                const n = b.name.toLowerCase();
                return !n.includes('body') && !n.includes('beige');
            });
            if (withoutBeige.length < 3) return [];

            // 2. Then apply width-based filtering on the remaining bands
            const widths = withoutBeige.map((b: any) => b.count).sort((a: number, b: number) => a - b);
            const medianWidth = widths[Math.floor(widths.length / 2)];
            const maxWidth = widths[widths.length - 1];

            // If a band is significantly wider than the median (e.g., > 2.5x), treat it as body
            const bodyColorName = (maxWidth > medianWidth * 2.5)
                ? withoutBeige.find((b: any) => b.count === maxWidth).name
                : null;

            return withoutBeige.filter((b: any) => b.name !== bodyColorName).map((b: any) => b.name);
        });

        const sequenceCounts: { [key: string]: number } = {};
        allProcessedSequences.forEach(seq => {
            if (seq.length >= 3) {
                const key = seq.join(',');
                sequenceCounts[key] = (sequenceCounts[key] || 0) + 1;
            }
        });

        let bestSequence: string[] = [];
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

    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

async function handleExtractColors(request: Request, env: Env): Promise<Response> {
    try {
        const { pixels, colorCount, width, height } = await request.json() as {
            pixels: Pixel[],
            colorCount: number,
            width?: number,
            height?: number
        };
        const customColors = env.LEARNING_STORE
            ? await env.LEARNING_STORE.get<CustomColor[]>("custom_colors", { type: "json" }) || []
            : [];

        if (!pixels || !Array.isArray(pixels) || !colorCount) {
            return new Response('Invalid data', { status: 400 });
        }

        // --- Median Cut Quantization ---
        const dominantColors = getDominantColors(pixels, colorCount);

        // --- Apply Edge Detection Logic: Position-based Color Refinement ---
        const imageWidth = width || Math.sqrt(pixels.length); // Estimate if not provided
        const enrichedColors = dominantColors.map((color, index) => {
            let resistorColor = findClosestColor(color.rgb, customColors);
            const lab = rgbToLab(color.rgb.r, color.rgb.g, color.rgb.b);

            // Position information (from avgX)
            const normalizedX = color.avgX / imageWidth; // 0.0 ~ 1.0
            const isAtEdge = normalizedX < 0.2 || normalizedX > 0.8;

            // --- Context-aware refinement (from extractBands logic) ---

            // Silver candidate detection
            const isLowChroma = Math.abs(lab.a) < 3 && Math.abs(lab.b) < 3;
            const isCandidateSilver =
                isLowChroma &&
                lab.l > 60 && lab.l < 95 &&
                isAtEdge;

            // Gold candidate detection
            const isWarm = lab.a > -5 && lab.b > 20;
            const isCandidateGold =
                isWarm &&
                lab.l > 25 && lab.l < 90 &&
                isAtEdge;

            // Override color name based on position and physical properties
            if (isCandidateSilver) {
                const silverColor = RESISTOR_COLORS.find(c => c.name === 'Silver');
                if (silverColor) resistorColor = silverColor;
            } else if (isCandidateGold) {
                const goldColor = RESISTOR_COLORS.find(c => c.name === 'Gold');
                if (goldColor) resistorColor = goldColor;
            }

            return {
                ...color,
                name: resistorColor.name,
                hex: rgbToHex(color.rgb.r, color.rgb.g, color.rgb.b),
                position: normalizedX, // Add position info for debugging
                isAtEdge: isAtEdge
            };
        });

        // --- Improved Body Filtering using Width Information ---
        const totalPixels = pixels.length;

        // Calculate width statistics (similar to extractBands)
        const colorWidths = enrichedColors.map(c => c.count);
        const sortedWidths = [...colorWidths].sort((a, b) => a - b);
        const medianWidth = sortedWidths[Math.floor(sortedWidths.length / 2)];

        const filteredEnrichedColors = enrichedColors.filter(c => {
            // 1. Filter by name
            if (c.name === 'Beige (Body)') return false;

            // 2. Filter by extreme dominance (70% threshold)
            if (c.count > totalPixels * 0.7) return false;

            // 3. Filter by width (if significantly wider than median, likely body)
            // Only apply to non-edge colors
            if (!c.isAtEdge && c.count > medianWidth * 2.5) {
                if (c.name.includes('Body') || c.name.includes('Beige') || c.name.includes('Tan')) {
                    return false;
                }
            }

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
                avgX: c.avgX,
                position: c.position,
                isAtEdge: c.isAtEdge
            })),
            totalPixels: pixels.length,
            detected_bands: filteredBandNames,
            resistor_value: resistorValue
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (e: any) {
        console.error(`[handleExtractColors] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500 });
    }
}

function getDominantColors(pixels: Pixel[], k: number): { rgb: Pixel, count: number, avgX: number }[] {
    if (pixels.length === 0 || k === 0) return [];

    // 1. Create a bucket with all pixels
    let buckets: Pixel[][] = [pixels];

    // 2. Iteratively split buckets
    while (buckets.length < k) {
        let largestBucketIndex = -1;
        let largestRange = -1;
        let dimensionToSplit: 'r' | 'g' | 'b' | -1 = -1;

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

        if (largestBucketIndex === -1 || dimensionToSplit === -1) break; // No more splits possible

        // 3. Split the chosen bucket
        const bucketToSplit = buckets[largestBucketIndex];
        bucketToSplit.sort((a, b) => a[dimensionToSplit as 'r' | 'g' | 'b'] - b[dimensionToSplit as 'r' | 'g' | 'b']);

        const medianIndex = Math.floor(bucketToSplit.length / 2);

        const newBucket1 = bucketToSplit.slice(0, medianIndex);
        const newBucket2 = bucketToSplit.slice(medianIndex);

        // Replace the original bucket with the two new ones
        buckets.splice(largestBucketIndex, 1, newBucket1, newBucket2);
    }

    // 4. Average the colors in each bucket
    return buckets.filter(b => b.length > 0).map(bucket => {
        const colorSum = bucket.reduce((acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b, x: (acc.x || 0) + (p.x || 0) }), { r: 0, g: 0, b: 0, x: 0 });
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

const RESISTOR_COLORS: ResistorColor[] = [
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
    // Body color variants (expanded for better Gold vs Body discrimination)
    { name: 'Beige (Body)', r: 245, g: 245, b: 220 },
    { name: 'Tan (Body)', r: 210, g: 180, b: 140 },
    { name: 'Sandy (Body)', r: 244, g: 164, b: 96 }, // 砂色系のBody
    { name: 'Cream (Body)', r: 255, g: 253, b: 208 }, // クリーム色系のBody
    { name: 'Khaki (Body)', r: 195, g: 176, b: 145 }, // カーキ色系のBody
    { name: 'Light Blue (Body)', r: 173, g: 216, b: 230 },
    // Dark variants for better detection under shadows
    { name: 'Violet_Dark', r: 100, g: 50, b: 150, value: 7, multiplier: 10000000, tolerance: 0.1 }
];

function findClosestColor(pixel: { r: number, g: number, b: number }, customColors: CustomColor[] = []): ResistorColor {
    let minDist = Infinity;
    let closest = RESISTOR_COLORS[0];

    // First check user-learned colors with high bias
    if (customColors && Array.isArray(customColors)) {
        for (const color of customColors) {
            const dist = colorDistance(pixel, color);
            // Smaller multiplier means higher priority
            // Adjusted from 0.4 to 0.7 to avoid false positives from shadow/dark bands
            const biasedDist = dist * 0.7;

            if (biasedDist < minDist) {
                minDist = biasedDist;
                // Map CustomColor to ResistorColor structure
                closest = { ...color, name: color.name, value: -1 }; // Approximate
            }
        }
    }

    // Then check standard colors
    const pixelLab = rgbToLab(pixel.r, pixel.g, pixel.b);
    const pixelChroma = Math.sqrt(pixelLab.a * pixelLab.a + pixelLab.b * pixelLab.b);

    // Calculate hue angle in Lab color space for better Gold vs Body discrimination
    const hueAngle = Math.atan2(pixelLab.b, pixelLab.a) * (180 / Math.PI);

    for (const color of RESISTOR_COLORS) {
        let dist = colorDistance(pixel, color);
        const colorLab = rgbToLab(color.r, color.g, color.b);
        const colorChroma = Math.sqrt(colorLab.a * colorLab.a + colorLab.b * colorLab.b);

        // --- IMPROVEMENT: Enhanced Gold vs Body Color Discrimination ---

        // 1. Chroma-based Penalty for Neutral Colors
        const isNeutral = ['Black', 'Gray', 'White', 'Silver'].includes(color.name) || color.name.includes('(Body)');
        if (pixelChroma > 10 && isNeutral) {
            dist *= (1.0 + (pixelChroma / 50));
        }

        // 2. Gold-specific enhancement with saturation check
        if (color.name.startsWith('Gold')) {
            // Gold has high saturation (chroma > 30) and specific hue (60-90 degrees)
            const isGoldLike = pixelChroma > 30 && hueAngle > 60 && hueAngle < 100;
            if (isGoldLike) {
                dist *= 0.55; // Strong preference for Gold when characteristics match
            } else {
                dist *= 0.75; // Moderate preference otherwise
            }
        } else if (color.name === 'Silver') {
            dist *= 0.8;
        }

        // 3. Body colors: penalize if pixel has high saturation (Gold-like)
        if (color.name.includes('(Body)')) {
            if (pixelChroma > 35) {
                // High saturation pixel is unlikely to be Body color
                dist *= 1.5;
            } else if (pixelChroma < 15) {
                // Low saturation is typical for Body colors
                dist *= 0.85;
            } else {
                dist *= 0.95;
            }
        }

        if (dist <= minDist) {
            minDist = dist;
            closest = color;
        }
    }

    // Unify different shades of Gold into a single 'Gold'
    if (closest.name && closest.name.startsWith('Gold')) {
        const gold = RESISTOR_COLORS.find(c => c.name === 'Gold');
        if (gold) return gold;
    }

    // Unify Dark Violet back to Violet
    if (closest.name === 'Violet_Dark') {
        const violet = RESISTOR_COLORS.find(c => c.name === 'Violet');
        if (violet) return violet;
    }

    return closest;
}

function calculateResistorValue(bands: string[]): string | null {
    if (!bands || bands.length < 3) return null;

    let colorObjsFull = bands.map(bandName => {
        return RESISTOR_COLORS.find(c => c.name === bandName) || null;
    }).filter(obj => obj !== null) as ResistorColor[];

    if (colorObjsFull.length < 3) {
        return "Not enough valid bands";
    }

    let resistance = 0;
    let tolerance = 20; // Default tolerance
    let digits: ResistorColor[] = [];
    let multiplierObj: ResistorColor | null = null;
    let toleranceObj: ResistorColor | null = null;

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

    if (toleranceObj && toleranceObj.tolerance) {
        tolerance = toleranceObj.tolerance;
    }

    return formatResistance(resistance) + ` ±${tolerance}%`;
}


function formatResistance(ohms: number): string {
    if (ohms >= 1000000) return (ohms / 1000000).toFixed(1).replace(/\.0$/, '') + 'MΩ';
    if (ohms >= 1000) return (ohms / 1000).toFixed(1).replace(/\.0$/, '') + 'kΩ';
    return ohms + 'Ω';
}

function rgbToHex(r: number, g: number, b: number): string {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}


function rgbToLab(r: number, g: number, b: number): { l: number, a: number, b: number } {
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

function colorDistance(c1: { r: number, g: number, b: number }, c2: { r: number, g: number, b: number }): number {
    const lab1 = rgbToLab(c1.r, c1.g, c1.b);
    const lab2 = rgbToLab(c2.r, c2.g, c2.b);
    return Math.sqrt(Math.pow(lab1.l - lab2.l, 2) + Math.pow(lab1.a - lab2.a, 2) + Math.pow(lab1.b - lab2.b, 2));
}

function averageColor(colors: Pixel[]): Pixel {
    if (colors.length === 0) return { r: 0, g: 0, b: 0 };
    const sum = colors.reduce((acc, c) => ({ r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b }), { r: 0, g: 0, b: 0 });
    return { r: Math.round(sum.r / colors.length), g: Math.round(sum.g / colors.length), b: Math.round(sum.b / colors.length) };
}

function extractBands(pixels: Pixel[], width: number, height: number, colorChangeThreshold: number, customColors: CustomColor[] = []): any[] {
    if (pixels.length === 0 || width === 0 || height === 0) return [];

    const averagedLine: Pixel[] = [];
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

    const segments: { start_x: number, end_x: number, pixels: Pixel[] }[] = [];
    if (averagedLine.length === 0) return [];

    let currentSegment = { start_x: (averagedLine[0].x || 0), end_x: (averagedLine[0].x || 0), pixels: [averagedLine[0]] };
    for (let i = 1; i < averagedLine.length; i++) {
        const prevColor = averagedLine[i - 1];
        const currentColor = averagedLine[i];

        if (colorDistance(prevColor, currentColor) > colorChangeThreshold) {
            segments.push(currentSegment);
            currentSegment = { start_x: (currentColor.x || 0), end_x: (currentColor.x || 0), pixels: [currentColor] };
        } else {
            currentSegment.end_x = (currentColor.x || 0);
            currentSegment.pixels.push(currentColor);
        }
    }
    segments.push(currentSegment);

    const finalBands: any[] = [];
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
        let resistorColor = findClosestColor(avgColor, customColors);

        const isAtEdge = (index === 0 || index >= segments.length - 2);

        // Doc.txtに基づくSilver/Gold検出の強化: Role(位置) + Physicalによる判定
        const isLowChroma = Math.abs(lab.a) < 3 && Math.abs(lab.b) < 3;
        const isCandidateSilver =
            isLowChroma &&
            l > 60 && l < 95 &&
            segWidth < medianWidth * 1.5 &&
            isAtEdge;

        // Gold Candidate: 強化された判定ロジック
        // 1. 色相: 黄色系 (Lab b > 20)
        // 2. 彩度: 高彩度 (chroma > 30) - Body色との区別
        // 3. 位置: 端にある
        // 4. 幅: 細い (tolerance band)
        const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
        const isWarm = lab.a > -5 && lab.b > 20;
        const isHighSaturation = chroma > 30; // Body色は通常 chroma < 25
        const isCandidateGold =
            isWarm &&
            isHighSaturation &&
            l > 25 && l < 90 &&
            segWidth < medianWidth * 1.2 && // Goldは通常細い
            isAtEdge;

        if (isCandidateSilver) {
            const silverColor = RESISTOR_COLORS.find(c => c.name === 'Silver');
            if (silverColor) resistorColor = silverColor;
        } else if (isCandidateGold) {
            // 黄色やオレンジと迷いやすいGoldを、位置情報から積極的に採用する
            const goldColor = RESISTOR_COLORS.find(c => c.name === 'Gold');
            if (goldColor) resistorColor = goldColor;
        }

        // Additional check: If detected as Body color but has Gold-like characteristics, reconsider
        if (resistorColor.name.includes('(Body)') && isAtEdge) {
            const bodyChroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
            // If Body color at edge has high saturation and warm tone, likely Gold
            if (bodyChroma > 30 && lab.b > 25 && segWidth < medianWidth * 1.2) {
                const goldColor = RESISTOR_COLORS.find(c => c.name === 'Gold');
                if (goldColor) resistorColor = goldColor;
            }
        }

        const isMetallic = resistorColor.name.startsWith('Gold') || resistorColor.name === 'Silver';

        // 【改善ポイント2】輝度制限の動的緩和
        // 金属色（金色・銀色）の可能性がある場合は、白飛び(L>99)や影(L<5)を許容する
        if (!isMetallic && (l < 5 || l > 99)) return;

        // 【改善ポイント3】端のバンドに対する幅制限の緩和
        // 4バンド目の金色は、画像端で広く認識されやすいため、
        // 配列の最初や最後付近のセグメントは、2.5倍ルールから除外する
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
            chroma: chroma, // Add chroma for debugging Gold vs Body discrimination
        });
    });

    return finalBands.sort((a, b) => a.x - b.x);
}


async function handleLearnFromValue(request: Request, env: Env): Promise<Response> {
    try {
        const { detectedBands, correctValue, correctTolerance } = await request.json() as any;

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

    } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

function parseResistance(valueStr: string): number | null {
    if (!valueStr) return null;
    const str = String(valueStr).trim().toUpperCase();
    let multiplier = 1;
    let numericPart = str;

    if (str.endsWith('K')) { multiplier = 1000; numericPart = str.slice(0, -1); }
    else if (str.endsWith('M')) { multiplier = 1000000; numericPart = str.slice(0, -1); }

    const value = parseFloat(numericPart);
    return isNaN(value) ? null : value * multiplier;
}

function resistanceToColors(ohms: number, tolerance: string | null = null): string[] {
    if (ohms < 0.1) return [];

    const colorMap = [
        { name: 'Black', value: 0 }, { name: 'Brown', value: 1 }, { name: 'Red', value: 2 },
        { name: 'Orange', value: 3 }, { name: 'Yellow', value: 4 }, { name: 'Green', value: 5 },
        { name: 'Blue', value: 6 }, { name: 'Violet', value: 7 }, { name: 'Gray', value: 8 },
        { name: 'White', value: 9 }
    ];

    const toleranceMap: { [key: string]: string } = {
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


async function handleEdgeDetection(request: Request, env: Env): Promise<Response> {
    try {
        const { pixels, width, height, threshold } = await request.json() as { pixels: Pixel[], width: number, height: number, threshold: number };
        const customColors = env.LEARNING_STORE
            ? await env.LEARNING_STORE.get<CustomColor[]>("custom_colors", { type: "json" }) || []
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
            const widths = processedBands.map((b: any) => b.width).sort((a: number, b: number) => a - b);
            const medianWidth = widths[Math.floor(widths.length / 2)];

            // If a segment is > 2.5x the median width, it's highly likely to be the body or a gap
            processedBands = processedBands.map((b: any) => {
                if (b.width > medianWidth * 2.5) {
                    return { ...b, isBody: true };
                }
                return b;
            });
        }

        // 3. Filter out those marked as body
        const filteredBands = processedBands.filter((b: any) => !b.isBody);
        const filteredBandNames = filteredBands.map((b: any) => b.colorName);

        const resistorValue = calculateResistorValue(filteredBandNames);

        return new Response(JSON.stringify({
            success: true,
            bands: filteredBands,
            detected_bands: filteredBandNames,
            resistor_value: resistorValue
        }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e: any) {
        console.error(`[handleEdgeDetection] Error: ${e.message}`);
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}
