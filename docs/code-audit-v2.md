# ImagePress 代码审计报告（第四轮）

**审计日期**: 2026-08-02  
**审计范围**: 全部源代码  
**审计重点**: 安全漏洞、性能问题、健壮性、代码质量、可访问性、用户体验  
**测试状态**: 49 tests passed (2 test files)  
**构建状态**: Build succeeded，compressWorker 3.41 kB，heic2any 分包 1.35 MB（无警告）

**说明**: 第三轮审计中发现的全部 11 个问题均已修复。本轮聚焦于修复后代码中仍存在的遗留问题与新发现的问题。

---

## 〇、第三轮修复验证

| 第三轮问题编号 | 问题描述 | 修复状态 |
|--------------|---------|---------|
| 1.1 | `index.html` `lang="en"` 与实际语言不符 | ✅ 已改为 `lang="zh-CN"` |
| 2.1 | `compressCore` 异常路径未释放 Canvas | ✅ 已添加 `try/finally`（第 228-317 行） |
| 2.2 | `compressWorker` 静默忽略未知消息类型 | ✅ 已添加 `console.warn`（第 25 行） |
| 3.1 | fallback 兜底路径与 `searchByScale` 重复 | ✅ 已添加意图注释（第 292-296 行） |
| 3.2 | `fileToImage`/`fileToImageBitmap` 重复 RAW/DNG 检查 | ✅ 已提取为共享 `warnIfRaw` 函数（第 86-91 行） |
| 3.3 | `downloadAll` 未使用 `useCallback` | ✅ 已包裹 `useCallback`（第 610 行） |
| 3.4 | 数字输入缺少上限约束 | ✅ 已添加 `max="200"`（第 789 行） |
| 3.5 | 全部文件被跳过时下载区域不显示 | ✅ `hasResults` 已包含 `skippedFiles`（第 363 行） |
| 4.1 | 未使用的 `clsx`/`tailwind-merge` 依赖 | ✅ 非问题 — `cn()` 被 40+ 个 shadcn/ui 组件使用 |
| 4.2 | `heic2any` 分包体积警告 | ✅ 已设置 `chunkSizeWarningLimit: 1500` |
| 5.1 | 压缩统计区域缩进不一致 | ✅ 已统一缩进 |

---

## 一、健壮性问题

### 1.1 `handleSizeInputChange` 不验证上限 🟡 中等

**位置**: `src/pages/Index.jsx` 第 649-653 行

**问题**:
```javascript
const handleSizeInputChange = (val) => {
    setMaxSizeInput(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0) setMaxSizeMB(num);
};
```

输入框 HTML 已设置 `max="200"`（第 789 行），但 `max` 属性仅作为浏览器 Spinner 的视觉提示，**不阻止用户手动输入超过 200 的值**。`handleSizeInputChange` 只检查了 `num > 0`，未检查上限。用户可以输入 `999`、`99999` 等极大值，这些值会被直接设置为 `maxSizeMB`。

虽然 `MAX_FILE_SIZE`（200MB）的上传限制仍生效，不会导致安全问题，但超大目标值会让压缩失去意义（目标远大于源文件），且与预设按钮（最大 100MB）的上限不一致。

**建议**: 在 `handleSizeInputChange` 中添加上限校验：
```javascript
const handleSizeInputChange = (val) => {
    setMaxSizeInput(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0 && num <= 200) setMaxSizeMB(num);
};
```

或在输入失焦时做 clamp：
```javascript
const handleSizeBlur = () => {
    const num = parseFloat(maxSizeInput);
    if (isNaN(num) || num < 0.1) { setMaxSizeInput("0.1"); setMaxSizeMB(0.1); }
    else if (num > 200) { setMaxSizeInput("200"); setMaxSizeMB(200); }
};
```

---

### 1.2 Worker 无超时机制 🟡 中等

**位置**: `src/lib/imageCompress.js` - `compressViaWorker` 函数（第 133-181 行）

**问题**:
```javascript
function compressViaWorker(bitmap, options, { onProgress, shouldAbort }) {
    return new Promise((resolve, reject) => {
        // ... 创建 Worker ...
        worker.onmessage = (e) => { /* resolve/reject */ };
        worker.onerror = (err) => { /* reject */ };
        worker.postMessage({ type: "compress", bitmap, options }, [bitmap]);
    });
}
```

