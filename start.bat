@echo off
cd /d "%~dp0"
start "学生编程回放" "http://127.0.0.1:8765"
"C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" server.py --port 8765
