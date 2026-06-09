const CONFIG = window.VIGOR_ENV || {};
const supabaseClient =
  window.supabase && CONFIG.supabaseUrl && CONFIG.supabaseAnonKey
    ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey)
    : null;

const supabaseAdminClient =
  window.supabase && CONFIG.supabaseAdminUrl && CONFIG.supabaseAdminKey
    ? window.supabase.createClient(CONFIG.supabaseAdminUrl, CONFIG.supabaseAdminKey)
    : null;

const toast = document.querySelector("#toast");
const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const internalPages = ["recarga", "historico", "configuracoes"];

const showToast = (message) => {
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("is-visible"), 3800);
};

const getApiErrorMessage = (data, error, fallback) => {
  const raw = String(data?.error || data?.message || error?.message || fallback || "");
  const lower = raw.toLowerCase();

  if (data?.code === "NOT_FOUND" || lower.includes("requested function was not found")) {
    return "Funcao do Supabase ainda nao foi publicada. Faca deploy das Edge Functions.";
  }

  if (data?.code === "42501" || lower.includes("row-level security")) {
    return "Banco bloqueou por RLS. Rode o database.sql atualizado no Supabase.";
  }

  if (lower.includes("not approved")) {
    return "Conta SyncPay ainda nao aprovada para gerar Pix.";
  }

  if (lower.includes("invalid_client") || lower.includes("client authentication failed")) {
    return "Credenciais SyncPay invalidas. Confira Client ID e Client Secret.";
  }

  return raw || fallback || "Nao foi possivel concluir a operacao.";
};

const callLocalApi = async (path, body = {}) => {
  const user = await getSessionUser();
  if (!user) throw new Error("Entre na sua conta para continuar.");

  const { data: sessionData } = await supabaseClient.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error("Sessao expirada. Entre novamente.");

  const isLocal = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const baseUrl = isLocal ? "http://127.0.0.1:5601" : "";
  const fullPath = path.startsWith("http") ? path : `${baseUrl}${path}`;

  const response = await fetch(fullPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.error) {
    const error = new Error(getApiErrorMessage(data, null, "Erro na API local."));
    error.data = data;
    error.status = response.status;
    throw error;
  }

  return data;
};

const showLoadingAndGo = (url, delay = 4000) => {
  const loading = document.querySelector("#loadingScreen");
  if (loading) {
    loading.classList.add("is-visible");
    loading.setAttribute("aria-hidden", "false");
  }

  window.setTimeout(() => {
    window.location.href = url;
  }, delay);
};

const getSessionUser = async () => {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.getUser();
  if (error) return null;
  return data.user || null;
};

const requireUser = async () => {
  const page = document.body.dataset.page;
  if (!internalPages.includes(page)) return null;

  if (!supabaseClient) {
    showToast("Configure o Supabase antes de continuar.");
    return null;
  }

  const user = await getSessionUser();
  if (!user) {
    window.location.href = "index.html";
    return null;
  }

  try {
    await ensureUserRows(user);
  } catch (error) {
    showToast(error.message || "Nao foi possivel preparar sua conta.");
  }

  return user;
};

