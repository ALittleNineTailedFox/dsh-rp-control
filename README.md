# dsh-rp-control

**DSH 里跑角色扮演对话的总控**：所有"要不要注入、注入哪一段"都从这里管。

像酒馆的预设界面：**分组 + 条目独立开关、自由组合**。分几组、每组几条都由你定 ——
文风、身体、出图规则、人格……都走同一套「分组 → 条目」模型。
胶囊按钮 → 点开勾选 / 取消，每轮动态注入所有开启条目的正文。

> 随包**只带一组**：`persona`（人格）。其余分组留给你自己加，见「怎么追加一个新配置项」。

插件还自带一个 **agent preset「RP 扮演」**（id `rp`）：它整套照抄内置 standard preset 的工具栈，
但把 persona 行换成 `{{rp_control_prompt}}` + `complete: true`，于是**该 preset 的系统提示词内容
就是本插件对这个会话的渲染结果**（见「RP 扮演 preset」）。

**人格可以随模型切换**：`modelPersona` 把 `"<provider>/<model>"` 绑到某个人设条目，未命中回落
`defaultPersona`，两者都没有则完全按手选开关（见「人格随模型切换」）。

> 随包条目里的正文都是**占位示例**，写着"把这里替换成你自己的……"。
> 它们是给你照着改的骨架，不是拿来直接用的成品。

## 现在能做什么

在 DSH 输入框里、模型选择器左边加一个「预设」胶囊按钮。

- 胶囊文案：有开启项时 **预设 · N**（N＝开启条目数），全关时 **预设 · 关**（**所有组默认全关**，内置各组都不设 `defaultItems`）
- 点开菜单：**分组标题 + 每项一行开关**，勾上就注入、取消就撤掉，可自由组合；`exclusive` 组内是单选圆点
- 条目多时菜单顶部出现搜索框，按条目名／描述过滤（组名命中则整组保留）
- 选中后**当前会话下一轮立即生效**，按会话隔离（A 会话开 2 条，B 会话不受影响）

## 分组

随包的内置名单只有一组：

| 组 id | 名 | exclusive / default | 条目 |
|---|---|---|---|
| `persona` | 人格 | exclusive=√, `defaultItems=["dafeiyu"]` | 大肥鱼（引用随包的 `personas/dafeiyu.md`） |

`persona` 是**互斥组**（同一时刻只有一份人设），也是唯一一组正文放在**独立文件**里的：
真实人设是 `personas/dafeiyu.md`（DeepSeek 蓝鲸娘的自述，只讲人格、不设场景规则），
`personas/example.md` 是一份可复制的骨架；换人设 = 往 `personas/` 放一个 md +
在 `persona` 组里加一条 `textFile` 引用。

> **安装即用**：`defaultItems` 默认开这一条 —— 新机器装完就有完整人格，
> 不需要再手工粘一遍守则。想关掉就在设置页取消「默认开」，或显式关一次。

文风、身体、出图规则这些分组**不随包提供** —— 用覆盖文件按下面的格式自己加。
`validateRpConfig` 只校验结构，不关心你分几组、叫什么名字。

新增组/条目的接法：往 `src/groups.ts` 的 `BUILTIN_GROUPS`（或 `$DSH_HOME/rp-control.json`）里加 `GroupSpec`，
注入函数 `renderInjection` 会按组 → 条目顺序自动拼接，**不需要改任何路由 / 上下文 / 注入代码**。

## 开关状态落盘

这些开关是**场景状态**，按会话落盘到 `$DSH_HOME/rp-control-state.json` ——
**重启 DSH 后同一会话恢复上次选择；新会话全部关闭**。
POST 成功后立刻原子写（`.tmp` → rename）；启动时载入内存。文件坏掉（JSON 坏 / 结构不合法 / 值类型不对）→
回退空状态并把原因记进 diag probe（`?diag=1`）；记录里已不在配置中的 itemId → 静默忽略。
`defaultItems` 只在该会话**完全没有该组记录**时生效 —— 组里任意一条被显式关过（`false`）就算"碰过"，整组默认都不会被拉起（内置各组都不设默认）。
一个组可以默认开多条；`exclusive` 组最多一条（见下）。

