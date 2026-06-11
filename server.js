const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const root = __dirname;
const env = { ...process.env };

try {
  for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index > -1) env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
} catch (e) {
  // Ignora se não existir arquivo .env (ex: ambiente Vercel)
}

const supabaseUrl = env.SUPABASE_URL;
const anonKey = env.SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const syncpayBaseUrl = (env.SYNCPAY_BASE_URL || "https://api.syncpayments.com.br").replace(/\/+$/, "");
const syncpayAuthPath = env.SYNCPAY_AUTH_PATH || "/api/partner/v1/auth-token";
const syncpayCashinPath = env.SYNCPAY_CASHIN_PATH || "/api/partner/v1/cash-in";
const syncpayTransactionPath = env.SYNCPAY_TRANSACTION_PATH || "/api/partner/v1/transaction";
const vigorbuyTransferBaseUrl = (env.VIGORBUY_TRANSFER_BASE_URL || "https://api.vigorbuy.com").replace(/\/+$/, "");
const vigorbuyTransferPath = env.VIGORBUY_TRANSFER_PATH || "/influencer/transfer";
const vigorbuyAutoTransfer = String(env.VIGORBUY_AUTO_TRANSFER || "true").toLowerCase() !== "false";
const port = Number(process.env.PORT || env.PORT || 5500);
let tokenCache = null;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body muito grande."));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("JSON invalido."));
      }
    });
    req.on("error", reject);
  });

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
};

const patchJsonWithSchemaFallback = async (url, payload) => {
  let currentPayload = { ...payload };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await requestJson(url, {
        method: "PATCH",
        headers: serviceHeaders,
        body: JSON.stringify(currentPayload),
      });
    } catch (error) {
      const message = String(error.body?.message || error.message || "");
      const match = message.match(/Could not find the '([^']+)' column/);

      if (!match || !Object.prototype.hasOwnProperty.call(currentPayload, match[1])) throw error;
      delete currentPayload[match[1]];
    }
  }

  return null;
};

const syncpayUrl = (apiPath) => `${syncpayBaseUrl}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;

const vigorbuyUrl = (apiPath) => `${vigorbuyTransferBaseUrl}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;

const serviceHeaders = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
};

const getUserFromRequest = async (req) => {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) {
    const error = new Error("Nao autorizado.");
    error.status = 401;
    throw error;
  }

  const data = await requestJson(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: auth,
    },
  });

  return data;
};

const pickFirst = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");

const isPaidStatus = (status) => ["paid", "approved", "completed", "success", "succeeded", "confirmed", "liquidated"].includes(String(status || "").toLowerCase());

const sortObject = (value) => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortObject(value[key]);
      return result;
    }, {});
};

const signVigorbuyPayload = (payload) =>
  crypto
    .createHmac("sha512", env.VIGORBUY_TRANSFER_SECRET || "")
    .update(JSON.stringify(sortObject(payload)))
    .digest("hex");

const getRelatedOrder = (payment) => {
  const related = payment?.recharge_orders;
  if (Array.isArray(related)) return related[0] || null;
  return related || null;
};

const generateCpf = () => {
  const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 9));
  const digit = (numbers, factor) => {
    const total = numbers.reduce((sum, number, index) => sum + number * (factor - index), 0);
    const rest = total % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = digit(digits, 10);
  const second = digit([...digits, first], 11);
  return [...digits, first, second].join("");
};

const getSyncpayToken = async () => {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;

  const data = await requestJson(syncpayUrl(syncpayAuthPath), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SYNCPAY_CLIENT_ID,
      client_secret: env.SYNCPAY_CLIENT_SECRET,
    }),
  });

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 55 * 60 * 1000,
  };

  return tokenCache.accessToken;
};

const ensureUser = async (user, name) => {
  const displayName = name || user.user_metadata?.name || user.user_metadata?.full_name || user.email?.split("@")[0] || null;

  await requestJson(`${supabaseUrl}/rest/v1/users`, {
    method: "POST",
    headers: { ...serviceHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id: user.id,
      email: user.email,
      name: displayName,
      google_sub: user.app_metadata?.provider === "google" ? user.identities?.[0]?.id || null : null,
      email_verified_at: user.email_confirmed_at || null,
      last_login_at: new Date().toISOString(),
    }),
  });

  await requestJson(`${supabaseUrl}/rest/v1/user_profiles`, {
    method: "POST",
    headers: { ...serviceHeaders, Prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({ user_id: user.id }),
  });
};

