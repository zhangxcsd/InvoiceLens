import subprocess
import sys
from pathlib import Path


def main() -> int:
    project_root = Path(__file__).resolve().parent
    streamlit_app = project_root / "src" / "ui" / "app.py"

    if not streamlit_app.exists():
        print(f"未找到 Streamlit 入口文件: {streamlit_app}")
        return 1

    cmd = [
        sys.executable,
        "-m",
        "streamlit",
        "run",
        str(streamlit_app),
        "--server.headless",
        "true",
        "--server.port",
        "8501",
    ]
    return subprocess.call(cmd, cwd=str(project_root))


if __name__ == "__main__":
    raise SystemExit(main())
