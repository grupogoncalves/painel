import { initializeApp } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.8.1/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  update,
  push,
  onValue,
  get,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.8.1/firebase-database.js";

const config = window.SDR_CONFIG || {};
const hasConfig = config.apiKey && !config.apiKey.includes("COLE_SUA") && config.databaseURL && !config.databaseURL.includes("SEU_PROJETO");

const app = hasConfig ? initializeApp(config) : null;
const auth = app ? getAuth(app) : null;
const db = app ? getDatabase(app) : null;

const $ = (id) => document.getElementById(id);
const views = {
  auth: $("authView"),
  blocked: $("blockedView"),
  dashboard: $("dashboardView"),
  newLead: $("newLeadView"),
  operators: $("operatorsView")
};

let currentUser = null;
let currentProfile = null;
let leadsCache = [];
let usersCache = [];
let leadsUnsubscribe = null;
let usersUnsubscribe = null;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3400);
}

function showView(name) {
  Object.values(views).forEach((view) => view.hidden = true);
  views[name].hidden = false;
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
}

function setLoggedLayout(isLogged) {
  $("navArea").hidden = !isLogged;
  $("userBox").hidden = !isLogged;
  if (isLogged) {
    $("currentUserName").textContent = currentProfile?.name || currentUser?.email || "Operador";
  }
}