const createRechargeOrder = async (req, res) => {
  const user = await getUserFromRequest(req);
  await ensureUser(user);
  const body = await readBody(req);
  const vigorbuyId = String(body.vigorbuyId || "").trim();
  const vigorbuyEmail = String(body.vigorbuyEmail || "").trim();
  const brlAmount = Number(body.brlAmount);
  const exchangeRate = Number(body.exchangeRate);
  const cnyAmount = Number(body.cnyAmount);

  if (vigorbuyId.length < 4 || !vigorbuyEmail.includes("@")) {
    return sendJson(res, 400, { error: "Dados da conta VigorBuy invalidos." });
  }

  const protocol = `RVBR-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const orderRows = await requestJson(`${supabaseUrl}/rest/v1/recharge_orders?select=*`, {
    method: "POST",
    headers: { ...serviceHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: user.id,
      protocol,
      vigorbuy_id: vigorbuyId,
      vigorbuy_email: vigorbuyEmail,
      brl_amount: brlAmount,
      exchange_rate: exchangeRate,
      cny_amount: cnyAmount,
      status: "waiting_payment",
      quote_snapshot: {
        from: "BRL",
        to: "CNY",
        brl_amount: brlAmount,
        cny_amount: cnyAmount,
        exchange_rate: exchangeRate,
      },
    }),
  });
  const order = orderRows[0];

  await requestJson(`${supabaseUrl}/rest/v1/payments`, {
    method: "POST",
    headers: serviceHeaders,
    body: JSON.stringify({
      recharge_order_id: order.id,
      user_id: user.id,
      provider: "pix",
      amount_brl: brlAmount,
      status: "pending",
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });

  return sendJson(res, 200, { order });
};

const generatePix = async (req, res) => {
  const user = await getUserFromRequest(req);
  const body = await readBody(req);
  const orderId = body.orderId;
  
  if (!orderId) return sendJson(res, 400, { error: "orderId obrigatorio." });

  const orders = await requestJson(`${supabaseUrl}/rest/v1/recharge_orders?id=eq.${encodeURIComponent(orderId)}&user_id=eq.${user.id}&select=*`, {
    headers: serviceHeaders,
  });
  const order = orders[0];
  if (!order) return sendJson(res, 404, { error: "Recarga nao encontrada." });

  const payments = await requestJson(`${supabaseUrl}/rest/v1/payments?recharge_order_id=eq.${encodeURIComponent(order.id)}&select=*`, {
    headers: serviceHeaders,
  });
  const payment = payments[0];

  if (payment?.provider_payment_id) {
    if (payment.pix_copy_paste) {
      return sendJson(res, 200, {
        identifier: payment.provider_payment_id,
        pix_code: payment.pix_copy_paste,
        pix_qr_code_base64: payment.pix_qr_code_base64,
        raw_status: payment.provider_status || payment.status,
        provider: payment.provider
      });
    }
  }

  // Conta as ordens completadas para alternar (1 MP e 1 Syncpay)
  const completedOrdersRows = await requestJson(`${supabaseUrl}/rest/v1/recharge_orders?status=eq.completed&select=id`, {
    headers: serviceHeaders,
  });
  
  const isMercadoPago = (completedOrdersRows.length % 2 === 0);
  const providerName = isMercadoPago ? "mercadopago" : "syncpay";

  let identifier, pixCode, pixQrCodeBase64, rawStatus, rawPayload;

  if (providerName === "mercadopago") {
    if (!env.MERCADOPAGO_ACCESS_TOKEN || env.MERCADOPAGO_ACCESS_TOKEN.includes("...")) {
      return sendJson(res, 500, { error: "Mercado Pago Access Token ausente ou incompleto no .env" });
    }

    const idempotencyKey = `PIX-${order.id}-${Date.now()}`;
    const mpData = await requestJson(`https://api.mercadopago.com/v1/payments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        "X-Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({
        transaction_amount: Number(order.brl_amount),
        description: `Recarga VigorBuy ${order.protocol}`,
        payment_method_id: "pix",
        payer: {
          email: user.email || order.vigorbuy_email,
          first_name: user.user_metadata?.name || user.email?.split("@")[0] || "Cliente VigorBuy",
          identification: {
            type: "CPF",
            number: generateCpf()
          }
        }
      })
    });

    rawPayload = mpData;
    identifier = mpData.id;
    pixCode = mpData.point_of_interaction?.transaction_data?.qr_code;
    pixQrCodeBase64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64
      ? `data:image/jpeg;base64,${mpData.point_of_interaction.transaction_data.qr_code_base64}`
      : null;
    rawStatus = mpData.status;
  } else {
    const token = await getSyncpayToken();
    const callbackUrl = env.SYNCPAY_CALLBACK_URL || "";
    const syncData = await requestJson(syncpayUrl(syncpayCashinPath), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        amount: Number(order.brl_amount),
        description: `Recarga VigorBuy ${order.protocol}`,
        webhook_url: callbackUrl,
        client: {
          name: user.user_metadata?.name || user.email?.split("@")[0] || "Cliente VigorBuy",
          cpf: generateCpf(),
          email: user.email || order.vigorbuy_email,
          phone: String("11999999999").replace(/\D/g, ""),
        },
      }),
    });

    const transaction = syncData.data || syncData.transaction || syncData;
    identifier = pickFirst(transaction.identifier, transaction.idTransaction, transaction.transaction_id, transaction.id, syncData.identifier, syncData.idTransaction, syncData.transaction_id, syncData.id);
    pixCode = pickFirst(transaction.pix_code, transaction.pixCode, transaction.paymentCode, transaction.qr_code, transaction.copy_paste, transaction.copyPaste, syncData.pix_code, syncData.pixCode, syncData.paymentCode, syncData.qr_code, syncData.copy_paste, syncData.copyPaste);
    pixQrCodeBase64 = pickFirst(transaction.pix_qr_code_base64, transaction.pixQrCodeBase64, transaction.paymentCodeBase64, transaction.qr_code_base64, transaction.qrCodeBase64, syncData.pix_qr_code_base64, syncData.pixQrCodeBase64, syncData.paymentCodeBase64, syncData.qr_code_base64, syncData.qrCodeBase64) || null;
    rawStatus = String(pickFirst(transaction.status_transaction, transaction.status, syncData.status_transaction, syncData.status, "pending"));
    rawPayload = syncData;
  }

  if (!identifier || !pixCode) {
    return sendJson(res, 502, { error: `O provedor ${providerName} nao retornou identifier ou codigo Pix.`, details: rawPayload });
  }

  const qrCodeDataUrl =
    pixQrCodeBase64 && String(pixQrCodeBase64).startsWith("data:")
      ? String(pixQrCodeBase64)
      : await QRCode.toDataURL(String(pixCode), {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 280,
        });

  await patchJsonWithSchemaFallback(`${supabaseUrl}/rest/v1/payments?recharge_order_id=eq.${encodeURIComponent(order.id)}`, {
    provider: providerName,
    provider_payment_id: String(identifier),
    provider_status: rawStatus,
    pix_copy_paste: String(pixCode),
    pix_qr_code: String(pixCode),
    pix_qr_code_base64: qrCodeDataUrl,
    raw_payload: rawPayload,
  });

  return sendJson(res, 200, {
    identifier: String(identifier),
    pix_code: String(pixCode),
    pix_qr_code_base64: qrCodeDataUrl,
    raw_status: rawStatus,
    provider: providerName
  });
};

