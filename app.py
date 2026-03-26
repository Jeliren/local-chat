from __future__ import annotations

import json
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
MESSAGES_FILE = DATA_DIR / "messages.json"
SESSION_COOKIE_NAME = "local_chat_session"
DEFAULT_CHAT_PASSWORD = "19011901"
CHAT_PASSWORD = os.environ.get("CHAT_PASSWORD", DEFAULT_CHAT_PASSWORD)
USING_DEFAULT_PASSWORD = "CHAT_PASSWORD" not in os.environ


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


RFC1918_NETWORKS = (
    IPv4Network("10.0.0.0/8"),
    IPv4Network("172.16.0.0/12"),
    IPv4Network("192.168.0.0/16"),
)
IGNORED_NETWORKS = (
    IPv4Network("127.0.0.0/8"),
    IPv4Network("169.254.0.0/16"),
    IPv4Network("198.18.0.0/15"),
)


def is_rfc1918(address: IPv4Address) -> bool:
    return any(address in network for network in RFC1918_NETWORKS)


def is_ignored_address(address: IPv4Address) -> bool:
    return any(address in network for network in IGNORED_NETWORKS)


def collect_interface_ipv4s() -> list[str]:
    candidates: list[str] = []
    commands = (["ifconfig"], ["ip", "-4", "addr"])
    for command in commands:
        try:
            result = subprocess.run(command, capture_output=True, text=True, check=False)
        except OSError:
            continue
        if result.returncode != 0:
            continue
        candidates.extend(re.findall(r"\binet (\d+\.\d+\.\d+\.\d+)\b", result.stdout))
    return candidates


def build_content_disposition(filename: str) -> str:
    fallback = "".join(char if 32 <= ord(char) < 127 and char not in {'"', "\\"} else "_" for char in filename)
    fallback = fallback.strip(" .") or "download"
    encoded = quote(filename, safe="")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"


def guess_host_ip() -> str:
    candidates: list[IPv4Address] = []

    for raw_ip in collect_interface_ipv4s():
        try:
            candidates.append(IPv4Address(raw_ip))
        except ValueError:
            continue

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        candidates.append(IPv4Address(sock.getsockname()[0]))
    except (OSError, ValueError):
        pass
    finally:
        sock.close()

    rfc1918 = [ip for ip in candidates if is_rfc1918(ip)]
    if rfc1918:
        return str(rfc1918[0])

    publicish = [ip for ip in candidates if not is_ignored_address(ip)]
    if publicish:
        return str(publicish[0])

    return "127.0.0.1"


def clean_username(raw_value: str | None) -> str:
    return str(raw_value or "").strip()[:40]


def clean_recipient(raw_value: str | None, current_user: str) -> str | None:
    value = clean_username(raw_value)
    if not value:
        return None
    if value == current_user:
        return None
    return value


@dataclass
class StoredFile:
    filename: str
    content: bytes


class SessionStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, str] = {}

    def create(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = username
        return token

    def get_user(self, token: str | None) -> str | None:
        if not token:
            return None
        with self._lock:
            return self._sessions.get(token)

    def delete(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)

    def list_users(self) -> list[str]:
        with self._lock:
            return sorted(set(self._sessions.values()), key=str.lower)


class ChatStore:
    def __init__(self, messages_path: Path, uploads_dir: Path) -> None:
        self.messages_path = messages_path
        self.uploads_dir = uploads_dir
        self._lock = threading.Lock()
        self.messages_path.parent.mkdir(parents=True, exist_ok=True)
        self.uploads_dir.mkdir(parents=True, exist_ok=True)
        self._messages: list[dict] = []
        self._next_id = 1
        self._load()

    def _load(self) -> None:
        if not self.messages_path.exists():
            return
        try:
            self._messages = json.loads(self.messages_path.read_text(encoding="utf-8"))
            if self._messages:
                self._next_id = max(item["id"] for item in self._messages) + 1
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            self._messages = []
            self._next_id = 1

    def _save(self) -> None:
        self.messages_path.write_text(
            json.dumps(self._messages, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _normalize(self, message: dict) -> dict:
        normalized = dict(message)
        recipient = clean_username(normalized.get("recipient"))
        normalized["recipient"] = recipient or None
        normalized["is_private"] = bool(recipient)
        return normalized

    def _is_visible_to(self, message: dict, username: str) -> bool:
        normalized = self._normalize(message)
        if not normalized["is_private"]:
            return True
        return username in {normalized.get("user"), normalized.get("recipient")}

    def list_messages_for_user(self, username: str, after_id: int = 0) -> list[dict]:
        with self._lock:
            visible = []
            for message in self._messages:
                if message["id"] <= after_id:
                    continue
                if self._is_visible_to(message, username):
                    visible.append(self._normalize(message))
            return visible

    def list_known_users(self, active_users: list[str]) -> list[dict[str, bool | str]]:
        active_set = {clean_username(user) for user in active_users if clean_username(user)}
        with self._lock:
            users = set(active_set)
            for message in self._messages:
                normalized = self._normalize(message)
                sender = clean_username(normalized.get("user"))
                recipient = clean_username(normalized.get("recipient"))
                if sender:
                    users.add(sender)
                if recipient:
                    users.add(recipient)
            return [
                {"name": user, "online": user in active_set}
                for user in sorted(users, key=str.lower)
            ]

    def get_message_by_file(self, stored_name: str) -> dict | None:
        with self._lock:
            for message in self._messages:
                if message.get("stored_name") == stored_name:
                    return self._normalize(message)
        return None

    def add_text_message(self, user: str, text: str, recipient: str | None = None) -> dict:
        with self._lock:
            message = {
                "id": self._next_id,
                "type": "text",
                "user": user,
                "text": text,
                "recipient": recipient,
                "created_at": utc_now_iso(),
            }
            self._next_id += 1
            self._messages.append(message)
            self._save()
            return self._normalize(message)

    def add_file_message(self, user: str, uploaded_file: StoredFile, recipient: str | None = None) -> dict:
        safe_name = Path(uploaded_file.filename).name or "file"
        ext = Path(safe_name).suffix
        stored_name = f"{uuid.uuid4().hex}{ext}"
        target = self.uploads_dir / stored_name
        target.write_bytes(uploaded_file.content)

        with self._lock:
            message = {
                "id": self._next_id,
                "type": "file",
                "user": user,
                "filename": safe_name,
                "stored_name": stored_name,
                "size": len(uploaded_file.content),
                "download_url": f"/files/{stored_name}",
                "recipient": recipient,
                "created_at": utc_now_iso(),
            }
            self._next_id += 1
            self._messages.append(message)
            self._save()
            return self._normalize(message)

    def delete_message(self, message_id: int, username: str) -> str:
        stored_name = ""
        with self._lock:
            for index, message in enumerate(self._messages):
                if message.get("id") != message_id:
                    continue
                if clean_username(message.get("user")) != username:
                    return "forbidden"
                deleted = self._messages.pop(index)
                stored_name = str(deleted.get("stored_name") or "")
                self._save()
                break
            else:
                return "not_found"

        if stored_name:
            try:
                (self.uploads_dir / Path(stored_name).name).unlink()
            except FileNotFoundError:
                pass

        return "deleted"


STORE = ChatStore(MESSAGES_FILE, UPLOADS_DIR)
SESSIONS = SessionStore()


class ChatHandler(BaseHTTPRequestHandler):
    server_version = "LocalChat/2.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.serve_file(STATIC_DIR / "index.html")
            return
        if parsed.path == "/api/info":
            self.handle_info()
            return
        if parsed.path == "/api/session":
            self.handle_session()
            return
        if parsed.path == "/api/messages":
            self.handle_list_messages(parsed.query)
            return
        if parsed.path.startswith("/static/"):
            rel_path = parsed.path.removeprefix("/static/")
            self.serve_file(STATIC_DIR / rel_path)
            return
        if parsed.path.startswith("/files/"):
            stored_name = Path(parsed.path.removeprefix("/files/")).name
            self.serve_upload(stored_name)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/login":
            self.handle_login()
            return
        if parsed.path == "/api/logout":
            self.handle_logout()
            return
        if parsed.path == "/api/messages":
            self.handle_add_message()
            return
        if parsed.path == "/api/files":
            self.handle_upload()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/messages/"):
            self.handle_delete_message(parsed.path)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def get_current_user(self) -> str | None:
        cookie_header = self.headers.get("Cookie", "")
        if not cookie_header:
            return None
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(SESSION_COOKIE_NAME)
        if not morsel:
            return None
        return SESSIONS.get_user(morsel.value)

    def require_user(self) -> str | None:
        user = self.get_current_user()
        if user:
            return user
        self.send_json({"error": "Authentication required."}, HTTPStatus.UNAUTHORIZED)
        return None

    def handle_info(self) -> None:
        port = self.server.server_address[1]
        self.send_json(
            {
                "port": port,
                "lan_url": f"http://{guess_host_ip()}:{port}",
            }
        )

    def handle_session(self) -> None:
        user = self.get_current_user()
        if not user:
            self.send_json({"authenticated": False})
            return

        self.send_json(
            {
                "authenticated": True,
                "user": user,
                "users": STORE.list_known_users(SESSIONS.list_users()),
            }
        )

    def handle_login(self) -> None:
        data = self.read_json_body()
        username = clean_username(data.get("username"))
        password = (data.get("password") or "").strip()

        if not username or not password:
            self.send_json({"error": "Username and password are required."}, HTTPStatus.BAD_REQUEST)
            return
        if password != CHAT_PASSWORD:
            self.send_json({"error": "Wrong password."}, HTTPStatus.UNAUTHORIZED)
            return

        token = SESSIONS.create(username)
        self.send_json(
            {
                "authenticated": True,
                "user": username,
                "users": STORE.list_known_users(SESSIONS.list_users()),
            },
            headers={"Set-Cookie": f"{SESSION_COOKIE_NAME}={token}; HttpOnly; Path=/; SameSite=Lax"},
        )

    def handle_logout(self) -> None:
        cookie_header = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        cookie.load(cookie_header)
        morsel = cookie.get(SESSION_COOKIE_NAME)
        if morsel:
            SESSIONS.delete(morsel.value)
        self.send_json(
            {"ok": True},
            headers={"Set-Cookie": f"{SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"},
        )

    def handle_list_messages(self, query: str) -> None:
        user = self.require_user()
        if not user:
            return

        params = parse_qs(query)
        try:
            after_id = int(params.get("after", ["0"])[0])
        except ValueError:
            after_id = 0

        self.send_json(
            {
                "messages": STORE.list_messages_for_user(user, after_id),
                "users": STORE.list_known_users(SESSIONS.list_users()),
            }
        )

    def handle_add_message(self) -> None:
        user = self.require_user()
        if not user:
            return

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" in content_type:
            try:
                fields = self.read_multipart_form()
            except ValueError as exc:
                self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                return

            text = (fields.get("text") if isinstance(fields.get("text"), str) else "").strip()
            recipient = clean_recipient(
                fields.get("recipient") if isinstance(fields.get("recipient"), str) else None,
                user,
            )
            uploaded_file = fields.get("file")

            if not text and (not isinstance(uploaded_file, StoredFile) or not uploaded_file.content):
                self.send_json({"error": "Text or file is required."}, HTTPStatus.BAD_REQUEST)
                return

            created_messages = []
            if text:
                created_messages.append(STORE.add_text_message(user=user, text=text, recipient=recipient))
            if isinstance(uploaded_file, StoredFile) and uploaded_file.content:
                created_messages.append(
                    STORE.add_file_message(user=user, uploaded_file=uploaded_file, recipient=recipient)
                )

            self.send_json({"messages": created_messages}, HTTPStatus.CREATED)
            return

        data = self.read_json_body()
        text = (data.get("text") or "").strip()
        recipient = clean_recipient(data.get("recipient"), user)
        if not text:
            self.send_json({"error": "Text is required."}, HTTPStatus.BAD_REQUEST)
            return

        message = STORE.add_text_message(user=user, text=text, recipient=recipient)
        self.send_json({"message": message}, HTTPStatus.CREATED)

    def handle_upload(self) -> None:
        user = self.require_user()
        if not user:
            return

        try:
            fields = self.read_multipart_form()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return

        uploaded_file = fields.get("file")
        recipient = clean_recipient(fields.get("recipient") if isinstance(fields.get("recipient"), str) else None, user)
        if not isinstance(uploaded_file, StoredFile) or not uploaded_file.content:
            self.send_json({"error": "A file is required."}, HTTPStatus.BAD_REQUEST)
            return

        message = STORE.add_file_message(user=user, uploaded_file=uploaded_file, recipient=recipient)
        self.send_json({"message": message}, HTTPStatus.CREATED)

    def handle_delete_message(self, path: str) -> None:
        user = self.require_user()
        if not user:
            return

        message_id_raw = Path(path).name
        try:
            message_id = int(message_id_raw)
        except ValueError:
            self.send_json({"error": "Invalid message id."}, HTTPStatus.BAD_REQUEST)
            return

        result = STORE.delete_message(message_id, user)
        if result == "forbidden":
            self.send_json({"error": "Only the author can delete this message."}, HTTPStatus.FORBIDDEN)
            return
        if result == "not_found":
            self.send_json({"error": "Message not found."}, HTTPStatus.NOT_FOUND)
            return

        self.send_json({"ok": True})

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}

    def read_multipart_form(self) -> dict[str, str | StoredFile]:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            raise ValueError("Expected multipart/form-data request.")

        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
        )

        if not message.is_multipart():
            raise ValueError("Invalid multipart payload.")

        result: dict[str, str | StoredFile] = {}
        for part in message.iter_parts():
            disposition = part.get_content_disposition()
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            if disposition != "form-data" or not name:
                continue
            payload = part.get_payload(decode=True) or b""
            if filename:
                result[name] = StoredFile(filename=filename, content=payload)
            else:
                charset = part.get_content_charset() or "utf-8"
                result[name] = payload.decode(charset, errors="replace")
        return result

    def serve_upload(self, stored_name: str) -> None:
        user = self.get_current_user()
        if not user:
            self.send_error(HTTPStatus.UNAUTHORIZED, "Authentication required")
            return

        message = STORE.get_message_by_file(stored_name)
        if not message:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        if message.get("is_private") and user not in {message.get("user"), message.get("recipient")}:
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return

        target = UPLOADS_DIR / stored_name
        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        content_type, _ = mimetypes.guess_type(str(target))
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Content-Disposition", build_content_disposition(message.get("filename", stored_name)))
        self.end_headers()
        with target.open("rb") as file_obj:
            self.wfile.write(file_obj.read())

    def serve_file(self, file_path: Path) -> None:
        try:
            resolved = file_path.resolve()
        except FileNotFoundError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        allowed_root = STATIC_DIR.resolve()
        if resolved.is_dir() or (allowed_root not in resolved.parents and resolved != allowed_root):
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        if not resolved.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        content_type, _ = mimetypes.guess_type(str(resolved))
        data = resolved.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(
        self,
        payload: dict,
        status: HTTPStatus = HTTPStatus.OK,
        headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        sys.stdout.write(f"{self.address_string()} - {format % args}\n")


def main() -> None:
    host = os.environ.get("CHAT_HOST", "0.0.0.0")
    port = int(os.environ.get("CHAT_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), ChatHandler)
    lan_ip = guess_host_ip()
    print(f"Chat is running on http://127.0.0.1:{port}")
    print(f"Open from local network: http://{lan_ip}:{port}")
    if USING_DEFAULT_PASSWORD:
        print(f"Login password: {DEFAULT_CHAT_PASSWORD} (set CHAT_PASSWORD to change it)")
    else:
        print("Login password loaded from CHAT_PASSWORD")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
