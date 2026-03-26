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
const composerDropzone = document.getElementById("composer-dropzone");
const replyPreview = document.getElementById("reply-preview");
const replyPreviewTitle = document.getElementById("reply-preview-title");
const replyPreviewBody = document.getElementById("reply-preview-body");
const clearReplyButton = document.getElementById("clear-reply-button");
const messageInput = document.getElementById("message-input");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const dropHint = document.getElementById("drop-hint");
const attachmentPreview = document.getElementById("attachment-preview");
const clearFileButton = document.getElementById("clear-file-button");
const emptyStateTemplate = document.getElementById("empty-state-template");
const imageLightbox = document.getElementById("image-lightbox");
const imageLightboxClose = document.getElementById("image-lightbox-close");
const imageLightboxImg = document.getElementById("image-lightbox-img");

const PUBLIC_CHAT_KEY = "public";
const savedUsername = localStorage.getItem("local-chat-username");
const defaultTitle = document.title;
const mobileMedia = window.matchMedia("(max-width: 640px)");

let currentUser = "";
let selectedRecipient = "";
let isInitialLoad = true;
let pollTimer = null;
let knownMessageIds = new Set();
let knownUsers = [];
let allMessages = [];
let readState = {};
let hasStoredReadState = false;
let currentReply = null;

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
    // The local UI still resets.
  }

  stopPolling();
  resetClientState();
  showAuth();
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitComposer();
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) {
    return;
  }
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    return;
  }

  event.preventDefault();
  void submitComposer();
});

fileInput.addEventListener("change", updateAttachmentPreview);
clearFileButton.addEventListener("click", clearAttachment);
clearReplyButton.addEventListener("click", clearReply);
composerDropzone.addEventListener("dragenter", handleDragEnter);
composerDropzone.addEventListener("dragover", handleDragOver);
composerDropzone.addEventListener("dragleave", handleDragLeave);
composerDropzone.addEventListener("drop", handleDrop);
messagesContainer.addEventListener("scroll", handleMessagesScroll);
imageLightbox.addEventListener("click", handleLightboxClick);
imageLightboxClose.addEventListener("click", closeImageLightbox);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    handleAttentionRestore();
  }
});

window.addEventListener("focus", handleAttentionRestore);
window.addEventListener("keydown", handleWindowKeydown);

if (typeof mobileMedia.addEventListener === "function") {
  mobileMedia.addEventListener("change", syncRecipientAccordion);
} else {
  mobileMedia.addListener(syncRecipientAccordion);
}

async function boot() {
  syncRecipientAccordion();
  updateComposerPlaceholder();
  updateAttachmentPreview();
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
  allMessages = [];
  messagesContainer.innerHTML = "";
  updateDocumentTitle();
  await loadMessages({ forceScroll: true, jumpToUnread: true });
}

async function loadMessages({ forceScroll = false, jumpToUnread = false } = {}) {
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

    allMessages = messages;
    knownMessageIds = new Set(messages.map((message) => message.id));

    if (isInitialLoad && !hasStoredReadState) {
      initializeReadStateFromMessages();
    }

    updateUsers(data.users || []);
    renderCurrentChat({
      shouldScroll,
      distanceFromBottom,
      forceScroll,
      jumpToUnread: jumpToUnread || isInitialLoad,
    });

    if (newExternalMessages.length > 0) {
      notifyAboutMessages(newExternalMessages);
    }

    const preserveUnreadMarker = (jumpToUnread || isInitialLoad) && getUnreadCount(getCurrentChatKey()) > 0;
    if (!document.hidden && document.hasFocus() && shouldScroll && !preserveUnreadMarker) {
      markCurrentChatAsRead({ rerender: false });
    }

    isInitialLoad = false;
    updateDocumentTitle();
  } catch (error) {
    // The next poll will retry.
  }
}

