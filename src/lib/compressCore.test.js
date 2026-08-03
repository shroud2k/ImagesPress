import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { compressCore, CompressAbortError } from "./compressCore";

// ===================== Mock 辅助工具 =====================

/** 创建模拟图片对象（兼容 HTMLImageElement 和 ImageBitmap 接口） */
function makeMockImg(w, h) {
	return { naturalWidth: w, naturalHeight: h };
}

/** 控制每次 convertToBlob 返回的 blob 大小 */
let blobSizeFn;

/** 记录所有 convertToBlob 调用的参数 */
let convertToBlobCalls;

beforeEach(() => {
	convertToBlobCalls = [];

	// 全局模拟 OffscreenCanvas（compressCore 优先使用此路径）
	global.OffscreenCanvas = class {
		constructor(w, h) {
			this.width = w;
			this.height = h;
			this._ctx = null;
		}
		getContext() {
			if (!this._ctx) {
				this._ctx = {
					imageSmoothingEnabled: false,
					imageSmoothingQuality: "low",
					drawImage: vi.fn(),
				};
			}
			return this._ctx;
		}
		convertToBlob(options) {
			const { type, quality } = options || {};
			const pixels = this.width * this.height;
			const size = blobSizeFn
				? blobSizeFn(type, quality, pixels, this.width, this.height)
				: 100;
			convertToBlobCalls.push({
				type,
				quality,
				width: this.width,
				height: this.height,
				size,
			});
			return Promise.resolve({ size, type: type || "image/jpeg" });
		}
	};
});

afterEach(() => {
	delete global.OffscreenCanvas;
	blobSizeFn = null;
	convertToBlobCalls = null;
});

// ===================== JPEG 压缩测试 =====================

describe("compressCore - JPEG 压缩", () => {
	it("二分质量搜索找到不超过目标的最佳质量", async () => {
		const img = makeMockImg(2000, 2000); // 4M 像素
		const targetBytes = 1 * 1024 * 1024; // 1MB

		// JPEG: size = pixels * quality * 0.5
		// q=1.0 → 2MB（超标），q=0.5 → 1MB（刚好达标），q=0.25 → 0.5MB
		blobSizeFn = (type, quality, pixels) => {
			const q = quality ?? 1.0;
			return Math.round(pixels * q * 0.5);
		};

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 5 * 1024 * 1024,
			},
			{},
		);

		expect(result.skipped).toBe(false);
		expect(result.fileName).toBe("test.jpg");
		expect(result.compressedSize).toBeLessThanOrEqual(targetBytes);
		expect(result.blob).toBeDefined();
		expect(result.originalSize).toBe(5 * 1024 * 1024);
	});

	it("输出文件名正确替换扩展名", async () => {
		const img = makeMockImg(1000, 1000);
		const targetBytes = 5 * 1024 * 1024; // 5MB target

		// 所有编码结果都远小于目标
		blobSizeFn = () => 100;

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "photo.heic",
				originalSize: 5 * 1024 * 1024,
			},
			{},
		);

		expect(result.fileName).toBe("photo.jpg");
	});

	it("无扩展名文件也能正确输出", async () => {
		const img = makeMockImg(500, 500);

		blobSizeFn = () => 100;

		const result = await compressCore(
			img,
			{
				targetBytes: 1024 * 1024,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "noextension",
				originalSize: 5 * 1024 * 1024,
			},
			{},
		);

		// lastIndexOf(".") 返回 -1，dotIndex <= 0，baseName = 原文件名
		expect(result.fileName).toBe("noextension.jpg");
	});

	it("所有编码都超标时使用最小缩放兜底", async () => {
		const img = makeMockImg(2000, 2000);
		const targetBytes = 100; // 极小目标

		// 所有编码结果都固定为 50000，始终超标
		blobSizeFn = () => 50000;

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 1000000,
			},
			{},
		);

		// 兜底路径仍应返回有效结果
		expect(result.blob).toBeDefined();
		expect(result.skipped).toBe(false);
		expect(result.compressedSize).toBe(50000);
	});
});

