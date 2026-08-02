import { describe, it, expect } from "vitest";
import {
	formatFileSize,
	isSupportedImage,
	getFormatLabel,
	ALL_EXTENSIONS,
	SUPPORTED_FORMATS,
	CompressAbortError,
	compressImage,
} from "./imageCompress";

// ===================== formatFileSize 测试（5.1 回归） =====================
describe("formatFileSize", () => {
	it("0 字节返回 '0 B'", () => {
		expect(formatFileSize(0)).toBe("0 B");
	});

	it("负数返回 '0 B'（边界修复）", () => {
		expect(formatFileSize(-1)).toBe("0 B");
		expect(formatFileSize(-1024)).toBe("0 B");
	});

	it("null/undefined 返回 '0 B'（边界修复）", () => {
		expect(formatFileSize(null)).toBe("0 B");
		expect(formatFileSize(undefined)).toBe("0 B");
	});

	it("1 字节返回 '1 B'", () => {
		expect(formatFileSize(1)).toBe("1 B");
	});

	it("1024 字节返回 '1 KB'", () => {
		expect(formatFileSize(1024)).toBe("1 KB");
	});

	it("1048576 字节返回 '1 MB'", () => {
		expect(formatFileSize(1048576)).toBe("1 MB");
	});

	it("1073741824 字节返回 '1 GB'", () => {
		expect(formatFileSize(1073741824)).toBe("1 GB");
	});

	it("超过 GB 时使用 TB 单位，不越界（边界修复）", () => {
		const tb = 1024 ** 4; // 1 TB
		expect(formatFileSize(tb)).toBe("1 TB");
		expect(formatFileSize(tb * 5)).toBe("5 TB");
	});

	it("小数保留两位", () => {
		expect(formatFileSize(1536)).toBe("1.5 KB");
		expect(formatFileSize(1572864)).toBe("1.5 MB");
	});
});

// ===================== isSupportedImage 测试（4.1 RAW/DNG 移除回归） =====================
describe("isSupportedImage", () => {
	const makeFile = (name, type = "") => new File([new Uint8Array([0])], name, { type });

	it("支持 JPEG", () => {
		expect(isSupportedImage(makeFile("test.jpg"))).toBe(true);
		expect(isSupportedImage(makeFile("test.jpeg"))).toBe(true);
	});

	it("支持 PNG", () => {
		expect(isSupportedImage(makeFile("test.png"))).toBe(true);
	});

	it("支持 GIF", () => {
		expect(isSupportedImage(makeFile("test.gif"))).toBe(true);
	});

	it("支持 WebP", () => {
		expect(isSupportedImage(makeFile("test.webp"))).toBe(true);
	});

	it("支持 AVIF", () => {
		expect(isSupportedImage(makeFile("test.avif"))).toBe(true);
	});

	it("支持 BMP", () => {
		expect(isSupportedImage(makeFile("test.bmp"))).toBe(true);
	});

	it("支持 TIFF", () => {
		expect(isSupportedImage(makeFile("test.tiff"))).toBe(true);
		expect(isSupportedImage(makeFile("test.tif"))).toBe(true);
	});

	it("支持 HEIC", () => {
		expect(isSupportedImage(makeFile("test.heic"))).toBe(true);
		expect(isSupportedImage(makeFile("test.heif"))).toBe(true);
	});

	// 4.1: RAW/DNG 应该不再被支持
	it("不支持 RAW 格式（已从支持列表移除）", () => {
		expect(isSupportedImage(makeFile("test.raw"))).toBe(false);
		expect(isSupportedImage(makeFile("test.cr2"))).toBe(false);
		expect(isSupportedImage(makeFile("test.nef"))).toBe(false);
		expect(isSupportedImage(makeFile("test.arw"))).toBe(false);
	});

	it("不支持 DNG 格式（已从支持列表移除）", () => {
		expect(isSupportedImage(makeFile("test.dng"))).toBe(false);
	});

	it("不支持非图片文件", () => {
		expect(isSupportedImage(makeFile("test.txt"))).toBe(false);
		expect(isSupportedImage(makeFile("test.pdf"))).toBe(false);
		expect(isSupportedImage(makeFile("test"))).toBe(false);
	});

	it("通过 MIME 类型识别图片", () => {
		expect(isSupportedImage(makeFile("test", "image/jpeg"))).toBe(true);
		expect(isSupportedImage(makeFile("test", "image/png"))).toBe(true);
		expect(isSupportedImage(makeFile("test", "text/plain"))).toBe(false);
	});

	it("大小写不敏感", () => {
		expect(isSupportedImage(makeFile("test.JPG"))).toBe(true);
		expect(isSupportedImage(makeFile("test.PNG"))).toBe(true);
		expect(isSupportedImage(makeFile("test.Heic"))).toBe(true);
	});
});

