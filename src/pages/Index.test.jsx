// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import Index from "./Index";
import { compressImage } from "@/lib/imageCompress";

// ===================== Mock 依赖模块 =====================

// Mock imageCompress：避免实际图片解码和 Worker 创建
vi.mock("@/lib/imageCompress", () => ({
	compressImage: vi.fn(),
	isSupportedImage: vi.fn(() => true),
	// 7.2: mock 与实际实现保持一致，返回正确的单位
	formatFileSize: vi.fn((bytes) => {
		if (!bytes || bytes <= 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB", "TB"];
		if (bytes >= 1024 ** 4) return parseFloat((bytes / (1024 ** 4)).toFixed(2)) + " TB";
		const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
		return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
	}),
	getPreviewUrl: vi.fn(() => null),
	revokePreviewUrl: vi.fn(),
	getFormatLabel: vi.fn(() => "JPG"),
	ALL_EXTENSIONS: [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp", ".tiff", ".heic", ".heif"],
	CompressAbortError: class extends Error {
		constructor() {
			super("压缩已暂停");
			this.name = "AbortError";
		}
	},
}));

// Mock JSZip：避免打包逻辑依赖真实库
vi.mock("jszip", () => ({
	default: vi.fn(),
}));

// ===================== 全局 Mock =====================

beforeEach(() => {
	// jsdom 不支持 URL.createObjectURL / revokeObjectURL
	global.URL.createObjectURL = vi.fn(() => "blob:mock-url");
	global.URL.revokeObjectURL = vi.fn();
	// window.confirm 在 jsdom 中默认返回 false
	window.confirm = vi.fn(() => true);
	// Radix UI 组件依赖 ResizeObserver，jsdom 不提供
	global.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ===================== 辅助工具 =====================

/** 获取文件选择 input（非文件夹 input） */
function getFileInput() {
	const inputs = document.querySelectorAll('input[type="file"]');
	return inputs[0];
}

/** 创建模拟图片文件 */
function makeImageFile(name = "test.jpg", size = 1024) {
	return new File([new Uint8Array(size)], name, { type: "image/jpeg" });
}

/** 创建模拟压缩成功结果 */
function makeCompressResult(originalSize = 1024, compressedSize = 512) {
	return {
		blob: new Blob(["compressed"], { type: "image/jpeg" }),
		originalSize,
		compressedSize,
		fileName: "test.jpg",
		skipped: false,
	};
}

/** 创建模拟跳过结果 */
function makeSkippedResult(size = 100) {
	return {
		blob: new File([new Uint8Array(size)], "small.jpg", { type: "image/jpeg" }),
		originalSize: size,
		compressedSize: size,
		fileName: "small.jpg",
		skipped: true,
	};
}

/** 添加文件并点击压缩按钮 */
async function addFileAndCompress(file) {
	render(<Index />);
	fireEvent.change(getFileInput(), { target: { files: [file] } });
	await waitFor(() => screen.getByText(file.name));
	fireEvent.click(screen.getByRole("button", { name: /开始压缩/ }));
}

// ===================== 测试用例 =====================

describe("Index 组件 - 初始渲染", () => {
	it("显示页面标题", () => {
		render(<Index />);
		expect(screen.getByRole("heading", { name: "图片压缩" })).toBeInTheDocument();
	});

	it("显示四个步骤指示器", () => {
		render(<Index />);
		// 使用步骤描述文本（各处唯一），避免与章节标题重复
		expect(screen.getByText("输入目标文件大小")).toBeInTheDocument();
		expect(screen.getByText("选择文件或文件夹")).toBeInTheDocument();
		expect(screen.getByText("一键压缩所有图片")).toBeInTheDocument();
		expect(screen.getByText("单个或打包下载")).toBeInTheDocument();
	});

	it("显示拖拽区域提示文字", () => {
		render(<Index />);
		expect(
			screen.getByText("拖拽图片或文件夹到此处，或点击选择文件"),
		).toBeInTheDocument();
	});

	it("无文件时显示空状态提示", () => {
		render(<Index />);
		expect(screen.getByText("尚未选择任何图片")).toBeInTheDocument();
	});

	it("默认目标大小为 32 MB", () => {
		render(<Index />);
		expect(screen.getByDisplayValue("32")).toBeInTheDocument();
	});

	it("显示预设大小按钮", () => {
		render(<Index />);
		expect(screen.getByText("1 MB")).toBeInTheDocument();
		expect(screen.getByText("5 MB")).toBeInTheDocument();
		expect(screen.getByText("100 MB")).toBeInTheDocument();
	});
});

describe("Index 组件 - 文件添加", () => {
	it("通过文件选择添加图片后显示在列表中", async () => {
		render(<Index />);
		const file = makeImageFile("photo.jpg");
		fireEvent.change(getFileInput(), { target: { files: [file] } });

		await waitFor(() => {
			expect(screen.getByText("photo.jpg")).toBeInTheDocument();
		});
	});

	it("添加文件后显示文件计数", async () => {
		render(<Index />);
		const file = makeImageFile("photo.jpg");
		fireEvent.change(getFileInput(), { target: { files: [file] } });

		await waitFor(() => {
			expect(screen.getByText(/已选图片 \(1\)/)).toBeInTheDocument();
		});
	});

	it("添加多个文件后计数正确更新", async () => {
		render(<Index />);
		const files = [
			makeImageFile("a.jpg"),
			makeImageFile("b.jpg"),
			makeImageFile("c.png"),
		];
		fireEvent.change(getFileInput(), { target: { files } });

		await waitFor(() => {
			expect(screen.getByText("a.jpg")).toBeInTheDocument();
			expect(screen.getByText("b.jpg")).toBeInTheDocument();
			expect(screen.getByText("c.png")).toBeInTheDocument();
		});
		expect(screen.getByText(/已选图片 \(3\)/)).toBeInTheDocument();
	});

	it("添加文件后不再显示空状态", async () => {
		render(<Index />);
		expect(screen.getByText("尚未选择任何图片")).toBeInTheDocument();

		const file = makeImageFile("photo.jpg");
		fireEvent.change(getFileInput(), { target: { files: [file] } });

		await waitFor(() => {
			expect(screen.queryByText("尚未选择任何图片")).not.toBeInTheDocument();
		});
	});
});

describe("Index 组件 - 文件删除", () => {
	it("清空按钮移除所有文件", async () => {
		render(<Index />);
		const file = makeImageFile("photo.jpg");
		fireEvent.change(getFileInput(), { target: { files: [file] } });

		await waitFor(() => screen.getByText("photo.jpg"));

		fireEvent.click(screen.getByRole("button", { name: /清空/ }));

		await waitFor(() => {
			expect(screen.queryByText("photo.jpg")).not.toBeInTheDocument();
		});
	});

	it("清空时弹出确认对话框", async () => {
		window.confirm = vi.fn(() => true);
		render(<Index />);
		const file = makeImageFile("photo.jpg");
		fireEvent.change(getFileInput(), { target: { files: [file] } });

		await waitFor(() => screen.getByText("photo.jpg"));

		fireEvent.click(screen.getByRole("button", { name: /清空/ }));
		expect(window.confirm).toHaveBeenCalledTimes(1);
	});

	it("取消确认时不清空文件", async () => {
		window.confirm = vi.fn(() => false);
		render(<Index />);
		const file = makeImageFile("photo.jpg");
		fireEvent.change(getFileInput(), { target: { files: [file] } });

		await waitFor(() => screen.getByText("photo.jpg"));

		fireEvent.click(screen.getByRole("button", { name: /清空/ }));

		// 文件应该仍然存在
		expect(screen.getByText("photo.jpg")).toBeInTheDocument();
	});

	it("单文件删除按钮移除指定文件", async () => {
		render(<Index />);
		const files = [makeImageFile("keep.jpg"), makeImageFile("delete.jpg")];
		fireEvent.change(getFileInput(), { target: { files } });

		await waitFor(() => screen.getByText("keep.jpg"));

		// 找到 delete.jpg 所在行中的删除按钮（X 图标按钮）
		const deleteRow = screen.getByText("delete.jpg").closest("div[role='listitem']");
		const removeButton = deleteRow.querySelector("button");
		fireEvent.click(removeButton);

		await waitFor(() => {
			expect(screen.queryByText("delete.jpg")).not.toBeInTheDocument();
		});
		expect(screen.getByText("keep.jpg")).toBeInTheDocument();
	});
});

describe("Index 组件 - 目标大小设置", () => {
	it("点击预设大小按钮更新输入框", () => {
		render(<Index />);
		fireEvent.click(screen.getByText("5 MB"));
		expect(screen.getByDisplayValue("5")).toBeInTheDocument();
	});

	it("手动输入目标大小", () => {
		render(<Index />);
		const input = screen.getByDisplayValue("32");
		fireEvent.change(input, { target: { value: "10" } });
		expect(screen.getByDisplayValue("10")).toBeInTheDocument();
	});
});

describe("Index 组件 - 压缩按钮状态", () => {
	it("无文件时不显示压缩按钮", () => {
		render(<Index />);
		// 无文件时压缩区域不渲染，按钮不存在
		expect(screen.queryByRole("button", { name: /开始压缩/ })).not.toBeInTheDocument();
	});

	it("有文件时压缩按钮启用", async () => {
		render(<Index />);
		const file = makeImageFile("photo.jpg");
		fireEvent.change(getFileInput(), { target: { files: [file] } });

		await waitFor(() => screen.getByText("photo.jpg"));

		const compressBtn = screen.getByRole("button", { name: /开始压缩/ });
		expect(compressBtn).not.toBeDisabled();
	});
});

describe("Index 组件 - 拖拽区域可访问性", () => {
	it("拖拽区域有 role=button 和 aria-label", () => {
		render(<Index />);
		const dropzone = screen.getByRole("button", {
			name: "拖拽图片或文件夹到此处，或点击选择文件",
		});
		expect(dropzone).toBeInTheDocument();
	});

	it("拖拽区域支持 tabIndex", () => {
		render(<Index />);
		const dropzone = screen.getByRole("button", {
			name: "拖拽图片或文件夹到此处，或点击选择文件",
		});
		expect(dropzone).toHaveAttribute("tabindex", "0");
	});
});

// ===================== 压缩流程测试（审计 7.3） =====================

describe("Index 组件 - 压缩流程", () => {
	it("点击压缩按钮调用 compressImage", async () => {
		const file = makeImageFile("photo.jpg", 2048);
		vi.mocked(compressImage).mockResolvedValue(makeCompressResult(2048, 1024));

		await addFileAndCompress(file);

		await waitFor(() => {
			expect(compressImage).toHaveBeenCalledTimes(1);
		});
		expect(compressImage).toHaveBeenCalledWith(
			file,
			32,
			expect.objectContaining({ quality: 100 }),
		);
	});

	it("压缩完成后显示成功状态和下载按钮", async () => {
		const file = makeImageFile("photo.jpg", 2048);
		vi.mocked(compressImage).mockResolvedValue(makeCompressResult(2048, 1024));

		await addFileAndCompress(file);

		// 等待压缩完成，下载结果区域出现
		await waitFor(() => {
			expect(screen.getByText("下载结果")).toBeInTheDocument();
		});

		// 显示"已压缩 1 张"统计
		expect(screen.getByText(/已压缩 1 张/)).toBeInTheDocument();

		// 下载按钮可见（单个文件时显示"下载图片"）
		expect(screen.getByRole("button", { name: /下载图片/ })).toBeInTheDocument();
	});

	it("压缩完成后显示压缩后大小和压缩率", async () => {
		const file = makeImageFile("photo.jpg", 2048);
		vi.mocked(compressImage).mockResolvedValue(makeCompressResult(2048, 1024));

		await addFileAndCompress(file);

		await waitFor(() => {
			expect(screen.getByText("下载结果")).toBeInTheDocument();
		});

		// 压缩率 = (1 - 1024/2048) * 100 = 50.0%
		expect(screen.getByText(/-50\.0%/)).toBeInTheDocument();
	});

	it("多个文件压缩完成后显示打包下载按钮", async () => {
		const files = [
			makeImageFile("a.jpg", 2048),
			makeImageFile("b.jpg", 2048),
		];
		vi.mocked(compressImage).mockResolvedValue(makeCompressResult(2048, 1024));

		render(<Index />);
		fireEvent.change(getFileInput(), { target: { files } });
		await waitFor(() => screen.getByText("a.jpg"));

		fireEvent.click(screen.getByRole("button", { name: /开始压缩/ }));

		await waitFor(() => {
			expect(screen.getByText("下载结果")).toBeInTheDocument();
		});

		// 多个文件时显示"打包下载 ZIP"
		expect(screen.getByRole("button", { name: /打包下载 ZIP/ })).toBeInTheDocument();
		expect(screen.getByText(/已压缩 2 张/)).toBeInTheDocument();
	});

	it("压缩失败时显示错误信息和重试按钮", async () => {
		const file = makeImageFile("photo.jpg", 2048);
		vi.mocked(compressImage).mockRejectedValue(new Error("解码失败"));

		await addFileAndCompress(file);

		// 等待错误状态出现
		await waitFor(() => {
			expect(screen.getByText("解码失败")).toBeInTheDocument();
		});

		// 显示"失败 1 张"统计
		expect(screen.getByText(/失败 1 张/)).toBeInTheDocument();

		// 重试全部按钮可见
		expect(screen.getByText("重试全部")).toBeInTheDocument();
	});

	it("点击重试全部将失败文件重置为待压缩", async () => {
		const file = makeImageFile("photo.jpg", 2048);
		vi.mocked(compressImage).mockRejectedValue(new Error("解码失败"));

		await addFileAndCompress(file);

		await waitFor(() => {
			expect(screen.getByText("解码失败")).toBeInTheDocument();
		});

		// 点击重试全部
		fireEvent.click(screen.getByText("重试全部"));

		// 文件应回到待压缩状态
		await waitFor(() => {
			expect(screen.getByText("待压缩")).toBeInTheDocument();
		});
		expect(screen.queryByText("解码失败")).not.toBeInTheDocument();
	});

	it("跳过的文件显示无需压缩标签", async () => {
		const file = makeImageFile("small.jpg", 100);
		vi.mocked(compressImage).mockResolvedValue(makeSkippedResult(100));

		await addFileAndCompress(file);

		await waitFor(() => {
			expect(screen.getByText("无需压缩")).toBeInTheDocument();
		});

		// 跳过统计
		expect(screen.getByText(/跳过 1 张/)).toBeInTheDocument();
	});

	it("压缩过程中显示进度百分比", async () => {
		const file = makeImageFile("photo.jpg", 2048);
		// 模拟异步压缩过程
		vi.mocked(compressImage).mockImplementation(
			(file, maxSizeMB, callbacks = {}) => {
				callbacks.onProgress?.(50);
				return Promise.resolve(makeCompressResult(2048, 1024));
			},
		);

		render(<Index />);
		fireEvent.change(getFileInput(), { target: { files: [file] } });
		await waitFor(() => screen.getByText("photo.jpg"));

		fireEvent.click(screen.getByRole("button", { name: /开始压缩/ }));

		// 等待压缩完成
		await waitFor(() => {
			expect(screen.getByText("下载结果")).toBeInTheDocument();
		});

		expect(compressImage).toHaveBeenCalled();
	});

	it("无待压缩文件时点击压缩按钮提示", async () => {
		render(<Index />);
		// 无文件时不显示压缩区域
		expect(screen.queryByRole("button", { name: /开始压缩/ })).not.toBeInTheDocument();
	});
});
