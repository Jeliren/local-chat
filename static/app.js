const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginUsernameInput = document.getElementById("login-username");
const loginPasswordInput = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const currentUserLabel = document.getElementById("current-user");
const logoutButton = document.getElementById("logout-button");
const recipientDetails = document.getElementById("recipient-details");
const recipientCurrent = document.getElementById("recipient-current");
const recipientOptions = document.getElementById("recipient-options");
const messagesContainer = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const fileForm = document.getElementById("file-form");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const emptyStateTemplate = document.getElementById("empty-state-template");

const savedUsername = localStorage.getItem("local-chat-username");
const defaultTitle = document.title;
const mobileMedia = window.matchMedia("(max-width: 640px)");

let currentUser = "";
let selectedRecipient = "";
let isInitialLoad = true;
let pollTimer = null;
let knownMessageIds = new Set();
let unseenCount = 0;
let knownUsers = [];

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
    await ensureNotificationPermission();
  } catch (error) {
    showLoginError("Сервер не отвечает.");
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch (error) {
    // Nothing else to do here; the local session is still cleared.
  }

  stopPolling();
  resetClientState();
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

  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, recipient: selectedRecipient || null }),
    });

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) {
      return;
    }

    messageInput.value = "";
    await loadMessages({ forceScroll: true });
  } catch (error) {
    // The next poll will retry.
  }
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
  formData.append("recipient", selectedRecipient);

  try {
    const response = await fetch("/api/files", {
      method: "POST",
      body: formData,
    });

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) {
      return;
    }

    fileForm.reset();
    fileName.textContent = "Файл не выбран";
    await loadMessages({ forceScroll: true });
  } catch (error) {
    // The next poll will retry.
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    resetUnreadNotifications();
  }
});

window.addEventListener("focus", resetUnreadNotifications);

if (typeof mobileMedia.addEventListener === "function") {
  mobileMedia.addEventListener("change", syncRecipientAccordion);
} else {
  mobileMedia.addListener(syncRecipientAccordion);
}

async function boot() {
  syncRecipientAccordion();
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
    await ensureNotificationPermission();
  } catch (error) {
    showAuth();
  }
}

async function resetAndLoadMessages() {
  isInitialLoad = true;
  knownMessageIds = new Set();
  messagesContainer.innerHTML = "";
  resetUnreadNotifications();
  await loadMessages({ forceScroll: true });
}

async function loadMessages({ forceScroll = false } = {}) {
  const shouldScroll = forceScroll || isInitialLoad || isNearBottom();
  const distanceFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop;

  try {
    const response = await fetch("/api/messages");
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const previousIds = knownMessageIds;
    const newExternalMessages = isInitialLoad
      ? []
      : messages.filter((message) => !previousIds.has(message.id) && message.user !== currentUser);

    updateUsers(data.users || []);
    renderMessages(messages);

    knownMessageIds = new Set(messages.map((message) => message.id));

    if (shouldScroll) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else {
      messagesContainer.scrollTop = Math.max(messagesContainer.scrollHeight - distanceFromBottom, 0);
    }

    if (newExternalMessages.length > 0) {
      notifyAboutMessages(newExternalMessages);
    }

    isInitialLoad = false;
  } catch (error) {
    // The next poll will retry.
  }
}

function renderMessages(messages) {
  messagesContainer.innerHTML = "";

  if (messages.length === 0) {
    messagesContainer.appendChild(emptyStateTemplate.content.cloneNode(true));
    return;
  }

  for (const message of messages) {
    messagesContainer.appendChild(buildMessageElement(message));
  }
}

function buildMessageElement(message) {
  const article = document.createElement("article");
  article.className = `message ${message.user === currentUser ? "self" : "other"}`;
  article.dataset.messageId = String(message.id);

  const header = document.createElement("div");
  header.className = "message-header";

  const user = document.createElement("span");
  user.className = "message-user";
  user.textContent = message.user;

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const privacyBadge = document.createElement("span");
  privacyBadge.className = `privacy-badge ${message.is_private ? "" : "public"}`.trim();
  privacyBadge.textContent = message.is_private
    ? message.user === currentUser
      ? `Личное -> ${message.recipient}`
      : `Личное <- ${message.user}`
    : "Всем";
  meta.appendChild(privacyBadge);

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = formatTime(message.created_at);
  meta.appendChild(time);

  header.append(user, meta);
  article.appendChild(header);

  const body = document.createElement("div");
  body.className = "message-body";

  if (message.type === "file") {
    const link = document.createElement("a");
    link.className = "file-link";
    link.href = message.download_url;
    link.textContent = `${message.filename} (${formatBytes(message.size)})`;
    body.appendChild(link);
  } else {
    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message.text;
    body.appendChild(text);
  }

  const actions = document.createElement("div");
  actions.className = "message-actions";
  actions.appendChild(
    createIconButton("Скопировать", "copy", async () => {
      await copyMessage(message);
    }),
  );

  if (message.user === currentUser) {
    actions.appendChild(
      createIconButton("Удалить", "trash", async () => {
        await deleteMessage(message.id);
      }, "danger"),
    );
  }

  body.appendChild(actions);
  article.appendChild(body);

  return article;
}