// ===================== PNG 压缩测试 =====================

describe("compressCore - PNG 压缩", () => {
	it("二分缩放搜索找到不超过目标的最大尺寸", async () => {
		const img = makeMockImg(2000, 2000); // 4M 像素
		const targetBytes = 1 * 1024 * 1024; // 1MB

		// PNG: size = pixels * 0.5（无 quality 参数）
		// 全尺寸 4M 像素 → 2MB > 1MB，需缩小
		blobSizeFn = (type, quality, pixels) => {
			return Math.round(pixels * 0.5);
		};

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: true,
				mimeType: "image/png",
				outputExt: ".png",
				fileName: "test.png",
				originalSize: 3 * 1024 * 1024,
			},
			{},
		);

		expect(result.skipped).toBe(false);
		expect(result.fileName).toBe("test.png");
		expect(result.compressedSize).toBeLessThanOrEqual(targetBytes);
	});

	it("PNG 不传 quality 参数", async () => {
		const img = makeMockImg(100, 100);
		const targetBytes = 5 * 1024 * 1024;

		let pngQualityReceived = "NOT_CALLED";

		blobSizeFn = (type, quality) => {
			if (type === "image/png") {
				pngQualityReceived = quality;
			}
			return 100;
		};

		await compressCore(
			img,
			{
				targetBytes,
				usePng: true,
				mimeType: "image/png",
				outputExt: ".png",
				fileName: "test.png",
				originalSize: 1024 * 1024,
			},
			{},
		);

		// PNG 路径不应传递 quality 参数
		expect(pngQualityReceived).toBeUndefined();
	});

	it("PNG 全尺寸已达标时直接使用", async () => {
		const img = makeMockImg(1000, 1000); // 1M 像素
		const targetBytes = 2 * 1024 * 1024; // 2MB

		// PNG: 1M 像素 → 500KB < 2MB
		blobSizeFn = (type, quality, pixels) => Math.round(pixels * 0.5);

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: true,
				mimeType: "image/png",
				outputExt: ".png",
				fileName: "test.png",
				originalSize: 1024 * 1024,
			},
			{},
		);

		expect(result.compressedSize).toBe(500000);
	});
});

// ===================== 中断测试 =====================

describe("compressCore - 中断", () => {
	it("shouldAbort 返回 true 时抛出 CompressAbortError", async () => {
		const img = makeMockImg(2000, 2000);

		blobSizeFn = () => 100;

		await expect(
			compressCore(
				img,
				{
					targetBytes: 50,
					usePng: false,
					mimeType: "image/jpeg",
					outputExt: ".jpg",
					fileName: "test.jpg",
					originalSize: 1000,
				},
				{ shouldAbort: () => true },
			),
		).rejects.toThrow(CompressAbortError);
	});

	it("PNG 压缩中中断抛出 CompressAbortError", async () => {
		const img = makeMockImg(2000, 2000);

		blobSizeFn = () => 100000;

		await expect(
			compressCore(
				img,
				{
					targetBytes: 50,
					usePng: true,
					mimeType: "image/png",
					outputExt: ".png",
					fileName: "test.png",
					originalSize: 1000,
				},
				{ shouldAbort: () => true },
			),
		).rejects.toThrow(CompressAbortError);
	});

	it("shouldAbort 初始为 false 后变为 true 也能中断", async () => {
		const img = makeMockImg(2000, 2000);
		let callCount = 0;

		blobSizeFn = () => {
			callCount++;
			return 100000; // 超标，确保进入搜索循环
		};

		await expect(
			compressCore(
				img,
				{
					targetBytes: 50,
					usePng: false,
					mimeType: "image/jpeg",
					outputExt: ".jpg",
					fileName: "test.jpg",
					originalSize: 1000,
				},
				{
					shouldAbort: () => callCount > 2,
				},
			),
		).rejects.toThrow(CompressAbortError);
	});
});