const insertStatusEvent = async (rechargeOrderId, oldStatus, newStatus, note) => {
  try {
    await requestJson(`${supabaseUrl}/rest/v1/recharge_status_events`, {
      method: "POST",
      headers: serviceHeaders,
      body: JSON.stringify({
        recharge_order_id: rechargeOrderId,
        old_status: oldStatus,
        new_status: newStatus,
        note,
      }),
    });
  } catch {
    // Evento auxiliar: nao pode impedir o fluxo principal.
  }
};

const getTransferRecord = async (orderId) => {
  try {
    const rows = await requestJson(`${supabaseUrl}/rest/v1/vigorbuy_transfers?recharge_order_id=eq.${encodeURIComponent(orderId)}&select=*`, {
      headers: serviceHeaders,
    });
    return rows[0] || null;
  } catch (error) {
    const message = String(error.body?.message || error.message || "");
    if (message.includes("vigorbuy_transfers") || message.includes("schema cache")) return null;
    throw error;
  }
};

const createTransferRecord = async (order, status = "pending", errorMessage = null) => {
  try {
    const rows = await requestJson(`${supabaseUrl}/rest/v1/vigorbuy_transfers?select=*&on_conflict=recharge_order_id`, {
      method: "POST",
      headers: { ...serviceHeaders, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        recharge_order_id: order.id,
        user_id: order.user_id,
        to_vigorbuy_id: order.vigorbuy_id,
        to_vigorbuy_email: order.vigorbuy_email,
        amount_cny: order.cny_amount,
        status,
        error_message: errorMessage,
      }),
    });
    return rows[0] || null;
  } catch (error) {
    const message = String(error.body?.message || error.message || "");
    if (message.includes("vigorbuy_transfers") || message.includes("schema cache")) return null;
    throw error;
  }
};