function renderCurrentChat({
  shouldScroll = false,
  distanceFromBottom = 0,
  forceScroll = false,
  jumpToUnread = false,
} = {}) {
  const chatKey = getCurrentChatKey();
  const visibleMessages = getMessagesForChat(chatKey);
  const unreadMessages = getUnreadMessages(chatKey);
  const firstUnreadId = unreadMessages[0]?.id || null;

  renderMessages(visibleMessages, {
    firstUnreadId,
    unreadCount: unreadMessages.length,
  });

  if (jumpToUnread && firstUnreadId) {
    scrollToUnreadMarker();
    return;
  }

  if (forceScroll || shouldScroll) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return;
  }

  messagesContainer.scrollTop = Math.max(messagesContainer.scrollHeight - distanceFromBottom, 0);
}

function getCurrentChatKey() {
  return getChatKeyForRecipient(selectedRecipient);
}

function getChatKeyForRecipient(recipient) {
  return recipient ? `dm:${recipient}` : PUBLIC_CHAT_KEY;
}

function getChatKeyForMessage(message) {
  if (!message.is_private) {
    return PUBLIC_CHAT_KEY;
  }

  const otherUser = message.user === currentUser ? message.recipient : message.user;
  return getChatKeyForRecipient(otherUser);
}

function getMessagesForChat(chatKey) {
  if (chatKey === PUBLIC_CHAT_KEY) {
    return allMessages.filter((message) => !message.is_private);
  }

  const otherUser = chatKey.replace(/^dm:/, "");
  return allMessages.filter((message) => {
    if (!message.is_private) {
      return false;
    }

    return (
      (message.user === currentUser && message.recipient === otherUser) ||
      (message.user === otherUser && message.recipient === currentUser)
    );
  });
}

function getUnreadMessages(chatKey) {
  const lastReadId = getLastReadId(chatKey);
  return getMessagesForChat(chatKey).filter((message) => message.user !== currentUser && message.id > lastReadId);
}

function getUnreadCount(chatKey) {
  return getUnreadMessages(chatKey).length;
}

function getLastReadId(chatKey) {
  return Number(readState[chatKey] || 0);
}

function getChatLastMessageId(chatKey) {
  const messages = getMessagesForChat(chatKey);
  return messages.length > 0 ? messages[messages.length - 1].id : 0;
}

function getAllChatKeys() {
  const keys = new Set([PUBLIC_CHAT_KEY]);
  for (const message of allMessages) {
    keys.add(getChatKeyForMessage(message));
  }
  return [...keys];
}

function initializeReadStateFromMessages() {
  for (const chatKey of getAllChatKeys()) {
    readState[chatKey] = getChatLastMessageId(chatKey);
  }
  hasStoredReadState = true;
  saveReadState();
}

function renderMessages(messages, { firstUnreadId = null, unreadCount = 0 } = {}) {
  messagesContainer.innerHTML = "";

  if (messages.length === 0) {
    const emptyState = emptyStateTemplate.content.cloneNode(true);
    const text = emptyState.querySelector("p");
    if (text) {
      text.textContent = selectedRecipient
        ? `Пока нет сообщений с ${selectedRecipient}.`
        : "Пока в общем чате нет сообщений.";
    }
    messagesContainer.appendChild(emptyState);
    return;
  }

  let unreadMarkerInserted = false;

  for (const message of messages) {
    if (!unreadMarkerInserted && firstUnreadId && message.id === firstUnreadId) {
      messagesContainer.appendChild(buildUnreadMarker(unreadCount));
      unreadMarkerInserted = true;
    }
    messagesContainer.appendChild(buildMessageElement(message));
  }
}

