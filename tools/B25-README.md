# B25 导出与网页入口修正

网页 browser/b25-renderer.mjs 为唯一绘图源；shared/b25-renderer.mjs 为发布时同字节副本。修改时同步并比较SHA256，不再维护另一套Pillow坐标。

npm ci 后运行 node tools/b25-render.cjs --in record.json --out image.png --assets /www/wwwroot/ournotes-web。

资源须包括 static-data/b25-font.ttf、b25-extra.json，以及 ui-images、avatar-images、jacket-images。文泉驿字体许可证随网页发布；两端字体/图像一致，Canvas引擎抗锯齿仍可能存在像素差异。

仓库 on_commands.js 只保留 Our Notes 指令。生产宿主中的其他游戏模块不在此仓库；部署时应按宿主的模块边界集成并先备份。

运行时独立放在 data/on/b25-runtime/（tools、shared、package.json和lock），该目录 npm ci --omit=dev --ignore-scripts。串行渲染，至多3个排队/运行请求，30秒超时、Node heap128MiB，实测25首图约110MiB RSS/1.85秒。PNG发送后5分钟清理。

离线验收：ON_DIR=/var/tmp/test-b25 ON_WEB_ASSETS=/path/to/web B25_TEST_SOURCE=/path/to/staged-on_commands.js node tests/test_b25_output.cjs /home/admin/bot/on_commands.js /path/to/synthetic-record.json。假HTTP及截获sendReply，不发送QQ消息，不读取真实账号。检验无数据引导、PNG尺寸、网页链接、JSON清理和/onhelp b25。