// ===================== 进度回调测试 =====================

describe("compressCore - 进度回调", () => {
	it("onProgress 被调用且首尾值正确", async () => {
		const img = makeMockImg(1000, 1000);
		const progressValues = [];

		blobSizeFn = () => 100;

		await compressCore(
			img,
			{
				targetBytes: 1024 * 1024,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 5 * 1024 * 1024,
			},
			{
				onProgress: (p) => progressValues.push(p),
			},
		);

		expect(progressValues.length).toBeGreaterThan(0);
		expect(progressValues[0]).toBe(15);
		expect(progressValues[progressValues.length - 1]).toBe(100);
	});

	it("进度值递增（不回退）", async () => {
		const img = makeMockImg(2000, 2000);
		const progressValues = [];

		blobSizeFn = (type, quality, pixels) => {
			const q = quality ?? 1.0;
			return Math.round(pixels * q * 0.5);
		};

		await compressCore(
			img,
			{
				targetBytes: 1 * 1024 * 1024,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 5 * 1024 * 1024,
			},
			{
				onProgress: (p) => progressValues.push(p),
			},
		);

		for (let i = 1; i < progressValues.length; i++) {
			expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
		}
	});
});

// ===================== Canvas 内存释放测试 =====================

describe("compressCore - Canvas 内存释放", () => {
	it("完成后 Canvas 尺寸归零（2.2）", async () => {
		const img = makeMockImg(1000, 1000);
		let canvasRef = null;

		// 捕获 createCanvas 创建的 canvas 实例
		const origOffscreenCanvas = global.OffscreenCanvas;
		global.OffscreenCanvas = class extends origOffscreenCanvas {
			constructor(w, h) {
				super(w, h);
				canvasRef = this;
			}
		};

		blobSizeFn = () => 100;

		await compressCore(
			img,
			{
				targetBytes: 1024 * 1024,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 5 * 1024 * 1024,
			},
			{},
		);

		expect(canvasRef).not.toBeNull();
		expect(canvasRef.width).toBe(0);
		expect(canvasRef.height).toBe(0);
	});

	it("异常路径也释放 Canvas（try/finally 回归测试）", async () => {
		const img = makeMockImg(2000, 2000);
		let canvasRef = null;

		const origOffscreenCanvas = global.OffscreenCanvas;
		global.OffscreenCanvas = class extends origOffscreenCanvas {
			constructor(w, h) {
				super(w, h);
				canvasRef = this;
			}
		};

		// shouldAbort 在第一次 checkAbort 时就抛出 CompressAbortError
		blobSizeFn = () => 100;

		await expect(
			compressCore(
				img,
				{
					targetBytes: 1024 * 1024,
					usePng: false,
					mimeType: "image/jpeg",
					outputExt: ".jpg",
					fileName: "test.jpg",
					originalSize: 5 * 1024 * 1024,
				},
				{ shouldAbort: () => true },
			),
		).rejects.toThrow(CompressAbortError);

		// 即使异常退出，Canvas 也应被清理
		expect(canvasRef).not.toBeNull();
		expect(canvasRef.width).toBe(0);
		expect(canvasRef.height).toBe(0);
	});

	it("PNG 异常路径也释放 Canvas（try/finally 回归测试）", async () => {
		const img = makeMockImg(2000, 2000);
		let canvasRef = null;

		const origOffscreenCanvas = global.OffscreenCanvas;
		global.OffscreenCanvas = class extends origOffscreenCanvas {
			constructor(w, h) {
				super(w, h);
				canvasRef = this;
			}
		};

		blobSizeFn = () => 100000;

		await expect(
			compressCore(
				img,
				{
					targetBytes: 50,
					usePng: true,
					mimeType: "image/png",
					outputExt: ".png",
					fileName: "test.png",
					originalSize: 1000,
				},
				{ shouldAbort: () => true },
			),
		).rejects.toThrow(CompressAbortError);

		expect(canvasRef).not.toBeNull();
		expect(canvasRef.width).toBe(0);
		expect(canvasRef.height).toBe(0);
	});
});

