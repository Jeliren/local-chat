from __future__ import annotations

import json
import mimetypes
import os
import re
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
MESSAGES_FILE = DATA_DIR / "messages.json"


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


@dataclass
class StoredFile:
    filename: str
    content: bytes


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

    def list_messages(self, after_id: int = 0) -> list[dict]:
        with self._lock:
            return [message for message in self._messages if message["id"] > after_id]

    def add_text_message(self, user: str, text: str) -> dict:
        message = {
            "id": self._next_message_id(),
            "type": "text",
            "user": user,
            "text": text,
            "created_at": utc_now_iso(),
        }
        with self._lock:
            self._messages.append(message)
            self._save()
        return message

    def add_file_message(self, user: str, uploaded_file: StoredFile) -> dict:
        safe_name = Path(uploaded_file.filename).name or "file"
        ext = Path(safe_name).suffix
        stored_name = f"{uuid.uuid4().hex}{ext}"
        target = self.uploads_dir / stored_name
        target.write_bytes(uploaded_file.content)

        message = {
            "id": self._next_message_id(),
            "type": "file",
            "user": user,
            "filename": safe_name,
            "stored_name": stored_name,
            "size": len(uploaded_file.content),
            "download_url": f"/files/{stored_name}",
            "created_at": utc_now_iso(),
        }
        with self._lock:
            self._messages.append(message)
            self._save()
        return message

    def _next_message_id(self) -> int:
        with self._lock:
            current = self._next_id
            self._next_id += 1
            return current


STORE = ChatStore(MESSAGES_FILE, UPLOADS_DIR)


class ChatHandler(BaseHTTPRequestHandler):
    server_version = "LocalChat/1.0"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.serve_file(STATIC_DIR / "index.html")
            return
        if parsed.path == "/api/messages":
            self.handle_list_messages(parsed.query)
            return
        if parsed.path == "/api/info":
            self.handle_info()
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
        if parsed.path == "/api/messages":
            self.handle_add_message()
            return
        if parsed.path == "/api/files":
            self.handle_upload()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def handle_list_messages(self, query: str) -> None:
        params = parse_qs(query)
        try:
            after_id = int(params.get("after", ["0"])[0])
        except ValueError:
            after_id = 0
        self.send_json({"messages": STORE.list_messages(after_id)})

    def handle_info(self) -> None:
        host = self.server.server_address[0]
        port = self.server.server_address[1]
        self.send_json(
            {
                "host": host,
                "port": port,
                "lan_url": f"http://{guess_host_ip()}:{port}",
            }
        )

    def handle_add_message(self) -> None:
        data = self.read_json_body()
        user = (data.get("user") or "").strip()
        text = (data.get("text") or "").strip()
        if not user or not text:
            self.send_json({"error": "User and text are required."}, HTTPStatus.BAD_REQUEST)
            return
        message = STORE.add_text_message(user=user[:40], text=text)
        self.send_json({"message": message}, HTTPStatus.CREATED)

    def handle_upload(self) -> None:
        try:
            fields = self.read_multipart_form()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            return

        user = fields.get("user")
        uploaded_file = fields.get("file")
        if not isinstance(user, str) or not user.strip():
            self.send_json({"error": "User is required."}, HTTPStatus.BAD_REQUEST)
            return
        if not isinstance(uploaded_file, StoredFile) or not uploaded_file.content:
            self.send_json({"error": "A file is required."}, HTTPStatus.BAD_REQUEST)
            return

        message = STORE.add_file_message(user=user.strip()[:40], uploaded_file=uploaded_file)
        self.send_json({"message": message}, HTTPStatus.CREATED)

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
        target = UPLOADS_DIR / stored_name
        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        original_name = stored_name
        for message in STORE.list_messages():
            if message.get("stored_name") == stored_name:
                original_name = message.get("filename", stored_name)
                break

        content_type, _ = mimetypes.guess_type(str(target))
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{original_name}"')
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

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
