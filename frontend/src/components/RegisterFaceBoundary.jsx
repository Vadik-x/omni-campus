import { Component } from "react";

export default class RegisterFaceBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      message: "",
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      message: String(error?.message || "Unexpected registration modal error."),
    };
  }

  componentDidCatch(error) {
    console.error("Face registration crashed", error);
  }

  handleClose = () => {
    this.setState({ hasError: false, message: "" });
    if (typeof this.props.onClose === "function") {
      this.props.onClose();
    }
  };

  handleRetry = () => {
    this.setState({ hasError: false, message: "" });
    if (typeof this.props.onRetry === "function") {
      this.props.onRetry();
    }
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="fixed inset-0 z-[1600] grid place-items-center bg-[#070b12]/85 px-4 py-6 backdrop-blur-sm">
        <div className="glass-card w-full max-w-lg rounded-2xl border border-red-300/35 bg-[#111827]/95 p-5 text-slate-100">
          <h3 className="text-lg font-semibold text-red-200">Face Register crashed</h3>
          <p className="mt-2 text-sm text-slate-300">
            The registration modal hit an unexpected error. You can retry opening it or close it safely.
          </p>
          <p className="mt-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-slate-300">
            {this.state.message || "Unexpected registration modal error."}
          </p>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              className="rounded-xl border border-white/20 px-3 py-2 text-sm text-slate-200 transition hover:border-cyan-300/50 hover:text-cyan-100"
              onClick={this.handleClose}
            >
              Close
            </button>
            <button
              type="button"
              className="neon-btn"
              onClick={this.handleRetry}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }
}
