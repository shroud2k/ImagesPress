import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react";
import {
	Upload,
	FolderOpen,
	Image as ImageIcon,
	Zap,
	Download,
	Trash2,
	X,
	CheckCircle2,
	AlertCircle,
	Loader2,
	FileImage,
	ArrowRight,
	Package,
	RotateCcw,
	Info,
	ChevronDown,
	Pause,
	Play,
	ExternalLink,
	Repeat,
	RotateCw,
	Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { toast } from "sonner";
import JSZip from "jszip";
import {
	compressImage,
	CompressAbortError,
	isSupportedImage,
	formatFileSize,
	getPreviewUrl,
	getFormatLabel,
	ALL_EXTENSIONS,
} from "@/lib/imageCompress";

const C = {
	blue: "#0f62fe",
	blueHover: "#0050e6",
	blue60: "#0043ce",
	ink: "#161616",
	inkMuted: "#525252",
	inkSubtle: "#8c8c8c",
	canvas: "#ffffff",
	surface1: "#f4f4f4",
	surface2: "#e0e0e0",
	hairline: "#e0e0e0",
	success: "#24a148",
	error: "#da1e28",
	warning: "#f1c21b",
};

const STEPS = [
	{ num: "01", title: "设置大小限制", desc: "输入目标文件大小" },
	{ num: "02", title: "选择图片", desc: "选择文件或文件夹" },
	{ num: "03", title: "开始压缩", desc: "一键压缩所有图片" },
	{ num: "04", title: "下载结果", desc: "单个或打包下载" },
];

const PRESET_SIZES = [
	{ label: "1 MB", value: 1 },
	{ label: "2 MB", value: 2 },
	{ label: "5 MB", value: 5 },
	{ label: "10 MB", value: 10 },
	{ label: "20 MB", value: 20 },
	{ label: "32 MB", value: 32 },
	{ label: "50 MB", value: 50 },
	{ label: "100 MB", value: 100 },
];

const RELATED_TOOLS = [
	{
		title: "图片格式转换",
		url: "https://ic.yiruoyu.com",
		Icon: Repeat,
		desc: "在线图片格式转换",
	},
	{
		title: "图片压缩",
		url: "https://ip.yiruoyu.com",
		Icon: Zap,
		desc: "在线图片压缩",
	},
	{
		title: "图片自适应旋转",
		url: "https://ir.yiruoyu.com",
		Icon: RotateCw,
		desc: "在线图片自适应旋转",
	},
	{
		title: "视频体积压缩",
		url: "https://v.yiruoyu.com",
		Icon: Video,
		desc: "在线视频体积压缩",
	},
];

const RENDER_BATCH = 10;
const CONCURRENT_LIMIT = 3;
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 单文件最大 200MB（1.1）
const MAX_FILE_COUNT = 100; // 最多 100 个文件（1.2）

// 使用时间戳+随机数生成唯一 ID，避免 HMR 后计数器不重置的问题（3.2）
const nextId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

async function extractFilesFromDataTransfer(dataTransfer) {
	const allFiles = [];
	if (dataTransfer.items && dataTransfer.items.length > 0) {
		const entries = [];
		for (let i = 0; i < dataTransfer.items.length; i++) {
			const item = dataTransfer.items[i];
			const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
			if (entry) {
				entries.push(entry);
			} else {
				const file = item.getAsFile?.();
				if (file) allFiles.push(file);
			}
		}
		if (entries.length > 0) {
			for (const entry of entries) {
				await traverseEntry(entry, allFiles);
			}
			return allFiles;
		}
	}
	if (dataTransfer.files && dataTransfer.files.length > 0) {
		for (let i = 0; i < dataTransfer.files.length; i++) {
			allFiles.push(dataTransfer.files[i]);
		}
	}
	return allFiles;
}

async function traverseEntry(entry, allFiles) {
	if (entry.isFile) {
		return new Promise((resolve) => {
			entry.file(
				(f) => {
					allFiles.push(f);
					resolve();
				},
				() => resolve(),
			);
		});
	}
	if (entry.isDirectory) {
		const reader = entry.createReader();
		const entries = await readAllEntriesSafe(reader);
		for (const sub of entries) {
			await traverseEntry(sub, allFiles);
		}
	}
}

function readAllEntriesSafe(reader) {
	return new Promise((resolve) => {
		if (typeof reader.readAllEntries === "function") {
			reader.readAllEntries(resolve, (err) => {
				console.warn("readAllEntries 失败:", err);
				resolve([]);
			});
			return;
		}
		const allEntries = [];
		const readBatch = () => {
			reader.readEntries(
				(batch) => {
					if (batch.length === 0) resolve(allEntries);
					else {
						allEntries.push(...batch);
						readBatch();
					}
				},
				(err) => {
					console.warn("readEntries 失败:", err);
					resolve(allEntries);
				},
			);
		};
		readBatch();
	});
}

const FileRow = memo(function FileRow({
	item,
	onRemove,
	onDownload,
	onRetry,
	isCompressing,
}) {
	const { file, status, progress, result, error, preview } = item;
	const ext = getFormatLabel(file.name);
	const compressionRatio = result
		? ((1 - result.compressedSize / result.originalSize) * 100).toFixed(1)
		: null;

	return (
		<div
			className="flex items-center gap-4 px-4 py-3"
			style={{ backgroundColor: C.canvas }}
		>
			<div
				className="w-12 h-12 flex-shrink-0 flex items-center justify-center overflow-hidden"
				style={{ backgroundColor: C.surface1 }}
			>
				{preview ? (
					<img
						src={preview}
						alt={file.name}
						className="w-full h-full object-cover"
						loading="lazy"
					/>
				) : (
					<FileImage className="w-5 h-5" style={{ color: C.inkSubtle }} />
				)}
			</div>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2 mb-0.5">
					<p className="text-sm truncate font-normal" style={{ color: C.ink }}>
						{file.name}
					</p>
					<span
						className="px-1.5 py-0.5 text-[10px] font-semibold uppercase flex-shrink-0"
						style={{ backgroundColor: C.surface1, color: C.inkMuted }}
					>
						{ext}
					</span>
				</div>
				<div
					className="flex items-center gap-3 text-xs"
					style={{ color: C.inkSubtle }}
				>
					<span>{formatFileSize(file.size)}</span>
					{result && (
						<>
							<ArrowRight className="w-3 h-3" />
							<span style={{ color: C.success }}>
								{formatFileSize(result.compressedSize)}
							</span>
							<span style={{ color: C.success }}>(-{compressionRatio}%)</span>
						</>
					)}
					{result?.skipped && (
						<span style={{ color: C.inkSubtle }}>
							(已小于目标大小，无需压缩)
						</span>
					)}
				</div>
				{status === "compressing" && (
					<div className="mt-1.5">
						<Progress
							value={progress}
							className="h-1 rounded-none"
							style={{ backgroundColor: C.surface2 }}
						/>
					</div>
				)}
				{status === "error" && (
					<p className="text-xs mt-1" style={{ color: C.error }}>
						{error}
					</p>
				)}
			</div>
			<div className="flex items-center gap-2 flex-shrink-0">
				{status === "pending" && (
					<span
						className="text-xs px-2 py-1"
						style={{ backgroundColor: C.surface1, color: C.inkMuted }}
					>
						待压缩
					</span>
				)}
				{status === "compressing" && (
					<Loader2 className="w-4 h-4 animate-spin" style={{ color: C.blue }} />
				)}
				{status === "done" && !result?.skipped && (
					<>
						<CheckCircle2 className="w-4 h-4" style={{ color: C.success }} />
						<Button
							variant="ghost"
							size="sm"
							className="h-8 w-8 p-0 rounded-none"
							onClick={() => onDownload(item)}
						>
							<Download className="w-4 h-4" style={{ color: C.blue }} />
						</Button>
					</>
				)}
				{status === "done" && result?.skipped && (
					<span
						className="text-xs px-2 py-1"
						style={{ backgroundColor: C.surface1, color: C.inkSubtle }}
					>
						无需压缩
					</span>
				)}
				{status === "error" && (
					<>
						<AlertCircle className="w-4 h-4" style={{ color: C.error }} />
						<Button
							variant="ghost"
							size="sm"
							className="h-8 w-8 p-0 rounded-none"
							onClick={() => onRetry(item)}
						>
							<RotateCcw className="w-4 h-4" style={{ color: C.blue }} />
						</Button>
					</>
				)}
				{status !== "compressing" && (
					<Button
						variant="ghost"
						size="sm"
						className="h-8 w-8 p-0 rounded-none"
						onClick={() => onRemove(item.id)}
						disabled={isCompressing}
					>
						<X className="w-4 h-4" style={{ color: C.inkSubtle }} />
					</Button>
				)}
			</div>
		</div>
	);
});
const Index = () => {
	const [maxSizeMB, setMaxSizeMB] = useState(32);
	const [maxSizeInput, setMaxSizeInput] = useState("32");
	const [quality, setQuality] = useState(100);
	const [files, setFiles] = useState([]);
	const [isCompressing, setIsCompressing] = useState(false);
	const [isPaused, setIsPaused] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
	const [overallProgress, setOverallProgress] = useState(0);
	const [currentStep, setCurrentStep] = useState(1);
	const [visibleCount, setVisibleCount] = useState(RENDER_BATCH);

	const fileInputRef = useRef(null);
	const folderInputRef = useRef(null);
	const filesRef = useRef(files);
	filesRef.current = files;
	const pausedRef = useRef(false);
	const pauseResolversRef = useRef([]);

	const waitIfPaused = useCallback(() => {
		if (!pausedRef.current) return Promise.resolve();
		return new Promise((resolve) => {
			pauseResolversRef.current.push(resolve);
		});
	}, []);

	const togglePause = useCallback(() => {
		if (pausedRef.current) {
			pausedRef.current = false;
			setIsPaused(false);
			const resolvers = pauseResolversRef.current;
			pauseResolversRef.current = [];
			resolvers.forEach((r) => r());
		} else {
			pausedRef.current = true;
			setIsPaused(true);
		}
	}, []);

	const pendingFiles = useMemo(
		() => files.filter((f) => f.status === "pending"),
		[files],
	);
	const doneFiles = useMemo(
		() => files.filter((f) => f.status === "done" && !f.result?.skipped),
		[files],
	);
	const skippedFiles = useMemo(
		() => files.filter((f) => f.status === "done" && f.result?.skipped),
		[files],
	);
	const errorFiles = useMemo(
		() => files.filter((f) => f.status === "error"),
		[files],
	);
	const totalOriginal = useMemo(
		() => files.reduce((s, f) => s + f.file.size, 0),
		[files],
	);
	const totalCompressed = useMemo(
		() => doneFiles.reduce((s, f) => s + (f.result?.compressedSize || 0), 0),
		[doneFiles],
	);
	const hasResults = doneFiles.length > 0 || skippedFiles.length > 0;
	const visibleFiles = useMemo(
		() => files.slice(0, visibleCount),
		[files, visibleCount],
	);
	const hasMoreFiles = visibleCount < files.length;

	useEffect(() => {
		if (hasResults) setCurrentStep(4);
		else if (isCompressing) setCurrentStep(3);
		else if (files.length > 0) setCurrentStep(3);
		else if (maxSizeMB > 0) setCurrentStep(2);
		else setCurrentStep(1);
	}, [files.length, isCompressing, hasResults, maxSizeMB]);

	const loadMore = useCallback(() => {
		setVisibleCount((prev) =>
			Math.min(prev + RENDER_BATCH, filesRef.current.length),
		);
	}, []);
	const loadAll = useCallback(() => {
		setVisibleCount(filesRef.current.length);
	}, []);

	const addFiles = useCallback((fileList) => {
		// 文件数量限制（1.2）
		if (filesRef.current.length + fileList.length > MAX_FILE_COUNT) {
			toast.error(`最多支持 ${MAX_FILE_COUNT} 个文件，当前已有 ${filesRef.current.length} 个`);
			return;
		}
		const newFiles = [],
			unsupported = [],
			tooLarge = [];
		for (const file of fileList) {
			// 文件大小限制（1.1）
			if (file.size > MAX_FILE_SIZE) {
				tooLarge.push(file.name);
				continue;
			}
			if (isSupportedImage(file)) {
				newFiles.push({
					id: nextId(),
					file,
					status: "pending",
					progress: 0,
					result: null,
					error: null,
					preview: getPreviewUrl(file, 50),
				});
			} else {
				unsupported.push(file.name);
			}
		}
		if (tooLarge.length > 0)
			toast.error(`${tooLarge.length} 个文件超过 200MB 限制：${tooLarge.slice(0, 3).join("、")}${tooLarge.length > 3 ? " 等" : ""}`);
		if (unsupported.length > 0)
			toast.warning(`已跳过 ${unsupported.length} 个不支持的文件`);
		if (newFiles.length > 0) {
			setFiles((prev) => [...prev, ...newFiles]);
			toast.success(`已添加 ${newFiles.length} 张图片`);
		}
	}, []);

	const handleFileSelect = (e) => {
		if (e.target.files?.length) addFiles(Array.from(e.target.files));
		e.target.value = "";
	};
	const handleFolderSelect = (e) => {
		if (e.target.files?.length) addFiles(Array.from(e.target.files));
		e.target.value = "";
	};
	const handleDragOver = (e) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
	};
	const handleDragLeave = (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (e.currentTarget === e.target) setIsDragOver(false);
	};

	const handleDrop = useCallback(
		async (e) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);
			toast.info("正在读取文件...");
			try {
				const allFiles = await extractFilesFromDataTransfer(e.dataTransfer);
				if (allFiles.length > 0) addFiles(allFiles);
				else toast.warning("未检测到有效文件");
			} catch (err) {
				toast.error("读取文件失败: " + err.message);
			}
		},
		[addFiles],
	);

	const removeFile = useCallback((id) => {
		setFiles((prev) => {
			const f = prev.find((x) => x.id === id);
			if (f?.preview) URL.revokeObjectURL(f.preview);
			return prev.filter((x) => x.id !== id);
		});
	}, []);

	const clearAll = useCallback(() => {
		// 基于快照清空，避免竞态（4.2）
		const snapshot = filesRef.current;
		if (snapshot.length > 0 && !window.confirm(`确定要清空所有 ${snapshot.length} 个文件吗？`)) {
			return;
		}
		snapshot.forEach((f) => {
			if (f.preview) URL.revokeObjectURL(f.preview);
		});
		setFiles([]);
		setOverallProgress(0);
		setVisibleCount(RENDER_BATCH);
	}, []);

	// 重置单个失败文件为待压缩状态（4.4）
	const retryFile = useCallback((id) => {
		setFiles((prev) =>
			prev.map((f) =>
				f.id === id ? { ...f, status: "pending", progress: 0, error: null } : f
			)
		);
	}, []);

	// 重置所有失败文件为待压缩状态（4.4）
	const retryAllFailed = useCallback(() => {
		setFiles((prev) =>
			prev.map((f) =>
				f.status === "error" ? { ...f, status: "pending", progress: 0, error: null } : f
			)
		);
	}, []);

	const handleCompress = useCallback(async () => {
		const currentPending = filesRef.current.filter(
			(f) => f.status === "pending",
		);
		if (currentPending.length === 0) {
			toast.info("没有待压缩的图片");
			return;
		}
		if (maxSizeMB <= 0) {
			toast.error("请设置有效的目标大小");
			return;
		}
		// 目标大小下限警告（4.1）
		if (maxSizeMB < 0.5) {
			toast.warning("目标大小较小，压缩后画质可能有明显损失");
		}
		setIsCompressing(true);
		setOverallProgress(0);
		pausedRef.current = false;
		setIsPaused(false);
		const total = currentPending.length;
		let completed = 0,
			succeeded = 0,
			failed = 0,
			skipped = 0;
		const updateFile = (id, updates) =>
			setFiles((prev) =>
				prev.map((f) => (f.id === id ? { ...f, ...updates } : f)),
			);

		const queue = [...currentPending];

		const compressOne = async (fileItem) => {
			updateFile(fileItem.id, { status: "compressing", progress: 0 });
			try {
				const result = await compressImage(fileItem.file, maxSizeMB, {
					quality,
					onProgress: (p) => updateFile(fileItem.id, { progress: p }),
					shouldAbort: () => pausedRef.current,
				});
				updateFile(fileItem.id, { status: "done", progress: 100, result });
				if (result.skipped) skipped++;
				else succeeded++;
			} catch (err) {
				if (err instanceof CompressAbortError || err?.name === "AbortError") {
					// 暂停触发的中断：重置为待压缩并重新入队，不计入完成数
					updateFile(fileItem.id, { status: "pending", progress: 0 });
					queue.unshift(fileItem);
					return;
				}
				updateFile(fileItem.id, { status: "error", error: err.message });
				failed++;
			}
			completed++;
			setOverallProgress(Math.round((completed / total) * 100));
		};

		const workers = Array(Math.min(CONCURRENT_LIMIT, queue.length))
			.fill(null)
			.map(async () => {
				while (queue.length > 0) {
					await waitIfPaused();
					if (queue.length === 0) break;
					const item = queue.shift();
					if (item) await compressOne(item);
				}
			});
		// 并发控制：JavaScript 单线程下 shift() 是原子的，多个 worker 不会重复处理同一文件（5.3）
		try {
			await Promise.all(workers);
			const parts = [];
			if (succeeded > 0) parts.push(`${succeeded} 张已压缩`);
			if (skipped > 0) parts.push(`${skipped} 张已小于 ${maxSizeMB}MB，无需压缩`);
			if (failed > 0) parts.push(`${failed} 张失败`);
			if (succeeded > 0)
				toast.success("压缩完成！", { description: parts.join("，") });
			else if (skipped > 0 && failed === 0)
				toast.info("没有需要压缩的图片", {
					description: `所有图片都已小于 ${maxSizeMB}MB，无需压缩`,
				});
			else toast.warning("压缩完成", { description: parts.join("，") });
		} catch (err) {
			// 全局错误兜底：防止异常导致 isCompressing 状态无法重置（3.3）
			toast.error("压缩过程出错: " + err.message);
		} finally {
			setIsCompressing(false);
			pausedRef.current = false;
			setIsPaused(false);
		}
	}, [maxSizeMB, quality]);

	const downloadSingle = useCallback((fileItem) => {
		if (!fileItem.result) return;
		let url;
		try {
			url = URL.createObjectURL(fileItem.result.blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = fileItem.result.fileName;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} finally {
			// 确保异常时也能释放 Object URL（3.4）
			if (url) URL.revokeObjectURL(url);
		}
	}, []);

	const downloadAll = useCallback(async () => {
		if (doneFiles.length === 0) return;
		if (doneFiles.length === 1) {
			downloadSingle(doneFiles[0]);
			return;
		}
		const zipToastId = "zip-packaging";
		toast.loading("正在打包 ZIP...", { id: zipToastId });
		let url;
		try {
			const zip = new JSZip();
			for (const f of doneFiles) {
				if (f.result) zip.file(f.result.fileName, f.result.blob);
			}
			const content = await zip.generateAsync(
				{ type: "blob" },
				// ZIP 打包进度反馈（2.4）
				(metadata) => {
					toast.loading(`正在打包 ZIP... ${Math.round(metadata.percent)}%`, {
						id: zipToastId,
					});
				},
			);
			url = URL.createObjectURL(content);
			const a = document.createElement("a");
			a.href = url;
			a.download = "compressed-images.zip";
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			toast.success("ZIP 下载已开始", { id: zipToastId });
		} catch (err) {
			toast.error("打包失败: " + err.message, { id: zipToastId });
		} finally {
			// 确保异常时也能释放 Object URL（3.4）
			if (url) URL.revokeObjectURL(url);
		}
	}, [doneFiles, downloadSingle]);

	const handleSizeInputChange = (val) => {
		setMaxSizeInput(val);
		const num = parseFloat(val);
		if (!isNaN(num) && num > 0) setMaxSizeMB(num);
	};
	const applyPreset = (val) => {
		setMaxSizeMB(val);
		setMaxSizeInput(String(val));
	};

	useEffect(() => {
		return () => {
			filesRef.current.forEach((f) => {
				if (f.preview) URL.revokeObjectURL(f.preview);
			});
		};
	}, []);

	return (
		<div
			className="min-h-screen"
			style={{
				backgroundColor: C.canvas,
				fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
			}}
		>
			<header
				className="border-b"
				style={{ borderColor: C.hairline, backgroundColor: C.canvas }}
			>
				<div className="max-w-[1200px] mx-auto px-6 h-14 flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div
							className="w-8 h-8 flex items-center justify-center"
							style={{ backgroundColor: C.blue }}
						>
							<Zap className="w-4 h-4 text-white" />
						</div>
						<span
							className="text-sm font-semibold tracking-wide"
							style={{ color: C.ink }}
						>
							ImagePress
						</span>
					</div>
					<span className="text-xs" style={{ color: C.inkSubtle }}>
						图片压缩工具
					</span>
				</div>
			</header>

			<section
				className="border-b"
				style={{ borderColor: C.hairline, backgroundColor: C.canvas }}
			>
				<div className="max-w-[1200px] mx-auto px-6 pt-16 pb-12">
					<p className="text-sm mb-4 tracking-wide" style={{ color: C.blue }}>
						免费 · 在线 · 无需上传服务器
					</p>
					<h1
						className="font-light leading-[1.17] tracking-[-0.5px] mb-6"
						style={{ color: C.ink, fontSize: "clamp(42px, 6vw, 76px)" }}
					>
						图片压缩
					</h1>
					<p
						className="text-lg max-w-[560px] leading-[1.5]"
						style={{ color: C.inkMuted }}
					>
						将图片压缩到指定大小，支持
						JPEG、PNG、GIF、WebP、AVIF、TIFF、HEIC、BMP
						等多种格式。所有处理均在浏览器本地完成，保护您的隐私。
					</p>
				</div>
			</section>

			<section
				className="border-b"
				style={{ borderColor: C.hairline, backgroundColor: C.surface1 }}
			>
				<div className="max-w-[1200px] mx-auto px-6 py-6">
					<div className="grid grid-cols-2 md:grid-cols-4 gap-0">
						{STEPS.map((step, i) => (
							<div
								key={step.num}
								className="flex items-start gap-3 px-4 py-3"
								style={{
									borderLeft: i > 0 ? `1px solid ${C.hairline}` : "none",
									opacity: currentStep >= i + 1 ? 1 : 0.4,
								}}
							>
								<span
									className="text-2xl font-light mt-0.5"
									style={{ color: currentStep >= i + 1 ? C.blue : C.inkSubtle }}
								>
									{step.num}
								</span>
								<div>
									<p className="text-sm font-semibold" style={{ color: C.ink }}>
										{step.title}
									</p>
									<p className="text-xs mt-0.5" style={{ color: C.inkSubtle }}>
										{step.desc}
									</p>
								</div>
							</div>
						))}
					</div>
				</div>
			</section>

			<main className="max-w-[1200px] mx-auto px-6 py-12">
				<section className="mb-10">
					<div className="flex items-center gap-2 mb-6">
						<span
							className="w-6 h-6 flex items-center justify-center text-xs font-semibold text-white"
							style={{ backgroundColor: C.blue }}
						>
							1
						</span>
						<h2 className="text-xl font-normal" style={{ color: C.ink }}>
							设置目标大小
						</h2>
					</div>
					<div
						className="border p-6"
						style={{ borderColor: C.hairline, backgroundColor: C.canvas }}
					>
						<div className="flex flex-col sm:flex-row items-start sm:items-end gap-4">
							<div className="flex-1 max-w-[280px]">
								<label
									className="block text-sm mb-2"
									style={{ color: C.inkMuted }}
								>
									压缩后每张图片不超过
								</label>
								<div className="flex items-center gap-2">
								<Input
									type="number"
									min="0.1"
									max="200"
									step="0.1"
										value={maxSizeInput}
										onChange={(e) => handleSizeInputChange(e.target.value)}
										className="h-12 text-lg border rounded-none focus-visible:ring-1"
										style={{ borderColor: C.inkSubtle, color: C.ink }}
									/>
									<span
										className="text-lg font-normal whitespace-nowrap"
										style={{ color: C.ink }}
									>
										MB
									</span>
								</div>
							</div>
							<div className="flex flex-wrap gap-2">
								{PRESET_SIZES.map((p) => (
									<button
										key={p.value}
										onClick={() => applyPreset(p.value)}
										className="px-3 py-2 text-sm border transition-colors"
										style={{
											borderColor: maxSizeMB === p.value ? C.blue : C.hairline,
											backgroundColor:
												maxSizeMB === p.value ? C.blue : C.canvas,
											color: maxSizeMB === p.value ? "#fff" : C.inkMuted,
										}}
									>
										{p.label}
									</button>
								))}
							</div>
						</div>
						<div
							className="mt-6 pt-6 border-t"
							style={{ borderColor: C.hairline }}
						>
							<div className="flex items-center justify-between mb-3">
								<label className="text-sm" style={{ color: C.inkMuted }}>
									输出质量
								</label>
								<span
									className="text-sm font-semibold"
									style={{ color: C.ink }}
								>
									{quality}%
								</span>
							</div>
							<Slider
								value={[quality]}
								onValueChange={(val) => setQuality(val[0])}
								min={10}
								max={100}
								step={5}
								className="w-full"
							/>
							<div
								className="mt-3 flex items-start gap-2 text-sm"
								style={{ color: C.inkSubtle }}
							>
								<Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
						<span>
							100% = 压缩到 {maxSizeMB}MB。降低百分比可进一步缩小文件，例如 90% ≈{" "}
							{(maxSizeMB * 0.9).toFixed(1)}MB。数值越低文件越小，画质损失越大。
						</span>
							</div>
						</div>
						<div
							className="mt-4 flex items-start gap-2 text-sm"
							style={{ color: C.inkSubtle }}
						>
							<Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
							<span>
								已小于目标大小的图片将直接跳过压缩。压缩过程在浏览器本地完成，不会上传到服务器。
							</span>
						</div>
					</div>
				</section>

				<section className="mb-10">
					<div className="flex items-center gap-2 mb-6">
						<span
							className="w-6 h-6 flex items-center justify-center text-xs font-semibold text-white"
							style={{ backgroundColor: C.blue }}
						>
							2
						</span>
						<h2 className="text-xl font-normal" style={{ color: C.ink }}>
							选择图片
						</h2>
					</div>
					<div
						onDragOver={handleDragOver}
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
						role="button"
						tabIndex={0}
						aria-label="拖拽图片或文件夹到此处，或点击选择文件"
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								fileInputRef.current?.click();
							}
						}}
						className="border-2 border-dashed p-12 text-center transition-colors cursor-pointer"
						style={{
							borderColor: isDragOver ? C.blue : C.hairline,
							backgroundColor: isDragOver ? "#edf5ff" : C.surface1,
						}}
						onClick={() => fileInputRef.current?.click()}
					>
						<div className="flex flex-col items-center gap-4">
							<div
								className="w-16 h-16 flex items-center justify-center"
								style={{ backgroundColor: isDragOver ? C.blue : C.surface2 }}
							>
								<Upload
									className="w-7 h-7"
									style={{ color: isDragOver ? "#fff" : C.inkMuted }}
								/>
							</div>
							<div>
								<p
									className="text-base font-normal mb-1"
									style={{ color: C.ink }}
								>
									拖拽图片或文件夹到此处，或点击选择文件
								</p>
								<p className="text-sm" style={{ color: C.inkSubtle }}>
									支持 JPEG、PNG、GIF、WebP、AVIF、TIFF、HEIC、BMP 等格式
								</p>
							</div>
							<div className="flex gap-3 mt-2">
								<Button
									variant="outline"
									className="rounded-none h-10 px-5 text-sm"
									style={{ borderColor: C.blue, color: C.blue }}
									onClick={(e) => {
										e.stopPropagation();
										fileInputRef.current?.click();
									}}
								>
									<FileImage className="w-4 h-4 mr-2" />
									选择图片
								</Button>
								<Button
									variant="outline"
									className="rounded-none h-10 px-5 text-sm"
									style={{ borderColor: C.inkMuted, color: C.inkMuted }}
									onClick={(e) => {
										e.stopPropagation();
										folderInputRef.current?.click();
									}}
								>
									<FolderOpen className="w-4 h-4 mr-2" />
									选择文件夹
								</Button>
							</div>
						</div>
					</div>
					<input
						ref={fileInputRef}
						type="file"
						multiple
						accept={ALL_EXTENSIONS.join(",") + ",image/*"}
						className="hidden"
						onChange={handleFileSelect}
					/>
					<input
						ref={folderInputRef}
						type="file"
						multiple
						webkitdirectory=""
						className="hidden"
						onChange={handleFolderSelect}
					/>
					<div className="mt-4 flex flex-wrap gap-1.5">
						{[
							"JPEG",
							"PNG",
							"GIF",
							"WebP",
							"AVIF",
							"TIFF",
							"HEIC",
							"BMP",
						].map((fmt) => (
							<span
								key={fmt}
								className="px-2 py-1 text-xs border"
								style={{
									borderColor: C.hairline,
									color: C.inkSubtle,
									backgroundColor: C.canvas,
								}}
							>
								{fmt}
							</span>
						))}
					</div>
				</section>

				{files.length > 0 && (
					<section className="mb-10">
						<div className="flex items-center justify-between mb-4">
							<div className="flex items-center gap-3">
								<h3
									className="text-base font-semibold"
									style={{ color: C.ink }}
								>
									已选图片 ({files.length})
								</h3>
								<span className="text-sm" style={{ color: C.inkSubtle }}>
									总计 {formatFileSize(totalOriginal)}
								</span>
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="text-sm rounded-none"
								style={{ color: C.inkMuted }}
								onClick={clearAll}
								disabled={isCompressing}
							>
								<Trash2 className="w-4 h-4 mr-1" />
								清空
							</Button>
						</div>
						<div
							className="border divide-y"
							style={{ borderColor: C.hairline }}
						>
						{visibleFiles.map((fileItem) => (
							<FileRow
								key={fileItem.id}
								item={fileItem}
								onRemove={removeFile}
								onDownload={downloadSingle}
								onRetry={retryFile}
								isCompressing={isCompressing}
							/>
						))}
						</div>
						{hasMoreFiles && (
							<div
								className="flex items-center justify-center gap-3 py-4 border border-t-0"
								style={{ borderColor: C.hairline, backgroundColor: C.surface1 }}
							>
								<span className="text-sm" style={{ color: C.inkSubtle }}>
									已显示 {visibleCount} / {files.length} 张
								</span>
								<Button
									variant="outline"
									size="sm"
									className="rounded-none h-9 px-4 text-sm"
									style={{ borderColor: C.blue, color: C.blue }}
									onClick={loadMore}
								>
									<ChevronDown className="w-4 h-4 mr-1" />
									加载更多 (
									{Math.min(RENDER_BATCH, files.length - visibleCount)} 张)
								</Button>
								<Button
									variant="ghost"
									size="sm"
									className="rounded-none h-9 px-4 text-sm"
									style={{ color: C.inkMuted }}
									onClick={loadAll}
								>
									全部加载
								</Button>
							</div>
						)}
					</section>
				)}

				{files.length > 0 && (
					<section className="mb-10">
						<div className="flex items-center gap-2 mb-6">
							<span
								className="w-6 h-6 flex items-center justify-center text-xs font-semibold text-white"
								style={{ backgroundColor: C.blue }}
							>
								3
							</span>
							<h2 className="text-xl font-normal" style={{ color: C.ink }}>
								开始压缩
							</h2>
						</div>
						<div
							className="border p-6"
							style={{ borderColor: C.hairline, backgroundColor: C.canvas }}
						>
							<div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
								<Button
									onClick={handleCompress}
									disabled={
										isCompressing || pendingFiles.length === 0 || maxSizeMB <= 0
									}
									className="h-12 px-8 text-sm rounded-none"
									style={{
										backgroundColor:
											isCompressing || pendingFiles.length === 0
												? C.inkSubtle
												: C.blue,
										color: "#fff",
									}}
								>
								{isCompressing ? (
									<>
										{isPaused ? (
											<Pause className="w-4 h-4 mr-2" />
										) : (
											<Loader2 className="w-4 h-4 mr-2 animate-spin" />
										)}
										{isPaused
											? `已暂停 ${overallProgress}%`
											: `正在压缩... ${overallProgress}%`}
									</>
								) : (
									<>
										<Zap className="w-4 h-4 mr-2" />
										开始压缩 ({pendingFiles.length} 张图片)
									</>
								)}
							</Button>
							{isCompressing && (
								<Button
									variant="outline"
									onClick={togglePause}
									className="h-12 px-6 text-sm rounded-none"
									style={{ borderColor: C.blue, color: C.blue }}
								>
									{isPaused ? (
										<>
											<Play className="w-4 h-4 mr-2" />
											继续压缩
										</>
									) : (
										<>
											<Pause className="w-4 h-4 mr-2" />
											暂停压缩
										</>
									)}
								</Button>
							)}
							{isCompressing && (
								<div className="flex-1 w-full sm:w-auto">
									<Progress
										value={overallProgress}
										className="h-2 rounded-none"
										style={{ backgroundColor: C.surface2 }}
									/>
								</div>
							)}
							</div>
							{(doneFiles.length > 0 ||
								skippedFiles.length > 0 ||
								errorFiles.length > 0) &&
								!isCompressing && (
									<div className="mt-4 flex flex-wrap gap-4 text-sm">
										{doneFiles.length > 0 && (
											<span style={{ color: C.success }}>
												<CheckCircle2 className="w-4 h-4 inline mr-1" />
												已压缩 {doneFiles.length} 张
											</span>
										)}
										{skippedFiles.length > 0 && (
											<span style={{ color: C.inkMuted }}>
												<Info className="w-4 h-4 inline mr-1" />
												跳过 {skippedFiles.length} 张（已小于 {maxSizeMB}MB）
											</span>
										)}
										{errorFiles.length > 0 && (
											<span style={{ color: C.error }} className="flex items-center">
												<AlertCircle className="w-4 h-4 inline mr-1" />
												失败 {errorFiles.length} 张
												<button
													onClick={retryAllFailed}
													className="ml-2 text-xs underline hover:opacity-70"
													style={{ color: C.blue }}
												>
													重试全部
												</button>
											</span>
										)}
										{totalCompressed > 0 && totalOriginal > 0 && (
											<span style={{ color: C.inkMuted }}>
												节省空间:{" "}
												{formatFileSize(totalOriginal - totalCompressed)}(
												{((1 - totalCompressed / totalOriginal) * 100).toFixed(
													1,
												)}
												%)
											</span>
										)}
									</div>
								)}
						</div>
					</section>
				)}

				{hasResults && !isCompressing && (
					<section className="mb-10">
						<div className="flex items-center gap-2 mb-6">
							<span
								className="w-6 h-6 flex items-center justify-center text-xs font-semibold text-white"
								style={{ backgroundColor: C.blue }}
							>
								4
							</span>
							<h2 className="text-xl font-normal" style={{ color: C.ink }}>
								下载结果
							</h2>
						</div>
						<div
							className="border p-6"
							style={{ borderColor: C.hairline, backgroundColor: C.canvas }}
						>
							<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
								<div>
									<p
										className="text-base font-normal mb-1"
										style={{ color: C.ink }}
									>
											{doneFiles.length > 0
												? `${doneFiles.length} 张图片已压缩完成`
												: `${skippedFiles.length} 张图片已小于目标大小，无需压缩`}
									</p>
									<p className="text-sm" style={{ color: C.inkSubtle }}>
										原始总大小 {formatFileSize(totalOriginal)} → 压缩后{" "}
										{formatFileSize(totalCompressed)}
									</p>
								</div>
						<div className="flex gap-3">
							{doneFiles.length > 0 && (
								<Button
									onClick={downloadAll}
									className="h-12 px-6 text-sm rounded-none"
									style={{ backgroundColor: C.blue, color: "#fff" }}
								>
									<Package className="w-4 h-4 mr-2" />
									{doneFiles.length > 1 ? "打包下载 ZIP" : "下载图片"}
								</Button>
							)}
							<Button
								variant="outline"
								onClick={clearAll}
								className="h-12 px-6 text-sm rounded-none"
								style={{ borderColor: C.inkMuted, color: C.inkMuted }}
							>
								<RotateCcw className="w-4 h-4 mr-2" />
								重新开始
							</Button>
						</div>
							</div>
						</div>
					</section>
				)}

				{files.length === 0 && (
					<section className="py-20 text-center">
						<div
							className="w-20 h-20 mx-auto mb-6 flex items-center justify-center"
							style={{ backgroundColor: C.surface1 }}
						>
							<ImageIcon className="w-8 h-8" style={{ color: C.inkSubtle }} />
						</div>
						<p
							className="text-lg font-light mb-2"
							style={{ color: C.inkMuted }}
						>
							尚未选择任何图片
						</p>
						<p className="text-sm" style={{ color: C.inkSubtle }}>
							设置目标大小后，点击上方区域或拖拽图片/文件夹到页面中
						</p>
					</section>
				)}
			</main>

			<section
				className="border-t"
				style={{ borderColor: C.hairline, backgroundColor: C.canvas }}
			>
				<div className="max-w-[1200px] mx-auto px-6 py-12">
					<div className="flex items-center gap-2 mb-6">
						<span
							className="w-6 h-6 flex items-center justify-center text-xs font-semibold text-white"
							style={{ backgroundColor: C.blue }}
						>
							<Zap className="w-3.5 h-3.5" />
						</span>
						<h2 className="text-xl font-normal" style={{ color: C.ink }}>
							相关工具
						</h2>
					</div>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
						{RELATED_TOOLS.map((tool) => {
							const { Icon } = tool;
							return (
								<a
									key={tool.url}
									href={tool.url}
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center gap-3 p-4 border transition-colors"
									style={{
										borderColor: C.hairline,
										backgroundColor: C.surface1,
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.borderColor = C.blue;
											e.currentTarget.style.backgroundColor =
												"#edf5ff";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.borderColor = C.hairline;
											e.currentTarget.style.backgroundColor = C.surface1;
									}}
								>
									<div
										className="w-10 h-10 flex items-center justify-center flex-shrink-0"
										style={{ backgroundColor: C.canvas }}
									>
											<Icon
												className="w-5 h-5"
												style={{ color: C.blue }}
											/>
										</div>
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-1 mb-0.5">
											<p
												className="text-sm font-semibold truncate"
												style={{ color: C.ink }}
											>
												{tool.title}
											</p>
											<ExternalLink
												className="w-3 h-3 flex-shrink-0"
												style={{ color: C.inkSubtle }}
											/>
										</div>
										<p
											className="text-xs truncate"
											style={{ color: C.inkSubtle }}
										>
												{tool.url.replace("https://", "")}
										</p>
									</div>
								</a>
							);
						})}
					</div>
				</div>
			</section>

			<footer
				className="border-t py-8"
				style={{ borderColor: C.hairline, backgroundColor: C.surface1 }}
			>
				<div className="max-w-[1200px] mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
					<div className="flex items-center gap-3">
						<div
							className="w-6 h-6 flex items-center justify-center"
							style={{ backgroundColor: C.blue }}
						>
							<Zap className="w-3 h-3 text-white" />
						</div>
						<span className="text-sm" style={{ color: C.inkMuted }}>
							ImagePress — 图片压缩工具
						</span>
					</div>
					<p className="text-xs" style={{ color: C.inkSubtle }}>
						所有处理均在浏览器本地完成 · 不会上传任何文件
					</p>
				</div>
			</footer>
		</div>
	);
};

export default Index;
