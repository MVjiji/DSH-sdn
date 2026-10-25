# 桑多涅 · DSH 插件 + 克隆语音（自包含一键装）

把「桑多涅」（《原神》愚人众执行官第七席「木偶」）装进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：
**一套人格预设 + 她自己训练出来的声音**。每条回复结束，她会用桑多涅的声线把这段话念出来。

仓库里有插件、安装脚本，以及一套**只保留推理**的 GPT-SoVITS 运行时（去掉了训练、ASR、人声分离）。
模型与运行时挂在 [Releases](https://github.com/MVjiji/DSH-sdn/releases/tag/v0.1.0)，脚本自动下载并校验 SHA-256。

---

## 30 秒上手（换电脑也是这三步）

```powershell
git clone https://github.com/MVjiji/DSH-sdn.git
cd DSH-sdn
.\install.ps1
```

随后：**完全退出并重新启动 DeepSeek Harness** → 新建会话 → 预设选「桑多涅」。

脚本会自动：

1. 下载两个语音权重（约 313 MB）到插件的 `assets/weights/`；
2. 下载便携运行时（5 个分卷，约 8.3 GB），合并解压到 `%USERPROFILE%\.dsh\sandrone\runtime`；
3. 把插件装进 `desktop` profile 并写好配置。

> 如果本机**已经有** GPT-SoVITS，脚本会直接复用，不会下载运行时（更省时间）。
> 也可以显式指定：`.\install.ps1 -GptSoVitsDir "D:\GPT-SoVITS-v2pro-20250604"`。

---

## 为什么模型和运行时不在仓库里

GitHub 的硬限制：

| 限制 | 数值 |
| --- | --- |
| 仓库里单个文件 | 100 MB |
| 单次 Release 附件 | 2 GB |
| 推荐仓库体积 | 1 GB 以内 |

而桑多涅的运行时（Python + torch + BERT/HuBERT + 中文前端）有 **8.3 GB**，权重 313 MB。
所以：仓库只放代码（几 MB），大文件走 Release 附件，由 `install.ps1` 下载并逐个校验 SHA-256。

下载量清单：

| 资产 | 大小 | 说明 |
| --- | --- | --- |
| `sandrone-gpt.ckpt` | 148 MB | GPT / Text2Semantic 权重 |
| `sandrone-sovits.pth` | 165 MB | SoVITS / 声学模型权重 |
| `sandrone-runtime.tar.part001…005` | 8.3 GB | 便携运行时（只含推理） |

---

## 运行时里有什么 / 没有什么

只保留「文字 → 语音」这一条链：

**保留**

- `runtime/`：Python 3.9 + torch（CUDA）+ onnxruntime + transformers/librosa 等推理依赖
- `GPT_SoVITS/`：`TTS_infer_pack`、`AR`、`module`、`feature_extractor`、`eres2net`、`BigVGAN`、`text/`（中文前端 + G2PW 模型）
- `GPT_SoVITS/pretrained_models/`：`chinese-roberta-wwm-ext-large`、`chinese-hubert-base`、`v2Pro`（底模）、`sv`（说话人验证，v2ProPlus 必需）
- `GPT_SoVITS/configs/tts_infer.yaml`（会被插件复制到临时目录再改，原件不动）
- `tools/`：只留 `i18n` 与音频工具，**删掉** `asr/`、`uvr5/`

**删掉**

- 训练：`pytorch_lightning` 之外的自定义训练脚本、`logs/`、`prepare_datasets`、`s2Gv3`、`gsv-v2final`、`gsv-v4`、`s2D488k`、`s2G488k`、`s1bert25hz`（v1/v2/v3/v4 底模）
- 语音识别 / 人声分离：`funasr`、`modelscope`、`ctranslate2`、`faster_whisper`、`av`、`uvr5`
- 界面：`gradio`
- 构建/数据：`cmake`、`pyarrow`、韩语词典（`mecab_ko_dic`、`eunjeon`）

> 注：`pytorch_lightning` 与 `torchmetrics` 不能删 —— `AR/models/t2s_lightning_module.py` 会 import 它；
> `BigVGAN`、`tools/AP_BWE_main`、`pretrained_models/sv` 也都还在 import 链上。删包时是逐轮启动实测过的。

---

## 仓库里有什么

```
DSH-sdn/
├─ install.ps1                # 一键安装（权重 + 运行时 + 插件 + 配置）
├─ uninstall.ps1              # 一键卸载（只动 profile）
├─ dsh-sandrone/              # ★ 插件本体，一个标准 DSH bundle
│  ├─ preset/sandrone.patch.yml   # 人格预设（性格、口癖、处境、工具集）
│  ├─ index.js                    # 宿主侧：设置命名空间 + /sandrone/* 语音网关
│  ├─ lib/tts.js                  # 运行时进程管理、临时配置、便携权重
│  ├─ lib/tones.js / refs.js      # 6 组语气参考 + 按回复自动挑语气
│  ├─ client.js                   # 浏览器侧：设置页 + 每轮结束自动朗读
│  ├─ assets/ref/*.wav            # 6 组语气参考音频
│  └─ (安装后) assets/weights/    # 下载或合并出来的两个权重
├─ models/
│  └─ manifest.json           # 权重与运行时的下载清单（含每段 SHA-256）
└─ runtime/README.md          # 运行时说明
```

---

## 插件是怎么做到「不碰 GPT-SoVITS 目录」的

`api_v2.py` 启动时会通过 `TTS.init_*_weights()` 把 `tts_infer.yaml` **重写一遍**。为了不污染任何原始文件，插件做了四件事：

1. 把运行时的 `tts_infer.yaml` **复制到系统临时目录**，`-c` 指向副本；
2. 在副本的 `custom` 段里，把两个权重路径改成插件 `assets/weights/` 下的**绝对路径**（`version` 固定 `v2ProPlus`）；
3. 子进程关闭字节码写盘（`PYTHONDONTWRITEBYTECODE` + `PYTHONPYCACHEPREFIX` 指到临时目录）；
4. 不调用会回写配置的 `/set_gpt_weights`、`/set_sovits_weights`。

结果：你原来的 `D:\GPT-SoVITS-v2pro-20250604` 只读不写，模型跟着插件走。

---

## 设置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | 开 | 总开关 |
| `autoSpeak` | 开 | 每轮回复结束自动念 |
| `presetOnly` | 开 | 只给「桑多涅」预设的会话出声，避免和别的角色插件叠音 |
| `volume` / `speed` | 100 / 1.0 | 音量、语速 |
| `chunkChars` | 110 | 分句长度，越小越早出声 |
| `textLang` | zh | 正文语言（`auto` 会被强制成 `zh`，否则中文短句容易被判成日语） |
| `toneAuto` / `fixedTone` | 开 / neutral | 按回复内容自动挑语气（平静/揶揄/嫌烦/冷淡/别扭/认真） |
| `apiUrl` | `http://127.0.0.1:9880` | 已有服务在跑就直接复用 |
| `gptDir` | 安装时写入 | 运行时目录 |
| `pythonPath` | 空 | 空 = 运行时自带的 `runtime\python.exe` |
| `autoStart` / `preload` | 开 / 开 | 按需拉起、开机预热 |

---

## 常见问题

**下载很慢 / 中断**
→ 脚本用的是 `curl -C -`（断点续传），重跑 `.\install.ps1` 会接着下，已完成的文件会校验后跳过。

**装好了但不出声**
→ 设置 →「桑多涅」最下面那行写服务状态：
- `语音服务未启动`：还没人叫过它，发一条消息；
- `正在加载模型…`：等 10–40 秒；
- `异常：…`：多半是 `gptDir` 不对、显存被占，或 9880 端口冲突（改 `apiUrl`）。

**没有 NVIDIA 显卡**
→ 能跑，但走 CPU 会很慢（一句话几十秒）。运行时的 `device: cuda` 会自动回落 CPU。

**换电脑后 DSH 报 `1 entry did not activate`**
→ 重启一次 DSH（不是刷新页面）。还不行就看控制台里 `[dsh-sandrone]` 的日志。

---

## 体积与许可

| 项 | 大小 |
| --- | --- |
| 仓库本体（代码） | < 3 MB |
| Release：权重 | 313 MB |
| Release：便携运行时 | 8.3 GB |

角色「桑多涅」及《原神》相关名称版权归米哈游所有；本仓库只包含插件代码、自行训练的语音权重与打包的推理运行时，
供个人研究与自用，请勿用于商业用途或二次分发角色素材。
