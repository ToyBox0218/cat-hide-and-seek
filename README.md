# 貓咪捉迷藏：雙人尋貓

可直接放在 GitHub Pages 的雙人 WebRTC 邏輯遊戲。房主瀏覽器保存答案並裁定回合、計時與分數；加入者只收到公開盤面狀態。

## 立即遊玩

1. 兩人分別以 Google Chrome 開啟同一個 GitHub Pages 網址。
2. 房主按「建立房間」，將畫面上的 `CAT-...` 房號傳給另一位玩家。
3. 另一位玩家輸入房號並按「加入房間」。
4. PeerJS Cloud 只協調 WebRTC 握手；連線建立後，對局資料直接在兩個瀏覽器間傳送。

若 PeerJS Cloud 暫時不可用，可改用頁面的「手動建立／手動加入」，交換一次邀請碼與一次回覆碼，不需要中央 signaling 服務。

## 規則與功能

- 12×12、20×20、24×24；每行、每列、每個連通區域恰好一隻貓，貓不可八方向相鄰。
- 找到貓得一分並續手；猜錯、交棒、超時或達到連抓上限時換人。
- 每位玩家可設定不同回合秒數，連抓上限可開關。
- 已確認貓會公開標示直接排除格；私人 X／候選記號只留在自己的瀏覽器。
- 雙方都同意後才顯示教學式共同提示；提示只指出可優先檢查的行、列或區域，不直接公布答案格。
- 固定友善表情、雙方同意再戰、再戰交換先手。
- 方向鍵可移動焦點，Enter／Space 操作格子；支援瀏覽器縮放與減少動態偏好。
- WebAudio 音效在第一次使用者操作後啟用，可隨時靜音。
- 房主重新整理後可恢復權威局面，取得新房號並讓另一位玩家重新加入。

## PeerJS 第三方服務

- 用戶端鎖定 PeerJS `1.5.5`，檔案隨專案發布，不在執行時向 CDN 下載。
- 檔案：`vendor/peerjs-1.5.5.min.js`
- SHA-256：`7604D8C31BEC4F134B0D15C2D80B1D095EA18AF005354F439F14291FCD7B4168`
- PeerJS 官方說明預設 PeerServer Cloud 免費處理 signaling，且自訂 ID 可能碰撞；本遊戲使用高熵 `CAT-` 房號，遇碰撞會顯示錯誤而不覆寫別人的房間。
- 官方亦說這是共享服務，高流量應自行架設 PeerServer。本專案不把它視為有 SLA 的正式商用服務。
- PeerJS 已停止免費 TURN；本專案只設定公開 STUN。因此對稱 NAT、企業或校園防火牆下可能無法直連，不保證所有跨網路環境成功。

官方資料：

- https://peerjs.com/client/getting-started
- https://peerjs.com/client/faq
- https://peerjs.com/server/cloud
- https://github.com/orgs/peers/discussions/1172

## 隱私與權威限制

- 不使用自由文字聊天，不要求姓名、信箱或兒童個資。
- 正常協定不會把 `solution` 傳給加入者。
- 房主瀏覽器持有答案及權威狀態，無法防止房主修改公開原始碼、竄改本機計時或使用外部解題器。
- 房號會送至 PeerJS Cloud 以建立 WebRTC 握手；PeerJS 官方說明連線建立後資料不經 signaling 伺服器，除非使用 TURN。本專案沒有設定 TURN。
- 私人筆記存於自己的 `sessionStorage`，不傳給對手。

## 可選自架 signaling 範例

`signaling/` 提供 Cloudflare Workers Durable Objects 範例，但目前沒有部署，也不是預設房號流程所必需。

- `SignalRoom` 使用 Durable Object 的 `ctx.storage` 暫存 offer／answer，並以 alarm 在十分鐘後刪除。
- 它不是 global memory；Durable Object 負責單一房間的一致儲存與 WebSocket hibernation。
- 它不保存題目、答案、分數或對局狀態。
- `Matchmaker` 可配對同規則的等待者；未部署時快速隨機配對就是未提供，頁面不會假裝配到機器人。
- 部署需要使用者自己的 Cloudflare 帳號與明確授權。本專案沒有建立帳號、OAuth 或付費服務。

## 本機啟動

在專案上層目錄執行：

```powershell
node scripts/serve-p2p.js
```

再用 Chrome 開啟 `http://127.0.0.1:3010/`。

## GitHub Pages

此目錄可直接作為倉庫根目錄，Pages 來源設為 `main` 分支根目錄即可。所有遊戲資源都使用相對路徑；`signaling/` 不會由 GitHub Pages 執行。

## 已驗證

- Google Chrome 兩個獨立使用者資料夾，經目前正常運作的 PeerJS Cloud 建立真正 WebRTC DataChannel。
- PeerJS 房號邀請、答案不下發、私人筆記隔離、雙方共同提示、鍵盤方向鍵。
- 房主重新整理後恢復局面、產生新房號、另一位玩家重新加入。
- P2P 12×12、20×20、24×24 都完成整局；連抓上限設為 1 時分別以 6:6、10:10、12:12 平手。
- 手動兩段交換備援完成 12×12 整局。
- 12／20／24 各抽驗 30 題，共 90 題：規則合法、區域連通、唯一解。
- 13 項規則與伺服器單元測試通過。

未驗證：兩個真實外網環境的 NAT 穿透率、TURN 後備、自架 Cloudflare signaling 的線上部署、PeerJS Cloud 長時間負載或 SLA。

## 本機新版（尚未發布）

- 基礎玩法統一為偵探尋貓：正式翻到空格會公開周圍八格總貓數；數字由房主答案產生後固定，包含之後已找到的貓。
- 模式可選「偵探對戰」或「默契合作」。合作仍輪流、計時並遵守連抓上限，全部找到後共同成功，個人找到數只作紀念。
- 六款內建貓咪頭像會同步給對手並保存本機偏好，不需要上傳照片或真實姓名。
- 新增固定「怎麼玩」、清楚圖例、真正翻空格／規則排除／私人筆記的形狀與填色區別，以及非阻塞動畫。
- 這些修改目前只存在本機工作樹；未取得新版公開發布批准前不會推送或部署。