`compressViaWorker` 返回的 Promise 完全依赖 Worker 的 `onmessage` 和 `onerror` 回调来 resolve/reject。如果 Worker 因以下原因未响应：
- 浏览器内存压力导致 Worker 被静默终止
- `compressCore` 内部出现死循环（理论上不会，但缺乏防御）
- 浏览器安全策略终止 Worker 线程

则 Promise 将永远处于 pending 状态，导致 UI 卡在"正在压缩..."界面无法恢复。`handleCompress` 的 `finally` 块虽然会重置 `isCompressing`，但仅在 `Promise.all(workers)` resolve/reject 后才执行——如果某个 Worker 的 Promise 永远 pending，`Promise.all` 也会永远 pending。

**建议**: 添加超时机制：
```javascript
function compressViaWorker(bitmap, options, { onProgress, shouldAbort }) {
    return new Promise((resolve, reject) => {
        let worker;
        let timeoutId;

        try {
            worker = new Worker(/* ... */, { type: "module" });
        } catch (e) {
            reject(new Error("Failed to create worker: " + e.message));
            return;
        }

        // 超时保护：120 秒无响应则终止
        timeoutId = setTimeout(() => {
            worker.terminate();
            reject(new Error("压缩超时"));
        }, 120000);

        worker.onmessage = (e) => {
            const { type } = e.data;
            if (type === "progress") {
                onProgress?.(e.data.progress);
                if (!shouldAbort?.()) { /* ... */ }
                else { worker.postMessage({ type: "abort" }); }
            } else if (type === "done") {
                clearTimeout(timeoutId);
                worker.terminate();
                resolve(e.data.result);
            } else if (type === "error") {
                clearTimeout(timeoutId);
                worker.terminate();
                // ... reject ...
            }
        };

        worker.onerror = (err) => {
            clearTimeout(timeoutId);
            worker.terminate();
            reject(new Error("Worker error: " + (err.message || "unknown")));
        };

        worker.postMessage({ type: "compress", bitmap, options }, [bitmap]);
    });
}
```

注意：超时时间应根据文件大小动态调整，或设为足够大的固定值（如 120 秒），并确保 `shouldAbort`（暂停检查）仍能在超时前介入。

---

### 1.3 组件卸载时未终止进行中的压缩 🟡 中等

**位置**: `src/pages/Index.jsx` - `useEffect` 清理（第 659-665 行）

**问题**:
```javascript
useEffect(() => {
    return () => {
        filesRef.current.forEach((f) => {
            if (f.preview) URL.revokeObjectURL(f.preview);
        });
    };
}, []);
```

组件卸载时的清理逻辑仅释放了预览 URL，未终止进行中的压缩任务。如果用户在压缩过程中离开页面（虽然当前是单页应用只有一个路由，但未来可能扩展），已创建的 Worker 会在后台继续运行，浪费 CPU 和内存资源。

此外，`handleCompress` 中的 `setFiles`/`setIsCompressing` 等 state 更新在组件卸载后会触发 React 警告（"Can't perform a React state update on an unmounted component"）。

**建议**: 添加 `AbortController` 或卸载标志：
```javascript
const isMountedRef = useRef(true);

useEffect(() => {
    return () => {
        isMountedRef.current = false;
        filesRef.current.forEach((f) => {
            if (f.preview) URL.revokeObjectURL(f.preview);
        });
    };
}, []);

// 在 handleCompress 的 updateFile 中检查：
const updateFile = (id, updates) => {
    if (!isMountedRef.current) return; // 卸载后不再更新
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)));
};
```

---

## 二、代码质量问题

### 2.1 多个事件处理器未包裹 `useCallback` 🟢 轻微

**位置**: `src/pages/Index.jsx`

**问题**: 组件中以下函数未使用 `useCallback` 包裹：