## 怎么追加一个新配置项

数据模型是「分组 → 条目」：

```ts
interface ItemSpec  { id, name, desc?, text?: string, textFile?: string }
interface GroupSpec { id, name, desc?, exclusive?: boolean, defaultItems?: string[], items: ItemSpec[] }
interface RpConfig  { groups: GroupSpec[], modelPersona?: Record<string, string>, defaultPersona?: string }
// 每会话状态：itemId -> true（开着）或 false（显式关过，用于压住 defaultItems）；缺席 = 没碰过
```

`defaultItems` 是**数组**：组没被碰过时，列出的每一个 id 都会打开。
旧的单数字段 `defaultItem: "x"` 仍然**读得进**（按 `defaultItems: ["x"]` 处理），但页面写盘时只写 `defaultItems`。
写盘校验（`validateRpConfig`）会拒绝：不是数组、元素不是非空字符串、id 不属于本组；重复 id 直接去重不算错；
`exclusive: true` 的组给超过一个默认项会被拒（400 + 原因），而**手写文件**读进来时遇到这种组合只保留第一个 —— 单选组绝不能同时开两条。

两条路，都不用重启：

1. **改内置** —— 在 `src/groups.ts` 的 `BUILTIN_GROUPS` 里加组/条目，然后重新 build。
2. **写覆盖文件** —— 建 `$DSH_HOME/rp-control.json`（不存在就是纯内置），格式 `{ "groups": [ … ] }`；
   **改完下一轮就生效**（每次求值重新读），能增删组、增删条目、改写条目文本。

```json
{ "groups": [ { "id": "style", "name": "文风", "defaultItems": ["style-plain", "style-lyrical"],
  "items": [ { "id": "style-plain", "name": "平实白描", "text": "……" },
             { "id": "style-lyrical", "name": "细腻抒情", "text": "……" } ] } ] }
```
（`$DSH_HOME/rp-control.json`、内置 `BUILTIN_GROUPS` 都吃这个格式；`rp-control.example.json` 是一份示例，演示人格组与模型绑定，测试里会校验它始终可用。）

大体量文本可以内联进 `text`，也可以让条目用 `textFile` 指过去（`textFile` 能力保留，配置页里也能填路径）：

```json
{ "groups": [ { "id": "persona", "name": "人格", "exclusive": true, "items": [
  { "id": "persona-example", "name": "示例人设", "textFile": "./personas/example.md" } ] } ] }
```

`text` 与 `textFile` 二选一：**`text`（非空）优先**；没有 `text` 才读 `textFile`。
`textFile` 路径有四种写法：

| 写法 | 解析成 |
|---|---|
| `./personas/example.md` | **本插件包根目录**下的相对路径（内置人设就用这个，随包走） |
| `$DSH_HOME/notes/x.md` | `$DSH_HOME` 展开后的绝对路径 |
| `C:\...\x.md` | 原样使用的绝对路径 |
| `notes/x.md` | 相对 `$DSH_HOME`（旧行为，不变） |

**每次求值重新读**。
**`textFile` 读取时过滤 `>` 开头的行**（那些是给人看的引用块，不进注入），并把 3+ 空行折叠成 1 个空行。
文件读不到 / 内容为空 → 该条目**视为不可用**（菜单里不出现），并把原因记进加载错误；**绝不抛异常**。
配置文件坏掉（JSON 语法错 / 字段不合法 / 组或条目全无效）→ 回退内置名单并报错，绝不拖垮提示组装；
`modelPersona` / `defaultPersona` 与名单相互独立，名单坏掉时它们照常保留。

## 设置页「RP 开关」

设置对话框左侧导航里多一页 **RP 开关**（注册到官方槽位 `settings.section`，id `rp-control`，order 260）。

- **分组是可折叠卡片，一律默认折叠**；标题行常显「分组名 · 条目数 · 已设 N 项默认／不设默认 · 互斥标记 · 未保存标记」，
  点标题展开/收起。展开状态只活在组件 state 里，**保存或恢复内置不会把卡片全部弹开**。