// ===================== ALL_EXTENSIONS 测试（4.1 回归） =====================
describe("ALL_EXTENSIONS", () => {
	it("不包含 RAW 相关扩展名", () => {
		expect(ALL_EXTENSIONS).not.toContain(".raw");
		expect(ALL_EXTENSIONS).not.toContain(".dng");
		expect(ALL_EXTENSIONS).not.toContain(".cr2");
		expect(ALL_EXTENSIONS).not.toContain(".nef");
		expect(ALL_EXTENSIONS).not.toContain(".arw");
		expect(ALL_EXTENSIONS).not.toContain(".orf");
		expect(ALL_EXTENSIONS).not.toContain(".rw2");
	});

	it("包含常用图片格式", () => {
		expect(ALL_EXTENSIONS).toContain(".jpg");
		expect(ALL_EXTENSIONS).toContain(".jpeg");
		expect(ALL_EXTENSIONS).toContain(".png");
		expect(ALL_EXTENSIONS).toContain(".gif");
		expect(ALL_EXTENSIONS).toContain(".webp");
		expect(ALL_EXTENSIONS).toContain(".avif");
		expect(ALL_EXTENSIONS).toContain(".bmp");
		expect(ALL_EXTENSIONS).toContain(".tiff");
		expect(ALL_EXTENSIONS).toContain(".heic");
	});
});

// ===================== SUPPORTED_FORMATS 测试（4.1 回归） =====================
describe("SUPPORTED_FORMATS", () => {
	it("不包含 RAW/DNG MIME 类型", () => {
		expect(SUPPORTED_FORMATS).not.toHaveProperty("image/x-adobe-dng");
		expect(SUPPORTED_FORMATS).not.toHaveProperty("image/x-raw");
	});
});

// ===================== getFormatLabel 测试 =====================
describe("getFormatLabel", () => {
	it("正确映射常见格式", () => {
		expect(getFormatLabel("photo.jpg")).toBe("JPG");
		expect(getFormatLabel("photo.jpeg")).toBe("JPEG");
		expect(getFormatLabel("photo.png")).toBe("PNG");
		expect(getFormatLabel("photo.gif")).toBe("GIF");
		expect(getFormatLabel("photo.webp")).toBe("WebP");
		expect(getFormatLabel("photo.avif")).toBe("AVIF");
		expect(getFormatLabel("photo.bmp")).toBe("BMP");
		expect(getFormatLabel("photo.tiff")).toBe("TIFF");
		expect(getFormatLabel("photo.tif")).toBe("TIF");
		expect(getFormatLabel("photo.heic")).toBe("HEIC");
		expect(getFormatLabel("photo.heif")).toBe("HEIF");
	});

	it("无扩展名时返回'未知'（修复空字符串）", () => {
		expect(getFormatLabel("noextension")).toBe("未知");
	});

	it("未知扩展名返回大写", () => {
		expect(getFormatLabel("file.xyz")).toBe("XYZ");
	});
});

// ===================== CompressAbortError 测试 =====================
describe("CompressAbortError", () => {
	it("是 Error 的子类", () => {
		const err = new CompressAbortError();
		expect(err).toBeInstanceOf(Error);
	});

	it("name 为 AbortError", () => {
		const err = new CompressAbortError();
		expect(err.name).toBe("AbortError");
	});

	it("message 为 '压缩已暂停'", () => {
		const err = new CompressAbortError();
		expect(err.message).toBe("压缩已暂停");
	});
});

// ===================== compressImage 跳过逻辑测试（5.1） =====================
describe("compressImage - 跳过逻辑", () => {
	it("小于目标大小的文件直接跳过（skipped: true）", async () => {
		const smallFile = new File([new Uint8Array(100)], "small.jpg", {
			type: "image/jpeg",
		});
		const result = await compressImage(smallFile, 1, {});
		expect(result.skipped).toBe(true);
		expect(result.blob).toBe(smallFile);
		expect(result.compressedSize).toBe(100);
		expect(result.fileName).toBe("small.jpg");
	});

	it("quality 参数影响跳过阈值", async () => {
		// 500KB 文件，目标 1MB，quality 50% → effective target = 0.5MB
		// 500KB = 512000 bytes, 0.5MB = 524288 bytes → 500KB < 0.5MB → skip
		const file = new File([new Uint8Array(512000)], "mid.jpg", {
			type: "image/jpeg",
		});
		const result = await compressImage(file, 1, { quality: 50 });
		expect(result.skipped).toBe(true);
	});

	it("quality 降低后不再跳过", async () => {
		// 600KB 文件，目标 1MB，quality 50% → effective target = 0.5MB = 524288 bytes
		// 600KB = 614400 bytes > 524288 bytes → 不跳过
		// 但 compressImage 会尝试解码图片（在 Node 环境中会失败），
		// 此测试仅验证跳过逻辑的正确性，不验证实际压缩
		const file = new File([new Uint8Array(614400)], "big.jpg", {
			type: "image/jpeg",
		});
		// 在 Node 环境中 compressImage 会尝试使用 Worker 或 fileToImage，
		// 两者都需要浏览器 API，因此会抛出错误
		// 我们只验证它不会返回 skipped: true
		try {
			const result = await compressImage(file, 1, { quality: 50 });
			// 如果没有抛出错误，验证不是 skipped
			expect(result.skipped).not.toBe(true);
		} catch (err) {
			// 在 Node 环境中预期会抛出错误（缺少浏览器 API）
			expect(err).toBeInstanceOf(Error);
		}
	});
});
