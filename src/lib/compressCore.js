/**
 * 核心图片压缩逻辑 — 上下文无关模块
 *
 * 本模块不依赖任何 DOM API（document、window 等），可在以下两种环境运行：
 * - 主线程：使用 HTMLCanvasElement（不支持 OffscreenCanvas 时的回退路径）
 * - Web Worker：使用 OffscreenCanvas（根本解决主线程阻塞，审计 2.1）
 *
 * 调用方负责：
 * - 文件解码（file → HTMLImageElement / ImageBitmap）
 * - HEIC 格式转换
 * - 跳过逻辑（文件已小于目标大小时直接返回）
 * - 传递正确的压缩参数
 */

export class CompressAbortError extends Error {
	constructor() {
		super("压缩已暂停");
		this.name = "AbortError";
	}
}

// ---- 压缩参数配置（4.2: 统一管理魔法数字，便于调优） ----

const CONFIG = {
	JPEG_QUALITY_ITERS: 6,      // JPEG 质量二分迭代次数
	SCALE_ITERS: 8,             // 缩放比例二分迭代次数
	UPSCALE_ITERS: 6,           // 放大比例二分迭代次数
	EDGE_MAX_PROBES: 6,         // edgeRefine 探测上限
	EDGE_PROBE_OFFSETS: [1, 2, 3, 5, 8, 13], // edgeRefine 像素偏移候选
	REFINE_FACTORS: [0.5, 0.75], // 局部上探比例因子
	MAX_UPSCALE: 1.3,           // 放大上限
	MIN_SCALE: 0.05,            // 最小缩放比例
	MIN_QUALITY: 0.1,           // 兜底最低质量
	JPEG_MIN_QUALITY_START: 0.5, // JPEG 质量二分下限
	JPEG_FALLBACK_QUALITY: 0.85, // JPEG 降分辨率回退质量
	NEAR_TARGET_RATIO: 0.9,     // 已接近目标大小的判定比例
	EDGE_REFINE_THRESHOLD: 0.98, // edgeRefine 跳过阈值
};

// ---- 上下文检测 ----

// Worker 中无需 yield（不阻塞主线程）；主线程需要 yield 让 UI 有机会响应
const isWorker =
	typeof self !== "undefined" && typeof window === "undefined";

const yieldToMain = isWorker
	? () => Promise.resolve()
	: () => new Promise((r) => setTimeout(r, 0));

// ---- Canvas 抽象层 ----

function createCanvas() {
	if (typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(1, 1);
	}
	return document.createElement("canvas");
}

function canvasToBlob(canvas, mimeType, quality) {
	// OffscreenCanvas 使用 convertToBlob（返回 Promise）
	if (typeof canvas.convertToBlob === "function") {
		return canvas.convertToBlob(
			quality !== undefined
				? { type: mimeType, quality }
				: { type: mimeType },
		);
	}
	// HTMLCanvasElement 使用 toBlob（回调式）
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("Canvas 导出失败"))),
			mimeType,
			quality,
		);
	});
}

// ---- 核心压缩 ----

/**
 * 执行核心图片压缩。
 *
 * @param {HTMLImageElement|ImageBitmap} img - 已解码的图片
 * @param {Object}   options
 * @param {number}   options.targetBytes  - 目标文件大小（字节）
 * @param {boolean}  options.usePng       - 是否输出 PNG（有透明通道时）
 * @param {string}   options.mimeType     - 输出 MIME 类型
 * @param {string}   options.outputExt    - 输出文件扩展名
 * @param {string}   options.fileName     - 原始文件名
 * @param {number}   options.originalSize - 原始文件大小（字节）
 * @param {Object}   [callbacks]
 * @param {Function} [callbacks.onProgress]   - 进度回调 (0-100)
 * @param {Function} [callbacks.shouldAbort]  - 返回 true 时中断压缩
 * @returns {Promise<{blob:Blob, originalSize:number, compressedSize:number, fileName:string, skipped:boolean}>}
 */
