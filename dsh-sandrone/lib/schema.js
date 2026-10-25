/**
 * 取 `@deepseek-ai/schemastery` 的那一层。
 *
 * 为什么不能只写 `import z from "@deepseek-ai/schemastery"`：
 * 这个插件是从工作区目录**链接**进 profile 的，模块的真实路径在 profile 之外，
 * 于是 Node 的裸包名解析会从插件目录一路往上找 —— 那一路上没有 `@deepseek-ai/*`。
 * 桌面版 DSH 的 profile 又只带了极少几个包（`schemastery`、`cosmokit`），
 * 所以正确的拿法是从 **profile 根** 解析（`createRequire($DSH_PROFILE_DIR/package.json)`），
 * 再按文件 URL 动态 import。
 *
 * 三条路依次试：
 *   ① profile 根（最常见，也是和宿主同一份）；
 *   ② `$DSH_HOME/profiles/*` 里每一个 profile 根；
 *   ③ 裸 import（web profile / 依赖被 hoist 上来的机器）。
 *
 * 全失败时**不伪造 schema**：`Config` 导出 undefined，插件照常加载，只是没有设置页
 * —— 因为一个形状不对的 schema 会让整条 loader 条目激活失败（实测报错
 * `runtime.Config.~standard.validate is not a function`），那比少一个设置页糟得多。
 */
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "@deepseek-ai/schemastery";

/** 依次尝试 profile 根的 package.json 作为解析基准。 */
function profileBases() {
  const bases = [];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (typeof profileDir === "string" && profileDir !== "") {
    bases.push(join(profileDir, "package.json"));
  }
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  try {
    for (const name of readdirSync(join(home, "profiles"))) {
      bases.push(join(home, "profiles", name, "package.json"));
    }
  } catch {
    /* 没有 profiles 目录就算了 */
  }
  bases.push(join(process.cwd(), "package.json"));
  return bases;
}

/** 从 profile 树里拿到这个包；拿不到返回 null。 */
async function fromProfiles(packageName) {
  for (const base of profileBases()) {
    try {
      const requireFrom = createRequire(base);
      const entry = requireFrom.resolve(packageName);
      return await import(pathToFileURL(entry).href);
    } catch {
      /* 换下一个基准 */
    }
  }
  return null;
}

let z = null;
try {
  const mod = (await fromProfiles(PACKAGE)) ?? (await import(PACKAGE));
  z = mod?.default ?? mod ?? null;
} catch {
  z = null;
}
if (z !== null && (typeof z.object !== "function" || typeof z.string !== "function")) z = null;

/** 是否拿到了真的 schemastery（false ⇒ 这个插件没有 Config）。 */
export const hasSchema = z !== null;

export default z;
