# ImagePress 代码审计报告（第三轮）

**审计日期**: 2026-08-02  
**审计范围**: 全部源代码  
**审计重点**: 安全漏洞、性能问题、代码质量、可访问性、测试覆盖  
**测试状态**: 47 tests passed (2 test files)  
**构建状态**: Build succeeded, compressWorker 已独立分包 (3.35 kB)

**说明**: 前两轮审计中发现的问题（文件限制、CSP、Error Boundary、ARIA、Canvas 释放、useCallback、竞态修复等）均已修复。本轮聚焦于**当前代码中仍存在的遗留问题**。

---

## 一、可访问性问题

### 1.1 HTML lang 属性与实际语言不符 🔴 严重

**位置**: `index.html` 第 2 行

**问题**:
```html
<html lang="en">
```
页面内容全部为中文，但 `lang` 属性设置为 `"en"`。这会导致：
- 屏幕阅读器使用英文发音规则朗读中文内容
- 浏览器翻译功能误判页面语言
- 不符合 WCAG 2.1 成功标准 3.1.1（语言标识）

**建议**:
```html
<html lang="zh-CN">
```

---

## 二、健壮性问题

### 2.1 compressCore 错误路径未释放 Canvas 🟡 中等

**位置**: `src/lib/compressCore.js` - `compressCore` 函数

**问题**: Canvas 内存释放代码（`canvas.width = 0; canvas.height = 0`）位于函数末尾（第 302-304 行），但如果 `encodeAt`、`searchByScale`、`edgeRefine` 等中间步骤抛出异常，这些释放代码不会被执行。虽然异常后函数退出，局部变量可被 GC，但 Canvas 的内部位图缓冲区可能不会立即释放。

**建议**: 使用 `try/finally` 确保 Canvas 始终被清理：
```javascript
export async function compressCore(img, options, callbacks = {}) {
  // ... 参数解构 ...
  const canvas = createCanvas();
  try {
    // ... 全部压缩逻辑 ...
    return { blob: bestBlob, ... };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
```

### 2.2 compressWorker 不处理未知消息类型 🟢 轻微

**位置**: `src/lib/compressWorker.js` - `self.onmessage`

**问题**:
```javascript
self.onmessage = async (e) => {
  const { type } = e.data;
  if (type === "abort") { ... return; }
  if (type !== "compress") return;  // 静默忽略
  // ...
};
```
如果主线程意外发送了未知类型的消息（如 `{ type: "unknown" }`），Worker 会静默忽略，不会有任何日志或错误反馈。虽然当前代码路径不会产生这种情况，但缺少防御性检查。

**建议**: 添加 `console.warn` 记录未知消息：
```javascript
if (type !== "compress") {
  console.warn("[compressWorker] 未知消息类型:", type);
  return;
}
```

---

## 三、代码质量问题

### 3.1 fallback 兜底路径与 searchByScale 重复 🟡 中等

**位置**: `src/lib/compressCore.js` - `compressCore` 函数（第 291-293 行）

**问题**:
```javascript
if (!bestBlob) {
  bestBlob = await encodeAt(0.05, usePng ? undefined : 0.1);
}
```
此兜底路径在以下情况被触发：
- PNG: `searchByScale(undefined, 8, ...)` 返回 `null`（所有迭代都超标）
- JPEG `!bestFit`: `searchByScale(0.85, 8, ...)` 返回 `null`

但 `searchByScale` 的二分搜索起始 `lo = 0.05`，即第一次迭代就是 0.05 缩放。如果 0.05 缩放仍超标，搜索会收敛到 `hi = 0.05`，`best` 保持 `null`。此时兜底路径再次调用 `encodeAt(0.05, ...)` 是冗余的（PNG 路径完全重复，JPEG 路径仅 quality 不同）。

**建议**: 添加注释说明意图，或移除 PNG 路径的冗余调用：
```javascript
if (!bestBlob) {
  // PNG: 与 searchByScale 最小迭代完全相同，可安全移除
  // JPEG: quality 0.1 低于 searchByScale 使用的 0.85，可产出更小文件
  if (!usePng) {
    bestBlob = await encodeAt(0.05, 0.1);
  }
}
```

### 3.2 fileToImage 与 fileToImageBitmap 重复 RAW/DNG 防御检查 🟢 轻微

**位置**: `src/lib/imageCompress.js` - `fileToImage`（第 89-92 行）和 `fileToImageBitmap`（第 104-107 行）

**问题**: 两个函数都包含相同的 RAW/DNG 防御性 `console.warn` 检查。由于 RAW/DNG 已在上层 `isSupportedImage` 中被过滤，这两处检查永远不会触发，且代码完全重复。

**建议**: 提取为共享的防御性工具函数，或仅在 `fileToImage`（主线程回退路径）中保留：
```javascript
function warnIfRaw(file) {
  const ext = getExtension(file.name).toLowerCase();
  if ([".raw", ".dng", ".cr2", ".nef", ".arw", ".orf", ".rw2"].includes(ext)) {
    console.warn(`Unexpected RAW/DNG file: ${file.name}`);
  }
}
```

### 3.3 downloadAll 未使用 useCallback 🟢 轻微

**位置**: `src/pages/Index.jsx` - `downloadAll` 函数（第 610 行）

**问题**: `downloadAll` 是组件内的普通 async 函数，未用 `useCallback` 包裹。它引用了 `doneFiles`（`useMemo` 结果）和 `downloadSingle`。虽然作为按钮点击处理器性能影响极小，但与组件中其他回调（`downloadSingle`、`clearAll`、`retryFile` 等）的风格不一致。

**建议**: 包裹 `useCallback` 或转为 ref 模式以保持风格统一。

