// This file was previously empty. It will now contain the logic for the "Learn from Value" feature.

async function learnFromEdgeDetection(correctValue, toleranceValue, statusElement) {
    console.log('learnFromEdgeDetection called with value:', correctValue, 'and tolerance:', toleranceValue);
    
    if (!window.lastEdgeDetectionResult || !window.lastEdgeDetectionResult.bands || window.lastEdgeDetectionResult.bands.length === 0) {
        showToast('先に「バンド検出」を実行して、有効なバンドを見つける必要があります。');
        return;
    }

    if (!correctValue) {
        showToast('有効な抵抗値を入力してください。');
        return;
    }

    // Clear previous status and show loading
    statusElement.textContent = '学習中...';
    statusElement.style.color = '#fbbf24'; // Orange for pending

    try {
        const response = await fetch('/api/learn-from-value', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                detectedBands: window.lastEdgeDetectionResult.bands,
                correctValue: correctValue,
                correctTolerance: toleranceValue
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || 'サーバーで学習処理に失敗しました。');
        }

        const result = await response.json();
        console.log('Server learning response:', result);
        
        statusElement.textContent = '学習が完了しました！';
        statusElement.style.color = '#4ade80'; // Green for success
        showToast('学習が完了しました。再度分析を実行して結果を確認してください。');

    } catch (error) {
        console.error('Error in learnFromEdgeDetection:', error);
        statusElement.textContent = '学習に失敗しました。';
        statusElement.style.color = '#f87171'; // Red for error
        showToast(`学習エラー: ${error.message}`);
    }
}
