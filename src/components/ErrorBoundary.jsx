import React from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

class ErrorBoundary extends React.Component {
	state = { hasError: false, error: null };

	static getDerivedStateFromError(error) {
		return { hasError: true, error };
	}

	componentDidCatch(error, errorInfo) {
		console.error("ErrorBoundary caught an error:", error, errorInfo);
	}

	handleReload = () => {
		window.location.reload();
	};

	render() {
		if (this.state.hasError) {
			return (
				<div
					className="min-h-screen flex items-center justify-center"
					style={{
						backgroundColor: "#ffffff",
						fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
					}}
				>
					<div className="text-center max-w-md px-6">
						<div
							className="w-16 h-16 mx-auto mb-6 flex items-center justify-center"
							style={{ backgroundColor: "#f4f4f4" }}
						>
							<AlertCircle className="w-8 h-8" style={{ color: "#da1e28" }} />
						</div>
						<h1 className="text-xl font-light mb-2" style={{ color: "#161616" }}>
							页面出现错误
						</h1>
						<p className="text-sm mb-6" style={{ color: "#525252" }}>
							应用遇到了意外问题，请尝试刷新页面。如果问题持续存在，请联系技术支持。
						</p>
						<Button
							onClick={this.handleReload}
							className="h-10 px-6 text-sm rounded-none"
							style={{ backgroundColor: "#0f62fe", color: "#fff" }}
						>
							<RotateCcw className="w-4 h-4 mr-2" />
							刷新页面
						</Button>
					</div>
				</div>
			);
		}

		return this.props.children;
	}
}

export default ErrorBoundary;