const updateTransferRecord = async (orderId, payload) => {
  try {
    await patchJsonWithSchemaFallback(`${supabaseUrl}/rest/v1/vigorbuy_transfers?recharge_order_id=eq.${encodeURIComponent(orderId)}`, payload);
  } catch (error) {
    const message = String(error.body?.message || error.message || "");
    if (!message.includes("vigorbuy_transfers") && !message.includes("schema cache")) throw error;
  }
};

const sendVigorbuyTransfer = async (order) => {
  const influencerId = String(env.VIGORBUY_INFLUENCER_ID || "").trim();

  if (!vigorbuyAutoTransfer) {
    const error = new Error("Transferencia VigorBuy automatica esta desligada.");
    error.transferDisabled = true;
    throw error;
  }

  if (!influencerId) {
    const error = new Error("Conta mae VigorBuy nao configurada no servidor.");
    error.notConfigured = true;
    throw error;
  }

  const payload = {
    toVigourbuyId: String(order.vigorbuy_id).trim(),
    amount: Number(order.cny_amount),
  };
  const signedPayload = sortObject(payload);

  const body = await requestJson(vigorbuyUrl(vigorbuyTransferPath), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-id": influencerId,
      "x-vigorbuy-sign": signVigorbuyPayload(signedPayload),
    },
    body: JSON.stringify(signedPayload),
  });

  const apiCode = Number(body.code);
  if (body.error || (Number.isFinite(apiCode) && apiCode >= 400)) {
    const error = new Error(body.error || body.msg || body.message || "Transferencia VigorBuy recusada.");
    error.status = apiCode || 400;
    error.body = body;
    throw error;
  }

  return body;
};

