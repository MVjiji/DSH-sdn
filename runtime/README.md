# 运行时（GPT-SoVITS 推理引擎）说明

这个目录**故意是空的**：GPT-SoVITS 整合包有 10 GB 以上（Python 运行时 6.3 GB、torch 就占 4.1 GB，再加底模），
放不进任何普通 Git 仓库（GitHub 单文件 100 MB，Gitee 单文件 50 MB / 单仓库 500 MB）。

它不需要放进仓库，因为 `install.ps1` 会：

1. 先看 `-GptSoVitsDir` 参数；
2. 再看 profile 里上一轮写入的 `gptDir`；
3. 再扫常见位置（用户目录、C/D/E/F 盘下的 `GPT-SoVITS*`）。

找到就用，找不到会打印官方下载地址并提示你重跑。

## 怎么准备一份

- 官方 Releases：<https://github.com/RVC-Boss/GPT-SoVITS/releases>
- 官方网盘（夸克）：<https://drive.uc.cn/s/482dcfa346a94>

下载 `GPT-SoVITS-v2pro-20250604.7z` 之类的整合包，解压到任意目录（例如 `D:\GPT-SoVITS-v2pro-20250604`），
确认里面有：

```
api_v2.py
runtime\python.exe
GPT_SoVITS\configs\tts_infer.yaml
```

然后：

```powershell
.\install.ps1 -GptSoVitsDir "D:\GPT-SoVITS-v2pro-20250604"
```

## 为什么不用仓库里的模型去覆盖整合包的权重

插件的做法是：把整合包自带的 `tts_infer.yaml` 复制到临时目录，再把其中 `custom` 段的两个权重路径
改成 `dsh-sandrone\assets\weights\` 里的绝对路径，然后把这份临时副本交给 `api_v2.py`。

所以：

- 整合包目录里**不会**多出、也不会被改掉任何文件（连 `tts_infer.yaml` 都不动）；
- 仓库里的桑多涅模型跟着插件走，换电脑不用重新训练、也不用往整合包里拷文件。