| 函数名 | 行号 | 说明 |
|--------|------|------|
| `handleFileSelect` | 426 | 文件选择 `onChange` |
| `handleFolderSelect` | 430 | 文件夹选择 `onChange` |
| `handleDragOver` | 434 | 拖拽悬停 `onDragOver` |
| `handleDragLeave` | 439 | 拖拽离开 `onDragLeave` |
| `handleSizeInputChange` | 649 | 目标大小输入 `onChange` |
| `applyPreset` | 654 | 预设按钮 `onClick` |

而以下函数已使用 `useCallback`：
- `handleDrop`（第 445 行）
- `removeFile`、`clearAll`、`retryFile`、`retryAllFailed`
- `handleCompress`、`downloadSingle`、`downloadAll`
- `loadMore`、`loadAll`、`addFiles`、`waitIfPaused`、`togglePause`

风格不一致，每次组件渲染时未包裹的函数会创建新实例。虽然对 DOM 事件处理器性能影响极小（React 事件委托），但如果这些函数被传给 `memo` 子组件或 `useEffect` 依赖数组，可能导致不必要的重渲染或 effect 重复执行。

**建议**: 为保持风格一致，可将上述函数统一包裹 `useCallback`，或将简单的一次性函数内联到 JSX 中。

---

### 2.2 "输出质量" 标签语义混淆 🟢 轻微

**位置**: `src/pages/Index.jsx` 第 827-828 行（标签）与第 851 行（说明文字）

**问题**:
```jsx
<label className="text-sm" style={{ color: C.inkMuted }}>
    输出质量
</label>
```

UI 中的"输出质量"滑块实际上控制的是目标大小的百分比，而非 JPEG 编码质量：
```javascript
// imageCompress.js 第 188 行
const effectiveMaxSizeMB = maxSizeMB * (quality / 100);
```

`quality = 50` 意味着目标大小减半（`maxSizeMB * 0.5`），而不是 JPEG quality = 0.5。而 `compressCore` 内部的 JPEG quality 二分搜索起始范围为 `[0.5, 1.0]`，与滑块的"质量"概念无关。

说明文字 `100% = 压缩到 {maxSizeMB}MB。降低百分比可进一步缩小文件` 部分澄清了行为，但"输出质量"这一标签本身容易让用户误解为图像画质控制。

**建议**: 将标签改为更准确的描述，如"目标比例"或"压缩强度"：
```jsx
<label className="text-sm" style={{ color: C.inkMuted }}>
    目标比例
</label>
```

---

### 2.3 `compressViaWorker` 每次创建新 Worker 实例 🟢 轻微

**位置**: `src/lib/imageCompress.js` - `compressViaWorker`（第 137 行）

**问题**:
```javascript
worker = new Worker(
    new URL("./compressWorker.js", import.meta.url),
    { type: "module" },
);
```

每次调用 `compressImage` 都会创建一个新的 Worker 实例，压缩完成后 `terminate()`。在批量压缩 100 个文件、并发度为 3 的场景下，最多会创建 100 个 Worker 实例（虽然同时只有 3 个活跃）。Worker 的创建/销毁开销包括：
- 模块解析（`compressWorker.js` 导入 `compressCore`）
- 线程创建
- OffscreenCanvas 上下文初始化

对于批量处理大量小文件，这个开销可能成为瓶颈。

**建议**: 实现 Worker 池（Pool），复用固定数量的 Worker 实例：
```javascript
class WorkerPool {
    constructor(size) {
        this.workers = Array.from({ length: size }, () =>
            new Worker(new URL("./compressWorker.js", import.meta.url), { type: "module" })
        );
        this.queue = [];
    }

    async run(bitmap, options, callbacks) {
        const worker = this.workers.pop() || await this.waitForFree();
        // ... 执行压缩 ...
        this.workers.push(worker);
    }
}
```

注意：Worker 池需要处理消息路由（区分不同压缩任务的响应），实现复杂度较高。对于当前 100 文件上限的场景，每次创建 Worker 的总开销仍在可接受范围。

---

### 2.4 `downloadAll` 打包大量文件时内存峰值高 🟢 轻微

**位置**: `src/pages/Index.jsx` - `downloadAll`（第 610-647 行）

**问题**:
```javascript
const zip = new JSZip();
for (const f of doneFiles) {
    if (f.result) zip.file(f.result.fileName, f.result.blob);
}
const content = await zip.generateAsync({ type: "blob" }, ...);
```

