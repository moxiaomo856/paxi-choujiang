# 🎰 choujiang-simple —— 抽奖前端（三档简化版）

纯静态站点，可直接推到 GitHub Pages。对应合约：`contracts/paxi-lottery-contract-simple`。
（完整自由参数版保留在 `choujiang/` + `contracts/paxi-lottery-contract/`，两者独立部署。）

## 三档规格（simple 版核心）

| 档位 | 人数 | 每人参与费 | 建池费（进奖池） |
|---|---|---|---|
| 5 人档（tier 0） | 5 | 1 PAXI + 1 万 TKCC | 1 PAXI + 2 万 TKCC |
| 20 人档（tier 1） | 20 | 2 PAXI + 2 万 TKCC | 15 PAXI + 10 万 TKCC |
| 50 人档（tier 2） | 50 | 10 PAXI + 10 万 TKCC | 60 PAXI + 60 万 TKCC |

* 分配比例三档一致：TKCC 38/28/14/14/6（一/二/建池者/运营/销毁），PAXI 40/30/15/15。
* simple 版**只看满员开奖**：超时未满员一律退款，不存在"过期能凑数开奖"。
* 金额/人数全部由合约内 `tier_spec()` 静态决定，管理员改不了任何费用。
* 建池者**不能参与自己建的池**（合约强制；他已拿 14%/15% 建池者分成）。

## 双模式说明

### 官方奖池（推荐）
管理员预设模板（只选档位），用户点击"参与"即可，金额由档位决定。
池子满员自动开奖，同时自动用同模板开下一个池子。
**第一个参与的人与后面的人待遇完全一致，没有任何特殊奖励。**

官方池随机性由**平台托管 secret + 哈希链**提供：管理员创建模板时前端自动生成
一条随机哈希链（存本机 localStorage，`cj_tpl_chain_<模板id>`），提交链头承诺；
每次开奖前管理员点"揭示下一个秘密"，合约验证 sha256 后把承诺推进到揭示值。
揭示值记录在链上 `template_secrets` 查表（池子创建时的承诺 → 该池用的 secret），
因此**满员之后再揭示同样对该池生效**，多个并行池各用链上不同位置的值，互不干扰。
开奖后 `seed` 与随机源写入链上事件，**任何人可复算验证**。
⚠️ 秘密链只存本机：换设备/清缓存会永久丢失，届时该模板的池子只能退款，务必备份。

### 玩家自建池
玩家选一档建池（付对应建池费），可附加 commit-reveal 秘密增强随机性；
不填则用区块熵 + 参与者加入时间兜底（页面上会标明随机源）。

## 外部依赖风险（务必知悉）

* **TKCC 是外部 PRC-20**（`TK Card Coin`，decimals 6，总量固定、minter 为空）。
  我们已解码其链上字节码确认：实现为 `cw20_base`，支持 `transfer / send /
  burn / increase_allowance`，因此默认销毁方式可用黑洞转账，`Burn` 亦可真销毁。
* ⚠️ **该 TKCC 合约带有非标准的 `freeze / unfreeze` 扩展**：有权者理论上可冻结
  抽奖合约地址，导致合约内 TKCC 无法转出（开奖 / 提现失败）。TKCC 由本项目方发行，
  该风险由项目方自担；若未来 TKCC 控制权移交，需重新评估。
* 合约默认销毁方式是 `BlackHole`（需先配置黑洞地址）；页面上销毁方式默认项已与
  合约对齐。未配置黑洞地址时开奖会报 `BurnAddressNotConfigured`，奖池不会卡死
  （配置后即可开奖）。

## 一、文件

```
index.html    页面结构
config.js     链参数 / 合约地址 / 三档规格（tiers）
hash.js       加密工具（secp256k1 / sha256 / ripemd160 / bech32，走 CDN 库）
chain.js      钱包连接 + 合约查询 / 交易
session.js    无感会话密钥（domain = "lottery"）
lottery.js    抽奖合约调用封装（含哈希链生成）
app.js        UI 逻辑
styles.css    样式
```