function buildUnreadMarker(unreadCount) {
  const marker = document.createElement("div");
  marker.className = "unread-marker";
  marker.id = "unread-marker";

  const line = document.createElement("div");
  line.className = "unread-marker-line";

  const label = document.createElement("span");
  label.className = "unread-marker-label";
  label.textContent = unreadCount > 1 ? `Новые сообщения (${unreadCount})` : "Новое сообщение";

  marker.append(line, label);
  return marker;
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

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = formatTime(message.created_at);
  meta.appendChild(time);

  header.append(user, meta);
  article.appendChild(header);

  const replyReference = buildReplyReference(message);
  if (replyReference) {
    article.appendChild(replyReference);
  }

  const body = document.createElement("div");
  body.className = "message-body";

  if (message.type === "file" && message.is_image) {
    const mediaLink = document.createElement("button");
    mediaLink.type = "button";
    mediaLink.className = "image-link";
    mediaLink.setAttribute("aria-label", `Открыть изображение ${message.filename}`);
    mediaLink.addEventListener("click", () => {
      openImageLightbox(message);
    });

    const image = document.createElement("img");
    image.className = "message-image";
    image.src = message.download_url;
    image.alt = message.filename;
    image.loading = "lazy";
    mediaLink.appendChild(image);

    const caption = document.createElement("span");
    caption.className = "image-caption";
    caption.textContent = message.filename;

    const imageBlock = document.createElement("div");
    imageBlock.className = "image-message";
    imageBlock.append(mediaLink, caption);
    body.appendChild(imageBlock);
  } else if (message.type === "file") {
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
    createIconButton(
      "Ответить",
      "reply",
      () => {
        startReply(message);
      },
      "reply-button",
    ),
  );
  actions.appendChild(
    createIconButton("Скопировать", "copy", async () => {
      await copyMessage(message);
    }),
  );

  if (message.user === currentUser) {
    actions.appendChild(
      createIconButton(
        "Удалить",
        "trash",
        async () => {
          await deleteMessage(message.id);
        },
        "danger",
      ),
    );
  }

  body.appendChild(actions);
  article.appendChild(body);
  return article;
}

