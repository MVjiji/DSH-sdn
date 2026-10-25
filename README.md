# 桑多涅 · DSH 插件 + 克隆语音

把「桑多涅」（《原神》愚人众执行官第七席「木偶」）装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：
**一套人格预设 + 她自己训练出来的声音**。每条回复结束，她会用桑多涅的声线把这段话念出来。

这个仓库是**一个自包含的文件夹**：插件、她的两个语音模型（GPT + SoVITS）、语气参考音频、
一键安装脚本都在里面。换一台电脑，克隆下来跑一遍脚本就装好。

---

## 30 秒上手

```powershell
git clone https://github.com/MVjiji/DSH-sdn.git
cd DSH-sdn
.\install.ps1
```

看到「安装完成」后：**完全退出并重新启动 DeepSeek Harness** → 新建会话 → 预设选「桑多涅」。

> 脚本会自动：还原模型分卷 → 校验 SHA-256 → 找本机的 GPT-SoVITS → 装插件进 `desktop` profile →
> 写配置。默认**不修改** GPT-SoVITS 目录里的任何文件。

---

## 前置条件：一份 GPT-SoVITS 整合包

插件负责「说什么、用什么声音」，真正把文字变成音频的是 **GPT-SoVITS**（推理引擎，含 Python 运行时、
torch 和底模，10 GB 以上）。它**不能**放进这个仓库：GitHub 单文件上限 100 MB、仓库建议 1 GB 以内，
而整合包 10 GB 起步。

所以：

| 情况 | 怎么做 |
| --- | --- |
| 电脑上已经有 GPT-SoVITS | 什么都不用做，`install.ps1` 会自动扫到 |
| 装在非常规位置 | `.\install.ps1 -GptSoVitsDir "D:\你的\GPT-SoVITS-xxx"` |
| 没有 | 先下官方包，解压，再重跑脚本，或在设置页里填 `gptDir` |

官方下载：

- Releases：<https://github.com/RVC-Boss/GPT-SoVITS/releases>
- 网盘（夸克）：<https://drive.uc.cn/s/482dcfa346a94>

整合包解压后至少要有这三样：

```
api_v2.py
runtime\python.exe
GPT_SoVITS\configs\tts_infer.yaml
```

脚本认不出 GPT-SoVITS 时会把上面的地址再打印一遍，插件也照装（只是暂时不出声）。

---

## 仓库里有什么

```
DSH-sdn/
├─ install.ps1                # 一键安装（还原模型 + 装插件 + 写配置）
├─ uninstall.ps1              # 一键卸载（只动 profile）
├─ dsh-sandrone/              # ★ 插件本体，一个标准的 DSH bundle
│  ├─ preset/sandrone.patch.yml   # 人格预设（性格、口癖、处境、工具集）
│  ├─ index.js                    # 宿主侧：设置命名空间 + /sandrone/* 语音网关
│  ├─ lib/tts.js                  # GPT-SoVITS 进程管理、临时配置、便签权重
│  ├─ client.js                   # 浏览器侧：设置页 + 每轮结束自动朗读
│  ├─ assets/ref/*.wav            # 6 组语气参考音频（中性/调侃/不爽/生气/软/严肃）
│  └─ (安装后) assets/weights/    # 从 models/ 还原出来的两个权重
├─ models/                    # ★ 桑多涅的克隆语音模型（分卷）
│  ├─ sandrone-gpt-e12.ckpt.part01…04        # GPT / Text2Semantic，合计 148 MB
│  ├─ sandrone-sovits-e6s198.pth.part01…04   # SoVITS / 声学模型，合计 165 MB
│  └─ manifest.json           # 分卷清单 + 合并后 SHA-256
└─ runtime/README.md          # 为什么不把 GPT-SoVITS 放进来、怎么准备
```

模型来自你自己训练的 v2ProPlus 权重：

| 文件 | 来源 |
| --- | --- |
| `sandrone-gpt-e12.ckpt` | `GPT_weights_v2ProPlus/桑多涅1-e12.ckpt` |
| `sandrone-sovits-e6s198.pth` | `SoVITS_weights_v2ProPlus/桑多涅v1.0.1_e6_s198.pth` |

分卷是为了绕过代码托管平台的单文件限制；`install.ps1` 合并后会逐字节校验 SHA-256。

---

## 装完之后

