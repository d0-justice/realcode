# Ralph Loop 状态机执行规约 (Docs 目录定制版)

作为高阶 AI 编程代理，你必须严格遵循 Ralph Loop 状态机循环机制来执行开发任务。你的所有行为都应以“小步快跑、状态持久化、自检闭环”为原则。

## 核心运行机制 (State Machine)
1. **磁盘即数据库**：每一次对话都是一个独立的生命周期。你必须将 `docs/IMPLEMENTATION_PLAN.md` 视为你的唯一全局状态机模型。
2. **单次单任务**：单次交互中，你**有且仅能执行一个**具体子任务。绝对不要试图一次性写完所有功能。
3. **回归验证**：每做完一个任务，必须主动运行测试（如 npm test, pytest 等）或编译命令，验证通过后才能进入下一步。

## 状态机每轮迭代生命周期 (Lifecycle)
在每次接收到用户的指令或开始新一轮编码时，你必须隐式执行以下四个阶段：

### 阶段 1：定向与读取 (Orient & Read)
- 检查 `docs/` 目录下的需求文档（如 `docs/feature-requirements.md`）。
- 读取 `docs/IMPLEMENTATION_PLAN.md` 文件的当前状态（找出优先级最高、且处于 [ ] 未完成状态的任务）。

### 阶段 2：执行与小步提交 (Implement & Verify)
- 仅针对选中的那**一个**任务编写或修改代码。
- 严禁假定代码天然正确。利用 VS Code 终端工具链执行对应的 Lint、Build 或 Test 命令进行验证。

### 阶段 3：更新状态 (State Update)
- 任务验证成功后，立即修改 `docs/IMPLEMENTATION_PLAN.md`。
- 将该任务标记为 `[x] 已完成`，并简要追加你本轮所做的改动。
- 重新评估后续任务的优先级。

### 阶段 4：输出信号 (Signaling)
- 当所有任务全部通过并标记完成后，在回复的最后输出特定终止符：`<promise>COMPLETE</promise>`。
- 如果遇到无法自主解决的阻塞性阻碍，输出：`<promise>BLOCKED: 原因描述</promise>`。

## 任务清单结构标准
你读写的 `docs/IMPLEMENTATION_PLAN.md` 必须严格保持以下 Markdown 状态列表格式：
- [x] 任务 A (已完成 - 简述结果)
- [/] 任务 B (当前正在进行/待验证)
- [ ] 任务 C (等待中)
