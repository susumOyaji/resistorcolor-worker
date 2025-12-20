function extractBands(pixels, width, height, colorChangeThreshold, customColors = []) {
    // ... (前段の平均化ロジックはそのまま) ...

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