function createIconButton(label, iconName, onClick, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${extraClass}`.trim();
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = getIconSvg(iconName);
  button.addEventListener("click", onClick);
  return button;
}

function getIconSvg(iconName) {
  if (iconName === "trash") {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18"></path>
        <path d="M8 6V4h8v2"></path>
        <path d="M6 6l1 14h10l1-14"></path>
        <path d="M10 10v6"></path>
        <path d="M14 10v6"></path>
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2"></rect>
      <path d="M5 15V6a2 2 0 0 1 2-2h9"></path>
    </svg>
  `;
}

function updateUsers(users) {
  knownUsers = normalizeUsers(users);
  const availableRecipients = knownUsers.filter((user) => user.name && user.name !== currentUser);
  const hasSelectedRecipient = availableRecipients.some((user) => user.name === selectedRecipient);
  if (!hasSelectedRecipient) {
    selectedRecipient = "";
  }

  recipientOptions.innerHTML = "";
  recipientOptions.appendChild(
    createRecipientOption({
      label: "Всем",
      value: "",
      selected: selectedRecipient === "",
      online: false,
    }),
  );

  for (const user of availableRecipients) {
    recipientOptions.appendChild(
      createRecipientOption({
        label: user.name,
        value: user.name,
        selected: selectedRecipient === user.name,
        online: user.online,
      }),
    );
  }

  updateRecipientSummary();
}

function normalizeUsers(users) {
  const map = new Map();

  for (const entry of users) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name) {
        map.set(name, { name, online: false });
      }
      continue;
    }

    const name = String(entry?.name || "").trim();
    if (!name) {
      continue;
    }

    const previous = map.get(name);
    map.set(name, {
      name,
      online: Boolean(entry.online) || Boolean(previous?.online),
    });
  }

  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function createRecipientOption({ label, value, selected, online }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `recipient-option ${selected ? "is-selected" : ""}`.trim();
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", selected ? "true" : "false");
  button.dataset.recipient = value;
  button.textContent = label;

  if (online) {
    const badge = document.createElement("span");
    badge.className = "presence-badge";
    badge.textContent = "онлайн";
    button.appendChild(badge);
  }

  button.addEventListener("click", () => {
    selectedRecipient = value;
    updateUsers(knownUsers);
    if (mobileMedia.matches) {
      recipientDetails.open = false;
    }
  });

  return button;
}

function updateRecipientSummary() {
  recipientCurrent.textContent = selectedRecipient || "Всем";
}

function applySession(session) {
  currentUser = session.user;
  currentUserLabel.textContent = session.user;
  updateUsers(session.users || []);
  showApp();
  syncRecipientAccordion();
}

function showAuth() {
  authScreen.classList.remove("is-hidden");
  appShell.classList.add("is-hidden");
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
  resetClientState();
  showAuth();
  showLoginError("Сессия истекла. Войдите снова.");
}

function resetClientState() {
  currentUser = "";
  selectedRecipient = "";
  isInitialLoad = true;
  knownMessageIds = new Set();
  knownUsers = [];
  messagesContainer.innerHTML = "";
  recipientOptions.innerHTML = "";
  recipientCurrent.textContent = "Всем";
  currentUserLabel.textContent = "...";
  fileForm.reset();
  fileName.textContent = "Файл не выбран";
  resetUnreadNotifications();
}

function ensurePolling() {
  stopPolling();
  pollTimer = window.setInterval(() => {
    void loadMessages();
  }, 2000);
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function syncRecipientAccordion() {
  recipientDetails.open = !mobileMedia.matches;
}

function isNearBottom() {
  const threshold = 80;
  return (
    messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight <
    threshold
  );
}

async function copyMessage(message) {
  const text = message.type === "file"
    ? `${message.filename}\n${new URL(message.download_url, window.location.origin)}`
    : message.text;

  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    // Ignore clipboard errors; the UI remains usable.
  }
}

async function deleteMessage(messageId) {
  const confirmed = window.confirm("Удалить сообщение у всех?");
  if (!confirmed) {
    return;
  }

  try {
    const response = await fetch(`/api/messages/${messageId}`, {
      method: "DELETE",
    });

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) {
      return;
    }

    await loadMessages();
  } catch (error) {
    // The next poll will retry.
  }
}

async function ensureNotificationPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") {
    return;
  }

  try {
    await Notification.requestPermission();
  } catch (error) {
    // Browsers can reject outside a gesture; fallback stays available.
  }
}

function notifyAboutMessages(messages) {
  if (document.hidden) {
    unseenCount += messages.length;
    updateDocumentTitle();
  }

  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const latestMessage = messages[messages.length - 1];
  const title =
    messages.length === 1 ? `Новое сообщение от ${latestMessage.user}` : `${messages.length} новых сообщений`;
  const body = latestMessage.type === "file"
    ? `Файл: ${latestMessage.filename}`
    : latestMessage.text.slice(0, 140);

  const notification = new Notification(title, {
    body,
    tag: "local-chat-messages",
  });

  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

function resetUnreadNotifications() {
  unseenCount = 0;
  document.title = defaultTitle;
}

function updateDocumentTitle() {
  document.title = unseenCount > 0 ? `(${unseenCount}) ${defaultTitle}` : defaultTitle;
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
