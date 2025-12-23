# バンド検出画像のX座標表示機能

## 実装した改善内容

### 1. オーバーレイラベルへのX座標追加

バンド検出画像のオーバーレイに表示されるラベルに、X座標を追加表示しました。

#### Before (改善前)
```
┌─────────┐
│  Orange │
└─────────┘
```

#### After (改善後)
```
┌─────────┐
│  Orange │
│  x: 320 │
└─────────┘
```

### 実装コード

```javascript
// Color name
const colorNameSpan = document.createElement('span');
colorNameSpan.textContent = band.colorName;
colorNameSpan.style.cssText = 'font-size: 11px;';

// X coordinate
const xCoordSpan = document.createElement('span');
xCoordSpan.textContent = `x: ${band.x}`;
xCoordSpan.style.cssText = 'font-size: 9px; opacity: 0.8; color: #fbbf24;';

label.appendChild(colorNameSpan);
label.appendChild(xCoordSpan);
```

**表示スタイル**:
- カラー名: 11px、白色
- X座標: 9px、アンバー色(#fbbf24)、透明度80%
- 縦方向に配置(flex-direction: column)

### 2. Detection Resultへのchroma情報追加

各バンドチップに彩度(chroma)情報を追加し、Gold vs Body色の判定根拠を可視化しました。

#### 表示内容

```
┌────────────────────────────────────────────────────┐
│ 🟧 Orange #DA5B03 (x: 320) C: 48.2 (High) [Learn] │
└────────────────────────────────────────────────────┘
```

#### Chroma値の色分け

| Chroma値 | 色 | ラベル | 意味 |
|----------|-----|--------|------|
| **> 30** | 🟢 緑色 (#4ade80) | High | Gold候補 |
| **< 25** | 🔵 青色 (#60a5fa) | Low | Body色候補 |
| **25-30** | 🟡 アンバー (#fbbf24) | Mid | 中間 |

### 実装コード

```javascript
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

// Display chroma info
${band.chroma !== undefined ? 
    `<span style="font-size: 0.7rem; padding: 2px 6px; background: rgba(0,0,0,0.3); 
     border-radius: 3px; color: ${chromaColor};" 
     title="Chroma (Saturation): ${band.chroma.toFixed(1)}">
     C: ${band.chroma.toFixed(1)} (${chromaLabel})
    </span>` 
    : ''}
```

## 使用方法

### 1. バンド検出を実行

1. 画像をアップロード
2. 「バンド検出」ボタンをクリック
3. 検出された画像のオーバーレイを確認

### 2. X座標の確認

各バンドの垂直線上に表示されるラベルで確認:
- **上段**: カラー名(白色)
- **下段**: X座標(アンバー色)

### 3. Chroma情報の確認

Detection Resultのバンドチップで確認:
- **緑色(High)**: 高彩度 → Gold候補
- **青色(Low)**: 低彩度 → Body色候補
- **アンバー(Mid)**: 中間

マウスオーバーでツールチップに詳細な数値が表示されます。

## デバッグ活用例

### ケース1: Goldの誤判定を確認

```
検出結果:
┌────────────────────────────────────────────┐
│ 🟧 Tan (Body) #D2B48C (x: 480) C: 22.3 (Low) │
└────────────────────────────────────────────┘
```

**分析**:
- X座標: 480 → 画像の端
- Chroma: 22.3 (Low) → Body色の特徴
- **判定**: 正しくBody色と判定

### ケース2: Goldの正常検出

```
検出結果:
┌────────────────────────────────────────────┐
│ 🟡 Gold #FFD700 (x: 485) C: 48.5 (High) │
└────────────────────────────────────────────┘
```

**分析**:
- X座標: 485 → 画像の端
- Chroma: 48.5 (High) → Goldの特徴
- **判定**: 正しくGoldと判定

### ケース3: 位置情報の活用

```
検出結果:
┌────────────────────────────────────────────┐
│ 🟧 Orange #DA5B03 (x: 120) C: 48.2 (High) │
│ 🟢 Green #008000 (x: 240) C: 35.1 (High)  │
│ 🟡 Gold #FFD700 (x: 480) C: 47.8 (High)   │
└────────────────────────────────────────────┘
```

**分析**:
- Orange (x: 120): 中央付近 → 値バンド
- Green (x: 240): 中央付近 → 値バンド
- Gold (x: 480): 端 → 許容差バンド

## 改善効果

### Before (改善前)

- ❌ X座標が不明 → 位置判定の根拠が不明
- ❌ Chroma情報なし → Gold vs Body判定の根拠が不明
- ❌ デバッグが困難

### After (改善後)

- ✅ X座標を視覚的に確認可能
- ✅ Chroma値で判定根拠を可視化
- ✅ 色分けで直感的に理解可能
- ✅ デバッグが容易

## トラブルシューティング

### Q1: X座標が表示されない

**確認事項**:
- サーバーが最新のコードで起動しているか
- ブラウザのキャッシュをクリアしたか

**解決方法**:
```bash
# サーバーを再起動
Ctrl+C
npm start
```

### Q2: Chroma情報が表示されない

**原因**: サーバー側でchroma情報が計算されていない

**確認方法**:
1. Raw Worker Responseを開く
2. `bands`配列に`chroma`フィールドがあるか確認

### Q3: 色分けが正しく表示されない

**確認事項**:
- `band.chroma`の値が正しいか
- 閾値(30, 25)が適切か

## まとめ

バンド検出画像にX座標とChroma情報を追加表示することで:

1. **位置情報の可視化** - 端のバンド判定の根拠が明確に
2. **彩度情報の可視化** - Gold vs Body色の判定根拠が明確に
3. **デバッグの効率化** - 問題箇所を素早く特定可能
4. **直感的な理解** - 色分けで一目で判断可能

これにより、検出精度の検証とトラブルシューティングが大幅に改善されました。
