const usernameInput = document.getElementById("username");
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
let lastMessageId = 0;
let isInitialLoad = true;

if (savedUsername) {
  usernameInput.value = savedUsername;
}

usernameInput.addEventListener("input", () => {
  localStorage.setItem("local-chat-username", usernameInput.value.trim());
});

fileInput.addEventListener("change", () => {
  const selected = fileInput.files && fileInput.files[0];
  fileName.textContent = selected ? selected.name : "Файл не выбран";
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = usernameInput.value.trim();
  const text = messageInput.value.trim();

  if (!user) {
    usernameInput.focus();
    return;
  }
  if (!text) {
    messageInput.focus();
    return;
  }

  await fetch("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, text }),
  });

  messageInput.value = "";
  await loadMessages();
});

fileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const user = usernameInput.value.trim();
  const selectedFile = fileInput.files && fileInput.files[0];

  if (!user) {
    usernameInput.focus();
    return;
  }
  if (!selectedFile) {
    fileInput.click();
    return;
  }

  const formData = new FormData();
  formData.append("user", user);
  formData.append("file", selectedFile);

  await fetch("/api/files", {
    method: "POST",
    body: formData,
  });

  fileForm.reset();
  fileName.textContent = "Файл не выбран";
  await loadMessages();
});

async function loadInfo() {
  try {
    const response = await fetch("/api/info");
    const data = await response.json();
    serverUrl.textContent = data.lan_url;
  } catch (error) {
    serverUrl.textContent = "Не удалось определить адрес";
  }
}

async function loadMessages() {
  try {
    const response = await fetch(`/api/messages?after=${lastMessageId}`);
    const data = await response.json();
    const messages = data.messages || [];

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
  const currentUser = usernameInput.value.trim();
  const article = document.createElement("article");
  article.className = `message ${message.user === currentUser ? "self" : "other"}`;

  const header = document.createElement("div");
  header.className = "message-header";

  const user = document.createElement("span");
  user.className = "message-user";
  user.textContent = message.user;

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = formatTime(message.created_at);

  header.append(user, time);
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

loadInfo();
loadMessages();
setInterval(loadMessages, 2000);
