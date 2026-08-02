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