function buildReplyReference(message) {
  const replyData = resolveReplyPreview(message);
  if (!replyData) {
    return null;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "message-reply-reference";
  button.addEventListener("click", () => {
    jumpToMessage(replyData.id);
  });

  const title = document.createElement("div");
  title.className = "message-reply-title";
  title.textContent = `Ответ ${replyData.user} · ${formatTime(replyData.created_at)}`;

  const body = document.createElement("div");
  body.className = "message-reply-body";
  body.textContent = getReplyExcerpt(replyData);

  button.append(title, body);
  return button;
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
  if (iconName === "reply") {
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 6 4 11l5 5"></path>
        <path d="M20 18a8 8 0 0 0-8-8H4"></path>
      </svg>
    `;
  }
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
      unreadCount: getUnreadCount(PUBLIC_CHAT_KEY),
    }),
  );

  for (const user of availableRecipients) {
    const chatKey = getChatKeyForRecipient(user.name);
    recipientOptions.appendChild(
      createRecipientOption({
        label: user.name,
        value: user.name,
        selected: selectedRecipient === user.name,
        online: user.online,
        unreadCount: getUnreadCount(chatKey),
      }),
    );
  }

  updateRecipientSummary();
  updateComposerPlaceholder();
  updateDocumentTitle();
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

function createRecipientOption({ label, value, selected, online, unreadCount }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `recipient-option ${selected ? "is-selected" : ""}`.trim();
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", selected ? "true" : "false");
  button.dataset.recipient = value;

  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;
  button.appendChild(labelSpan);

  if (online) {
    const badge = document.createElement("span");
    badge.className = "presence-badge";
    badge.textContent = "онлайн";
    button.appendChild(badge);
  }

  if (unreadCount > 0) {
    const badge = document.createElement("span");
    badge.className = "unread-count-badge";
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    button.appendChild(badge);
  }

  button.addEventListener("click", () => {
    selectedRecipient = value;
    clearReply();
    updateUsers(knownUsers);
    renderCurrentChat({ jumpToUnread: true, forceScroll: unreadCount === 0 });
    if (mobileMedia.matches) {
      recipientDetails.open = false;
    }
  });

  return button;
}

function updateRecipientSummary() {
  recipientCurrent.textContent = selectedRecipient || "Всем";
}

function updateComposerPlaceholder() {
  messageInput.placeholder = selectedRecipient
    ? `Личное сообщение для ${selectedRecipient}...`
    : "Напишите сообщение в общий чат...";
}

function startReply(message) {
  currentReply = {
    id: message.id,
    user: message.user,
    created_at: message.created_at,
    type: message.type,
    text: message.text || "",
    filename: message.filename || "",
    is_image: Boolean(message.is_image),
  };
  renderReplyPreview();
  messageInput.focus();
}

function clearReply() {
  currentReply = null;
  renderReplyPreview();
}

function renderReplyPreview() {
  if (!currentReply) {
    replyPreview.classList.add("is-hidden");
    replyPreviewTitle.textContent = "";
    replyPreviewBody.textContent = "";
    return;
  }

  replyPreview.classList.remove("is-hidden");
  replyPreviewTitle.textContent = `Ответ ${currentReply.user} от ${formatTime(currentReply.created_at)}`;
  replyPreviewBody.textContent = getReplyExcerpt(currentReply);
}

function resolveReplyPreview(message) {
  if (message.reply_preview && message.reply_preview.id) {
    return message.reply_preview;
  }
  if (!message.reply_to) {
    return null;
  }
  return allMessages.find((item) => item.id === message.reply_to) || null;
}

function getReplyExcerpt(replyData) {
  if (replyData.type === "file") {
    return replyData.is_image ? `Изображение: ${replyData.filename}` : `Файл: ${replyData.filename}`;
  }
  return truncateText(String(replyData.text || ""), 110);
}

function truncateText(text, maxLength) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized || "Сообщение";
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function updateAttachmentPreview() {
  const selected = fileInput.files && fileInput.files[0];
  fileName.textContent = selected ? selected.name : "Файл не выбран";
  attachmentPreview.classList.toggle("is-hidden", !selected);
}

function clearAttachment() {
  fileInput.value = "";
  setDropActive(false);
  updateAttachmentPreview();
}

function handleDragEnter(event) {
  event.preventDefault();
  if (!hasFiles(event)) {
    return;
  }
  setDropActive(true);
}

function handleDragOver(event) {
  event.preventDefault();
  if (!hasFiles(event)) {
    return;
  }
  event.dataTransfer.dropEffect = "copy";
  setDropActive(true);
}

function handleDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) {
    return;
  }
  setDropActive(false);
}

function handleDrop(event) {
  event.preventDefault();
  setDropActive(false);

  const droppedFile = getFirstDroppedFile(event);
  if (!droppedFile) {
    return;
  }

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(droppedFile);
  fileInput.files = dataTransfer.files;
  updateAttachmentPreview();
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function getFirstDroppedFile(event) {
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) {
    return null;
  }
  return files[0];
}

function setDropActive(isActive) {
  composerDropzone.classList.toggle("is-drop-active", isActive);
  dropHint.classList.toggle("is-hidden", !isActive);
}

function openImageLightbox(message) {
  imageLightboxImg.src = message.download_url;
  imageLightboxImg.alt = message.filename || "Изображение";
  imageLightbox.classList.remove("is-hidden");
  imageLightbox.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeImageLightbox() {
  imageLightbox.classList.add("is-hidden");
  imageLightbox.setAttribute("aria-hidden", "true");
  imageLightboxImg.removeAttribute("src");
  imageLightboxImg.alt = "";
  document.body.style.overflow = "";
}

function handleLightboxClick(event) {
  if (event.target === imageLightbox || event.target.classList.contains("image-lightbox-backdrop")) {
    closeImageLightbox();
  }
}

function handleWindowKeydown(event) {
  if (event.key === "Escape" && !imageLightbox.classList.contains("is-hidden")) {
    closeImageLightbox();
  }
}

async function submitComposer() {
  const text = messageInput.value.trim();
  const file = fileInput.files && fileInput.files[0];
  if (!text && !file) {
    messageInput.focus();
    return;
  }

  const formData = new FormData();
  formData.append("recipient", selectedRecipient);
  if (currentReply?.id) {
    formData.append("reply_to", String(currentReply.id));
  }
  if (text) {
    formData.append("text", text);
  }
  if (file) {
    formData.append("file", file);
  }

  try {
    const response = await fetch("/api/messages", {
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

    messageInput.value = "";
    clearAttachment();
    clearReply();
    await loadMessages({ forceScroll: true });
    markCurrentChatAsRead({ rerender: false });
    messageInput.focus();
  } catch (error) {
    // The next poll will retry.
  }
}

function applySession(session) {
  currentUser = session.user;
  currentUserLabel.textContent = session.user;
  loadReadState();
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
  allMessages = [];
  readState = {};
  hasStoredReadState = false;
  messagesContainer.innerHTML = "";
  recipientOptions.innerHTML = "";
  recipientCurrent.textContent = "Всем";
  currentUserLabel.textContent = "...";
  messageInput.value = "";
  clearAttachment();
  clearReply();
  updateComposerPlaceholder();
  updateDocumentTitle();
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

function handleMessagesScroll() {
  if (!document.hidden && isNearBottom()) {
    markCurrentChatAsRead();
  }
}

function handleAttentionRestore() {
  if (isNearBottom()) {
    markCurrentChatAsRead();
  } else {
    updateDocumentTitle();
  }
}

function markCurrentChatAsRead({ rerender = true } = {}) {
  const chatKey = getCurrentChatKey();
  const lastMessageId = getChatLastMessageId(chatKey);
  if (lastMessageId <= getLastReadId(chatKey)) {
    return;
  }

  readState[chatKey] = lastMessageId;
  saveReadState();
  updateUsers(knownUsers);

  if (rerender) {
    renderCurrentChat({ forceScroll: true });
  }
}

function scrollToUnreadMarker() {
  requestAnimationFrame(() => {
    const marker = document.getElementById("unread-marker");
    if (!marker) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      return;
    }

    messagesContainer.scrollTop = Math.max(marker.offsetTop - 18, 0);
  });
}

function jumpToMessage(messageId) {
  if (!messageId) {
    return;
  }

  const target = messagesContainer.querySelector(`[data-message-id="${messageId}"]`);
  if (!target) {
    return;
  }

  target.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
  target.classList.add("message-highlight");
  window.setTimeout(() => {
    target.classList.remove("message-highlight");
  }, 1800);
}

function getReadStateStorageKey() {
  return currentUser ? `local-chat-read-state:${currentUser}` : "";
}

function loadReadState() {
  const storageKey = getReadStateStorageKey();
  if (!storageKey) {
    readState = {};
    hasStoredReadState = false;
    return;
  }

  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    readState = {};
    hasStoredReadState = false;
    return;
  }

  try {
    readState = JSON.parse(raw) || {};
    hasStoredReadState = true;
  } catch (error) {
    readState = {};
    hasStoredReadState = false;
  }
}

function saveReadState() {
  const storageKey = getReadStateStorageKey();
  if (!storageKey) {
    return;
  }
  localStorage.setItem(storageKey, JSON.stringify(readState));
}

async function copyMessage(message) {
  const text =
    message.type === "file"
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
  if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) {
    return;
  }

  const latestMessage = messages[messages.length - 1];
  const title = latestMessage.is_private
    ? `Новое личное сообщение от ${latestMessage.user}`
    : messages.length === 1
      ? `Новое сообщение от ${latestMessage.user}`
      : `${messages.length} новых сообщений`;
  const body =
    latestMessage.type === "file"
      ? latestMessage.is_image
        ? `Изображение: ${latestMessage.filename}`
        : `Файл: ${latestMessage.filename}`
      : latestMessage.text.slice(0, 140);

  const notification = new Notification(title, {
    body,
    tag: latestMessage.is_private ? `dm:${latestMessage.user}` : "public",
  });

  notification.onclick = () => {
    window.focus();
    if (latestMessage.is_private) {
      selectedRecipient = latestMessage.user;
      updateUsers(knownUsers);
      renderCurrentChat({ jumpToUnread: true, forceScroll: false });
    }
    notification.close();
  };
}

function updateDocumentTitle() {
  const totalUnread = getAllChatKeys().reduce((sum, chatKey) => sum + getUnreadCount(chatKey), 0);
  document.title = totalUnread > 0 ? `(${totalUnread}) ${defaultTitle}` : defaultTitle;
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
