# 警告

目前，我们用的是 opencode RUNNER，技能加载顺序是:

1. /app/.agents/skills
2. /app/workspaces/.agents/skills

而 RCS 会在第一个放置其打包到代码的默认系统技能。

我们修改的这个 `show-html-or-picture` 正式系统技能！

因此，之前把他放到 HOST machine 然后 bind 到 /app/workspaces 的方法是无法起作用！
我们就不应该用这样 HACK 的方法！

但事已至此，先临时应对：建议将这个技能放到 `./internal-skills/show-html-or-picture` ，然后只读 bind 到 `/app/.agents/skills/show-html-or-picture`。

下一次大版本更新一定要换一个机制！