| 你在哪 | 看到什么 |
| --- | --- |
| 新建会话 → 预设 | 「桑多涅」 |
| 每轮回复结束 | 自动用她的声音念出来（代码块、链接、Markdown 记号不会被念） |
| 每条回复下面 | 「🔊 朗读」按钮，可以重念 / 停止 |
| 设置 →「桑多涅」 | 语音总开关、自动朗读、只在桑多涅会话说话、音量、语速、分句长度、语气、链路参数、试听 |

首次出声要等模型加载：显卡上大约 10–40 秒（插件启动 5 秒后会自动预热，通常第一轮对话前就好了）。

---

## 换电脑的完整流程

1. 装好 DeepSeek Harness（能正常打开界面）。
2. 准备 GPT-SoVITS 整合包（见上）。
3. `git clone https://github.com/MVjiji/DSH-sdn.git && cd DSH-sdn`
4. `.\install.ps1`
5. 重启 DSH，新建会话选「桑多涅」。

不需要重新训练、不需要往 GPT-SoVITS 里拷模型、不需要改它的配置。

---

## 它是怎么不碰 GPT-SoVITS 目录的

`api_v2.py` 启动时会通过 `TTS.init_*_weights()` 把 `tts_infer.yaml` **重写一遍**。为了不污染原始文件，
插件做了三件事：

1. 把整合包的 `tts_infer.yaml` **复制到系统临时目录**，`-c` 指向副本；
2. 在副本的 `custom` 段里，把权重路径改成插件自己 `assets/weights/` 下的绝对路径；
3. 子进程关闭字节码写盘（`PYTHONDONTWRITEBYTECODE` + `PYTHONPYCACHEPREFIX` 指到临时目录），
   也不调用会回写配置的 `/set_gpt_weights`、`/set_sovits_weights`。

结果：整合包目录只读，仓库里的模型跟着插件走。

---

## 设置项说明

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | 开 | 总开关，关掉就不出声、按钮也消失 |
| `autoSpeak` | 开 | 每轮回复结束自动念 |
| `presetOnly` | 开 | 只给「桑多涅」预设的会话出声，避免和别的角色插件叠音 |
| `volume` / `speed` | 100 / 1.0 | 音量、语速 |
| `chunkChars` | 110 | 分句长度，越小越早出声 |
| `textLang` | zh | 正文语言（`auto` 会被强制成 `zh`，否则中文短句容易被判成日语） |
| `toneAuto` / `fixedTone` | 开 / neutral | 按回复内容自动挑语气，或固定一种 |
| `apiUrl` | `http://127.0.0.1:9880` | 已有服务在跑就直接复用 |
| `gptDir` | （安装时写入） | GPT-SoVITS 整合包目录 |
| `pythonPath` | 空 | 空 = 整合包自带的 `runtime\python.exe` |
| `autoStart` / `preload` | 开 / 开 | 按需拉起服务、开机预热 |
| `refAudio` / `promptText` | 空 | 手动指定参考音频（会覆盖语气库） |

---

## 常见问题

**设置里没有「桑多涅」这一页**
→ 插件没被 profile 认出来。检查 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的
`dsh.profile.bundles` 里有没有 `dsh-sandrone`，以及 `node_modules\dsh-sandrone` 存不存在。

**装好了但不出声**
→ 设置 →「桑多涅」最下面那行会写服务状态：
- `语音服务未启动`：还没人叫过它，发一条消息试试；
- `正在加载模型…`：等 10–40 秒；
- `异常：…`：多半是 `gptDir` 不对、显卡被占、或 9880 端口被别的程序占了（改 `apiUrl` 换端口）。

**声音不像**
→ 设置里换 `fixedTone` 试试；或者关掉「自动语气」，把 `refAudio` 指到一段 3–10 秒的干净参考音频，
并把 `promptText` 填成那段音频的**逐字文本**。

**换电脑后 DSH 报 `1 entry did not activate`**
→ 重启一次 DSH（不是刷新页面）。还不行就看 DSH 控制台里 `[dsh-sandrone]` 的日志。

---

## 体积与许可

| 项 | 大小 |
| --- | --- |
| 插件代码 + 语气参考音频 | < 4 MB |
| 桑多涅模型（分卷） | 约 313 MB |
| GPT-SoVITS 整合包（不进仓库） | 10 GB+ |

角色「桑多涅」及《原神》相关名称的版权归米哈游所有；本仓库只包含插件代码与自行训练的语音权重，
供个人研究与自用，请勿用于商业用途或二次分发角色素材。