## 二、部署前必做

1. 打开 `config.js`，把 `contract` 改成部署后的抽奖合约地址：

```js
contract: 'paxi1...（paxi-lottery-contract-simple 地址）',
```

2. **TKCC 地址已内置**，无需改动：

```js
tkccToken: 'paxi1s353hkvev2xtv5076wr5l2v6wy4tl9ph872g0puupakcx2p6rkls8q3vms',
```

这是主网 TKCC（`TK Card Coin` / decimals 6 / `cw20-base`）。
运行时优先用合约 `{"tkcc":{}}` 的返回值；合约尚未 `SetTkccToken` 时用这一条兜底，
并**直接向 TKCC 合约查 `token_info`** 拿 symbol 与 decimals（所以余额、精度在管理员启用前就能正确显示）。

3. **管理员 / 运营金库已内置**（写入合约时用；前端据此判断管理员）：

```js
admins: [
  'paxi1rdarmm997hqwfdgl9wvnpffe28zmex3kfyg7xd',
  'paxi1qvrmsftn402cumn0axqjc4dgvmkge6lhp0y39j',
],
multisigThreshold: 1,
treasury: 'paxi194kpjqhyz7re2g749lc2030cgeg4sql5ldvyem', // 运营分成收款地址
```

> 前端判断管理员时**优先用链上 `{"admins":{}}`**；合约还没部署/查询失败时回落到这份白名单，
> 所以本地联调也能看到管理面板。

4. **管理员启用**（一次性，页面按钮即可）：

* 「管理员：运营配置」→ 点 **写入运营金库**，把 `treasury` 写进合约；
* 「管理员：TKCC 集成」→ 点 **启用 TKCC（写入合约）**，写入 TKCC 地址；
* 6% 销毁建议选 **`burn`**（该 TKCC 是标准 cw20-base，支持 `burn`，真减少总供应）；
  不想真销毁就选 `black_hole` 并填黑洞地址；
* 习惯用 CLI：`SOCIAL_ADDR=… LOTTERY_ADDR=… ./scripts/set-tkcc.sh`（含运营金库）。

5. 推到 GitHub，Settings → Pages → 选分支根目录（或 `/choujiang`），用 **HTTPS** 访问
   （钱包注入只在 https 生效）。

> **精度**：PAXI 与 TKCC 都是 **6**（1 个 = `10^6` raw）。10000 TKCC = `10000000000` raw。

## 三、页面功能

| 区块 | 能力 |
| --- | --- |
| 顶部 | 连接钱包（PaxiHub App 内置浏览器）、开启 / 关闭无感 |
| 余额 | 内部 PAXI / TKCC 余额、链上 PAXI；充值 / 提现 |
| **官方奖池** | 展示各活跃模板的报名进度，一键参与；满员自动开新池 |
| **管理员：运营配置** | 仅管理员可见；查看管理员白名单 / 多签阈值，写入运营金库 |
| **管理员：TKCC 集成** | 仅管理员可见；一键写入 TKCC 地址、设置销毁方式 / 黑洞地址 |
| **管理员：模板管理** | 仅管理员可见；创建 / 启停模板，查看模板列表 |
| 创建抽奖 | 玩家自建池：**只选档位**（5 / 20 / 50 人档），建池费、参与费、人数全部由合约 `tier_spec()` 静态决定；可选填"随机秘密"（commit-reveal） |
| 列表 | 按状态筛选；参与 / 开奖 / 领取 / 退款 / 揭示秘密；每条带"官方池 / 玩家建池"标签 |

## 四、无感签名

开启"无感"时会弹**一次**钱包注册会话，之后参与 / 建池由会话密钥本地签名：

```
{chainId}:{contractAddr}:lottery:{action}:{roundId}:{amount}:{nonce}:{pubkeyHex}
```