function normalize(str = "") {
  return String(str).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function money(value) {
  if (!value) return "-";
  const clean = String(value).replace(/[^\d,.]/g, "");
  return clean ? `R$ ${clean}` : value;
}

function dateLabel(value) {
  if (!value) return "Agora";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "Agora";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function badgeClass(status) {
  if (["Perdido", "Sem perfil"].includes(status)) return "danger";
  if (["Agendar consultor", "Agendado"].includes(status)) return "warning";
  return "";
}

function userIsAdmin() {
  return currentProfile?.role === "admin";
}

function applyAdminVisibility() {
  document.querySelectorAll("[data-admin-only]").forEach((el) => el.hidden = !userIsAdmin());
}

function generateSummary(data) {
  const parts = [];
  if (data.nome) parts.push(`Lead ${data.nome}`);
  if (data.cidade || data.bairro) parts.push(`localizado em ${[data.bairro, data.cidade].filter(Boolean).join(", ")}`);
  if (data.contaLuz) parts.push(`com conta média de ${money(data.contaLuz)}`);
  if (data.tipoImovel) parts.push(`imóvel ${data.tipoImovel.toLowerCase()}`);
  if (data.propriedade) parts.push(`${data.propriedade.toLowerCase()}`);
  if (data.telhado) parts.push(`telhado ${data.telhado.toLowerCase()}`);
  if (data.melhorHorario) parts.push(`prefere atendimento em ${data.melhorHorario}`);
  if (!parts.length) return "Lead cadastrado para qualificação SDR.";
  return `${parts.join(", ")}. Próximo passo sugerido: confirmar dados técnicos e direcionar para agendamento com consultor.`;
}

function formData() {
  const data = {
    nome: $("nome").value.trim(),
    telefone: $("telefone").value.trim(),
    cidade: $("cidade").value.trim(),
    bairro: $("bairro").value.trim(),
    contaLuz: $("contaLuz").value.trim(),
    tipoImovel: $("tipoImovel").value,
    propriedade: $("propriedade").value,
    telhado: $("telhado").value,
    melhorHorario: $("melhorHorario").value.trim(),
    status: $("status").value,
    resumo: $("resumo").value.trim(),
    observacoes: $("observacoes").value.trim(),
    updatedAt: Date.now(),
    updatedBy: currentUser.uid
  };
  if (!data.resumo) data.resumo = generateSummary(data);
  return data;
}

function fillLeadForm(lead = {}) {
  $("leadId").value = lead.id || "";
  $("nome").value = lead.nome || "";
  $("telefone").value = lead.telefone || "";
  $("cidade").value = lead.cidade || "";
  $("bairro").value = lead.bairro || "";
  $("contaLuz").value = lead.contaLuz || "";
  $("tipoImovel").value = lead.tipoImovel || "";
  $("propriedade").value = lead.propriedade || "";
  $("telhado").value = lead.telhado || "";
  $("melhorHorario").value = lead.melhorHorario || "";
  $("status").value = lead.status || "Novo";
  $("resumo").value = lead.resumo || "";
  $("observacoes").value = lead.observacoes || "";
}

function renderStats() {
  $("statTotal").textContent = leadsCache.length;
  $("statNovo").textContent = leadsCache.filter(l => l.status === "Novo").length;
  $("statAgendar").textContent = leadsCache.filter(l => ["Agendar consultor", "Agendado"].includes(l.status)).length;
  $("statConvertido").textContent = leadsCache.filter(l => l.status === "Convertido").length;
}

function renderLeads() {
  renderStats();
  const q = normalize($("searchInput").value);
  const status = $("statusFilter").value;
  const list = $("leadList");

  const filtered = leadsCache.filter((lead) => {
    const hay = normalize([lead.nome, lead.telefone, lead.cidade, lead.bairro, lead.contaLuz, lead.resumo].join(" "));
    return (!q || hay.includes(q)) && (!status || lead.status === status);
  });

  if (!filtered.length) {
    list.innerHTML = `<div class="empty">Nenhum lead encontrado.</div>`;
    return;
  }

  list.innerHTML = filtered.map((lead) => `
    <article class="lead-card">
      <div class="lead-head">
        <div>
          <h3>${escapeHtml(lead.nome || "Lead sem nome")}</h3>
          <div class="lead-meta">
            <span>${escapeHtml(lead.telefone || "Sem telefone")}</span>
            <span>${escapeHtml([lead.bairro, lead.cidade].filter(Boolean).join(" - ") || "Sem cidade")}</span>
            <span>${dateLabel(lead.createdAt)}</span>
          </div>
        </div>
        <span class="badge ${badgeClass(lead.status)}">${escapeHtml(lead.status || "Novo")}</span>
      </div>
      <div class="lead-details">
        <div class="detail"><small>Conta</small><strong>${escapeHtml(money(lead.contaLuz))}</strong></div>
        <div class="detail"><small>Imóvel</small><strong>${escapeHtml(lead.tipoImovel || "-")}</strong></div>
        <div class="detail"><small>Situação</small><strong>${escapeHtml(lead.propriedade || "-")}</strong></div>
        <div class="detail"><small>Telhado</small><strong>${escapeHtml(lead.telhado || "-")}</strong></div>
      </div>
      <div class="lead-summary">${escapeHtml(lead.resumo || "Sem resumo.")}</div>
      <div class="lead-actions">
        <select data-status-select="${lead.id}">
          ${["Novo","Em atendimento","Agendar consultor","Agendado","Sem perfil","Perdido","Convertido"].map(s => `<option ${lead.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <button class="ghost" data-edit="${lead.id}">Editar</button>
        <a class="ghost" href="https://wa.me/${String(lead.telefone || "").replace(/\D/g, "")}" target="_blank" rel="noreferrer" style="text-decoration:none;display:inline-flex;align-items:center">Abrir WhatsApp</a>
      </div>
    </article>
  `).join("");

  list.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lead = leadsCache.find((item) => item.id === btn.dataset.edit);
      fillLeadForm(lead);
      showView("newLead");
    });
  });

  list.querySelectorAll("[data-status-select]").forEach((select) => {
    select.addEventListener("change", async () => {
      const leadId = select.dataset.statusSelect;
      try {
        await update(ref(db, `leads/${leadId}`), {
          status: select.value,
          updatedAt: Date.now(),
          updatedBy: currentUser.uid
        });
        await push(ref(db, "audit"), {
          action: "lead_status_updated",
          leadId,
          status: select.value,
          userId: currentUser.uid,
          createdAt: Date.now()
        });
        toast("Status atualizado.");
      } catch (error) {
        toast("Sem permissão para alterar este lead.");
        console.error(error);
      }
    });
  });
}

function renderOperators() {
  const list = $("operatorList");
  if (!usersCache.length) {
    list.innerHTML = `<div class="empty">Nenhum operador encontrado.</div>`;
    return;
  }

  list.innerHTML = usersCache.map((user) => `
    <article class="operator-card">
      <div>
        <h3 style="margin:0 0 6px">${escapeHtml(user.name || user.email || "Operador")}</h3>
        <div class="lead-meta">
          <span>${escapeHtml(user.email || "")}</span>
          <span class="badge ${user.status === "pending" ? "warning" : user.status === "blocked" ? "danger" : ""}">${escapeHtml(user.status || "pending")}</span>
          <span class="badge">${escapeHtml(user.role || "operador")}</span>
        </div>
      </div>
      <div class="operator-actions">
        <button class="ghost" data-approve="${user.id}">Aprovar</button>
        <button class="ghost" data-admin="${user.id}">Tornar admin</button>
        <button class="ghost" data-block="${user.id}">Bloquear</button>
      </div>
    </article>
  `).join("");

  list.querySelectorAll("[data-approve]").forEach((btn) => btn.addEventListener("click", () => updateOperator(btn.dataset.approve, { status: "approved", role: "operador" })));
  list.querySelectorAll("[data-admin]").forEach((btn) => btn.addEventListener("click", () => updateOperator(btn.dataset.admin, { status: "approved", role: "admin" })));
  list.querySelectorAll("[data-block]").forEach((btn) => btn.addEventListener("click", () => updateOperator(btn.dataset.block, { status: "blocked" })));
}

async function updateOperator(uid, payload) {
  try {
    await update(ref(db, `users/${uid}`), payload);
    await push(ref(db, "audit"), {
      action: "operator_updated",
      targetUserId: uid,
      payload,
      userId: currentUser.uid,
      createdAt: Date.now()
    });
    toast("Operador atualizado.");
  } catch (error) {
    toast("Não foi possível atualizar o operador.");
    console.error(error);
  }
}

function listenLeads() {
  if (leadsUnsubscribe) leadsUnsubscribe();
  leadsUnsubscribe = onValue(ref(db, "leads"), (snapshot) => {
    const data = snapshot.val() || {};
    leadsCache = Object.entries(data)
      .map(([id, lead]) => ({ id, ...lead }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderLeads();
  });
}

function listenUsers() {
  if (!userIsAdmin()) return;
  if (usersUnsubscribe) usersUnsubscribe();
  usersUnsubscribe = onValue(ref(db, "users"), (snapshot) => {
    const data = snapshot.val() || {};
    usersCache = Object.entries(data)
      .map(([id, user]) => ({ id, ...user }))
      .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    renderOperators();
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function authError(error) {
  const code = error?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Email ou senha inválidos.";
  if (code.includes("email-already-in-use")) return "Este email já possui cadastro.";
  if (code.includes("weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  if (code.includes("permission-denied")) return "Sem permissão. Confira as regras e se o usuário está aprovado.";
  return "Ocorreu um erro. Confira a configuração e tente novamente.";
}

function requireConfig() {
  if (!hasConfig) {
    toast("Preencha o arquivo config.js antes de usar o painel.");
    return false;
  }
  return true;
}

// Eventos de autenticação
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireConfig()) return;
  try {
    await signInWithEmailAndPassword(auth, $("loginEmail").value.trim(), $("loginPassword").value);
  } catch (error) {
    toast(authError(error));
    console.error(error);
  }
});

$("registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!requireConfig()) return;
  try {
    const cred = await createUserWithEmailAndPassword(auth, $("registerEmail").value.trim(), $("registerPassword").value);
    await set(ref(db, `users/${cred.user.uid}`), {
      name: $("registerName").value.trim(),
      email: cred.user.email,
      role: "operador",
      status: "pending",
      createdAt: Date.now()
    });
    toast("Acesso criado. Aguarde aprovação do administrador.");
  } catch (error) {
    toast(authError(error));
    console.error(error);
  }
});

if (hasConfig) {
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    currentProfile = null;
    if (!user) {
      setLoggedLayout(false);
      showView("auth");
      return;
    }

    const profileSnap = await get(ref(db, `users/${user.uid}`));
    currentProfile = profileSnap.val();

    if (!currentProfile) {
      await set(ref(db, `users/${user.uid}`), {
        name: user.email,
        email: user.email,
        role: "operador",
        status: "pending",
        createdAt: Date.now()
      });
      currentProfile = { name: user.email, email: user.email, role: "operador", status: "pending" };
    }

    if (currentProfile.status !== "approved") {
      setLoggedLayout(false);
      showView("blocked");
      return;
    }

    setLoggedLayout(true);
    applyAdminVisibility();
    listenLeads();
    listenUsers();
    showView("dashboard");
  });
} else {
  showView("auth");
  setTimeout(() => toast("Preencha o arquivo config.js antes de usar."), 700);
}

$("logoutBtn").addEventListener("click", () => signOut(auth));
$("blockedLogoutBtn").addEventListener("click", () => signOut(auth));

// Navegação
$("navArea").addEventListener("click", (event) => {
  const btn = event.target.closest(".nav-btn");
  if (!btn) return;
  if (btn.dataset.view === "newLead") fillLeadForm();
  showView(btn.dataset.view);
});

document.querySelectorAll("[data-open-new]").forEach((btn) => btn.addEventListener("click", () => {
  fillLeadForm();
  showView("newLead");
}));

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    const mode = btn.dataset.auth;
    $("loginForm").hidden = mode !== "login";
    $("registerForm").hidden = mode !== "register";
  });
});

$("searchInput").addEventListener("input", renderLeads);
$("statusFilter").addEventListener("change", renderLeads);

$("clearFormBtn").addEventListener("click", () => fillLeadForm());

$("leadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser) return;
  const id = $("leadId").value;
  const data = formData();
  try {
    if (id) {
      await update(ref(db, `leads/${id}`), data);
      await push(ref(db, "audit"), { action: "lead_updated", leadId: id, userId: currentUser.uid, createdAt: Date.now() });
      toast("Lead atualizado.");
    } else {
      const leadRef = push(ref(db, "leads"));
      await set(leadRef, {
        ...data,
        createdAt: Date.now(),
        createdBy: currentUser.uid,
        source: "manual"
      });
      await push(ref(db, "audit"), { action: "lead_created", leadId: leadRef.key, userId: currentUser.uid, createdAt: Date.now() });
      toast("Lead salvo.");
    }
    fillLeadForm();
    showView("dashboard");
  } catch (error) {
    toast("Não foi possível salvar. Confira permissões e aprovação do usuário.");
    console.error(error);
  }
});
