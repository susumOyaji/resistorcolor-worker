// Global state accessible by other scripts
window.lastEdgeDetectionResult = null;

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Global utility functions for Raw Worker Response
function toggleRawResponse() {
    const content = document.getElementById('raw-response-content');
    const icon = document.getElementById('raw-response-toggle-icon');

    if (!content || !icon) return;

    if (content.style.maxHeight === '0px' || content.style.maxHeight === '') {
        content.style.maxHeight = content.scrollHeight + 'px';
        icon.style.transform = 'rotate(180deg)';
    } else {
        content.style.maxHeight = '0px';
        icon.style.transform = 'rotate(0deg)';
    }
}

function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    if (!element) return;

    const text = element.textContent;
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('Failed to copy to clipboard');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('DOMContentLoaded fired for Resistor Color Extractor');

    // Elements
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const analysisSection = document.getElementById('analysis-section');
    const imagePreview = document.getElementById('image-preview');
    const changeImageBtn = document.getElementById('change-image-btn');
    const resetCropBtn = document.getElementById('reset-crop-btn');

    // State
    let currentImage = null;
    let cropper = null;

    // --- Event Listeners for Drag & Drop ---
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, preventDefaults, false));
    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
    ['dragenter', 'dragover'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over'), false));
    ['dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'), false));

    dropZone.addEventListener('drop', handleDrop, false);
    dropZone.addEventListener('click', () => fileInput.click(), true);
    fileInput.addEventListener('change', handleFiles);

    // --- Main Buttons ---
    const edgeDetectBtn = document.getElementById('edge-detect-btn');
    const edgeThresholdSlider = document.getElementById('edge-threshold-slider');
    const edgeThresholdValue = document.getElementById('edge-threshold-value');
    const thresholdDecrementBtn = document.getElementById('threshold-decrement-btn');
    const thresholdIncrementBtn = document.getElementById('threshold-increment-btn');

    const updateThreshold = (newValue) => {
        const value = Math.max(parseInt(edgeThresholdSlider.min, 10), Math.min(parseInt(edgeThresholdSlider.max, 10), newValue));
        edgeThresholdSlider.value = value;
        // Manually trigger input event to update the display
        edgeThresholdSlider.dispatchEvent(new Event('input', { bubbles: true }));
    };

    if (edgeThresholdSlider && edgeThresholdValue) {
        edgeThresholdSlider.addEventListener('input', (e) => {
            edgeThresholdValue.textContent = e.target.value;
        });
    }

    if (thresholdDecrementBtn) {
        thresholdDecrementBtn.addEventListener('click', () => {
            updateThreshold(parseInt(edgeThresholdSlider.value, 10) - 1);
        });
    }

    if (thresholdIncrementBtn) {
        thresholdIncrementBtn.addEventListener('click', () => {
            updateThreshold(parseInt(edgeThresholdSlider.value, 10) + 1);
        });
    }

    if (edgeDetectBtn) {
        edgeDetectBtn.addEventListener('click', () => {
            if (currentImage) performEdgeDetection();
            else console.error('No image loaded');
        });
    }

    const edgeLearningModeToggle = document.getElementById('edgeLearning-mode-toggle');
    const edgeLearningModeButton = document.getElementById('edge-learning-mode-button');
    const edgeLearningInputArea = document.getElementById('edge-learning-input-area');

    // Function to update the UI based on toggle state
    const updateLearningModeUI = () => {
        if (!edgeLearningModeToggle) return;
        const isChecked = edgeLearningModeToggle.checked;
        const container = edgeLearningInputArea;
        if (isChecked) {
            container.style.display = 'block';
            container.classList.add('learning-mode-active-container');
            container.style.animation = 'fadeIn 0.3s ease-out';
        } else {
            container.style.display = 'none';
            container.classList.remove('learning-mode-active-container');
        }
    };

    // Initial UI update
    if (edgeLearningModeToggle && edgeLearningInputArea) {
        updateLearningModeUI(); // Set initial state
        // Update UI when checkbox state changes
        edgeLearningModeToggle.addEventListener('change', updateLearningModeUI);
    }


    const edgeLearnFromValueBtn = document.getElementById('edge-learn-from-value-btn');
    const edgeCorrectResistanceInput = document.getElementById('edge-correct-resistance-input');
    const edgeCorrectToleranceSelect = document.getElementById('edge-correct-tolerance-select');
    const edgeLearningStatus = document.getElementById('edge-learning-status');
    if (edgeLearnFromValueBtn) {
        edgeLearnFromValueBtn.addEventListener('click', () => {
            const inputValue = edgeCorrectResistanceInput.value.trim();
            const toleranceValue = edgeCorrectToleranceSelect.value;
            if (!inputValue) {
                showToast('正しい抵抗値を入力してください');
                return;
            }
            if (!window.lastEdgeDetectionResult) {
                showToast('先にエッジ検出を実行してください');
                return;
            }
            if (typeof learnFromEdgeDetection === 'function') {
                learnFromEdgeDetection(inputValue, toleranceValue, edgeLearningStatus);
            } else {
                console.error('learnFromEdgeDetection function not found');
            }
        });
    }

    if (changeImageBtn) {
        changeImageBtn.addEventListener('click', () => {
            fileInput.value = '';
            fileInput.click();
        });
    }
    if (resetCropBtn) resetCropBtn.addEventListener('click', () => cropper ? cropper.reset() : null);

    // --- Core Functions ---

    function resetApp() {
        currentImage = null;
        if (cropper) {
            cropper.destroy();
            cropper = null;
        }
        imagePreview.src = '';
        fileInput.value = '';
        analysisSection.classList.add('hidden');
        dropZone.classList.remove('hidden');
        dropZone.style.display = 'block';
        const edgeResult = document.getElementById('edge-result');
        if (edgeResult) edgeResult.style.display = 'none';
        const edgeImageContainer = document.getElementById('edge-image-container');
        if (edgeImageContainer) edgeImageContainer.style.display = 'none';
    }

    function handleDrop(e) {
        handleFiles({ target: { files: e.dataTransfer.files } });
    }

    function handleFiles(e) {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            // Clear previous results immediately
            const edgeImageContainer = document.getElementById('edge-image-container');
            if (edgeImageContainer) edgeImageContainer.style.display = 'none';

            const edgeAnalyzedImage = document.getElementById('edge-analyzed-image');
            if (edgeAnalyzedImage) edgeAnalyzedImage.src = '';

            const edgeOverlay = document.getElementById('edge-overlay');
            if (edgeOverlay) edgeOverlay.innerHTML = '';

            const edgeResult = document.getElementById('edge-result');
            if (edgeResult) edgeResult.style.display = 'none';

            window.lastEdgeDetectionResult = null;

            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    currentImage = img;
                    imagePreview.src = img.src;
                    dropZone.classList.add('hidden');
                    dropZone.style.display = 'none';
                    analysisSection.classList.remove('hidden');
                    if (cropper) cropper.destroy();
                    cropper = new Cropper(imagePreview, {
                        aspectRatio: NaN,
                        viewMode: 1,
                        autoCropArea: 1,
                        responsive: true,
                        background: false,
                        dragMode: 'move'
                    });
                    setTimeout(() => analysisSection.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(file);
        } else {
            showToast('Please upload a valid image file.');
        }
    }

    async function performEdgeDetection() {
        if (!cropper) {
            showToast('Cropper not initialized!');
            return;
        }
        const canvas = cropper.getCroppedCanvas();
        if (!canvas) return;

        const edgeImageContainer = document.getElementById('edge-image-container');
        const edgeAnalyzedImage = document.getElementById('edge-analyzed-image');
        if (edgeAnalyzedImage && edgeImageContainer) {
            edgeAnalyzedImage.src = canvas.toDataURL();
            edgeImageContainer.style.display = 'block';
        }

        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = [];
        for (let i = 0; i < imageData.data.length; i += 4) {
            pixels.push({ r: imageData.data[i], g: imageData.data[i + 1], b: imageData.data[i + 2] });
        }

        const threshold = edgeThresholdSlider ? parseInt(edgeThresholdSlider.value, 10) : 1;

        // Prepare request data
        const requestData = { pixels, width: canvas.width, height: canvas.height, threshold };
        const endpoint = '/api/detect-edges';

        try {
            const startTime = Date.now();
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestData)
            });
            const endTime = Date.now();

            // Capture response for debugging
            const responseClone = response.clone();
            const data = await response.json();

            // Display raw worker response
            displayRawWorkerResponse({
                request: {
                    endpoint: endpoint,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: {
                        ...requestData,
                        pixels: `[${pixels.length} pixels - truncated for display]`
                    }
                },
                response: {
                    status: responseClone.status,
                    statusText: responseClone.statusText,
                    headers: Object.fromEntries(responseClone.headers.entries()),
                    body: data
                },
                metadata: {
                    timestamp: new Date().toISOString(),
                    duration: `${endTime - startTime}ms`
                }
            });

            if (!response.ok) {
                throw new Error(data.error || 'Edge detection failed');
            }

            window.lastEdgeDetectionResult = data;
            renderEdgeVisualization(data.bands, canvas.width, data.orientation, canvas.height);
            renderEdgeResult(data);
        } catch (error) {
            console.error('Error in edge detection:', error);
            showToast(`Error: ${error.message}`);
        }
    }

    // --- Raw Worker Response Functions ---
    function displayRawWorkerResponse(debugData) {
        const panel = document.getElementById('raw-response-panel');
        const requestEl = document.getElementById('raw-request-data');
        const responseEl = document.getElementById('raw-response-data');
        const statusEl = document.getElementById('response-status');
        const endpointEl = document.getElementById('response-endpoint');
        const timestampEl = document.getElementById('response-timestamp');

        if (!panel || !requestEl || !responseEl) return;

        // Show panel
        panel.style.display = 'block';

        // Format and display request
        requestEl.textContent = JSON.stringify(debugData.request, null, 2);

        // Format and display response
        responseEl.textContent = JSON.stringify(debugData.response.body, null, 2);

        // Display metadata
        if (statusEl) {
            statusEl.textContent = `${debugData.response.status} ${debugData.response.statusText}`;
            statusEl.style.color = debugData.response.status === 200 ? '#4ade80' : '#f87171';
        }
        if (endpointEl) endpointEl.textContent = debugData.request.endpoint;
        if (timestampEl) timestampEl.textContent = `${debugData.metadata.timestamp} (${debugData.metadata.duration})`;
    }

    function renderEdgeVisualization(bands, width, orientation, height) { // orientation, height引数を追加
        const edgeOverlay = document.getElementById('edge-overlay');
        if (!edgeOverlay) return;
        edgeOverlay.innerHTML = '';

        // 画像の表示領域の実際の寸法を使用
        const targetWidth = width;
        const targetHeight = height;


        bands.forEach(band => {
            const line = document.createElement('div');
            let lineStyle = `
                position: absolute;
                background: rgb(${band.rgb.r}, ${band.rgb.g}, ${band.rgb.b});
                box-shadow: 0 0 8px rgba(255, 255, 255, 0.8), 0 0 4px rgba(0, 0, 0, 0.5);
                pointer-events: none;
                z-index: 10;
            `;
            let labelStyle = `
                position: absolute;
                background: rgba(0, 0, 0, 0.9); color: white; padding: 4px 8px;
                border-radius: 4px; font-size: 10px; font-weight: bold; white-space: nowrap;
                display: flex; flex-direction: column; align-items: center; gap: 2px;
            `;
            let coordText;

            if (orientation === "horizontal") {
                lineStyle += `
                    left: ${(band.x / targetWidth) * 100}%;
                    transform: translateX(-50%);
                    top: 0;
                    width: 3px;
                    height: 100%;
                `;
                labelStyle += `
                    top: 5px; left: 50%; transform: translateX(-50%);
                `;
                coordText = `x: ${band.x}`;
            } else { // vertical
                lineStyle += `
                    top: ${(band.y / targetHeight) * 100}%;
                    transform: translateY(-50%);
                    left: 0;
                    height: 3px;
                    width: 100%;
                `;
                labelStyle += `
                    left: 5px; top: 50%; transform: translateY(-50%);
                `;
                coordText = `y: ${band.y}`;
            }

            line.style.cssText = lineStyle;
            const label = document.createElement('div');
            label.style.cssText = labelStyle;

            // Color name
            const colorNameSpan = document.createElement('span');
            colorNameSpan.textContent = band.colorName;
            colorNameSpan.style.cssText = 'font-size: 11px;';

            // Coordinate
            const coordSpan = document.createElement('span');
            coordSpan.textContent = coordText;
            coordSpan.style.cssText = 'font-size: 9px; opacity: 0.8; color: #fbbf24;';

            label.appendChild(colorNameSpan);
            label.appendChild(coordSpan);
            line.appendChild(label);
            edgeOverlay.appendChild(line);
        });
    }

    function renderEdgeResult(data) {
        const resultContainer = document.getElementById('edge-result');
        const valueEl = document.getElementById('edge-resistor-value');
        const bandsEl = document.getElementById('edge-detected-bands');
        const vizEl = document.getElementById('edge-visualization');

        if (!resultContainer || !valueEl || !bandsEl || !vizEl) return;

        resultContainer.style.display = 'block';
        if (data.resistor_value) {
            valueEl.textContent = data.resistor_value;
            bandsEl.innerHTML = `Detected sequence: <span style="color:white;">${data.detected_bands.join(' → ')}</span>`;
        } else {
            valueEl.textContent = "Detection Failed";
            bandsEl.innerHTML = `Detected bands: <span style="color:rgba(255,255,255,0.5);">${data.detected_bands ? data.detected_bands.join(' → ') : 'None'}</span>`;
        }

        vizEl.innerHTML = '';
        data.bands.forEach(band => {
            const chip = document.createElement('div');
            chip.className = 'band-chip';
            chip.style.cssText = `display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; background: rgba(${band.rgb.r}, ${band.rgb.g}, ${band.rgb.b}, 0.2); border: 2px solid rgb(${band.rgb.r}, ${band.rgb.g}, ${band.rgb.b}); border-radius: 8px; color: white; font-size: 0.9rem;`;

            // Determine chroma color indicator
            let chromaColor = '#94a3b8'; // default gray
            let chromaLabel = '';
            if (band.chroma !== undefined) {
                if (band.chroma > 30) {
                    chromaColor = '#4ade80'; // green - high saturation (Gold-like)
                    chromaLabel = 'High';
                } else if (band.chroma < 25) {
                    chromaColor = '#60a5fa'; // blue - low saturation (Body-like)
                    chromaLabel = 'Low';
                } else {
                    chromaColor = '#fbbf24'; // amber - medium
                    chromaLabel = 'Mid';
                }
            }

            chip.innerHTML = `
                <div style="width: 24px; height: 24px; background: rgb(${band.rgb.r}, ${band.rgb.g}, ${band.rgb.b}); border-radius: 4px; border: 1px solid rgba(255,255,255,0.3);"></div>
                <span>${band.colorName}</span>
                <span style="opacity: 0.6; font-size: 0.8rem;">#${((1 << 24) + (band.rgb.r << 16) + (band.rgb.g << 8) + band.rgb.b).toString(16).slice(1).toUpperCase()}</span>
                <span style="opacity: 0.5; font-size: 0.75rem;">(x: ${band.x})</span>
                ${band.chroma !== undefined ? `<span style="font-size: 0.7rem; padding: 2px 6px; background: rgba(0,0,0,0.3); border-radius: 3px; color: ${chromaColor};" title="Chroma (Saturation): ${band.chroma.toFixed(1)}">C: ${band.chroma.toFixed(1)} (${chromaLabel})</span>` : ''}
                <button class="learn-btn" style="margin-left: 0.5rem; background: #f59e0b; border: none; color: white; padding: 0.25rem 0.5rem; border-radius: 4px; cursor: pointer;">Learn</button>
            `;
            chip.querySelector('.learn-btn').addEventListener('click', () => openLearnModal(band));
            vizEl.appendChild(chip);
        });
    }

    function openLearnModal(band) {
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <span class="close-btn">&times;</span>
                <h2>Learn Color</h2>
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
                    <div style="width: 50px; height: 50px; background: rgb(${band.rgb.r}, ${band.rgb.g}, ${band.rgb.b}); border-radius: 8px; border: 2px solid white;"></div>
                    <div>
                        <p>Detected as: <strong>${band.colorName}</strong></p>
                        <p style="font-size: 0.8rem; opacity: 0.8;">RGB: ${band.rgb.r}, ${band.rgb.g}, ${band.rgb.b}</p>
                    </div>
                </div>
                <label for="correct-color-select">What is the correct color?</label>
                <select id="correct-color-select">
                    <option value="Black">Black</option>
                    <option value="Brown">Brown</option>
                    <option value="Red">Red</option>
                    <option value="Orange">Orange</option>
                    <option value="Yellow">Yellow</option>
                    <option value="Green">Green</option>
                    <option value="Blue">Blue</option>
                    <option value="Violet">Violet</option>
                    <option value="Gray">Gray</option>
                    <option value="White">White</option>
                    <option value="Beige (Body)">Beige (Body)</option>
                    <option value="Gold">Gold</option>
                    <option value="Silver">Silver</option>
                </select>
                <button id="save-learn-btn" class="analyze-btn" style="width: 100%; justify-content: center; margin-top: 1rem;">Save Learning</button>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.close-btn').addEventListener('click', () => modal.remove());
        modal.querySelector('#save-learn-btn').addEventListener('click', () => {
            const correctColorName = modal.querySelector('#correct-color-select').value;
            handleLearn(band.rgb, correctColorName);
            modal.remove();
        });
    }

    async function handleLearn(detectedColor, correctColorName) {
        try {
            const response = await fetch('/api/learn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ detectedColor, correctColorName })
            });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to learn color');
            }
            const data = await response.json();
            showToast(data.message || 'Learning saved!');
            // Re-run detection to show updated results
            performEdgeDetection();
        } catch (error) {
            console.error('Error in learning:', error);
            showToast(`Error: ${error.message}`);
        }
    }


    // --- Auto Crop Feature ---
    const autoCropBtn = document.getElementById('auto-crop-btn');
    if (autoCropBtn) {
        autoCropBtn.addEventListener('click', performAutoCrop);
    }

    function performAutoCrop() {
        if (!cropper || !currentImage) {
            showToast('画像がロードされていません');
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = currentImage.naturalWidth;
        canvas.height = currentImage.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(currentImage, 0, 0);

        const imgWidth = canvas.width;
        const imgHeight = canvas.height;
        const imageData = ctx.getImageData(0, 0, imgWidth, imgHeight);
        const data = imageData.data;

        // --- 向きの推定 (Worker側のestimateOrientationと同様のロジック) ---
        let orientation;
        if (imgWidth > imgHeight * 1.5) {
            orientation = "horizontal";
        } else if (imgHeight > imgWidth * 1.5) {
            orientation = "vertical";
        } else {
            orientation = "horizontal"; // デフォルト
        }

        let mainDim, crossDim;
        let mainCenter;

        if (orientation === "horizontal") {
            mainDim = imgWidth;
            crossDim = imgHeight;
            mainCenter = Math.floor(imgWidth / 2);
        } else { // vertical
            mainDim = imgHeight;
            crossDim = imgWidth;
            mainCenter = Math.floor(imgHeight / 2);
        }
        
        // クロス軸方向の走査範囲 (抵抗のボディ部分の平均色を捉えるため)
        // crossDim の10%から90%の範囲
        const crossAxisStart = Math.floor(crossDim * 0.1);
        const crossAxisEnd = Math.floor(crossDim * 0.9);

        // --- 汎用的なピクセル取得と平均色計算関数 ---
        function getPixelColor(x, y) {
            if (x < 0 || x >= imgWidth || y < 0 || y >= imgHeight) return { r: 0, g: 0, b: 0 };
            const idx = (y * imgWidth + x) * 4;
            return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
        }

        // mainCoord は走査軸方向の座標
        // crossAxisStart/End はクロス軸方向の平均化範囲
        function getAverageColor(mainCoord, crossStart, crossEnd) {
            let r = 0, g = 0, b = 0, count = 0;
            if (crossStart >= crossEnd) return { r: 0, g: 0, b: 0 };

            for (let crossCoord = crossStart; crossCoord < crossEnd; crossCoord++) {
                let pixel;
                if (orientation === "horizontal") {
                    pixel = getPixelColor(mainCoord, crossCoord); // mainCoordはX、crossCoordはY
                } else { // vertical
                    pixel = getPixelColor(crossCoord, mainCoord); // mainCoordはY、crossCoordはX
                }
                r += pixel.r; g += pixel.g; b += pixel.b;
                count++;
            }
            return count > 0 ? { r: r / count, g: g / count, b: b / count } : { r: 0, g: 0, b: 0 };
        }

        // ボディ色の推定（メイン軸の中心付近のクロス軸全体の平均）
        const bodyColor = getAverageColor(mainCenter, crossAxisStart, crossAxisEnd);

        const diffThreshold = 40; // 色差の閾値

        function isColorDifferent(color1, color2) {
            const diff = Math.abs(color1.r - color2.r) + Math.abs(color1.g - color2.g) + Math.abs(color1.b - color2.b);
            return diff > diffThreshold * 3;
        }

        let mainAxisStart = 0;
        let mainAxisEnd = mainDim;

        // メイン軸に沿ってボディ色の境界を検出
        for (let m = mainCenter; m >= 0; m -= 2) {
            if (isColorDifferent(bodyColor, getAverageColor(m, crossAxisStart, crossAxisEnd))) {
                mainAxisStart = m;
                break;
            }
        }
        for (let m = mainCenter; m < mainDim; m += 2) {
            if (isColorDifferent(bodyColor, getAverageColor(m, crossAxisStart, crossAxisEnd))) {
                mainAxisEnd = m;
                break;
            }
        }

        const detectedLength = mainAxisEnd - mainAxisStart;
        const padding = Math.floor(detectedLength * 0.1);
        let cropMainStart = mainAxisStart - padding;
        let cropMainLength = detectedLength + (padding * 2);

        // クロップ範囲の調整
        if (cropMainStart < 0) cropMainStart = 0;
        if (cropMainStart + cropMainLength > mainDim) cropMainLength = mainDim - cropMainStart;

        let cropX, cropY, cropWidth, cropHeight;

        if (orientation === "horizontal") {
            cropX = cropMainStart;
            cropY = 0; // Y方向全体をクロップ
            cropWidth = cropMainLength;
            cropHeight = imgHeight;
        } else { // vertical
            cropX = 0; // X方向全体をクロップ
            cropY = cropMainStart;
            cropWidth = imgWidth;
            cropHeight = cropMainLength;
        }

        const cropData = { x: cropX, y: cropY, width: cropWidth, height: cropHeight };
        cropper.setData(cropData);

        // Center the crop box visually without resetting zoom
        setTimeout(() => {
            const containerData = cropper.getContainerData();
            const canvasData = cropper.getCanvasData();
            const cropBoxData = cropper.getCropBoxData();

            // Calculate center points
            const containerCenterX = containerData.width / 2;
            const containerCenterY = containerData.height / 2;
            const boxCenterX = cropBoxData.left + (cropBoxData.width / 2);
            const boxCenterY = cropBoxData.top + (cropBoxData.height / 2);

            // Calculate the move delta
            const diffX = containerCenterX - boxCenterX;
            const diffY = containerCenterY - boxCenterY;

            // Move the canvas relatively to align centers
            cropper.setCanvasData({
                left: canvasData.left + diffX,
                top: canvasData.top + diffY
            });

            // Smooth scroll the preview container into view
            const previewContainer = document.querySelector('.image-preview-container');
            if (previewContainer) {
                previewContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 100);

        showToast('検出エリアを自動調整しました (Center-Out)');
    }
});