| 操作 | action | roundId | amount |
| --- | --- | --- | --- |
| 建池（A 模式） | `create_lottery` | `0` | 建池费 **PAXI + TKCC 的 raw 总和**（PAXI 同样计入日限额） |
| 参与玩家池（A 模式） | `join_lottery` | 抽奖 ID | 参与费 **PAXI + TKCC 的 raw 总和** |
| 激活模板（B2 模式） | `activate_template` | 模板 ID | 参与费 **PAXI + TKCC 的 raw 总和** |

> B2 模式的 `roundId` 用 **template_id**（不是 pool_id）：池子可能在本笔交易里才被创建，
> 前端签名时并不知道 pool id。金额一律以链上池子为准，前端传的 amount 只用于签名匹配。

会话 24 小时过期；交易失败会自动回滚本地 nonce，并从链上重新同步。

### 会话私钥存储与安全边界

会话私钥存 `localStorage`，键名格式为 `cj_sess_priv__<主钱包地址>`
（抽奖前缀 `cj_`，社交前缀 `pt_`）。**明文存储，未加密。**

这是**有意**的选择：

- 手机端 `sessionStorage` 在切后台 / 锁屏 / 内存紧张时会被系统清空，
  导致"开一次无感只能用几分钟"，体验不可用；
- `sessionStorage` 与 `localStorage` 在 XSS / 同域脚本 / 浏览器扩展这三种
  主要攻击面前是**等价**的（都能被读），加密只能防"设备文件被物理窃取"这一种场景，
  而那种场景下攻击者可直接打开钱包 App 转走资产，无需偷会话私钥；
- 因此不做 AES-GCM 加密（复杂度高、保护面窄）。

**缓解措施**：

- 会话私钥 **≠** 主钱包私钥，泄漏只影响 `daily_limit`（默认 1e12 raw）额度内资金；
- 可随时在链上 `RevokeSession`（前端"关闭无感"按钮会触发）；
- 主钱包私钥从不落地。

**若你的威胁模型包含"设备被物理接触且浏览器未锁定"**：请勿开启无感，
或联系运营将 `daily_limit` 设为更小值。

## 五、TKCC 未配置时

* 页面顶部黄条提示"TKCC 尚未配置"
* 创建 / 参与抽奖会失败并返回 `TkccNotConfigured`
* 管理员在「管理员：TKCC 集成」点一次 **启用 TKCC**（或两个合约各调一次 `SetTkccToken`），刷新即可恢复正常

## 六、费用速查

| 项 | A 玩家建池 | B2 模板池 |
| --- | --- | --- |
| 建池费 | 按档位：**1 / 15 / 60 PAXI** + 2万 / 10万 / 60万 TKCC（全额进奖池） | 0 |
| 参与费 | 按档位：**1 / 2 / 10 PAXI** + 1万 / 2万 / 10万 TKCC | 同左（由模板所选档位决定） |
| 人数 | 按档位：**5 / 20 / 50**（满员即开） | 同左 |
| 触发者奖励 | — | **无**（与普通参与者完全一致） |
| 一等奖 | 1 人，TKCC 38% / PAXI 40% | 同左 |
| 二等奖 | 2 人，TKCC 共 28% / PAXI 共 30% | 同左 |
| 建池者 | TKCC 14% / PAXI 15% | 0 |
| 运营 | TKCC 14% / PAXI 15% | **28% / 30%**（含建池者那份） |
| 销毁 | TKCC 6% | TKCC 6% |

## 七、依赖

CDN（index.html 内引入，无需构建）：

* `@noble/secp256k1@2.1.0`
* `@noble/hashes@1.4.0`（sha256 / ripemd160）
* `bech32@2.0.0`

钱包：**仅支持** `window.paxihub`（PaxiHub App 内置浏览器）。
      PaxiHub 的 signAndSendTransaction 只签名，客户端自行组装 TxRaw
      并 POST 到 LCD（BROADCAST_MODE_SYNC）广播，然后 waitForTx 轮询最终结果。