`JSZip` 将所有文件的 Blob 数据加载到内存中，再生成 ZIP Blob。对于 100 个文件、每个压缩后 5-10MB 的情况，内存峰值约为 500MB-1GB（原始 Blob + ZIP 缓冲）。在移动端或低配设备上可能导致浏览器标签页崩溃。

此外，如果 `doneFiles` 中存在同名文件（如两个 `photo.jpg`），JSZip 会静默覆盖，用户只会得到一个文件。

**建议**:
1. 大量文件时考虑分批打包或使用流式生成（`zip.generateInternalStream`）。
2. 对同名文件添加后缀去重：
```javascript
const nameMap = new Map();
for (const f of doneFiles) {
    if (!f.result) continue;
    let name = f.result.fileName;
    if (nameMap.has(name)) {
        const count = nameMap.get(name) + 1;
        nameMap.set(name, count);
        const dot = name.lastIndexOf(".");
        name = dot > 0
            ? `${name.slice(0, dot)} (${count})${name.slice(dot)}`
            : `${name} (${count})`;
    } else {
        nameMap.set(name, 1);
    }
    zip.file(name, f.result.blob);
}
```

---

## 三、可访问性问题

### 3.1 拖拽区域键盘操作后焦点管理缺失 🟢 轻微

**位置**: `src/pages/Index.jsx` 第 884-892 行

**问题**:
```jsx
<div
    role="button"
    tabIndex={0}
    aria-label="拖拽图片或文件夹到此处，或点击选择文件"
    onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
        }
    }}
    // ...
>
```

按 Enter/空格触发文件选择对话框后，焦点丢失——文件对话框关闭后焦点不会自动回到拖拽区域，而是回到 body。键盘用户需要重新 Tab 才能回到操作位置。

**建议**: 对话框关闭后将焦点还原：
```jsx
onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInputRef.current?.click();
        // 焦点还原（文件对话框关闭后执行）
        setTimeout(() => e.currentTarget.focus(), 0);
    }
}}
```

注意：`fileInput.click()` 打开的文件对话框是模态的，`setTimeout` 会在对话框关闭后才执行。

---

### 3.2 预览图缺少 `loading="lazy"` 以外的懒加载策略 🟢 轻微

**位置**: `src/pages/Index.jsx` 第 182-187 行

**问题**:
```jsx
<img
    src={preview}
    alt={file.name}
    className="w-full h-full object-cover"
    loading="lazy"
/>
```

`loading="lazy"` 在列表中效果好，但当文件列表很长（100 个文件）且用户点击"全部加载"时，所有预览图会同时加载，可能导致大量 Object URL 同时请求解码。虽然浏览器有并发请求限制（通常 6 个），但内存中的 Object URL 引用仍然存在。

**建议**: 可配合 `IntersectionObserver` 实现真正的视口内懒加载，或对"全部加载"场景加 debounce。但当前 `loading="lazy"` 已满足基本需求，此为优化建议。

---

## 四、测试覆盖

### 4.1 Worker 通信路径缺少测试 🟡 中等

**位置**: `src/lib/compressWorker.js` 与 `src/lib/imageCompress.js` - `compressViaWorker`

**问题**: 当前 49 个测试全部针对 `compressCore`（核心压缩逻辑）和 `imageCompress`（工具函数），但以下路径完全没有测试覆盖：

- **Worker 消息协议**: `{ type: "compress" }` / `{ type: "abort" }` / `{ type: "progress" }` / `{ type: "done" }` / `{ type: "error" }` 的消息收发
- **`compressViaWorker` 的 Promise resolve/reject 路径**: Worker 正常完成、Worker 错误、Worker 创建失败
- **ImageBitmap 转移**: `postMessage(..., [bitmap])` 的 transferable 机制
- **Worker 回退逻辑**: `SUPPORTS_WORKER` 为 false 或 Worker 出错时回退到主线程

