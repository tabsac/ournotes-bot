# 个人信息请求版本兼容

2026-10-10：旧 `x-client-version` 报 `gRPC 2: client update required`，旧主数据版本也会报 `master version mismatch`。生产实测同一凭证在该只读个人信息端点不发送可选客户端版本头、更新主数据版本后查询成功。

`on_player.js` 的公开 Masterdata.Version 不继承旧版本头。仅 Friend.FindByProfileID 收到上述版本错误时，重新查询主数据版本并重试一次，保留现有凭证。该兼容分支不用于登录、好友写操作或其他写接口，也不证明登录端点接受省略版本。

无需因为该错误让每个用户重新上传账号包。以后若实际登录凭证失效，仍按原有登录刷新流程处理；只有登录刷新也失败时才检查服务账号重新登录/采集。

回归：`node tests/test_profile_version.cjs` 使用合成凭证和模拟 HTTP/2，验证三次只读调用、主数据更新、凭证保留、写操作不使用版本兼容重试。生产查询已成功，工具变更已加载到 bot。