### 3.4 数字输入缺少上限约束 🟢 轻微

**位置**: `src/pages/Index.jsx` - 目标大小输入框（第 786-794 行）

**问题**:
```jsx
<Input
  type="number"
  min="0.1"
  step="0.1"
  value={maxSizeInput}
  // ...
/>
```
输入框设置了 `min="0.1"` 但没有 `max` 属性。用户可以输入极大值（如 99999 MB），虽然不会导致安全问题（文件大小限制 200MB 仍生效），但预设按钮最大仅 100MB，输入框与预设按钮的上限不一致。

**建议**: 添加 `max` 属性与 `MAX_FILE_SIZE` 对齐：
```jsx
<Input
  type="number"
  min="0.1"
  max="200"
  step="0.1"
  // ...
/>
```

### 3.5 全部文件被跳过时下载区域不显示 🟢 轻微

**位置**: `src/pages/Index.jsx` - `hasResults` 逻辑（第 363 行）

**问题**:
```javascript
const hasResults = doneFiles.length > 0;
const doneFiles = useMemo(
  () => files.filter((f) => f.status === "done" && !f.result?.skipped),
  [files],
);
```
当所有文件都小于目标大小（全部被跳过）时，`doneFiles` 为空，`hasResults` 为 `false`，第 4 步"下载结果"区域不会显示。但压缩统计区域（第 3 步）会显示"跳过 X 张"。用户看到"跳过"提示但没有下载入口，体验不够完整。

**建议**: 将 `hasResults` 改为包含 skipped 文件：
```javascript
const hasResults = useMemo(
  () => files.some((f) => f.status === "done"),
  [files],
);
```

---

## 四、依赖与构建

### 4.1 未使用的 npm 依赖 🟢 轻微

**位置**: `package.json`

**问题**: 以下依赖已安装但代码中未使用：
- `clsx` — 仅在 `src/lib/utils.js` 的 `cn()` 中使用，但 `cn()` 未被任何组件引用
- `tailwind-merge` — 同上

**建议**: 如果确认不再使用 `cn()` 工具函数，可移除这两个依赖以减小 `node_modules` 和 lockfile 体积：
```bash
npm uninstall clsx tailwind-merge
```

### 4.2 heic2any 分包体积警告 🟢 轻微

**位置**: 构建输出

**问题**: 构建时产生警告：
```
(!) Some chunks are larger than 500 kB after minification.
dist/assets/heic2any-D2NZtvkm.js  1,352.84 kB │ gzip: 341.21 kB
```
虽然 `heic2any` 已通过动态导入实现代码分割（不影响首屏），但 1.35MB 的单独 chunk 仍可能影响 HEIC 文件处理时的加载体验。

**建议**: 可通过 `vite.config.js` 的 `build.chunkSizeWarningLimit` 提高阈值以消除警告（因为这是预期行为），或考虑替换为更轻量的 HEIC 解码库。

---

## 五、代码风格

### 5.1 压缩统计区域缩进不一致 🟢 轻微

**位置**: `src/pages/Index.jsx` - 错误文件统计区块（第 1161-1173 行）

**问题**: `errorFiles.length > 0` 区块的缩进与同级元素不一致：
```jsx
										{skippedFiles.length > 0 && (
											// 6 级缩进
										)}
							{errorFiles.length > 0 && (
								// 3 级缩进 ← 不一致
							)}
										{totalCompressed > 0 && (
											// 6 级缩进
										)}
```

**建议**: 统一为 6 级 tab 缩进，与相邻条件分支对齐。

---

## 六、总结

### 问题统计

| 严重程度 | 数量 | 类别 |
|---------|------|------|
| 🔴 严重 | 1 | 可访问性 |
| 🟡 中等 | 2 | 健壮性、代码质量 |
| 🟢 轻微 | 8 | 代码质量、依赖、构建、风格 |

### 与前两轮对比

| 轮次 | 🔴 严重 | 🟡 中等 | 🟢 轻微 | 总计 |
|------|---------|---------|---------|------|
| 第一轮 | 2 | 7 | 11 | 20 |
| 第二轮 | 2 | 6 | 10 | 18 |
| 第三轮 | 1 | 2 | 8 | 11 |

问题总数逐轮递减，代码质量持续提升。

### 优先处理建议

1. **立即修复**（工作量极小，收益显著）:
   - `index.html` 的 `lang="en"` 改为 `lang="zh-CN"`

2. **近期优化**:
   - `compressCore` 添加 `try/finally` 确保 Canvas 清理
   - 修复 `hasResults` 逻辑，全部跳过时仍显示下载区域
   - 数字输入框添加 `max="200"`

3. **长期改进**:
   - 清理未使用的 `clsx`/`tailwind-merge` 依赖
   - 统一代码缩进风格
   - 消除 fallback 兜底路径的冗余逻辑

### 总体评价

经过三轮审计和修复，代码质量已达到较高水平：
- **架构**: 核心压缩逻辑已抽取为独立的 `compressCore.js`，支持 Web Worker 和主线程双路径执行，模块职责清晰
- **安全**: CSP 策略完整，所有文件处理在浏览器本地完成，无数据外泄风险
- **性能**: Web Worker 执行压缩避免主线程阻塞，`heic2any` 动态导入实现代码分割，Worker 分包仅 3.35 kB
- **测试**: 47 个测试覆盖了核心压缩逻辑（JPEG/PNG 二分搜索、中断、进度回调、Canvas 内存释放），测试质量良好
- **可访问性**: ARIA 标签、键盘导航已添加，仅剩 `lang` 属性需修正

剩余 11 个问题均为低优先级，不影响核心功能，可按团队节奏逐步处理。