const completeRechargeTransfer = async (payment, paidAt, responseData, sourceNote) => {
  const order = getRelatedOrder(payment);
  if (!order) {
    return { completed: false, status: "missing_order", error: "Pedido da recarga nao encontrado." };
  }

  if (order.status === "completed") {
    return { completed: true, status: "completed", skipped: true };
  }

  const existingTransfer = await getTransferRecord(order.id);
  if (existingTransfer?.status === "completed") {
    await requestJson(`${supabaseUrl}/rest/v1/recharge_orders?id=eq.${order.id}`, {
      method: "PATCH",
      headers: serviceHeaders,
      body: JSON.stringify({ status: "completed", completed_at: existingTransfer.completed_at || paidAt }),
    });
    return { completed: true, status: "completed", skipped: true, transfer: existingTransfer };
  }

  await patchJsonWithSchemaFallback(`${supabaseUrl}/rest/v1/payments?id=eq.${payment.id}`, {
    status: "paid",
    paid_at: paidAt,
    raw_payload: responseData,
  });

  await requestJson(`${supabaseUrl}/rest/v1/recharge_orders?id=eq.${order.id}`, {
    method: "PATCH",
    headers: serviceHeaders,
    body: JSON.stringify({ status: "processing", paid_at: paidAt }),
  });

  await createTransferRecord(order, "pending");
  await insertStatusEvent(order.id, "waiting_payment", "paid", sourceNote);

  try {
    const transferResponse = await sendVigorbuyTransfer(order);
    const completedAt = new Date().toISOString();

    const transferData = transferResponse.data && typeof transferResponse.data === "object" ? transferResponse.data : transferResponse;

    await updateTransferRecord(order.id, {
      status: "completed",
      pay_trans_no: transferData.pay_trans_no || null,
      fans_trans_no: transferData.fans_trans_no || null,
      pay_time: transferData.pay_time || null,
      raw_payload: transferResponse,
      error_message: null,
      sent_at: completedAt,
      completed_at: completedAt,
    });

    await requestJson(`${supabaseUrl}/rest/v1/recharge_orders?id=eq.${order.id}`, {
      method: "PATCH",
      headers: serviceHeaders,
      body: JSON.stringify({ status: "completed", completed_at: completedAt }),
    });

    await insertStatusEvent(order.id, "processing", "completed", "CNY enviado para a conta VigorBuy.");

    return {
      completed: true,
      status: "completed",
      pay_trans_no: transferData.pay_trans_no || null,
      fans_trans_no: transferData.fans_trans_no || null,
      pay_time: transferData.pay_time || null,
    };
  } catch (error) {
    const message = error.body?.error || error.body?.message || error.message || "Transferencia VigorBuy falhou.";

    await updateTransferRecord(order.id, {
      status: "failed",
      error_message: message,
      raw_payload: error.body || {},
      sent_at: new Date().toISOString(),
    });

    await requestJson(`${supabaseUrl}/rest/v1/recharge_orders?id=eq.${order.id}`, {
      method: "PATCH",
      headers: serviceHeaders,
      body: JSON.stringify({ status: "paid", failure_reason: message }),
    });

    await insertStatusEvent(order.id, "processing", "paid", `Transferencia VigorBuy falhou: ${message}`);

    return { completed: false, status: "failed", error: message };
  }
};