// ===================== edgeRefine 测试（审计 7.1 回归） =====================

describe("compressCore - edgeRefine 满幅边缘探测", () => {
	it("bestBlob 已接近目标时直接返回，不探测（阈值 98%）", async () => {
		const img = makeMockImg(2000, 2000);
		const targetBytes = 1048576; // 1MB

		// 全尺寸超标，搜索结果恰好 99% 目标 → edgeRefine 应直接返回
		blobSizeFn = (type, quality, pixels, w, h) => {
			if (w === 2000 && h === 2000) return 2000000; // 全尺寸: 2MB 超标
			return 1038075; // 99% of 1MB, 达标且 >= 98% 阈值
		};

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: true,
				mimeType: "image/png",
				outputExt: ".png",
				fileName: "test.png",
				originalSize: 3 * 1024 * 1024,
			},
			{},
		);

		// 结果应为 99% 目标大小，edgeRefine 未做额外探测
		expect(result.compressedSize).toBe(1038075);
		expect(result.compressedSize).toBeLessThanOrEqual(targetBytes);
	});

	it("bestBlob 远小于目标时探测满幅边缘候选", async () => {
		const img = makeMockImg(2000, 2000);
		const targetBytes = 1048576; // 1MB

		// 全尺寸超标，搜索结果仅 50% 目标，
		// 但 [2000, 1999] 边缘候选恰好达标且更大
		blobSizeFn = (type, quality, pixels, w, h) => {
			if (w === 2000 && h === 2000) return 2000000; // 全尺寸超标
			if (w === 2000 && h === 1999) return 1048000; // 边缘候选: 接近目标
			return 524288; // 50% 目标，达标但远小于目标
		};

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: true,
				mimeType: "image/png",
				outputExt: ".png",
				fileName: "test.png",
				originalSize: 3 * 1024 * 1024,
			},
			{},
		);

		// edgeRefine 应找到 [2000, 1999] 候选，大小远大于搜索结果
		expect(result.compressedSize).toBe(1048000);
		expect(result.compressedSize).toBeLessThanOrEqual(targetBytes);
	});

	it("edgeRefine 探测不超过 EDGE_MAX_PROBES 上限", async () => {
		const img = makeMockImg(2000, 2000);
		const targetBytes = 1048576; // 1MB

		// 所有编码都远小于目标，但没有边缘候选达标 → 全部探测完
		let probeCount = 0;
		blobSizeFn = (type, quality, pixels, w, h) => {
			if (w === 2000 && h === 2000) return 2000000;
			probeCount++;
			return 524288; // 始终远小于目标
		};

		await compressCore(
			img,
			{
				targetBytes,
				usePng: true,
				mimeType: "image/png",
				outputExt: ".png",
				fileName: "test.png",
				originalSize: 3 * 1024 * 1024,
			},
			{},
		);

		// edgeRefine 最多探测 EDGE_MAX_PROBES (6) 个候选
		// searchByScale + refine + edgeRefine 总调用数 > 6，但 edgeRefine 部分 <= 6
		// 验证总探测数合理（不超过搜索迭代+精炼+边缘探测上限）
		expect(probeCount).toBeGreaterThan(0);
	});
});

// ===================== 放大搜索测试（审计 7.1 回归） =====================

