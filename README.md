# 学生编程回放

基于 `prodai_local_20260924` 中的真实 CSV 数据，按时间同步回放学生代码、编辑器文本光标、AI 问答、页面标签切换和在线/离线记录。

数据中没有终端、测试、鼠标坐标、AI 草稿输入或流式回复，因此界面会明确显示“数据未采集”，不会生成替代事件。

## 运行

```powershell
cd C:\Users\Admin\Desktop\student_program_replay
C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe server.py
```

打开 `http://127.0.0.1:8765`。

## 重新生成数据

```powershell
C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe build_data.py
```

生成过程只提取回放需要的字段，不复制笔记图片和分析结果。
