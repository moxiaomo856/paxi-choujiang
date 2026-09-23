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

  /** raw → 人类可读 */
  function fmt(raw, dec) {
    if (raw === null || raw === undefined || raw === '') return '0';
    const n = Number(raw) / Math.pow(10, dec);
    return n.toLocaleString('zh-CN', { maximumFractionDigits: dec });
  }

  /** public_key / pubkey 兼容：钱包可能返回数组（Uint8Array / Array），也可能返回 base64 字符串 */
  function pkToHex(pk) {
    if (pk == null) return '';
    if (typeof pk === 'string') {
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
  const wallet = { address: '', pubkeyHex: '', kind: 'paxihub' };

  function detectWalletKind() {
    if (typeof window.paxihub !== 'undefined' && window.paxihub.paxi) return 'paxihub';
    return '';
  }

  const hasWallet = () => detectWalletKind() !== '';

  async function connect() {
    if (!detectWalletKind()) throw new Error('未检测到 PaxiHub 钱包。请在 PaxiHub App 内置浏览器打开本页面。');
    const info = await window.paxihub.paxi.getAddress();
    wallet.address = info.address;
    wallet.pubkeyHex = pkToHex(info.public_key);
    wallet.kind = 'paxihub';
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
    return {
      accountNumber: Number(ba.account_number || '0'),
      sequence: Number(ba.sequence || '0'),
    };
  }

  /** 把 CosmJS Any 格式的 msgs 转成 TxBody.messages 需要的 proto Any */
  function toProtoAny(typeUrl, msgValueObj) {
    return {
      typeUrl,
      value: toBase64(
        PaxiCosmJS.MsgExecuteContract.encode({
          sender: msgValueObj.sender,
          contract: msgValueObj.contract,
          msg: msgValueObj.msg,
          funds: msgValueObj.funds || [],
        }).finish()
      ),
    };
  }

  /** 从 tx_response.raw.logs 里提取 wasm 事件的 key/value（数组形式，供前端按 key 查找事件属性） */
  function extractWasmAttrs(txResponse) {
    const out = [];
    const logs = (txResponse && txResponse.logs) || [];
    for (const log of logs) {
      for (const evt of (log.events || [])) {
        if (evt.type !== 'wasm') continue;
        for (const a of (evt.attributes || [])) {
          out.push({ key: a.key, value: a.value });
        }
      }
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
    throw new Error('交易确认超时（链上可能已成功，请刷新查看）');
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

    const { accountNumber, sequence } = await buildCommon(C.chainId, wallet.address);

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
    const feeAmount = [{ denom: C.coinMinimalDenom, amount: String(Math.max(1, Math.ceil(Number(gas) * C.gasPrice))) }];
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
      chainId: C.chainId,
      accountNumber: BigInt(accountNumber),
    });

    // §3.4 signAndSendTransaction —— 注意：这一步只签名，不广播！
    const txObj = {
      bodyBytes: toBase64(signDoc.bodyBytes),    // 本地 toBase64，不要用 PaxiCosmJS.Encoder（不存在）
      authInfoBytes: toBase64(signDoc.authInfoBytes),
      chainId: C.chainId,
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
      // 极少数情况 SYNC 不返回 txhash，只能兜底返回（合约实际执行状态未知）
      return { code: 0, transactionHash: '', raw: txr };
    }
    const confirmed = await waitForTx(txhash);
    if (!confirmed.ok) {
      throw new Error(confirmed.log || '交易执行失败');
    }
    const attrs = extractWasmAttrs(confirmed.raw);
    return { code: 0, transactionHash: txhash, raw: confirmed.raw, attributes: attrs };
  }

  /**
   * 发送执行交易。
   * @param {object} execMsg ExecuteMsg，如 { join_lottery: { id: 1, auth } }
   * @param {Array}  funds   原生币 [{ denom, amount }]
   * @param {object} opts    { gas, memo, contract, session:{action,roundId,amount} }
   */
  async function execute(execMsg, funds = [], opts = {}) {
    if (!wallet.address) await connect();

    const usedSession = opts.session && window.CJSession && window.CJSession.state.enabled;

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
      if (usedSession) window.CJSession.rollbackNonce();
      throw e;
    }
  }

  window.CJChain = {
    C,
    wallet,
    hasWallet,
    connect,
    queryContract,
    getBankBalances,
    execute,
    waitForTx,
    fmt,
    toRaw,
    toBase64,
    fetchWithTimeout,
  };
})();