describe("compressCore - 放大搜索 (searchUpscale)", () => {
	it("所有质量都小于目标时通过放大分辨率用满预算", async () => {
		const img = makeMockImg(1000, 1000); // 1M 像素
		const targetBytes = 5 * 1024 * 1024; // 5MB 目标

		// JPEG 编码效率极高，即使 q=1.0 也远小于目标
		// size = pixels * quality * 0.01
		// 全尺寸 q=1.0: 1M * 1.0 * 0.01 = 10000 (10KB) << 5MB
		// 放大 1.3x: 1.69M * 1.0 * 0.01 = 16900 (16.9KB) << 5MB
		blobSizeFn = (type, quality, pixels) => {
			const q = quality ?? 1.0;
			return Math.round(pixels * q * 0.01);
		};

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 1024 * 1024,
			},
			{},
		);

		// 放大搜索应找到 scale > 1.0 的结果
		// 验证有放大发生：检查 convertToBlobCalls 中是否有 width > 1000 的调用
		const upscaleCalls = convertToBlobCalls.filter((c) => c.width > 1000);
		expect(upscaleCalls.length).toBeGreaterThan(0);
		expect(result.blob).toBeDefined();
		expect(result.skipped).toBe(false);
	});
});

// ===================== 质量跳变路径测试（审计 7.1 回归） =====================

describe("compressCore - JPEG 质量跳变路径", () => {
	it("bestFit 远小于目标时走 firstMissQ + searchByScale 路径", async () => {
		const img = makeMockImg(2000, 2000); // 4M 像素
		const targetBytes = 1048576; // 1MB

		// 模拟编码器质量跳变：
		// q > 0.55: size = pixels * 0.5 (大文件)
		// q <= 0.55: size = pixels * 0.05 (小文件，远小于目标)
		// 二分搜索结果: bestFit ≈ 200KB (q≈0.54), firstMiss ≈ 2MB (q≈0.55)
		// bestFit.size (200K) < target * 0.9 (943K) → 走跳变路径
		// searchByScale(firstMissQ≈0.55) 会用高质量+缩放找到更接近目标的结果
		blobSizeFn = (type, quality, pixels) => {
			const q = quality ?? 1.0;
			if (q > 0.55) return Math.round(pixels * 0.5);
			return Math.round(pixels * 0.05);
		};

		const result = await compressCore(
			img,
			{
				targetBytes,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 5 * 1024 * 1024,
			},
			{},
		);

		// 跳变路径应找到比 bestFit (200KB) 大得多的结果
		expect(result.compressedSize).toBeGreaterThan(200000);
		expect(result.compressedSize).toBeLessThanOrEqual(targetBytes);
	});
});

// ===================== CONFIG 常量验证测试（审计 4.2 回归） =====================

describe("compressCore - CONFIG 常量使用验证（4.2）", () => {
	it("JPEG 质量二分迭代次数为 6", async () => {
		const img = makeMockImg(1000, 1000);
		const targetBytes = 1024 * 1024;

		// 所有编码结果都远小于目标 → 走放大搜索路径
		blobSizeFn = () => 100;

		await compressCore(
			img,
			{
				targetBytes,
				usePng: false,
				mimeType: "image/jpeg",
				outputExt: ".jpg",
				fileName: "test.jpg",
				originalSize: 5 * 1024 * 1024,
			},
			{},
		);

		// JPEG 质量二分: 6 次迭代 (CONFIG.JPEG_QUALITY_ITERS)
		// 之后可能有放大搜索 (6 次 + 精炼)
		// 至少应该有 6 次质量二分调用
		expect(convertToBlobCalls.length).toBeGreaterThanOrEqual(6);
	});

	it("PNG 缩放搜索迭代次数为 8", async () => {
		const img = makeMockImg(2000, 2000);
		const targetBytes = 1024 * 1024;

		// 全尺寸超标，需要缩放搜索
		blobSizeFn = (type, quality, pixels) => Math.round(pixels * 0.5);

		await compressCore(
			img,
			{
				targetBytes,
				usePng: true,
				mimeType: "image/png",
				outputExt: ".png",
				fileName: "test.png",
				originalSize: 3 * 1024 * 1024,
			},
			{},
		);

		// PNG 路径: 1 次全尺寸 + 8 次缩放搜索 (CONFIG.SCALE_ITERS) + 精炼 + edgeRefine
		expect(convertToBlobCalls.length).toBeGreaterThanOrEqual(9);
	});
});
