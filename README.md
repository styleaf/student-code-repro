# 小组协作回放

基于 `prodai_local_20260924` 的真实CSV记录，按小组统一时间轴回放三名成员共同维护的共享代码、共享笔记、房间聊天/AI、编辑器文本光标、页面操作、连接状态和任务完成记录。

## 页面包含

- 共享代码完整快照、变化行、当前操作者和每名成员最后记录的文本光标；
- 代码行、笔记段落及笔记图片按最后编辑者着色；后续覆盖会更新归属；
- 共享笔记文本与去重后的原始图片；
- 普通房间聊天、AI问题、AI回复及消息内代码；
- 结果页、数据、PDF、发送、提及、上传和完成等真实按钮操作；
- 三名成员稳定一致的颜色，贯穿内容背景、消息、活动和时间轴；
- 独立事后分析页面中的后期ICAP、协作异常、AI交互和笔记分析。

顶部“事后分析”可进入独立教师面板，当前包括：

- 成员行为参与和最终代码/笔记归属；
- ICAP窗口随时间变化及窗口详情；
- 协作异常提示的类型聚合与原始窗口跳转；
- 去重后的AI交互类型、Bloom层级、AI角色和小组后续反应；
- 代码演化里程碑、笔记见解和全部小组概览。

事后分析使用 `comprehensive_analysis_results.csv`、`analysis_results.csv`、`ai_chat_analysis.csv`、`sampled_notes_analysis.csv` 和 `note_analysis_results.csv`。自动分析只用于筛查，页面会持续显示数据兼容性和解释边界。

数据没有终端命令、stdout/stderr、测试用例结果、鼠标屏幕坐标、页面可见性或消息已读记录。`cursorpositions` 是编辑器文本光标；`online/offline` 是连接状态。界面不会用这些字段推断未采集的行为。

行级归属由连续完整快照做差分恢复。AI粉色只用于先前AI回复中存在足够长逐字匹配、且随后以批量新增方式进入代码或笔记的行；这表示可验证的文本来源匹配，不表示AI直接控制过编辑器。

## 运行

双击 `start.bat`，或执行：

```powershell
cd C:\Users\Admin\Desktop\student_program_replay
python server.py
```

打开 `http://127.0.0.1:8765/`。

## 重新生成组级数据

```powershell
python build_data.py
```

生成结果位于 `data/groups/`。笔记中的Base64图片按内容哈希去重后保存在 `data/assets/`，避免在每个完整笔记快照中重复保存同一图片。

## 浏览器验证

测试需要本机Playwright运行库：

```powershell
$env:NODE_PATH='C:\Users\Admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node tests\smoke.cjs
```