const ensureUserRows = async (user, name) => {
  if (!supabaseClient || !user) return;

  try {
    await callLocalApi("/api/ensure-user", { name });
    return;
  } catch {
    // Continua com Supabase direto/Edge Function quando o backend local nao estiver rodando.
  }

  const { data, error } = await supabaseClient.functions.invoke("ensure-user", {
    body: { name },
  });

  if (!error && !data?.error) return;

  const displayName = name || user.user_metadata?.name || user.user_metadata?.full_name || user.email?.split("@")[0] || null;
  const { error: userError } = await supabaseClient.from("users").upsert(
    {
      id: user.id,
      email: user.email,
      name: displayName,
      google_sub: user.app_metadata?.provider === "google" ? user.identities?.[0]?.id || null : null,
      email_verified_at: user.email_confirmed_at || null,
      last_login_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  if (userError) {
    throw new Error(getApiErrorMessage(userError, data || error, "Nao foi possivel preparar sua conta."));
  }

  await supabaseClient.from("user_profiles").upsert(
    {
      user_id: user.id,
    },
    { onConflict: "user_id", ignoreDuplicates: true }
  );
};

const formatCny = (value) =>
  new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const mapRechargeStatus = (status) => {
  const labels = {
    draft: "Rascunho",
    waiting_payment: "Aguardando pagamento",
    paid: "Paga",
    processing: "Processando",
    completed: "Concluída",
    failed: "Falhou",
    canceled: "Cancelada",
  };

  return labels[status] || "Em análise";
};

const isDoneStatus = (status) => ["paid", "processing", "completed"].includes(status);

const initRevealAnimations = () => {
  const revealElements = document.querySelectorAll(".reveal");
  if (!revealElements.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  revealElements.forEach((element) => observer.observe(element));
};

const initLogin = () => {
  const form = document.querySelector("#loginForm");
  const googleButton = document.querySelector("#googleLoginButton");
  const card = document.querySelector(".login-card");
  const title = document.querySelector("#login-title");
  const nameInput = document.querySelector("#name");
  const forgotPassword = document.querySelector(".forgot-password");
  const loginButton = document.querySelector(".login-button");
  const authTabs = document.querySelectorAll("[data-auth-mode]");
  const authCopy = document.querySelector("[data-auth-copy]");
  const authToggle = document.querySelector("[data-auth-toggle]");
  let authMode = "login";
  let switchTimeout;

  const setAuthMode = (mode, shouldAnimate = true) => {
    if (mode === authMode && shouldAnimate) return;

    const previousTab = document.querySelector(".auth-tab.is-active");
    const isSignup = mode === "signup";
    authMode = mode;

    window.clearTimeout(switchTimeout);

    if (shouldAnimate) {
      card?.classList.add("is-switching");
      loginButton?.classList.remove("is-button-switching");
      window.requestAnimationFrame(() => loginButton?.classList.add("is-button-switching"));
      previousTab?.classList.add("is-tab-leaving");
    }

    if (title) title.textContent = "Sua conta";
    if (nameInput) {
      nameInput.classList.toggle("is-auth-hidden", !isSignup);
      nameInput.required = isSignup;
      nameInput.disabled = !isSignup;
      nameInput.setAttribute("aria-hidden", String(!isSignup));
    }
    if (forgotPassword) {
      forgotPassword.classList.toggle("is-auth-hidden", isSignup);
      forgotPassword.setAttribute("aria-hidden", String(isSignup));
    }
    if (authCopy) authCopy.textContent = isSignup ? "Ja tem conta?" : "Nao tem conta?";
    if (authToggle) authToggle.textContent = isSignup ? "Acessar" : "Criar conta";

    authTabs.forEach((tab) => {
      const isActive = tab.dataset.authMode === mode;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));

      if (shouldAnimate && isActive) {
        tab.classList.add("is-tab-entering");
      }
    });

    if (shouldAnimate) {
      switchTimeout = window.setTimeout(() => {
        card?.classList.remove("is-switching");
        loginButton?.classList.remove("is-button-switching");
        authTabs.forEach((tab) => tab.classList.remove("is-tab-entering", "is-tab-leaving"));
      }, 460);
    }
  };

  setAuthMode("login", false);

  authTabs.forEach((tab) => {
    tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode));
  });

  authToggle?.addEventListener("click", () => {
    setAuthMode(authMode === "signup" ? "login" : "signup");
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!supabaseClient) {
      showToast("Supabase não configurado.");
      return;
    }

    const formData = new FormData(form);
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    const name = String(formData.get("name") || "").trim();

    loginButton?.classList.add("is-loading");

    const result =
      authMode === "signup"
        ? await supabaseClient.auth.signUp({
            email,
            password,
            options: { data: { name } },
          })
        : await supabaseClient.auth.signInWithPassword({ email, password });

    loginButton?.classList.remove("is-loading");

    if (result.error) {
      const message = String(result.error.message || "");
      if (message.toLowerCase().includes("invalid login credentials")) {
        showToast("E-mail ou senha incorretos. Se acabou de criar a conta, confirme o e-mail primeiro.");
      } else if (message.toLowerCase().includes("email not confirmed")) {
        showToast("Confirme seu e-mail antes de entrar.");
      } else {
        showToast(message);
      }
      return;
    }

    if (result.data?.user && result.data?.session) {
      try {
        await ensureUserRows(result.data.user, name);
      } catch (error) {
        showToast("Login feito. Perfil sera sincronizado depois.");
      }

      showToast(authMode === "signup" ? "Conta criada com sucesso." : "Acesso confirmado.");
      showLoadingAndGo("recarga.html");
      return;
    }

    showToast("Conta criada. Confira seu e-mail para confirmar antes de entrar.");
  });

  googleButton?.addEventListener("click", async (e) => {
    e.preventDefault();
    showToast("Estamos atualizando o login com Google. Por favor, use e-mail e senha no momento.");
  });
};

const initDockNavigation = () => {
  const dock = document.querySelector(".bottom-nav");
  if (!dock) return;

  const items = Array.from(dock.querySelectorAll(".bottom-item"));
  const baseSize = 50;
  const magnification = 70;
  const distance = 200;
  let navigationTimer;

  const setItemSize = (item, size) => {
    item.style.setProperty("--dock-size", `${size.toFixed(1)}px`);
  };

  const resetDock = () => {
    dock.classList.remove("is-dock-hovered", "is-touching");
    items.forEach((item) => {
      item.classList.remove("is-touching");
      setItemSize(item, baseSize);
    });
  };

  const touchDockItem = (activeItem) => {
    const activeIndex = items.indexOf(activeItem);
    dock.classList.add("is-touching");

    items.forEach((item, index) => {
      item.classList.toggle("is-touching", item === activeItem);
      const distanceFromActive = Math.abs(index - activeIndex);
      const size = distanceFromActive === 0 ? magnification : distanceFromActive === 1 ? 58 : baseSize;
      setItemSize(item, size);
    });
  };

  dock.addEventListener("pointermove", (event) => {
    dock.classList.toggle("is-touching", event.pointerType === "touch");
    dock.classList.toggle("is-dock-hovered", event.pointerType !== "touch");

    items.forEach((item) => {
      const rect = item.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      const distanceFromMouse = Math.abs(event.clientX - center);
      const strength = Math.max(0, 1 - distanceFromMouse / distance);
      const size = baseSize + (magnification - baseSize) * strength;
      setItemSize(item, size);
    });
  });

  dock.addEventListener("pointerleave", resetDock);
  dock.addEventListener("blur", resetDock, true);

  items.forEach((item) => {
    item.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      touchDockItem(item);
    });

    item.addEventListener("pointerup", () => {
      window.setTimeout(resetDock, 220);
    });

    item.addEventListener("pointercancel", resetDock);

    item.addEventListener("click", (event) => {
      const href = item.getAttribute("href");

      if (href === "index.html") {
        if (!window.confirm("Deseja realmente sair da conta e ir para a página inicial?")) {
          event.preventDefault();
          return;
        }
      }

      if (!window.matchMedia("(pointer: coarse)").matches) return;

      if (!href || item.classList.contains("is-active")) return;

      event.preventDefault();
      window.clearTimeout(navigationTimer);
      touchDockItem(item);

      navigationTimer = window.setTimeout(() => {
        window.location.href = href;
      }, 180);
    });
  });

  resetDock();
};