export async function compressCore(img, options, callbacks = {}) {
	const {
		targetBytes,
		usePng,
		mimeType,
		outputExt,
		fileName,
		originalSize,
	} = options;
	const { onProgress, shouldAbort } = callbacks;
	const checkAbort = () => {
		if (shouldAbort?.()) throw new CompressAbortError();
	};

	// HTMLImageElement 用 naturalWidth/Height；ImageBitmap 用 width/height
	const w = img.naturalWidth || img.width;
	const h = img.naturalHeight || img.height;
	onProgress?.(15);

	const canvas = createCanvas();
	const ctx = canvas.getContext("2d");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

	const encodeAt = (scale, q) => {
		const cw = Math.max(1, Math.round(w * scale));
		const ch = Math.max(1, Math.round(h * scale));
		canvas.width = cw;
		canvas.height = ch;
		ctx.drawImage(img, 0, 0, cw, ch);
		return canvasToBlob(canvas, mimeType, usePng ? undefined : q);
	};

	// 固定质量，二分缩放比例（缩小），输出不超过 target 的最大文件
	const searchByScale = async (q, iters, progressBase, progressSpan) => {
		let lo = CONFIG.MIN_SCALE,
			hi = 1.0,
			best = null,
			bestScale = 0;
		for (let i = 0; i < iters; i++) {
			checkAbort();
			await yieldToMain();
			const mid = (lo + hi) / 2;
			const blob = await encodeAt(mid, q);
			onProgress?.(progressBase + Math.round(((i + 1) / iters) * progressSpan));
			if (blob.size <= targetBytes) {
				// 旧 best 引用被覆盖，GC 可回收（2.3）
				best = blob;
				bestScale = mid;
				lo = mid;
			} else {
				// 超标 blob 不再需要，循环结束后自动出作用域（2.3）
				hi = mid;
			}
		}
		// 局部上探精炼：大小-缩放曲线非单调（缩放会平滑噪点），
		// 二分结果可能偏小，在 (bestScale, hi) 区间内继续上探用满预算
		if (best) {
			for (const f of CONFIG.REFINE_FACTORS) {
				checkAbort();
				const s = bestScale + (hi - bestScale) * f;
				if (s <= bestScale || s >= 1.0) continue;
				const blob = await encodeAt(s, q);
				if (blob.size <= targetBytes && blob.size > best.size) {
					best = blob;
					bestScale = s;
				}
			}
		}
		return best;
	};

	// 固定质量，二分放大比例（>1），用满目标大小预算
	const searchUpscale = async (q, maxScale, iters, progressBase, progressSpan) => {
		let lo = 1.0,
			hi = maxScale,
			best = null,
			bestScale = 0;
		for (let i = 0; i < iters; i++) {
			checkAbort();
			await yieldToMain();
			const mid = (lo + hi) / 2;
			const blob = await encodeAt(mid, q);
			onProgress?.(progressBase + Math.round(((i + 1) / iters) * progressSpan));
			if (blob.size <= targetBytes) {
				best = blob;
				bestScale = mid;
				lo = mid;
			} else {
				hi = mid;
			}
		}
		if (best) {
			for (const f of CONFIG.REFINE_FACTORS) {
				checkAbort();
				const s = bestScale + (hi - bestScale) * f;
				if (s <= bestScale || s > maxScale) continue;
				const blob = await encodeAt(s, q);
				if (blob.size <= targetBytes && blob.size > best.size) {
					best = blob;
					bestScale = s;
				}
			}
		}
		return best;
	};

	// 固定像素尺寸编码（允许单维 1:1 的非等比输出）
	const encodeDims = (cw, ch, q) => {
		canvas.width = Math.max(1, cw);
		canvas.height = Math.max(1, ch);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return canvasToBlob(canvas, mimeType, usePng ? undefined : q);
	};

	// 满幅边缘探测：缩放搜索结果仍明显小于目标时，定向尝试"单维 1:1 +
	// 另一维微缩几像素"的候选尺寸。重采样只发生在单一方向时噪点保留最多，
	// 文件大小在满幅边缘形成尖顶（实测：4671x7007→28.9MB，4672x7007→31.3MB，
	// 4672x7008→32.9MB），这些候选是保留原始细节最多且不超标的选择
	const edgeRefine = async (q, current) => {
		if (current && current.size >= targetBytes * CONFIG.EDGE_REFINE_THRESHOLD) return current;
		let best = current;
		const seen = new Set();
		const candidates = [];
		for (const k of CONFIG.EDGE_PROBE_OFFSETS) {
			candidates.push([w, h - k], [w - k, h]);
		}
		// 按像素总数从大到小排序，最接近满幅的优先
		candidates.sort((a, b) => b[0] * b[1] - a[0] * a[1]);
		let probes = 0;
		for (const [cw, ch] of candidates) {
			if (probes >= CONFIG.EDGE_MAX_PROBES) break;
			if (cw < 1 || ch < 1 || (cw === w && ch === h)) continue;
			const key = cw + "x" + ch;
			if (seen.has(key)) continue;
			seen.add(key);
			checkAbort();
			probes++;
			const blob = await encodeDims(cw, ch, q);
			if (blob.size <= targetBytes) {
				if (!best || blob.size > best.size) best = blob;
				break; // 最接近满幅的合规候选即尖顶最优，停止探测
			}
		}
		return best;
	};

	let bestBlob = null;

	try {
		if (usePng) {
			// PNG 无质量参数：先试原尺寸，再二分缩放逼近目标大小
			checkAbort();
			const full = await encodeAt(1);
			onProgress?.(35);
			if (full.size <= targetBytes) {
				bestBlob = full;
			} else {
				bestBlob = await searchByScale(undefined, CONFIG.SCALE_ITERS, 35, 55);
				bestBlob = await edgeRefine(undefined, bestBlob);
			}
		} else {
			// JPEG：先在原分辨率下二分质量
			let lo = CONFIG.JPEG_MIN_QUALITY_START,
				hi = 1.0,
				bestFit = null, // 不超过 target 的最高质量结果
				bestFitQ = null,
				firstMiss = null, // 超过 target 的最低质量结果（档位跳变点）
				firstMissQ = null;
			for (let i = 0; i < CONFIG.JPEG_QUALITY_ITERS; i++) {
				checkAbort();
				await yieldToMain();
				const mid = (lo + hi) / 2;
				const blob = await encodeAt(1, mid);
				onProgress?.(15 + Math.round(((i + 1) / CONFIG.JPEG_QUALITY_ITERS) * 45));
				if (blob.size <= targetBytes) {
					if (bestFitQ === null || mid > bestFitQ) {
						bestFit = blob;
						bestFitQ = mid;
					}
					lo = mid;
				} else {
					if (firstMissQ === null || mid < firstMissQ) {
						firstMiss = blob;
						firstMissQ = mid;
					}
					hi = mid;
				}
			}

			if (!bestFit) {
				// 原分辨率下最低质量也超标，降低分辨率逼近目标
				bestBlob = await searchByScale(CONFIG.JPEG_FALLBACK_QUALITY, CONFIG.SCALE_ITERS, 60, 30);
			} else if (!firstMiss) {
				// 所有质量档（含 q≈1.0）全分辨率都小于目标（原图编码效率低，
				// 如相机直出 JPEG）：质量已到顶，通过适度放大分辨率用满目标
				// 大小预算（上限 1.3x）
				const upscaled = await searchUpscale(1.0, CONFIG.MAX_UPSCALE, CONFIG.UPSCALE_ITERS, 60, 30);
				bestBlob = upscaled || bestFit;
			} else if (bestFit.size >= targetBytes * CONFIG.NEAR_TARGET_RATIO) {
				// 已足够接近目标大小
				bestBlob = bestFit;
			} else {
				// 编码器质量档位发生跳变（如 4:2:0 → 4:4:4 色度抽样切换）：
				// 全分辨率下合规档远小于目标、超标档又太大。
				// 改用超标档的高画质 + 轻微缩小分辨率，让输出尽量接近目标大小。
				const scaled = await searchByScale(firstMissQ, CONFIG.SCALE_ITERS, 60, 30);
				bestBlob = scaled && scaled.size > bestFit.size ? scaled : bestFit;
				bestBlob = await edgeRefine(firstMissQ, bestBlob);
			}
		}

		if (!bestBlob) {
			// 兜底：所有搜索策略均未产出合规结果时，使用最小缩放 + 最低质量编码。
			// PNG: searchByScale 最小测试缩放约 0.054，此处 0.05 更小，确保产出有效 blob。
			// JPEG: quality 0.1 低于 searchByScale 使用的起始质量，可产出更小文件。
			bestBlob = await encodeAt(CONFIG.MIN_SCALE, usePng ? undefined : CONFIG.MIN_QUALITY);
		}

		onProgress?.(95);
		// 安全的文件名处理：避免正则特殊字符导致替换失败
		const dotIndex = fileName.lastIndexOf(".");
		const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
		const outputName = baseName + outputExt;
		onProgress?.(100);

		return {
			blob: bestBlob,
			originalSize,
			compressedSize: bestBlob.size,
			fileName: outputName,
			skipped: false,
		};
	} finally {
		// 显式释放 Canvas 内存（2.2），确保异常路径也能清理
		canvas.width = 0;
		canvas.height = 0;
	}
}