**建议**: 使用 `vitest` 的 Worker mock 或 `jsdom` 环境模拟 Worker：
```javascript
import { vi } from "vitest";

// 模拟 Worker
const mockWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
};
global.Worker = vi.fn(() => mockWorker);

it("Worker 正常完成时 resolve", async () => {
    const promise = compressViaWorker(bitmap, options, {});
    mockWorker.onmessage({ data: { type: "done", result: { blob: new Blob() } } });
    const result = await promise;
    expect(result.blob).toBeDefined();
});

it("Worker 错误时 reject", async () => {
    const promise = compressViaWorker(bitmap, options, {});
    mockWorker.onmessage({ data: { type: "error", message: "压缩失败" } });
    await expect(promise).rejects.toThrow("压缩失败");
});
```

---

### 4.2 `edgeRefine` 满幅边缘探测逻辑缺少测试 🟢 轻微

**位置**: `src/lib/compressCore.js` - `edgeRefine`（第 197-224 行）

**问题**: `compressCore` 测试覆盖了 JPEG/PNG 二分搜索、中断、进度回调、Canvas 释放，但 `edgeRefine`（满幅边缘尖顶探测）这一关键优化逻辑没有任何测试。该函数的候选尺寸生成、排序、去重、探测上限逻辑较复杂，且依赖于"文件大小在满幅边缘形成尖顶"的经验观察，容易出现回归。

**建议**: 添加针对 `edgeRefine` 的测试：
```javascript
it("edgeRefine 在满幅边缘找到更优结果", async () => {
    // 模拟 4671x7007 图片，target 30MB
    // 验证 edgeRefine 能在缩放搜索结果基础上找到更大的满幅候选
});
```

---

## 五、总结

### 问题统计

| 严重程度 | 数量 | 类别 |
|---------|------|------|
| 🔴 严重 | 0 | — |
| 🟡 中等 | 4 | 健壮性(3)、测试覆盖(1) |
| 🟢 轻微 | 6 | 代码质量(4)、可访问性(2) |

### 与历轮对比

| 轮次 | 🔴 严重 | 🟡 中等 | 🟢 轻微 | 总计 |
|------|---------|---------|---------|------|
| 第一轮 | 2 | 7 | 11 | 20 |
| 第二轮 | 2 | 6 | 10 | 18 |
| 第三轮 | 1 | 2 | 8 | 11 |
| 第四轮 | 0 | 4 | 6 | 10 |

问题总数持续递减，已无严重级别问题。中等问题从健壮性/测试维度发现，轻微问题集中在代码风格一致性。

### 优先处理建议

1. **近期优化**（影响健壮性，工作量适中）:
   - `handleSizeInputChange` 添加上限校验（1.1）— 极简改动
   - `compressViaWorker` 添加超时机制（1.2）— 防止 UI 卡死
   - 补充 Worker 通信路径测试（4.1）— 提升回归信心

2. **中期改进**（代码质量/UX）:
   - 组件卸载时终止压缩任务（1.3）
   - "输出质量" 标签改为"目标比例"（2.2）
   - 同名文件去重逻辑（2.4）

3. **长期完善**（性能/细节）:
   - Worker 池复用（2.3）
   - `edgeRefine` 测试覆盖（4.2）
   - 拖拽区域焦点还原（3.1）
   - 事件处理器 `useCallback` 统一（2.1）

### 总体评价

经过四轮审计，代码质量已达到生产级水平：

- **安全**: CSP 策略完整，所有文件处理本地完成，无数据外泄。文件大小/数量限制完善。
- **架构**: 核心压缩逻辑独立于 DOM（`compressCore`），Worker/主线程双路径执行，模块职责清晰。`try/finally` 确保 Canvas 释放。
- **性能**: Web Worker 避免主线程阻塞，`heic2any` 动态导入实现代码分割，Worker 分包仅 3.41 kB。`edgeRefine` 满幅探测是亮点优化。
- **测试**: 49 个测试覆盖核心压缩逻辑，但 Worker 通信层和 `edgeRefine` 逻辑仍需补充。
- **可访问性**: ARIA 标签、键盘导航完善，`lang` 属性已修正。仅剩焦点管理细节。
- **用户体验**: 暂停/继续、批量重试、进度反馈、打包下载等功能完整。

剩余 10 个问题均为中低优先级，不影响核心功能安全与正确性，可按团队节奏逐步处理。当前代码可安全发布到生产环境。