const initRecharge = async (user) => {
  const form = document.querySelector("#rechargeForm");
  if (!form) return;
  form.noValidate = true;

  const quoteStep = document.querySelector("#quoteStep");
  const detailsStep = document.querySelector('[data-step="details"]');
  const checkoutStep = document.querySelector("#checkoutStep");
  const continueButton = document.querySelector("#continueToDetails");
  const backButton = document.querySelector("#backToQuote");
  const backToDetailsButton = document.querySelector("#backToDetails");
  const payButton = document.querySelector("#payRechargeButton");
  const paymentSuccess = document.querySelector("#paymentSuccess");
  const paymentBackdrop = document.querySelector("#paymentBackdrop");
  const vigorId = document.querySelector("#vigorId");
  const vigorEmail = document.querySelector("#vigorEmail");
  const amount = document.querySelector("#amount");
  const terms = document.querySelector("#terms");
  const amountButtons = document.querySelectorAll(".amount-option");
  const submitButton = form.querySelector(".submit-recharge-button");
  const pixAmount = document.querySelector("#pixAmount");
  const receiveAmount = document.querySelector("#receiveAmount");
  const summaryId = document.querySelector("#summaryId");
  const summaryEmail = document.querySelector("#summaryEmail");
  const summaryAmount = document.querySelector("#summaryAmount");
  const summaryCny = document.querySelector("#summaryCny");
  const statusBox = document.querySelector("#statusBox");
  const checkoutAccount = document.querySelector("#checkoutAccount");
  const checkoutEmail = document.querySelector("#checkoutEmail");
  const checkoutBrl = document.querySelector("#checkoutBrl");
  const checkoutCny = document.querySelector("#checkoutCny");
  const checkoutPixAmount = document.querySelector("#checkoutPixAmount");
  const pixResult = document.querySelector("#pixResult");
  const pixQrImage = document.querySelector("#pixQrImage");
  const pixCopyCode = document.querySelector("#pixCopyCode");
  const copyPixButton = document.querySelector("#copyPixButton");
  const checkPaymentButton = document.querySelector("#checkPaymentButton");
  const pixStatus = document.querySelector("#pixStatus");
  const rateLabel = document.querySelector("#rateLabel");
  let exchangeRate = 1.20;
  let baseRate = 1.20;
  let ccRate = 1.20;

  const loadExchangeRate = async () => {
    if (!supabaseAdminClient) return;
    try {
      const { data, error } = await supabaseAdminClient.from('exchange_rates').select('id, rate').in('id', [1, 2]);
      if (data && data.length > 0) {
        const pixData = data.find(r => r.id === 1);
        const ccData = data.find(r => r.id === 2);
        baseRate = pixData ? Number(pixData.rate) : 1.20;
        ccRate = ccData ? Number(ccData.rate) : baseRate;
        updateRateDisplay();
      }
    } catch (e) {
      console.error("Erro ao carregar cotação", e);
    }
  };

  const updateRateDisplay = () => {
    const method = document.querySelector('input[name="paymentMethod"]:checked')?.value || "pix";
    exchangeRate = method === "credit_card" ? ccRate : baseRate;
    if (rateLabel) rateLabel.textContent = `1 BRL = ${exchangeRate.toFixed(2)} CNY`;
    updateSummary();
    
    // Update texts
    const checkoutPanelLabel = document.querySelector("#paymentMethodLabel");
    if (checkoutPanelLabel) checkoutPanelLabel.textContent = method === "credit_card" ? "Cartão de Crédito" : "Pix";
    
    const checkoutBrlLabel = checkoutBrl?.previousElementSibling;
    if (checkoutBrlLabel) checkoutBrlLabel.textContent = method === "credit_card" ? "Total no Cartão" : "Total no Pix";
    
    currentOrderId = null; // Force new order with new rate
    setPayButtonMode("start");
  };

  document.querySelectorAll('input[name="paymentMethod"]').forEach(el => {
    el.addEventListener('change', updateRateDisplay);
  });

  let currentOrderId = null;
  let currentPixGenerated = false;
  let paymentPollTimer = null;
  const paymentIcon =
    '<svg viewBox="0 0 576 512" class="svgIcon" aria-hidden="true"><path d="M512 80c8.8 0 16 7.2 16 16v32H48V96c0-8.8 7.2-16 16-16H512zm16 144V416c0 8.8-7.2 16-16 16H64c-8.8 0-16-7.2-16-16V224H528zM64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64H512c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zm56 304c-13.3 0-24 10.7-24 24s10.7 24 24 24h48c13.3 0 24-10.7 24-24s-10.7-24-24-24H120zm128 0c-13.3 0-24 10.7-24 24s10.7 24 24 24H360c13.3 0 24-10.7 24-24s-10.7-24-24-24H248z"></path></svg>';

  const setPayButtonMode = (mode) => {
    if (!payButton) return;
    const method = document.querySelector('input[name="paymentMethod"]:checked')?.value || "pix";
    let label = "Gerar Pix";
    if (mode === "check") {
      label = "Verificar pagamento";
    } else if (method === "credit_card") {
      label = "Ir para o Pagamento";
    }
    payButton.innerHTML = `${label} ${paymentIcon}`;
  };

  const resetPixState = () => {
    currentOrderId = null;
    currentPixGenerated = false;
    if (paymentPollTimer) {
      window.clearInterval(paymentPollTimer);
      paymentPollTimer = null;
    }
    if (pixResult) pixResult.hidden = true;
    if (pixCopyCode) pixCopyCode.value = "";
    if (pixQrImage) {
      pixQrImage.hidden = true;
      pixQrImage.removeAttribute("src");
    }
    if (pixStatus) pixStatus.textContent = "Aguardando pagamento.";
    setPayButtonMode("generate");
  };

  const { data: profile } =
    supabaseClient && user
      ? await supabaseClient
          .from("user_profiles")
          .select("default_vigorbuy_id, default_vigorbuy_email")
          .eq("user_id", user.id)
          .maybeSingle()
      : { data: null };

  if (profile?.default_vigorbuy_id) vigorId.value = profile.default_vigorbuy_id;
  if (profile?.default_vigorbuy_email) vigorEmail.value = profile.default_vigorbuy_email;

  const normalizeAmount = () => Number(String(amount.value).replace(",", "."));
  const getCnyAmount = () => Number((Math.round(normalizeAmount() * exchangeRate * 100) / 100).toFixed(2));

  const setError = (field, message) => {
    const error = document.querySelector(`[data-error-for="${field}"]`);
    if (error) error.textContent = message;
  };

  const clearErrors = () => {
    ["vigorId", "vigorEmail", "amount", "terms"].forEach((field) => setError(field, ""));
  };

  const updateSummary = () => {
    const brlValue = normalizeAmount();
    const cnyValue = getCnyAmount();
    const brlText = Number.isFinite(brlValue) && brlValue > 0 ? currency.format(brlValue) : "R$ 0,00";
    const cnyText = Number.isFinite(cnyValue) && cnyValue > 0 ? `¥ ${formatCny(cnyValue)}` : "¥ 0,00";

    summaryId.textContent = vigorId.value.trim() || "Aguardando";
    summaryEmail.textContent = vigorEmail.value.trim() || "Aguardando";
    summaryAmount.textContent = brlText;
    summaryCny.textContent = cnyText;
    pixAmount.textContent = brlText;
    receiveAmount.textContent = cnyText;
    checkoutAccount.textContent = summaryId.textContent;
    checkoutEmail.textContent = summaryEmail.textContent;
    checkoutBrl.textContent = brlText;
    checkoutCny.textContent = cnyText;
    if (checkoutPixAmount) checkoutPixAmount.textContent = brlText;
  };

  await loadExchangeRate();

  const validateQuote = () => {
    const amountValue = normalizeAmount();

    if (!Number.isFinite(amountValue) || amountValue < 15) {
      showToast("O valor mínimo de recarga é R$ 15,00.");
      return false;
    }

    return true;
  };

  const validateForm = () => {
    clearErrors();
    let isValid = true;

    if (vigorId.value.trim().length < 4) {
      setError("vigorId", "Informe o ID VigorBuy do usuário.");
      isValid = false;
    }

    if (!vigorEmail.validity.valid || vigorEmail.value.trim().length < 6) {
      setError("vigorEmail", "Informe o e-mail da conta VigorBuy.");
      isValid = false;
    }

    if (!Number.isFinite(normalizeAmount()) || normalizeAmount() < 15) {
      setError("amount", "O valor mínimo de recarga é R$ 15,00.");
      isValid = false;
    }

    if (!terms.checked) {
      setError("terms", "Confirme os dados antes de enviar.");
      isValid = false;
    }

    return isValid;
  };

  const showPaidAnimation = () => {
    paymentBackdrop.classList.remove("is-hiding");
    paymentBackdrop.classList.add("is-visible");
    paymentSuccess.classList.remove("is-hiding");
    paymentSuccess.classList.add("is-visible");
    paymentSuccess.setAttribute("aria-hidden", "false");

    window.setTimeout(() => {
      paymentBackdrop.classList.add("is-hiding");
      paymentSuccess.classList.add("is-hiding");
      paymentSuccess.setAttribute("aria-hidden", "true");
    }, 4200);

    window.setTimeout(() => {
      paymentBackdrop.classList.remove("is-visible", "is-hiding");
      paymentSuccess.classList.remove("is-visible", "is-hiding");
    }, 4900);
  };

  const createRechargeOrder = async () => {
    const activeUser = user || (await getSessionUser());
    if (!activeUser) {
      throw new Error("Entre na sua conta antes de gerar o Pix.");
    }

    const brlValue = normalizeAmount();
    const cnyValue = getCnyAmount();
    const orderPayload = {
      vigorbuyId: vigorId.value.trim(),
      vigorbuyEmail: vigorEmail.value.trim(),
      brlAmount: brlValue,
      exchangeRate,
      cnyAmount: cnyValue,
    };

    try {
      const localData = await callLocalApi("/api/recharge-orders", orderPayload);
      if (localData?.order) {
        currentOrderId = localData.order.id;
        return localData.order;
      }
    } catch {
      // Continua com Edge Function/fallback direto quando o backend local nao estiver rodando.
    }

    const { data, error } = await supabaseClient.functions.invoke("create-recharge-order", {
      body: orderPayload,
    });

    if (!error && !data?.error && data?.order) {
      const order = data.order;
      currentOrderId = order.id;
      return order;
    }

    const protocol = `RVBR-${Date.now().toString().slice(-6)}`;
    const { data: order, error: orderError } = await supabaseClient
      .from("recharge_orders")
      .insert({
        user_id: activeUser.id,
        protocol,
        vigorbuy_id: vigorId.value.trim(),
        vigorbuy_email: vigorEmail.value.trim(),
        brl_amount: brlValue,
        exchange_rate: exchangeRate,
        cny_amount: cnyValue,
        status: "waiting_payment",
        quote_snapshot: {
          from: "BRL",
          to: "CNY",
          brl_amount: brlValue,
          cny_amount: cnyValue,
          exchange_rate: exchangeRate,
        },
      })
      .select()
      .single();

    if (orderError) {
      throw new Error(getApiErrorMessage(orderError, data || error, "Nao foi possivel criar a recarga."));
    }

    const { error: paymentError } = await supabaseClient.from("payments").insert({
      recharge_order_id: order.id,
      user_id: activeUser.id,
      provider: "pix",
      amount_brl: brlValue,
      status: "pending",
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    if (paymentError) {
      throw new Error(getApiErrorMessage(paymentError, null, "Nao foi possivel preparar o pagamento."));
    }

    currentOrderId = order.id;
    return order;
  };

  const renderPix = (pixData) => {
    pixResult.hidden = false;
    pixCopyCode.value = pixData.pix_code || "";

    if (pixData.pix_qr_code_base64) {
      const base64 = String(pixData.pix_qr_code_base64);
      pixQrImage.src = base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
      pixQrImage.hidden = false;
    } else {
      pixQrImage.hidden = true;
    }

    pixStatus.textContent = "Pix gerado. Aguardando pagamento.";
    currentPixGenerated = true;
    setPayButtonMode("check");
  };

  const generatePix = async () => {
    const order = currentOrderId ? { id: currentOrderId } : await createRechargeOrder();
    currentOrderId = order.id;

    const paymentMethodInput = document.querySelector('input[name="paymentMethod"]:checked');
    const paymentMethod = paymentMethodInput ? paymentMethodInput.value : "pix";

    try {
      const localData = await callLocalApi("/api/syncpay/cashin", { orderId: order.id, method: paymentMethod });
      
      if (paymentMethod === "credit_card" && localData.init_point) {
        showLoadingAndGo(localData.init_point, 0);
        return order.id;
      }
      
      renderPix(localData);
      showToast("Pix gerado. Use o QR Code ou Pix copia e cola.");
      return order.id;
    } catch (localError) {
      if (localError?.status && localError.status !== 404) throw localError;
    }

    const { data, error } = await supabaseClient.functions.invoke("syncpay-cashin", {
      body: { orderId: order.id, method: paymentMethod },
    });

    if (error || data?.error) {
      throw new Error(getApiErrorMessage(data, error, "Erro ao gerar pagamento."));
    }

    if (paymentMethod === "credit_card" && data.init_point) {
      showLoadingAndGo(data.init_point, 0);
      return order.id;
    }

    renderPix(data);
    showToast("Pix gerado. Use o QR Code ou Pix copia e cola.");
    return order.id;
  };

  const checkPaymentStatus = async (orderId, { silent = false } = {}) => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { data, error } = await supabaseClient.functions.invoke("syncpay-check-payment", {
        body: { orderId },
      });

      if (!error && data?.confirmed) {
        showPaidAnimation();
        showToast(`Pagamento aprovado. Protocolo ${data.protocol}.`);
        return true;
      }

      if (pixStatus) pixStatus.textContent = "Aguardando pagamento...";

      await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }

    showToast("Pagamento criado. Aguardando confirmacao do Pix.");
    return false;
  };

  const pollPaymentStatus = checkPaymentStatus;

  const isRechargeCompleted = (data) => data?.status === "completed" || data?.transfer?.completed;

  const checkPaymentStatusOnce = async (orderId, { silent = false } = {}) => {
    try {
      const localData = await callLocalApi("/api/syncpay/check-payment", { orderId });
      if (localData?.confirmed) {
        if (paymentPollTimer) {
          window.clearInterval(paymentPollTimer);
          paymentPollTimer = null;
        }

        if (isRechargeCompleted(localData)) {
          if (pixStatus) pixStatus.textContent = `Recarga concluida. Protocolo ${localData.protocol}.`;
          showPaidAnimation();
          showToast(`Recarga efetuada. Protocolo ${localData.protocol}.`);
          return true;
        }

        const transferError = localData.transfer?.error;
        if (pixStatus) pixStatus.textContent = transferError ? `Pagamento aprovado. Envio CNY pendente: ${transferError}` : "Pagamento aprovado. Envio CNY em processamento.";
        if (!silent) showToast("Pagamento aprovado. A recarga ainda esta sendo enviada.");
        return false;
      }

      if (pixStatus) pixStatus.textContent = "Aguardando pagamento Pix...";
      if (!silent) showToast("Pagamento ainda nao identificado.");
      return false;
    } catch (localError) {
      if (localError?.status && localError.status !== 404) throw localError;
    }

    const { data, error } = await supabaseClient.functions.invoke("syncpay-check-payment", {
      body: { orderId },
    });

    if (error || data?.error) {
      throw new Error(getApiErrorMessage(data, error, "Nao foi possivel verificar o pagamento."));
    }

    if (data?.confirmed) {
      if (paymentPollTimer) {
        window.clearInterval(paymentPollTimer);
        paymentPollTimer = null;
      }

      if (isRechargeCompleted(data)) {
        if (pixStatus) pixStatus.textContent = `Recarga concluida. Protocolo ${data.protocol}.`;
        showPaidAnimation();
        showToast(`Recarga efetuada. Protocolo ${data.protocol}.`);
        return true;
      }

      if (pixStatus) pixStatus.textContent = "Pagamento aprovado. Envio CNY em processamento.";
      if (!silent) showToast("Pagamento aprovado. A recarga ainda esta sendo enviada.");
      return false;
    }

    if (pixStatus) pixStatus.textContent = "Aguardando pagamento Pix...";
    if (!silent) showToast("Pagamento ainda nao identificado.");
    return false;
  };

  const startPaymentPolling = (orderId) => {
    if (paymentPollTimer) window.clearInterval(paymentPollTimer);
    paymentPollTimer = window.setInterval(async () => {
      try {
        await checkPaymentStatusOnce(orderId, { silent: true });
      } catch {
        if (pixStatus) pixStatus.textContent = "Aguardando pagamento Pix...";
      }
    }, 5000);
  };

  amountButtons.forEach((button) => {
    button.addEventListener("click", () => {
      amountButtons.forEach((item) => item.classList.remove("is-active"));
      button.classList.add("is-active");
      amount.value = button.dataset.amount;
      resetPixState();
      updateSummary();
    });
  });

  const paymentMethodRadios = document.querySelectorAll('input[name="paymentMethod"]');
  const paymentMethodLabel = document.querySelector("#paymentMethodLabel");

  paymentMethodRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const method = document.querySelector('input[name="paymentMethod"]:checked').value;
      if (method === "credit_card") {
        if (paymentMethodLabel) paymentMethodLabel.textContent = "Cartão de Crédito";
      } else {
        if (paymentMethodLabel) paymentMethodLabel.textContent = "Pix";
      }
      resetPixState();
    });
  });

  [vigorId, vigorEmail, amount].forEach((input) => {
    input.addEventListener("input", () => {
      resetPixState();
      if (input === amount) {
        amountButtons.forEach((button) => {
          button.classList.toggle("is-active", Number(button.dataset.amount) === normalizeAmount());
        });
      }

      updateSummary();
    });
  });

  continueButton.addEventListener("click", () => {
    if (!validateQuote()) return;

    quoteStep.classList.remove("is-active");
    detailsStep.classList.add("is-active");
    checkoutStep.classList.remove("is-active");
    detailsStep.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => vigorId.focus({ preventScroll: true }), 260);
    updateSummary();
  });

  backButton.addEventListener("click", () => {
    detailsStep.classList.remove("is-active");
    checkoutStep.classList.remove("is-active");
    quoteStep.classList.add("is-active");
    quoteStep.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => amount.focus({ preventScroll: true }), 260);
  });

  backToDetailsButton.addEventListener("click", () => {
    checkoutStep.classList.remove("is-active");
    detailsStep.classList.add("is-active");
    detailsStep.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => vigorEmail.focus({ preventScroll: true }), 260);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!validateForm()) {
      showToast("Revise os campos antes de continuar.");
      return;
    }

    submitButton.classList.add("is-loading");
    statusBox.textContent = "Pronto para pagamento.";

    await new Promise((resolve) => window.setTimeout(resolve, 450));

    submitButton.classList.remove("is-loading");
    detailsStep.classList.remove("is-active");
    checkoutStep.classList.add("is-active");
    checkoutStep.scrollIntoView({ behavior: "smooth", block: "start" });
    updateSummary();
  });

  const legacyPayClickDisabled = async () => {
    payButton.classList.add("is-loading");
    showToast(currentOrderId ? "Verificando pagamento..." : "Criando pagamento Pix...");

    try {
      const order = currentOrderId ? { id: currentOrderId } : await createRechargeOrder();
      currentOrderId = order.id;

      if (!pixCopyCode.value) {
        const { data, error } = await supabaseClient.functions.invoke("syncpay-cashin", {
          body: { orderId: order.id },
        });

        if (error || data?.error) {
          throw new Error(data?.error || error?.message || "Erro ao gerar Pix.");
        }

        renderPix(data);
      }

      payButton.textContent = "Verificar pagamento";
      payButton.insertAdjacentHTML(
        "beforeend",
        '<svg viewBox="0 0 576 512" class="svgIcon" aria-hidden="true"><path d="M512 80c8.8 0 16 7.2 16 16v32H48V96c0-8.8 7.2-16 16-16H512zm16 144V416c0 8.8-7.2 16-16 16H64c-8.8 0-16-7.2-16-16V224H528zM64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64H512c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zm56 304c-13.3 0-24 10.7-24 24s10.7 24 24 24h48c13.3 0 24-10.7 24-24s-10.7-24-24-24H120zm128 0c-13.3 0-24 10.7-24 24s10.7 24 24 24H360c13.3 0 24-10.7 24-24s-10.7-24-24-24H248z"></path></svg>'
      );

      showToast("Pix gerado. Aguardando confirmacao.");
      await pollPaymentStatus(order.id);
    } catch (error) {
      showToast(error.message || "Nao foi possivel criar o pagamento.");
    } finally {
      payButton.classList.remove("is-loading");
    }
  };

  copyPixButton.addEventListener("click", async () => {
    if (!pixCopyCode.value) return;
    await navigator.clipboard.writeText(pixCopyCode.value);
    showToast("Codigo Pix copiado.");
  });

  const legacyCheckClickDisabled = async () => {
    if (!currentOrderId) return;
    checkPaymentButton.classList.add("is-loading");
    await pollPaymentStatus(currentOrderId);
    checkPaymentButton.classList.remove("is-loading");
  };

  payButton.addEventListener(
    "click",
    async (event) => {
      event.stopImmediatePropagation();
      payButton.classList.add("is-loading");

      try {
        if (!currentPixGenerated) {
          showToast("Gerando Pix...");
          const orderId = await generatePix();
          startPaymentPolling(orderId);
          return;
        }

        showToast("Verificando pagamento...");
        await checkPaymentStatusOnce(currentOrderId);
      } catch (error) {
        showToast(error.message || "Nao foi possivel criar o pagamento.");
      } finally {
        payButton.classList.remove("is-loading");
      }
    },
    true
  );

  checkPaymentButton.addEventListener(
    "click",
    async (event) => {
      event.stopImmediatePropagation();
      if (!currentOrderId) return;
      checkPaymentButton.classList.add("is-loading");

      try {
        await checkPaymentStatusOnce(currentOrderId);
      } catch (error) {
        showToast(error.message || "Nao foi possivel verificar o pagamento.");
      } finally {
        checkPaymentButton.classList.remove("is-loading");
      }
    },
    true
  );

  setPayButtonMode("generate");
  updateSummary();
};

