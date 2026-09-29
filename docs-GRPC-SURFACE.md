# Our Notes gRPC 免登录方法面清单

生成：2026-09-28 23:07:16　目标：`l14-prod-hk-all-gs-sirius.gamerfusiontech.com`

做法：从 `apk-extract/global-metadata.dat` 抽出真实服务名与 `__Method_*` 方法名，
对每个 (服务, 方法) 组合发一个 **空的 5 字节 gRPC 帧**（`00 00 00 00 00`，
`content-type: application/grpc+proto`，**不带任何登录态**），看 HTTP 状态。
全部是只读探测，不写任何账号数据。

## 结果

| 项 | 值 |
|---|---|
| 探测次数 | 9020（55 服务 × 164 方法）|
| 注册存在的方法 | **145**，分布在 41 个服务 |
| 未注册 | 8875（返回 `404 page not found`）|
| **免登录且返回数据** | **3** |

> 注意：**未知方法与未知服务都返回 404**，无法区分，所以必须做笛卡尔积。

## 免登录可用的接口（只有这 3 个）

| 方法 | 返回 | 内容 |
|---|---|---|
| `app.masterdata.MasterdataService/Version` | 74 B | `resourceVersion=0b21c9f4…`、`contentVersion=1.0.0.105`（主数据更新已在用）|
| `app.feature_switch.FeatureSwitchService/Get` | 106 B | 3 个功能开关，均 =1：`cdkEnabled`、`announcementRelatedLinksEnabled`、`announcementFeaturedRecommendationsEnabled` |
| `app.external_payments.ExternalPaymentsService/Nop` | 5 B | 空响应（探活）|

## 已注册但需要登录态/参数的方法（142 个）

这些返回 `200` 但**响应体为空** —— 说明方法存在，但空请求缺必填字段或缺少登录态。

| 服务 | 注册方法数 |
|---|---|
| `app.live.LiveService` | 21 |
| `app.circle.CircleService` | 14 |
| `app.membercard.MemberCardService` | 8 |
| `app.shop.ShopService` | 8 |
| `app.circleinvitation.CircleInvitationService` | 6 |
| `app.event.EventService` | 6 |
| `app.friend.FriendService` | 6 |
| `app.gacha.GachaService` | 6 |
| `app.mission.MissionService` | 6 |
| `app.offlinebonus.OfflineBonusService` | 5 |
| `app.circlejoinrequest.CircleJoinReqService` | 4 |
| `app.external_payments.ExternalPaymentsService` | 4 |
| `app.liveboost.LiveBoostService` | 4 |
| `app.invitation.InvitationService` | 3 |
| `app.livemusic.LiveMusicService` | 3 |
| `app.memory.MemoryService` | 3 |
| `app.present.PresentService` | 3 |
| `app.seasonpass.SeasonPassService` | 3 |
| `app.story.StoryService` | 3 |
| `app.supports_terms.SupportsTermsService` | 3 |
| `app.circlemission.CircleMissionService` | 2 |
| `app.circleplayer.CirclePlayerService` | 2 |
| `app.circlerankupreward.CircleRankUpRewardService` | 2 |
| `app.stamp.StampService` | 2 |
| `app.supportcard.SupportCardService` | 2 |
| `app.announcement.AnnouncementService` | 1 |
| `app.banditem.BandItemService` | 1 |
| `app.carousel_help.CarouselHelpService` | 1 |
| `app.circleranking.CircleRankingService` | 1 |
| `app.content_unlock.ContentUnlockService` | 1 |
| `app.deck.DeckService` | 1 |
| `app.feature_switch.FeatureSwitchService` | 1 |
| `app.firebase.FirebaseService` | 1 |
| `app.home.HomeService` | 1 |
| `app.integrity.IntegrityService` | 1 |
| `app.loginbonus.LoginBonusService` | 1 |
| `app.masterdata.MasterdataService` | 1 |
| `app.personal_notification.PersonalNotificationService` | 1 |
| `app.sendchat.SendChatService` | 1 |
| `app.serial_code.SerialCodeService` | 1 |
| `app.spot.SpotService` | 1 |

完整方法名见 `data/on/grpc_methods.json`。

## 结论

* 想让机器人做「按 UID 查玩家资料 / 查好友 / 查排行」这类功能，**必须复刻登录态**，
  没有任何免登录的旁路。
* 免登录面只有版本号 + 功能开关，没有玩家数据。
