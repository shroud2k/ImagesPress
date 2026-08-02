import { Toaster as Sonner } from "sonner";

// next-themes 已移除：项目无暗色模式切换，使用固定 light 主题（3.1）
const Toaster = ({ ...props }) => {
	return (
		<Sonner
			theme="light"
			className="toaster group"
			toastOptions={{
				classNames: {
					toast:
						"group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
					description: "group-[.toast]:text-muted-foreground",
					actionButton:
						"group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
					cancelButton:
						"group-[.toast]:text-muted-foreground group-[.toast]:bg-muted",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