const initHistory = async (user) => {
  const list = document.querySelector(".history-list");
  if (!list || !user) return;

  const params = new URLSearchParams(window.location.search);
  const paymentId = params.get('payment_id');
  const externalReference = params.get('external_reference');

  if (paymentId && externalReference) {
    try {
      showToast("Sincronizando pagamento do cartão...");
      await callLocalApi("/api/syncpay/check-payment", { orderId: externalReference, payment_id: paymentId });
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) {
      try {
        await supabaseClient.functions.invoke("syncpay-check-payment", {
          body: { orderId: externalReference, payment_id: paymentId },
        });
      } catch (err) {}
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }

  const historyWallet = document.querySelector(".history-wallet");
  const walletLastAmount = document.querySelector("#walletLastAmount");
  const walletLastId = document.querySelector("#walletLastId");
  const walletLastProtocol = document.querySelector("#walletLastProtocol");
  const historyTotal = document.querySelector("#historyTotal");
  const historyLastCny = document.querySelector("#historyLastCny");
  const historyCount = document.querySelector("#historyCount");

  if (historyWallet) {
    historyWallet.addEventListener("click", () => {
      if (!window.matchMedia("(pointer: coarse)").matches) return;
      historyWallet.classList.toggle("is-open");
    });
  }

  const { data, error } = await supabaseClient
    .from("recharge_orders")
    .select("protocol, vigorbuy_id, vigorbuy_email, brl_amount, cny_amount, status, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(20);

  list.querySelectorAll(".history-row").forEach((row) => row.remove());

  if (error) {
    showToast(error.message);
    return;
  }

  const rows = data || [];

  if (!rows.length) {
    walletLastAmount.textContent = "R$ 0,00";
    walletLastId.textContent = "Sem recarga";
    walletLastProtocol.textContent = "RVBR";
    historyTotal.textContent = "R$ 0,00";
    historyLastCny.textContent = "¥ 0,00";
    historyCount.textContent = "0";
    list.insertAdjacentHTML(
      "beforeend",
      `<article class="history-row"><span class="status status-pending">Vazio</span><div><strong>Nenhuma recarga ainda</strong><p>Faça sua primeira recarga para aparecer aqui.</p></div><div class="history-values"><strong>R$ 0,00</strong><p>¥ 0,00</p></div><span>--</span></article>`
    );
    return;
  }

  const latest = rows[0];
  const total = rows.reduce((sum, item) => sum + (Number(item.brl_amount) || 0), 0);

  walletLastAmount.textContent = currency.format(Number(latest.brl_amount) || 0);
  walletLastId.textContent = latest.vigorbuy_id || "Conta";
  walletLastProtocol.textContent = latest.protocol || "RVBR";
  historyTotal.textContent = currency.format(total);
  historyLastCny.textContent = `¥ ${formatCny(latest.cny_amount)}`;
  historyCount.textContent = String(rows.length);

  const markup = rows
    .map((item) => {
      const statusLabel = mapRechargeStatus(item.status);
      const statusClass = isDoneStatus(item.status) ? "status-done" : "status-pending";
      const date = new Date(item.created_at).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      return `
        <article class="history-row">
          <span class="status ${statusClass}">${escapeHtml(statusLabel)}</span>
          <div>
            <strong>Recarga para ${escapeHtml(item.vigorbuy_id)}</strong>
            <p>${escapeHtml(date)} · ${escapeHtml(item.vigorbuy_email)}</p>
          </div>
          <div class="history-values">
            <strong>${currency.format(Number(item.brl_amount) || 0)}</strong>
            <p>¥ ${formatCny(item.cny_amount)}</p>
          </div>
          <span>${escapeHtml(item.protocol)}</span>
        </article>
      `;
    })
    .join("");

  list.insertAdjacentHTML("beforeend", markup);
};

const initSupport = () => {
  const form = document.querySelector("#supportForm");
  if (!form) return;

  const button = form.querySelector(".submit-button");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.classList.add("is-loading");
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    button.classList.remove("is-loading");
    form.reset();
    showToast("Mensagem enviada para o suporte.");
  });
};

