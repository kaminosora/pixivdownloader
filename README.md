# Pixiv 原图下载器 1.2.0

纯 Chrome 扩展，Chrome 116+。先选保存文件夹，再批量保存原图，不逐张弹出另存为窗口。动图自动转 GIF，超过 GIF 限制时转视频，并保留原始每帧时长。无需本地辅助程序。

## 安装与更新

1. 从 [GitHub Release v1.2.0](https://github.com/kaminosora/pixivdownloader/releases/tag/v1.2.0) 下载 [插件安装包 pixiv-original-downloader-1.2.0.zip](https://github.com/kaminosora/pixivdownloader/releases/download/v1.2.0/pixiv-original-downloader-1.2.0.zip)，解压得到 extension 文件夹。GitHub 自动生成的 Source code 压缩包是源码，需按下方构建步骤生成 dist 后才能加载。
2. 打开 chrome://extensions，开启「开发者模式」，点击「加载已解压的扩展程序」，选择直接包含 manifest.json 的文件夹。
3. 更新旧版时先等待任务完成或取消；把新版 extension 内容复制到原加载目录，再在扩展管理页点击「重新加载」。如果原来加载的是项目 dist，只需重新加载。
4. 确认版本为 **1.2.0**，刷新原有 Pixiv 标签页。可将扩展固定到工具栏，或使用作品页右下角「↓ 原图下载」。

## 选择保存位置

1. 在下载面板点击「选择保存文件夹」。
2. 打开的扩展设置页中点击「选择文件夹并允许写入」，在系统对话框中选目录，并完成 Chrome 的授权提示。
3. 选好后自动返回原标签页，面板显示所选文件夹名，可以开始下载。

**下载期间请保留文件夹设置页**，可以切换到其他标签，不必一直看着它。关闭设置页或重启浏览器可能使目录权限失效；此时点击「更换 / 重新授权文件夹」再次选择即可。记住目录句柄不等于永久授权。

网页内嵌面板与 Pixiv 跨域，Chrome 不允许它直接调出目录选择器，因此选目录需要独立扩展页面。选定后全部文件直接写入，不受 Chrome「下载前询问每个文件的保存位置」设置影响，无需更改该全局设置。

浏览器提供目录句柄与名称，不提供完整本地绝对路径，因此面板显示文件夹名。

## 下载范围和结果

- **下载当前作品**：只保存当前标签页对应作品，多图作品自动保存全部原图。
- **下载本窗口全部作品**：只取发起操作窗口内已打开的 Pixiv 作品页；同作品去重。其他窗口、推荐链接、作者页和搜索页不加入。
- 文件直接保存到所选目录顶层。每个任务入队时固定保存位置，之后换目录不影响已排队任务。
- 静态图片保留原图 URL 的完整文件名，如 121113419-原有哈希_p0.jpg，不使用 Blob 缓存 UUID，也不改为作品标题。哈希如果本来存在于 Pixiv 原图地址，就属于原文件名的一部分。
- 同名文件自动加 (1)、(2) 等序号，保留已有文件，例如 123_p0 (1).png。
- 关闭下载面板不影响后台处理；Chrome 与文件夹设置页需保持运行。
- 可取消和重试。重试整个作品时采用当前选择的目录，已存在文件另存带序号副本。

支持 https://www.pixiv.net/artworks/ID 和 /en/artworks/ID 等语言前缀。请在当前 Chrome 登录并确认有作品访问权限。

## 原图与动图

静态作品使用对应 /pages 接口每页的 urls.original；保留原始字节和格式，不截屏、不保存缩略图、不需要点「查看全部」。同时检查作品 ID、页码、原图目录和来源域名。支持 ID_pN.ext 和 ID-32位哈希_pN.ext 两种文件名。

动图 ugoira 原本由帧和时序组成，没有可直接保存的原生 GIF。本扩展下载逐帧原图，按帧时长转换为 GIF；超过 GIF 限制时自动生成视频。**只保存一个转换结果，不生成 ZIP、时序 JSON 或散帧文件**。名称从来源推导，如 123-hash_ugoira0.png 转为 123-hash_ugoira.gif；视频使用同一主干，扩展名为 .mp4 或 .webm。

GIF 最多 256 色、二值透明度，最长边最多 1280 像素；时间按 10ms 精度近似，播放器还可能限制极短帧间隔。GIF 是转换副本，不是无损原帧存档。

### GIF 超限自动转视频

以下任一 GIF 限制触发自动转视频：超过 600 帧、缩放后累计超过 1.5 亿像素、累计原帧超过 128 MiB、生成的 GIF 超过 128 MiB，或单帧时间超出 GIF 表达上限。面板显示切换原因和编码进度；完成后显示实际文件名。

优先使用浏览器支持的 H.264 / MP4；不可用时使用 VP9 或 VP8 / WebM。无需安装视频软件，不会上传到外部转换服务。已知超限会直接逐帧下载、编码；中途超限会复用已下载的帧，再按顺序取得剩余帧。

**Pixiv 动图使用每帧 delay，并不一定具有固定帧率。** 视频按原始毫秒时长累加时间戳，保留每一帧及最后一帧停留时间；不强制转换成 25、30 或 60 FPS，不用实时录屏。视频是可变帧间隔（VFR），媒体软件显示的单个平均 FPS 不能代表完整时序。播放是否循环由播放器设置决定。

视频最长边 1920，不放大；MP4 需要时补到偶数尺寸，透明区域转黑底，无音轨。视频属于有损转换副本。单张静态图/单个动图原帧仍以 128 MiB 为上限；视频编码数据和最终输出均限制为 256 MiB，以控制本地内存使用。没有可用编码器、视频超限、损坏图片、尺寸不一致或网络错误会明确失败，不输出 ZIP。静态多图任务中已成功保存的文件会保留。

## 常见问题

- **目录权限失效**：重新选择并授权，下载期间保留设置页。不会暗中退回逐文件另存为。
- **HTTP 401/403/404、超时或限流**：检查登录、作品可见性和网络，稍后重试，不会用缩略图替代。
- **后台服务重启**：对照仍存活的处理页恢复状态，无法确认的任务标为中断。完全重启 Chrome 可能改变窗口编号，旧记录可能不在新面板显示，可重新打开作品再发起下载。
- **取消中途写入**：尽力中止并清理本次新建的未完成文件；权限已撤销时可能残留空文件，已保存和原有文件会保留。
- **Chrome 下载列表没有记录**：新版直接写入所选目录，完成状态及实际文件名见插件面板，文件可直接在目录中查看。

## 隐私与权限

没有遥测、云转换或上传；仅请求 Pixiv 元数据与 i.pximg.net 原图。登录由 Chrome 提供，不读取、导出或保存密码或 Cookie。

任务和各窗口的目录名称保存在扩展本地存储，目录句柄保存在扩展 IndexedDB。写权限来自用户在浏览器中选择目录时的授权。卸载会移除扩展记录，已保存文件保留。

Manifest 使用 storage、offscreen、alarms、declarativeNetRequestWithHostAccess 和两个站点权限；**已移除 downloads 权限**。来源头修改仅作用于扩展自己发往 Pixiv/CDN 的请求。

## 构建和验证

需要 Node.js 22+，日常加载现成插件无需 Node.js。

源码仓库不包含生成的 dist、依赖和浏览器测试资料。克隆仓库后，在项目根目录运行 `npm.cmd ci --cache .cache/npm` 和 `npm.cmd run build` 即可生成可加载的 dist 文件夹；完整验证与打包命令如下。

```powershell
npm.cmd ci --cache .cache/npm
npm.cmd test
npm.cmd run build
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/ms-playwright"
npx.cmd --no-install playwright install chromium
npm.cmd run test:browser
npm.cmd run test:video
npm.cmd run package
```

测试使用项目内独立浏览器配置、网络夹具和目录，不使用日常 Chrome 登录资料。自动测试与原生目录对话框验证范围分别记录在 docs/verification.md。真实 Pixiv 账号、风控、地域网络与未来接口变化需在使用环境验收。

可选 npm run test:network 使用回环 HTTPS 服务验证来源头，需要 OpenSSL；可用 PIXIV_TEST_OPENSSL 指定路径，默认 Git for Windows 附带版本。这只是开发测试依赖。

## 依据和许可证

- [Chrome File System Access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [Chrome 目录持久权限](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)
- [扩展存储与分区](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- [Chrome Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [WebCodecs 时戳与质量模式](https://www.w3.org/TR/webcodecs/)
- [Mediabunny 1.64.0 封装源码](https://github.com/Vanilagy/mediabunny/tree/v1.64.0/src)
- [Pixiv 哈希原图样例](https://github.com/mikf/gallery-dl/commit/4654ef47f445e9ef834e8aa678c644d3395e7266)

代码为独立实现，采用 MIT。运行时依赖 gifenc 1.0.3（MIT）和 Mediabunny 1.64.0（MPL-2.0）；fflate 0.8.2（MIT）用于开发发布包，不进入下载处理脚本。Mediabunny 未修改，许可证与对应库源码压缩包随 extension/licenses 提供；本项目自有代码仍为 MIT。插画版权属于原权利人。