- 「新增分组 / 保存 / 恢复内置 / 放弃改动」都在卡片之外的页面头部，不被折叠影响。
- 展开后能改：分组名、**互斥模式**（Switch）、条目名、条目描述、条目正文（多行文本框，够放 KB 级正文）、`textFile` 路径。
- 分组卡片之上有一个 **「人格 · 随模型切换」** 区块：`defaultPersona` 输入框、`modelPersona` 行编辑框
  （每行 `provider/model = 人设 id`，`#` 注释），以及一条只读的链
  「**当前模型 → 命中人设 → 回落**」——取自 host 最近一次提示词组装实际解析出的 `personaDiag`，不是页面自己猜的。
  模型绑定框的原始文本与解析结果是分开存的：半行没写完的绑定不会被下一次按键吃掉。
- **每条条目自带一个「默认开」勾选框**（不是组级下拉）：勾几条这一组就有几个默认项；`exclusive` 组内勾一个会自动取消其它（保持单选语义），
  把组切成互斥时若已有多个默认项，只保留列表里的第一个。
- **保存**写覆盖文件；**恢复内置**删掉覆盖文件回落到 `BUILTIN_GROUPS`。
- 顶部标签显示当前生效来源（内置 / 配置文件）与文件路径；读取失败、文件被拒用、`textFile` 取不到正文、保存失败都各自提示。
- 有未保存改动时给出提示条，**关掉设置面板不会丢弃草稿**（草稿 parked，重开还在），离开页面时浏览器原生拦截。

配置页走 host 的 `/dsh-rp-control/config`：

| 方法 | 语义 |
|---|---|
| `GET` | 返回 `{ groups, modelPersona?, defaultPersona?, source, path, error?, textError?, personaDiag? }`；`groups` 是**磁盘上原样**的名单（`textFile` 不展开），`personaDiag` 是最近一次组装解析出的「模型 → 人设 → 回落」 |
| `PUT {config}` | 先用 `validateRpConfig` 严格校验（失败 400 `invalid-config` + `reason`），通过后**原子写**（`.tmp` → rename）覆盖文件；写的是**整份文档**（名单 + 人格绑定），省略绑定即清空绑定 |
| `PUT {reset:true}` / `DELETE` | 删掉覆盖文件，恢复内置 |

`validateRpConfig` 对人格绑定的额外拒绝项：`modelPersona` 不是对象、键里没有 `/`、值是空串 / 非字符串 /
**不是 `persona` 组的条目 id**，以及 `defaultPersona` 同样不是 `persona` 组条目 —— 运行时会被静默忽略的绑定
属于笔误，宁可在写盘时就顶回来。

请求体上限 4 MiB（`textFile`／内联正文都够用）；`content-type` 必须是 JSON（否则 415）；
跨站 `Origin` 一律 403（与状态路由同一条 same-origin 规则）。**任何情况下配置坏掉都只有一个报错字段，不会抛进提示组装。**

## RP 扮演 preset

