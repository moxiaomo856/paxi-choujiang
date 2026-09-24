/* =====================================================================
 * chain.js —— 钱包连接 + 链上查询 / 交易
 *
 * 钱包适配层：仅支持 PaxiHub App（手机端）
 *   window.paxihub
 *     API: hub.paxi.getAddress() → { address, public_key }
 *          hub.paxi.signAndSendTransaction({ bodyBytes, authInfoBytes, chainId, accountNumber })
 *          ⚠️ signAndSendTransaction 只签名，不广播！
 *             拿到 result.success（签名 base64）后，需自行组装 TxRaw 并 POST 到 LCD 广播。
 *             见下方 executeViaPaxihub。
 *
 * 未检测到 window.paxihub → hasWallet() 返回 false，触发 UI 兜底（提示用 PaxiHub 打开）。
 * ===================================================================== */
(function () {
  const C = window.CJ_CONFIG;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchWithTimeout(url, opt = {}, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opt, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const toBase64 = (bytes) => {
    // bytes 可以是字符串（兼容旧代码）或 Uint8Array
    if (typeof bytes === 'string') {
      return btoa(unescape(encodeURIComponent(bytes)));
    }
    // Uint8Array → base64
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  /** raw → 人类可读（整数/小数分段换算，raw > 2^53 也不丢精度） */
  function fmt(raw, dec) {
    if (raw === null || raw === undefined || raw === '') return '0';
    let s = String(raw).trim();
    const neg = s.startsWith('-');
    if (neg) s = s.slice(1);
    const [i = '0', f = ''] = s.split('.');
    const frac = (f + '0'.repeat(dec)).slice(0, dec);
    let out = BigInt(i || '0').toLocaleString('zh-CN');
    if (dec > 0 && frac) out += '.' + frac;
    return (neg ? '-' : '') + out;
  }

  /** public_key / pubkey 兼容：钱包可能返回数组（Uint8Array / Array），也可能返回 base64 字符串 */
  function pkToHex(pk) {
    if (pk == null) return '';
    if (typeof pk === 'string') {
      // getAddress() 可能直接返回 hex 字符串，此时 atob 会解出乱码。
      // 压缩公钥 33 字节 = 66 hex，非压缩 65 字节 = 130 hex。
      if (/^[0-9a-fA-F]+$/.test(pk) && (pk.length === 66 || pk.length === 130)) {
        return pk.toLowerCase();
      }
      // base64 字符串 → decode 后转 hex
      const bin = atob(pk);
      return Array.from(bin).map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    }
    // Uint8Array / Array → 直接转
    return Array.from(pk).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 人类可读 → raw（字符串拼接，避免浮点误差） */
  function toRaw(human, dec) {
    const s = String(human).trim();
    if (!s) return '0';
    const neg = s.startsWith('-');
    const body = neg ? s.slice(1) : s;
    const [int, frac = ''] = body.split('.');
    const f = (frac + '0'.repeat(dec)).slice(0, dec);
    const v = (BigInt(int || '0') * BigInt(Math.pow(10, dec)) + BigInt(f || '0')).toString();
    return neg ? '-' + v : v;
  }

  // ---------- 钱包 ----------
  const wallet = { address: '', pubkeyHex: '' };

  function detectWalletKind() {
    if (typeof window.paxihub !== 'undefined' && window.paxihub.paxi) return 'paxihub';
    return '';
  }

  const hasWallet = () => detectWalletKind() !== '';

  /**
   * PaxiHub 的桥接是**异步注入**的：脚本执行时 window.paxihub 可能还没挂上。
   * 直接同步判空会误判成"没钱包"，在 App 内也会把用户深链跳出去。
   */
  async function waitForWallet(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (detectWalletKind()) return true;
      await sleep(100);
    }
    return false;
  }

  async function connect() {
    if (!detectWalletKind()) await waitForWallet(2000);
    if (!detectWalletKind()) throw new Error('未检测到 PaxiHub 钱包。请在 PaxiHub App 内置浏览器打开本页面。');
    const info = await window.paxihub.paxi.getAddress();
    wallet.address = info.address;
    wallet.pubkeyHex = pkToHex(info.public_key);
    return wallet.address;
  }

  // ---------- 查询 ----------
  /** 查询合约（默认查抽奖合约；传 contract 可查别的合约，如 TKCC） */
  async function queryContract(msg, contract) {
    const addr = contract || C.contract;
    if (!addr || addr.startsWith('PASTE_')) throw new Error('合约地址未配置（config.js）');
    const url = `${C.lcd}/cosmwasm/wasm/v1/contract/${addr}/smart/${toBase64(JSON.stringify(msg))}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`查询失败 ${res.status}`);
    const json = await res.json();
    if (json.code) throw new Error(json.message || '查询返回错误');
    return json.data;
  }

  async function getBankBalances(address) {
    const res = await fetchWithTimeout(`${C.lcd}/cosmos/bank/v1beta1/balances/${address}`);
    const json = await res.json();
    return json.balances || [];
  }

  // ---------- paxihub 专属辅助 ----------
  /** §3.2 fetch accountNumber & sequence */
  async function buildCommon(chainId, address) {
    const res = await fetchWithTimeout(`${C.lcd}/cosmos/auth/v1beta1/accounts/${address}`);
    const json = await res.json();
    const account = json.account || {};
    const ba = account.base_account || account;
    // ⚠️ Cosmos SDK 里 account_number 的合法值就是 0，旧实现用 String(...) !== '0'
    // 判断"未初始化"，会让 account_number=0 的真实账户（通常是新账户）直接报错。
    const raw = ba.account_number;
    if (raw === undefined || raw === null || raw === '') {
      throw new Error('账户尚未在链上初始化（account_number 缺失）。请先接收一笔 PAXI 后重试。');
    }
    return {
      accountNumber: Number(raw),
      sequence: Number(ba.sequence || '0'),
    };
  }

  /** 从 tx_response 提取 wasm 事件的 key/value（数组形式，供前端按 key 查找事件属性）
   *
   * 兼容三种 LCD 形态：
   * 1) 顶层 txResponse.events（Cosmos SDK 0.47+ / 新版 LCD）——必须先查，
   *    否则 lottery_id / template_id 拿不到，模板池哈希链存不进 localStorage；
   * 2) txResponse.logs[].events（旧版）；
   * 3) 部分老版本把 attribute key 做 base64 —— wasm 事件 key 都是 [a-z_]，
   *    不匹配就尝试 atob 解码，解不动保底用原值。
   */
  function extractWasmAttrs(txResponse) {
    const out = [];
    const push = (evt) => {
      const t = evt && evt.type;
      if (!t || !(t === 'wasm' || t.startsWith('wasm-'))) return;
      for (const a of (evt.attributes || [])) {
        let k = a.key;
        try {
          if (k && !/^[a-z_]+$/.test(k)) k = atob(k);
        } catch (_) { /* 保底用原值 */ }
        out.push({ key: k, value: a.value });
      }
    };
    // 1) 顶层 events
    for (const evt of ((txResponse && txResponse.events) || [])) push(evt);
    // 2) logs[].events（旧版；部分 LCD 把 logs 返回成 JSON 字符串，先解析）
    let logs = (txResponse && txResponse.logs) || [];
    if (typeof logs === 'string') {
      try { logs = JSON.parse(logs); } catch (e) { logs = []; }
    }
    for (const log of logs) {
      for (const evt of (log.events || [])) push(evt);
    }
    return out;
  }

  // ---------- 交易 ----------
  async function waitForTx(hash, timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetchWithTimeout(`${C.lcd}/cosmos/tx/v1beta1/txs/${hash}`, {}, 10000);
        if (res.ok) {
          const txr = (await res.json()).tx_response || {};
          if (txr.code === 0) return { ok: true, raw: txr };
          if (txr.code) return { ok: false, raw: txr, log: txr.raw_log };
        }
      } catch (e) {
        /* 瞬时错误，继续轮询 */
      }
      await sleep(1500);
    }
    // 超时≠失败：交易可能已经上链。标记为 txPending，
    // 让上层知道**不要**回滚会话 nonce（否则本地比链上少 1，下一笔会被判重放）。
    const e = new Error(`交易确认超时（txhash=${hash}）。链上可能已成功，请稍后刷新列表确认。`);
    e.txPending = true;
    throw e;
  }

  /**
   * 用 paxihub 发交易（§3.4 buildAndSendTx 的精简版）。
   * 只走 wasm ExecuteContract，其余类型暂不需要。
   *
   * 流程：构造 SignDoc → signAndSendTransaction 让钱包签名（返回 success=base64 签名）
   *       → 组装 TxRaw → POST 到 LCD /cosmos/tx/v1beta1/txs 广播（SYNC 模式，只等 mempool 准入）
   *       → waitForTx 轮询链上最终执行结果 → 从 logs 提取 attributes → 返回。
   *
   * ⚠️ 旧注释说"signAndSendTransaction 内部完成签名+广播"是错的！
   *    指南 §3.4 明确写了：拿到 result.success（签名 base64）后必须自己组装 TxRaw 广播。
   *    另外 BROADCAST_MODE_SYNC 只做准入检查，合约里的 Err(TkccNotConfigured) /
   *    Err(AlreadyJoined) / Err(Expired) 等必须靠 waitForTx 二次确认，否则会被当成成功。
   */
  async function executeViaPaxihub(execMsg, funds, opts) {
    // 先等钱包库加载完
    if (typeof PaxiCosmJS === 'undefined') {
      throw new Error('PaxiCosmJS 库未加载，请检查网络');
    }

    const chainId = await getChainId();

    const { accountNumber, sequence } = await buildCommon(chainId, wallet.address);

    // TxBody：msgs + memo
    const msgs = [
      PaxiCosmJS.Any.fromPartial({
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: PaxiCosmJS.MsgExecuteContract.encode({
          sender: wallet.address,
          contract: opts.contract || C.contract,
          msg: new TextEncoder().encode(JSON.stringify(execMsg)),
          funds: funds || [],
        }).finish(),
      }),
    ];
    const txBody = PaxiCosmJS.TxBody.fromPartial({
      messages: msgs,
      memo: opts.memo || '',
    });

    // Fee
    const gas = String(opts.gas || C.defaultGas);
    // gasPrice 是浮点（如 0.05 / 0.123）；放大到 1e9 再取整，
    // 避免小数精度被截断导致手续费算错
    const gpScaled = Math.round(C.gasPrice * 1e9);
    const feeAmount = [{
      denom: C.coinMinimalDenom,
      amount: String(Math.max(1, Math.ceil(Number(gas) * gpScaled / 1e9))),
    }];
    const fee = { amount: feeAmount, gasLimit: gas };

    // PubKey Any
    const pubkeyBytes = new Uint8Array(wallet.pubkeyHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    const pubkeyAny = {
      typeUrl: '/cosmos.crypto.secp256k1.PubKey',
      value: PaxiCosmJS.PubKey.encode({ key: pubkeyBytes }).finish(),
    };

    // AuthInfo
    const authInfo = PaxiCosmJS.AuthInfo.fromPartial({
      signerInfos: [{
        publicKey: pubkeyAny,
        modeInfo: { single: { mode: 1 } },
        sequence: BigInt(sequence),
      }],
      fee,
    });

    // SignDoc
    const signDoc = PaxiCosmJS.SignDoc.fromPartial({
      bodyBytes: PaxiCosmJS.TxBody.encode(txBody).finish(),
      authInfoBytes: PaxiCosmJS.AuthInfo.encode(authInfo).finish(),
      chainId,
      accountNumber: BigInt(accountNumber),
    });

    // §3.4 signAndSendTransaction —— 注意：这一步只签名，不广播！
    const txObj = {
      bodyBytes: toBase64(signDoc.bodyBytes),    // 本地 toBase64，不要用 PaxiCosmJS.Encoder（不存在）
      authInfoBytes: toBase64(signDoc.authInfoBytes),
      chainId,
      accountNumber: String(signDoc.accountNumber),
    };
    const result = await window.paxihub.paxi.signAndSendTransaction(txObj);

    if (!result || !result.success) {
      throw new Error('paxihub 签名失败：' + JSON.stringify(result));
    }

    // ---- 组装 TxRaw 并广播（指南 §3.4 后半段，旧代码完全缺失这一步）----
    const sigBytes = Uint8Array.from(atob(result.success), (c) => c.charCodeAt(0));
    const txRaw = PaxiCosmJS.TxRaw.fromPartial({
      bodyBytes: signDoc.bodyBytes,
      authInfoBytes: signDoc.authInfoBytes,
      signatures: [sigBytes],
    });
    const base64Tx = toBase64(PaxiCosmJS.TxRaw.encode(txRaw).finish());

    const broadcastRes = await fetchWithTimeout(`${C.lcd}/cosmos/tx/v1beta1/txs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_bytes: base64Tx, mode: 'BROADCAST_MODE_SYNC' }),
    });
    if (!broadcastRes.ok) {
      throw new Error('广播失败：HTTP ' + broadcastRes.status);
    }
    let broadcast;
    try { broadcast = await broadcastRes.json(); }
    catch { throw new Error('LCD 返回异常（HTTP ' + broadcastRes.status + '）'); }
    const txr = broadcast.tx_response || {};

    // BROADCAST_MODE_SYNC 返回的 code 是准入检查结果（序列号错误、签名错误会在这里报）
    if (txr.code !== undefined && txr.code !== 0) {
      throw new Error(txr.raw_log || '广播失败：code=' + txr.code);
    }

    // BROADCAST_MODE_SYNC 只等 mempool 准入，不等合约执行；必须进一步用 waitForTx
    // 轮询链上最终结果，否则合约里的 Err(TkccNotConfigured) / Err(AlreadyJoined) /
    // Err(Expired) 会被当成成功，UI 显示"参与成功"但链上实际失败。
    const txhash = txr.txhash;
    if (!txhash) {
      // 拿不到 txhash 就无法二次确认，合约到底执行成功还是失败是未知的。
      // 旧实现在这里返回 code:0，UI 会显示"参与成功"，但链上可能是失败的 ——
      // 宁可报错让用户去区块浏览器核对，也不要给出假成功。
      throw new Error('广播未返回 txhash，无法确认链上执行结果，请稍后刷新列表核对。');
    }
    const confirmed = await waitForTx(txhash);
    if (!confirmed.ok) {
      throw new Error(confirmed.log || '交易执行失败');
    }
    const attrs = extractWasmAttrs(confirmed.raw);
    return { code: 0, transactionHash: txhash, raw: confirmed.raw, attributes: attrs };
  }

  // ---------- chainId ----------
  /**
   * 链上 chainId（**会话签名原文的第一段，必须与交易签名用同一个值**）。
   *
   * 之前 session.js 用 config.js 的硬编码值、chain.js 用链上动态值，两者目前
   * 恰好都是 `paxi-mainnet` 所以没暴露问题；一旦链改名或切链，交易能发出去、
   * 但会话验签会**全量失败**（签名原文第一段就对不上），而且错误定位极难。
   * 这里统一由 chain.js 取一次并缓存，两个用途共用同一个值。
   */
  let cachedChainId = '';
  let cachedChainIdAt = 0;
  const CHAIN_ID_TTL = 5 * 60 * 1000; // 5 分钟：链改名/切链最多 5 分钟内感知
  async function getChainId() {
    if (cachedChainId && Date.now() - cachedChainIdAt < CHAIN_ID_TTL) {
      return cachedChainId;
    }
    try {
      const r = await fetchWithTimeout(`${C.lcd}/cosmos/base/tendermint/v1beta1/node_info`, {}, 5000);
      const j = await r.json();
      const onchain = j && j.default_node_info && j.default_node_info.network;
      if (onchain) {
        if (onchain !== C.chainId) {
          console.warn(`chainId 不一致：config=${C.chainId}，链上=${onchain}，改用链上值`);
        }
        cachedChainId = onchain;
        cachedChainIdAt = Date.now();
        return cachedChainId;
      }
    } catch (e) { /* 查不到就用 config 兜底 */ }
    cachedChainId = C.chainId;
    cachedChainIdAt = Date.now();
    return cachedChainId;
  }

  /**
   * 发送执行交易。
   * @param {object} execMsg ExecuteMsg，如 { join_lottery: { id: 1, auth } }
   * @param {Array}  funds   原生币 [{ denom, amount }]
   * @param {object} opts    { gas, memo, contract, session:{action,roundId,amount} }
   */
  /**
   * 交易串行队列。
   *
   * 每笔交易都会各自去 LCD 取一次 sequence。如果用户连点两下，两笔交易会拿到
   * **同一个 sequence**，第二笔必然被节点以 "account sequence mismatch" 拒绝。
   * 这里用一个 promise 链把所有发交易的动作串起来，保证前一笔落地后再取下一个
   * sequence。前一笔失败不能阻塞后续，所以 then/catch 两边都放行。
   */
  let txQueue = Promise.resolve();
  function serializeTx(fn) {
    const run = txQueue.then(fn, fn);
    txQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async function execute(execMsg, funds = [], opts = {}) {
    return serializeTx(async () => {
      if (!wallet.address) await connect();

      // P1-1：合约里 CreateLottery / JoinLottery / ActivateTemplate 的 `auth`
      // 是**必填**字段（非 Option），而只有开启会话才会由 signPayload 注入。
      // 未开启时消息会缺 auth，链上反序列化直接拒绝（missing field auth），
      // 报错对普通用户完全不可读。这里提前拦下，给出能照做的提示。
      const needAuth = !!opts.session;
      if (needAuth && !(window.CJSession && window.CJSession.state.enabled)) {
        const err = new Error(
          '该操作需要「无感会话」签名：请先点右上角「开启无感」（只需一次），成功后再重试。'
        );
        err.needSession = true;
        throw err;
      }

      const usedSession = needAuth;

      let finalMsg = execMsg;
      if (usedSession) {
        const { payload } = await window.CJSession.signPayload(
          execMsg,
          opts.session.action,
          opts.session.roundId,
          opts.session.amount
        );
        finalMsg = payload;
      }

      try {
        return await executeViaPaxihub(finalMsg, funds, opts);
      } catch (e) {
        // e.txPending = waitForTx 超时：交易可能已上链，此时回滚本地 nonce
        // 会让本地比链上少 1，下一笔签名被判重放。只有确认没上链才回滚。
        if (usedSession && !e.txPending) window.CJSession.rollbackNonce();
        throw e;
      }
    });
  }

  window.CJChain = {
    C,
    wallet,
    hasWallet,
    waitForWallet,
    connect,
    getChainId,
    queryContract,
    getBankBalances,
    execute,
    waitForTx,
    extractWasmAttrs,
    fmt,
    toRaw,
    toBase64,
    fetchWithTimeout,
  };
})();
