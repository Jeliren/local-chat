const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginUsernameInput = document.getElementById("login-username");
const loginPasswordInput = document.getElementById("login-password");
const loginHint = document.getElementById("login-hint");
const loginError = document.getElementById("login-error");
const currentUserLabel = document.getElementById("current-user");
const logoutButton = document.getElementById("logout-button");
const recipientSelect = document.getElementById("recipient-select");
const userList = document.getElementById("user-list");
const messagesContainer = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const fileForm = document.getElementById("file-form");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const statusPill = document.getElementById("status-pill");
const serverUrl = document.getElementById("server-url");
const emptyStateTemplate = document.getElementById("empty-state-template");

const savedUsername = localStorage.getItem("local-chat-username");
let currentUser = "";
let lastMessageId = 0;
let isInitialLoad = true;
let pollTimer = null;

if (savedUsername) {
  loginUsernameInput.value = savedUsername;
}

loginUsernameInput.addEventListener("input", () => {
  localStorage.setItem("local-chat-username", loginUsernameInput.value.trim());
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideLoginError();

  const username = loginUsernameInput.value.trim();
  const password = loginPasswordInput.value;
  if (!username) {
    loginUsernameInput.focus();
    return;
  }
  if (!password) {
    loginPasswordInput.focus();
    return;
  }

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      showLoginError(data.error || "Не удалось войти.");
      return;
    }

    localStorage.setItem("local-chat-username", username);
    loginPasswordInput.value = "";
    applySession(data);
    await resetAndLoadMessages();
    ensurePolling();
  } catch (error) {
    showLoginError("Сервер не отвечает.");
  }
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  stopPolling();
  currentUser = "";
  showAuth();
});

fileInput.addEventListener("change", () => {
  const selected = fileInput.files && fileInput.files[0];
  fileName.textContent = selected ? selected.name : "Файл не выбран";
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) {
    messageInput.focus();
    return;
  }

  const response = await fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, recipient: recipientSelect.value || null }),
  });

  if (response.status === 401) {
    handleUnauthorized();
    return;
  }

  messageInput.value = "";
  await loadMessages();
});

fileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const selectedFile = fileInput.files && fileInput.files[0];
  if (!selectedFile) {
    fileInput.click();
    return;
  }

  const formData = new FormData();
  formData.append("file", selectedFile);
  formData.append("recipient", recipientSelect.value || "");

  const response = await fetch("/api/files", {
    method: "POST",
    body: formData,
  });

  if (response.status === 401) {
    handleUnauthorized();
    return;
  }

  fileForm.reset();
  fileName.textContent = "Файл не выбран";
  await loadMessages();
});

async function boot() {
  await loadInfo();
  await restoreSession();
}

async function restoreSession() {
  try {
    const response = await fetch("/api/session");
    const data = await response.json();
    if (!data.authenticated) {
      showAuth();
      return;
    }

    applySession(data);
    await resetAndLoadMessages();
    ensurePolling();
  } catch (error) {
    showAuth();
  }
}

async function loadInfo() {
  try {
    const response = await fetch("/api/info");
    const data = await response.json();
    serverUrl.textContent = data.lan_url;
  } catch (error) {
    serverUrl.textContent = "Не удалось определить адрес";
  }
}

async function resetAndLoadMessages() {
  lastMessageId = 0;
  isInitialLoad = true;
  messagesContainer.innerHTML = "";
  await loadMessages();
}

async function loadMessages() {
  try {
    const response = await fetch(`/api/messages?after=${lastMessageId}`);
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    const data = await response.json();
    const messages = data.messages || [];
    updateUsers(data.users || []);

    if (isInitialLoad) {
      messagesContainer.innerHTML = "";
      if (messages.length === 0) {
        messagesContainer.appendChild(emptyStateTemplate.content.cloneNode(true));
      }
    } else if (messages.length > 0) {
      const emptyState = messagesContainer.querySelector(".empty-state");
      if (emptyState) {
        emptyState.remove();
      }
    }

    for (const message of messages) {
      renderMessage(message);
      lastMessageId = Math.max(lastMessageId, message.id);
    }

    if (messages.length > 0 || isInitialLoad) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    isInitialLoad = false;
    statusPill.textContent = "На связи";
  } catch (error) {
    statusPill.textContent = "Нет ответа";
  }
}

function renderMessage(message) {
  const article = document.createElement("article");
  article.className = `message ${message.user === currentUser ? "self" : "other"}`;

  const header = document.createElement("div");
  header.className = "message-header";

  const user = document.createElement("span");
  user.className = "message-user";
  user.textContent = message.user;

  const meta = document.createElement("div");
  meta.className = "message-meta";

  if (message.is_private) {
    const badge = document.createElement("span");
    badge.className = "privacy-badge";
    badge.textContent =
      message.user === currentUser
        ? `Личное -> ${message.recipient}`
        : `Личное <- ${message.user}`;
    meta.appendChild(badge);
  } else {
    const badge = document.createElement("span");
    badge.className = "privacy-badge public";
    badge.textContent = "Общий чат";
    meta.appendChild(badge);
  }

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = formatTime(message.created_at);
  meta.appendChild(time);

  header.append(user, meta);
  article.appendChild(header);

  if (message.type === "file") {
    const link = document.createElement("a");
    link.className = "file-link";
    link.href = message.download_url;
    link.textContent = `${message.filename} (${formatBytes(message.size)})`;
    article.appendChild(link);
  } else {
    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text;
    article.appendChild(text);
  }

  messagesContainer.appendChild(article);
}

function updateUsers(users) {
  const uniqueUsers = users.filter((user, index) => users.indexOf(user) === index);
  const currentSelection = recipientSelect.value;

  recipientSelect.innerHTML = "";
  recipientSelect.append(new Option("Общий чат", ""));
  for (const user of uniqueUsers) {
    if (user === currentUser) continue;
    recipientSelect.append(new Option(user, user));
  }

  if ([...recipientSelect.options].some((option) => option.value === currentSelection)) {
    recipientSelect.value = currentSelection;
  }

  userList.innerHTML = "";
  for (const user of uniqueUsers) {
    const item = document.createElement("li");
    item.className = "user-list-item";
    item.textContent = user === currentUser ? `${user} (вы)` : user;
    userList.appendChild(item);
  }
}

function applySession(session) {
  currentUser = session.user;
  currentUserLabel.textContent = session.user;
  updateUsers(session.users || []);
  showApp();
}

function showAuth() {
  authScreen.classList.remove("is-hidden");
  appShell.classList.add("is-hidden");
  statusPill.textContent = "Нужен вход";
}

function showApp() {
  authScreen.classList.add("is-hidden");
  appShell.classList.remove("is-hidden");
}

function showLoginError(text) {
  loginError.hidden = false;
  loginError.textContent = text;
}

function hideLoginError() {
  loginError.hidden = true;
  loginError.textContent = "";
}

function handleUnauthorized() {
  stopPolling();
  showAuth();
  showLoginError("Сессия истекла. Войдите снова.");
}

function ensurePolling() {
  stopPolling();
  pollTimer = window.setInterval(loadMessages, 2000);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function formatTime(iso) {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

boot();