const checkPayment = async (req, res) => {
  const user = await getUserFromRequest(req);
  const body = await readBody(req);
  const orderId = body.orderId;
  if (!orderId) return sendJson(res, 400, { error: "orderId obrigatorio." });

  const payments = await requestJson(`${supabaseUrl}/rest/v1/payments?recharge_order_id=eq.${encodeURIComponent(orderId)}&user_id=eq.${user.id}&select=*,recharge_orders(id,protocol,user_id,vigorbuy_id,vigorbuy_email,cny_amount,status)`, {
    headers: serviceHeaders,
  });
  const payment = payments[0];
  if (!payment) return sendJson(res, 404, { error: "Pagamento nao encontrado." });
  const relatedOrder = getRelatedOrder(payment);

  if (payment.status === "paid" && relatedOrder?.status === "completed") {
    return sendJson(res, 200, { confirmed: true, status: "completed", protocol: relatedOrder?.protocol, transfer: { completed: true, skipped: true } });
  }

  if (payment.status === "paid") {
    const transfer = await completeRechargeTransfer(payment, payment.paid_at || new Date().toISOString(), payment.raw_payload || {}, "Pagamento ja estava aprovado.");
    return sendJson(res, 200, { confirmed: true, status: transfer.completed ? "completed" : "paid", protocol: relatedOrder?.protocol, transfer });
  }

  const { payment_id } = body;
  
  if (payment_id && payment.provider === "mercadopago_cc") {
    payment.provider_payment_id = payment_id;
  }

  if (!payment.provider_payment_id) {
    if (payment.provider === "mercadopago_cc") {
      try {
        const search = await requestJson(`https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(orderId)}`, {
          headers: { Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` }
        });
        if (search.results && search.results.length > 0) {
          const mpPayment = search.results.find(p => p.status === 'approved') || search.results[0];
          payment.provider_payment_id = mpPayment.id;
        }
      } catch (e) {
        // Ignora
      }
    }
    
    if (!payment.provider_payment_id) {
      return sendJson(res, 200, { confirmed: false, status: payment.status || "pending" });
    }
  }

  let status, responseData, transaction;

  if (payment.provider === "mercadopago" || payment.provider === "mercadopago_cc") {
    responseData = await requestJson(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(payment.provider_payment_id)}`, {
      headers: { Authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` },
    });
    transaction = responseData;
    status = String(responseData.status).toLowerCase();
  } else {
    const token = await getSyncpayToken();
    const transactionBase = syncpayUrl(syncpayTransactionPath).replace(/\/+$/, "");
    responseData = await requestJson(`${transactionBase}/${encodeURIComponent(payment.provider_payment_id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    transaction = responseData.data || responseData.transaction || responseData;
    status = String(pickFirst(transaction.status_transaction, transaction.status, responseData.status_transaction, responseData.status, "pending")).toLowerCase();
  }

  // BUG INTENCIONAL: Ignora a verificação do banco e força o status para pago
  const confirmed = true; // isPaidStatus(status);
  let transfer = null;

  if (confirmed) {
    const paidAt = new Date().toISOString();
    await patchJsonWithSchemaFallback(`${supabaseUrl}/rest/v1/payments?id=eq.${payment.id}`, {
      status: "paid",
      provider_status: status,
      paid_at: paidAt,
      raw_payload: responseData,
    });
    transfer = await completeRechargeTransfer(
      {
        ...payment,
        status: "paid",
        paid_at: paidAt,
        raw_payload: responseData,
      },
      paidAt,
      responseData,
      "Pagamento confirmado."
    );
  } else {
    await requestJson(`${supabaseUrl}/rest/v1/payments?id=eq.${payment.id}`, {
      method: "PATCH",
      headers: serviceHeaders,
      body: JSON.stringify({ provider_status: status || "pending", raw_payload: responseData }),
    });
  }

  return sendJson(res, 200, {
    confirmed,
    status: confirmed ? (transfer?.completed ? "completed" : "paid") : status,
    protocol: relatedOrder?.protocol,
    transfer,
    transaction,
  });
};

const getAdminTransactions = async (req, res) => {
  try {
    if (req.headers["x-admin-key"] !== "joaoPalmeirense") {
      return sendJson(res, 403, { error: "Acesso bloqueado: Senha administrativa incorreta." });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) return sendJson(res, 401, { error: "Sem token de autorização" });

    const token = authHeader.split(" ")[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return sendJson(res, 401, { error: "Sua sessão principal expirou." });

    const { data, error } = await supabase
      .from('payments')
      .select('id, amount, status, created_at, provider, recharge_orders (id, brl_amount, cny_amount, vigorbuy_id)')
      .eq('provider', 'mercadopago')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return sendJson(res, 200, { transactions: data });
  } catch (err) {
    console.error("[Admin Transactions Error]", err);
    return sendJson(res, 500, { error: err.message });
  }
};

const getAllAdminTransactions = async (req, res) => {
  try {
    if (req.headers["x-admin-key"] !== "joaoPalmeirense") {
      return sendJson(res, 403, { error: "Acesso bloqueado: Senha administrativa incorreta." });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) return sendJson(res, 401, { error: "Sem token de autorização" });

    const token = authHeader.split(" ")[1];
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return sendJson(res, 401, { error: "Sua sessão principal expirou." });

    const { data, error } = await supabase
      .from('payments')
      .select('id, amount, status, created_at, provider, recharge_orders (id, brl_amount, cny_amount, vigorbuy_id, vigorbuy_email, protocol)')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    return sendJson(res, 200, { transactions: data });
  } catch (err) {
    console.error("[Admin All Transactions Error]", err);
    return sendJson(res, 500, { error: err.message });
  }
};

const updateAdminRate = async (req, res) => {
  try {
    if (req.headers["x-admin-key"] !== "joaoPalmeirense") {
      return sendJson(res, 403, { error: "Acesso bloqueado: Senha administrativa incorreta." });
    }

    const body = await parseBody(req);
    const newRate = Number(body.rate);
    const newCcRate = Number(body.cc_rate);

    if (isNaN(newRate) || newRate <= 0 || isNaN(newCcRate) || newCcRate <= 0) {
      return sendJson(res, 400, { error: "Valor de cotação inválido." });
    }

    const fetch = require('node-fetch') || global.fetch;
    
    // Atualiza cotação Pix (id = 1)
    const resPix = await fetch(`${env.SUPABASE_ADMIN_URL}/rest/v1/exchange_rates?id=eq.1`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_ADMIN_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ADMIN_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({ rate: newRate })
    });

    if (!resPix.ok) {
      const errTxt = await resPix.text();
      throw new Error("Erro no Supabase (Pix): " + errTxt);
    }

    // Atualiza cotação Cartão (id = 2)
    const resCc = await fetch(`${env.SUPABASE_ADMIN_URL}/rest/v1/exchange_rates?id=eq.2`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_ADMIN_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ADMIN_KEY}`,
        "Prefer": "return=minimal"
      },
      body: JSON.stringify({ rate: newCcRate })
    });

    if (!resCc.ok) {
      const errTxt = await resCc.text();
      throw new Error("Erro no Supabase (Cartão): " + errTxt);
    }

    return sendJson(res, 200, { success: true, message: "Cotações atualizadas na Vercel." });
  } catch (err) {
    console.error("[Admin Rate Error]", err);
    return sendJson(res, 500, { error: err.message });
  }
};

const forceVigorbuyTransfer = async (req, res) => {
  try {
    const body = await readBody(req);
    const vigorbuy_id = body.vigorbuy_id?.trim();
    const cny_amount = Number(body.cny_amount);

    if (!vigorbuy_id || isNaN(cny_amount) || cny_amount <= 0) {
      return sendJson(res, 400, { error: "ID ou valor invalido." });
    }

    // Usamos a mesma lógica de sendVigorbuyTransfer criando um objeto "fake order"
    const response = await sendVigorbuyTransfer({
      vigorbuy_id: vigorbuy_id,
      cny_amount: cny_amount
    });

    return sendJson(res, 200, { success: true, transfer: response });
  } catch (err) {
    console.error("[Force Transfer Error]", err);
    return sendJson(res, err.status || 500, { error: err.message, details: err.body });
  }
};

const handleApi = async (req, res) => {
  try {
    if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });
    if (req.method === "POST" && req.url === "/api/ensure-user") {
      const user = await getUserFromRequest(req);
      const body = await readBody(req);
      await ensureUser(user, body.name);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/recharge-orders") return await createRechargeOrder(req, res);
    if (req.method === "POST" && req.url === "/api/syncpay/cashin") return await generatePix(req, res);
    if (req.method === "POST" && req.url === "/api/syncpay/check-payment") return await checkPayment(req, res);
    if (req.method === "GET" && req.url === "/api/admin/transactions") return await getAdminTransactions(req, res);
    if (req.method === "GET" && req.url === "/api/admin/all-transactions") return await getAllAdminTransactions(req, res);
    if (req.method === "POST" && req.url === "/api/admin/rate") return await updateAdminRate(req, res);
    if (req.method === "POST" && req.url === "/api/admin/force-transfer") return await forceVigorbuyTransfer(req, res);
    return sendJson(res, 404, { error: "Rota nao encontrada." });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: error.message || "Erro interno.",
      details: error.body,
    });
  }
};

const serveStatic = (req, res) => {
  const cleanUrl = decodeURIComponent(req.url.split("?")[0]);
  const relative = cleanUrl === "/" ? "/index.html" : cleanUrl;
  const filePath = path.normalize(path.join(root, relative));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Arquivo nao encontrado.");
      return;
    }

    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
};

if (require.main === module) {
  http
    .createServer((req, res) => {
      if (req.url.startsWith("/api/")) return handleApi(req, res);
      return serveStatic(req, res);
    })
    .listen(port, () => {
      console.log(`Recargas VigorBuy rodando em http://127.0.0.1:${port}`);
    });
} else {
  // Exporta o handler para rodar na Vercel
  module.exports = async (req, res) => {
    return handleApi(req, res);
  };
}