`cordis.patch.yml` 除了挂载插件本体，还声明一个 `@deepseek-ai/dsh-agent-preset`（id `rp`、名 `RP 扮演`、order 6）。
它的 `plugins` **逐行照抄内置 standard preset**（`@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 里
`persona` 行到 `tool-plugin-manager` 行，连 `disabled: !!js process.platform === …` 这种表达式都原样保留），
只做三处取舍：

| 取舍 | 为什么 |
|---|---|
| `persona` 行改成 `prefix: '{{rp_control_prompt}}'` + `complete: true` + `includeRuntimeContext: false` | 该段成为**唯一**系统提示词段，于是 preset 的提示词就是本插件对这个会话的渲染结果（工具 schema 照常交付） |
| 删掉 `agent-instructions` | AGENTS.md 一类指令走 `agent/pre-step` **消息通道**（作为消息追加），不是 prompt section，`complete` 段管不到它 |
| 删掉 `skill-filesystem` + `tool-skill` | skill catalog 同属 `agent/pre-step` 消息通道，`complete` 同样挡不住 |
| 删掉 `planning` 整组 | 它注册的 `plan:policy` 段会被 `complete` 段遮蔽，plan mode 会静默失效，留个永远不生效的开关只会误导 |

### 变量 `rp_control_prompt`

与动态上下文**共用同一条解析路径**（`sessionId → facts → selection → persona 覆盖 → renderInjection`），
两个消费者不会漂移。两条硬规则：

- **绝不抛错、绝不返回 `undefined`** —— provider 抛错会让整次 assembly 失败，插值遇到 `undefined` 直接抛。
- **绝不为空**：组装会丢掉渲染后为空的段，而 `complete` 段渲染成空会**清空整条系统提示词** ——
  所以没启用任何模块时回 `（本轮未启用任何 RP 模块。）`（`RP_PROMPT_FALLBACK`）。

变量名固定 `rp_control_prompt`（必须匹配 `/^[a-z][a-z0-9_]*$/`，不能有驼峰）。

## 人格随模型切换

`RpConfig` 顶层两个可选字段：

```json
{
  "groups": [ … ],
  "modelPersona": { "deepseek-official/deepseek-flash": "persona-example" },
  "defaultPersona": "persona-example"
}
```

判定链（纯函数 `resolvePersonaForModel` / `applyPersonaOverride`，host 与设置页共用同一套）：

1. 探测当前会话的模型 → `"<provider>/<model>"`；
2. 在 `modelPersona` 里**精确查这个键** → 命中则**强制打开**该人设、同组其它项关闭；
3. 未命中 → 回落 `defaultPersona`（同样强制打开）；
4. 两者都没有 → **完全不覆盖**，按用户手选。

几个刻意的行为：

- 覆盖**只作用于 `persona` 组**，且**从不写进** `$DSH_HOME/rp-control-state.json` ——
  它是模型的属性，不是场景状态；状态路由返回的 `selection` 里能看到它，落盘里看不到。
- 绑定的 id 必须真的是 `persona` 组的条目，否则 `applyPersonaOverride` 原样放行（不覆盖）。
- 模型探测（`modelOf`）沿 assembly context 广搜到 session，读 `agent.session.requestHeader().config`
  —— 这正是 `api-session` 自己读的那一处；读不到就返回 `undefined`（**不抛错**）。
  因此：**全新会话的第一轮可能还没有 request header**，这一轮按 `defaultPersona` 走；
  模型切换后，人设随**下一次被受理的请求**一起换（与该请求实际使用的模型一致）。
- 广搜优先采用**两半齐全**的 `{ provider, model }`，只有找不到配对时才退而用裸 `model` 字符串；
  后者匹配不上 `<provider>/<model>` 形式的绑定，只会走回落。
- 一次组装观测到的模型会按会话缓存：某次组装读不到模型时沿用上一次的，不会因为一次读失败就掉回默认人设。

## 注入门控（只对主 agent）

每轮提示组装时，provider 用 `agent.id`（＝ sessionId）查出该会话的 `Selection`（先叠加人格的模型覆盖），
把**所有开启条目的 `text` 按组 → 条目顺序用空行拼成一段**（不加任何小标题，保持原文纯净），
作为**一个** `systemPrompt.context`（name `dsh-rp-control:injected`，order 56）输出；全关返回空字符串。
同一个结果另有第二个出口：变量 `rp_control_prompt`（全关时回固定的非空兜底串，见「变量 `rp_control_prompt`」）。

子 agent 一律不注入：`shouldInjectRp()` 的判据是 `origin === 'subagent'` → false、
`delegationDepth > 0` → false；上下文读不出来时**保持注入**（宁可多带一份也不静默丢预设），
并通过 `probeOf()`（路由 `?diag=1` 暴露）记录最近一次组装实际看到了什么，方便排查"为什么没注入"。

## 实现速览

| 半边 | 文件 | 干什么 |
|---|---|---|
| host | `src/index.ts` | 注册两条路由 + 一个动态提示上下文 + 变量 `rp_control_prompt`；`sessionId → Selection` 存内存 Map；`modelOf()` 模型探测 |
| host | `src/state.ts` | `$DSH_HOME/rp-control-state.json` 的原子读/写（重启恢复） |
| host | `src/rp-route.ts` | `GET ?sessionId=` 读、`POST {sessionId, itemId, on}` 切换；同时导出两条路由共用的 same-origin / JSON 帮手 |
| host | `src/config-route.ts` | `/dsh-rp-control/config` 的 `GET` / `PUT` / `DELETE`，校验 + 原子写 + 恢复内置；整份文档（名单 + 人格绑定）一起读写 |
| host | `src/groups.ts` | 内置名单（只带 persona 组）+ 读 `$DSH_HOME/rp-control.json`（`loadRpRawConfig` 不展开 `textFile`）+ `textFile` 展开（`./` → 包根）/读取/过滤 `>` |
| host | `src/shared.ts` | 数据模型 + 路由/上下文/变量常量 + `renderInjection` + `validateRpConfig` + `resolvePersonaForModel` / `applyPersonaOverride` |
| host | `personas/example.md` | 随包人设骨架（独立文件，`textFile` 引用；复制一份改成你自己的） |
| host | `cordis.patch.yml` | 挂载插件本体 + 声明 `RP 扮演` agent preset |
| client | `src/client/index.tsx` | 注册官方槽位 `conversation.input.right`（id `rp-control`，order 21）与 `settings.section`（id `rp-control`，order 260） |
| client | `src/client/rp-pill.tsx` | 胶囊按钮 + 分组开关菜单（`MenuSurface` / `MenuGroup` 材质） |
| client | `src/client/rp-settings.tsx` | 「RP 开关」设置页 |
| client | `src/client/primitives.d.ts` | `@deepseek-ai/dsh-client-ui-primitives` 的类型垫片（见下） |
| tool | `tools/dump-session.mjs` | 只读会话存档检查器：逐帧解 zstd 读 `$DSH_HOME/sessions`，判「系统提示词是否已被换成 RP 正文」 |

槽位 `conversation.input.right` 声明为 `{ kind: "list", scope: "session" }`，天然拿到 sessionId、天然与其他 pill 并列。

### 关于 primitives 的类型垫片

DSH 应用里的 `@deepseek-ai/dsh-client-ui-primitives` 只发布浏览器运行时（`lib/index.js` + 已被 web 壳打进样式表的 CSS Modules），
**没有 `lib/types`**。所以：

- 运行时按常规接 junction：`node_modules\@deepseek-ai\dsh-client-ui-primitives` → 应用目录里的包，client bundle 里留成 external 请求；
- 类型由 `src/client/primitives.d.ts` 提供（只声明本插件用到的导出，签名抄自发布包的 JSDoc），
  并在 `tsconfig.json` 的 `paths` 里把说明符指到该文件 —— 之所以不用 `declare module`，是因为模块解析一旦落到没有声明的 `.js`，
  环境声明就赢不了（TS 只会报 TS7016）。

## 菜单定位（踩过的坑，别再犯）

菜单必须从 pill 子树 `createPortal` 到 `document.body` + `position: fixed` + `getBoundingClientRect()`
算视口坐标（就地 `absolute` 会被 composer 祖先裁剪、就地 `fixed` 会被带 transform 的祖先当成包含块而飞走）。
`react-dom` 由宿主提供（`tsdown.config.ts` 的 `CLIENT_EXTERNALS` 声明）。

## 自测

```powershell
# 构建（tsc 出类型 + tsdown 出 bundle）
.\node_modules\.bin\tsc.cmd
.\node_modules\.bin\tsdown.cmd

# 五个测试，全绿才算过
node tests/smoke.mjs
node tests/config.mjs
node tests/persist.mjs
node tests/config-route.mjs
node tests/client.mjs
```

产物：`lib/index.js`（host）＋ `lib/client.js`（client）。

`tools/dump-session.mjs` 是验收「RP 扮演」preset 是否真的换源的只读工具
（`node tools/dump-session.mjs --all`）；它默认探针是随包示例的特征串，
换成你自己的正文特征用 `RP_MARKERS` 环境变量（逗号分隔）覆盖。

## License

MIT