const initSettings = async (user) => {
  const form = document.querySelector("#settingsForm");
  if (!form || !user) return;

  const button = form.querySelector(".submit-button");
  const nameInput = form.querySelector('[name="name"]');
  const emailInput = form.querySelector('[name="email"]');
  const defaultIdInput = form.querySelector('[name="defaultId"]');
  const alertInput = form.querySelectorAll('input[type="checkbox"]')[0];
  const saveLastInput = form.querySelectorAll('input[type="checkbox"]')[1];
  const referralCode = document.querySelector("#referralCode");
  const referralProgressText = document.querySelector("#referralProgressText");
  const referralProgressBar = document.querySelector("#referralProgressBar");
  const referralReward = document.querySelector("#referralReward");

  const [{ data: profile }, { data: userRow }, { count: referralCount }, { data: rewardRow }] = await Promise.all([
    supabaseClient
      .from("user_profiles")
      .select("default_vigorbuy_id, default_vigorbuy_email, receive_recharge_alerts, save_last_vigorbuy_id")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabaseClient.from("users").select("name, email, referral_code").eq("id", user.id).maybeSingle(),
    supabaseClient
      .from("referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_user_id", user.id)
      .not("qualified_at", "is", null),
    supabaseClient
      .from("referral_rewards")
      .select("required_referrals, reward_cny, status")
      .eq("user_id", user.id)
      .order("required_referrals", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  nameInput.value = userRow?.name || user.user_metadata?.name || "";
  emailInput.value = userRow?.email || user.email || "";
  defaultIdInput.value = profile?.default_vigorbuy_id || "";
  alertInput.checked = profile?.receive_recharge_alerts ?? true;
  saveLastInput.checked = profile?.save_last_vigorbuy_id ?? true;

  const requiredReferrals = rewardRow?.required_referrals || 20;
  const rewardCny = rewardRow?.reward_cny || 130;
  const currentReferrals = referralCount || 0;
  const progress = Math.min(100, Math.round((currentReferrals / requiredReferrals) * 100));

  referralCode.textContent = userRow?.referral_code || "--";
  referralProgressText.textContent = `${currentReferrals} de ${requiredReferrals} indicações`;
  referralProgressBar.style.width = `${progress}%`;
  referralReward.textContent = `¥ ${formatCny(rewardCny)} CNY`;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.classList.add("is-loading");

    const { error: userError } = await supabaseClient
      .from("users")
      .update({ name: nameInput.value.trim() || null })
      .eq("id", user.id);

    const { error: profileError } = await supabaseClient.from("user_profiles").upsert(
      {
        user_id: user.id,
        default_vigorbuy_id: defaultIdInput.value.trim() || null,
        default_vigorbuy_email: emailInput.value.trim() || null,
        receive_recharge_alerts: alertInput.checked,
        save_last_vigorbuy_id: saveLastInput.checked,
      },
      { onConflict: "user_id" }
    );

    button.classList.remove("is-loading");

    if (userError || profileError) {
      showToast(userError?.message || profileError?.message || "Erro ao salvar configurações.");
      return;
    }

    showToast("Configurações salvas.");
  });
};

const boot = async () => {
  try {
    initRevealAnimations();
    initLogin();
    initDockNavigation();

    const user = await requireUser();
    await initRecharge(user);
    await initHistory(user);
    await initSettings(user);
    initSupport();
  } catch (error) {
    showToast(error.message || "Nao foi possivel carregar a pagina.");
  }
};

boot();
